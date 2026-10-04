/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs",
);

const { NoranekoConstants } = ChromeUtils.importESModule(
  "resource://noraneko/modules/NoranekoConstants.sys.mjs",
);

const { setTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs",
);

export const env = Services.env;
export const isMainBrowser = env.get("MOZ_BROWSER_TOOLBOX_PORT") === "";

export let isFirstRun = false;
export let isUpdated = false;

/**
 * Get nsIComponentRegistrar from Components.manager via QueryInterface.
 * Components.manager needs explicit QI to access registerFactory.
 */
function getComponentRegistrar(): nsIComponentRegistrar | null {
  try {
    const cm = Components.manager;
    if (cm === undefined || cm === null) {
      return null;
    }
    // Components.manager has QueryInterface at runtime but TypeScript defs don't reflect it
    const maybeQI = (cm as unknown as { QueryInterface?: (iid: nsIID) => unknown }).QueryInterface;
    if (typeof maybeQI !== "function") {
      return null;
    }
    return maybeQI.call(cm, Ci.nsIComponentRegistrar) as nsIComponentRegistrar;
  } catch (e) {
    console.error("[NoranekoStartup] Failed to get nsIComponentRegistrar:", e);
    return null;
  }
}

const executedFunctions = new Set<string>();
// bork has no release blog; the download page is the closest thing to notes,
// and it beats sending users to upstream's post for a version we did not ship.
const RELEASE_NOTES_URL = "https://borkbrowser.online/";

export function executeOnce(id: string, callback: () => void): boolean {
  if (executedFunctions.has(id)) {
    return false;
  }

  callback();

  executedFunctions.add(id);
  return true;
}

/**
 * bork: vertical tabs are removed from the browser entirely — the horizontal
 * strip is the only tab layout (tab stacks and the bork theme assume it).
 * The native mode is pref-gated, so removal = enforcement: migrate any
 * profile that still has it on, pin the default to false, and lock the pref
 * so neither about:config nor Firefox's own settings UI can re-enter the
 * mode. Locks don't persist, so this must run every startup (it does: this
 * module is imported at the top of the patched BrowserGlue, before the first
 * window exists).
 */
function enforceVerticalTabsRemoved(): void {
  const PREF = "sidebar.verticalTabs";
  try {
    const wasVertical = Services.prefs.getBoolPref(PREF, false);
    if (Services.prefs.prefHasUserValue(PREF)) {
      Services.prefs.clearUserPref(PREF);
    }
    Services.prefs.getDefaultBranch("").setBoolPref(PREF, false);
    Services.prefs.lockPref(PREF);
    if (wasVertical) {
      // The settings page did this when leaving vertical mode; keep the
      // one-time cleanup for profiles migrated off it here.
      Services.prefs.setBoolPref("sidebar.revamp", false);
    }
  } catch (e) {
    console.error("[NoranekoStartup] Failed to enforce vertical-tabs removal:", e);
  }
}

function initializeVersionInfo(): void {
  isFirstRun = !Services.prefs.getStringPref(
    "browser.startup.homepage_override.mstone",
    undefined,
  );

  const nowVersion = AppConstants.MOZ_APP_VERSION_DISPLAY;
  const oldVersionPref = Services.prefs.getStringPref(
    "floorp.startup.oldVersion",
    undefined,
  );

  if (oldVersionPref !== nowVersion && !isFirstRun) {
    isUpdated = true;
  }

  Services.prefs.setStringPref("floorp.startup.oldVersion", nowVersion);
}

/**
 * bork's default add-ons (uBlock Origin, Dark Reader) ship in the app's
 * distribution/extensions directory, which Firefox only auto-installs when a
 * profile is new or the GECKO version changes — bork releases keep the same
 * Gecko, so existing profiles would never receive them. This adopts them into
 * existing profiles exactly once per add-on id: a per-id pref records the
 * attempt, so an add-on the user removes stays removed forever.
 */
