import { setupBorkPanes } from "./bork-panes.ts";

interface FirefoxWindow extends Window {
  gBrowser: {
    selectedTab: unknown;
    addTab(url: string, options: unknown): unknown;
  };
}

interface XULElement extends Element {}

// In Firefox browser chrome context, document is always available.
// Gecko types declare it as `Document | null`, but it is never null here.
const doc = document!;

const FLOORP_HUB_WARNING_IDS = {
  container: "floorp-hub-warning",
  message: "floorp-hub-warning-message",
  button: "floorp-hub-warning-button",
  style: "floorp-hub-warning-style",
} as const;

type FloorpHubWarningTexts = {
  message: string;
  buttonLabel: string;
};

type I18NextLike = {
  isInitialized: boolean;
  on(event: string, callback: () => void): void;
  t(key: string, options?: Record<string, unknown>): string | string[];
};

let i18nextInstance: I18NextLike | null = null;

function logFloorpHub(..._messages: Array<unknown>): void {
  // Silent in production: this wrapper previously emitted noisy debug
  // output via console.log. Keep as a no-op to avoid cluttering logs.
  return;
}

function getI18nextInstance(): I18NextLike | null {
  if (i18nextInstance) {
    logFloorpHub("Reusing cached i18next instance.");
    return i18nextInstance;
  }

  try {
    const module = ChromeUtils.importESModule(
      "chrome://noraneko/content/assets/js/external/i18next.js",
    ) as Record<string, unknown>;

    // Try common export shapes used across bundles
    // prefer: module.i, module.i18next, module.default?.i, module.default, module
    // Log what we find to aid debugging in runtime logs
    try {
      logFloorpHub(
        "Imported i18next module exports:",
        Object.keys(module ?? {}),
      );
    } catch {
      // ignore if module is not an object
    }

    // Try variants
    // Try variants in a type-safe way
    const m = module as Record<string, unknown> | null;
    let resolved: unknown | null = null;
    if (m) {
      if ("i" in m && m["i"]) {
        resolved = m["i"];
      } else if ("i18next" in m && m["i18next"]) {
        resolved = m["i18next"];
      } else if ("default" in m && m["default"]) {
        const def = m["default"] as Record<string, unknown>;
        if ("i" in def && def["i"]) resolved = def["i"];
        else resolved = def;
      } else {
        resolved = m;
      }
    }

    const maybe = resolved as {
      t?: unknown;
      isInitialized?: boolean;
      on?: unknown;
    } | null;
    if (maybe && typeof maybe.t === "function") {
      i18nextInstance = maybe as I18NextLike;
      logFloorpHub("Successfully resolved i18next instance from module.");
    } else {
      console.error(
        "Floorp Hub:",
        "Imported module did not expose a usable i18next instance.",
        module,
      );
      i18nextInstance = null;
    }
  } catch (error) {
    console.error("Floorp Hub:", "Failed to import i18next module", error);
    i18nextInstance = null;
  }

  return i18nextInstance;
}

type FloorpHubWarningElements = {
  container: XULElement;
  message: XULElement;
  button: XULElement;
};

const defaultWarningTexts: FloorpHubWarningTexts = {
  message:
    "Bork-specific settings such as the panel sidebar, Workspaces, and mouse gestures are managed in Bork Hub.",
  buttonLabel: "Open Bork Hub",
};

// Note: localized fallback maps removed for preferences — preferences will
// now use default texts when translations are not available.

let floorpHubWarningElements: FloorpHubWarningElements | null = null;
let warningI18nHandlersBound = false;
let localeObserverBound = false;
let i18nUtilsInstance:
  | {
      getPrimaryBrowserLocaleMapped(): string;
      addLocaleChangeListener(callback: (locale: string) => void): void;
    }
  | null
  | undefined;

function ensureI18NInitialized(): void {
  const instance = getI18nextInstance();
  if (!instance) {
    logFloorpHub("i18next instance unavailable; using fallback text.");
    return;
  }

  // Dump diagnostics to help determine why translations may not be available
  logI18nextDiagnostics(instance);
  if (!instance.isInitialized) {
    console.warn(
      "Floorp Hub:",
      "i18next not initialized; using fallback strings.",
    );
    return;
  }

  logFloorpHub("i18next already initialized.");
  bindGlobalI18nInitializedObserver();
}

