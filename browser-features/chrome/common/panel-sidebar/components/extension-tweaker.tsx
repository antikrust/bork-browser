/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createSignal, For } from "solid-js";

/**
 * Extension tweaker: an inline column of icons that slides up out of the
 * sidebar's bottom button box, replacing the stock unified-extensions
 * popup. One icon per enabled extension that has a toolbar action, plus a
 * manage icon at the top. Clicking an icon triggers the extension's real
 * browserAction — its popup opens anchored to our icon, so it slides out
 * to the side of the panel; right-click offers options/disable/manage.
 */

type ActionManifest = { default_icon?: unknown; default_popup?: string };

type WebExtension = {
  id: string;
  name?: string;
  manifest: {
    browser_action?: ActionManifest;
    action?: ActionManifest;
    icons?: Record<string, string>;
  };
};

type WEPolicy = {
  id: string;
  name?: string;
  extension?: WebExtension;
  getURL: (path: string) => string;
};

type SidebarExtension = {
  id: string;
  name: string;
  iconUrl: string;
  hasPopup: boolean;
};

const GENERIC_ICON = "chrome://mozapps/skin/extensions/extensionGeneric.svg";

const getWEP = () =>
  (Cu.getGlobalForObject(Services) as unknown as {
    WebExtensionPolicy: {
      getActiveExtensions: () => WEPolicy[];
      getByID: (id: string) => WEPolicy | null;
    };
  }).WebExtensionPolicy;

/** Best icon from a manifest icon set (string or {size: path} object). */
const fromIconSet = (icons: unknown): string | null => {
  if (typeof icons === "string") return icons;
  if (icons && typeof icons === "object") {
    const entries = Object.entries(icons as Record<string, string>)
      .map(([k, v]) => [Number(k), v] as const)
      .filter(([k, v]) => !Number.isNaN(k) && typeof v === "string")
      .sort((a, b) => a[0] - b[0]);
    if (entries.length === 0) return null;
    // Smallest icon that still looks sharp at panel size; else the largest.
    const ideal = entries.find(([k]) => k >= 32) ?? entries[entries.length - 1];
    return ideal[1];
  }
  return null;
};