async function adoptDistributionAddons(): Promise<void> {
  // Third-party add-ons: install once, then never touch again — their version
  // is between the user and the add-on's own updater.
  const ADOPT_IDS = [
    "uBlock0@raymondhill.net",
    "addon@darkreader.org",
    "jid1-MnnxcxisBPnSXQ@jetpack", // Privacy Badger
  ];
  // Ours: shipped inside the app, so the app is what says which version is
  // current, and each release should carry its own.
  // An id is never reused: AMO permanently retires the id of a deleted add-on,
  // so renaming one of these means giving it a new id.
  const OWN_IDS = ["youtube-manager@bork", "cyberswine@bork"];
  const PREF_BASE = "bork.distribution.adopted.";
  try {
    const { AddonManager } = ChromeUtils.importESModule(
      "resource://gre/modules/AddonManager.sys.mjs",
    );
    const distDir = Services.dirsvc.get("XREAppDist", Ci.nsIFile);
    for (const id of ADOPT_IDS) {
      if (Services.prefs.getBoolPref(PREF_BASE + id, false)) continue;
      // Never reinstall over anything present (any state — disabled counts).
      const existing = await AddonManager.getAddonByID(id);
      if (existing) {
        Services.prefs.setBoolPref(PREF_BASE + id, true);
        continue;
      }
      const xpi = distDir.clone();
      xpi.append("extensions");
      xpi.append(`${id}.xpi`);
      if (!xpi.exists()) continue;
      const install = await AddonManager.getInstallForFile(xpi);
      await install.install();
      Services.prefs.setBoolPref(PREF_BASE + id, true);
      console.log(`[NoranekoStartup] adopted distribution add-on ${id}`);
    }

    // Our own bundled add-ons are kept in step with the app, which the
    // distribution mechanism cannot do for us. XPIProvider skips an add-on it
    // has already installed unless the GECKO version changed
    //   (!aAppChanged && prefHasUserValue("extensions.installedDistroAddon."+id))
    // and a bork release keeps the same runtime, so a bundled add-on installs
    // exactly once and every later version is ignored — silently, with the new
    // .xpi sitting right there in the app.
    for (const id of OWN_IDS) {
      const xpi = distDir.clone();
      xpi.append("extensions");
      xpi.append(`${id}.xpi`);
      if (!xpi.exists()) continue;

      const existing = await AddonManager.getAddonByID(id);

      // Removed on purpose: Firefox records the first install in
      // extensions.installedDistroAddon.<id> and honours a later removal by
      // never bringing it back. Do the same — shipping it should not mean
      // forcing it.
      if (!existing) {
        if (Services.prefs.prefHasUserValue(`extensions.installedDistroAddon.${id}`)) {
          continue;
        }
        const install = await AddonManager.getInstallForFile(xpi);
        await install.install();
        console.log(`[NoranekoStartup] installed bundled add-on ${id}`);
        continue;
      }

      // getInstallForFile parses the .xpi, so the shipped version is readable
      // before committing to anything.
      const install = await AddonManager.getInstallForFile(xpi);
      const shipped = install?.addon?.version;
      if (!shipped || Services.vc.compare(shipped, existing.version) <= 0) {
        install?.cancel();
        continue;
      }
      await install.install();
      console.log(
        `[NoranekoStartup] updated bundled add-on ${id}: ${existing.version} -> ${shipped}`,
      );
    }

    // Turn one of our themes on. Shipping ten and enabling none left the stock
    // "follow the system" theme active, which takes every chrome text and icon
    // colour from the desktop. macOS answers dark and it looks deliberate; a
    // GTK desktop whose theme has no dark variant answers LIGHT, and Firefox
    // then paints black text and black icons onto the black chrome the skin
    // hardcodes — tab labels, urlbar and the whole panel rail invisible, on a
    // machine whose desktop was set to dark mode. Our themes carry their own
    // colours (tab_text #fbfbfe on frame #050506), so enabling one takes the
    // desktop out of the decision entirely.
    const THEME_ID = "black-swish@themes.bork";
    const THEME_PREF = `${PREF_BASE}theme`;
    if (!Services.prefs.getBoolPref(THEME_PREF, false)) {
      const theme = await AddonManager.getAddonByID(THEME_ID);
      if (theme) {
        // Once, and never over a theme the user picked: the stock default
        // being active is exactly what "has not chosen one" looks like.
        const themes = await AddonManager.getAddonsByTypes(["theme"]);
        const current = themes.find((t: { isActive?: boolean }) => t.isActive);
        if (!current || current.id === "default-theme@mozilla.org") {
          await theme.enable();
          console.log(`[NoranekoStartup] enabled bundled theme ${THEME_ID}`);
        }
        Services.prefs.setBoolPref(THEME_PREF, true);
      }
    }
  } catch (e) {
    console.error("[NoranekoStartup] distribution add-on adoption failed:", e);
  }
}

