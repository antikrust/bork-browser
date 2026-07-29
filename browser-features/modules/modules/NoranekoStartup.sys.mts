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
const RELEASE_NOTES_URL = "https://therob.lol/bork/";

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
  const ADOPT_IDS = ["uBlock0@raymondhill.net", "addon@darkreader.org"];
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

export function onFinalUIStartup(): void {
  Services.obs.removeObserver(onFinalUIStartup, "final-ui-startup");

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
