/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { render } from "@nora/solid-xul";
import {
  noraComponent,
  NoraComponentBase,
} from "#features-chrome/utils/base.ts";
import { UrlbarCopyButton } from "./copy-button.tsx";
import style from "./styles.css?inline";

/**
 * One-click copy of the address bar's URL, sitting just after the shield in
 * the urlbar's site-info area.
 */
@noraComponent(import.meta.hot)
export default class UrlbarCopy extends NoraComponentBase {
  init(): void {
    const styleEl = document?.createElement("style");
    if (styleEl) {
      styleEl.textContent = style;
      document?.head?.appendChild(styleEl);
    }

    const shield = document?.getElementById(
      "tracking-protection-icon-container",
    );
    const identityBox = document?.getElementById("identity-box");
    if (!shield?.parentElement || !identityBox) {
      this.logger.warn("urlbar site-info area not found; button not mounted");
      return;
    }

    render(UrlbarCopyButton, shield.parentElement, {
      marker: identityBox,
      hotCtx: import.meta.hot,
    });
  }
}