/**
 * A `-marionette` launch applies Firefox's automation pref list AS USER
 * PREFS, and they persist in the profile after the session — among them
 * apz.content_response_timeout=60000 (the compositor waits up to 60s, not
 * 0.4s, for a busy page before scrolling) and
 * mousewheel.allow_scrolling_more_than_one_page. A profile debugged once
 * scrolls like a broken browser forever after. On a NORMAL launch, clear any
 * user value on these; while automation is actually running (MOZ_MARIONETTE
 * set) leave them alone — the session needs them.
 */
function healAutomationScrollPrefs(): void {
  try {
    const env = Cc["@mozilla.org/process/environment;1"].getService(
      Ci.nsIEnvironment,
    );
    if (env.exists("MOZ_MARIONETTE")) return;
  } catch {
    // no environment service: fall through and heal anyway
  }
  const LEFTOVERS = [
    "apz.content_response_timeout",
    "mousewheel.allow_scrolling_more_than_one_page",
    "mousewheel.transaction.timeout",
    // dead pref from the deleted tab-strip-wheel-guard feature
    "floorp.tabstrip.wheelguard",
    // RecommendedPreferences ships extensions.installDistroAddons=false, which
    // is the master gate on distribution/extensions — the mechanism that
    // delivers the themes, uBlock, Dark Reader and SHUT UP. Left behind, the
    // browser keeps whatever was bundled BEFORE the automation session and
    // silently ignores everything shipped after it, with nothing in the UI to
    // suggest why: a profile debugged once stops receiving default add-ons
    // forever. Found on a real profile that had ten renamed themes it could
    // never install.
    "extensions.installDistroAddons",
  ];
  // RecommendedPreferences also ships browser.translations.enable=false;
  // left behind it blocks the translate panel with a "To translate text,
  // unblock this feature" message (isBlocked is literally !this pref).
  // A DELIBERATE block through AI controls writes the same pref but stamps
  // browser.ai.control.translations="blocked" beside it (TranslationsFeature
  // .block()); automation stamps nothing. Only heal the unstamped case so a
  // user's explicit choice survives.
  try {
    if (
      Services.prefs.getStringPref("browser.ai.control.translations", "") !==
        "blocked"
    ) {
      LEFTOVERS.push("browser.translations.enable");
    }
  } catch {
    LEFTOVERS.push("browser.translations.enable");
  }

  // RecommendedPreferences also switches the password manager off wholesale:
  // signon.autofillForms and signon.rememberSignons both false. Left behind,
  // saved logins stop filling themselves in — they are still there, and still
  // offered from the autocomplete dropdown, so it reads as "Firefox has gone
  // weird on this site" rather than as a setting. Reported from a bank login.
  //
  // Both of those are real checkboxes in Settings, so a user can mean them,
  // and clearing them blindly would undo a deliberate choice. The two beside
  // them are the tell: breach-alerts and vulnerable-passwords appear in no UI
  // anywhere, so a user value on one of them can only have come from
  // automation — and automation writes all four together. Heal the group only
  // on that fingerprint.
  const AUTOMATION_ONLY_SIGNON = [
    "signon.management.page.breach-alerts.enabled",
    "signon.management.page.vulnerable-passwords.enabled",
  ];
  try {
    if (AUTOMATION_ONLY_SIGNON.some((p) => Services.prefs.prefHasUserValue(p))) {
      LEFTOVERS.push(
        ...AUTOMATION_ONLY_SIGNON,
        "signon.autofillForms",
        "signon.rememberSignons",
      );
    }
  } catch (e) {
    console.error("[NoranekoStartup] signon leftover check failed:", e);
  }

  for (const pref of LEFTOVERS) {
    try {
      if (Services.prefs.prefHasUserValue(pref)) {
        Services.prefs.clearUserPref(pref);
        console.log(`[NoranekoStartup] cleared automation leftover ${pref}`);
      }
    } catch (e) {
      console.error(`[NoranekoStartup] clearing ${pref} failed:`, e);
    }
  }
}

