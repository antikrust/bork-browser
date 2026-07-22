/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export interface Version2UpdateStatus {
  hasUpdate: boolean;
  remoteVersion2: string | null;
  detailsURL: string | null;
}

export interface UpdateCheckerModule {
  checkForVersion2Updates(): Promise<Version2UpdateStatus>;
}

export interface NotificationButton {
  label: string;
  callback: () => boolean;
}

export interface NotificationBoxLike {
  PRIORITY_INFO_MEDIUM: number;
  appendNotification(
    type: string,
    props: { label: string; priority: number },
    buttons: NotificationButton[],
  ): unknown;
}
