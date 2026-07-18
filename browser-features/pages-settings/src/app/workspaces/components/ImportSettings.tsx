import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/common/card.tsx";
import { Button } from "@/components/common/button.tsx";
import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { Check, Download, Loader2 } from "lucide-react";
import { rpc } from "@/lib/rpc/rpc.ts";

/**
 * Bringing workspaces over from Vivaldi. Onboarding offers this too, but an
 * existing profile never sees onboarding again, so this is the entry point
 * that stays reachable.
 */
export function ImportSettings() {
  const { t } = useTranslation();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    rpc.listImportSources()
      .then((sources: { key: string }[]) => {
        if (!cancelled) {
          setAvailable(sources.some((s) => s.key === "vivaldi"));
        }
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Nothing to offer without a Vivaldi profile on the machine.
  if (available !== true) return null;

  const runImport = async () => {
    setBusy(true);
    setResult(null);
    try {
      const response = await rpc.importVivaldiWorkspaces();
      const imported = response.result;
      if (!response.ok || !imported) {
        throw new Error(response.error ?? "import failed");
      }
      setResult(
        t("workspaces.import.done", {
          workspaces: imported.workspacesCreated,
          tabs: imported.tabsRestored,
        }),
      );
    } catch (e) {
      console.error("Failed to import Vivaldi workspaces:", e);
      setResult(t("workspaces.import.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Download className="size-5 text-primary" />
          {t("workspaces.import.title")}
        </CardTitle>
        <CardDescription>{t("workspaces.import.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col sm:flex-row sm:items-center gap-3">
        <Button type="button" onClick={runImport} disabled={busy}>
          {busy
            ? <Loader2 className="mr-2 size-4 animate-spin" />
            : <Download className="mr-2 size-4" />}
          {t("workspaces.import.button")}
        </Button>
        {result && (
          <span className="text-sm flex items-center gap-2">
            <Check className="size-4 text-primary" />
            {result}
          </span>
        )}
      </CardContent>
    </Card>
  );
}