/**
 * Wake any extension that owns the proxy, before restored tabs start loading.
 *
 * proxy.settings writes REAL Firefox prefs, so a VPN extension's tunnel is
 * already in prefs.js at startup and live from the very first request. The
 * extension that has to AUTHENTICATE that tunnel is not: an MV3 background is
 * an event page, and Firefox deliberately holds its wakeup until after the
 * first window paints. Restored tabs therefore go out through a proxy with
 * nobody to answer its auth challenge — the connection is refused and every
 * tab shows "can't find the page" until the VPN is toggled off and on, which
 * is the only thing that gets the extension running.
 *
 * Clearing the proxy prefs instead would be the easy fix and the wrong one:
 * the first requests would then go out over the real connection, which is
 * precisely what someone running a VPN must not have happen. Better a slower
 * startup than a leak.
 *
 * Only extensions actually holding the proxy permission are woken, and only
 * when a proxy is configured at all, so this costs nothing on a normal start.
 */
function wakeProxyExtensions(): void {
  if (Services.prefs.getIntPref("network.proxy.type", 0) === 0) {
    return;
  }

  // Extensions are not reliably started yet at final-ui-startup, and the exact
  // ordering is not ours to depend on, so look again for a couple of seconds
  // rather than assume. Every attempt after the first is free once one has
  // been woken.
  const RETRY_MS = 100;
  const MAX_ATTEMPTS = 20;
  let attempts = 0;

  const { setTimeout } = ChromeUtils.importESModule(
    "resource://gre/modules/Timer.sys.mjs",
  );

  const tryWake = () => {
    attempts += 1;
    let woke = 0;
    try {
      for (const policy of WebExtensionPolicy.getActiveExtensions()) {
        if (!policy.active || !policy.permissions.includes("proxy")) {
          continue;
        }
        // What ext-backgroundPage.js itself listens for to build a background.
        policy.extension?.emit("start-background-script");
        woke += 1;
        Services.console.logStringMessage(
          `[NoranekoStartup] woke proxy extension ${policy.id}`,
        );
      }
    } catch (e) {
      console.error("[NoranekoStartup] waking proxy extensions failed:", e);
      return;
    }
    if (!woke && attempts < MAX_ATTEMPTS) {
      setTimeout(tryWake, RETRY_MS);
    }
  };

  tryWake();
}

export function onFinalUIStartup(): void {
  Services.obs.removeObserver(onFinalUIStartup, "final-ui-startup");

  wakeProxyExtensions();

  healAutomationScrollPrefs();

  createDefaultUserChromeFiles().catch((error) => {
    console.error("Failed to create default userChrome files:", error);
  });

  adoptDistributionAddons();

  openReleaseNotesInRecentWindow();

  // init i18n
  ChromeUtils.importESModule(
    "resource://noraneko/modules/i18n/I18n-Utils.sys.mjs",
  );
}

async function openReleaseNotesInRecentWindow(): Promise<void> {
  const { SessionStore } = await ChromeUtils.importESModule(
    "resource:///modules/sessionstore/SessionStore.sys.mjs",
  );

  await SessionStore.promiseInitialized;

  if (!isUpdated) {
    return;
  }

  const recentWindow = Services.wm.getMostRecentWindow(
    "navigator:browser",
  ) as Window | null;

  if (!recentWindow) {
    console.warn("[NoranekoStartup] No recent window found");
    return;
  }

  const tabBrowser = recentWindow.gBrowser;
  const newTab = tabBrowser.addTab(RELEASE_NOTES_URL, {
    relatedToCurrent: false,
    inBackground: false,
    skipAnimation: false,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });

  const WORKSPACE_TAB_ATTRIBUTION_ID = "floorpWorkspaceId";
  let currentWorkspaceID: string | null = null;

  // Poll for workspacesFuncs if not immediately available or if ID is missing.
  // We'll give it a few tries (e.g. up to 2 seconds) to let WorkspacesService initialize.
  const waitForWorkspaceID = async (): Promise<string | null> => {
    let attempts = 0;
    while (attempts < 20) {
      const funcs = (recentWindow as Window).workspacesFuncs;
      if (funcs?.getSelectedWorkspaceID) {
        try {
          const id = funcs.getSelectedWorkspaceID();
          if (id) return id;
        } catch (e) {
          console.error("[NoranekoStartup] Failed to get workspace ID", e);
        }
      }
      await new Promise((r) => setTimeout(r, 100));
      attempts++;
    }
    return null;
  };

  currentWorkspaceID = await waitForWorkspaceID();

  if (currentWorkspaceID) {
    try {
      newTab.setAttribute(WORKSPACE_TAB_ATTRIBUTION_ID, currentWorkspaceID);
    } catch (e) {
      console.error(
        "[NoranekoStartup] Failed to set workspace for release notes tab",
        e,
      );
    }
  } else {
    console.warn(
      "[NoranekoStartup] Workspaces service not ready or no ID found, tab may open in default workspace.",
    );
  }

  try {
    // The shipping version, not a hardcoded "12" (a Floorp-12 leftover that
    // made the page announce "Welcome to Bork 12" on every build). version2 is
    // package.json's version, injected at build time.
    const welcomeTab = tabBrowser.addTab(
      `about:welcome?upgrade=${
        encodeURIComponent(NoranekoConstants.version2 as string)
      }`,
      {
      relatedToCurrent: false,
      inBackground: true,
      skipAnimation: false,
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });

    if (currentWorkspaceID) {
      welcomeTab.setAttribute(WORKSPACE_TAB_ATTRIBUTION_ID, currentWorkspaceID);
    }
  } catch (e) {
    console.error("[NoranekoStartup] Failed to open welcome tab", e);
  }

  recentWindow.addEventListener(
    "DOMContentLoaded",
    () => {
      tabBrowser.selectedTab = newTab;
    },
    { once: true },
  );
}

