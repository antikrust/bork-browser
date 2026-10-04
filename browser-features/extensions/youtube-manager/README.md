# YouTube Manager

A browser extension that makes YouTube live chat readable: filter by word or by
person, silence someone in one click, let a phrase get them blocked outright,
and read the whole thing as threads instead of a waterfall.

## What it does

**Say this and you're gone.** A list of phrases where saying one *once* costs
the speaker everything — the message, everything they already had on screen, and
everything they say afterwards. They go onto the blocklist, so it survives a
reload. This is the list to put `woke`, `snowflake` and friends in.

**Words and phrases.** The milder list: hides the offending message and leaves
the person alone. Plain text matches anywhere; `/pattern/flags` is a regular
expression that keeps exactly the flags you give it. Lines starting with `#` are
notes.

**SHUT UP button.** Hovering any message shows one. Click it and that person is
hidden — retroactively for what is on screen, permanently for what comes next.
There is one on every message in the threaded view too.

**Repeat offenders.** Anyone caught by the milder word rules three times (your
number, `0` to switch it off) is blocked automatically, with an Undo in the
toast if it was unfair.

**Threads.** Chat has no reply feature, so people improvise one by typing
`@Someone`. The threaded view resolves those mentions and renders the reply
underneath the message it answers, with a thread jumping to the bottom when it
gets a new reply. Toggle it from the pill in the bottom-left of the chat, or
press Escape to close it.

**Blocklist.** Local, yours, exportable as JSON. Name matching ignores case,
spacing, full-width letters and the zero-width padding people use to slip past
exactly this kind of list.

## How it ships

This is part of bork. `installThemePack()` in `tools/src/injector.ts` zips this
directory into `distribution/extensions/youtube-manager@bork.xpi` on every build, next to
uBlock Origin and Dark Reader, and Firefox installs everything in that directory
as an ordinary add-on.

What that means for someone running bork:

- It arrives on the next launch of a build that carries it. An existing profile
  is fine — a new one is not required.
- It is visible and removable in `about:addons` like anything else.
- **Removing it sticks.** `installDistributionAddon` records
  `extensions.installedDistroAddon.shutup@bork`, and on later startups it sees
  the add-on is gone but the pref is set, and leaves it uninstalled. A bork
  update will not push it back.
- Raising `version` in `manifest.json` upgrades it in place for everyone who
  kept it, because a distribution add-on only replaces an installed one when its
  version is strictly newer.

To try a change without cutting a release, run
`deno task feles-build misc distribution` and relaunch: the pack is rebuilt from
this directory.

**Chrome / Edge**, for cross-browser work — `chrome://extensions`, turn on
Developer mode, *Load unpacked*, pick this folder.

**Stock Firefox** refuses unsigned add-ons on release builds; use
`about:debugging#/runtime/this-firefox` → *Load Temporary Add-on…* →
`manifest.json`, which lasts until the browser closes. bork itself has no such
problem: it ships `xpinstall.signatures.required=false`.

## Using it

Open a stream with live chat. The chat lives in its own iframe and that is where
the extension runs: a round **Threads** button joins the chat's own controls
next to the emoji picker. The panel it opens has the Threads and Hidden tabs,
and Settings lives in its header (also in about:addons → Preferences).

Word lists are plain text, one word or phrase per line:

```
farage is brilliant
woke
snowflake
communist
binface is a cunt
```

## Development

```bash
deno task test:host                          # runs test/logic_test.ts with the rest
deno task feles-build misc distribution      # rebuild the shipped add-on pack
```

The tests cover rule matching and threading and need no browser, no live stream
and nobody saying anything awful.

The filtering and threading logic lives in `src/filters.js` and `src/threads.js`
with no DOM and no storage in them, which is what lets the tests run without a
browser or a live stream. `src/content.js` is the only part that touches
YouTube's DOM.

Two decisions worth knowing before changing it:

- Hidden messages get a CSS class; they are never removed from the DOM. YouTube
  owns that list — it trims, recycles and rebuilds it — and removing its
  children makes it fight back.
- The threaded view is our own DOM in an overlay panel, not a rearrangement of
  YouTube's list. Moving a reply up to its parent means moving a node YouTube is
  about to trim while it is managing scroll position. Close the panel and the
  normal chat is untouched underneath.

### Known limits

- People are matched by display name, because that is what the chat DOM exposes.
  Two viewers with the same display name are the same person as far as the
  blocklist is concerned.
- Threading is inferred from `@mentions`. Somebody replying without one is not
  something any amount of parsing can recover.
