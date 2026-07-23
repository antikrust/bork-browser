//TODO: make reject when the name is invalid
export class NRSettingsParent extends JSWindowActorParent {
  constructor() {
    super();
  }
  // deno-lint-ignore require-await
  async receiveMessage(message: { name: string; data?: unknown }): Promise<unknown> {
    const data = message.data as Record<string, unknown> | undefined;
    switch (message.name) {
      case "getBoolPref": {
        const name = data && typeof data.name === "string" ? data.name : null;
        if (!name) return null;
        if (Services.prefs.getPrefType(name) != Services.prefs.PREF_BOOL) {
          return null;
        }
        return Services.prefs.getBoolPref(name);
      }
      case "getIntPref": {
        const name = data && typeof data.name === "string" ? data.name : null;
        if (!name) return null;
        if (Services.prefs.getPrefType(name) != Services.prefs.PREF_INT) {
          return null;
        }
        return Services.prefs.getIntPref(name);
      }
      case "getStringPref": {
        const name = data && typeof data.name === "string" ? data.name : null;
        if (!name) return null;
        if (Services.prefs.getPrefType(name) != Services.prefs.PREF_STRING) {
          return null;
        }
        return Services.prefs.getStringPref(name);
      }
      case "setBoolPref": {
        {
          const name = data && typeof data.name === "string" ? data.name : null;
          const val =
            data && typeof data.prefValue === "boolean" ? data.prefValue : null;
          if (!name || val === null) return null;
          Services.prefs.setBoolPref(name, val);
        }
        break;
      }
      case "setIntPref": {
        {
          const name = data && typeof data.name === "string" ? data.name : null;
          const val =
            data && typeof data.prefValue === "number" ? data.prefValue : null;
          if (!name || val === null) return null;
          Services.prefs.setIntPref(name, val);
        }
        break;
      }
      case "setStringPref": {
        {
          const name = data && typeof data.name === "string" ? data.name : null;
          const val =
            data && typeof data.prefValue === "string" ? data.prefValue : null;
          if (!name || val === null) return null;
          Services.prefs.setStringPref(name, val);
        }
        break;
      }
      case "listImportSources": {
        // Everything the onboarding box needs to populate itself: which
        // browsers are actually installed with data, and what each can give.
        const { MigrationUtils } = ChromeUtils.importESModule(
          "resource:///modules/MigrationUtils.sys.mjs",
        );
        const wanted = ["PASSWORDS", "BOOKMARKS", "HISTORY", "COOKIES"];
        const sources: {
          key: string;
          offers: string[];
        }[] = [];
        for (const key of MigrationUtils.availableMigratorKeys) {
          // A test-only migrator ships with the engine; never offer it.
          if (key.startsWith("internal-testing")) continue;
          try {
            const migrator = await MigrationUtils.getMigrator(key);
            if (!migrator) continue;
            const profiles = await migrator.getSourceProfiles();
            const profile = Array.isArray(profiles) ? profiles[0] : null;
            const available = await migrator.getMigrateData(profile);
            const offers = wanted.filter(
              (name) => available & MigrationUtils.resourceTypes[name],
            ).map((name) => name.toLowerCase());
            if (offers.length) sources.push({ key, offers });
          } catch {
            // A migrator that throws while being inspected is one we cannot
            // offer; the rest of the list is still worth showing.
          }
        }
        return sources;
      }
      case "runImport": {
        const key = data && typeof data.key === "string" ? data.key : null;
        const items = Array.isArray(data?.items) ? data.items as string[] : [];
        if (!key || !items.length) return { ok: false, error: "nothing to do" };
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
          console.error("[NRSettingsParent] import failed", e);
          return { ok: false, error: String(e) };
        }
      }
      case "importVivaldiWorkspaces": {
        // The workspaces service lives in the chrome layer, not here, so ask
        // the browser window to do it and report back.
        try {
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
        } catch (e) {
          console.error("[NRSettingsParent] workspace import failed", e);
          return { ok: false, error: String(e) };
        }
      }
      case "openMigrationWizard": {
        try {
          const { MigrationUtils } = ChromeUtils.importESModule(
            "resource:///modules/MigrationUtils.sys.mjs",
          );
          // Vivaldi, Chrome, Edge and Safari migrators all ship with the
          // engine, passwords included, so onboarding only has to open the
          // wizard rather than reimplement any of it.
          MigrationUtils.showMigrationWizard(
            Services.wm.getMostRecentWindow("navigator:browser"),
            { entrypoint: MigrationUtils.MIGRATION_ENTRYPOINTS.FIRSTRUN },
          );
        } catch (e) {
          console.error("[NRSettingsParent] migration wizard failed", e);
        }
        break;
      }
    }
  }
}
