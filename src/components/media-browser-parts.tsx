import { memo, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { classNames, formatBytes } from "../lib/format";
import { bi, getCurrentLocale } from "../lib/i18n";
import { assetUrl } from "../lib/tauri-media";
import type { MediaItem, SortKey } from "../lib/media-browser";

export type ExplorerTableEntry =
  | {
      type: "folder";
      key: string;
      path: string;
      name: string;
      itemCount: number;
      depth: number;
      canExpand: boolean;
      isExpanded: boolean;
    }
  | {
      type: "file";
      key: string;
      item: MediaItem;
      depth: number;
    };

export const VideoThumb = memo(function VideoThumb({
  path,
  active,
}: {
  path: string;
  active: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const ref = useRef<HTMLVideoElement | null>(null);
  const shouldPlay = active || hovered;
  const src = assetUrl(path);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    if (shouldPlay) {
      const promise = node.play();
      if (promise) {
        promise.catch(() => {});
      }
      return;
    }

    node.pause();
    if (node.readyState >= 1) {
      try {
        node.currentTime = Math.min(0.05, node.duration || 0.05);
      } catch {
        // Ignore browsers that don't allow seeking this early.
      }
    }
  }, [shouldPlay, src]);

  return (
    <video
      ref={ref}
      src={src}
      className="h-full w-full object-cover"
      muted
      loop
      playsInline
      preload="metadata"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onLoadedMetadata={(event) => {
        if (shouldPlay) return;
        const node = event.currentTarget;
        try {
          node.currentTime = Math.min(0.05, node.duration || 0.05);
        } catch {
          // Ignore early seek failures.
        }
      }}
    />
  );
});

function entryThumbnail(entry: ExplorerTableEntry, isActive: boolean) {
  if (entry.type === "folder") {
    return (
      <div className="flex h-full w-full items-center justify-center text-[9px] font-semibold text-zinc-600 dark:text-zinc-300">
        DIR
      </div>
    );
  }

  const item = entry.item;
  if (item.kind === "image") {
    return (
      <img
        src={assetUrl(item.path)}
        alt={item.name}
        className="h-full w-full object-cover"
        loading="lazy"
      />
    );
  }
  if (item.kind === "video") {
    return <VideoThumb path={item.path} active={isActive} />;
  }
  if (item.kind === "document") {
    return (
      <div className="flex h-full w-full items-center justify-center text-[9px] font-semibold text-zinc-600 dark:text-zinc-300">
        MD
      </div>
    );
  }
  return (
    <div className="flex h-full w-full items-center justify-center text-[9px] font-semibold text-zinc-600 dark:text-zinc-300">
      ZIP
    </div>
  );
}

function entryName(entry: ExplorerTableEntry) {
  return entry.type === "folder" ? entry.name : `${entry.item.name}${entry.item.ext}`;
}

function entryMeta(entry: ExplorerTableEntry) {
  return entry.type === "folder"
    ? bi(`${entry.itemCount} items`, `${entry.itemCount}개 항목`)
    : entry.item.ext || "-";
}

function entryDateParts(entry: ExplorerTableEntry) {
  if (entry.type === "folder") {
    return { primary: "-", secondary: "" };
  }

  const locale = getCurrentLocale() === "ko" ? "ko-KR" : "en-US";
  const hour12 = getCurrentLocale() === "en";
  const date = new Date(entry.item.modifiedMs);

  return {
    primary: new Intl.DateTimeFormat(locale, {
      year: "2-digit",
      month: "2-digit",
      day: "2-digit",
    }).format(date),
    secondary: new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      hour12,
    }).format(date),
  };
}

function entrySize(entry: ExplorerTableEntry) {
  return entry.type === "folder" ? "-" : formatBytes(entry.item.sizeBytes);
}

function entryExt(entry: ExplorerTableEntry) {
  return entry.type === "folder" ? bi("Folder", "폴더") : entry.item.ext || "-";
}

function sortIndicator(column: SortKey, activeSortKey: SortKey, sortDirection: "asc" | "desc") {
  if (column !== activeSortKey) return "";
  return sortDirection === "asc" ? "↑" : "↓";
}

