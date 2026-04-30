import { memo, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { classNames, formatBytes } from "../lib/format";
import type { FolderTreeNode, MediaItem } from "../lib/media-browser";
import { assetUrl } from "../lib/tauri-media";

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

export const MediaListRow = memo(function MediaListRow({
  item,
  isActive,
  isSelected,
  itemHeight,
  onSelect,
  onContextMenu,
}: {
  item: MediaItem;
  isActive: boolean;
  isSelected: boolean;
  itemHeight: number;
  onSelect: (event: ReactMouseEvent<HTMLButtonElement>, item: MediaItem) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLButtonElement>, item: MediaItem) => void;
}) {
  return (
    <button
      type="button"
      onClick={(event) => onSelect(event, item)}
      onContextMenu={(event) => onContextMenu(event, item)}
      className={classNames(
        "flex w-full items-center gap-2 rounded-xl border px-2 py-1 text-left transition",
        isActive
          ? "border-zinc-950 bg-zinc-950 text-white dark:border-white dark:bg-white dark:text-zinc-950"
          : isSelected
            ? "border-sky-700 bg-sky-50 text-zinc-950 dark:border-sky-500 dark:bg-sky-950/40 dark:text-zinc-50"
            : "border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900",
      )}
      style={{ height: `${itemHeight - 4}px` }}
    >
      <div className="h-10 w-14 shrink-0 overflow-hidden rounded-lg bg-zinc-200 dark:bg-zinc-800">
        {item.kind === "image" ? (
          <img
            src={assetUrl(item.path)}
            alt={item.name}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <VideoThumb path={item.path} active={isActive} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-semibold leading-5">
          {item.name}
          <span
            className={classNames(
              "ml-1 text-[10px] font-normal",
              isActive ? "text-zinc-300 dark:text-zinc-600" : "text-zinc-500 dark:text-zinc-400",
            )}
          >
            {item.ext}
          </span>
        </div>
        <div
          className={classNames(
            "truncate text-[10px]",
            isActive ? "text-zinc-300 dark:text-zinc-600" : "text-zinc-500 dark:text-zinc-400",
          )}
        >
          {item.relativePath} / {formatBytes(item.sizeBytes)}
        </div>
      </div>
    </button>
  );
});

export const FolderTreeBranch = memo(function FolderTreeBranch({
  nodePath,
  nodes,
  selectedPath,
  rootLabel,
  expandedPaths,
  folderFiles,
  activeFileId,
  selectedItemIds,
  onSelect,
  onToggle,
  onSelectFile,
  onContextMenuFolder,
  onContextMenuFile,
}: {
  nodePath: string;
  nodes: Map<string, FolderTreeNode>;
  selectedPath: string;
  rootLabel: string;
  expandedPaths: Set<string>;
  folderFiles: Map<string, MediaItem[]>;
  activeFileId: string | null;
  selectedItemIds: Set<string>;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
  onSelectFile: (event: ReactMouseEvent<HTMLButtonElement>, item: MediaItem) => void;
  onContextMenuFolder: (event: ReactMouseEvent<HTMLButtonElement>, path: string) => void;
  onContextMenuFile: (event: ReactMouseEvent<HTMLButtonElement>, item: MediaItem) => void;
}) {
  const node = nodes.get(nodePath);
  if (!node) return null;

  const label = node.path ? node.name : rootLabel || "Root";
  const isSelected = selectedPath === node.path;
  const files = folderFiles.get(node.path) ?? [];
  const isExpanded = expandedPaths.has(node.path);
  const canExpand = node.children.length > 0 || files.length > 0;

  return (
    <div>
      <div
        className={classNames(
          "flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left transition",
          isSelected
            ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"
            : "hover:bg-zinc-100 dark:hover:bg-zinc-900",
        )}
        data-tree-key={`folder:${node.path}`}
        style={{ paddingLeft: `${10 + node.depth * 12}px` }}
      >
        <button
          type="button"
          onClick={() => onSelect(node.path)}
          onContextMenu={(event) => onContextMenuFolder(event, node.path)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <div className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-md bg-zinc-200 text-[8px] font-semibold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-300">
            {node.coverPath ? (
              <img
                src={assetUrl(node.coverPath)}
                alt={label}
                className="h-full w-full object-cover"
                loading="lazy"
              />
            ) : (
              "DIR"
            )}
          </div>
          <div className="min-w-0 flex-1 truncate text-[11px] font-medium leading-5">
            {label}
          </div>
          <div
            className={classNames(
              "shrink-0 text-[9px]",
              isSelected ? "text-zinc-300 dark:text-zinc-600" : "text-zinc-500 dark:text-zinc-400",
            )}
          >
            {node.itemCount}
          </div>
        </button>
        <button
          type="button"
          aria-label={isExpanded ? "Collapse folder" : "Expand folder"}
          onClick={() => {
            if (canExpand) onToggle(node.path);
          }}
          className={classNames(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded border text-[10px] font-semibold transition",
            canExpand
              ? "border-zinc-700 text-zinc-400 hover:bg-zinc-900 dark:border-zinc-300 dark:text-zinc-600 dark:hover:bg-zinc-200"
              : "border-transparent text-transparent",
          )}
        >
          {canExpand ? (isExpanded ? "-" : "+") : "+"}
        </button>
      </div>

      {isExpanded ? (
        <>
          {files.map((file) => (
            <button
              key={file.id}
              type="button"
              onClick={(event) => onSelectFile(event, file)}
              onContextMenu={(event) => onContextMenuFile(event, file)}
              className={classNames(
                "flex w-full items-center gap-2 rounded-lg px-2 py-0.5 text-left transition",
                activeFileId === file.id
                  ? "bg-zinc-900/90 text-white dark:bg-zinc-100 dark:text-zinc-950"
                  : selectedItemIds.has(file.id)
                    ? "bg-zinc-200 text-zinc-950 dark:bg-zinc-800 dark:text-zinc-50"
                    : "hover:bg-zinc-100 dark:hover:bg-zinc-900",
              )}
              data-tree-key={`file:${file.id}`}
              style={{ paddingLeft: `${28 + node.depth * 12}px` }}
            >
              <div className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded border border-zinc-800 bg-zinc-950 text-[8px] font-semibold text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
                {file.kind === "image" ? (
                  <img
                    src={assetUrl(file.path)}
                    alt={file.name}
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                ) : file.kind === "video" ? (
                  "VID"
                ) : (
                  "FIL"
                )}
              </div>
              <div className="min-w-0 flex-1 truncate text-[10px]">
                {file.name}
                <span className="ml-1 text-[9px] text-zinc-500 dark:text-zinc-400">
                  {file.ext}
                </span>
              </div>
            </button>
          ))}

          {node.children.map((childPath) => (
            <FolderTreeBranch
              key={childPath}
              nodePath={childPath}
              nodes={nodes}
              selectedPath={selectedPath}
              rootLabel={rootLabel}
              expandedPaths={expandedPaths}
              folderFiles={folderFiles}
              activeFileId={activeFileId}
              selectedItemIds={selectedItemIds}
              onSelect={onSelect}
              onToggle={onToggle}
              onSelectFile={onSelectFile}
              onContextMenuFolder={onContextMenuFolder}
              onContextMenuFile={onContextMenuFile}
            />
          ))}
        </>
      ) : null}
    </div>
  );
});
