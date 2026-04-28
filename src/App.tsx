import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import {
  memo,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type MediaKind = "image" | "video";
type SortKey = "name" | "date" | "size";
type PaneKey = "folders" | "files" | "preview";
type TreeVisibleEntry =
  | {
      type: "folder";
      key: string;
      path: string;
      depth: number;
      canExpand: boolean;
      isExpanded: boolean;
    }
  | {
      type: "file";
      key: string;
      id: string;
      path: string;
      parentPath: string;
      depth: number;
    };

type ExplorerSelection =
  | {
      type: "folder";
      path: string;
    }
  | {
      type: "file";
      id: string;
      parentPath: string;
    };

type MediaItem = {
  id: string;
  kind: MediaKind;
  name: string;
  path: string;
  relativePath: string;
  ext: string;
  sizeBytes: number;
  modifiedMs: number;
};

type ScanResult = {
  rootPath: string;
  rootName: string;
  items: MediaItem[];
};

type FolderTreeNode = {
  path: string;
  name: string;
  depth: number;
  itemCount: number;
  coverPath: string | null;
  children: string[];
};

const LIST_OVERSCAN = 6;
const LIST_ITEM_HEIGHT = 62;
const IMAGE_ZOOM_MIN = 0.5;
const IMAGE_ZOOM_MAX = 6;
const IMAGE_ZOOM_STEP = 0.2;
const DEFAULT_FOLDER_WIDTH = 276;
const DEFAULT_FILE_WIDTH = 360;
const MIN_FOLDER_WIDTH = 220;
const MAX_FOLDER_WIDTH = 460;
const MIN_FILE_WIDTH = 280;
const MAX_FILE_WIDTH = 680;
const NATURAL_NAME_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function formatBytes(bytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDate(ms: number) {
  return new Date(ms).toLocaleString();
}

function classNames(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function assetUrl(path: string) {
  return convertFileSrc(path);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function parentFolderPath(relativePath: string) {
  const slashIndex = relativePath.lastIndexOf("/");
  return slashIndex >= 0 ? relativePath.slice(0, slashIndex) : "";
}

function folderLabel(path: string, fallback: string) {
  if (!path) return fallback;
  const segments = path.split("/");
  return segments[segments.length - 1] || fallback;
}

function compareNaturalText(a: string, b: string) {
  return NATURAL_NAME_COLLATOR.compare(a, b);
}

function buildVisibleTreeEntries(
  nodePath: string,
  nodes: Map<string, FolderTreeNode>,
  expandedPaths: Set<string>,
  folderFiles: Map<string, MediaItem[]>,
  depth = 0,
): TreeVisibleEntry[] {
  const node = nodes.get(nodePath);
  if (!node) return [];

  const files = folderFiles.get(node.path) ?? [];
  const canExpand = node.children.length > 0 || files.length > 0;
  const isExpanded = expandedPaths.has(node.path);
  const entries: TreeVisibleEntry[] = [
    {
      type: "folder",
      key: `folder:${node.path}`,
      path: node.path,
      depth,
      canExpand,
      isExpanded,
    },
  ];

  if (!isExpanded) {
    return entries;
  }

  for (const file of files) {
    entries.push({
      type: "file",
      key: `file:${file.id}`,
      id: file.id,
      path: file.path,
      parentPath: node.path,
      depth: depth + 1,
    });
  }

  for (const childPath of node.children) {
    entries.push(
      ...buildVisibleTreeEntries(childPath, nodes, expandedPaths, folderFiles, depth + 1),
    );
  }

  return entries;
}

const VideoThumb = memo(function VideoThumb({
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

const MediaListRow = memo(function MediaListRow({
  item,
  isActive,
  itemHeight,
  onSelect,
  onContextMenu,
}: {
  item: MediaItem;
  isActive: boolean;
  itemHeight: number;
  onSelect: (id: string) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLButtonElement>, item: MediaItem) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      onContextMenu={(event) => onContextMenu(event, item)}
      className={classNames(
        "flex w-full items-center gap-2 rounded-xl border px-2 py-1 text-left transition",
        isActive
          ? "border-zinc-950 bg-zinc-950 text-white dark:border-white dark:bg-white dark:text-zinc-950"
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

const FolderTreeBranch = memo(function FolderTreeBranch({
  nodePath,
  nodes,
  selectedPath,
  rootLabel,
  expandedPaths,
  folderFiles,
  activeFileId,
  onSelect,
  onToggle,
  onSelectFile,
  onContextMenuFile,
}: {
  nodePath: string;
  nodes: Map<string, FolderTreeNode>;
  selectedPath: string;
  rootLabel: string;
  expandedPaths: Set<string>;
  folderFiles: Map<string, MediaItem[]>;
  activeFileId: string | null;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
  onSelectFile: (item: MediaItem) => void;
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
              onClick={() => onSelectFile(file)}
              onContextMenu={(event) => onContextMenuFile(event, file)}
              className={classNames(
                "flex w-full items-center gap-2 rounded-lg px-2 py-0.5 text-left transition",
                activeFileId === file.id
                  ? "bg-zinc-900/90 text-white dark:bg-zinc-100 dark:text-zinc-950"
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
              onSelect={onSelect}
              onToggle={onToggle}
              onSelectFile={onSelectFile}
              onContextMenuFile={onContextMenuFile}
            />
          ))}
        </>
      ) : null}
    </div>
  );
});

function App() {
  const [kindFilter, setKindFilter] = useState<"all" | MediaKind>("all");
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [videoMuted, setVideoMuted] = useState(true);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [rootFolderName, setRootFolderName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [viewerExpanded, setViewerExpanded] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [showFolders, setShowFolders] = useState(true);
  const [showFiles, setShowFiles] = useState(false);
  const [showPreview, setShowPreview] = useState(true);
  const [folderWidth, setFolderWidth] = useState(DEFAULT_FOLDER_WIDTH);
  const [fileWidth, setFileWidth] = useState(DEFAULT_FILE_WIDTH);
  const [expandedFolderPaths, setExpandedFolderPaths] = useState<Set<string>>(new Set([""]));
  const [selectedFolderPath, setSelectedFolderPath] = useState("");
  const [explorerSelection, setExplorerSelection] = useState<ExplorerSelection>({
    type: "folder",
    path: "",
  });
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [imageZoom, setImageZoom] = useState(1);
  const [imageOffset, setImageOffset] = useState({ x: 0, y: 0 });
  const [isDraggingImage, setIsDraggingImage] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    itemId: string;
  } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const explorerRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const resizeStateRef = useRef<{
    pane: "folders" | "files";
    startX: number;
    startWidth: number;
  } | null>(null);

  const deferredQuery = useDeferredValue(query);

  const treeSourceItems = useMemo(
    () => (kindFilter === "all" ? items : items.filter((item) => item.kind === kindFilter)),
    [items, kindFilter],
  );

  const folderTree = useMemo(() => {
    const nodes = new Map<string, FolderTreeNode>();
    nodes.set("", {
      path: "",
      name: rootFolderName || "Root",
      depth: 0,
      itemCount: 0,
      coverPath: null,
      children: [],
    });

    for (const item of treeSourceItems) {
      const parentPath = parentFolderPath(item.relativePath);
      const segments = parentPath ? parentPath.split("/") : [];
      let currentPath = "";

      nodes.get("")!.itemCount += 1;

      for (const segment of segments) {
        const nextPath = currentPath ? `${currentPath}/${segment}` : segment;
        if (!nodes.has(nextPath)) {
          nodes.set(nextPath, {
            path: nextPath,
            name: segment,
            depth: nextPath.split("/").length,
            itemCount: 0,
            coverPath: null,
            children: [],
          });
        }

        const parentNode = nodes.get(currentPath);
        if (parentNode && !parentNode.children.includes(nextPath)) {
          parentNode.children.push(nextPath);
        }

        nodes.get(nextPath)!.itemCount += 1;
        currentPath = nextPath;
      }

      if (
        item.kind === "image" &&
        !parentPath &&
        rootFolderName &&
        !nodes.get("")?.coverPath &&
        item.name.toLowerCase() === rootFolderName.toLowerCase()
      ) {
        nodes.get("")!.coverPath = item.path;
      }

      if (item.kind === "image" && parentPath) {
        const folderNode = nodes.get(parentPath);
        if (
          folderNode &&
          !folderNode.coverPath &&
          item.name.toLowerCase() === folderNode.name.toLowerCase()
        ) {
          folderNode.coverPath = item.path;
        }
      }
    }

    for (const node of nodes.values()) {
      node.children.sort((a, b) => {
        const aNode = nodes.get(a);
        const bNode = nodes.get(b);
        return (aNode?.name ?? "").localeCompare(bNode?.name ?? "");
      });
    }

    return nodes;
  }, [rootFolderName, treeSourceItems]);

  const selectedFolderNode = folderTree.get(selectedFolderPath) ?? folderTree.get("");

  function handleFolderSelect(path: string) {
    setSelectedFolderPath(path);
    setExplorerSelection({ type: "folder", path });
    const node = folderTree.get(path);
    if (!node?.coverPath) {
      setActiveId(null);
      return;
    }

    const coverItem = items.find((item) => item.path === node.coverPath) ?? null;
    setActiveId(coverItem?.id ?? null);
  }

  const filtered = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLowerCase();
    return items
      .filter((item) =>
        selectedFolderPath ? item.relativePath.startsWith(`${selectedFolderPath}/`) : true,
      )
      .filter((item) => (kindFilter === "all" ? true : item.kind === kindFilter))
      .filter((item) => {
        if (!normalizedQuery) return true;
        return (
          item.name.toLowerCase().includes(normalizedQuery) ||
          item.relativePath.toLowerCase().includes(normalizedQuery)
        );
      });
  }, [items, selectedFolderPath, kindFilter, deferredQuery]);

  const treeFilteredItems = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLowerCase();
    return items
      .filter((item) => (kindFilter === "all" ? true : item.kind === kindFilter))
      .filter((item) => {
        if (!normalizedQuery) return true;
        return (
          item.name.toLowerCase().includes(normalizedQuery) ||
          item.relativePath.toLowerCase().includes(normalizedQuery)
        );
      });
  }, [items, kindFilter, deferredQuery]);

  const sorted = useMemo(() => {
    const next = [...filtered];
    next.sort((a, b) => {
      switch (sortKey) {
        case "name":
          return compareNaturalText(a.name, b.name) || compareNaturalText(a.ext, b.ext);
        case "size":
          return b.sizeBytes - a.sizeBytes;
        case "date":
        default:
          return b.modifiedMs - a.modifiedMs;
      }
    });
    return next;
  }, [filtered, sortKey]);

  const sortedTreeItems = useMemo(() => {
    const next = [...treeFilteredItems];
    next.sort((a, b) => {
      switch (sortKey) {
        case "name":
          return compareNaturalText(a.name, b.name) || compareNaturalText(a.ext, b.ext);
        case "size":
          return b.sizeBytes - a.sizeBytes;
        case "date":
        default:
          return b.modifiedMs - a.modifiedMs;
      }
    });
    return next;
  }, [treeFilteredItems, sortKey]);

  const filesByFolder = useMemo(() => {
    const next = new Map<string, MediaItem[]>();
    for (const item of sortedTreeItems) {
      const folderPath = parentFolderPath(item.relativePath);
      const bucket = next.get(folderPath) ?? [];
      bucket.push(item);
      next.set(folderPath, bucket);
    }
    return next;
  }, [sortedTreeItems]);

  const active = useMemo(
    () => (activeId ? items.find((item) => item.id === activeId) ?? null : null),
    [items, activeId],
  );
  const activeName = active ? active.name + active.ext : "Select a file";
  const activeLocation = active
    ? active.relativePath
    : selectedFolderPath
      ? `Showing ${selectedFolderPath}`
      : "Choose a folder to start browsing.";
  const currentFolderLabel = selectedFolderPath
    ? folderLabel(selectedFolderPath, rootFolderName || "Root")
    : rootFolderName || "Root";

  const previewSourceUrl = useMemo(
    () => (active ? assetUrl(active.path) : ""),
    [active?.path],
  );

  useEffect(() => {
    setRenameValue(active?.name ?? "");
  }, [active?.id, active?.name]);

  useEffect(() => {
    setContextMenu(null);
  }, [active?.id, deferredQuery, kindFilter, selectedFolderPath, sortKey]);

  useEffect(() => {
    const node = listRef.current;
    if (!node) return;

    const updateHeight = () => setViewportHeight(node.clientHeight);
    updateHeight();

    const observer = new ResizeObserver(updateHeight);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const node = listRef.current;
    if (!node || !activeId) return;
    const index = sorted.findIndex((item) => item.id === activeId);
    if (index < 0) return;

    const top = index * LIST_ITEM_HEIGHT;
    const bottom = top + LIST_ITEM_HEIGHT;
    const viewTop = node.scrollTop;
    const viewBottom = viewTop + node.clientHeight;

    if (top < viewTop) {
      node.scrollTo({ top });
    } else if (bottom > viewBottom) {
      node.scrollTo({ top: bottom - node.clientHeight });
    }
  }, [activeId, sorted]);

  useEffect(() => {
    if (!viewerExpanded || active?.kind !== "image") {
      setImageZoom(1);
      setImageOffset({ x: 0, y: 0 });
      setIsDraggingImage(false);
      dragStateRef.current = null;
    }
  }, [viewerExpanded, active?.id, active?.kind]);

  useEffect(() => {
    setSelectedFolderPath("");
    setExplorerSelection({ type: "folder", path: "" });
    setExpandedFolderPaths(new Set([""]));
  }, [rootPath]);

  useEffect(() => {
    if (!sorted.length) {
      setActiveId(null);
      return;
    }
    if (showFiles && (!activeId || !sorted.some((item) => item.id === activeId))) {
      setActiveId(sorted[0].id);
    }
  }, [activeId, showFiles, sorted]);

  async function loadFolder(root: string, preferredPath?: string | null) {
    setIsLoading(true);
    setErrorMessage("");

    try {
      const result = await invoke<ScanResult>("scan_media_folder", {
        rootPath: root,
      });
      setItems(result.items);
      setRootFolderName(result.rootName);
      setRootPath(result.rootPath);
      setSelectedFolderPath("");
      setExplorerSelection({ type: "folder", path: "" });

      const preferred = preferredPath
        ? result.items.find((item) => item.path === preferredPath)
        : null;
      const fallback =
        activeId && !preferredPath
          ? result.items.find((item) => item.id === activeId)
          : null;
      setActiveId(preferred?.id ?? fallback?.id ?? result.items[0]?.id ?? null);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to scan the selected folder.",
      );
    } finally {
      setIsLoading(false);
    }
  }

  async function handlePickRootFolder() {
    setErrorMessage("");
    try {
      const selectedRoot = await invoke<string | null>("pick_root_folder");
      if (!selectedRoot) return;
      await loadFolder(selectedRoot);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to open the folder picker.",
      );
    }
  }

  async function handleRename() {
    if (!active || !rootPath) return;
    setIsSaving(true);
    setErrorMessage("");

    try {
      const renamedPath = await invoke<string>("rename_media_file", {
        filePath: active.path,
        newName: renameValue,
      });
      setRenameOpen(false);
      await loadFolder(rootPath, renamedPath);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to rename the selected file.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteItem(item: MediaItem) {
    if (!rootPath) return;
    const confirmed = window.confirm(`Delete "${item.name + item.ext}"?`);
    if (!confirmed) return;

    setIsSaving(true);
    setErrorMessage("");

    try {
      await invoke("delete_media_file", {
        filePath: item.path,
      });
      setInfoOpen(false);
      await loadFolder(rootPath);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to delete the selected file.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  function selectNext(delta: -1 | 1) {
    if (!active) return;
    const index = sorted.findIndex((item) => item.id === active.id);
    if (index < 0) return;
    const next = sorted[Math.max(0, Math.min(sorted.length - 1, index + delta))];
    setActiveId(next.id);
  }

  function applyImageZoom(nextZoom: number) {
    const clampedZoom = clamp(nextZoom, IMAGE_ZOOM_MIN, IMAGE_ZOOM_MAX);
    setImageZoom(clampedZoom);
    if (clampedZoom <= 1) {
      setImageOffset({ x: 0, y: 0 });
    }
  }

  function handleExpandedImageWheel(event: ReactWheelEvent<HTMLDivElement>) {
    if (!viewerExpanded || active?.kind !== "image") return;
    event.preventDefault();
    const direction = event.deltaY < 0 ? 1 : -1;
    applyImageZoom(imageZoom + direction * IMAGE_ZOOM_STEP);
  }

  function handleExpandedImageMouseDown(event: ReactMouseEvent<HTMLImageElement>) {
    if (!viewerExpanded || active?.kind !== "image" || imageZoom <= 1) return;
    event.preventDefault();
    setIsDraggingImage(true);
    dragStateRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: imageOffset.x,
      originY: imageOffset.y,
    };
  }

  function resetExpandedImageView() {
    setImageZoom(1);
    setImageOffset({ x: 0, y: 0 });
  }

  function openRenameForItem(item: MediaItem) {
    setActiveId(item.id);
    setRenameValue(item.name);
    setRenameOpen(true);
    setContextMenu(null);
  }

  const isSearchMode = deferredQuery.trim().length > 0;

  const visibleTreeEntries = useMemo(() => {
    if (isSearchMode) {
      return sortedTreeItems.map(
        (item, index) =>
          ({
            type: "file",
            key: `search-file:${item.id}:${index}`,
            id: item.id,
            path: item.path,
            parentPath: parentFolderPath(item.relativePath),
            depth: 0,
          }) satisfies TreeVisibleEntry,
      );
    }

    return buildVisibleTreeEntries("", folderTree, expandedFolderPaths, filesByFolder);
  }, [expandedFolderPaths, filesByFolder, folderTree, isSearchMode, sortedTreeItems]);

  function toggleFolderExpanded(path: string) {
    setExpandedFolderPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  function togglePane(pane: PaneKey) {
    const next = {
      folders: showFolders,
      files: showFiles,
      preview: showPreview,
      [pane]: !(
        pane === "folders" ? showFolders : pane === "files" ? showFiles : showPreview
      ),
    };

    if (!next.folders && !next.files && !next.preview) {
      return;
    }

    setShowFolders(next.folders);
    setShowFiles(next.files);
    setShowPreview(next.preview);
  }

  function resetLayout() {
    setShowFolders(true);
    setShowFiles(false);
    setShowPreview(true);
    setFolderWidth(DEFAULT_FOLDER_WIDTH);
    setFileWidth(DEFAULT_FILE_WIDTH);
  }

  function startResize(
    pane: "folders" | "files",
    event: ReactMouseEvent<HTMLDivElement>,
  ) {
    event.preventDefault();
    resizeStateRef.current = {
      pane,
      startX: event.clientX,
      startWidth: pane === "folders" ? folderWidth : fileWidth,
    };
  }

  function handleRowContextMenu(event: ReactMouseEvent<HTMLButtonElement>, item: MediaItem) {
    event.preventDefault();
    setActiveId(item.id);
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      itemId: item.id,
    });
  }

  function handleTreeFileSelect(item: MediaItem) {
    const parentPath = parentFolderPath(item.relativePath);
    setSelectedFolderPath(parentPath);
    setExplorerSelection({
      type: "file",
      id: item.id,
      parentPath,
    });
    setActiveId(item.id);
  }

  function moveTreeSelection(delta: -1 | 1) {
    if (!visibleTreeEntries.length) return;

    const currentIndex =
      explorerSelection.type === "file"
        ? visibleTreeEntries.findIndex(
            (entry) => entry.type === "file" && entry.id === explorerSelection.id,
          )
        : visibleTreeEntries.findIndex(
            (entry) => entry.type === "folder" && entry.path === explorerSelection.path,
          );

    const baseIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = Math.max(0, Math.min(visibleTreeEntries.length - 1, baseIndex + delta));
    const entry = visibleTreeEntries[nextIndex];
    if (!entry) return;

    if (entry.type === "folder") {
      handleFolderSelect(entry.path);
      return;
    }

    const item = items.find((candidate) => candidate.id === entry.id);
    if (item) {
      handleTreeFileSelect(item);
    }
  }

  function openSelectedFolder() {
    const selectedFolderEntry =
      explorerSelection.type === "file"
        ? visibleTreeEntries.find(
            (entry) =>
              entry.type === "folder" && entry.path === explorerSelection.parentPath,
          )
        : visibleTreeEntries.find(
            (entry) => entry.type === "folder" && entry.path === explorerSelection.path,
          );

    if (
      selectedFolderEntry &&
      selectedFolderEntry.type === "folder" &&
      selectedFolderEntry.canExpand &&
      !selectedFolderEntry.isExpanded
    ) {
      toggleFolderExpanded(selectedFolderEntry.path);
      return;
    }

    if (explorerSelection.type === "file") {
      return;
    }

    if (
      selectedFolderEntry &&
      selectedFolderEntry.type === "folder" &&
      selectedFolderEntry.isExpanded
    ) {
      const nextEntryIndex = visibleTreeEntries.findIndex(
        (entry) => entry.type === "folder" && entry.path === selectedFolderEntry.path,
      );
      const nextEntry = visibleTreeEntries[nextEntryIndex + 1];
      if (!nextEntry) return;

      if (nextEntry.type === "folder") {
        handleFolderSelect(nextEntry.path);
        return;
      }

      const item = items.find((candidate) => candidate.id === nextEntry.id);
      if (item) {
        handleTreeFileSelect(item);
      }
    }
  }

  function closeSelectedFolder() {
    if (explorerSelection.type === "file") {
      handleFolderSelect(explorerSelection.parentPath);
      return;
    }

    const selectedFolderEntry = visibleTreeEntries.find(
      (entry) => entry.type === "folder" && entry.path === explorerSelection.path,
    );

    if (!selectedFolderEntry || selectedFolderEntry.type !== "folder") return;

    if (selectedFolderEntry.isExpanded) {
      toggleFolderExpanded(selectedFolderEntry.path);
      return;
    }

    handleFolderSelect(parentFolderPath(selectedFolderEntry.path));
  }

  const previewContent = active ? (
    active.kind === "image" ? (
      <img
        src={previewSourceUrl}
        alt={active.name}
        className="max-h-full max-w-full object-contain"
      />
    ) : (
      <video
        src={previewSourceUrl}
        className="h-full w-full object-contain"
        controls
        autoPlay
        muted={videoMuted}
        preload="metadata"
      />
    )
  ) : (
    <div className="text-center text-zinc-400">
      <div className="text-lg font-semibold">Nothing selected</div>
      <div className="mt-2 text-sm">
        Pick a root folder and choose a file from the list.
      </div>
    </div>
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (contextMenu) {
          event.preventDefault();
          setContextMenu(null);
          return;
        }
        if (renameOpen) {
          event.preventDefault();
          setRenameOpen(false);
          return;
        }
        if (infoOpen) {
          event.preventDefault();
          setInfoOpen(false);
          return;
        }
        if (viewerExpanded) {
          event.preventDefault();
          setViewerExpanded(false);
          return;
        }
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        moveTreeSelection(-1);
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveTreeSelection(1);
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        closeSelectedFolder();
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        openSelectedFolder();
      }
      if (viewerExpanded && active?.kind === "image") {
        if (event.key === "+" || event.key === "=") {
          event.preventDefault();
          applyImageZoom(imageZoom + IMAGE_ZOOM_STEP);
        }
        if (event.key === "-") {
          event.preventDefault();
          applyImageZoom(imageZoom - IMAGE_ZOOM_STEP);
        }
        if (event.key === "0") {
          event.preventDefault();
          resetExpandedImageView();
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    active,
    contextMenu,
    explorerSelection,
    imageZoom,
    infoOpen,
    items,
    renameOpen,
    selectedFolderPath,
    viewerExpanded,
    visibleTreeEntries,
  ]);

  useEffect(() => {
    if (!isDraggingImage) return;

    function onMouseMove(event: MouseEvent) {
      const state = dragStateRef.current;
      if (!state) return;
      setImageOffset({
        x: state.originX + event.clientX - state.startX,
        y: state.originY + event.clientY - state.startY,
      });
    }

    function onMouseUp() {
      setIsDraggingImage(false);
      dragStateRef.current = null;
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [isDraggingImage]);

  useEffect(() => {
    function onMouseMove(event: MouseEvent) {
      const state = resizeStateRef.current;
      if (!state) return;

      const deltaX = event.clientX - state.startX;
      if (state.pane === "folders") {
        setFolderWidth(clamp(state.startWidth + deltaX, MIN_FOLDER_WIDTH, MAX_FOLDER_WIDTH));
        return;
      }

      setFileWidth(clamp(state.startWidth + deltaX, MIN_FILE_WIDTH, MAX_FILE_WIDTH));
    }

    function onMouseUp() {
      resizeStateRef.current = null;
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [folderWidth, fileWidth]);

  useEffect(() => {
    if (!contextMenu) return;

    function closeContextMenu() {
      setContextMenu(null);
    }

    window.addEventListener("click", closeContextMenu);
    window.addEventListener("scroll", closeContextMenu, true);
    window.addEventListener("resize", closeContextMenu);
    return () => {
      window.removeEventListener("click", closeContextMenu);
      window.removeEventListener("scroll", closeContextMenu, true);
      window.removeEventListener("resize", closeContextMenu);
    };
  }, [contextMenu]);

  const totalHeight = sorted.length * LIST_ITEM_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollTop / LIST_ITEM_HEIGHT) - LIST_OVERSCAN);
  const visibleCount = Math.ceil((viewportHeight || 0) / LIST_ITEM_HEIGHT) + LIST_OVERSCAN * 2;
  const endIndex = Math.min(sorted.length, startIndex + visibleCount);
  const visibleItems = sorted.slice(startIndex, endIndex);
  const contextMenuItem = contextMenu
    ? sorted.find((item) => item.id === contextMenu.itemId) ?? null
    : null;
  const selectedExplorerKey =
    explorerSelection.type === "file"
      ? `file:${explorerSelection.id}`
      : `folder:${explorerSelection.path}`;

  useEffect(() => {
    const container = explorerRef.current;
    if (!container || !selectedExplorerKey) return;
    const target = container.querySelector<HTMLElement>(
      `[data-tree-key="${selectedExplorerKey}"]`,
    );
    target?.scrollIntoView({ block: "nearest" });
  }, [selectedExplorerKey, visibleTreeEntries]);

  return (
    <div className="dark h-dvh w-dvw overflow-hidden bg-zinc-100 text-[12px] text-zinc-950 dark:bg-[#0d0d10] dark:text-zinc-50">
      <div className="absolute right-3 top-3 z-30 flex items-center gap-2 rounded-xl border border-zinc-800 bg-[#121217]/92 p-1.5 shadow-lg backdrop-blur">
        <div className="px-1 text-[9px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
          Layout
        </div>
        {(
          [
            ["folders", "Folders", showFolders],
            ["preview", "Preview", showPreview],
          ] as const
        ).map(([pane, label, visible]) => (
          <button
            key={pane}
            type="button"
            onClick={() => togglePane(pane)}
            className={classNames(
              "rounded-md px-2 py-1 text-[10px] transition",
              visible
                ? "bg-white text-zinc-950"
                : "border border-zinc-800 bg-zinc-950 text-zinc-300 hover:bg-zinc-900",
            )}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          onClick={resetLayout}
          className="rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[10px] text-zinc-300 hover:bg-zinc-900"
        >
          Reset
        </button>
      </div>

      <div className="flex h-full w-full">
        {showFolders ? (
        <aside
          className="flex min-h-0 shrink-0 flex-col border-r border-zinc-200 bg-white/90 dark:border-zinc-800 dark:bg-[#121217]"
          style={{ width: `${folderWidth}px` }}
        >
          <div className="shrink-0 border-b border-zinc-200 p-3 dark:border-zinc-800">
            <div className="flex items-center gap-2">
              <div className="shrink-0 text-[14px] font-semibold">Media Vault</div>
              <div className="min-w-0 truncate text-[10px] text-zinc-500 dark:text-zinc-400">
                {rootFolderName || "No folder"}{rootPath ? ` / ${rootPath}` : ""}
              </div>
            </div>

            <button
              className="mt-3 w-full rounded-lg bg-zinc-950 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-zinc-800 disabled:cursor-wait disabled:opacity-70 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
              type="button"
              onClick={handlePickRootFolder}
              disabled={isLoading || isSaving}
            >
              {isLoading ? "Scanning..." : "Choose Folder"}
            </button>

          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3 pt-2">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search files"
              className="shrink-0 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-[12px] outline-none placeholder:text-zinc-500 focus:border-zinc-600"
            />

            <div className="mt-2.5 flex shrink-0 items-center gap-2">
              {(
                [
                  ["all", "All"],
                  ["image", "Images"],
                  ["video", "Videos"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setKindFilter(key)}
                  className={classNames(
                    "rounded-md px-2.5 py-1 text-[10px]",
                    kindFilter === key
                      ? "bg-white text-zinc-950"
                      : "border border-zinc-800 bg-zinc-950 hover:bg-zinc-900",
                  )}
                >
                  {label}
                </button>
              ))}

              <select
                className="ml-auto rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[10px]"
                value={sortKey}
                onChange={(event) => setSortKey(event.target.value as SortKey)}
              >
                <option value="date">Date</option>
                <option value="name">Name</option>
                <option value="size">Size</option>
              </select>
            </div>

            <div className="mt-2.5 flex min-h-0 flex-1 flex-col rounded-xl border border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-800 dark:bg-zinc-950/60">
              <div className="flex shrink-0 items-center justify-between gap-3">
                <div className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  {isSearchMode ? "Results" : "Explorer"}
                </div>
                <div className="text-[9px] text-zinc-500 dark:text-zinc-400">
                  {isSearchMode ? sortedTreeItems.length : selectedFolderNode?.itemCount ?? 0}
                </div>
              </div>
              <div ref={explorerRef} className="mt-2 min-h-0 flex-1 overflow-auto">
                {isSearchMode ? (
                  <div className="space-y-1">
                    {sortedTreeItems.map((item) => (
                      <div key={item.id} data-tree-key={`file:${item.id}`}>
                        <MediaListRow
                          item={item}
                          isActive={
                            explorerSelection.type === "file" &&
                            item.id === explorerSelection.id
                          }
                          itemHeight={LIST_ITEM_HEIGHT}
                          onSelect={() => handleTreeFileSelect(item)}
                          onContextMenu={handleRowContextMenu}
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <FolderTreeBranch
                    nodePath=""
                    nodes={folderTree}
                    selectedPath={
                      explorerSelection.type === "folder" ? explorerSelection.path : "__none__"
                    }
                    rootLabel={rootFolderName || "Root"}
                    expandedPaths={expandedFolderPaths}
                    folderFiles={filesByFolder}
                    activeFileId={
                      explorerSelection.type === "file" ? explorerSelection.id : null
                    }
                    onSelect={handleFolderSelect}
                    onToggle={toggleFolderExpanded}
                    onSelectFile={handleTreeFileSelect}
                    onContextMenuFile={handleRowContextMenu}
                  />
                )}
              </div>
            </div>
          </div>
        </aside>
        ) : null}

        {showFolders && (showFiles || showPreview) ? (
          <div
            role="separator"
            aria-orientation="vertical"
            className="group relative -ml-1 mr-[-1px] w-2 shrink-0 cursor-col-resize bg-transparent"
            onMouseDown={(event) => startResize("folders", event)}
          >
            <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-zinc-800/80 transition group-hover:bg-zinc-500" />
          </div>
        ) : null}

        {showFiles ? (
        <section
          className="flex min-h-0 shrink-0 flex-col border-r border-zinc-200 bg-[#101015] dark:border-zinc-800"
          style={{ width: showPreview ? `${fileWidth}px` : undefined, flex: showPreview ? undefined : 1 }}
        >
          <div className="border-b border-zinc-200 px-3 py-2.5 dark:border-zinc-800">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[9px] uppercase tracking-[0.2em] text-zinc-500 dark:text-zinc-400">
                  Files
                </div>
                <div className="mt-1 truncate text-[14px] font-semibold">
                  {currentFolderLabel}
                </div>
              </div>
              <div className="text-[10px] text-zinc-500 dark:text-zinc-400">
                {sorted.length}
              </div>
            </div>
            <div className="mt-1.5 text-[9px] text-zinc-500 dark:text-zinc-400">
              Tree for browsing, list for bulk scanning.
            </div>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search files"
              className="mt-2.5 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-[12px] outline-none placeholder:text-zinc-500 focus:border-zinc-600"
            />
            <div className="mt-2.5 flex items-center gap-2">
              {(
                [
                  ["all", "All"],
                  ["image", "Images"],
                  ["video", "Videos"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setKindFilter(key)}
                  className={classNames(
                    "rounded-md px-2.5 py-1 text-[10px]",
                    kindFilter === key
                      ? "bg-white text-zinc-950"
                      : "border border-zinc-800 bg-zinc-950 hover:bg-zinc-900",
                  )}
                >
                  {label}
                </button>
              ))}

              <select
                className="ml-auto rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[10px]"
                value={sortKey}
                onChange={(event) => setSortKey(event.target.value as SortKey)}
              >
                <option value="date">Date</option>
                <option value="name">Name</option>
                <option value="size">Size</option>
              </select>
            </div>
          </div>
          <div
            ref={listRef}
            className="min-h-0 flex-1 overflow-auto p-1.5"
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          >
            <div className="relative" style={{ height: `${totalHeight}px` }}>
              {visibleItems.map((item, index) => {
                const actualIndex = startIndex + index;
                return (
                  <div
                    key={item.id}
                    className="absolute left-0 right-0"
                    style={{
                      top: `${actualIndex * LIST_ITEM_HEIGHT}px`,
                      height: `${LIST_ITEM_HEIGHT}px`,
                    }}
                  >
                    <MediaListRow
                      item={item}
                      isActive={item.id === active?.id}
                      itemHeight={LIST_ITEM_HEIGHT}
                      onSelect={setActiveId}
                      onContextMenu={handleRowContextMenu}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </section>
        ) : null}

        {showFiles && showPreview ? (
          <div
            role="separator"
            aria-orientation="vertical"
            className="group relative -ml-1 mr-[-1px] w-2 shrink-0 cursor-col-resize bg-transparent"
            onMouseDown={(event) => startResize("files", event)}
          >
            <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-zinc-800/80 transition group-hover:bg-zinc-500" />
          </div>
        ) : null}

        {showPreview ? (
        <main className="flex min-h-0 flex-1 flex-col bg-zinc-200/40 dark:bg-[#0b0b0d]">
          <div className="border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
            <div className="text-[9px] uppercase tracking-[0.2em] text-zinc-500 dark:text-zinc-400">
              Preview
            </div>
            <div className="mt-1 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="truncate text-[14px] font-semibold">
                  {activeName}
                </div>
                <div className="mt-0.5 truncate text-[10px] text-zinc-500 dark:text-zinc-400">
                  {activeLocation}
                </div>
              </div>
              {active ? (
                <div className="flex shrink-0 items-center gap-2">
                  <div className="rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-[10px] dark:border-zinc-800 dark:bg-zinc-950">
                    {active.kind === "video" ? "Video" : "Image"}
                  </div>
                  <button
                    type="button"
                    onClick={() => setInfoOpen(true)}
                    className="rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-[10px] hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900"
                  >
                    Info
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewerExpanded(true)}
                    className="rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-[10px] hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900"
                  >
                    Expand
                  </button>
                </div>
              ) : null}
            </div>
          </div>

          <div className="min-h-0 flex-1 p-2">
            <div className="relative h-full">
              <div
                className="flex h-full items-center justify-center overflow-hidden rounded-3xl border border-zinc-200 bg-black shadow-sm dark:border-zinc-800"
                onDoubleClick={() => active && setViewerExpanded(true)}
              >
                {previewContent}
              </div>

              {active ? (
                <>
                  <button
                    type="button"
                    onClick={() => selectNext(-1)}
                    className="absolute left-3 top-1/2 z-10 -translate-y-1/2 rounded-full border border-zinc-700 bg-black/70 px-3 py-1.5 text-base font-semibold text-white hover:bg-black/85"
                    aria-label="Previous item"
                  >
                    &lt;
                  </button>
                  <button
                    type="button"
                    onClick={() => selectNext(1)}
                    className="absolute right-3 top-1/2 z-10 -translate-y-1/2 rounded-full border border-zinc-700 bg-black/70 px-3 py-1.5 text-base font-semibold text-white hover:bg-black/85"
                    aria-label="Next item"
                  >
                    &gt;
                  </button>
                </>
              ) : null}
            </div>
          </div>
        </main>
        ) : null}
      </div>

      {errorMessage ? (
        <div className="pointer-events-none fixed bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-xl border border-red-900/70 bg-red-950/90 px-4 py-3 text-[13px] text-red-100 shadow-lg">
          {errorMessage}
        </div>
      ) : null}

      {contextMenu && contextMenuItem ? (
        <div
          className="fixed z-40 min-w-40 rounded-xl border border-zinc-800 bg-[#121217] p-1.5 shadow-2xl"
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
        >
          <button
            type="button"
            onClick={() => openRenameForItem(contextMenuItem)}
            className="flex w-full rounded-lg px-3 py-2 text-left text-[12px] hover:bg-zinc-900"
          >
            Rename
          </button>
          <button
            type="button"
            onClick={() => {
              setContextMenu(null);
              setActiveId(contextMenuItem.id);
              void deleteItem(contextMenuItem);
            }}
            className="flex w-full rounded-lg px-3 py-2 text-left text-[12px] text-red-300 hover:bg-red-950/50"
          >
            Delete
          </button>
        </div>
      ) : null}

      {renameOpen && active ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
          <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-[#121217] p-4 shadow-2xl">
            <div className="text-[15px] font-semibold">Rename File</div>
            <div className="mt-1 truncate text-[11px] text-zinc-500 dark:text-zinc-400">
              {active.relativePath}
            </div>
            <input
              autoFocus
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              className="mt-4 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-[13px] outline-none focus:border-zinc-600"
              placeholder="New name"
            />
            <div className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">
              Leave out the extension to rename only the title.
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setRenameOpen(false)}
                className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-[12px] hover:bg-zinc-900"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleRename}
                disabled={isSaving || isLoading || !renameValue.trim()}
                className="rounded-lg bg-white px-3 py-2 text-[12px] font-semibold text-zinc-950 disabled:cursor-wait disabled:opacity-60"
              >
                {isSaving ? "Applying..." : "Rename"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {infoOpen && active ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
          <div className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-[#121217] p-4 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[15px] font-semibold">File Info</div>
                <div className="mt-1 break-words text-[13px] font-medium">{activeName}</div>
                <div className="mt-1 break-words text-[11px] text-zinc-500 dark:text-zinc-400">
                  {active.relativePath}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setInfoOpen(false)}
                className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-[12px] hover:bg-zinc-900"
              >
                Close
              </button>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3 rounded-2xl border border-zinc-800 bg-zinc-950/60 p-3 text-[12px]">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  Type
                </div>
                <div className="mt-1">{active.kind === "video" ? "Video" : "Image"}</div>
              </div>
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  Size
                </div>
                <div className="mt-1">{formatBytes(active.sizeBytes)}</div>
              </div>
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  Modified
                </div>
                <div className="mt-1">{formatDate(active.modifiedMs)}</div>
              </div>
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  Extension
                </div>
                <div className="mt-1">{active.ext}</div>
              </div>
              <div className="col-span-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  Full Path
                </div>
                <div className="mt-1 break-words">{active.path}</div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {viewerExpanded && active ? (
        <div className="fixed inset-0 z-50 bg-black/95">
          <div className="flex h-full flex-col">
            <div className="flex items-center justify-between gap-4 px-4 py-3 text-white">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">
                  {active.name + active.ext}
                </div>
                <div className="truncate text-xs text-zinc-400">
                  {active.relativePath}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {active.kind === "image" ? (
                  <>
                    <div className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200">
                      {Math.round(imageZoom * 100)}%
                    </div>
                    <button
                      className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs hover:bg-zinc-800"
                      type="button"
                      onClick={() => applyImageZoom(imageZoom - IMAGE_ZOOM_STEP)}
                    >
                      Zoom Out
                    </button>
                    <button
                      className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs hover:bg-zinc-800"
                      type="button"
                      onClick={() => applyImageZoom(imageZoom + IMAGE_ZOOM_STEP)}
                    >
                      Zoom In
                    </button>
                    <button
                      className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs hover:bg-zinc-800"
                      type="button"
                      onClick={resetExpandedImageView}
                    >
                      Reset
                    </button>
                  </>
                ) : null}
                {active.kind === "video" ? (
                  <button
                    className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs hover:bg-zinc-800"
                    type="button"
                    onClick={() => setVideoMuted((value) => !value)}
                  >
                    Audio {videoMuted ? "Off" : "On"}
                  </button>
                ) : null}
                <button
                  className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs hover:bg-zinc-800"
                  type="button"
                  onClick={() => setViewerExpanded(false)}
                >
                  Close
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 p-4">
              <div className="relative h-full">
                <div
                  className="flex h-full items-center justify-center overflow-hidden rounded-2xl bg-black"
                  onWheel={handleExpandedImageWheel}
                >
                  {active.kind === "image" ? (
                    <img
                      src={previewSourceUrl}
                      alt={active.name}
                      className={classNames(
                        "max-h-full max-w-full select-none object-contain transition-transform",
                        imageZoom > 1 ? "cursor-grab" : "cursor-zoom-in",
                        isDraggingImage ? "cursor-grabbing" : "",
                      )}
                      draggable={false}
                      onMouseDown={handleExpandedImageMouseDown}
                      style={{
                        transform: `translate(${imageOffset.x}px, ${imageOffset.y}px) scale(${imageZoom})`,
                        transitionDuration: isDraggingImage ? "0ms" : "140ms",
                      }}
                    />
                  ) : (
                    previewContent
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => selectNext(-1)}
                  className="absolute left-4 top-1/2 z-10 -translate-y-1/2 rounded-full border border-zinc-700 bg-black/70 px-4 py-2 text-xl font-semibold text-white hover:bg-black/85"
                  aria-label="Previous item"
                >
                  &lt;
                </button>
                <button
                  type="button"
                  onClick={() => selectNext(1)}
                  className="absolute right-4 top-1/2 z-10 -translate-y-1/2 rounded-full border border-zinc-700 bg-black/70 px-4 py-2 text-xl font-semibold text-white hover:bg-black/85"
                  aria-label="Next item"
                >
                  &gt;
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;
