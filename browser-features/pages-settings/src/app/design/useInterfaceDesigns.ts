import { useMemo } from "react";
import { useTheme } from "@/components/theme-provider";
import { useTranslation } from "react-i18next";

import LeptonLight from "@/app/design/images/designs/Floorp_UI_Lepton_Light.svg";
import LeptonDark from "@/app/design/images/designs/Floorp_UI_Lepton_Dark.svg";

export const useInterfaceDesigns = (): {
  value: string;
  title: string;
  image: string;
}[] => {
  const { resolvedTheme } = useTheme();
  const { t } = useTranslation();

  return useMemo(() => {
    const isDark = resolvedTheme === "dark";
    // derp keeps only two interfaces: derp (the fork's compact default) and
    // lepton (the base it is built on). Both preview with the Lepton image,
    // since derp is a compact Lepton.
    return [
      {
        value: "derp",
        title: t("design.derp"),
        image: isDark ? LeptonDark : LeptonLight,
      },
      {
        value: "lepton",
        title: t("design.lepton"),
        image: isDark ? LeptonDark : LeptonLight,
      },
    ];
  }, [resolvedTheme, t]);
};
