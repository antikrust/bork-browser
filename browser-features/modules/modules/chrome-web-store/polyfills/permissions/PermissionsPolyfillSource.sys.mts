/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Permissions Polyfill Source Code
 *
 * Chrome extensions routinely re-request permissions they already declare, and
 * on Chrome that resolves true immediately. Firefox refuses outright:
 *
 *   Cannot request permission proxy since it was not declared in
 *   optional_permissions
 *
 * A converted extension declares its permissions as required — that is what
 * the Chrome manifest said — so every such call throws. The usual shape is
 *
 *   (await browser.permissions.request(what)) && continueSignIn()
 *
 * inside a click handler, which means the rejection takes the whole handler
 * down and the button appears to do nothing at all.
 *
 * So: ask first whether everything is already granted, and answer true without
 * troubling Firefox if it is. Nothing extra is granted by this — a request for
 * something genuinely missing still goes to Firefox and is still refused,
 * which is correct.
 */

export const PERMISSIONS_POLYFILL_SOURCE = `
(function () {
  // Permissions API Polyfill for Firefox
  // Generated from PermissionsPolyfillSource.sys.mts

  var LOG = "[Floorp Permissions Polyfill]";

  var api = typeof browser !== "undefined" ? browser : (typeof chrome !== "undefined" ? chrome : null);
  if (!api || !api.permissions || !api.permissions.request || !api.permissions.contains) {
    return;
  }

  var nativeRequest = api.permissions.request.bind(api.permissions);
  var nativeContains = api.permissions.contains.bind(api.permissions);

  function request(descriptor, callback) {
    var wanted = {
      permissions: (descriptor && descriptor.permissions) || [],
      origins: (descriptor && descriptor.origins) || []
    };

    var pending = Promise.resolve()
      .then(function () {
        return nativeContains(wanted);
      })
      .then(function (granted) {
        if (granted) {
          return true;
        }
        // Genuinely missing: let Firefox decide, exactly as before.
        return nativeRequest(descriptor);
      });

    if (typeof callback === "function") {
      pending.then(function (granted) {
        callback(granted);
      }, function (error) {
        console.error(LOG, error);
        callback(false);
      });
      return undefined;
    }

    return pending;
  }

  function install(namespace) {
    if (!namespace || !namespace.permissions) {
      return;
    }
    // defineProperty, never assignment: Firefox exposes API members through
    // getters, and assigning over one in non-strict code fails SILENTLY — no
    // exception, so a catch-based fallback never runs.
    try {
      Object.defineProperty(namespace.permissions, "request", {
        value: request,
        configurable: true,
        writable: true
      });
    } catch (error) {
      console.error(LOG, "could not install permissions.request shim:", error);
    }
  }

  if (typeof chrome !== "undefined") {
    install(chrome);
  }
  if (typeof browser !== "undefined" && browser !== chrome) {
    install(browser);
  }
})();
`;
