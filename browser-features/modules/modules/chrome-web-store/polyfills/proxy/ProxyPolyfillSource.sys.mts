/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Proxy Polyfill Source Code
 *
 * Chrome and Firefox both have proxy.settings and they take entirely
 * different objects. Chrome describes a proxy as
 *
 *   { mode: "fixed_servers", rules: { singleProxy: { scheme, host, port } } }
 *
 * and Firefox as
 *
 *   { proxyType: "manual", http: "host:port", ssl: "host:port" }
 *
 * Firefox's setCallback reads proxyType/http/ssl/socks and nothing else, so a
 * Chrome-shaped object leaves every one of them undefined. It does not throw:
 * the call succeeds and configures nothing, which is why a converted VPN
 * extension connects, reports itself connected, and proxies no traffic.
 *
 * This translates between the two shapes in both directions, since an
 * extension reads its own setting back and expects Chrome's answer.
 *
 * Not translatable: Chrome's rules.includeOnly (proxy ONLY these hosts) has no
 * counterpart in Firefox's settings API — that is proxy.onRequest territory —
 * so it is reported and dropped rather than half-applied.
 */

export const PROXY_POLYFILL_SOURCE = `
(function () {
  // Proxy API Polyfill for Firefox
  // Generated from ProxyPolyfillSource.sys.mts

  var api = typeof browser !== "undefined" ? browser : (typeof chrome !== "undefined" ? chrome : null);
  if (!api || !api.proxy || !api.proxy.settings) {
    return;
  }

  var LOG = "[Floorp Proxy Polyfill]";

  // Chrome lets a server omit its port; these are the defaults it applies.
  var DEFAULT_PORTS = { http: 80, https: 443, quic: 443, socks4: 1080, socks5: 1080, socks: 1080 };

  function isSocks(scheme) {
    return scheme === "socks" || scheme === "socks4" || scheme === "socks5";
  }

  // Chrome: { scheme, host, port } -> Firefox: "host:port"
  function serverToAddress(server) {
    if (!server || !server.host) {
      return "";
    }
    var port = server.port;
    if (port === undefined || port === null) {
      port = DEFAULT_PORTS[server.scheme] || 80;
    }
    return server.host + ":" + port;
  }

  // Firefox: "host:port" -> Chrome: { host, port }
  function addressToServer(address, scheme) {
    if (!address) {
      return undefined;
    }
    var parts = String(address).split(":");
    var server = { host: parts[0] };
    if (scheme) {
      server.scheme = scheme;
    }
    var port = parseInt(parts[1], 10);
    if (!isNaN(port)) {
      server.port = port;
    }
    return server;
  }

  function chromeToFirefox(value) {
    if (!value || typeof value !== "object") {
      return null;
    }

    switch (value.mode) {
      case "direct":
        return { proxyType: "none" };
      case "system":
        return { proxyType: "system" };
      case "auto_detect":
        return { proxyType: "autoDetect" };

      case "pac_script": {
        var pac = value.pacScript || {};
        // Firefox only accepts a URL. An inline script becomes a data: URL,
        // which is the one way to hand it the same thing Chrome was given.
        var url = pac.url;
        if (!url && pac.data) {
          url = "data:application/x-ns-proxy-autoconfig;base64," + btoa(pac.data);
        }
        return url ? { proxyType: "autoConfig", autoConfigUrl: url } : null;
      }

      case "fixed_servers": {
        var rules = value.rules || {};
        var config = { proxyType: "manual" };

        if (rules.bypassList && rules.bypassList.length) {
          config.passthrough = rules.bypassList.join(", ");
        }
        if (rules.includeOnly) {
          console.warn(LOG, "rules.includeOnly has no equivalent in Firefox's proxy settings and was dropped");
        }

        // One server for everything is the common case and the only one
        // Firefox expresses directly, via httpProxyAll.
        if (rules.singleProxy) {
          var address = serverToAddress(rules.singleProxy);
          if (isSocks(rules.singleProxy.scheme)) {
            config.socks = address;
            config.socksVersion = rules.singleProxy.scheme === "socks4" ? 4 : 5;
            // Resolving names at the proxy is what a VPN wants; leaking DNS
            // to the local resolver would undo the point of the tunnel.
            config.proxyDNS = true;
          } else {
            config.http = address;
            config.ssl = address;
            config.httpProxyAll = true;
          }
          return config;
        }

        if (rules.proxyForHttp) {
          config.http = serverToAddress(rules.proxyForHttp);
        }
        if (rules.proxyForHttps) {
          config.ssl = serverToAddress(rules.proxyForHttps);
        }
        if (rules.fallbackProxy) {
          if (isSocks(rules.fallbackProxy.scheme)) {
            config.socks = serverToAddress(rules.fallbackProxy);
            config.socksVersion = rules.fallbackProxy.scheme === "socks4" ? 4 : 5;
            config.proxyDNS = true;
          } else if (!config.http) {
            config.http = serverToAddress(rules.fallbackProxy);
            config.ssl = config.http;
            config.httpProxyAll = true;
          }
        }
        return config;
      }

      default:
        return null;
    }
  }

  function firefoxToChrome(value) {
    if (!value || typeof value !== "object") {
      return value;
    }

    switch (value.proxyType) {
      case "none":
        return { mode: "direct" };
      case "system":
        return { mode: "system" };
      case "autoDetect":
        return { mode: "auto_detect" };
      case "autoConfig":
        return { mode: "pac_script", pacScript: { url: value.autoConfigUrl } };

      case "manual": {
        var rules = {};
        if (value.socks) {
          rules.singleProxy = addressToServer(value.socks, value.socksVersion === 4 ? "socks4" : "socks5");
        } else if (value.httpProxyAll && value.http) {
          rules.singleProxy = addressToServer(value.http, "http");
        } else {
          if (value.http) {
            rules.proxyForHttp = addressToServer(value.http, "http");
          }
          if (value.ssl) {
            rules.proxyForHttps = addressToServer(value.ssl, "http");
          }
        }
        if (value.passthrough) {
          rules.bypassList = value.passthrough.split(",").map(function (entry) {
            return entry.trim();
          }).filter(Boolean);
        }
        return { mode: "fixed_servers", rules: rules };
      }

      default:
        return value;
    }
  }

  var settings = api.proxy.settings;
  var nativeSet = settings.set.bind(settings);
  var nativeGet = settings.get.bind(settings);
  var nativeClear = settings.clear.bind(settings);

  // Chrome's callback style and Firefox's promise style are both in use, often
  // in the same extension, so every wrapper answers whichever it was asked in.
  function settle(promise, callback) {
    if (typeof callback !== "function") {
      return promise;
    }
    promise.then(function (result) {
      callback(result);
    }, function (error) {
      console.error(LOG, error);
      callback(undefined);
    });
    return undefined;
  }

  var wrapped = {
    set: function (details, callback) {
      var translated = chromeToFirefox(details && details.value);
      if (!translated) {
        // Already Firefox-shaped, or a mode we do not know: hand it over
        // untouched rather than guess.
        return settle(Promise.resolve(nativeSet(details)), callback);
      }
      var forwarded = { value: translated };
      if (details.scope) {
        forwarded.scope = details.scope;
      }
      return settle(Promise.resolve(nativeSet(forwarded)), callback);
    },

    get: function (details, callback) {
      var promise = Promise.resolve(nativeGet(details || {})).then(function (result) {
        if (result && "value" in result) {
          result.value = firefoxToChrome(result.value);
        }
        return result;
      });
      return settle(promise, callback);
    },

    clear: function (details, callback) {
      return settle(Promise.resolve(nativeClear(details || {})), callback);
    },

    onChange: {
      addListener: function (listener) {
        var translating = function (details) {
          if (details && "value" in details) {
            details.value = firefoxToChrome(details.value);
          }
          return listener(details);
        };
        // Remembered on the listener so removeListener can find its twin.
        listener.__floorpProxyWrapped = translating;
        return settings.onChange.addListener(translating);
      },
      removeListener: function (listener) {
        return settings.onChange.removeListener(listener.__floorpProxyWrapped || listener);
      },
      hasListener: function (listener) {
        return settings.onChange.hasListener(listener.__floorpProxyWrapped || listener);
      },
    },
  };

  function install(namespace) {
    if (!namespace || !namespace.proxy) {
      return;
    }
    // defineProperty, never assignment: Firefox exposes API members through
    // getters, and assigning over one in non-strict code fails SILENTLY — no
    // exception, so a catch-based fallback never runs.
    try {
      Object.defineProperty(namespace.proxy, "settings", {
        value: wrapped,
        configurable: true,
        writable: true,
      });
    } catch (error) {
      console.error(LOG, "could not install proxy.settings shim:", error);
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
