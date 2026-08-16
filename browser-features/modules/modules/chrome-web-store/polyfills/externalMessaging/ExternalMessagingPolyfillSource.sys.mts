/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * External Messaging (externally_connectable) Polyfill Source Code
 *
 * Chrome lets an extension nominate web pages that may talk to it directly:
 *
 *   "externally_connectable": { "matches": ["https://account.example.com/*"] }
 *
 * and those pages then call chrome.runtime.sendMessage(extensionId, ...) while
 * the extension answers on runtime.onMessageExternal. It is how a great many
 * extensions collect a session from their own website after you sign in there.
 *
 * Firefox implements none of it. The manifest key is not part of any Firefox
 * schema, and a web page has no chrome.runtime object to call in the first
 * place, so the page's message goes nowhere and the site eventually reports
 * that the extension timed out.
 *
 * The gap is bridged in two halves:
 *
 *   BRIDGE     a content script on exactly the pages the manifest listed. It
 *              defines chrome.runtime.sendMessage in the *page's* compartment
 *              with exportFunction and forwards each call to the background.
 *              Nothing is injected as a <script>, so a strict page CSP — which
 *              sites hosting a sign-in flow invariably have — cannot block it.
 *
 *   BACKGROUND makes runtime.onMessageExternal fire for those forwarded
 *              messages, while leaving Firefox's own extension-to-extension
 *              external messaging working.
 *
 * The two halves talk over a NAMED PORT, never runtime.sendMessage: every
 * onMessage listener in the extension sees every sendMessage, and the one that
 * settles first wins the response. An extension's internal catch-all handler
 * answers instantly, beating any real external handler that does actual work —
 * observed with a fork handler that waits 500ms by design and lost the race
 * every time. A port named for this polyfill is invisible to code that never
 * calls runtime.onConnect, and code that does still filters by port.name.
 *
 * Because the message really does arrive from a content script, the sender
 * carries a genuine sender.tab — which matters, as handlers routinely reply by
 * scripting the tab that asked.
 */

/** Content script half: runs on the pages listed in externally_connectable. */
export const EXTERNAL_MESSAGING_BRIDGE_SOURCE = `
(function () {
  // External Messaging Bridge for Firefox
  // Generated from ExternalMessagingPolyfillSource.sys.mts

  var LOG = "[Floorp External Messaging]";

  if (typeof window === "undefined" || !window.wrappedJSObject) {
    return;
  }
  if (typeof cloneInto !== "function" || typeof exportFunction !== "function") {
    return;
  }

  var api = typeof browser !== "undefined" ? browser : (typeof chrome !== "undefined" ? chrome : null);
  if (!api || !api.runtime) {
    return;
  }

  var page = window.wrappedJSObject;

  // One long-lived port carries every message from this page. A port, not
  // sendMessage: see the header — sendMessage responses are first-settled-wins
  // across every listener in the extension.
  var PORT_NAME = "__floorp_external_messaging__";
  var port = null;
  var nextId = 1;
  var pendingById = {};

  function ensurePort() {
    if (port) {
      return port;
    }
    port = api.runtime.connect({ name: PORT_NAME });
    port.onMessage.addListener(function (reply) {
      if (!reply || !pendingById[reply.id]) {
        return;
      }
      var settle = pendingById[reply.id];
      delete pendingById[reply.id];
      settle(reply.response);
    });
    port.onDisconnect.addListener(function () {
      port = null;
      for (var id in pendingById) {
        pendingById[id](undefined);
      }
      pendingById = {};
    });
    return port;
  }

  function forward(message) {
    // Structured cloning across the page boundary is fussy about exotic
    // objects; the JSON round trip is what the extensions themselves do.
    var payload;
    try {
      payload = JSON.parse(JSON.stringify(message));
    } catch (error) {
      payload = message;
    }
    return new Promise(function (resolve) {
      var id = nextId++;
      pendingById[id] = resolve;
      ensurePort().postMessage({
        id: id,
        origin: window.location.origin,
        message: payload
      });
    });
  }

  // Chrome's signature from a page is sendMessage(extensionId, message,
  // options?, callback?) — the id is mandatory there, so the message is the
  // second argument once the trailing callback and options are stripped.
  function sendMessage() {
    var args = Array.prototype.slice.call(arguments);
    var callback = typeof args[args.length - 1] === "function" ? args.pop() : null;
    if (args.length > 2) {
      args.pop();
    }
    var message = args.length > 1 ? args[1] : args[0];

    var pending = forward(message);

    if (callback) {
      pending.then(function (response) {
        callback(cloneInto(response === undefined ? null : response, page));
      }, function (error) {
        console.error(LOG, error);
        callback(cloneInto(null, page));
      });
      return undefined;
    }

    // No callback: answer with a promise the page can actually await, which
    // means building it with the page's own Promise constructor.
    try {
      return new page.Promise(exportFunction(function (resolve, reject) {
        pending.then(function (response) {
          resolve(cloneInto(response === undefined ? null : response, page));
        }, function (error) {
          reject(cloneInto(String(error), page));
        });
      }, page));
    } catch (error) {
      console.error(LOG, error);
      return undefined;
    }
  }

  function connect() {
    // Long-lived ports would need a second channel in both directions. Nothing
    // is silently half-connected: the page is told plainly.
    console.warn(LOG, "chrome.runtime.connect from a web page is not bridged; use sendMessage");
    return undefined;
  }

  var chromeObject = page.chrome;
  if (!chromeObject) {
    chromeObject = cloneInto({}, page);
    page.chrome = chromeObject;
  }
  var runtimeObject = chromeObject.runtime;
  if (!runtimeObject) {
    runtimeObject = cloneInto({}, page);
    chromeObject.runtime = runtimeObject;
  }

  exportFunction(sendMessage, runtimeObject, { defineAs: "sendMessage" });
  exportFunction(connect, runtimeObject, { defineAs: "connect" });
})();
`;

