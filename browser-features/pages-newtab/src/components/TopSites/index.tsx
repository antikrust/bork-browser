import { type MouseEvent, useEffect, useRef, useState } from "react";
import {
  getNewTabSettings,
  type NewTabSettings,
  type PinnedSite as PinnedSiteType,
  saveNewTabSettings,
} from "@/utils/dataManager.ts";
import { useTranslation } from "react-i18next";
import { TopSiteTile } from "./TopSiteTile.tsx";

export interface TopSite {
  url: string;
  title: string;
  label?: string;
  favicon?: string;
  smallFavicon?: string | null;
}

export type PinnedSite = PinnedSiteType;

declare global {
  interface Window {
  }
}

function BlockModal({
  site,
  onConfirm,
  onCancel,
}: {
  site: TopSite | PinnedSite;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <dialog className="modal modal-open">
      <div className="modal-box">
        <h3 className="font-bold text-lg">
          {t("topSites.blockTitle", {
            title: site.title,
            defaultValue: `Block "${site.title}"?`,
          })}
        </h3>
        <p className="py-4">
          {t(
            "topSites.blockConfirm",
            "This site will be removed from your Top Sites and won't be suggested again. You can manage blocked sites in settings.",
          )}
        </p>
        <div className="modal-action">
          <button type="button" onClick={onConfirm} className="btn btn-primary">
            {t("topSites.block")}
          </button>
          <button type="button" onClick={onCancel} className="btn">
            {t("topSites.cancel")}
          </button>
        </div>
      </div>
    </dialog>
  );
}

