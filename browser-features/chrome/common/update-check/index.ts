/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  noraComponent,
  NoraComponentBase,
} from "#features-chrome/utils/base.ts";
import type {
  NotificationBoxLike,
  UpdateCheckerModule,
} from "./types.ts";

/**
 * Daily release check against updates/update.xml on the repo's main branch
 * (served by raw.githubusercontent.com — no update server). When a newer
 * version is published, a notification bar offers the download page once
 * per version. The native Mozilla updater is policy-disabled
 * (DisableAppUpdate in distribution/policies.json): its compiled-in aus5
 * URL asks Mozilla's server about a product it doesn't serve.
 */

const LAST_CHECK_PREF = "bork.update.lastCheck";
const NOTIFIED_PREF = "bork.update.notifiedVersion";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60_000;
const FALLBACK_DOWNLOAD_URL = "https://therob.lol/bork/";

@noraComponent(import.meta.hot)
export default class UpdateCheck extends NoraComponentBase {
  init(): void {
    globalThis.setTimeout(() => {
      this.run().catch((e) => console.error("[UpdateCheck]", e));
    }, STARTUP_DELAY_MS);
  }

  private async run(): Promise<void> {
    const now = Date.now();
    const last = Number(Services.prefs.getStringPref(LAST_CHECK_PREF, "0"));
    if (now - last < CHECK_INTERVAL_MS) return;
    // Claimed before the fetch so simultaneous windows don't double-check.
    Services.prefs.setStringPref(LAST_CHECK_PREF, String(now));

    const { checkForVersion2Updates } = ChromeUtils.importESModule(
      "resource://noraneko/modules/NoranekoUpdateChecker.sys.mjs",
    ) as UpdateCheckerModule;
    const status = await checkForVersion2Updates();
    if (!status.hasUpdate || !status.remoteVersion2) return;
    if (
      Services.prefs.getStringPref(NOTIFIED_PREF, "") === status.remoteVersion2
    ) {
      return;
    }
    Services.prefs.setStringPref(NOTIFIED_PREF, status.remoteVersion2);
    this.notify(
      status.remoteVersion2,
      status.detailsURL || FALLBACK_DOWNLOAD_URL,
    );
  }

  private notify(version: string, url: string): void {
    const box = (globalThis as { gNotificationBox?: NotificationBoxLike })
      .gNotificationBox;
    if (!box) return;
    box.appendNotification("bork-update-available", {
      label: `Bork ${version} is available.`,
      priority: box.PRIORITY_INFO_MEDIUM,
    }, [
      {
        label: "Download",
        callback: () => {
          (globalThis as {
            openTrustedLinkIn?: (url: string, where: string) => void;
          }).openTrustedLinkIn?.(url, "tab");
          return false;
        },
      },
    ]);
  }
}
