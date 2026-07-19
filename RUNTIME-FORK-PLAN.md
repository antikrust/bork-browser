# Runtime Fork — Migration Plan

**Goal:** own the Gecko runtime derp is built on, so that (a) `dev-assets.floorp.app` stops
being a single point of failure, (b) the compiled branding tier becomes ours, making the
upcoming rename a config change rather than a patch, and (c) we can patch Gecko when we need to.

**Decided:** fork the repo and build artifacts on our own machines (self-hosted), not GitHub
Actions. Linux/Windows development is a wanted side-effect.

**Status:** **https://github.com/100mountains/derp-runtime** — private, mirrored from
`Floorp-Projects/Floorp-Runtime` (47 branches, 388 tags, 1.9 GB).

Named `derp-runtime` deliberately: `package.yml` derives the runtime repo as
`${{ github.repository }}-runtime`, so this name makes the existing CI logic resolve correctly
without edits. If the browser is renamed, this repo renames with it.

A bare mirror lives at `/Volumes/Instruments/derp-build/derp-runtime.git` — re-syncing from
upstream is `git fetch --all` there, then a mirror push.

> Effort figures below are estimates with the reasoning shown, not measurements. An earlier
> estimate in `ARCHITECTURE-AUDIT.md` was wrong by roughly an order of magnitude because it
> assumed artifact builds; these assume **full Gecko compiles**, which is what the runtime
> mozconfigs actually specify.

---

## The key architectural facts

**One Linux box can build all three desktop platforms.** Upstream's `common-build.yml` runs on
`ubuntu-latest` and drives Linux, Windows (`--target=x86_64-pc-windows-msvc`) and macOS targets
from that single host. This is why the "PC route" works.

**Exactly one step needs a real Mac**, and only once: extracting the macOS SDK from Xcode.
`wrapper-mac-build.yml` does this on a `macos-26` runner, tars the SDK, and hands it to the Linux
builder as an artifact. We do it once on the MacBook and store the tarball.

**PGO is optional and expensive.** Upstream runs separate profile-generation workflows
(`generate-pgo-profile-linux.yml`, `generate-pgo-profile-windows.yml`, `mac_pgo.yml`).
Instrumented build → profile run → optimised build is roughly 3× a plain build. **Start with PGO
off.** Turn it on once the pipeline is boring.

**The compiled branding tier lives in the mozconfigs** — these four lines are the whole reason
this fork makes the rename easy:

```
ac_add_options --with-app-name=floorp
ac_add_options --with-app-basename=Floorp
ac_add_options --with-distribution-id=app.floorp
ac_add_options --with-branding=browser/branding/noraneko-unofficial
```

---

## Hardware — measured 2026-07-19

### Build box: `sentience`

```
OS:    Linux Mint 22 (Ubuntu 24.04 base)
CPU:   Intel i7-9700K @ 3.60GHz — 8 cores, no HT (2018)
RAM:   31 GB total, 17 GB available
/:     219 G,  1.8 G free   ← 100% FULL
/mnt/terra: 916 G, 260 G free
```

**Verdict: viable, at the floor.** RAM is genuinely fine — that's the spec that would have
blocked us. Cores are the constraint.

**Measured 2026-07-19: `mach build` took ~23 min, not the 2–4 h estimated.** The estimate was
badly pessimistic for a plain non-PGO, non-packaging build; the 9700K coped fine. Add time for
`mach package`, and roughly 3× if PGO is ever turned on. But the working assumption "a build is
an overnight job" was wrong — clean incremental rebuilds will be minutes with ccache warm.

**The real constraint was memory, not CPU.** See M1 — the `gkrust` LTO step OOM-killed rustc
(17 GB peak) until a 32 GB swapfile was added. **Swap is a hard prerequisite on this box**, not
an optimisation.

**Two disk actions required before M0:**

1. **`/` has 1.8 GB free and `mach bootstrap` writes to `~/.mozbuild` by default** (toolchains,
   several GB). Set `MOZBUILD_STATE_PATH=/mnt/terra/.mozbuild` before bootstrapping or M0 fails
   immediately, having filled the root disk.
