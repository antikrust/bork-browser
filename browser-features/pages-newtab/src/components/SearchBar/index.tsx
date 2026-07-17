import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";

declare global {
  var NRFocusUrlBar: (() => void) | undefined;
  var NRSearchWithDefaultEngine: ((query: string) => void) | undefined;
}

export function SearchBar() {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");

  const submit = () => {
    const q = query.trim();
    if (!q) return;
    if (globalThis.NRSearchWithDefaultEngine) {
      // Address-bar semantics in this tab: URLs navigate, everything
      // else searches with the default engine.
      globalThis.NRSearchWithDefaultEngine(q);
    } else if (globalThis.NRFocusUrlBar) {
      // Actor unavailable (shouldn't happen): old focus-the-urlbar path.
      globalThis.NRFocusUrlBar();
    }
  };

  return (
    <div className="relative w-full">
      <div className="group bg-black/35 rounded-lg flex items-center p-2 focus-within:bg-black/50 hover:bg-black/45 transition-colors">
        <div className="relative flex-1">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder={t("searchBar.searchOrEnterUrl")}
            className="w-full bg-transparent border-none outline-none px-2 py-1 text-gray-100 group-hover:text-white transition-colors"
          />
        </div>

        <button
          type="button"
          onClick={submit}
          className="p-2 text-gray-400 hover:text-white transition-colors cursor-pointer"
          title={t("searchBar.searchOrEnterUrl")}
        >
          <Search size={18} />
        </button>
      </div>
    </div>
  );
}
