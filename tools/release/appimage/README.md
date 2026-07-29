# AppImage runtime blob

`runtime-x86_64` is the stock AppImage **type-2 runtime** — the small static
ELF that every AppImage starts with. An AppImage is literally this blob with
a squashfs of the AppDir concatenated after it; the runtime mounts its own
tail via squashfuse and execs `AppRun`. Because concatenation is the whole
trick, macOS can produce Linux AppImages with nothing more than
`mksquashfs` (brew install squashfs) — no Linux host in the packaging path.

- Source: https://github.com/AppImage/type2-runtime (release: continuous,
  fetched 2026-07-29)
- Integrity: `runtime-x86_64.sha256` (verify with `shasum -a 256 -c`)
- Consumed by: `tools/release/build-bork-packages.sh` (`build_linux`),
  which emits `dist/linux/Bork-linux-x86_64.AppImage` beside the tarball.

To update: download a newer runtime-x86_64 from the repo's releases,
refresh the .sha256, and re-run packaging. The squashfs is built with zstd
compression, which this runtime's squashfuse supports.
