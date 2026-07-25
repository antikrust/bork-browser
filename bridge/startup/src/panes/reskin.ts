/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Reskin about:preferences to the hub's look (the retired React settings
 * app): daisyUI palette, card-styled sections, hub-style sidebar.
 *
 * Strategy: Firefox in-content pages are themed through --in-content-* CSS
 * variables, so overriding those with the hub palette restyles the native
 * panes and subdialogs wholesale; on top of that, groupboxes become cards
 * (radius .5rem, base-200 surface) and the category sidebar gets the hub's
 * rounded, icon-led item style. Palette values are the RESOLVED daisyUI
 * light/dark themes lifted from the hub's built CSS.
 */

import { doc } from "./framework.ts";

const RESKIN_CSS = `
/* ---------- palette (daisyUI light, dark via media query) ----------
   Hub layering: page canvas is the DARKER surface, cards the lighter one
   (daisyUI: body base-200/300, Card bg base-100). */
:root {
  --bork-base-100: oklch(100% 0 0);
  --bork-base-200: oklch(98% 0 0);
  --bork-base-300: oklch(95% 0 0);
  --bork-canvas: oklch(98% 0 0);
  --bork-card: oklch(100% 0 0);
  --bork-base-content: oklch(21% .006 285.885);
  --bork-primary: oklch(45% .24 277.023);
  --bork-link: #007aff;
  --bork-radius-box: .5rem;
  --bork-radius-field: .25rem;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bork-base-100: oklch(25.33% .016 252.42);
    --bork-base-200: oklch(23.26% .014 253.1);
    --bork-base-300: oklch(21.15% .012 254.09);
    --bork-canvas: oklch(21.15% .012 254.09);
    --bork-card: oklch(25.33% .016 252.42);
    --bork-base-content: oklch(97.807% .029 256.847);
    --bork-primary: oklch(58% .233 277.117);
  }
}

/* ---------- in-content vars: native panes + dialogs adopt the palette ---------- */
:root {
  --in-content-page-background: var(--bork-canvas) !important;
  --in-content-page-color: var(--bork-base-content) !important;
  --in-content-box-background: var(--bork-card) !important;
  --in-content-box-background-odd: var(--bork-base-200) !important;
  --in-content-categories-background: var(--bork-canvas) !important;
  --in-content-item-selected: var(--bork-primary) !important;
  --in-content-item-selected-text: #ffffff !important;
  --in-content-item-hover: color-mix(in oklab, var(--bork-primary) 14%, transparent) !important;
  --in-content-item-hover-text: var(--bork-base-content) !important;
  --in-content-accent-color: var(--bork-primary) !important;
  --in-content-accent-color-active: var(--bork-primary) !important;
  --in-content-link-color: var(--bork-link) !important;
  --in-content-link-color-hover: var(--bork-link) !important;
  --in-content-border-color: color-mix(in oklab, var(--bork-base-content) 12%, transparent) !important;
  --in-content-table-background: var(--bork-card) !important;
  --in-content-button-background: var(--bork-base-300) !important;
  --in-content-button-background-hover: color-mix(in oklab, var(--bork-base-content) 10%, var(--bork-base-300)) !important;
  --in-content-button-background-active: color-mix(in oklab, var(--bork-base-content) 16%, var(--bork-base-300)) !important;
  --in-content-primary-button-background: var(--bork-primary) !important;
  --in-content-primary-button-background-hover: color-mix(in oklab, black 12%, var(--bork-primary)) !important;
  --in-content-primary-button-background-active: color-mix(in oklab, black 20%, var(--bork-primary)) !important;
  --link-color: var(--bork-link) !important;
  --color-accent-primary: var(--bork-primary) !important;
  background-color: var(--bork-canvas) !important;
  color: var(--bork-base-content) !important;
}

/* ---------- hub-style category sidebar (moz-page-nav custom element) ----------
   The nav buttons' internals live in shadow DOM, so color comes from the
   design tokens they consume — which map onto the in-content vars overridden
   above. Host-level styling here handles shape and spacing only. */
#categories {
  background-color: transparent !important;
  margin-top: 8px !important;
  --page-nav-button-border-radius: var(--bork-radius-box);
  --page-nav-button-background-color-selected: var(--bork-primary);
  --page-nav-button-indicator-width: 0px;
}
/* solid pill needs readable text/icon on primary */
moz-page-nav-button[selected],
#categories moz-page-nav-button[selected] {
  --page-nav-button-text-color: #ffffff;
  --icon-color: #ffffff;
  color: #ffffff;
}
moz-page-nav-button {
  border-radius: var(--bork-radius-box);
}

/* ---------- panes: cards ---------- */
groupbox,
#mainPrefPane groupbox {
  background-color: var(--bork-card) !important;
  border: 1px solid color-mix(in oklab, var(--bork-base-content) 8%, transparent) !important;
  border-radius: var(--bork-radius-box) !important;
  padding: 16px !important;
  margin-block: 10px !important;
  box-shadow: none !important;
}
groupbox h2 {
  font-size: 1.05em !important;
  font-weight: 600 !important;
  margin-block: 0 6px !important;
}
#mainPrefPane h1 {
  font-size: 1.6em !important;
  font-weight: 700 !important;
}

/* form controls pick up the field radius */
checkbox .checkbox-check,
input[type="checkbox"] {
  border-radius: var(--bork-radius-field) !important;
  accent-color: var(--bork-primary);
}
button, menulist {
  border-radius: var(--bork-radius-field) !important;
}
.text-link, a {
  color: var(--bork-link) !important;
}

/* search field, hub-style rounding */
#searchInput {
  border-radius: var(--bork-radius-box) !important;
}

/* ---------- Firefox's "Same settings, new look!" promo ----------
   An upstream announcement about MOZILLA's settings redesign, complete with a
   "Got it" button, sitting above the first real setting until dismissed. It is
   meaningless here — this page is bork's own reskin, not Firefox's redesign —
   and it comes back for every new profile. */
.settings-redesign-promo {
  display: none !important;
}

/* ---------- no grey band across the top ----------
   #search-container painted a grey band around the search field (64px of top
   padding plus an opaque background). Stock needs that background because the
   container is position:sticky with z-index 2 — it has to mask the content
   scrolling beneath it. So dropping the background alone would let the page
   scroll THROUGH the search field; the stickiness goes with it, and the search
   field simply scrolls with the page like every other row. */
#search-container {
  padding-top: 8px !important;
  background: transparent !important;
  position: static !important;
}

/* ---------- native features bork doesn't ship ----------
   bork has no AI and no vertical tabs (the bork vertical-tab feature was
   removed; the compact tab strip is horizontal by design). Hide Firefox's
   native settings surfaces for both so the page matches the product:
   the AI Features category+pane, the Browser Layout chooser in
   Tabs & Browsing, and Appearance's cross-link to it. */
#category-ai-features,
[data-category="paneAi"],
setting-pane[data-category="paneAi"] {
  display: none !important;
}
setting-group:has([id^="browserLayout"]),
groupbox:has([id^="browserLayout"]) {
  display: none !important;
}
#related-settings-tabs-browsing-link,
setting-group [id="related-settings-tabs-browsing-link"] {
  display: none !important;
}

/* ---------- grid backdrop ----------
   Math-book graph paper on the scrolling content region (cards sit on
   top): a faint minor grid with a slightly stronger major line every
   4 squares. Color derives from the text color at very low strength so
   it works in both themes. */
.main-content {
  background-image:
    /* major lines every 4 squares */
    linear-gradient(
      color-mix(in oklab, var(--bork-base-content) 5%, transparent) 1px,
      transparent 1px
    ),
    linear-gradient(
      90deg,
      color-mix(in oklab, var(--bork-base-content) 5%, transparent) 1px,
      transparent 1px
    ),
    /* minor lines */
    linear-gradient(
      color-mix(in oklab, var(--bork-base-content) 3%, transparent) 1px,
      transparent 1px
    ),
    linear-gradient(
      90deg,
      color-mix(in oklab, var(--bork-base-content) 3%, transparent) 1px,
      transparent 1px
    ) !important;
  background-size: 96px 96px, 96px 96px, 24px 24px, 24px 24px !important;
}
`;

export function applyBorkReskin(): void {
  if (doc.getElementById("bork-prefs-reskin")) return;
  const style = doc.createElement("style");
  style.id = "bork-prefs-reskin";
  style.textContent = RESKIN_CSS;
  doc.head?.appendChild(style);
}
