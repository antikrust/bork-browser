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

/** Stands for every browser found, rather than any one migrator key. */
const ALL_SOURCES = "__all__";

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

  // Everything found, offering the union of what they offer between them.
  // Each browser is still only asked for the items it actually has.
  const everySource: ImportSource | null = sources?.length
    ? {
      key: ALL_SOURCES,
      offers: [...new Set(sources.flatMap((s) => s.offers))],
    }
    : null;

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

  const importingAll = selected === ALL_SOURCES;
  const current = importingAll
    ? everySource
    : sources?.find((s) => s.key === selected) ?? null;
  // Workspaces are Vivaldi's, so they ride along whenever Vivaldi is in scope.
  const isVivaldi = selected === "vivaldi" ||
    (importingAll && !!sources?.some((s) => s.key === "vivaldi"));

  // "Everything" covers the browser's own data plus, for Vivaldi, the
  // workspaces - which is the whole point of picking Vivaldi.
  const allSelected = !!current &&
    current.offers.every((offer) => items.has(offer)) &&
    (!isVivaldi || withWorkspaces);
  const noneSelected = items.size === 0 && !(isVivaldi && withWorkspaces);

  const toggleAll = () => {
    if (allSelected) {
      setItems(new Set());
      setWithWorkspaces(false);
    } else {
      setItems(new Set(current?.offers ?? []));
      setWithWorkspaces(true);
    }
  };

  const runImport = async () => {
    if (!current) return;
    setBusy(true);
    setStatus(null);
    const done: string[] = [];
    try {
      const targets = importingAll ? (sources ?? []) : [current];
      const imported: { name: string; count: number }[] = [];
      const failed: string[] = [];

      for (const source of targets) {
        // Ask each browser only for what it actually offers: Safari has no
        // cookies to give, and requesting them fails the whole call.
        const wanted = source.offers.filter((offer) => items.has(offer));
        if (!wanted.length) continue;
        try {
          const result = await rpc.runImport(source.key, wanted);
          if (!result.ok) throw new Error(result.error ?? "import failed");
          imported.push({ name: sourceName(source.key), count: wanted.length });
        } catch (e) {
          // A locked password store in one browser should not cost you the
          // other four.
          console.error("[ImportPage] Import failed for", source.key, e);
          failed.push(sourceName(source.key));
        }
      }

      if (imported.length === 1) {
        done.push(
          t("importPage.doneData", {
            count: imported[0].count,
            browser: imported[0].name,
          }),
        );
      } else if (imported.length > 1) {
        done.push(
          t("importPage.doneAll", {
            browsers: imported.map((i) => i.name).join(", "),
          }),
        );
      }
      if (failed.length) {
        done.push(t("importPage.someFailed", { browsers: failed.join(", ") }));
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
                {/* Pointless with one browser installed, so it earns its place
                    only when there is actually more than one to sweep. */}
                {sources.length > 1 && everySource && (
                  <button
                    type="button"
                    className={`btn btn-sm ${
                      importingAll ? "btn-primary" : "btn-outline"
                    }`}
                    onClick={() => chooseSource(everySource)}
                  >
                    {t("importPage.allBrowsers")}
                  </button>
                )}
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
                <label className="flex items-center gap-3 rounded-lg bg-base-100 p-3 mb-2 cursor-pointer font-medium">
                  <input
                    type="checkbox"
                    className="checkbox checkbox-primary checkbox-sm"
                    checked={allSelected}
                    ref={(el) => {
                      // Partly ticked reads as "some of this", which a plain
                      // checked/unchecked box cannot express.
                      if (el) el.indeterminate = !allSelected && !noneSelected;
                    }}
                    onChange={toggleAll}
                  />
                  <span>{t("importPage.selectAll")}</span>
                </label>
              )}

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
                {importingAll && items.has("passwords")
                  ? ` ${t("importPage.passwordNoteAll")}`
                  : ""}
              </p>
            </>
          )}
        </div>
      </div>

      <Navigation />
    </div>
  );
}
