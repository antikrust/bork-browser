# bork

A compact fork of Floorp 12 (Firefox 152), with the AI stack deleted and the
telemetry taken out.

**https://borkbrowser.online** — macOS, Linux, Windows.

## What it is

Firefox still runs **Manifest V2 extensions**, so the complete **uBlock
Origin** works here — not the declawed Lite version that Chrome's Manifest V3
forced on everyone else. That is most of the reason this exists.

The rest is what got removed and what got built on top.

### Removed

- **No AI.** ONNX Runtime, transformers.js, wllama, openai.mjs, the model hub
  and both MLEngine actors are deleted from the build, not switched off.
  `browser.ml.enable` is false.
- **No telemetry**, no data sharing, no crash reports, no accounts.

Translation still works — it never used any of that.

### Built

Workspaces, tab stacks, tab groups, zen mode, split view, mouse gestures,
side panels (notes, downloads, a local translator), a command palette on F2,
an address bar that hides completely, and Chromium extension installs.

**Coming from Vivaldi:** bork imports your Vivaldi workspaces *including which
tabs live in which workspace* — it reads Vivaldi's own session data, so a
workspace with twenty tabs arrives as a workspace with twenty tabs. Passwords,
bookmarks, history and cookies import from Vivaldi, Chrome, Edge or Safari.

## Keys

The chrome controls sit on ⌘⌥ (macOS) / Ctrl+Alt (Windows, Linux) rather than
bare keys, so they cannot fire while you are typing into a page.

| | |
|---|---|
| `⌘⌥ + drag` | move the window from anywhere on it, no title bar needed |
| `⌘⌥A` | hide or show the address bar |
| `⌘⌥S` | hide or show the panel sidebar |
| `⌘⌥W` | hide or show the workspaces rail |
| `⌘⌥Z` | zen mode — toolbars and status bar retract, leaving the page |
| `⌘←` `⌘→` | back and forward (`⌘[` and `⌘]` also work) |
| `F2` | command palette |

**Double-click a tab** to type a URL straight into it. With the address bar
hidden this is how you navigate: Enter goes, Escape backs out. Tabs in a
stack's second row do the same.

## Installing

- **macOS** — open the DMG, drag Bork to Applications. Builds are self-signed,
  so first launch is right-click → Open.
- **Linux** — `tar -xzf Bork-linux-x86_64.tar.gz && ./bork/bork`
- **Windows** — unzip anywhere, run `bork.exe`. SmartScreen will grumble;
  More info → Run anyway.

## Building

The dev workflow is orchestrated by `feles-build`, a Deno task.

```bash
deno task feles-build stage                      # production assets, browser in dev mode
deno task feles-build build --phase before-mach  # production assets
deno task feles-build build --phase after-mach   # post-mach injection
```

The Gecko runtime lives in a separate repo,
[bork-runtime](https://github.com/100mountains/bork-runtime). The full release
chain — runtimes, feature layer, packaging, upload — is
`tools/release/production-build.sh`.

Notes on the trickier internals are in
[`docs/development/`](docs/development/).

## License

[Mozilla Public License 2.0](https://www.mozilla.org/en-US/MPL/2.0/)

bork is based on Floorp, which is based on Mozilla Firefox. It is not
affiliated with, endorsed by, or connected to Mozilla, Ablaze or the Floorp
project.

### Built on

- **[Mozilla Firefox](https://www.mozilla.org/firefox/)** — MPL 2.0 —
  [Mozilla & contributors](https://www.mozilla.org/credits/)
- **[Floorp](https://github.com/Floorp-Projects/Floorp)** — MPL 2.0 — Ablaze
- **[Noraneko](https://github.com/nyanrus/noraneko-runtime)** — MPL 2.0 —
  [NyanRus](https://github.com/nyanrus)
- **[Firefox UI FIX (Lepton)](https://github.com/black7375/Firefox-UI-Fix)** —
  MPL 2.0 — [black7375](https://github.com/black7375)
- **[Paxmod](https://github.com/numirias/paxmod)** — MIT —
  [numirias](https://github.com/numirias/)
- **[Fushra Pulse](https://pulsebrowser.app/)** — MPL 2.0 —
  [Fushra](https://github.com/Fushra)
- **userChromeCSS Loader** — MIT — Griever

If you maintain any of the above and your attribution is wrong or missing,
open an issue and it gets fixed.