let globalI18nInitializedObserverBound = false;
function bindGlobalI18nInitializedObserver(): void {
  if (globalI18nInitializedObserverBound) return;
  try {
    Services.obs.addObserver((...args: Array<unknown>) => {
      try {
        const topic = args[1] as string | undefined;
        if (topic !== "noraneko-i18n-initialized") return;
        logFloorpHub(
          "Received noraneko-i18n-initialized; applying translations.",
        );
        applyFloorpStartWarningTexts();
      } catch (e) {
        // Prevent observer exceptions from bubbling and stopping other observers
        // Log with a clear prefix to make debugging easier in runtime logs.
        try {
          console.error(
            "Floorp Hub: error in noraneko-i18n-initialized observer",
            e,
          );
        } catch {
          // swallow any errors thrown while attempting to log
        }
      }
    }, "noraneko-i18n-initialized");
    globalI18nInitializedObserverBound = true;
    logFloorpHub("Bound global i18n initialized observer.");
  } catch {
    // best-effort; ignore if Services not available
  }
}

function logI18nextDiagnostics(instance: I18NextLike | null): void {
  if (!instance) {
    logFloorpHub("i18next diagnostics: instance is null");
    return;
  }

  try {
    const instObj = instance as unknown as Record<string, unknown>;
    const langs = (instObj["languages"] as string[] | undefined) ?? null;
    const opts =
      (instObj["options"] as Record<string, unknown> | undefined) ?? null;
    const existsFn = instObj["exists"] as ((k: string) => boolean) | undefined;
    const hasMessage =
      typeof existsFn === "function"
        ? existsFn("floorpHubWarning.message")
        : null;

    logFloorpHub("i18next diagnostics:", {
      isInitialized: instance.isInitialized,
      languages: langs,
      options: opts,
      hasMessageKey: hasMessage,
    });
  } catch (error) {
    console.error("Floorp Hub:", "Failed to run i18next diagnostics", error);
  }
}

