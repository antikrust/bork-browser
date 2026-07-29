#!/usr/bin/env bash
# Build the Windows bork runtime inside the winbuild VM and pull the flat
# artifact out to sentience. Encodes the proven recipe (see runtime-build-recipe
# memory): elevated scheduled task (msiexec needs it), upstream patches for
# flat-format packaging.
#
# NAMING, because it has bitten twice: the derp -> bork rename moved the
# *host-side* directories only. The libvirt domain (derp-winbuild), the
# scheduled task (derpbuild), the VM objdir (C:\derp-obj) and its build log
# (C:\derp-build.log) are identities INSIDE the VM or in libvirt. Renaming any
# of them here does not rename the thing itself — it just stops this script
# finding it.
#
# TRANSFER: the artifact comes OUT over HTTP (VM curl -T -> receiver on the
# libvirt gateway), not base64-over-WinRM. The base64 pull once corrupted a
# 131 MB transfer — same length, different hash — which then failed the publish
# integrity check. HTTP moves raw bytes and is verified by sha256 end to end.
# The VM firewall blocks inbound and the VM has no real python, so we cannot
# serve FROM the VM; pushing OUT (outbound is allowed) is why this direction.
set -euo pipefail
D=/mnt/terra/bork-winbuild
PY=/mnt/terra/bob-release/tools/winrm-venv/bin/python
VMIP=192.168.122.95
ARTIFACTS=/mnt/terra/bork-runtime-build/artifacts
DEST="$ARTIFACTS/floorp-windows-x86_64-moz-artifact.zip"
PORT=8099
GW=$(ip -4 addr show virbr0 2>/dev/null | awk '/inet /{print $2}' | cut -d/ -f1)
GW="${GW:-192.168.122.1}"

# ensure VM up
state=$(sudo virsh domstate derp-winbuild 2>/dev/null || echo unknown)
[ "$state" = "running" ] || { sudo virsh start derp-winbuild; sleep 40; }
until timeout 5 bash -c "echo > /dev/tcp/$VMIP/5985" 2>/dev/null; do sleep 6; done

# build + package via the elevated scheduled task (already registered as derpbuild)
cat > "$D/go.ps1" <<PS1
if (Test-Path C:\derp-build.log) { Remove-Item C:\derp-build.log -Force }
Start-ScheduledTask -TaskName "derpbuild"
PS1
"$PY" "$D/winps95.py" < "$D/go.ps1"

# wait for BUILD_EXIT (mach build), then apply upstream patches + package
cat > "$D/waitbuild.ps1" <<PS1
\$raw = if (Test-Path C:\derp-build.log) { Get-Content C:\derp-build.log -Raw } else { "" }
if (\$raw -match "PKG_EXIT=(\d+)") { "PKG_EXIT=" + \$Matches[1] }
elseif (\$raw -match "BUILD_EXIT=(\d+)") { "BUILD_EXIT=" + \$Matches[1] }
else { "RUNNING" }
PS1
for i in $(seq 1 120); do
  o=$("$PY" "$D/winps95.py" < "$D/waitbuild.ps1" 2>/dev/null)
  echo "$o" | grep -qE "PKG_EXIT=0" && break
  echo "$o" | grep -qE "BUILD_EXIT=[1-9]|PKG_EXIT=[1-9]" && { echo "windows build failed: $o"; exit 1; }
  sleep 60
done

# Resolve the packaged zip rather than hardcoding its name: mach names it after
# MOZ_APP_NAME, so it is floorp-*.win64.zip until the VM's checkout carries the
# rebrand and bork-*.win64.zip afterwards. Also grab its sha256 so the transfer
# is verified against the source.
cat > "$D/findzip.ps1" <<'PS1'
$z = Get-ChildItem C:\derp-obj\dist\*.win64.zip -ErrorAction SilentlyContinue |
     Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($z) { $z.FullName + "|" + (Get-FileHash $z.FullName -Algorithm SHA256).Hash } else { "NONE" }
PS1
info=$("$PY" "$D/winps95.py" < "$D/findzip.ps1" | tr -d '\r' | grep '|' | tail -1)
ZIP="${info%%|*}"
SHA="$(printf '%s' "${info##*|}" | tr 'A-Z' 'a-z')"
[ -n "$ZIP" ] && [ "$ZIP" != "NONE" ] || { echo 'windows: no *.win64.zip in C:\derp-obj\dist'; exit 1; }
echo "windows: source $ZIP"
echo "windows: sha256 $SHA"

# Pull it out over HTTP, verified. Receiver is one-shot; retry once on failure.
mkdir -p "$ARTIFACTS"
pull_http() {
  rm -f "$DEST"
  python3 "$D/http_recv.py" "$GW" "$PORT" "$DEST" "$SHA" > /tmp/win-recv.out 2>&1 &
  local recv=$!
  sleep 1
  cat > "$D/push.ps1" <<PS1
curl.exe -s -S -T "$ZIP" "http://$GW:$PORT/artifact.zip"
"curl-rc=\$LASTEXITCODE"
PS1
  "$PY" "$D/winps95.py" < "$D/push.ps1" >/dev/null 2>&1
  wait "$recv"
}
if ! pull_http; then
  echo "windows: HTTP transfer failed once ($(cat /tmp/win-recv.out)); retrying"
  pull_http || { echo "windows: HTTP transfer failed twice: $(cat /tmp/win-recv.out)"; exit 1; }
fi
echo "windows: received $(cat /tmp/win-recv.out)"
echo "windows artifact ready"