2. Everything — checkout, objdirs, ccache — lives under `/mnt/terra`. 260 G free covers the
   1.9 GB checkout plus **30–40 GB objdir per target**; three targets plus ccache is roughly
   150 G. It fits, without much room to spare. Watch it.

### Windows: an existing second route

`sentience` already runs KVM/libvirt with a Windows build VM (`bob-winbuild`,
192.168.122.128), provisioned by `bob3/tools/setup-bob3-release-builder.sh`. That is a live
alternative to cross-compiling Windows from Linux in M3 — a native build in the VM may well beat
fighting the MSVC cross-toolchain. Evaluate both.

### Mac: SDK extraction only

The MacBook is at **8.2 GB free of 460 GB (99% full)**. It never builds — it is needed once, to
extract the macOS SDK from Xcode. That still needs headroom; clear space before M0.

The runtime clone lives on `/Volumes/Instruments/derp-build/` (3.6 TB, 1.8 TB free), not on the
internal disk.

---

## Milestones

### M0 — Prerequisites
- [ ] Free disk on the MacBook (needs headroom for Xcode + SDK tarball)
- [ ] Confirm the Linux box's cores / RAM / free disk against the table above
- [ ] Extract the macOS SDK on the Mac, tar it, store it somewhere both machines can reach
      (follow `wrapper-mac-build.yml`'s SDK step)
- [ ] Clone the fork on the Linux box, `./mach bootstrap`

**Exit:** `./mach build` starts without configure errors on Linux.

### M1 — First self-built Linux runtime, pinned to 152 ✅ DONE (2026-07-19)

Built a working **Mozilla Floorp 152.0.7** on `sentience`, verified by a headless launch
(rendered `about:buildconfig`, wrote a screenshot, exit 0, no crashes) — not just `--version`.

- [x] Clone `nora-0.2.0` (tip `cc0c8e744c9`, the `152.0.6` merge) to `/mnt/terra`. This *is* the
      152 line; `153.0` is unmerged and deferred to M6.
- [x] All build state off the full root disk via `/mnt/terra/derp-runtime-build/buildenv.sh`
      (`MOZBUILD_STATE_PATH`, `RUSTUP_HOME`, `CARGO_HOME`, `CCACHE_DIR`, `TMPDIR`)
- [x] Rust 1.90.0, `./mach bootstrap --application-choice browser`
- [x] `mozconfig-linux-x86_64` (PGO off, ccache on, `MOZ_OBJDIR` on `/mnt/terra`)
- [x] `./mach build` → working binary at `obj-linux-x86_64/dist/bin/floorp`

**What actually happened vs the estimate:**

| Expected | Actual |
| --- | --- |
| 2–4 days, "riskiest milestone" | One afternoon; one real failure, understood and fixed |
| 2–4 h build | **~23 min** wall (`mach build`, no packaging) |
| 30–40 GB objdir | **15 GB** (packaging into a tarball will add more) |

**The one failure — and it was not the fork's fault.** First build compiled cleanly for 22 min,
then the `gkrust` LTO step (fat LTO, `codegen-units=1`, `debuginfo=2`) was **OOM-killed**: rustc
wanted 17 GB, the box has 31 GB, a QEMU VM (`bob-winbuild`) held 10–12 GB, and swap was 2 GB.
`dmesg` confirmed `oom-kill … task=rustc`. This is a known Firefox build pressure point —
upstream ships `allocate-swap.sh` for exactly it. **Fix: a 32 GB swapfile on `/mnt/terra`**
(`bob-winbuild` autostart also disabled — it is now on-demand per the owner's call). Rebuild
passed in 23 min.

**Packaging + derp-compatibility — DONE and PROVEN (2026-07-19):**
- [x] Package into flat `floorp-linux-x86_64-moz-artifact.tar.xz` (8,545 entries, matches
      upstream's 8,543). **Required `--enable-chrome-format=flat`** — the base mozconfig lacks
      it; CI adds it via `setup-floorp.sh`. Without it you get omni.ja and derp's patcher can't
      apply. Staged at `sentience:/mnt/terra/derp-runtime-build/artifacts/` with a `.sha256`.
- [x] **Proved derp-compatible by dry-run:** `git apply --check` (derp's exact invocation) for
      all 13 patches → **12/13 apply clean**. The 13th, `derp-branding.patch`, fails *as
      expected* — our build used default (nightly) branding, so `updater.ini` says "Nightly
      Update" not the "Floorp Update" the patch targets. That failure **is** the M2 proof: the
      branding tier is a build-time choice, so building with derp branding retires the patch
      rather than requiring it to apply.

**Exit:** ✅ a runtime we built, launches as FF 152.0.7, and takes 12/13 of derp's patches
unchanged. The 13th is branding, addressed by M2.

**This changes M2:** don't just "set branding in-tree" abstractly — build with
`--with-branding=browser/branding/derp` (a dir we create from the existing derp assets in
`browser-features/branding/` + `skin/derp/`), matching how upstream copies `floorp-official`
in via `.github/assets/branding`. That makes updater.ini/brand.* say "Derp" at build time and
lets `derp-branding.patch` be deleted for Linux/Windows (stays macOS-only while macOS is
deferred).

### M2 — Branding moves in-tree, `derp-branding.patch` dies
- [ ] Create `browser/branding/derp/` in the fork (copy `noraneko-unofficial`, swap assets)
- [ ] Set the four mozconfig lines to derp
- [ ] Set locale branding in-tree: `brand.ftl`, `brand.properties`, `brand.dtd`, `updater.ini`
- [ ] Rebuild, verify **both** tiers: `--version` / `Services.appinfo.name` (compiled) **and**
      the macOS app menu / updater dialog (text)
- [ ] **Only then** delete `tools/patches/derp-branding.patch`

**Why this ordering:** the patch covers the *text* tier only and says so in its own header. The
mozconfig covers the *compiled* tier it explicitly cannot reach. Removing the patch before this
milestone regresses the app menu, "Set as Default Browser", and the updater dialog.

**Bonus:** this also fixes the langpack caveat in the patch's header — an installed language
pack currently overrides the name on non-en-US profiles, which no post-build patch can solve.

**This is the milestone that makes the rename cheap.** Do the rename here, or immediately after.

### M3 — Windows (macOS deferred)
- [ ] Windows target. **Two routes — evaluate both:**
      (a) cross-compile from Linux, as upstream does (`--target=x86_64-pc-windows-msvc`);
      (b) build natively in the existing `bob-winbuild` KVM VM on `sentience`.
      Route (b) may well be less painful than the MSVC cross-toolchain, and the VM already
      exists and is provisioned.
- [ ] Verify it launches on Windows

**Estimate:** 2–3 days.

#### macOS is deferred — blocked on the SDK, not on disk

**Gecko in this tree requires macOS SDK 26.4**, hard-coded:

```python
# build/moz.configure/toolchain.configure:254
def mac_sdk_min_version():
    return "26.4"
```

Configure fails below that with *"SDK version is too old"*. This is Firefox's own requirement,
not upstream's preference — which is why `wrapper-mac-build.yml` extracts the SDK from a
`macos-26` runner rather than letting `--enable-bootstrap` fetch it.

Our Mac has **Xcode 16.4 → `MacOSX15.5.sdk`**, on macOS 15.5 (Darwin 24.5). Closing the gap
means Xcode 26.x (~30 GB — installable to `/Volumes/Instruments`, so disk is solvable) and
likely a macOS upgrade first.

**Decision: keep consuming upstream's macOS `.dmg` for now.** A hybrid — our runtime on Linux
and Windows, upstream's on macOS — still removes the `dev-assets` dependency on the platforms we
build, and still gives us the compiled branding tier there. Revisit when the Mac is on macOS 26
for unrelated reasons. **Do not let this gate M1/M2.**

Consequence for M2: the branding milestone lands on Linux/Windows first. macOS keeps needing
`derp-branding.patch` plus `tools/release/brand-mac-bundle.sh` until its runtime is ours, so
**the patch cannot be deleted outright** — it becomes macOS-only. Revisit its scope at M2 rather
than removing it.

### M4 — Self-hosted CI
- [ ] Register the Linux box as a self-hosted runner (or a plain cron + script — CI here is a
      convenience, not a requirement)
- [ ] Port `wrapper-build-*.yml` to it, dropping the GitHub-hosted assumptions
- [ ] Publish artifacts somewhere derp can fetch (GitHub releases on the fork is simplest and
      matches upstream's own layout)

**Note:** Actions are disabled on `100mountains/derp` by project policy. That policy is about
the *feature* repo; decide explicitly whether it extends to the runtime fork.

### M5 — Point derp at our runtime

**Design notes (from reading `initializer.ts`, 2026-07-19):**

- `decompressBin()` looks for a **local** `*.tar.xz` in the working dir *before* downloading
  (line ~351). So the fastest proof needs no code change: drop our
  `floorp-linux-x86_64-moz-artifact.tar.xz` where feles-build looks and it uses ours. The
  `RUNTIME_BASE_URL` edit is the durable fix so *fresh* checkouts and other machines fetch ours.
- `run()` gates on `BIN_VERSION` vs the `VERSION` constant; to swap a runtime under an existing
  `_dist/bin`, remove `_dist/bin` (or the version file) to force re-extraction.
- **Platform reality:** feles-build runs on the *host* platform. Our runtime is Linux, so it can
  only be exercised by derp running **on `sentience`** — not on the darwin dev Mac, which wants a
  macOS runtime. The natural end-to-end test is: clone derp on `sentience`, `deno install`, drop
  our artifact, `feles-build stage`, confirm the feature layer loads on our own runtime. That is
  a real environment stand-up, so it is its own step.

---

Single integration point — `tools/src/initializer.ts:20`:

```ts
const RUNTIME_BASE_URL = "https://dev-assets.floorp.app/floorp-runtime-builds/";
```

- [ ] Repoint at our own artifacts
- [ ] Add a real version pin in-tree (see audit §7.2 — nothing currently records "FF152";
      `VERSION` is a cache-buster and `version.txt` says `1.0.0`)
- [ ] Cache all platforms locally, including the macOS `.dmg` that `build/runtimes/` lacks

**Exit:** `deno task feles-build stage --marionette` runs against a runtime we built. **This is
the point where the dependency on Floorp's infrastructure is gone.**

### M6 — Ongoing
- [ ] Take `153.0` as the first sync exercise; establish the per-release rebase cost empirically
- [ ] Consider PGO once builds are routine
- [ ] Signing/notarisation only when shipping publicly under the new name (Apple dev account +
      a Windows code-signing cert — real money, deferred)

---

## Risks

| Risk | Mitigation |
| --- | --- |
| Toolchain fights in M1 eat a week | PGO off, Linux only, one target. Fall back to upstream artifacts at any time — M5 is the last step, so nothing is committed until then. |
| MacBook disk (8.2 GB free) blocks the SDK step | Clear space in M0; it is a prerequisite, not a nice-to-have. |
| Upstream moves to 153+ while we sit on 152 | Intentional. Pin first, sync deliberately in M6. |
| Self-hosted runner is a pet, not cattle | Script the build so it is reproducible from a clean checkout; document the machine's setup. |
| Building Firefox is genuinely a lot of work for one person | The whole plan is reversible until M5. If M1 is miserable, mirroring upstream artifacts still kills the SPOF for an afternoon's work. |

---

## What this does *not* solve

Forking the runtime does nothing about the feature layer's coupling to Firefox internals
(~1,800 call sites, no compat layer) or about Lepton (39k lines of third-party
Firefox-DOM-coupled CSS). Those are separate decisions — see `ARCHITECTURE-AUDIT.md` §6–7.
Owning the runtime does, however, mean a breaking Firefox change is something we choose when to
absorb rather than something that arrives.
