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
import { createRootHMR } from "@nora/solid-xul";
import {
  type KeyboardShortcutConfig,
  type ShortcutConfig,
  zKeyboardShortcutConfig,
} from "./type.ts";
import { clearLegacyConfig, migrateLegacyConfig } from "./migration.ts";
import { isRight } from "fp-ts/Either";

/**
 * derp's chrome controls sit on the platform's "with Alt" chord: Cmd+Alt on
 * macOS, Ctrl+Alt everywhere else. Matching window-drag, which has always
 * branched this way - meta on Windows is the Windows key, which is not a
 * shortcut anyone wants to press.
 */
const IS_MAC = /mac/i.test(navigator.platform ?? "");
const CHROME_CHORD = {
  alt: true,
  ctrl: !IS_MAC,
  meta: IS_MAC,
  shift: false,
} as const;

export const KEYBOARD_SHORTCUT_ENABLED_PREF = "floorp.keyboardshortcut.enabled";
export const KEYBOARD_SHORTCUT_CONFIG_PREF = "floorp.keyboardshortcut.config";
export const KEYBOARD_SHORTCUT_SAFE_ERROR_HANDLING_PREF =
  "floorp.keyboardshortcut.safeErrorHandling";

/**
 * Returns the default keyboard shortcut map used by the extension.
 *
 * Shape: `Record<string, ShortcutConfig>` where each entry contains
 * `key`, `modifiers`, and `action`.
 *
 * The sole default mapping is the **F2** key for
 * "floorp-toggle-command-palette", with all modifiers set to `false`.
 */
const createDefaultShortcuts = (): Record<string, ShortcutConfig> => {
  return {
    "floorp-toggle-command-palette": {
      key: "F2",
      modifiers: { alt: false, ctrl: false, meta: false, shift: false },
      action: "floorp-toggle-command-palette",
    },
    // derp chrome controls all live on Alt+Cmd (same family as the
    // Alt+Cmd window drag). Plain keys fire while typing in web pages,
    // and plain Cmd+Z/A/S are undo / select-all / save.
    "floorp-toggle-zen-mode": {
      key: "Z",
      modifiers: { ...CHROME_CHORD },
      action: "floorp-toggle-zen-mode",
    },
    "derp-toggle-urlbar": {
      key: "A",
      modifiers: { ...CHROME_CHORD },
      action: "derp-toggle-urlbar",
    },
    "derp-toggle-panel-sidebar": {
      key: "S",
      modifiers: { ...CHROME_CHORD },
      action: "derp-toggle-panel-sidebar",
    },
  };
};

/**
 * Earlier derp builds shipped these as bare Z/A/S, which fire while typing
 * in web content. Saved configs win over defaults, so upgrade any entry
 * still matching the old bare-key shape to the current chord.
 */
const migrateBareDerpKeys = (
  shortcuts: Record<string, ShortcutConfig>,
): Record<string, ShortcutConfig> => {
  const defaults = createDefaultShortcuts();
  const oldBareKeys: Record<string, string> = {
    "floorp-toggle-zen-mode": "Z",
    "derp-toggle-urlbar": "A",
    "derp-toggle-panel-sidebar": "S",
  };
  const result = { ...shortcuts };
  for (const [id, oldKey] of Object.entries(oldBareKeys)) {
    const entry = result[id];
    const m = entry?.modifiers;
    if (
      entry &&
      entry.key === oldKey &&
      m && !m.alt && !m.ctrl && !m.meta && !m.shift &&
      defaults[id]
    ) {
      result[id] = defaults[id];
    }
  }
  return result;
};

/**
 * The chrome chords shipped as Cmd+Alt on every platform, so a Windows or
 * Linux profile that has run derp before holds meta+alt - the Windows key.
 * Rewrite those to the platform chord, but only where the entry still matches
 * the shipped chord exactly, so a shortcut the user rebound is left alone.
 */
const migrateChromeChordPlatform = (
  shortcuts: Record<string, ShortcutConfig>,
): Record<string, ShortcutConfig> => {
  if (IS_MAC) return shortcuts;
  const result = { ...shortcuts };
  for (const id of Object.keys(createDefaultShortcuts())) {
    const entry = result[id];
    const m = entry?.modifiers;
    const shipped = m && m.alt && m.meta && !m.ctrl && !m.shift;
    if (entry && shipped) {
      result[id] = { ...entry, modifiers: { ...CHROME_CHORD } };
    }
  }
  return result;
};

export const defaultConfig: KeyboardShortcutConfig = {
  enabled: true,
  shortcuts: createDefaultShortcuts(),
};

export const strDefaultConfig = JSON.stringify(defaultConfig);

const normalizeConfig = (
  config: Record<string, unknown>,
): KeyboardShortcutConfig => {
  return {
    ...defaultConfig,
    ...config,
    shortcuts: migrateChromeChordPlatform(migrateBareDerpKeys({
      // Merge so new default shortcuts reach profiles that saved an older
      // config. Caveat: a default the user deleted (rather than rebound)
      // comes back — acceptable until configs carry a schema version.
      ...defaultConfig.shortcuts,
      ...((config?.shortcuts as Record<string, ShortcutConfig> | undefined) ??
        {}),
    })),
  } as KeyboardShortcutConfig;
};

