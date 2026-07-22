/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  type Accessor,
  createEffect,
  createSignal,
  onCleanup,
  type Setter,
} from "solid-js";
import {
  strDefaultConfig,
  strDefaultData,
} from "../utils/default-prerf.js";
import { PanelSidebarStaticNames } from "../utils/panel-sidebar-static-names.js";
import {
  type Panels,
  type PanelSidebarConfig,
  zPanels,
  zPanelSidebarConfig,
} from "../utils/type.js";
import { createRootHMR } from "@nora/solid-xul";
import { isRight } from "fp-ts/Either";

function createPanelSidebarData(): [Accessor<Panels>, Setter<Panels>] {
  function getPanelSidebarData(stringData: string) {
    return JSON.parse(stringData).data || {};
  }
  const dataResult = zPanels.decode(
    getPanelSidebarData(
      Services.prefs.getStringPref(
        PanelSidebarStaticNames.panelSidebarDataPrefName,
        strDefaultData,
      ),
    ),
  );
  const [panelSidebarData, setPanelSidebarData] = createSignal<Panels>(
    isRight(dataResult) ? dataResult.right : [],
  );
  const observer = () => {
    const result = zPanels.decode(
      getPanelSidebarData(
        Services.prefs.getStringPref(
          PanelSidebarStaticNames.panelSidebarDataPrefName,
          strDefaultData,
        ),
      ),
    );
    if (isRight(result)) {
      setPanelSidebarData(result.right);
    }
  };
  Services.prefs.addObserver(
    PanelSidebarStaticNames.panelSidebarDataPrefName,
    observer,
  );
  onCleanup(() => {
    Services.prefs.removeObserver(
      PanelSidebarStaticNames.panelSidebarDataPrefName,
      observer,
    );
  });

  createEffect(() => {
    Services.prefs.setStringPref(
      PanelSidebarStaticNames.panelSidebarDataPrefName,
      JSON.stringify({ data: panelSidebarData() }),
    );
  });
  return [panelSidebarData, setPanelSidebarData];
}

/** PanelSidebar data */
export const [panelSidebarData, setPanelSidebarData] = createRootHMR(
  createPanelSidebarData,
  import.meta.hot,
);

function createSelectedPanelId(): [
  Accessor<string | null>,
  Setter<string | null>,
] {
  const [selectedPanelId, setSelectedPanelId] = createSignal<string | null>(
    null,
  );
  createEffect(() => {
    globalThis.gFloorpPanelSidebarCurrentPanel = selectedPanelId();
  });
  return [selectedPanelId, setSelectedPanelId];
}

/** Selected Panel */
export const [selectedPanelId, setSelectedPanelId] = createRootHMR(
  createSelectedPanelId,
  import.meta.hot,
);

function createPanelSidebarConfig(): [
  Accessor<PanelSidebarConfig>,
  Setter<PanelSidebarConfig>,
] {
  const configResult = zPanelSidebarConfig.decode(
    getPanelSidebarConfig(
      Services.prefs.getStringPref(
        PanelSidebarStaticNames.panelSidebarConfigPrefName,
        strDefaultConfig,
      ),
    ),
  );
  const [panelSidebarConfig, setPanelSidebarConfig] =
    createSignal<PanelSidebarConfig>(
      isRight(configResult) ? configResult.right : JSON.parse(strDefaultConfig),
    );
  createEffect(() => {
    Services.prefs.setStringPref(
      PanelSidebarStaticNames.panelSidebarConfigPrefName,
      JSON.stringify(panelSidebarConfig()),
    );
  });
  function getPanelSidebarConfig(stringData: string) {
    try {
      return JSON.parse(stringData);
    } catch (e) {
      console.error("Failed to parse panel sidebar config:", e);
      return {};
    }
  }
  const observer = () => {
    const result = zPanelSidebarConfig.decode(
      getPanelSidebarConfig(
        Services.prefs.getStringPref(
          PanelSidebarStaticNames.panelSidebarConfigPrefName,
          strDefaultConfig,
        ),
      ),
    );
    if (isRight(result)) {
      setPanelSidebarConfig(result.right);
    }
  };

  Services.prefs.addObserver(
    PanelSidebarStaticNames.panelSidebarConfigPrefName,
    observer,
  );
  onCleanup(() => {
    Services.prefs.removeObserver(
      PanelSidebarStaticNames.panelSidebarConfigPrefName,
      observer,
    );
  });
  return [panelSidebarConfig, setPanelSidebarConfig];
}

/** Get PanelSidebar Config data */
export const [panelSidebarConfig, setPanelSidebarConfig] = createRootHMR(
  createPanelSidebarConfig,
  import.meta.hot,
);

/** Floating state */
export const [isFloating, setIsFloating] = createRootHMR(
  () => createSignal(false),
  import.meta.hot,
);

/** Floating DraggingState */
export const [isFloatingDragging, setIsFloatingDragging] = createRootHMR(
  () => createSignal<boolean>(false),
  import.meta.hot,
);

function createIsPanelSidebarEnabled(): [Accessor<boolean>, Setter<boolean>] {
  // Hardcoded on: the enable/disable setting was removed (bridge sidebar
  // pane). The signal is permanently true so the sidebar always mounts and
  // nothing — a stored false, or the toggle-sidebar gesture — can unmount
  // it. The pref is forced true too, for the other readers that still
  // consult it directly. Visibility (show/hide) is a separate concern,
  // owned by the nav-bar toggle / Cmd+Alt+S.
  try {
    Services.prefs.setBoolPref(
      PanelSidebarStaticNames.panelSidebarEnabledPrefName,
      true,
    );
  } catch (e) {
    console.error("[PanelSidebar] failed to force enabled pref:", e);
  }
  const [isPanelSidebarEnabled, setIsPanelSidebarEnabled] = createSignal<
    boolean
  >(true);
  return [isPanelSidebarEnabled, setIsPanelSidebarEnabled];
}

/** Panel Sidebar Enabled */
export const [isPanelSidebarEnabled, setIsPanelSidebarEnabled] = createRootHMR(
  createIsPanelSidebarEnabled,
  import.meta.hot,
);
