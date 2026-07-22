/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import i18next from "i18next";
import { createSignal, onCleanup } from "solid-js";
import { addI18nObserver } from "#i18n/config-browser-chrome.ts";

/** How long the button shows its "copied" tick before returning to normal. */
const COPIED_MS = 1200;

/**
 * What a user means by "the URL in the address bar": normally the loaded
 * page's full URL — NOT gURLBar.value, which is the trimmed display form
 * ("github.com/x", scheme stripped). While the user is typing, though, the
 * bar shows their text and pageproxystate goes "invalid"; copying the
 * previous page's URL then would be a surprise, so the typed value wins.
 */
function currentAddress(): string {
  const urlbar = globalThis.gURLBar;
  if (urlbar?.getAttribute("pageproxystate") === "invalid") {
    return urlbar.value ?? "";
  }
  return globalThis.gBrowser?.selectedBrowser?.currentURI?.spec ?? "";
}

export function UrlbarCopyButton() {
  const [copied, setCopied] = createSignal(false);
  const [tooltip, setTooltip] = createSignal(i18next.t("urlbar.copyAddress"));

  addI18nObserver(() => setTooltip(i18next.t("urlbar.copyAddress")));

  let resetTimer: number | undefined;
  onCleanup(() => globalThis.clearTimeout(resetTimer));

  const copy = () => {
    const url = currentAddress();
    if (!url) return;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      globalThis.clearTimeout(resetTimer);
      resetTimer = globalThis.setTimeout(() => setCopied(false), COPIED_MS);
    }).catch((e) => console.error("[UrlbarCopy] copy failed:", e));
  };

  return (
    <xul:hbox
      id="derp-urlbar-copy"
      class="urlbar-page-action"
      role="button"
      title={tooltip()}
      copied={copied() ? "true" : undefined}
      onClick={copy}
    >
      <xul:image id="derp-urlbar-copy-image" class="urlbar-icon" />
    </xul:hbox>
  );
}
