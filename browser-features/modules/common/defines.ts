// SPDX-License-Identifier: MPL-2.0

export interface PrefGetParams {
  prefName: string;
  prefType: "string" | "boolean" | "number";
}

export interface PrefSetParams {
  prefName: string;
  prefType: "string" | "boolean" | "number";
  prefValue: string | boolean | number;
}

export interface NRSettingsParentFunctions {
  getBoolPref(prefName: string): Promise<boolean | null>;
  getIntPref(prefName: string): Promise<number | null>;
  getStringPref(prefName: string): Promise<string | null>;
  setBoolPref(prefName: string, prefValue: boolean): Promise<void>;
  setIntPref(prefName: string, prefValue: number): Promise<void>;
  setStringPref(prefName: string, prefValue: string): Promise<void>;
  /**
   * Opens the engine's migration wizard. Lives on the parent because the
   * wizard needs a chrome window to hang off and the onboarding page only
   * has its own content window.
   */
  openMigrationWizard(): Promise<void>;
  /** Installed browsers with data, and what each one can hand over. */
  listImportSources(): Promise<{ key: string; offers: string[] }[]>;
  runImport(
    key: string,
    items: string[],
  ): Promise<{ ok: boolean; error?: string }>;
  importVivaldiWorkspaces(): Promise<{
    ok: boolean;
    error?: string;
    result?: { workspacesCreated: number; tabsRestored: number };
  }>;
}