/** Background half: makes onMessageExternal fire for bridged messages. */
export const EXTERNAL_MESSAGING_BACKGROUND_SOURCE = `
(function () {
  // External Messaging Polyfill for Firefox
  // Generated from ExternalMessagingPolyfillSource.sys.mts

  var LOG = "[Floorp External Messaging]";

  var api = typeof browser !== "undefined" ? browser : (typeof chrome !== "undefined" ? chrome : null);
  if (!api || !api.runtime || !api.runtime.onConnect) {
    return;
  }

  var PORT_NAME = "__floorp_external_messaging__";
  var listeners = [];
  var nativeEvent = api.runtime.onMessageExternal;

  // A Chrome listener answers in one of three ways: return a promise, return
  // true and call sendResponse later, or return the value outright. All three
  // have to become the promise Firefox's onMessage wants back.
  function invoke(listener, message, sender) {
    var settleResponse;
    var deferred = new Promise(function (resolve) {
      settleResponse = resolve;
    });
    var answered = false;
    var sendResponse = function (value) {
      answered = true;
      settleResponse(value);
    };

    var result;
    try {
      result = listener(message, sender, sendResponse);
    } catch (error) {
      console.error(LOG, error);
      return null;
    }

    if (result && typeof result.then === "function") {
      return result;
    }
    if (result === true) {
      return deferred;
    }
    if (answered) {
      return deferred;
    }
    if (result !== undefined && result !== false) {
      return Promise.resolve(result);
    }
    return null;
  }

  api.runtime.onConnect.addListener(function (connectedPort) {
    if (!connectedPort || connectedPort.name !== PORT_NAME) {
      return;
    }
    connectedPort.onMessage.addListener(function (envelope) {
      if (!envelope || envelope.id === undefined) {
        return;
      }

      var sender = connectedPort.sender;
      // Chrome's external sender: the page's own identity, plus the tab it is
      // in, which handlers use to script the page back.
      var external = {
        id: api.runtime.id,
        url: sender ? sender.url : undefined,
        origin: envelope.origin,
        tab: sender ? sender.tab : undefined,
        frameId: sender ? sender.frameId : undefined
      };

      var answer = null;
      for (var i = 0; i < listeners.length && !answer; i++) {
        answer = invoke(listeners[i], envelope.message, external);
      }

      Promise.resolve(answer).then(function (response) {
        try {
          connectedPort.postMessage({ id: envelope.id, response: response });
        } catch (error) {
          // The page went away mid-answer; nothing left to tell.
        }
      }, function (error) {
        console.error(LOG, error);
        try {
          connectedPort.postMessage({ id: envelope.id, response: undefined });
        } catch (ignored) {}
      });
    });
  });

  var wrappedEvent = {
    addListener: function (listener) {
      if (listeners.indexOf(listener) < 0) {
        listeners.push(listener);
      }
      // Firefox's own extension-to-extension external messaging keeps working;
      // this adds web pages to it rather than replacing it.
      if (nativeEvent && nativeEvent.addListener) {
        try {
          nativeEvent.addListener(listener);
        } catch (error) {
          console.error(LOG, error);
        }
      }
    },
    removeListener: function (listener) {
      var index = listeners.indexOf(listener);
      if (index >= 0) {
        listeners.splice(index, 1);
      }
      if (nativeEvent && nativeEvent.removeListener) {
        try {
          nativeEvent.removeListener(listener);
        } catch (error) {
          console.error(LOG, error);
        }
      }
    },
    hasListener: function (listener) {
      return listeners.indexOf(listener) >= 0;
    }
  };

  function install(namespace) {
    if (!namespace || !namespace.runtime) {
      return;
    }
    // defineProperty, never assignment: Firefox exposes API members through
    // getters, and assigning over one in non-strict code fails SILENTLY — no
    // exception, no effect, and a catch-based fallback never runs.
    try {
      Object.defineProperty(namespace.runtime, "onMessageExternal", {
        value: wrappedEvent,
        configurable: true,
        writable: true
      });
    } catch (error) {
      console.error(LOG, "could not install onMessageExternal shim:", error);
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