function injectFloorpHubWarningStyles(): void {
  if (doc.getElementById(FLOORP_HUB_WARNING_IDS.style)) {
    logFloorpHub("Warning styles already present; skipping injection.");
    return;
  }

  logFloorpHub("Injecting warning styles.");
  const style = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "style",
  );
  style.id = FLOORP_HUB_WARNING_IDS.style;
  style.textContent = `
    #${FLOORP_HUB_WARNING_IDS.container} {
      background-color: #fff4ce;
      border: 1px solid #f5c518;
      border-radius: 6px;
      padding: 12px 16px;
      margin-block: 12px;
      gap: 12px;
      color: #1f1f1f;
    }

    #${FLOORP_HUB_WARNING_IDS.container} .floorp-hub-warning__message {
      font-size: 1em;
      line-height: 1.4;
    }

    #${FLOORP_HUB_WARNING_IDS.container} .floorp-hub-warning__button {
      background-color: #ffda55;
      border: 1px solid #e0a800;
      border-radius: 4px;
      padding: 4px 12px;
      font-weight: 600;
      color: #1f1f1f;
    }

    #${FLOORP_HUB_WARNING_IDS.container} .floorp-hub-warning__button:hover {
      background-color: #ffd13b;
    }
    
    /* Blue card for Floorp Start (Home) warning - layout matches the yellow card */
    #${FLOORP_START_WARNING_IDS?.container ?? "floorp-start-warning"} {
      background-color: #e8f4ff; /* light blue */
      border: 1px solid #7db2ff;
      border-radius: 6px;
      padding: 12px 16px;
      margin-block: 12px;
      gap: 12px;
      color: #0b2540;
    }

    #${FLOORP_START_WARNING_IDS?.container ?? "floorp-start-warning"} .floorp-hub-warning__message {
      font-size: 1em;
      line-height: 1.4;
    }

    #${FLOORP_START_WARNING_IDS?.container ?? "floorp-start-warning"} .floorp-hub-warning__button {
      background-color: #4da3ff;
      border: 1px solid #2b8cff;
      border-radius: 4px;
      padding: 4px 12px;
      font-weight: 600;
      color: #ffffff;
    }

    #${FLOORP_START_WARNING_IDS?.container ?? "floorp-start-warning"} .floorp-hub-warning__button:hover {
      background-color: #3390ff;
    }

    /*
     * Hide Floorp Start-related groups inside the redesigned Home pane when
     * the body has the "floorp-start-active" flag (set in JS below). This is
     * CSS-driven so it survives Lit re-renders of <setting-group>, which
     * would otherwise drop the "hidden" attribute we set imperatively.
     * Only the homepage / Firefox Home content groups are hidden; the
     * "startupHome" and "defaultBrowserHome" groups remain available.
     */
    body.floorp-start-active setting-pane[data-category="paneHome"] setting-group[groupid="homepage"],
    body.floorp-start-active setting-pane[data-category="paneHome"] setting-group[groupid="home"] {
      display: none !important;
    }

    /*
     * Legacy (non-redesign) Home pane: hide the homepage / Firefox Home
     * content sections only.
     */
    body.floorp-start-active #homepageGroup,
    body.floorp-start-active #homeContentsGroup,
    body.floorp-start-active #firefoxHomeCategory {
      display: none !important;
    }

    /*
     * bork: vertical tabs are removed from the browser entirely
     * (sidebar.verticalTabs is locked false at startup), so hide the native
     * horizontal/vertical tab-orientation picker in the Browser Layout
     * group. Unconditional — no body-class gate. The picker's
     * <setting-control> wrapper and the inner control both carry stable ids
     * (setting-group and setting-control render into light DOM, so page CSS
     * reaches them; this covers the legacy pane and the settings redesign,
     * which share the markup in preferences.xhtml). The group's separate
     * "Show sidebar" checkbox is deliberately left visible.
     */
    #setting-control-browserLayoutRadioGroup,
    #browserLayoutRadioGroup {
      display: none !important;
    }
  `;

  const parent =
    doc.head ??
    (doc.querySelector("head") as HTMLElement | null) ??
    doc.documentElement;
  parent?.appendChild(style);
}
function bindI18nHandlersForWarning(): void {
  if (warningI18nHandlersBound) {
    logFloorpHub("i18n handlers already bound for warning banner.");
    return;
  }

  logFloorpHub("Binding i18n handlers for warning banner.");
  const instance = getI18nextInstance();
  if (!instance) {
    logFloorpHub("i18next instance not available; deferring i18n binding.");
    return;
  }

  try {
    // Prefer event binding if available
    if (typeof instance.on === "function") {
      instance.on("initialized", () => applyFloorpStartWarningTexts());
      instance.on("languageChanged", () => applyFloorpStartWarningTexts());
      warningI18nHandlersBound = true;
      logFloorpHub("Bound i18next event handlers for warning banner.");
      // If already initialized, apply immediately
      if ((instance as I18NextLike).isInitialized) {
        logFloorpHub("i18next is already initialized; applying texts now.");
      }
    } else {
      // Fallback: poll for initialization for a short time
      logFloorpHub(
        "i18next instance has no .on; polling isInitialized for up to 5s.",
      );
      let checks = 0;
      const interval = setInterval(() => {
        checks++;
        try {
          if ((instance as I18NextLike).isInitialized) {
            clearInterval(interval);
            logFloorpHub(
              "i18next became initialized via poll; applying texts.",
            );
            warningI18nHandlersBound = true;
            return;
          }
        } catch {
          // ignore and continue polling
        }
        if (checks >= 25) {
          clearInterval(interval);
          logFloorpHub("Stopped polling for i18next initialization (timeout).");
        }
      }, 200);
    }
  } catch (error) {
    console.error("Floorp Hub:", "Failed to bind i18n handlers", error);
  }
}

function bindLocaleObserverForWarning(): void {
  if (localeObserverBound) {
    logFloorpHub("Locale observer already bound for warning banner.");
    return;
  }

  const utils = getI18nUtils();
  if (!utils) {
    logFloorpHub("I18nUtils unavailable; cannot bind locale observer.");
    return;
  }

  try {
    utils.addLocaleChangeListener(() => {
      logFloorpHub(
        "Locale change detected via I18nUtils; updating warning texts.",
      );
    });
    localeObserverBound = true;
    logFloorpHub("Bound locale change observer for warning banner.");
  } catch (error) {
    console.error("Floorp Hub:", "Failed to bind locale observer", error);
  }
}

function translateWithFallback(
  instance: I18NextLike,
  key: string,
  fallback: string,
): string {
  const translated = instance.t(key, { defaultValue: fallback });
  if (Array.isArray(translated)) {
    logFloorpHub("Translation result array for key:", key);
    return translated.join(" ");
  }

  if (typeof translated === "string" && translated.trim().length > 0) {
    logFloorpHub("Translation resolved for key:", key, "->", translated);
    return translated;
  }

  logFloorpHub("Translation empty; returning fallback for key:", key);
  return fallback;
}