const pickIcon = (policy: WEPolicy): string => {
  const manifest = policy.extension?.manifest;
  const action = manifest?.browser_action ?? manifest?.action;
  const path = fromIconSet(action?.default_icon) ?? fromIconSet(manifest?.icons);
  if (!path) return GENERIC_ICON;
  try {
    return policy.getURL(path.replace(/^\//, ""));
  } catch {
    return GENERIC_ICON;
  }
};

/** Enabled extensions that expose a toolbar action (MV2 or MV3). */
const listActionExtensions = (): SidebarExtension[] => {
  try {
    return getWEP()
      .getActiveExtensions()
      .filter((p) => {
        const m = p.extension?.manifest;
        return !!(m && (m.browser_action || m.action));
      })
      .map((p) => {
        const m = p.extension?.manifest;
        const action = m?.browser_action ?? m?.action;
        return {
          id: p.id,
          name: p.extension?.name ?? p.name ?? p.id,
          iconUrl: pickIcon(p),
          hasPopup: !!action?.default_popup,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    console.error("[extension-tweaker] enumerate failed:", e);
    return [];
  }
};

const [open, setOpen] = createSignal(false);
const [extensions, setExtensions] = createSignal<SidebarExtension[]>([]);

export const toggleExtensionTweaker = () => {
  if (!open()) {
    // Re-enumerate on every open so installs/disables show immediately.
    setExtensions(listActionExtensions());
  }
  setOpen(!open());
};

type ActionObject = {
  /** Inner toolkit action (ExtensionActions): per-tab popup resolution. */
  action?: { getPopupUrl?: (tab: unknown, strict?: boolean) => string };
  triggerAction?: (win: unknown) => unknown;
};

type PanelPopupInstance = {
  viewNode: Element & {
    openPopup: (anchor: Element, position: string) => void;
  };
  destroy?: () => void;
};

/** The extension's popup URL for the current tab, else the manifest one. */
const resolvePopupUrl = (
  policy: WEPolicy,
  action: ActionObject | null,
): string => {
  try {
    const gb = (globalThis as unknown as {
      gBrowser?: { selectedTab: unknown };
    }).gBrowser;
    const perTab = action?.action?.getPopupUrl?.(gb?.selectedTab);
    if (typeof perTab === "string" && perTab) return perTab;
  } catch {
    // fall through to the manifest default
  }
  const manifest = policy.extension?.manifest;
  const def = (manifest?.browser_action ?? manifest?.action)?.default_popup;
  if (!def) return "";
  try {
    return policy.getURL(def.replace(/^\//, ""));
  } catch {
    return "";
  }
};

const openExtensionAction = (info: SidebarExtension, anchorId: string) => {
  try {
    const policy = getWEP().getByID(info.id);
    const extension = policy?.extension;
    if (!policy || !extension) return;

    const EP = ChromeUtils.importESModule(
      "resource://gre/modules/ExtensionParent.sys.mjs",
    ) as {
      ExtensionParent: {
        apiManager: {
          global: {
            browserActionFor?: (ext: WebExtension) => ActionObject | null;
          };
        };
      };
    };
    const action =
      EP.ExtensionParent.apiManager.global.browserActionFor?.(extension) ??
        null;

    const anchor = document?.getElementById(anchorId);
    const popupUrl = info.hasPopup ? resolvePopupUrl(policy, action) : "";

    // Preferred path: the extension's real popup in a panel anchored to
    // OUR icon, so it slides out beside the sidebar instead of appearing
    // at a hidden toolbar widget. PanelPopup is the machinery Firefox
    // itself uses for page-action popups.
    if (popupUrl && anchor) {
      try {
        // App resource root (resource:///): ExtensionPopups lives in the
        // browser tree, not toolkit — resource://gre/ fails to resolve.
        const { PanelPopup } = ChromeUtils.importESModule(
          "resource:///modules/ExtensionPopups.sys.mjs",
        ) as {
          PanelPopup: new (
            extension: WebExtension,
            doc: Document,
            popupURL: string,
            browserStyle: boolean,
          ) => PanelPopupInstance;
        };
        const popup = new PanelPopup(
          extension,
          document as unknown as Document,
          popupUrl,
          false,
        );
        // start_before: popup's end edge against the icon's start edge —
        // out of the panel's side, the direction extension UIs expect to
        // have vertical room in.
        popup.viewNode.openPopup(anchor, "start_before");
        return;
      } catch (e) {
        console.error("[extension-tweaker] PanelPopup path failed:", e);
      }
    }

    // Fallback (and the no-popup case, where a click IS the action):
    // trigger the browserAction the way keyboard shortcuts do.
    action?.triggerAction?.(globalThis as unknown as object);
  } catch (e) {
    console.error("[extension-tweaker] action failed:", e);
  }
};

/** Context-menu state: which extension the open menu refers to. */
let menuTargetId: string | null = null;
const [menuHasOptions, setMenuHasOptions] = createSignal(false);

type AddonLike = {
  optionsURL?: string | null;
  optionsType?: number | null;
  disable: () => Promise<void>;
};

const getAddon = async (id: string): Promise<AddonLike | null> => {
  const { AddonManager } = ChromeUtils.importESModule(
    "resource://gre/modules/AddonManager.sys.mjs",
  ) as {
    AddonManager: { getAddonByID: (id: string) => Promise<AddonLike | null> };
  };
  return await AddonManager.getAddonByID(id);
};

const openAddonsPage = (view: string) => {
  try {
    globalThis.BrowserAddonUI.openAddonsMgr(view);
  } catch (e) {
    console.error("[extension-tweaker] open about:addons failed:", e);
  }
};

export function ExtensionTweaker() {
  const onMenuShowing = (event: Event) => {
    const popup = event.target as Element & { triggerNode?: Element | null };
    const button = popup.triggerNode?.closest?.("[data-ext-id]");
    menuTargetId = button?.getAttribute("data-ext-id") ?? null;
    setMenuHasOptions(false);
    if (menuTargetId) {
      const id = menuTargetId;
      getAddon(id).then((addon) => {
        // Guard: the menu may have moved on before the async answer lands.
        if (menuTargetId === id) {
          setMenuHasOptions(!!addon?.optionsURL);
        }
      }).catch(() => setMenuHasOptions(false));
    }
  };

  return (
    <>
      <xul:vbox
        id="derp-ext-tweaker"
        data-open={open() ? "true" : "false"}
      >
        {/* Single grid item: the row track animates 0fr -> 1fr, so the
            column slides to its real content height (a max-height tween
            spans a mostly-invisible range and reads as a pop). */}
        <xul:vbox class="derp-ext-tweaker-inner">
          <xul:toolbarbutton
            class="panel-sidebar-panel derp-ext-tweaker-item"
            id="derp-ext-tweaker-manage"
            image="chrome://global/skin/icons/settings.svg"
            tooltiptext="Manage extensions"
            onCommand={() => {
              setOpen(false);
              openAddonsPage("addons://list/extension");
            }}
          />
          <For each={extensions()}>
            {(info) => (
              <xul:toolbarbutton
                class="panel-sidebar-panel derp-ext-tweaker-item"
                id={`derp-ext-tweaker-${
                  info.id.replace(/[^A-Za-z0-9_-]/g, "_")
                }`}
                image={info.iconUrl}
                tooltiptext={info.name}
                data-ext-id={info.id}
                context="derp-ext-tweaker-menu"
                onCommand={() =>
                  openExtensionAction(
                    info,
                    `derp-ext-tweaker-${
                      info.id.replace(/[^A-Za-z0-9_-]/g, "_")
                    }`,
                  )}
              />
            )}
          </For>
        </xul:vbox>
      </xul:vbox>
      <xul:popupset>
        <xul:menupopup
          id="derp-ext-tweaker-menu"
          onPopupShowing={onMenuShowing}
        >
          <xul:menuitem
            label="Options…"
            disabled={!menuHasOptions()}
            onCommand={() => {
              if (menuTargetId) {
                openAddonsPage(
                  `addons://detail/${
                    encodeURIComponent(menuTargetId)
                  }/preferences`,
                );
              }
            }}
          />
          <xul:menuitem
            label="Disable"
            onCommand={() => {
              const id = menuTargetId;
              if (!id) return;
              getAddon(id)
                .then((addon) => addon?.disable())
                .then(() => setExtensions(listActionExtensions()))
                .catch((e) =>
                  console.error("[extension-tweaker] disable failed:", e)
                );
            }}
          />
          <xul:menuseparator />
          <xul:menuitem
            label="Manage…"
            onCommand={() => {
              if (menuTargetId) {
                openAddonsPage(
                  `addons://detail/${encodeURIComponent(menuTargetId)}`,
                );
              }
            }}
          />
        </xul:menupopup>
      </xul:popupset>
    </>
  );
}
