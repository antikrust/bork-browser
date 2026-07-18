import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Navigation from "../../components/Navigation.tsx";
import { Check, Download, Layers, Loader2 } from "lucide-react";
import { rpc } from "../../lib/rpc/rpc.ts";

interface ImportSource {
  key: string;
  offers: string[];
}

/** Migrator keys are internal; these are what people call the browsers. */
const SOURCE_NAMES: Record<string, string> = {
  vivaldi: "Vivaldi",
  chrome: "Google Chrome",
  "chrome-beta": "Chrome Beta",
  chromium: "Chromium",
  canary: "Chrome Canary",
  brave: "Brave",
  opera: "Opera",
  "opera-gx": "Opera GX",
  edge: "Microsoft Edge",
  "chromium-edge": "Microsoft Edge",
  "chromium-edge-beta": "Microsoft Edge Beta",
  safari: "Safari",
  firefox: "Firefox",
  ie: "Internet Explorer",
};

const sourceName = (key: string) => SOURCE_NAMES[key] ?? key;

export default function ImportPage() {
  const { t } = useTranslation();
  const [sources, setSources] = useState<ImportSource[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [items, setItems] = useState<Set<string>>(new Set());
  const [withWorkspaces, setWithWorkspaces] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    rpc.listImportSources()
      .then((found: ImportSource[]) => {
        if (cancelled) return;
        setSources(found);
        const first = found[0];
        if (first) {
          setSelected(first.key);
          setItems(new Set(first.offers));
        }
      })
      .catch((e: unknown) => {
        console.error("[ImportPage] Could not list import sources", e);
        if (!cancelled) setSources([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const chooseSource = (source: ImportSource) => {
    setSelected(source.key);
    setItems(new Set(source.offers));
    setStatus(null);
  };

  const toggleItem = (name: string) => {
    setItems((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const current = sources?.find((s) => s.key === selected) ?? null;
  const isVivaldi = selected === "vivaldi";

  const runImport = async () => {
    if (!current) return;
    setBusy(true);
    setStatus(null);
    const done: string[] = [];
    try {
      if (items.size) {
        const result = await rpc.runImport(current.key, [...items]);
        if (!result.ok) throw new Error(result.error ?? "import failed");
        done.push(
          t("importPage.doneData", { count: items.size, browser: sourceName(current.key) }),
        );
      }
      if (isVivaldi && withWorkspaces) {
        const ws = await rpc.importVivaldiWorkspaces();
        const r = ws.result;
        if (ws.ok && r) {
          done.push(
            t("importPage.doneWorkspaces", {
              workspaces: r.workspacesCreated,
              tabs: r.tabsRestored,
            }),
          );
        }
      }
      setStatus(done.join(" ") || t("importPage.nothingSelected"));
    } catch (e) {
      console.error("[ImportPage] Import failed", e);
      setStatus(t("importPage.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="text-center">
        <h1 className="text-4xl font-bold mb-4">{t("importPage.title")}</h1>
        <p className="text-lg">{t("importPage.subtitle")}</p>
      </div>

      <div className="card bg-base-200">
        <div className="card-body">
          {sources === null && (
            <div className="flex items-center gap-3 text-base-content/70">
              <Loader2 className="animate-spin" size={20} />
              {t("importPage.looking")}
            </div>
          )}

          {sources?.length === 0 && (
            <p className="text-base-content/70">{t("importPage.noneFound")}</p>
          )}

          {!!sources?.length && (
            <>
              <p className="text-base-content/80 mb-2">
                {t("importPage.description")}
              </p>

              <div className="flex flex-wrap gap-2 mb-4">
                {sources.map((source) => (
                  <button
                    key={source.key}
                    type="button"
                    className={`btn btn-sm ${
                      source.key === selected ? "btn-primary" : "btn-outline"
                    }`}
                    onClick={() => chooseSource(source)}
                  >
                    {sourceName(source.key)}
                  </button>
                ))}
              </div>

              {current && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {current.offers.map((name) => (
                    <label
                      key={name}
                      className="flex items-center gap-3 rounded-lg bg-base-100 p-3 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        className="checkbox checkbox-primary checkbox-sm"
                        checked={items.has(name)}
                        onChange={() => toggleItem(name)}
                      />
                      <span>{t(`importPage.items.${name}.label`)}</span>
                    </label>
                  ))}

                  {isVivaldi && (
                    <label className="flex items-center gap-3 rounded-lg bg-base-100 p-3 cursor-pointer sm:col-span-2">
                      <input
                        type="checkbox"
                        className="checkbox checkbox-primary checkbox-sm"
                        checked={withWorkspaces}
                        onChange={() => setWithWorkspaces((v) => !v)}
                      />
                      <Layers size={18} className="text-primary" />
                      <span>{t("importPage.items.workspaces.label")}</span>
                    </label>
                  )}
                </div>
              )}

              <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 mt-4">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || !current}
                  onClick={runImport}
                >
                  {busy
                    ? <Loader2 className="mr-2 animate-spin" size={20} />
                    : <Download className="mr-2" size={20} />}
                  {t("importPage.run")}
                </button>
                {status && (
                  <span className="text-sm flex items-center gap-2">
                    <Check size={16} className="text-primary" />
                    {status}
                  </span>
                )}
              </div>

              <p className="text-sm text-base-content/60 mt-4">
                {t("importPage.passwordNote")}
              </p>
            </>
          )}
        </div>
      </div>

      <Navigation />
    </div>
  );
}