// Localized fallback helper removed — preferences intentionally do not use
// localized fallback maps and will display default texts when translations
// are unavailable.

/* ===== Floorp Start (Home) warning ===== */
const FLOORP_START_WARNING_IDS = {
  container: "floorp-start-warning",
  message: "floorp-start-warning-message",
  button: "floorp-start-warning-button",
} as const;

const defaultStartWarningTexts: FloorpHubWarningTexts = {
  message:
    'To change the "Home" setting, disable Bork Start under Tab & Appearance.',
  buttonLabel: "Open Tab & Appearance",
};

// Localized start warning map removed for preferences — use default texts.

let floorpStartWarningElements: {
  container: XULElement;
  message: XULElement;
  button: XULElement;
} | null = null;

function getFloorpStartWarningTexts(): FloorpHubWarningTexts {
  const instance = getI18nextInstance();
  if (instance && instance.isInitialized) {
    return {
      message: translateWithFallback(
        instance,
        "floorpStartWarning.message",
        defaultStartWarningTexts.message,
      ),
      buttonLabel: translateWithFallback(
        instance,
        "floorpStartWarning.openButton",
        defaultStartWarningTexts.buttonLabel,
      ),
    };
  }

  // Try translation provider via I18nUtils first (synchronous short-path)
  const utils = getI18nUtils();
  try {
    const provider = utils?.getTranslationProvider?.();
    if (provider && typeof provider.t === "function") {
      try {
        const msg = provider.t("floorpStartWarning.message", {
          defaultValue: defaultStartWarningTexts.message,
        });
        const btn = provider.t("floorpStartWarning.openButton", {
          defaultValue: defaultStartWarningTexts.buttonLabel,
        });
        return {
          message: Array.isArray(msg)
            ? msg.join(" ")
            : String(msg) || defaultStartWarningTexts.message,
          buttonLabel: Array.isArray(btn)
            ? btn.join(" ")
            : String(btn) || defaultStartWarningTexts.buttonLabel,
        };
      } catch {
        // fall through to localized fallback below
      }
    }
  } catch {
    // ignore provider errors and fall back to localized map
  }

  logFloorpHub(
    "No localized fallback for Floorp Start in preferences; using default texts.",
  );
  return defaultStartWarningTexts;
}

function ensureFloorpStartWarning(): void {
  const initialize = () => createFloorpStartWarning();

  if (doc.readyState === "loading") {
    doc.addEventListener("DOMContentLoaded", initialize, { once: true });
    return;
  }

  initialize();
}

function createFloorpStartWarning(): void {
  const existing = doc.getElementById(
    FLOORP_START_WARNING_IDS.container,
  ) as XULElement | null;
  if (existing) return;

  const container = doc.createXULElement("hbox") as XULElement;
  container.id = FLOORP_START_WARNING_IDS.container;
  container.setAttribute("align", "center");
  container.setAttribute("pack", "start");
  container.setAttribute("role", "alert");
  container.setAttribute("aria-live", "polite");
  container.classList.add("floorp-hub-warning");

  const message = doc.createXULElement("description") as XULElement;
  message.id = FLOORP_START_WARNING_IDS.message;
  message.classList.add("floorp-hub-warning__message");
  message.setAttribute("flex", "1");
  message.textContent = defaultStartWarningTexts.message;

  const button = doc.createXULElement("button") as XULElement;
  button.id = FLOORP_START_WARNING_IDS.button;
  button.classList.add("floorp-hub-warning__button");
  button.setAttribute("label", defaultStartWarningTexts.buttonLabel);
  button.addEventListener("click", () => {
    if (import.meta.env.MODE === "dev") {
      (globalThis as unknown as Window).location.href =
        "http://localhost:5183/#/features/design";
      return;
    }
    // The Bork Start toggle lives in this page's own Tab & Appearance pane.
    location.hash = "#borkDesign";
  });

  container.appendChild(message);
  container.appendChild(button);

  const paneContainer = doc.querySelector(
    ".pane-container",
  ) as XULElement | null;
  const mainPrefPane = doc.querySelector(
    "#mainPrefPane",
  ) as XULElement | null;
  if (paneContainer && mainPrefPane) {
    // Insert the start warning after the hub warning (if present), or
    // right before #mainPrefPane.
    const hubWarning = doc.getElementById(FLOORP_HUB_WARNING_IDS.container);
    if (hubWarning && hubWarning.parentElement === paneContainer) {
      paneContainer.insertBefore(container, hubWarning.nextSibling);
    } else {
      paneContainer.insertBefore(container, mainPrefPane);
    }
  } else {
    console.warn(
      "Floorp Hub:",
      ".pane-container or #mainPrefPane not found; inserting warning at document top.",
    );
    const parent = doc.body ?? doc.documentElement;
    parent!.insertBefore(container, parent!.firstChild);
  }

  floorpStartWarningElements = { container, message, button };
  bindI18nHandlersForWarning();
  bindLocaleObserverForWarning();
  applyFloorpStartWarningTexts();
}

