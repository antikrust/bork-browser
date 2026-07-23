import type { NRSettingsParentFunctions } from "../../../../modules/common/defines.ts";
import { createBirpc } from "birpc";

// deno-lint-ignore no-explicit-any
declare const Services: any;
// deno-lint-ignore no-explicit-any
declare const ChromeUtils: any;
declare global {
  interface Window {
    NRSettingsSend: (data: string) => void;
    NRSettingsRegisterReceiveCallback: (
      callback: (data: string) => void,
    ) => void;
  }
}

const isLocalhost5187 = import.meta.url?.includes("localhost:5187");

const directServicesFunctions: NRSettingsParentFunctions = {
  getBoolPref: (prefName) => {
    if (Services.prefs.getPrefType(prefName) !== Services.prefs.PREF_BOOL) {
      return Promise.resolve(null);
    }
    return Promise.resolve(Services.prefs.getBoolPref(prefName));
  },
  getIntPref: (prefName) => {
    if (Services.prefs.getPrefType(prefName) !== Services.prefs.PREF_INT) {
      return Promise.resolve(null);
    }
    return Promise.resolve(Services.prefs.getIntPref(prefName));
  },
  getStringPref: (prefName) => {
    if (Services.prefs.getPrefType(prefName) !== Services.prefs.PREF_STRING) {
      return Promise.resolve(null);
    }
    return Promise.resolve(Services.prefs.getStringPref(prefName));
  },
  setBoolPref: (prefName, value) => {
    Services.prefs.setBoolPref(prefName, value);
    return Promise.resolve();
  },
  setIntPref: (prefName, value) => {
    Services.prefs.setIntPref(prefName, value);
    return Promise.resolve();
  },
  setStringPref: (prefName, value) => {
    Services.prefs.setStringPref(prefName, value);
    return Promise.resolve();
  },
  listImportSources: async () => {
    const { MigrationUtils } = ChromeUtils.importESModule(
      "resource:///modules/MigrationUtils.sys.mjs",
    );
    const wanted = ["PASSWORDS", "BOOKMARKS", "HISTORY", "COOKIES"];
    const sources: { key: string; offers: string[] }[] = [];
    for (const key of MigrationUtils.availableMigratorKeys) {
      // A test-only migrator ships with the engine; never offer it.
      if (key.startsWith("internal-testing")) continue;
      try {
        const migrator = await MigrationUtils.getMigrator(key);
        if (!migrator) continue;
        const profiles = await migrator.getSourceProfiles();
        const profile = Array.isArray(profiles) ? profiles[0] : null;
        const available = await migrator.getMigrateData(profile);
        const offers = wanted
          .filter((name) => available & MigrationUtils.resourceTypes[name])
          .map((name) => name.toLowerCase());
        if (offers.length) sources.push({ key, offers });
      } catch {
        // Skip a migrator that cannot be inspected; show the rest.
      }
    }
    return sources;
  },
  runImport: async (key: string, items: string[]) => {
    try {
      const { MigrationUtils } = ChromeUtils.importESModule(
        "resource:///modules/MigrationUtils.sys.mjs",
      );
      const migrator = await MigrationUtils.getMigrator(key);
      if (!migrator) return { ok: false, error: "source unavailable" };
      const profiles = await migrator.getSourceProfiles();
      const profile = Array.isArray(profiles) ? profiles[0] : null;
      let mask = 0;
      for (const item of items) {
        mask |= MigrationUtils.resourceTypes[item.toUpperCase()] ?? 0;
      }
      await migrator.migrate(mask, false, profile);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
  importVivaldiWorkspaces: async () => {
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    if (!win) return { ok: false, error: "no browser window" };
    const done = new Promise((resolve) => {
      win.addEventListener(
        "bork-vivaldi-import-done",
        (e: CustomEvent) => resolve(e.detail),
        { once: true },
      );
    });
    win.dispatchEvent(new win.CustomEvent("bork-vivaldi-import"));
    return { ok: true, result: await done };
  },
  openMigrationWizard: () => {
    // Production path: this page is chrome-privileged, so it can reach the
    // wizard itself - but only via a browser window, never its own.
    const { MigrationUtils } = ChromeUtils.importESModule(
      "resource:///modules/MigrationUtils.sys.mjs",
    );
    MigrationUtils.showMigrationWizard(
      Services.wm.getMostRecentWindow("navigator:browser"),
      { entrypoint: MigrationUtils.MIGRATION_ENTRYPOINTS.FIRSTRUN },
    );
    return Promise.resolve();
  },
};

export const rpc = isLocalhost5187
  ? createBirpc<NRSettingsParentFunctions, Record<string, never>>(
    {},
    {
      post: (data) => (globalThis as unknown as Window).NRSettingsSend(data),
      on: (callback) => {
        (globalThis as unknown as Window).NRSettingsRegisterReceiveCallback(
          callback,
        );
      },
      serialize: (v) => JSON.stringify(v),
      deserialize: (v) => JSON.parse(v),
    },
  )
  : directServicesFunctions;
