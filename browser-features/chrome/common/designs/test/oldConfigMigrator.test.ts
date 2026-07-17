// SPDX-License-Identifier: MPL-2.0
// @colocated-env browser

import {
  getOldInterfaceConfig,
  getOldTabbarStyleConfig,
  getOldTabbarPositionConfig,
} from "../utils/old-config-migrator.ts";
import {
  assertEquals,
  type TestCase,
} from "../../../test/utils/test_harness.ts";

// ---------------------------------------------------------------------------
// Helpers — set/clear prefs safely
// ---------------------------------------------------------------------------

function withIntPref(prefName: string, value: number, fn: () => void): void {
  Services.prefs.setIntPref(prefName, value);
  try {
    fn();
  } finally {
    Services.prefs.clearUserPref(prefName);
  }
}

function withIntPrefs(prefs: [string, number][], fn: () => void): void {
  for (const [name, value] of prefs) {
    Services.prefs.setIntPref(name, value);
  }
  try {
    fn();
  } finally {
    for (const [name] of prefs) {
      Services.prefs.clearUserPref(name);
    }
  }
}

// ---------------------------------------------------------------------------
// Tests — getOldInterfaceConfig
// ---------------------------------------------------------------------------

function testInterfaceDefaultDerp(): void {
  withIntPref("floorp.browser.user.interface", 0, () => {
    assertEquals(
      getOldInterfaceConfig(),
      "derp",
      "default (0, no legacy pref) should return derp",
    );
  });
}

function testInterfaceCase3DefaultLepton(): void {
  withIntPrefs(
    [
      ["floorp.browser.user.interface", 3],
      ["floorp.lepton.interface", 0],
    ],
    () => {
      assertEquals(
        getOldInterfaceConfig(),
        "lepton",
        "interface=3, lepton=0 should return lepton",
      );
    },
  );
}

function testInterfaceCase3PhotonNowLepton(): void {
  withIntPrefs(
    [
      ["floorp.browser.user.interface", 3],
      ["floorp.lepton.interface", 1],
    ],
    () => {
      assertEquals(
        getOldInterfaceConfig(),
        "lepton",
        "legacy photon (3, 1) collapses to lepton",
      );
    },
  );
}

function testInterfaceCase3ProtonfixNowLepton(): void {
  withIntPrefs(
    [
      ["floorp.browser.user.interface", 3],
      ["floorp.lepton.interface", 3],
    ],
    () => {
      assertEquals(
        getOldInterfaceConfig(),
        "lepton",
        "legacy protonfix (3, 3) collapses to lepton",
      );
    },
  );
}

function testInterfaceCase8FluerialNowLepton(): void {
  withIntPref("floorp.browser.user.interface", 8, () => {
    assertEquals(
      getOldInterfaceConfig(),
      "lepton",
      "legacy fluerial (8) collapses to lepton",
    );
  });
}

// ---------------------------------------------------------------------------
// Tests — getOldTabbarStyleConfig
// ---------------------------------------------------------------------------

function testTabbarStyleHorizontal(): void {
  withIntPref("floorp.tabbar.style", 0, () => {
    assertEquals(
      getOldTabbarStyleConfig(),
      "horizontal",
      "style=0 should return horizontal",
    );
  });
}

function testTabbarStyleMultirow(): void {
  withIntPref("floorp.tabbar.style", 1, () => {
    assertEquals(
      getOldTabbarStyleConfig(),
      "multirow",
      "style=1 should return multirow",
    );
  });
}

function testTabbarStyleVertical(): void {
  withIntPref("floorp.tabbar.style", 2, () => {
    assertEquals(
      getOldTabbarStyleConfig(),
      "vertical",
      "style=2 should return vertical",
    );
  });
}

// ---------------------------------------------------------------------------
// Tests — getOldTabbarPositionConfig
// ---------------------------------------------------------------------------

function testTabbarPositionDefault(): void {
  withIntPref("floorp.browser.tabbar.settings", 0, () => {
    assertEquals(
      getOldTabbarPositionConfig(),
      "default",
      "settings=0 should return default",
    );
  });
}

function testTabbarPositionHide(): void {
  withIntPref("floorp.browser.tabbar.settings", 1, () => {
    assertEquals(
      getOldTabbarPositionConfig(),
      "hide-horizontal-tabbar",
      "settings=1 should return hide-horizontal-tabbar",
    );
  });
}