function AddSiteModal({
  onAdd,
  onCancel,
}: {
  onAdd: (url: string, label: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    urlInputRef.current?.focus();
  }, []);

  const normalizeUrl = (raw: string): string | null => {
    let value = raw.trim();
    if (!value) return null;
    if (!/^https?:\/\//i.test(value)) {
      value = `https://${value}`;
    }
    try {
      const u = new URL(value);
      // 不要な末尾スラッシュを除去（ルートのみ維持）
      if (u.pathname !== "/") {
        u.pathname = u.pathname.replace(/\/+$/, "");
      }
      return u.href;
    } catch {
      return null;
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const normalized = normalizeUrl(url);
    if (!normalized) {
      setError(t("topSites.invalidUrl", { defaultValue: "Invalid URL" }));
      return;
    }
    onAdd(normalized, label.trim() || normalized);
  };

  return (
    <dialog className="modal modal-open">
      <div className="modal-box">
        <h3 className="font-bold text-lg mb-2">{t("topSites.addNewSite")}</h3>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="form-control">
            <label className="label">
              <span className="label-text">{t("topSites.url")}</span>
            </label>
            <input
              ref={urlInputRef}
              type="text"
              className="input input-bordered w-full"
              placeholder="https://example.com"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
          </div>
          <div className="form-control">
            <label className="label">
              <span className="label-text">{t("topSites.label")}</span>
            </label>
            <input
              type="text"
              className="input input-bordered w-full"
              placeholder={t("topSites.labelPlaceholder", {
                defaultValue: "Website name",
              })}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          {error && <p className="text-error text-sm">{error}</p>}
          <div className="modal-action">
            <button type="button" className="btn" onClick={onCancel}>
              {t("topSites.cancel")}
            </button>
            <button type="submit" className="btn btn-primary">
              {t("topSites.add")}
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
}

export function TopSites({ isFirefoxMode = false }: { isFirefoxMode?: boolean }) {
  const { t } = useTranslation();
  const [pinnedSites, setPinnedSites] = useState<PinnedSite[]>([]);
  const [blockedSites, setBlockedSites] = useState<string[]>([]);
  const [contextMenu, setContextMenu] = useState<
    {
      x: number;
      y: number;
      site: TopSite | PinnedSite;
    } | null
  >(null);
  const [siteToBlock, setSiteToBlock] = useState<TopSite | PinnedSite | null>(
    null,
  );
  const [showAddModal, setShowAddModal] = useState(false);

  const contextMenuRef = useRef<HTMLDivElement>(null);

  const loadSettings = async () => {
    const settings = await getNewTabSettings();
    setPinnedSites(settings.topSites.pinned);
    setBlockedSites(settings.topSites.blocked);

  };

  useEffect(() => {
    loadSettings();
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: globalThis.MouseEvent) => {
      if (
        contextMenuRef.current &&
        !contextMenuRef.current.contains(event.target as Node)
      ) {
        setContextMenu(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [contextMenuRef]);

  const handleContextMenu = (
    e: MouseEvent<HTMLAnchorElement>,
    site: TopSite | PinnedSite,
  ) => {
    e.preventDefault();
    setContextMenu({ x: e.pageX, y: e.pageY, site });
  };

  const handleSaveSettings = async (settings: Partial<NewTabSettings>) => {
    await saveNewTabSettings(settings);
    await loadSettings();
    setContextMenu(null);
  };

  const pinSite = async (site: TopSite | PinnedSite) => {
    const title = "title" in site && site.title ? site.title : site.url;
    const newPinnedSites = [...pinnedSites, { url: site.url, title }];
    await handleSaveSettings({
      topSites: { pinned: newPinnedSites, blocked: blockedSites },
    });
  };

  const addCustomSite = async (url: string, title: string) => {
    // 重複確認
    if (
      pinnedSites.some((p) => p.url === url) ||
      blockedSites.includes(url)
    ) {
      // 既に存在する場合はピン済み扱いとして閉じる
      setShowAddModal(false);
      return;
    }
    const newPinnedSites = [...pinnedSites, { url, title }];
    await handleSaveSettings({
      topSites: { pinned: newPinnedSites, blocked: blockedSites },
    });
    setShowAddModal(false);
  };

  /**
   * Take a tile off the page and forget it, without adding the URL to the
   * blocked list - the page only shows sites you added, so there is no
   * frecency ranking waiting to put it back.
   */
  const dismissSite = async (site: TopSite | PinnedSite) => {
    const newPinnedSites = pinnedSites.filter((p) => p.url !== site.url);
    await handleSaveSettings({
      topSites: { pinned: newPinnedSites, blocked: blockedSites },
    });
  };

  const unpinSite = async (site: PinnedSite) => {
    const newPinnedSites = pinnedSites.filter((p) => p.url !== site.url);
    await handleSaveSettings({
      topSites: { pinned: newPinnedSites, blocked: blockedSites },
    });
  };

  const handleBlockRequest = (site: TopSite | PinnedSite) => {
    setSiteToBlock(site);
    setContextMenu(null);
  };

  const confirmBlockSite = async () => {
    if (!siteToBlock) return;
    const newBlockedSites = [...blockedSites, siteToBlock.url];
    let newPinnedSites = pinnedSites;
    if (isPinned(siteToBlock)) {
      newPinnedSites = pinnedSites.filter((p) => p.url !== siteToBlock.url);
    }
    await handleSaveSettings({
      topSites: { pinned: newPinnedSites, blocked: newBlockedSites },
    });
    setSiteToBlock(null);
  };

  const cancelBlockSite = () => {
    setSiteToBlock(null);
  };

  const isPinned = (site: TopSite | PinnedSite) => {
    return pinnedSites.some((p) => p.url === site.url);
  };

  return (
    <>
      {siteToBlock && (
        <BlockModal
          site={siteToBlock}
          onConfirm={confirmBlockSite}
          onCancel={cancelBlockSite}
        />
      )}
      {showAddModal && (
        <AddSiteModal
          onAdd={addCustomSite}
          onCancel={() => setShowAddModal(false)}
        />
      )}
      <div
        className={`bg-black/40 p-3 rounded-lg inline-block`}
      >
        <div className="flex flex-wrap gap-x-0.5">
          {pinnedSites.map((site) => (
            <TopSiteTile
              key={site.url}
              site={site}
              isPinned
              isFirefoxMode={isFirefoxMode}
              onContextMenu={handleContextMenu}
            />
          ))}
          {/* Add new site tile */}
          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            className={`group flex flex-col items-center p-2 rounded-lg border border-dashed border-gray-400/50 text-gray-300 hover:text-white hover:bg-gray-100/20 transition-all ${
              isFirefoxMode ? "w-20 md:w-24" : "w-16"
            }`}
            title={t("topSites.addSite")}
          >
            <div
              className={`rounded-lg flex items-center justify-center bg-gray-700 group-hover:scale-110 transform transition-transform mb-1 ${
                isFirefoxMode ? "w-10 h-10 md:w-12 md:h-12" : "w-8 h-8"
              }`}
            >
              <span className="text-2xl leading-none">＋</span>
            </div>
            <span
              className="text-center leading-tight line-clamp-2 text-shadow-lg/20 group-hover:text-white transition-colors"
              style={{ fontSize: isFirefoxMode ? "12px" : "10px" }}
            >
              {t("topSites.addSite")}
            </span>
          </button>
        </div>
      </div>
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="absolute z-10 bg-base-200 rounded-md shadow-lg"
          style={{
            top: `${contextMenu.y}px`,
            left: `${contextMenu.x}px`,
          }}
        >
          <ul className="menu p-2">
            {isPinned(contextMenu.site)
              ? (
                <li onClick={() => unpinSite(contextMenu.site as PinnedSite)}>
                  <a>{t("topSites.unpin")}</a>
                </li>
              )
              : (
                <li onClick={() => pinSite(contextMenu.site)}>
                  <a>{t("topSites.pin")}</a>
                </li>
              )}
            <li onClick={() => dismissSite(contextMenu.site)}>
              <a>{t("topSites.dismiss")}</a>
            </li>
            <li onClick={() => handleBlockRequest(contextMenu.site)}>
              <a>{t("topSites.block")}</a>
            </li>
          </ul>
        </div>
      )}
    </>
  );
}