function applyFloorpStartWarningTexts(): void {
  if (!floorpStartWarningElements) return;
  const texts = getFloorpStartWarningTexts();
  floorpStartWarningElements.message.textContent = texts.message;
  floorpStartWarningElements.button.setAttribute("label", texts.buttonLabel);
}

// Primary-locale helper removed as localized fallback behavior was removed
// from preferences.

function getI18nUtils(): {
  getPrimaryBrowserLocaleMapped(): string;
  addLocaleChangeListener(callback: (locale: string) => void): void;
  // Optional translation provider APIs added to I18nUtils
  getTranslationProvider?: () => {
    t?: (key: string, opts?: Record<string, unknown>) => string | string[];
    isInitializedPromise?: Promise<unknown>;
  } | null;
  registerTranslationProvider?: (provider: {
    t?: (key: string, opts?: Record<string, unknown>) => string | string[];
    isInitializedPromise?: Promise<unknown>;
    changeLanguage?: (lng: string) => Promise<unknown> | void;
    getI18next?: () => unknown;
  }) => void;
} | null {
  if (i18nUtilsInstance !== undefined) {
    return i18nUtilsInstance;
  }

  try {
    const module = ChromeUtils.importESModule(
      "resource://noraneko/modules/i18n/I18n-Utils.sys.mjs",
    ) as {
      I18nUtils: {
        getPrimaryBrowserLocaleMapped(): string;
        addLocaleChangeListener(callback: (locale: string) => void): void;
      };
    };
    i18nUtilsInstance = module.I18nUtils;
    logFloorpHub("Retrieved I18nUtils instance.");
  } catch (error) {
    console.error("Floorp Hub:", "Failed to import I18n-Utils.sys.mjs", error);
    i18nUtilsInstance = null;
  }

  return i18nUtilsInstance ?? null;
}

// Whether the redesigned settings UI (browser.settings-redesign.enabled)
// is active. Firefox 152 ships it on by default; under the redesign the
// Home pane is rendered with <setting-pane>/<setting-group> elements and
// additionally contains the "startup" and "default browser" groups, which
// are unrelated to Floorp Start and must NOT be hidden.
function isSettingsRedesignEnabled(): boolean {
  try {
    return Services.prefs.getBoolPref(
      "browser.settings-redesign.enabled",
      false,
    );
  } catch {
    return false;
  }
}

// Read the Floorp Start toggle. Returns true when Floorp Start is active
// (i.e. uiCustomization.disableFloorpStart is falsy).
function isFloorpStartEnabled(): boolean {
  try {
    const pref = Services.prefs.getStringPref("floorp.design.configs");
    const config = JSON.parse(pref)?.uiCustomization?.disableFloorpStart;
    return !config;
  } catch {
    // On malformed/missing config, treat Floorp Start as enabled (default).
    return true;
  }
}

// Group ids rendered inside the redesigned paneHome that belong to the
// Floorp Start / Firefox Home surface and therefore should be hidden when
// Floorp Start is active. "startupHome" and "defaultBrowserHome" are
// intentionally excluded — they are generic browser startup settings.
const FLOORP_START_RELATED_GROUP_IDS = ["homepage", "home"] as const;

// CSS class applied to <body> when Floorp Start is active. Matching rules
// in injectFloorpHubWarningStyles() hide the related Home groups via CSS,
// which is robust against Lit re-rendering the <setting-group> elements.
const FLOORP_START_ACTIVE_CLASS = "floorp-start-active";

// Id selectors of the legacy (non-redesign) Home pane sections that are
// specific to the homepage / Firefox Home content.
const FLOORP_START_RELATED_LEGACY_IDS = [
  "#homepageGroup",
  "#homeContentsGroup",
  "#firefoxHomeCategory",
] as const;