export const ExplorerTable = memo(function ExplorerTable({
  entries,
  activeFileId,
  selectedFolderPath,
  selectedItemIds,
  sortKey,
  sortDirection,
  onRequestSort,
  onToggleFolderExpand,
  onSelectFolder,
  onOpenFolder,
  onSelectFile,
  onContextMenuFolder,
  onContextMenuFile,
}: {
  entries: ExplorerTableEntry[];
  activeFileId: string | null;
  selectedFolderPath: string;
  selectedItemIds: Set<string>;
  sortKey: SortKey;
  sortDirection: "asc" | "desc";
  onRequestSort: (key: SortKey) => void;
  onToggleFolderExpand: (path: string) => void;
  onSelectFolder: (path: string) => void;
  onOpenFolder: (path: string) => void;
  onSelectFile: (event: ReactMouseEvent<HTMLButtonElement>, item: MediaItem) => void;
  onContextMenuFolder: (event: ReactMouseEvent<HTMLButtonElement>, path: string) => void;
  onContextMenuFile: (event: ReactMouseEvent<HTMLButtonElement>, item: MediaItem) => void;
}) {
  const gridCols = "grid-cols-[minmax(0,1fr)_92px_68px_52px]";
  const headerCellClass =
    "flex w-full items-center gap-1 rounded-md px-1 py-0.5 text-left hover:bg-zinc-200/70 dark:hover:bg-zinc-800/70";

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950/50">
      <div className="max-h-full overflow-auto">
        <div className="min-w-[420px]">
          <div
            className={classNames(
              "grid items-center gap-2 border-b border-zinc-200 bg-zinc-100/80 px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.08em] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/70 dark:text-zinc-400",
              gridCols,
            )}
          >
            <button type="button" className={headerCellClass} onClick={() => onRequestSort("name")}>
              <span>{bi("Name", "이름")}</span>
              <span>{sortIndicator("name", sortKey, sortDirection)}</span>
            </button>
            <button type="button" className={headerCellClass} onClick={() => onRequestSort("date")}>
              <span>{bi("Date", "날짜")}</span>
              <span>{sortIndicator("date", sortKey, sortDirection)}</span>
            </button>
            <button
              type="button"
              className={classNames(headerCellClass, "justify-end")}
              onClick={() => onRequestSort("size")}
            >
              <span>{bi("Size", "크기")}</span>
              <span>{sortIndicator("size", sortKey, sortDirection)}</span>
            </button>
            <button type="button" className={headerCellClass} onClick={() => onRequestSort("ext")}>
              <span>{bi("Ext", "확장자")}</span>
              <span>{sortIndicator("ext", sortKey, sortDirection)}</span>
            </button>
          </div>

          {entries.length ? (
            entries.map((entry) => {
              const isFolder = entry.type === "folder";
              const isActive = !isFolder && activeFileId === entry.item.id;
              const isSelected =
                entry.type === "folder"
                  ? selectedFolderPath === entry.path
                  : selectedItemIds.has(entry.item.id);

              return (
                <div key={entry.key} data-tree-key={entry.key}>
                  <button
                    type="button"
                    onClick={(event) => {
                      if (entry.type === "folder") {
                        event.preventDefault();
                        onSelectFolder(entry.path);
                        return;
                      }
                      onSelectFile(event, entry.item);
                    }}
                    onDoubleClick={() => {
                      if (entry.type === "folder") {
                        onOpenFolder(entry.path);
                      }
                    }}
                    onContextMenu={(event) => {
                      if (entry.type === "folder") {
                        onContextMenuFolder(event, entry.path);
                        return;
                      }
                      onContextMenuFile(event, entry.item);
                    }}
                    className={classNames(
                      "grid w-full items-center gap-2 border-b border-zinc-100 px-2 py-1 text-left transition last:border-b-0 dark:border-zinc-900",
                      gridCols,
                      isActive
                        ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"
                        : isSelected
                          ? "bg-sky-50 text-zinc-950 dark:bg-sky-950/30 dark:text-zinc-50"
                          : "hover:bg-zinc-50 dark:hover:bg-zinc-900/70",
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: `${entry.depth * 10}px` }}>
                      {entry.type === "folder" ? (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            onToggleFolderExpand(entry.path);
                          }}
                          className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-zinc-300 text-[9px] text-zinc-500 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                          aria-label={entry.isExpanded ? bi("Collapse folder", "폴더 접기") : bi("Expand folder", "폴더 펼치기")}
                        >
                          {entry.canExpand ? (entry.isExpanded ? "-" : "+") : ""}
                        </button>
                      ) : (
                        <div className="w-4 shrink-0" />
                      )}
                      <div className="h-7 w-7 shrink-0 overflow-hidden rounded-md bg-zinc-200 dark:bg-zinc-800">
                        {entryThumbnail(entry, isActive)}
                      </div>
                      <div className="min-w-0">
                        <div
                          className="overflow-hidden text-[10px] font-semibold leading-3.5"
                          style={{
                            display: "-webkit-box",
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: "vertical",
                            wordBreak: "break-all",
                          }}
                        >
                          {entryName(entry)}
                        </div>
                        <div
                          className={classNames(
                            "truncate text-[8px] leading-3",
                            isActive ? "text-zinc-300 dark:text-zinc-600" : "text-zinc-500 dark:text-zinc-400",
                          )}
                        >
                          {entryMeta(entry)}
                        </div>
                      </div>
                    </div>

                    <div className="text-[8px] leading-3 text-zinc-500 dark:text-zinc-400">
                      <div className="truncate">{entryDateParts(entry).primary}</div>
                      <div className="truncate opacity-80">{entryDateParts(entry).secondary}</div>
                    </div>
                    <div className="truncate text-right text-[9px] text-zinc-500 dark:text-zinc-400">
                      {entrySize(entry)}
                    </div>
                    <div className="truncate text-[9px] text-zinc-500 dark:text-zinc-400">
                      {entryExt(entry)}
                    </div>
                  </button>
                </div>
              );
            })
          ) : (
            <div className="px-3 py-6 text-center text-[11px] text-zinc-500 dark:text-zinc-400">
              {bi("No items in this folder.", "이 폴더에 항목이 없습니다.")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