async function createDefaultUserChromeFiles(): Promise<void> {
  const chromeDir = PathUtils.join(
    Services.dirsvc.get("ProfD", Ci.nsIFile).path,
    "chrome",
  );
  const chromeExists = await IOUtils.exists(chromeDir);

  if (!chromeExists) {
    const userChromeCssPath = PathUtils.join(chromeDir, "userChrome.css");
    const userContentCssPath = PathUtils.join(chromeDir, "userContent.css");

    await IOUtils.writeUTF8(
      userChromeCssPath,
      `
/*************************************************************************************************************************************************************************************************************************************************************

"userChrome.css" is a custom CSS file that can be used to specify CSS style rules for Floorp's interface (NOT internal site) using "chrome" privileges.
For instance, if you want to hide the tab bar, you can use the following CSS rule:

**************************************
#TabsToolbar {                       *
    display: none !important;        *
}                                    *
**************************************

NOTE: You can use the userChrome.css file without change preferences (about:config)

Quote: https://userChrome.org | https://github.com/topics/userchrome 

************************************************************************************************************************************************************************************************************************************************************/

@charset "UTF-8";
@-moz-document url(chrome://browser/content/browser.xhtml) {
/* Please write your custom CSS under this line*/


}
`,
    );

    await IOUtils.writeUTF8(
      userContentCssPath,
      `
/*************************************************************************************************************************************************************************************************************************************************************

"userContent.css" is a custom CSS file that can be used to specify CSS style rules for Floorp's internal site using "chrome" privileges.
For instance, if you want to apply CSS at "about:newtab" and "about:home", you can use the following CSS rule:

***********************************************************************
@-moz-document url-prefix("about:newtab"), url-prefix("about:home") { *
                                                                      *
* Write your css *                                                    *
                                                                      *
}                                                                     *
***********************************************************************

NOTE: You can use the userContent.css file without change preferences (about:config)

************************************************************************************************************************************************************************************************************************************************************/

@charset "UTF-8";
/* Please write your custom CSS under this line*/
`,
    );
  }
}

async function isResourceAvailable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch (error) {
    console.error(`[noraneko] Failed to check resource: ${url}`, error);
    return false;
  }
}

// Only for dev build
async function setupNoranekoNewTab(): Promise<void> {
  const { AboutNewTab } = ChromeUtils.importESModule(
    "resource:///modules/AboutNewTab.sys.mjs",
  );

  if (
    (await isResourceAvailable(
      "chrome://noraneko-newtab/content/index.html",
    )) === false
  ) {
    // Fallback for dev build about:newtab if file doesn't exist
    AboutNewTab.newTabURL = "http://localhost:5186/";
  }
}