function hideFloorpStartLegacyHomePane(): void {
  // Legacy UI: remove only the homepage / Firefox Home content sections as
  // a fallback in case the CSS rule did not apply (e.g. styles not yet
  // injected). The pane itself is shared with nothing else.
  for (const selector of FLOORP_START_RELATED_LEGACY_IDS) {
    doc.querySelector(selector)?.remove();
  }
}

// Relocate the Floorp Start warning banner so it shows up directly above
// the remaining Home pane content (startup/default-browser groups) under
// the redesign, where it is most meaningful to the user.
function moveStartWarningAboveHomeGroups(): void {
  if (!isSettingsRedesignEnabled()) return;
  const warning = doc.getElementById(FLOORP_START_WARNING_IDS.container);
  const homePane = doc.querySelector(
    'setting-pane[data-category="paneHome"]',
  );
  if (!warning || !homePane) return;
  const firstRemaining = homePane.querySelector(
    "setting-group:not([hidden])",
  );
  if (firstRemaining && firstRemaining.parentElement) {
    firstRemaining.parentElement.insertBefore(warning, firstRemaining);
  }
}

function hideNewTabPage(): void {
  const startEnabled = isFloorpStartEnabled();

  // Toggle the body class that drives the CSS hiding rules. This is the
  // primary mechanism and survives Lit re-renders.
  doc.body?.classList.toggle(FLOORP_START_ACTIVE_CLASS, startEnabled);

  if (!startEnabled) {
    return;
  }

  logFloorpHub("Hiding Floorp Start-related Home settings as configured.");

  if (isSettingsRedesignEnabled()) {
    // Belt-and-suspenders: also set the hidden attribute on any groups
    // currently present. The MutationObserver keeps this in sync.
    const homePane = doc.querySelector(
      'setting-pane[data-category="paneHome"]',
    );
    if (homePane) {
      for (const groupId of FLOORP_START_RELATED_GROUP_IDS) {
        homePane
          .querySelector(`setting-group[groupid="${groupId}"]`)
          ?.setAttribute("hidden", "true");
      }
      moveStartWarningAboveHomeGroups();
    }
  } else {
    hideFloorpStartLegacyHomePane();
  }
}

// Under the redesigned settings UI, the <setting-pane data-category="paneHome">
// element and its child <setting-group>s are created asynchronously after
// DOMContentLoaded, and the legacy "home-pane-loaded" observer notification
// is no longer emitted (gHomePane.init() returns early). Watch the document
// so we re-apply the hidden attribute as a secondary measure whenever the
// pane materializes. CSS (driven by the body class) is the source of truth.
let floorpStartObserver: MutationObserver | null = null;

function startFloorpStartObserver(): void {
  if (floorpStartObserver) return;
  floorpStartObserver = new (doc.defaultView as unknown as {
    MutationObserver: typeof MutationObserver;
  }).MutationObserver(() => {
    if (!isFloorpStartEnabled() || !isSettingsRedesignEnabled()) return;
    const homePane = doc.querySelector(
      'setting-pane[data-category="paneHome"]',
    );
    if (!homePane) return;
    for (const groupId of FLOORP_START_RELATED_GROUP_IDS) {
      const group = homePane.querySelector(
        `setting-group[groupid="${groupId}"]`,
      );
      if (group && !group.hasAttribute("hidden")) {
        group.setAttribute("hidden", "true");
      }
    }
  });
  const target = doc.getElementById("mainPrefPane") ?? doc.body;
  if (target) {
    floorpStartObserver.observe(target, {
      childList: true,
      subtree: true,
    });
  }
}

function initHideNewTabPage(): void {
  const run = (): void => {
    hideNewTabPage();
    startFloorpStartObserver();
  };

  if (doc.readyState === "loading") {
    doc.addEventListener("DOMContentLoaded", run, { once: true });
  } else {
    run();
  }

  // Legacy UI relies on this notification; harmless under the redesign.
  try {
    Services.obs.addObserver(hideNewTabPage, "home-pane-loaded");
  } catch (error) {
    console.error("[Floorp Hub]", "Failed to add home-pane-loaded observer", error);
  }
}

ensureI18NInitialized();
ensureFloorpStartWarning();
initHideNewTabPage();

// bork panes: native categories inside about:preferences, replacing the hub
// pane-by-pane (see bork-panes.ts — statically imported so tsdown inlines it
// into this subscript bundle).
try {
  setupBorkPanes();
} catch (e) {
  console.error("[bork-panes] setup failed:", e);
}