const parseConfig = (jsonStr: string): KeyboardShortcutConfig => {
  try {
    const parsed = JSON.parse(jsonStr);
    const result = zKeyboardShortcutConfig.decode(parsed);
    if (isRight(result)) {
      return normalizeConfig(result.right);
    }
    console.warn(
      "Keyboard shortcut configuration validation failed, attempting to recover partial data",
    );
    return normalizeConfig(parsed);
  } catch (e) {
    console.error(
      "Failed to parse keyboard shortcut configuration JSON, using default",
      e,
    );
    return defaultConfig;
  }
};

function createEnabled(): [Accessor<boolean>, Setter<boolean>] {
  const [enabled, setEnabled] = createSignal(
    Services.prefs.getBoolPref(
      KEYBOARD_SHORTCUT_ENABLED_PREF,
      defaultConfig.enabled,
    ),
  );

  createEffect(() => {
    Services.prefs.setBoolPref(KEYBOARD_SHORTCUT_ENABLED_PREF, enabled());
  });

  const enabledObserver = () => {
    setEnabled(
      Services.prefs.getBoolPref(
        KEYBOARD_SHORTCUT_ENABLED_PREF,
        defaultConfig.enabled,
      ),
    );
  };

  Services.prefs.addObserver(KEYBOARD_SHORTCUT_ENABLED_PREF, enabledObserver);
  onCleanup(() => {
    Services.prefs.removeObserver(
      KEYBOARD_SHORTCUT_ENABLED_PREF,
      enabledObserver,
    );
  });

  return [enabled, setEnabled];
}

function createConfig(): [
  Accessor<KeyboardShortcutConfig>,
  Setter<KeyboardShortcutConfig>,
] {
  const legacyConfig = migrateLegacyConfig();
  if (legacyConfig) {
    clearLegacyConfig();
    Services.prefs.setStringPref(
      KEYBOARD_SHORTCUT_CONFIG_PREF,
      JSON.stringify(legacyConfig),
    );
  }

  const [config, setConfig] = createSignal<KeyboardShortcutConfig>(
    parseConfig(
      Services.prefs.getStringPref(
        KEYBOARD_SHORTCUT_CONFIG_PREF,
        strDefaultConfig,
      ),
    ),
  );

  createEffect(() => {
    Services.prefs.setStringPref(
      KEYBOARD_SHORTCUT_CONFIG_PREF,
      JSON.stringify(config()),
    );
  });

  const configObserver = () => {
    setConfig(
      parseConfig(
        Services.prefs.getStringPref(
          KEYBOARD_SHORTCUT_CONFIG_PREF,
          strDefaultConfig,
        ),
      ),
    );
  };

  Services.prefs.addObserver(KEYBOARD_SHORTCUT_CONFIG_PREF, configObserver);
  onCleanup(() => {
    Services.prefs.removeObserver(
      KEYBOARD_SHORTCUT_CONFIG_PREF,
      configObserver,
    );
  });

  return [config, setConfig];
}

export const [_enabled, _setEnabled] = createRootHMR(
  createEnabled,
  import.meta.hot,
);
export const [_config, _setConfig] = createRootHMR(
  createConfig,
  import.meta.hot,
);

export const isEnabled = () => _enabled();
export const setEnabled = (value: boolean) => _setEnabled(value);
export const getConfig = () => _config();
export const setConfig = (value: KeyboardShortcutConfig) => _setConfig(value);

/**
 * Experiment "ks_safe_error_handling" — wraps getAction + fn invocation
 * in a single try-catch so callers can always run their cleanup.
 */
export function isSafeErrorHandling(): boolean {
  return Services.prefs.getBoolPref(
    KEYBOARD_SHORTCUT_SAFE_ERROR_HANDLING_PREF,
    true, // default: enabled (safe behavior)
  );
}

export function shortcutToString(shortcut: ShortcutConfig): string {
  const modifiers = [];
  if (shortcut.modifiers.alt) modifiers.push("Alt");
  if (shortcut.modifiers.ctrl) modifiers.push("Ctrl");
  if (shortcut.modifiers.meta) modifiers.push("Meta");
  if (shortcut.modifiers.shift) modifiers.push("Shift");

  return [...modifiers, shortcut.key.toUpperCase()].join("+");
}

export function stringToShortcut(str: string): ShortcutConfig {
  const parts = str.split("+").map((part) => part.toLowerCase());
  const key = parts.pop() || "";
  const modifiers = {
    alt: parts.includes("alt"),
    ctrl: parts.includes("ctrl"),
    meta: parts.includes("meta"),
    shift: parts.includes("shift"),
  };

  return { modifiers, key, action: "" }; // action は後で設定する必要があります
}
