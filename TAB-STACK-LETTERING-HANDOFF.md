# Handoff: tab stack / group chip lettering — UNRESOLVED

Scope: **only** the tab-strip stack/group chip lettering. Ignore everything else.

## What the user wants

The chip lettering on tab **stacks** (and native tab **groups**) in the tab strip
should look right and consistent. Original request, verbatim:

> "tab group lettering should be the same size as the tab stack. it's a bit
> jammed up in there. so reduce that slightly."

Then, shown two chips side by side — **`Lib 5`** and **`AUDIO`** — the user said:

> "DOES THIS LOOK THE FUCKING SAME TO YOU"

**It does not.** `AUDIO` renders visibly **bigger and bolder** than `Lib`, and the
user wants them to look the same. The user has confirmed:

- The **active/selected state does NOT change the text rendering** ("it doesn't do
  anything different when it's active anyway"). So the difference is NOT the
  `[hasactivetab]` styling.

## What is currently WRONG (unresolved)

`AUDIO` looks larger/bolder than `Lib` even though both measured **11.5px / weight
400** via Marionette. The difference is UNEXPLAINED and NOT yet investigated
properly. Strong candidate not yet ruled out: **`AUDIO` is all-caps** (the user's
stack name) and `Lib` is mixed-case — capitals are visually taller, so all-caps
names read as bigger/bolder at the same font-size. If that's the cause, the fix is
NOT font-size (which has been changed 5 times pointlessly) — it may be nothing (it's
the name), or a deliberate normalization.

**The correct next step** (was interrupted before running): measure the `::before`
computed `font-size`, `font-weight`, `text-transform`, and actual rendered height of
the specific `AUDIO` chip vs the `Lib` chip, and confirm whether they genuinely
differ or it's purely the caps. Do NOT change font-size again before understanding
this.

## The code — file: `browser-features/chrome/common/tab-stacks/styles.css`

The stack chip's visible title is NOT the native label text (that's hidden). It's a
`::before` pseudo showing the `data-bork-title` attribute. Relevant rules **as they
stand now** (all values are the result of my repeated failed guesses — treat them as
suspect, not intentional):

**Stack chip — native label hidden, weight normal** (~line 290):
```css
tab-group[data-bork-stack] .tab-group-label {
  font-size: 0 !important;        /* hides native text; ::before shows the title */
  padding: 0 9px 0 25px !important;
  font-weight: normal !important;
  /* ...box-sizing, border, background, height... */
}
```

**Stack chip title** (~line 357) — the visible name (`Lib`, `AUDIO`, `New Stack`):
```css
tab-group[data-bork-stack] .tab-group-label::before {
  content: attr(data-bork-title);
  font-size: 11.5px;   /* CHANGED 12 -> 11 -> 10 -> 11.5 across builds; none satisfied the user */
  /* flex, overflow, mask-image ... */
}
```

**Stack chip count** (~line 372) — the `5` in `Lib 5`:
```css
tab-group[data-bork-stack] .tab-group-label[data-bork-count]::after {
  content: attr(data-bork-count);
  font-size: 11.5px;   /* was 11px; title was 10px — the mismatch was one theory for "jammed" */
  opacity: 0.7;
}
```

**Native (non-stack) group label** (~line 233):
```css
#tabbrowser-tabs tab-group:not([data-bork-stack]) .tab-group-label {
  font-size: 11.5px !important;   /* CHANGED 12 -> 11 -> 10 -> 11.5 */
}
```

The `data-bork-title` / `data-bork-count` attributes are set by
`browser-features/chrome/common/tab-stacks/index.ts` (search `data-bork-title`).

## What I changed and it DID NOT fix it (font-size churn — all suspect)

- Stack title `::before` font-size: 12px → 11px → 10px → **11.5px** (current).
- Native group label font-size: 12px → 11px → 10px → **11.5px** (current).
- Count `::after` font-size: 11px → **11.5px** (current).
- Native group glyph `::before` size: 15px → **14px** (line ~170) — to match the
  stack icon; probably fine, unrelated to the lettering complaint.

Measurements taken live in the user's real profile (Marionette on
`~/Library/Application Support/Bork/Profiles/p8zoyp7z.default-default`):
`stack title ::before = 11.5px/400`, `tab label = 11.5px/400`,
`count ::after = 11.5px`. So by measurement they match the tabs — yet the user still
sees `AUDIO` as bigger/bolder than `Lib`. **This contradiction is the crux and is
unexplained.**

## Notes for whoever picks this up

- Build/verify loop: this is the noraneko chrome layer. Edit the CSS, then
  `./tools/release/production-build.sh bork-runtime-152.0.7-2 --skip-runtime
  --no-upload mac`, install to `~/Applications/Bork.app`, and inspect via
  `bork --marionette -remote-allow-system-access` + `deno task dev-tool eval/screenshot`.
- **Do not** trust "it's the same size" from a fresh scratch profile — verify on the
  user's real chips (`Lib`, `AUDIO`) specifically.
- The buildID is static across `--skip-runtime` builds; a fresh profile always shows
  the latest CSS, so that is NOT the cause of "looks unchanged" (checked).
- My failure mode: I changed font-size 5 times without ever measuring `AUDIO` vs
  `Lib` directly or considering the all-caps explanation. Start there.