function testTabbarPositionOptimise(): void {
  withIntPref("floorp.browser.tabbar.settings", 2, () => {
    assertEquals(
      getOldTabbarPositionConfig(),
      "optimise-to-vertical-tabbar",
      "settings=2 should return optimise-to-vertical-tabbar",
    );
  });
}

function testTabbarPositionBottomNav(): void {
  withIntPref("floorp.browser.tabbar.settings", 3, () => {
    assertEquals(
      getOldTabbarPositionConfig(),
      "bottom-of-navigation-toolbar",
      "settings=3 should return bottom-of-navigation-toolbar",
    );
  });
}

function testTabbarPositionBottomWindow(): void {
  withIntPref("floorp.browser.tabbar.settings", 4, () => {
    assertEquals(
      getOldTabbarPositionConfig(),
      "bottom-of-window",
      "settings=4 should return bottom-of-window",
    );
  });
}

// ---------------------------------------------------------------------------
// Tests — edge cases (invalid / unknown values)
// ---------------------------------------------------------------------------

function testInterfaceInvalidValueReturnsDerp(): void {
  withIntPref("floorp.browser.user.interface", 99, () => {
    assertEquals(
      getOldInterfaceConfig(),
      "derp",
      "invalid interface value should default to derp",
    );
  });
}

function testInterfaceCase3InvalidLeptonReturnsLepton(): void {
  withIntPrefs(
    [
      ["floorp.browser.user.interface", 3],
      ["floorp.lepton.interface", 99],
    ],
    () => {
      assertEquals(
        getOldInterfaceConfig(),
        "lepton",
        "interface=3, lepton=99 should default to lepton",
      );
    },
  );
}

function testTabbarStyleInvalidValueReturnsHorizontal(): void {
  withIntPref("floorp.tabbar.style", 99, () => {
    assertEquals(
      getOldTabbarStyleConfig(),
      "horizontal",
      "invalid style value should default to horizontal",
    );
  });
}

function testTabbarPositionInvalidValueReturnsDefault(): void {
  withIntPref("floorp.browser.tabbar.settings", 99, () => {
    assertEquals(
      getOldTabbarPositionConfig(),
      "default",
      "invalid position value should default to 'default'",
    );
  });
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export function runAllTests(): void {
  const tests: TestCase[] = [
    { name: "interface default → derp", fn: testInterfaceDefaultDerp },
    {
      name: "interface 3+0 → lepton",
      fn: testInterfaceCase3DefaultLepton,
    },
    { name: "interface 3+1 → lepton", fn: testInterfaceCase3PhotonNowLepton },
    { name: "interface 3+3 → lepton", fn: testInterfaceCase3ProtonfixNowLepton },
    { name: "interface 8 → lepton", fn: testInterfaceCase8FluerialNowLepton },
    { name: "tabbar style 0 → horizontal", fn: testTabbarStyleHorizontal },
    { name: "tabbar style 1 → multirow", fn: testTabbarStyleMultirow },
    { name: "tabbar style 2 → vertical", fn: testTabbarStyleVertical },
    { name: "tabbar position 0 → default", fn: testTabbarPositionDefault },
    { name: "tabbar position 1 → hide", fn: testTabbarPositionHide },
    { name: "tabbar position 2 → optimise", fn: testTabbarPositionOptimise },
    {
      name: "tabbar position 3 → bottom-nav",
      fn: testTabbarPositionBottomNav,
    },
    {
      name: "tabbar position 4 → bottom-window",
      fn: testTabbarPositionBottomWindow,
    },
    // Edge cases
    {
      name: "interface invalid → derp",
      fn: testInterfaceInvalidValueReturnsDerp,
    },
    {
      name: "interface 3+invalid → lepton",
      fn: testInterfaceCase3InvalidLeptonReturnsLepton,
    },
    {
      name: "tabbar style invalid → horizontal",
      fn: testTabbarStyleInvalidValueReturnsHorizontal,
    },
    {
      name: "tabbar position invalid → default",
      fn: testTabbarPositionInvalidValueReturnsDefault,
    },
  ];

  const failures: string[] = [];

  for (const test of tests) {
    try {
      test.fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${test.name}: ${message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `oldConfigMigrator.test.ts failures: ${failures.join(" | ")}`,
    );
  }
}