async function checkNewtabUserPreference(): Promise<boolean> {
  if (
    (await isResourceAvailable(
      "chrome://noraneko-newtab/content/index.html",
    )) === false
  ) {
    // If chrome resource is missing, we might be in dev mode with localhost
    // For specific check, we assume false here unless we want to check localhost too.
    // However, the original code returned false if file check failed.
    return false;
  }

  const result = Services.prefs.getStringPref(
    "floorp.design.configs",
    undefined,
  );

  if (!result) {
    return true;
  }

  const data = JSON.parse(result);

  return !data.uiCustomization.disableFloorpStart;
}

/* Register Custom About Pages
 *
 * Credits: angelbruni/Geckium on GitHub
 * This code is the TypeScript version of the original JavaScript code.
 *
 * File referred: https://github.com/angelbruni/Geckium/blob/main/Profile%20Folder/chrome/JS/Geckium_aboutPageRegisterer.uc.js
 */

const getCustomAboutPages = async (): Promise<Record<string, string>> => {
  // about:hub is gone: bork settings live as native panes inside
  // about:preferences (bridge/startup/src/panes/), so the separate React
  // settings app is no longer registered.
  const customAboutPages: Record<string, string> = {
    welcome: "chrome://noraneko-welcome/content/index.html",
  };

  // Check and fallback for Dev Mode
  if (!(await isResourceAvailable(customAboutPages.welcome))) {
    customAboutPages.welcome = "http://localhost:5187/";
  }

  if (await checkNewtabUserPreference()) {
    customAboutPages["newtab"] = "chrome://noraneko-newtab/content/index.html";
    customAboutPages["home"] = "chrome://noraneko-newtab/content/index.html";
    // Fallback for newtab in about pages map (though AboutNewTab handles the actual newtab url)
    if (!(await isResourceAvailable(customAboutPages["newtab"]))) {
      const localhostNewTab = "http://localhost:5186/";
      customAboutPages["newtab"] = localhostNewTab;
      customAboutPages["home"] = localhostNewTab;
    }
  }

  return customAboutPages;
};

class CustomAboutPage {
  private _uri: nsIURI;

  constructor(urlString: string) {
    this._uri = Services.io.newURI(urlString);
  }

  get uri(): nsIURI {
    return this._uri;
  }

  newChannel(_uri: nsIURI, loadInfo: nsILoadInfo): nsIChannel {
    const query = _uri.query ? `?${_uri.query}` : "";
    const ref = _uri.ref ? `#${_uri.ref}` : "";
    const targetUri = Services.io.newURI(`${this.uri.spec}${query}${ref}`);
    const new_ch = Services.io.newChannelFromURIWithLoadInfo(
      targetUri,
      loadInfo,
    );
    new_ch.owner = Services.scriptSecurityManager.getSystemPrincipal();
    return new_ch;
  }

  getURIFlags(_uri: nsIURI): number {
    if (!this.uri) {
      throw new Error("URI is not defined");
    }

    return (
      (Ci.nsIAboutModule.ALLOW_SCRIPT as number) |
      (Ci.nsIAboutModule.IS_SECURE_CHROME_UI as number)
    );
  }

  getChromeURI(_uri: nsIURI): nsIURI {
    return this.uri;
  }

  QueryInterface = ChromeUtils.generateQI(["nsIAboutModule"]);
}

async function registerCustomAboutPages(): Promise<void> {
  const customAboutPages = await getCustomAboutPages();

  for (const aboutKey in customAboutPages) {
    const AboutModuleFactory: nsIFactory = {
      createInstance<T extends nsIID>(iid: T): nsQIResult<T> {
        return new CustomAboutPage(customAboutPages[aboutKey]).QueryInterface(
          iid,
        );
      },
    };

    const registrar = getComponentRegistrar();
    if (!registrar) {
      console.error("[NoranekoStartup] Failed to get nsIComponentRegistrar");
      continue;
    }
    registrar.registerFactory(
      Services.uuid.generateUUID(),
      `about:${aboutKey}`,
      `@mozilla.org/network/protocol/about;1?what=${aboutKey}`,
      AboutModuleFactory,
    );
  }
}

(async () => {
  enforceVerticalTabsRemoved();
  await registerCustomAboutPages();
  initializeVersionInfo();
  await setupNoranekoNewTab();
})().catch(console.error);

if (isMainBrowser) {
  Services.obs.addObserver(onFinalUIStartup, "final-ui-startup");
}
