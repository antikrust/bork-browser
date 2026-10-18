# The dev browser: logins and extension testing

The dev browser is what `deno task feles-build stage` launches: the runtime copy at
`_dist/bin/floorp/Floorp.app` running against the profile at `_dist/profile/test`.
That profile is persistent — nothing in the tooling wipes it — and it behaves like a
normal user profile, so you sign in to sites directly in it and the sessions stick.
There is no need to copy a real profile over to test anything that needs an account.

```bash
deno task feles-build stage                 # plain launch
deno task feles-build stage --marionette    # launch drivable by dev-tool
```

## Signing in (Google included)

Sign in to Google, GitHub, YouTube or anything else inside the dev browser the usual
way. Cookies, sessions and saved passwords persist across launches, across
`--marionette` launches, and across `dev-tool stop` / killed browsers.

This works because the dev browser does not present itself as an automated browser:

- **`navigator.webdriver` is always `false` for web pages.** Gecko reports a page as
  automated whenever Marionette is running, and Google refuses sign-in in browsers that
  do. `tools/patches-dev/` patches the dev runtime only, so content processes never see
  Marionette as running. The parent process still does, so Marionette and `dev-tool`
  work normally. The patcher applies the set on every stage run (marker:
  `_dist/bin/applied_dev_patches/`).
- **Marionette does not rewrite the profile's prefs.** By default `--marionette` applies
  the remote agent's "recommended preferences" (password saving off, popup blocker off,
  safe browsing off, ~110 in total) and resets them only on a clean shutdown, so every
  killed dev browser left them stuck in the profile. The dev `user.js`
  (`tools/src/dev_env_manager.ts`) sets `remote.prefs.recommended=false`, so they are
  never applied. The 94 that had already accumulated were cleared from
  `_dist/profile/test/prefs.js` on 2026-10-17.

Neither change reaches users: release packaging applies only `tools/patches/`, and the
mac fallback lane that copies the dev app reverses `tools/patches-dev/` on its copy.

If a site ever says the browser "may not be secure" or looks automated, check that
`_dist/bin/applied_dev_patches/` holds both patches and that a page reports
`navigator.webdriver === false`:

```bash
deno task dev-tool eval "navigator.webdriver" -c content
```

The profile lives under `_dist/`, which is gitignored. It holds real sessions — never
copy it into the repo or a package.

## Testing extensions against it

Our own extensions live as source under `browser-features/extensions/<name>/`
(YouTube Manager, cyberswine); third-party ones sit next to them as `.xpi` files. Every
build zips them into `distribution/extensions/`, and Firefox installs that directory
into the profile as ordinary add-ons.

Because the dev profile is signed in, extensions can be tested against real accounts:
YouTube Manager against a live stream's chat while signed in to YouTube, anything that
depends on a Google session, and so on.

### Fast loop: load from source

A temporary add-on overrides the installed copy until the browser closes, and needs no
rebuild and no version bump.

- By hand: `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** →
  pick the extension's `manifest.json`.
- From dev-tool (browser launched with `--marionette`):

```bash
deno task dev-tool eval '(async function () {
  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
  const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
  const addon = await AddonManager.installTemporaryAddon(
    new FileUtils.File("/Volumes/DATA/github/bork/bork-browser/browser-features/extensions/youtube-manager"));
  return JSON.stringify({ id: addon.id, version: addon.version, active: addon.isActive });
})()'
```

Edit the source, run it again to reload, then drive the extension with
`dev-tool navigate` / `eval -c content` against the signed-in pages.

### Testing the shipped copy

To test what users actually get, rebuild the pack and relaunch:

```bash
deno task feles-build misc distribution
```

An existing profile only replaces an installed distribution add-on when the
`manifest.json` `version` is **strictly newer**, so bump it, or the dev profile keeps
the old build. Removing a distribution add-on in `about:addons` sticks
(`extensions.installedDistroAddon.<id>` is recorded); later builds will not reinstall it.

### Helpers

`tools/testing/marionette.py` is a small Marionette client for driving the dev browser
from Python — trusted mouse input, several tabs, async page scripts.
`tools/testing/extension_storage.py` reads an extension's `storage.local` out of a
copied profile database, read-only.

### Logic tests

Extension logic that has no DOM or storage (YouTube Manager's `src/filters.js` and
`src/threads.js`) is covered by host tests that need no browser:

```bash
deno task test:host
```
