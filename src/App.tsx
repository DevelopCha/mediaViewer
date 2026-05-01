import {
  startTransition,
  type MouseEvent as ReactMouseEvent,
  type SyntheticEvent,
  type WheelEvent as ReactWheelEvent,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { FolderTreeBranch, MediaListRow } from "./components/media-browser-parts";
import { clamp, clampMenuPosition, classNames, formatBytes, formatDate } from "./lib/format";
import {
  buildFilesByFolder,
  buildFolderTree,
  buildVisibleTreeEntries,
  filterMediaItems,
  findMediaById,
  findMediaByPath,
  parentFolderPath,
  sortMediaItems,
  type ExplorerSelection,
  type MediaItem,
  type MediaKind,
  type SortKey,
  type TreeVisibleEntry,
} from "./lib/media-browser";
import {
  BACKGROUND_ENGINES,
  FRAME_EXTRACT_PRESETS,
  backgroundTaskLabel,
  backgroundTaskProgressLabel,
  resolveVideoVrLayout,
  type AnimationExportFormat,
  type BackgroundEngineKey,
  type BackgroundTask,
  type ContextMenuState,
  type ContextSubmenu,
  type FrameExtractPresetKey,
  type VideoEyeMode,
  type VideoVrLayout,
  type VideoVrLayoutSetting,
  upsertBackgroundTask,
  videoVrTransformStyle,
} from "./lib/media-processing";
import {
  assetUrl,
  cancelBackgroundTask as cancelBackgroundTaskCommand,
  clearFinishedBackgroundTasks as clearFinishedBackgroundTasksCommand,
  createMediaFolder,
  deleteMediaFile,
  deleteMediaFolder,
  duplicateMediaFile,
  duplicateMediaFolder,
  enqueueExtractVideoFrames,
  enqueueRemoveImageBackground,
  exportImageSequenceAnimation,
  exportPortfolioSheet,
  exportVideoBestCuts,
  exportVideoContactSheet,
  exportVideoLoopClip,
  listBackgroundTasks,
  onBackgroundTaskUpdate,
  pickRootFolder,
  renameMediaFile,
  resizeMediaFileWithPreset,
  scanMediaFolder,
  splitVideoByScenes,
} from "./lib/tauri-media";
import mviewerWatermark from "./assets/mviewer-watermark.png";

type PaneKey = "folders" | "preview";
type ResizePresetKey =
  | "square_1080"
  | "story_1080x1920"
  | "landscape_1920x1080"
  | "thumb_1280x720";
type LoopExportFormat = "mp4" | "gif" | "webp";
type ActionDialogState =
  | {
      kind: "bestCuts";
      item: MediaItem;
      count: string;
      threshold: string;
    }
  | {
      kind: "contactSheet";
      item: MediaItem;
      columns: string;
      rows: string;
    }
  | {
      kind: "loopClip";
      item: MediaItem;
      startSeconds: string;
      endSeconds: string;
      format: LoopExportFormat;
      fps: string;
    }
  | {
      kind: "splitScenes";
      item: MediaItem;
      threshold: string;
      minSceneSeconds: string;
    }
  | {
      kind: "portfolioSheet";
      columns: string;
      imageCount: number;
    }
  | {
      kind: "resizePreset";
      presetKey: ResizePresetKey;
      itemCount: number;
      targetKinds: string;
    };

const IMAGE_ZOOM_MIN = 0.5;
const IMAGE_ZOOM_MAX = 6;
const IMAGE_ZOOM_STEP = 0.2;
const ANIMATION_PREVIEW_FPS_MAX = 120;
const LIST_ITEM_HEIGHT = 62;
const DEFAULT_FOLDER_WIDTH = 276;
const MIN_FOLDER_WIDTH = 220;
const MAX_FOLDER_WIDTH = 460;
const CONTEXT_MENU_WIDTH = 176;
const CONTEXT_SUBMENU_WIDTH = 224;
const MENU_VIEWPORT_MARGIN = 12;

function formatSecondsLabel(value: number) {
  const safe = Math.max(0, value);
  const minutes = Math.floor(safe / 60);
  const seconds = Math.floor(safe % 60);
  const fraction = Math.round((safe - Math.floor(safe)) * 10);
  return `${minutes}:${seconds.toString().padStart(2, "0")}.${fraction}`;
}

function buildItemMaps(items: MediaItem[]) {
  const byId = new Map<string, MediaItem>();
  const byPath = new Map<string, MediaItem>();
  for (const item of items) {
    byId.set(item.id, item);
    byPath.set(item.path, item);
  }
  return { byId, byPath };
}

function firstBrowsableItem(items: MediaItem[]) {
  return items.find((item) => !item.archivePath) ?? items[0] ?? null;
}

function isOpenableZipItem(item: MediaItem) {
  return item.kind === "zip" && !item.archivePath;
}

function mapZipScanItemsToArchiveItems(zipItem: MediaItem, zipItems: MediaItem[]): MediaItem[] {
  return zipItems.map((child) => ({
    ...child,
    archivePath: zipItem.path,
    archiveEntryPath: child.relativePath,
    relativePath: `${zipItem.relativePath}/${child.relativePath}`,
  }));
}

function isArchiveRootPath(path: string) {
  return path.trim().toLowerCase().endsWith(".zip");
}

function App() {
  const [kindFilter, setKindFilter] = useState<"all" | MediaKind>("all");
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [headerMenuOpen, setHeaderMenuOpen] = useState<"file" | "help" | "view" | null>(null);
  const [videoMuted, setVideoMuted] = useState(true);
  const [videoEyeMode, setVideoEyeMode] = useState<VideoEyeMode>("standard");
  const [videoVrLayoutSetting, setVideoVrLayoutSetting] =
    useState<VideoVrLayoutSetting>("auto");
  const [activeVideoDimensions, setActiveVideoDimensions] = useState<{
    width: number;
    height: number;
  } | null>(null);
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
  const [aboutOpen, setAboutOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [showFolders, setShowFolders] = useState(true);
  const [showPreview, setShowPreview] = useState(true);
  const [folderWidth, setFolderWidth] = useState(DEFAULT_FOLDER_WIDTH);
  const [expandedFolderPaths, setExpandedFolderPaths] = useState<Set<string>>(new Set([""]));
  const [selectedFolderPath, setSelectedFolderPath] = useState("");
  const [explorerSelection, setExplorerSelection] = useState<ExplorerSelection>({
    type: "folder",
    path: "",
  });
  const [imageZoom, setImageZoom] = useState(1);
  const [imageOffset, setImageOffset] = useState({ x: 0, y: 0 });
  const [isDraggingImage, setIsDraggingImage] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [contextSubmenu, setContextSubmenu] = useState<ContextSubmenu>(null);
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTask[]>([]);
  const [tasksPanelOpen, setTasksPanelOpen] = useState(true);
  const [animationPreviewOpen, setAnimationPreviewOpen] = useState(false);
  const [animationPreviewFrameIds, setAnimationPreviewFrameIds] = useState<string[]>([]);
  const [animationPreviewIndex, setAnimationPreviewIndex] = useState(0);
  const [animationPreviewPlaying, setAnimationPreviewPlaying] = useState(true);
  const [animationPreviewLoop, setAnimationPreviewLoop] = useState(true);
  const [animationPreviewFps, setAnimationPreviewFps] = useState(6);
  const [animationPreviewReverse, setAnimationPreviewReverse] = useState(false);
  const [animationExporting, setAnimationExporting] = useState(false);
  const [animationContextMenu, setAnimationContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [actionDialog, setActionDialog] = useState<ActionDialogState | null>(null);
  const [clipPreviewDuration, setClipPreviewDuration] = useState(0);
  const [clipPreviewCurrentTime, setClipPreviewCurrentTime] = useState(0);
  const explorerRef = useRef<HTMLDivElement | null>(null);
  const clipPreviewRef = useRef<HTMLVideoElement | null>(null);
  const dragStateRef = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const resizeStateRef = useRef<{
    startX: number;
    startWidth: number;
  } | null>(null);
  const backgroundRefreshTimeoutRef = useRef<number | null>(null);
  const headerMenuRef = useRef<HTMLDivElement | null>(null);

  const deferredQuery = useDeferredValue(query);
  const browsingZipFolder = isVirtualZipFolderPath(selectedFolderPath);
  const listKindFilter = browsingZipFolder && kindFilter === "zip" ? "all" : kindFilter;

  const treeSourceItems = useMemo(
    () =>
      kindFilter === "all"
        ? items
        : kindFilter === "zip"
          ? items.filter((item) => item.kind === "zip" || item.archivePath)
          : items.filter((item) => item.kind === kindFilter),
    [items, kindFilter],
  );

  const folderTree = useMemo(
    () => buildFolderTree(rootFolderName, treeSourceItems),
    [rootFolderName, treeSourceItems],
  );

  const selectedFolderNode = folderTree.get(selectedFolderPath) ?? folderTree.get("");

  function isArchiveEntry(item: MediaItem) {
    return Boolean(item.archivePath);
  }

  function isVirtualZipFolderPath(path: string) {
    return path.toLowerCase().includes(".zip");
  }

  function zipFolderItems(path: string) {
    return items.filter((item) => item.relativePath.startsWith(`${path}/`));
  }

  function expandFolderHierarchy(path: string) {
    setExpandedFolderPaths((prev) => {
      const next = new Set(prev);
      next.add("");
      let current = "";
      for (const segment of path.split("/").filter(Boolean)) {
        current = current ? `${current}/${segment}` : segment;
        next.add(current);
      }
      return next;
    });
  }

  function hasZipChildren(item: MediaItem) {
    return (
      item.kind === "zip" &&
      items.some(
        (candidate) =>
          candidate.archivePath === item.path &&
          candidate.relativePath.startsWith(`${item.relativePath}/`),
      )
    );
  }

  async function openZipItem(item: MediaItem) {
    if (!isOpenableZipItem(item)) {
      return false;
    }

    if (hasZipChildren(item)) {
      expandFolderHierarchy(item.relativePath);
      setSelectedFolderPath(item.relativePath);
      setExplorerSelection({
        type: "file",
        id: item.id,
        parentPath: parentFolderPath(item.relativePath),
      });
      setSelectedItemIds(new Set([item.id]));
      setSelectionAnchorId(item.id);
      setActiveId(item.id);
      return true;
    }

    setIsLoading(true);
    setErrorMessage("");

    try {
      const result = await scanMediaFolder(item.path);
      const archiveItems = mapZipScanItemsToArchiveItems(item, result.items);

      startTransition(() => {
        setItems((prev) => {
          const withoutOldArchiveItems = prev.filter(
            (candidate) => candidate.archivePath !== item.path,
          );
          return [...withoutOldArchiveItems, ...archiveItems];
        });
      });

      expandFolderHierarchy(item.relativePath);
      if (kindFilter === "zip") {
        setKindFilter("all");
      }
      setSelectedFolderPath(item.relativePath);
      setExplorerSelection({
        type: "file",
        id: item.id,
        parentPath: parentFolderPath(item.relativePath),
      });
      setSelectedItemIds(new Set([item.id]));
      setSelectionAnchorId(item.id);
      setActiveId(item.id);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to open the ZIP file.");
      setActiveId(item.id);
    } finally {
      setIsLoading(false);
    }

    if (kindFilter === "zip") {
      setKindFilter("all");
    }
    return true;
  }

  function handleFolderSelect(path: string) {
    if (kindFilter === "zip" && isVirtualZipFolderPath(path)) {
      setKindFilter("all");
    }
    setSelectedFolderPath(path);
    setExplorerSelection({ type: "folder", path });
    const zipRootItem = items.find(
      (item) => item.kind === "zip" && !item.archivePath && item.relativePath === path,
    );
    const folderItems = isVirtualZipFolderPath(path)
      ? zipFolderItems(path)
      : treeSourceItems.filter((item) => (path ? item.relativePath.startsWith(`${path}/`) : true));
    if (zipRootItem) {
      setSelectedItemIds(new Set([zipRootItem.id]));
      setSelectionAnchorId(zipRootItem.id);
      setActiveId(zipRootItem.id);
      return;
    }
    setSelectedItemIds(new Set(folderItems.map((item) => item.id)));
    setSelectionAnchorId(folderItems[0]?.id ?? null);
    const node = folderTree.get(path);
    if (!node?.coverPath) {
      setActiveId(folderItems[0]?.id ?? null);
      return;
    }

    const coverItem = itemMaps.byPath.get(node.coverPath) ?? null;
    setActiveId(coverItem?.id ?? folderItems[0]?.id ?? null);
  }

  const filtered = useMemo(
    () =>
      filterMediaItems(items, {
        folderPath: selectedFolderPath,
        kindFilter: listKindFilter,
        query: deferredQuery,
        includeArchiveEntries: browsingZipFolder,
      }),
    [browsingZipFolder, deferredQuery, items, listKindFilter, selectedFolderPath],
  );

  const treeFilteredItems = useMemo(
    () =>
      filterMediaItems(items, {
        kindFilter,
        query: deferredQuery,
        includeArchiveEntries: true,
      }),
    [deferredQuery, items, kindFilter],
  );

  const sorted = useMemo(() => {
    const next = sortMediaItems(filtered, sortKey);
    return sortDirection === "asc" ? [...next].reverse() : next;
  }, [filtered, sortDirection, sortKey]);
  const sortedTreeItems = useMemo(
    () => {
      const next = sortMediaItems(treeFilteredItems, sortKey);
      return sortDirection === "asc" ? [...next].reverse() : next;
    },
    [sortDirection, sortKey, treeFilteredItems],
  );

  const filesByFolder = useMemo(() => buildFilesByFolder(sortedTreeItems), [sortedTreeItems]);
  const itemMaps = useMemo(() => buildItemMaps(items), [items]);
  const selectedItems = useMemo(
    () =>
      Array.from(selectedItemIds)
        .map((id) => itemMaps.byId.get(id) ?? null)
        .filter((item): item is MediaItem => item !== null),
    [itemMaps, selectedItemIds],
  );
  const selectedVideoItems = useMemo(
    () => selectedItems.filter((item) => item.kind === "video"),
    [selectedItems],
  );
  const selectedImageItems = useMemo(
    () => selectedItems.filter((item) => item.kind === "image"),
    [selectedItems],
  );
  const selectedItemCount = selectedItems.length;

  const active = useMemo(
    () => (activeId ? itemMaps.byId.get(activeId) ?? null : null),
    [activeId, itemMaps],
  );
  const resolvedVideoVrLayout = useMemo(
    () => resolveVideoVrLayout(videoVrLayoutSetting, activeVideoDimensions),
    [activeVideoDimensions, videoVrLayoutSetting],
  );
  const activeName = active ? active.name + active.ext : "Select a file";
  const activeFullPath = active
    ? active.archivePath && active.archiveEntryPath
      ? `${active.archivePath} :: ${active.archiveEntryPath}`
      : active.path
    : "";
  const activeLocation = active
    ? active.relativePath
    : selectedFolderPath
      ? `Showing ${selectedFolderPath}`
      : "Choose a folder or ZIP archive to start browsing.";
  const isArchiveRoot = isArchiveRootPath(rootPath);
  const previewSourceUrl = useMemo(
    () => (active ? assetUrl(active.path) : ""),
    [active?.path],
  );
  useEffect(() => {
    setRenameValue(active?.name ?? "");
  }, [active?.id, active?.name]);

  useEffect(() => {
    setContextMenu(null);
    setContextSubmenu(null);
  }, [active?.id, deferredQuery, kindFilter, selectedFolderPath, sortKey]);

  useEffect(() => {
    if (!headerMenuOpen) return;
    function onPointerDown(event: MouseEvent) {
      if (!headerMenuRef.current?.contains(event.target as Node)) {
        setHeaderMenuOpen(null);
      }
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [headerMenuOpen]);

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
    setSelectedItemIds(new Set());
    setSelectionAnchorId(null);
  }, [rootPath]);

  useEffect(() => {
    setVideoEyeMode("standard");
    setVideoVrLayoutSetting("auto");
    setActiveVideoDimensions(null);
  }, [active?.id, active?.kind]);

  const syncBackgroundTaskEffect = useEffectEvent(async (task: BackgroundTask) => {
    if (task.status === "completed" && rootPath) {
      if (backgroundRefreshTimeoutRef.current !== null) {
        window.clearTimeout(backgroundRefreshTimeoutRef.current);
      }
      backgroundRefreshTimeoutRef.current = window.setTimeout(() => {
        backgroundRefreshTimeoutRef.current = null;
        void loadFolder(rootPath, null, { preserveSelection: true });
      }, 220);
      return;
    }

    if (task.status === "failed" && task.error) {
      setErrorMessage(task.error);
    }
  });

  useEffect(() => {
    let cancelled = false;

    void listBackgroundTasks()
      .then((tasks) => {
        if (!cancelled) {
          setBackgroundTasks(tasks);
        }
      })
      .catch(() => {});

    const unlistenPromise = onBackgroundTaskUpdate((task) => {
      setBackgroundTasks((prev) => upsertBackgroundTask(prev, task));
      void syncBackgroundTaskEffect(task);
    });

    return () => {
      cancelled = true;
      if (backgroundRefreshTimeoutRef.current !== null) {
        window.clearTimeout(backgroundRefreshTimeoutRef.current);
        backgroundRefreshTimeoutRef.current = null;
      }
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [syncBackgroundTaskEffect]);

  async function loadFolder(
    root: string,
    preferredPath?: string | null,
    options?: { preserveSelection?: boolean },
  ) {
    setIsLoading(true);
    setErrorMessage("");

    try {
      const result = await scanMediaFolder(root);
      startTransition(() => {
        setItems(result.items);
        setRootFolderName(result.rootName);
        setRootPath(result.rootPath);
        if (!options?.preserveSelection) {
          setSelectedFolderPath("");
          setExplorerSelection({ type: "folder", path: "" });
        }

        const preferred = findMediaByPath(result.items, preferredPath ?? null);
        const fallback =
          activeId && !preferredPath ? findMediaById(result.items, activeId) : null;
        const initial = firstBrowsableItem(result.items);
        setActiveId(preferred?.id ?? fallback?.id ?? initial?.id ?? null);
      });
      return result;
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to scan the selected folder.",
      );
      return null;
    } finally {
      setIsLoading(false);
    }
  }

  function buildSearchQueryFromNames(names: string[]) {
    return names
      .map((name) => name.trim())
      .filter(Boolean)
      .slice(0, 10)
      .join(" | ");
  }

  function folderDisplayName(folderPath: string) {
    if (!folderPath) {
      return rootFolderName || "Root";
    }
    const segments = folderPath.split("/").filter(Boolean);
    return segments[segments.length - 1] || folderPath;
  }

  function applySearchQueryFromContext() {
    const names =
      contextMenuSelectionItems.length > 0
        ? contextMenuSelectionItems.map((item) => item.name)
        : contextMenuFolderPath !== null
          ? [folderDisplayName(contextMenuFolderPath)]
          : contextMenuItem
            ? [contextMenuItem.name]
            : [];
    const nextQuery = buildSearchQueryFromNames(names);
    if (!nextQuery) return;
    setQuery(nextQuery);
    setContextSubmenu(null);
    setContextMenu(null);
  }

  async function handlePickRootFolder() {
    setErrorMessage("");
    try {
      const selectedRoot = await pickRootFolder();
      if (!selectedRoot) return;
      await loadFolder(selectedRoot);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to open the folder picker.",
      );
    }
  }

  function ensureWritableRoot(action: string) {
    if (!isArchiveRoot) {
      return true;
    }
    setErrorMessage(`${action} is disabled while browsing a ZIP archive.`);
    setContextMenu(null);
    setContextSubmenu(null);
    return false;
  }

  function ensureWritableItems(action: string, targetItems: MediaItem[]) {
    const archiveItem = targetItems.find((item) => isArchiveEntry(item));
    if (!archiveItem) {
      return true;
    }
    setErrorMessage(`${action} is disabled for files inside ZIP archives.`);
    setContextMenu(null);
    setContextSubmenu(null);
    return false;
  }

  function ensureWritableFolderPath(action: string, folderPath: string) {
    if (!isVirtualZipFolderPath(folderPath)) {
      return true;
    }
    setErrorMessage(`${action} is disabled inside ZIP archives.`);
    setContextMenu(null);
    setContextSubmenu(null);
    return false;
  }

  function preferredOutputRootForItems(targetItems: MediaItem[]) {
    const archivePath = targetItems.find((item) => item.archivePath)?.archivePath;
    if (!archivePath) {
      return null;
    }
    const normalized = archivePath.replace(/\\/g, "/");
    const slashIndex = normalized.lastIndexOf("/");
    return slashIndex >= 0 ? archivePath.slice(0, slashIndex) : null;
  }

  async function handleRename() {
    if (!active || !rootPath) return;
    if (!ensureWritableRoot("Rename")) return;
    if (!ensureWritableItems("Rename", [active])) return;
    setIsSaving(true);
    setErrorMessage("");

    try {
      const renamedPath = await renameMediaFile(active.path, renameValue);
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
    if (!ensureWritableRoot("Delete")) return;
    if (!ensureWritableItems("Delete", [item])) return;
    const confirmed = window.confirm(`Delete "${item.name + item.ext}"?`);
    if (!confirmed) return;

    setIsSaving(true);
    setErrorMessage("");

    try {
      await deleteMediaFile(item.path);
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

  async function deleteSelectedItems() {
    if (!rootPath || selectedItems.length === 0) return;
    if (!ensureWritableRoot("Delete")) return;
    if (!ensureWritableItems("Delete", selectedItems)) return;
    const confirmed = window.confirm(`Delete ${selectedItems.length} selected item(s)?`);
    if (!confirmed) return;

    setIsSaving(true);
    setErrorMessage("");

    try {
      for (const item of selectedItems) {
        await deleteMediaFile(item.path);
      }
      setSelectedItemIds(new Set());
      await loadFolder(rootPath);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to delete the selected files.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  function relativeFolderPathFromAbsolute(path: string) {
    if (!rootPath) return "";
    const normalizedRoot = rootPath.split("\\").join("/");
    const normalizedPath = path.split("\\").join("/");
    if (normalizedPath === normalizedRoot) {
      return "";
    }
    return normalizedPath.startsWith(`${normalizedRoot}/`)
      ? normalizedPath.slice(normalizedRoot.length + 1)
      : "";
  }

  async function duplicateItem(item: MediaItem) {
    if (!rootPath) return;
    if (!ensureWritableRoot("Duplicate")) return;
    if (!ensureWritableItems("Duplicate", [item])) return;
    setErrorMessage("");
    setContextMenu(null);

    try {
      const duplicatedPath = await duplicateMediaFile(item.path);
      await loadFolder(rootPath, duplicatedPath);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to duplicate the selected file.",
      );
    }
  }

  async function createFolderAt(relativeFolderPath: string) {
    if (!rootPath) return;
    if (!ensureWritableRoot("Create folder")) return;
    if (!ensureWritableFolderPath("Create folder", relativeFolderPath)) return;
    setErrorMessage("");
    setContextMenu(null);

    try {
      const createdFolderPath = await createMediaFolder(rootPath, relativeFolderPath);
      const result = await loadFolder(rootPath, null, { preserveSelection: true });
      const nextFolderPath = relativeFolderPathFromAbsolute(createdFolderPath);
      setSelectedFolderPath(nextFolderPath);
      setExplorerSelection({ type: "folder", path: nextFolderPath });
      const folderItems =
        result?.items.filter((item) =>
          nextFolderPath ? item.relativePath.startsWith(`${nextFolderPath}/`) : true,
        ) ?? [];
      setSelectedItemIds(new Set(folderItems.map((item) => item.id)));
      setSelectionAnchorId(folderItems[0]?.id ?? null);
      setActiveId(folderItems[0]?.id ?? null);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to create a new folder.",
      );
    }
  }

  async function duplicateFolderAt(relativeFolderPath: string) {
    if (!rootPath || !relativeFolderPath) return;
    if (!ensureWritableRoot("Duplicate folder")) return;
    if (!ensureWritableFolderPath("Duplicate folder", relativeFolderPath)) return;
    setErrorMessage("");
    setContextMenu(null);

    try {
      const duplicatedFolderPath = await duplicateMediaFolder(rootPath, relativeFolderPath);
      const result = await loadFolder(rootPath, null, { preserveSelection: true });
      const nextFolderPath = relativeFolderPathFromAbsolute(duplicatedFolderPath);
      setSelectedFolderPath(nextFolderPath);
      setExplorerSelection({ type: "folder", path: nextFolderPath });
      const folderItems =
        result?.items.filter((item) =>
          nextFolderPath ? item.relativePath.startsWith(`${nextFolderPath}/`) : true,
        ) ?? [];
      setSelectedItemIds(new Set(folderItems.map((item) => item.id)));
      setSelectionAnchorId(folderItems[0]?.id ?? null);
      setActiveId(folderItems[0]?.id ?? null);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to duplicate the selected folder.",
      );
    }
  }

  async function deleteFolderAt(relativeFolderPath: string) {
    if (!rootPath || !relativeFolderPath) return;
    if (!ensureWritableRoot("Delete folder")) return;
    if (!ensureWritableFolderPath("Delete folder", relativeFolderPath)) return;
    const folderLabel = relativeFolderPath.split("/").pop() || relativeFolderPath;
    const confirmed = window.confirm(`Delete folder "${folderLabel}" and everything inside it?`);
    if (!confirmed) return;

    setErrorMessage("");
    setContextMenu(null);

    try {
      await deleteMediaFolder(rootPath, relativeFolderPath);
      await loadFolder(rootPath);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to delete the selected folder.",
      );
    }
  }

  async function handleRemoveBackground(item: MediaItem, engineKey: BackgroundEngineKey) {
    if (!rootPath) return;
    if (!item.archivePath) {
      if (!ensureWritableRoot("Background removal")) return;
      if (!ensureWritableItems("Background removal", [item])) return;
    }
    if (item.kind !== "image") {
      setErrorMessage("Background removal is only available for images.");
      setContextMenu(null);
      return;
    }

    setErrorMessage("");
    setContextMenu(null);
    setContextSubmenu(null);

    try {
      const task = await enqueueRemoveImageBackground(
        item.path,
        engineKey,
        preferredOutputRootForItems([item]),
      );
      setBackgroundTasks((prev) => upsertBackgroundTask(prev, task));
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to remove the image background.",
      );
    }
  }

  async function handleRemoveBackgroundSelected(engineKey: BackgroundEngineKey) {
    if (!rootPath || selectedItems.length === 0) return;
    if (!selectedItems.some((item) => item.archivePath)) {
      if (!ensureWritableRoot("Background removal")) return;
      if (!ensureWritableItems("Background removal", selectedItems)) return;
    }

    const imageItems = selectedImageItems;
    if (imageItems.length === 0) {
      setErrorMessage("Background removal is only available for selected images.");
      return;
    }

    setErrorMessage("");
    setContextMenu(null);
    setContextSubmenu(null);

    try {
      for (const item of imageItems) {
        const task = await enqueueRemoveImageBackground(
          item.path,
          engineKey,
          preferredOutputRootForItems([item]),
        );
        setBackgroundTasks((prev) => upsertBackgroundTask(prev, task));
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to queue selected background removals.",
      );
    }
  }

  async function handleExtractFrames(item: MediaItem, presetKey: FrameExtractPresetKey) {
    if (!rootPath) return;
    if (!item.archivePath) {
      if (!ensureWritableRoot("Frame extraction")) return;
      if (!ensureWritableItems("Frame extraction", [item])) return;
    }
    if (item.kind !== "video") {
      setErrorMessage("Frame extraction is only available for videos.");
      setContextMenu(null);
      return;
    }

    setErrorMessage("");
    setContextMenu(null);
    setContextSubmenu(null);

    try {
      const task = await enqueueExtractVideoFrames(
        item.path,
        presetKey,
        videoEyeMode,
        currentExtractLayout(),
        preferredOutputRootForItems([item]),
      );
      setBackgroundTasks((prev) => upsertBackgroundTask(prev, task));
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to extract video frames.",
      );
    }
  }

  async function handleExtractFramesSelected(presetKey: FrameExtractPresetKey) {
    if (!rootPath || selectedItems.length === 0) return;
    if (!selectedItems.some((item) => item.archivePath)) {
      if (!ensureWritableRoot("Frame extraction")) return;
      if (!ensureWritableItems("Frame extraction", selectedItems)) return;
    }
    if (selectedVideoItems.length === 0) {
      setErrorMessage("Frame extraction is only available for selected videos.");
      return;
    }

    setErrorMessage("");
    setContextMenu(null);
    setContextSubmenu(null);

    try {
      for (const item of selectedVideoItems) {
        const task = await enqueueExtractVideoFrames(
          item.path,
          presetKey,
          videoEyeMode,
          currentExtractLayout(),
          preferredOutputRootForItems([item]),
        );
        setBackgroundTasks((prev) => upsertBackgroundTask(prev, task));
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to queue video frame extraction.",
      );
    }
  }

  async function cancelBackgroundTask(taskId: string) {
    try {
      const task = await cancelBackgroundTaskCommand(taskId);
      setBackgroundTasks((prev) => upsertBackgroundTask(prev, task));
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to cancel the queued task.",
      );
    }
  }

  async function retryBackgroundTask(task: BackgroundTask) {
    try {
      const nextTask =
        task.kind === "extractFrames"
          ? await enqueueExtractVideoFrames(
              task.sourcePath,
              task.engineKey as FrameExtractPresetKey,
              task.extractEyeMode ?? "standard",
              task.extractLayout ?? "sbs",
            )
          : await enqueueRemoveImageBackground(
              task.sourcePath,
              task.engineKey as BackgroundEngineKey,
            );
      setBackgroundTasks((prev) => upsertBackgroundTask(prev, nextTask));
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to retry the queued task.",
      );
    }
  }

  async function clearFinishedBackgroundTasks() {
    try {
      await clearFinishedBackgroundTasksCommand();
      const tasks = await listBackgroundTasks();
      setBackgroundTasks(tasks);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to clear finished tasks.",
      );
    }
  }

  function selectSingleItem(item: MediaItem) {
    if (isOpenableZipItem(item)) {
      void openZipItem(item);
      return;
    }

    if (hasZipChildren(item)) {
      expandFolderHierarchy(item.relativePath);
      handleFolderSelect(item.relativePath);
      return;
    }

    const parentPath = parentFolderPath(item.relativePath);
    setSelectedFolderPath(parentPath);
    setExplorerSelection({
      type: "file",
      id: item.id,
      parentPath,
    });
    setActiveId(item.id);
    setSelectedItemIds(new Set([item.id]));
    setSelectionAnchorId(item.id);
  }

  function applyItemSelection(event: ReactMouseEvent<HTMLButtonElement>, item: MediaItem) {
    if (!event.shiftKey && !(event.ctrlKey || event.metaKey) && isOpenableZipItem(item)) {
      void openZipItem(item);
      return;
    }

    if (!event.shiftKey && !(event.ctrlKey || event.metaKey) && hasZipChildren(item)) {
      expandFolderHierarchy(item.relativePath);
      handleFolderSelect(item.relativePath);
      return;
    }

    const parentPath = parentFolderPath(item.relativePath);
    setSelectedFolderPath(parentPath);
    setExplorerSelection({
      type: "file",
      id: item.id,
      parentPath,
    });
    setActiveId(item.id);

    if (event.shiftKey && selectionAnchorId) {
      const orderedIds = selectionOrderedItems.map((candidate) => candidate.id);
      const anchorIndex = orderedIds.indexOf(selectionAnchorId);
      const currentIndex = orderedIds.indexOf(item.id);

      if (anchorIndex >= 0 && currentIndex >= 0) {
        const start = Math.min(anchorIndex, currentIndex);
        const end = Math.max(anchorIndex, currentIndex);
        setSelectedItemIds(new Set(orderedIds.slice(start, end + 1)));
        return;
      }
    }

    if (event.ctrlKey || event.metaKey) {
      setSelectedItemIds((prev) => {
        const next = new Set(prev);
        if (next.has(item.id)) {
          next.delete(item.id);
        } else {
          next.add(item.id);
        }
        return next;
      });
      setSelectionAnchorId(item.id);
      return;
    }

    selectSingleItem(item);
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
    const parentPath = parentFolderPath(item.relativePath);
    setSelectedFolderPath(parentPath);
    setExplorerSelection({
      type: "file",
      id: item.id,
      parentPath,
    });
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

  const selectionOrderedItems = useMemo(() => {
    if (isSearchMode) {
      return sortedTreeItems;
    }

    const visibleFileIds = visibleTreeEntries
      .filter((entry): entry is Extract<TreeVisibleEntry, { type: "file" }> => entry.type === "file")
      .map((entry) => entry.id);

    return visibleFileIds
      .map((id) => itemMaps.byId.get(id) ?? null)
      .filter((item): item is MediaItem => item !== null);
  }, [isSearchMode, itemMaps, sortedTreeItems, visibleTreeEntries]);

  const animationPreviewItems = useMemo(() => {
    const frameSet = new Set(animationPreviewFrameIds);
    const ordered = selectionOrderedItems.filter((item) => frameSet.has(item.id) && item.kind === "image");
    return animationPreviewReverse ? [...ordered].reverse() : ordered;
  }, [animationPreviewFrameIds, animationPreviewReverse, selectionOrderedItems]);

  const currentAnimationFrame = animationPreviewItems[animationPreviewIndex] ?? null;
  const currentAnimationFrameUrl = currentAnimationFrame ? assetUrl(currentAnimationFrame.path) : "";

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
      preview: showPreview,
      [pane]: !(pane === "folders" ? showFolders : showPreview),
    };

    if (!next.folders && !next.preview) {
      return;
    }

    setShowFolders(next.folders);
    setShowPreview(next.preview);
  }

  function resetLayout() {
    setShowFolders(true);
    setShowPreview(true);
    setFolderWidth(DEFAULT_FOLDER_WIDTH);
  }

  function startResize(event: ReactMouseEvent<HTMLDivElement>) {
    event.preventDefault();
    resizeStateRef.current = {
      startX: event.clientX,
      startWidth: folderWidth,
    };
  }

  function handleRowContextMenu(event: ReactMouseEvent<HTMLButtonElement>, item: MediaItem) {
    event.preventDefault();
    const parentPath = parentFolderPath(item.relativePath);
    setSelectedFolderPath(parentPath);
    setExplorerSelection({
      type: "file",
      id: item.id,
      parentPath,
    });
    setActiveId(item.id);
    setSelectedItemIds((prev) => {
      if (prev.has(item.id)) {
        return prev;
      }
      return new Set([item.id]);
    });
    setSelectionAnchorId(item.id);
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      target: "item",
      itemId: item.id,
    });
    setContextSubmenu(null);
  }

  function handleFolderContextMenu(event: ReactMouseEvent<HTMLButtonElement>, path: string) {
    event.preventDefault();
    handleFolderSelect(path);
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      target: "folder",
      folderPath: path,
    });
    setContextSubmenu(null);
  }

  function openAnimationPreview(itemsToPreview: MediaItem[]) {
    const previewIds = selectionOrderedItems
      .filter((item) => itemsToPreview.some((candidate) => candidate.id === item.id) && item.kind === "image")
      .map((item) => item.id);

    if (previewIds.length < 2) {
      setErrorMessage("Animation preview needs at least two selected images.");
      return;
    }

    setErrorMessage("");
    setContextMenu(null);
    setContextSubmenu(null);
    setAnimationContextMenu(null);
    setAnimationPreviewFrameIds(previewIds);
    setAnimationPreviewIndex(0);
    setAnimationPreviewPlaying(true);
    setAnimationPreviewLoop(true);
    setAnimationPreviewFps(6);
    setAnimationPreviewReverse(false);
    setAnimationPreviewOpen(true);
  }

  async function exportAnimationFromPreview(format: AnimationExportFormat) {
    if (animationPreviewItems.length < 2) return;
    if (!animationPreviewItems.some((item) => item.archivePath)) {
      if (!ensureWritableRoot("Animation export")) return;
    }

    setAnimationExporting(true);
    setAnimationContextMenu(null);
    setErrorMessage("");

    try {
      const outputPath = await exportImageSequenceAnimation(
        animationPreviewItems.map((item) => item.path),
        format,
        animationPreviewFps,
        false,
        preferredOutputRootForItems(animationPreviewItems),
      );
      if (rootPath) {
        await loadFolder(rootPath, outputPath, { preserveSelection: true });
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to export the animation preview.",
      );
    } finally {
      setAnimationExporting(false);
    }
  }

  async function runAndReload(action: string, work: () => Promise<string>) {
    setIsSaving(true);
    setErrorMessage("");
    setContextMenu(null);
    setContextSubmenu(null);

    try {
      const outputPath = await work();
      if (rootPath) {
        await loadFolder(rootPath, outputPath, { preserveSelection: true });
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : `Failed to complete ${action}.`,
      );
    } finally {
      setIsSaving(false);
    }
  }

  function openBestCutsDialog(item: MediaItem) {
    if (!rootPath) return;
    if (!item.archivePath) {
      if (!ensureWritableRoot("Best-cut extraction")) return;
      if (!ensureWritableItems("Best-cut extraction", [item])) return;
    }
    if (item.kind !== "video") {
      setErrorMessage("Best-cut extraction is only available for videos.");
      return;
    }

    setErrorMessage("");
    setContextMenu(null);
    setContextSubmenu(null);
    setActionDialog({ kind: "bestCuts", item, count: "8", threshold: "0.32" });
  }

  function openVideoContactSheetDialog(item: MediaItem) {
    if (!rootPath) return;
    if (!item.archivePath) {
      if (!ensureWritableRoot("Contact sheet")) return;
      if (!ensureWritableItems("Contact sheet", [item])) return;
    }
    if (item.kind !== "video") {
      setErrorMessage("Contact sheet export is only available for videos.");
      return;
    }

    setErrorMessage("");
    setContextMenu(null);
    setContextSubmenu(null);
    setActionDialog({ kind: "contactSheet", item, columns: "4", rows: "4" });
  }

  function openLoopClipDialog(item: MediaItem) {
    if (!rootPath) return;
    if (!item.archivePath) {
      if (!ensureWritableRoot("Loop clip export")) return;
      if (!ensureWritableItems("Loop clip export", [item])) return;
    }
    if (item.kind !== "video") {
      setErrorMessage("Loop clip export is only available for videos.");
      return;
    }

    setErrorMessage("");
    setContextMenu(null);
    setContextSubmenu(null);
    setActionDialog({
      kind: "loopClip",
      item,
      startSeconds: "0",
      endSeconds: "2.5",
      format: "mp4",
      fps: "15",
    });
    setClipPreviewCurrentTime(0);
    setClipPreviewDuration(0);
  }

  function openSplitScenesDialog(item: MediaItem) {
    if (!rootPath) return;
    if (!item.archivePath) {
      if (!ensureWritableRoot("Scene split")) return;
      if (!ensureWritableItems("Scene split", [item])) return;
    }
    if (item.kind !== "video") {
      setErrorMessage("Scene split is only available for videos.");
      return;
    }

    setErrorMessage("");
    setContextMenu(null);
    setContextSubmenu(null);
    setActionDialog({
      kind: "splitScenes",
      item,
      threshold: "0.35",
      minSceneSeconds: "1.2",
    });
  }

  function openPortfolioSheetDialog() {
    if (!rootPath || selectedImageItems.length < 2) {
      setErrorMessage("Select at least two images to create a portfolio sheet.");
      return;
    }
    if (!selectedImageItems.some((item) => item.archivePath)) {
      if (!ensureWritableRoot("Portfolio sheet")) return;
      if (!ensureWritableItems("Portfolio sheet", selectedImageItems)) return;
    }

    setErrorMessage("");
    setContextMenu(null);
    setContextSubmenu(null);
    setActionDialog({
      kind: "portfolioSheet",
      columns: "3",
      imageCount: selectedImageItems.length,
    });
  }

  function openResizePresetDialog() {
    if (!rootPath || selectedItems.length === 0) {
      setErrorMessage("Select at least one item to resize.");
      return;
    }
    if (!selectedItems.some((item) => item.archivePath)) {
      if (!ensureWritableRoot("Resize export")) return;
      if (!ensureWritableItems("Resize export", selectedItems)) return;
    }

    setErrorMessage("");
    setContextMenu(null);
    setContextSubmenu(null);
    setActionDialog({
      kind: "resizePreset",
      presetKey: "square_1080",
      itemCount: selectedItems.length,
      targetKinds: Array.from(new Set(selectedItems.map((item) => item.kind))).join(", "),
    });
  }

  async function submitActionDialog() {
    if (!actionDialog) return;

    if (actionDialog.kind === "bestCuts") {
      const count = Number(actionDialog.count);
      const threshold = Number(actionDialog.threshold);
      if (!Number.isFinite(count) || count < 1 || !Number.isFinite(threshold)) {
        setErrorMessage("Enter a valid cut count and scene sensitivity.");
        return;
      }
      setActionDialog(null);
      await runAndReload("best-cut extraction", () =>
        exportVideoBestCuts(
          actionDialog.item.path,
          Math.max(1, Math.round(count)),
          threshold,
          preferredOutputRootForItems([actionDialog.item]),
        ),
      );
      return;
    }

    if (actionDialog.kind === "contactSheet") {
      const columns = Number(actionDialog.columns);
      const rows = Number(actionDialog.rows);
      if (!Number.isFinite(columns) || !Number.isFinite(rows) || columns < 1 || rows < 1) {
        setErrorMessage("Enter valid column and row counts.");
        return;
      }
      setActionDialog(null);
      await runAndReload("contact sheet export", () =>
        exportVideoContactSheet(
          actionDialog.item.path,
          Math.round(columns),
          Math.round(rows),
          preferredOutputRootForItems([actionDialog.item]),
        ),
      );
      return;
    }

    if (actionDialog.kind === "loopClip") {
      const startSeconds = Number(actionDialog.startSeconds);
      const endSeconds = Number(actionDialog.endSeconds);
      const fps = Number(actionDialog.fps);
      if (
        !Number.isFinite(startSeconds) ||
        !Number.isFinite(endSeconds) ||
        !Number.isFinite(fps) ||
        fps < 1 ||
        endSeconds <= startSeconds
      ) {
        setErrorMessage("Choose a valid start, end, and FPS.");
        return;
      }
      setActionDialog(null);
      await runAndReload("loop clip export", () =>
        exportVideoLoopClip(
          actionDialog.item.path,
          startSeconds,
          endSeconds - startSeconds,
          actionDialog.format,
          Math.round(fps),
          preferredOutputRootForItems([actionDialog.item]),
        ),
      );
      return;
    }

    if (actionDialog.kind === "splitScenes") {
      const threshold = Number(actionDialog.threshold);
      const minSceneSeconds = Number(actionDialog.minSceneSeconds);
      if (!Number.isFinite(threshold) || !Number.isFinite(minSceneSeconds) || minSceneSeconds <= 0) {
        setErrorMessage("Enter a valid scene sensitivity and minimum scene length.");
        return;
      }
      setActionDialog(null);
      await runAndReload("scene split", () =>
        splitVideoByScenes(
          actionDialog.item.path,
          threshold,
          minSceneSeconds,
          preferredOutputRootForItems([actionDialog.item]),
        ),
      );
      return;
    }

    if (actionDialog.kind === "portfolioSheet") {
      const columns = Number(actionDialog.columns);
      if (!Number.isFinite(columns) || columns < 1) {
        setErrorMessage("Enter a valid portfolio column count.");
        return;
      }
      const orderedImagePaths = selectionOrderedItems
        .filter((item) => selectedItemIds.has(item.id) && item.kind === "image")
        .map((item) => item.path);
      setActionDialog(null);
      const exportItems = selectionOrderedItems.filter(
        (item) => selectedItemIds.has(item.id) && item.kind === "image",
      );
      await runAndReload("portfolio sheet export", () =>
        exportPortfolioSheet(
          orderedImagePaths,
          Math.round(columns),
          preferredOutputRootForItems(exportItems),
        ),
      );
      return;
    }

    if (actionDialog.kind === "resizePreset") {
      setActionDialog(null);
      setIsSaving(true);
      setErrorMessage("");
      try {
        let lastOutputPath = "";
        for (const item of selectedItems) {
          lastOutputPath = await resizeMediaFileWithPreset(
            item.path,
            actionDialog.presetKey,
            preferredOutputRootForItems([item]),
          );
        }
        if (rootPath) {
          await loadFolder(rootPath, lastOutputPath || null, { preserveSelection: true });
        }
      } catch (error) {
        setErrorMessage(
          error instanceof Error ? error.message : "Failed to export the resized media.",
        );
      } finally {
        setIsSaving(false);
      }
    }
  }

  async function handleResizeSelection() {
    openResizePresetDialog();
  }

  async function handleExportPortfolioSheet() {
    openPortfolioSheetDialog();
  }

  async function handleExportBestCuts(item: MediaItem) {
    openBestCutsDialog(item);
  }

  async function handleExportVideoContactSheet(item: MediaItem) {
    openVideoContactSheetDialog(item);
  }

  async function handleExportLoopClip(item: MediaItem) {
    openLoopClipDialog(item);
  }

  async function handleSplitVideoScenes(item: MediaItem) {
    openSplitScenesDialog(item);
  }

  function handleTreeFileSelect(event: ReactMouseEvent<HTMLButtonElement>, item: MediaItem) {
    applyItemSelection(event, item);
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
      selectSingleItem(item);
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
        selectSingleItem(item);
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

  function handleVideoMetadata(event: SyntheticEvent<HTMLVideoElement>) {
    const { videoWidth, videoHeight } = event.currentTarget;
    if (!videoWidth || !videoHeight) return;

    setActiveVideoDimensions((prev) => {
      if (prev?.width === videoWidth && prev.height === videoHeight) {
        return prev;
      }

      return { width: videoWidth, height: videoHeight };
    });
  }

  function cycleVideoVrLayout() {
    setVideoVrLayoutSetting((prev) => {
      if (prev === "auto") return "sbs";
      if (prev === "sbs") return "ou";
      return "auto";
    });
  }

  function renderVideoPreview(extraClassName?: string) {
    return (
      <div className="h-full w-full overflow-hidden bg-black">
        <video
          src={previewSourceUrl}
          className={classNames("h-full w-full object-contain", extraClassName)}
          controls
          autoPlay
          muted={videoMuted}
          preload="metadata"
          onLoadedMetadata={handleVideoMetadata}
          style={videoVrTransformStyle(videoEyeMode, resolvedVideoVrLayout)}
        />
      </div>
    );
  }

  function currentExtractLayout(): VideoVrLayout {
    return resolvedVideoVrLayout;
  }

  const emptyPreviewContent = (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden">
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="mb-14 flex items-center gap-0 opacity-[0.13] saturate-75">
          <div className="relative h-[190px] w-[320px] overflow-hidden">
            <img
              src={mviewerWatermark}
              alt=""
              aria-hidden="true"
              className="absolute left-0 top-1/2 h-[190px] max-w-none -translate-y-1/2 select-none"
            />
          </div>
          <div className="-ml-3 text-[clamp(2.2rem,4.3vw,4rem)] font-semibold tracking-[-0.05em] text-zinc-200">
            MediaViewer
          </div>
        </div>
      </div>

      <div className="relative z-10 mt-[22rem] px-6 text-center text-zinc-400">
        <div className="text-lg font-semibold">Nothing selected</div>
        <div className="mt-2 text-sm">
          Pick a folder or ZIP archive and choose a file from the list.
        </div>
      </div>
    </div>
  );

  const previewContent = active ? (
    active.kind === "image" ? (
      <img
        src={previewSourceUrl}
        alt={active.name}
        className="max-h-full max-w-full object-contain"
      />
    ) : active.kind === "video" ? (
      renderVideoPreview()
    ) : (
      <div className="text-center text-zinc-400">
        <div className="text-lg font-semibold">ZIP archive selected</div>
        <div className="mt-2 text-sm">ZIP preview and expand are not enabled yet.</div>
      </div>
    )
  ) : emptyPreviewContent;

  const mainPanelContent = showPreview ? previewContent : emptyPreviewContent;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (animationContextMenu) {
          event.preventDefault();
          setAnimationContextMenu(null);
          return;
        }
        if (animationPreviewOpen) {
          event.preventDefault();
          setAnimationPreviewOpen(false);
          return;
        }
        if (contextMenu) {
          event.preventDefault();
          setContextMenu(null);
          return;
        }
        if (actionDialog) {
          event.preventDefault();
          setActionDialog(null);
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
      if (animationPreviewOpen && animationPreviewItems.length) {
        if (event.key === " ") {
          event.preventDefault();
          setAnimationPreviewPlaying((prev) => !prev);
          return;
        }
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          setAnimationPreviewPlaying(false);
          setAnimationPreviewIndex((prev) =>
            prev === 0 ? animationPreviewItems.length - 1 : prev - 1,
          );
          return;
        }
        if (event.key === "ArrowRight") {
          event.preventDefault();
          setAnimationPreviewPlaying(false);
          setAnimationPreviewIndex((prev) =>
            prev >= animationPreviewItems.length - 1 ? 0 : prev + 1,
          );
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
    actionDialog,
    animationContextMenu,
    animationPreviewItems,
    animationPreviewOpen,
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
    if (!animationPreviewOpen || !animationPreviewPlaying || animationPreviewItems.length < 2) {
      return;
    }

    const intervalMs = Math.max(8, Math.round(1000 / Math.max(animationPreviewFps, 1)));
    const timer = window.setInterval(() => {
      setAnimationPreviewIndex((prev) => {
        const next = prev + 1;
        if (next >= animationPreviewItems.length) {
          return animationPreviewLoop ? 0 : prev;
        }
        return next;
      });
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [
    animationPreviewFps,
    animationPreviewItems.length,
    animationPreviewLoop,
    animationPreviewOpen,
    animationPreviewPlaying,
  ]);

  useEffect(() => {
    if (!animationPreviewOpen) {
      setAnimationContextMenu(null);
    }
  }, [animationPreviewOpen]);

  useEffect(() => {
    if (!animationContextMenu) return;

    function closeAnimationContextMenu() {
      setAnimationContextMenu(null);
    }

    window.addEventListener("click", closeAnimationContextMenu);
    window.addEventListener("scroll", closeAnimationContextMenu, true);
    window.addEventListener("resize", closeAnimationContextMenu);
    return () => {
      window.removeEventListener("click", closeAnimationContextMenu);
      window.removeEventListener("scroll", closeAnimationContextMenu, true);
      window.removeEventListener("resize", closeAnimationContextMenu);
    };
  }, [animationContextMenu]);

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
      setFolderWidth(clamp(state.startWidth + deltaX, MIN_FOLDER_WIDTH, MAX_FOLDER_WIDTH));
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
  }, [folderWidth]);

  useEffect(() => {
    if (!contextMenu) return;

    function closeContextMenu() {
      setContextMenu(null);
      setContextSubmenu(null);
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

  const contextMenuItem =
    contextMenu?.target === "item" ? findMediaById(items, contextMenu.itemId) : null;
  const contextMenuFolderPath = contextMenu?.target === "folder" ? contextMenu.folderPath : null;
  const contextMenuSelectionItems =
    contextMenu?.target === "folder"
      ? selectedItems
      : contextMenuItem && selectedItemIds.has(contextMenuItem.id) && selectedItemCount > 1
        ? selectedItems
        : contextMenuItem
          ? [contextMenuItem]
          : [];
  const contextMenuSelectionImages = contextMenuSelectionItems.filter((item) => item.kind === "image");
  const contextMenuSelectionVideos = contextMenuSelectionItems.filter((item) => item.kind === "video");
  const contextMenuSingleVideo =
    contextMenuSelectionVideos.length === 1 ? contextMenuSelectionVideos[0] : null;
  const contextMenuFolderWritable =
    contextMenuFolderPath !== null && !isVirtualZipFolderPath(contextMenuFolderPath);
  const folderEntryCount = contextMenuFolderWritable ? 1 + (contextMenuFolderPath ? 2 : 0) : 0;
  const fileActionEntryCount =
    (contextMenuSelectionImages.length >= 1 ? 1 : 0) +
    (contextMenuSelectionImages.length >= 2 ? 1 : 0) +
    (contextMenuSelectionImages.length >= 2 ? 1 : 0) +
    (contextMenuSingleVideo ? 4 : 0) +
    (contextMenuSelectionVideos.length >= 1 ? 1 : 0) +
    (contextMenuSelectionItems.length >= 1 ? 1 : 0) +
    (contextMenuItem && contextMenuSelectionItems.length === 1 ? 2 : 0) +
    (contextMenuSelectionItems.length >= 1 ? 1 : 0);
  const contextMenuEntryCount = folderEntryCount + fileActionEntryCount;
  const contextMenuPosition = contextMenu
    ? clampMenuPosition(contextMenu.x, contextMenu.y, CONTEXT_MENU_WIDTH, 16 + contextMenuEntryCount * 38)
    : null;
  const contextSubmenuX =
    contextMenuPosition && typeof window !== "undefined"
      ? contextMenuPosition.x + CONTEXT_MENU_WIDTH + MENU_VIEWPORT_MARGIN + CONTEXT_SUBMENU_WIDTH <= window.innerWidth
        ? contextMenuPosition.x + CONTEXT_MENU_WIDTH + 6
        : contextMenuPosition.x - CONTEXT_SUBMENU_WIDTH - 6
      : 0;
  const backgroundSubmenuPosition =
    contextMenuPosition && contextMenuSelectionImages.length >= 1
      ? clampMenuPosition(contextSubmenuX, contextMenuPosition.y, CONTEXT_SUBMENU_WIDTH, 16 + BACKGROUND_ENGINES.length * 38)
      : null;
  const imageActionOffset = (contextMenuSelectionImages.length >= 1 ? 1 : 0) * 34;
  const imageBatchOffset =
    (contextMenuSelectionImages.length >= 2 ? 1 : 0) * 34 +
    (contextMenuSelectionImages.length >= 2 ? 1 : 0) * 34;
  const videoActionOffset = (contextMenuSingleVideo ? 4 : 0) * 34;
  const extractSubmenuPosition =
    contextMenuPosition && contextMenuSelectionVideos.length >= 1
      ? clampMenuPosition(
          contextSubmenuX,
          contextMenuPosition.y + imageActionOffset + imageBatchOffset + videoActionOffset,
          CONTEXT_SUBMENU_WIDTH,
          16 + FRAME_EXTRACT_PRESETS.length * 38,
        )
      : null;
  const selectedExplorerKey =
    explorerSelection.type === "file"
      ? `file:${explorerSelection.id}`
      : `folder:${explorerSelection.path}`;
  const runningTaskCount = backgroundTasks.filter((task) => task.status === "running").length;
  const queuedTaskCount = backgroundTasks.filter((task) => task.status === "queued").length;
  const finishedTaskCount = backgroundTasks.filter(
    (task) => task.status === "completed" || task.status === "failed",
  ).length;
  const actionDialogTitle =
    actionDialog?.kind === "bestCuts"
      ? "Extract Best Cuts"
      : actionDialog?.kind === "contactSheet"
        ? "Create Contact Sheet"
        : actionDialog?.kind === "loopClip"
          ? "Extract Clip"
          : actionDialog?.kind === "splitScenes"
            ? "Split by Scenes"
            : actionDialog?.kind === "portfolioSheet"
              ? "Create Portfolio Sheet"
              : actionDialog?.kind === "resizePreset"
                ? "Resize with Preset"
                : "";
  const actionDialogDescription =
    actionDialog?.kind === "bestCuts"
      ? "Pick how many representative frames to save and how sensitive the scene change detection should be."
      : actionDialog?.kind === "contactSheet"
        ? "Create one summary image from evenly sampled frames in the selected video."
        : actionDialog?.kind === "loopClip"
          ? "Preview the video, mark the start and end points, then choose an output format and FPS."
          : actionDialog?.kind === "splitScenes"
            ? "Cut the video into separate scene clips based on visual scene changes."
            : actionDialog?.kind === "portfolioSheet"
              ? "Lay out the selected images into one sheet for easy comparison."
              : actionDialog?.kind === "resizePreset"
                ? "Apply a ready-made output size to every selected image or video."
                : "";
  const clipDialogStartValue =
    actionDialog?.kind === "loopClip"
      ? Math.min(
          Math.max(0, Number(actionDialog.startSeconds) || 0),
          clipPreviewDuration || Number(actionDialog.endSeconds) || 0,
        )
      : 0;
  const clipDialogEndValue =
    actionDialog?.kind === "loopClip"
      ? Math.max(clipDialogStartValue, Number(actionDialog.endSeconds) || 0)
      : 0;
  const rootPickerLabel = rootPath || "폴더 선택";

  useEffect(() => {
    const container = explorerRef.current;
    if (!container || !selectedExplorerKey) return;
    const target = container.querySelector<HTMLElement>(
      `[data-tree-key="${selectedExplorerKey}"]`,
    );
    target?.scrollIntoView({ block: "nearest" });
  }, [selectedExplorerKey, visibleTreeEntries]);

  return (
    <div className="dark relative h-dvh w-dvw overflow-hidden bg-zinc-100 text-[12px] text-zinc-950 dark:bg-[#0d0d10] dark:text-zinc-50">
      <div className="relative z-10 flex h-full w-full flex-col">
        <header className="shrink-0 border-b border-zinc-200 bg-white/90 px-3 py-2 dark:border-zinc-800 dark:bg-[#121217]/96">
          <div className="flex items-center justify-between gap-3">
            <div ref={headerMenuRef} className="flex items-center gap-2">
              <div className="pr-2 text-[15px] font-semibold">MViewer</div>
              {(
                [
                  ["file", "File"],
                  ["view", "View"],
                  ["help", "Help"],
                ] as const
              ).map(([key, label]) => (
                <div key={key} className="relative">
                  <button
                    type="button"
                    onClick={() =>
                      setHeaderMenuOpen((prev) => (prev === key ? null : key))
                    }
                    className="rounded-md px-2 py-1 text-[11px] text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900"
                  >
                    {label}
                  </button>
                  {headerMenuOpen === key ? (
                    <div className="absolute left-0 top-[calc(100%+6px)] z-50 min-w-44 rounded-xl border border-zinc-800 bg-[#121217] p-1.5 shadow-2xl">
                      {key === "file" ? (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              setHeaderMenuOpen(null);
                              void handlePickRootFolder();
                            }}
                            className="flex w-full rounded-lg px-3 py-2 text-left text-[12px] hover:bg-zinc-900"
                          >
                            Choose Folder
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setHeaderMenuOpen(null);
                              setQuery("");
                            }}
                            className="flex w-full rounded-lg px-3 py-2 text-left text-[12px] hover:bg-zinc-900"
                          >
                            Clear Search
                          </button>
                        </>
                      ) : null}
                      {key === "view" ? (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              setHeaderMenuOpen(null);
                              togglePane("folders");
                            }}
                            className="flex w-full rounded-lg px-3 py-2 text-left text-[12px] hover:bg-zinc-900"
                          >
                            {showFolders ? "Hide Folders" : "Show Folders"}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setHeaderMenuOpen(null);
                              togglePane("preview");
                            }}
                            className="flex w-full rounded-lg px-3 py-2 text-left text-[12px] hover:bg-zinc-900"
                          >
                            {showPreview ? "Hide Preview" : "Show Preview"}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setHeaderMenuOpen(null);
                              resetLayout();
                            }}
                            className="flex w-full rounded-lg px-3 py-2 text-left text-[12px] hover:bg-zinc-900"
                          >
                            Reset Layout
                          </button>
                        </>
                      ) : null}
                      {key === "help" ? (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              setHeaderMenuOpen(null);
                              setAboutOpen(true);
                            }}
                            className="flex w-full rounded-lg px-3 py-2 text-left text-[12px] hover:bg-zinc-900"
                          >
                            Program Info
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setHeaderMenuOpen(null);
                              setManualOpen(true);
                            }}
                            className="flex w-full rounded-lg px-3 py-2 text-left text-[12px] hover:bg-zinc-900"
                          >
                            Manual
                          </button>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>

            <div className="flex min-w-0 flex-1 items-center justify-center gap-2 px-2">
              <button
                type="button"
                onClick={() => void handlePickRootFolder()}
                className="max-w-[260px] truncate rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-[11px] text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-950/80 dark:text-zinc-200 dark:hover:bg-zinc-900"
                title={rootPath || "폴더 선택"}
              >
                {rootPickerLabel}
              </button>
              <div className="flex w-full max-w-xl items-center rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950/80">
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search files, folders, ZIP contents"
                  className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-zinc-500"
                />
              </div>
            </div>
            <div className="w-[120px]" />
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
        {showFolders ? (
        <aside
          className="flex min-h-0 shrink-0 flex-col border-r border-zinc-200 bg-white/90 dark:border-zinc-800 dark:bg-[#121217]"
          style={{ width: `${folderWidth}px` }}
        >
          <div className="shrink-0 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
            <div className="min-w-0 truncate text-[10px] text-zinc-500 dark:text-zinc-400">
              {rootFolderName || "No folder"}{rootPath ? ` / ${rootPath}` : ""}
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3 pt-2">
            <div className="mt-2.5 shrink-0 space-y-2">
              <div className="grid grid-cols-4 gap-2">
                {(
                  [
                    ["all", "All"],
                    ["image", "Image"],
                    ["video", "Video"],
                    ["zip", "ZIP"],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setKindFilter(key)}
                    className={classNames(
                      "rounded-md border px-2 py-1.5 text-[10px] transition",
                      kindFilter === key
                        ? "border-white bg-white text-zinc-950"
                        : "border-zinc-800 bg-zinc-950 text-zinc-300 hover:bg-zinc-900",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
                {(
                  [
                    ["name", "Name"],
                    ["date", "Date"],
                    ["size", "Size"],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setSortKey(key)}
                    className={classNames(
                      "rounded-md border px-2 py-1.5 text-[10px] transition",
                      sortKey === key
                        ? "border-white bg-white text-zinc-950"
                        : "border-zinc-800 bg-zinc-950 text-zinc-300 hover:bg-zinc-900",
                    )}
                  >
                    {label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    setSortDirection((prev) => (prev === "desc" ? "asc" : "desc"))
                  }
                  className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-[10px] text-zinc-300 hover:bg-zinc-900"
                  title={sortDirection === "desc" ? "Descending" : "Ascending"}
                >
                  {sortDirection === "desc" ? "↓" : "↑"}
                </button>
              </div>
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
                          isSelected={selectedItemIds.has(item.id)}
                          itemHeight={LIST_ITEM_HEIGHT}
                          onSelect={handleTreeFileSelect}
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
                    selectedItemIds={selectedItemIds}
                    onSelect={handleFolderSelect}
                    onToggle={toggleFolderExpanded}
                    onSelectFile={handleTreeFileSelect}
                    onContextMenuFolder={handleFolderContextMenu}
                    onContextMenuFile={handleRowContextMenu}
                  />
                )}
              </div>
            </div>
          </div>
        </aside>
        ) : null}

        {showFolders && showPreview ? (
          <div
            role="separator"
            aria-orientation="vertical"
            className="group relative -ml-1 mr-[-1px] w-2 shrink-0 cursor-col-resize bg-transparent"
            onMouseDown={startResize}
          >
            <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-zinc-800/80 transition group-hover:bg-zinc-500" />
          </div>
        ) : null}

        <main className="flex min-h-0 flex-1 flex-col bg-zinc-200/40 dark:bg-[#0b0b0d]">
          {showPreview ? (
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
                      {active.kind === "video"
                        ? "Video"
                        : active.kind === "zip"
                          ? "ZIP Archive"
                          : "Image"}
                    </div>
                    {active.kind === "video" ? (
                      <>
                        {(
                          [
                            ["standard", "Standard"],
                            ["left", "Left Eye"],
                            ["right", "Right Eye"],
                          ] as const
                        ).map(([mode, label]) => (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => setVideoEyeMode(mode)}
                            className={classNames(
                              "rounded-full border px-2.5 py-1 text-[10px]",
                              videoEyeMode === mode
                                ? "border-sky-700 bg-sky-950/70 text-sky-100"
                                : "border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900",
                            )}
                          >
                            {label}
                          </button>
                        ))}
                        <button
                          type="button"
                          onClick={cycleVideoVrLayout}
                          className="rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-[10px] hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900"
                        >
                          Layout {videoVrLayoutSetting === "auto" ? "Auto" : resolvedVideoVrLayout.toUpperCase()}
                        </button>
                      </>
                    ) : null}
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
          ) : null}

          <div className="min-h-0 flex-1 p-2">
            <div className="relative h-full">
              <div
                className="flex h-full items-center justify-center overflow-hidden rounded-3xl border border-zinc-200 bg-black shadow-sm dark:border-zinc-800"
                onDoubleClick={() => active && setViewerExpanded(true)}
              >
                {mainPanelContent}
              </div>

              {showPreview && active ? (
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
        </div>
      </div>

      {errorMessage ? (
        <div className="pointer-events-none fixed bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-xl border border-red-900/70 bg-red-950/90 px-4 py-3 text-[13px] text-red-100 shadow-lg">
          {errorMessage}
        </div>
      ) : null}

      {backgroundTasks.length ? (
        <div className="fixed bottom-4 right-4 z-40 w-[340px] max-w-[calc(100vw-2rem)] rounded-2xl border border-zinc-800 bg-[#121217]/96 p-3 shadow-2xl backdrop-blur">
          <button
            type="button"
            onClick={() => setTasksPanelOpen((value) => !value)}
            className="flex w-full items-center justify-between gap-3 text-left"
          >
            <div>
              <div className="text-[11px] font-semibold">Background Tasks</div>
              <div className="mt-0.5 text-[10px] text-zinc-400">
                {runningTaskCount ? `${runningTaskCount} running` : "No active run"}
                {queuedTaskCount ? ` / ${queuedTaskCount} queued` : ""}
                {finishedTaskCount ? ` / ${finishedTaskCount} finished` : ""}
                {" / 1 at a time"}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {finishedTaskCount ? (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    void clearFinishedBackgroundTasks();
                  }}
                  className="rounded-full border border-zinc-700 bg-zinc-950 px-2 py-1 text-[9px] text-zinc-300 hover:bg-zinc-900"
                >
                  Clear Done
                </button>
              ) : null}
              <div className="rounded-full border border-zinc-700 bg-zinc-950 px-2 py-1 text-[9px] uppercase tracking-[0.16em] text-zinc-300">
                Queue
              </div>
              <div className="rounded-full border border-zinc-700 bg-zinc-950 px-2 py-1 text-[9px] text-zinc-300">
                {tasksPanelOpen ? "Hide" : "Show"}
              </div>
            </div>
          </button>

          {tasksPanelOpen ? (
          <div className="mt-3 max-h-[240px] space-y-2 overflow-auto pr-1">
            {backgroundTasks.map((task) => (
              <div
                key={task.id}
                className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-2.5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-[11px] font-medium text-zinc-100">
                      {task.fileName}
                    </div>
                    <div className="mt-0.5 truncate text-[10px] text-zinc-500">
                      {task.engineLabel} / {task.message}
                    </div>
                  </div>
                  <div
                    className={classNames(
                      "shrink-0 rounded-full px-2 py-0.5 text-[9px] font-semibold",
                      task.status === "completed"
                        ? "bg-emerald-950 text-emerald-200"
                        : task.status === "failed"
                          ? "bg-red-950 text-red-200"
                          : task.status === "running"
                            ? "bg-sky-950 text-sky-200"
                            : "bg-zinc-800 text-zinc-300",
                    )}
                  >
                    {backgroundTaskLabel(task.status)}
                  </div>
                </div>

                <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className={classNames(
                      "h-full rounded-full transition-all duration-300",
                      task.status === "completed"
                        ? "bg-emerald-400"
                        : task.status === "failed"
                          ? "bg-red-400"
                          : task.status === "running"
                            ? "bg-sky-400"
                            : "bg-zinc-500",
                    )}
                    style={{ width: `${Math.max(task.progress, task.status === "queued" ? 6 : 0)}%` }}
                  />
                </div>

                <div className="mt-2 flex items-center justify-between gap-3 text-[10px] text-zinc-500">
                  <div>{backgroundTaskProgressLabel(task)}</div>
                  <div className="truncate">
                    {task.status === "queued" ? "Reserved in queue" : task.outputPath}
                  </div>
                </div>

                <div className="mt-2 flex items-center justify-end gap-2">
                  {task.status === "queued" ? (
                    <button
                      type="button"
                      onClick={() => void cancelBackgroundTask(task.id)}
                      className="rounded-md border border-amber-900/70 px-2 py-1 text-[10px] text-amber-200 hover:bg-amber-950/40"
                    >
                      Cancel
                    </button>
                  ) : null}
                  {task.status === "failed" ? (
                    <button
                      type="button"
                      onClick={() => void retryBackgroundTask(task)}
                      className="rounded-md border border-zinc-700 px-2 py-1 text-[10px] text-zinc-200 hover:bg-zinc-900"
                    >
                      Retry
                    </button>
                  ) : null}
                </div>

                {task.warning ? (
                  <div className="mt-2 rounded-lg border border-amber-900/80 bg-amber-950/40 px-2 py-1.5 text-[10px] text-amber-200">
                    {task.warning}
                  </div>
                ) : null}

                {task.error ? (
                  <div className="mt-2 rounded-lg border border-red-950/80 bg-red-950/40 px-2 py-1.5 text-[10px] text-red-200">
                    {task.error}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          ) : null}
        </div>
      ) : null}

      {contextMenu && (contextMenuItem || contextMenuFolderPath !== null) ? (
        <>
          <div
            className="fixed z-40 min-w-44 rounded-xl border border-zinc-800 bg-[#121217] p-1.5 shadow-2xl"
            style={{ left: `${contextMenuPosition?.x ?? 0}px`, top: `${contextMenuPosition?.y ?? 0}px` }}
          >
            {contextMenuFolderPath !== null && contextMenuFolderWritable ? (
              <>
                <button
                  type="button"
                  onClick={() => void createFolderAt(contextMenuFolderPath)}
                  className="flex w-full rounded-lg px-3 py-2 text-left text-[12px] hover:bg-zinc-900"
                >
                  New Folder
                </button>
                {contextMenuFolderPath ? (
                  <button
                    type="button"
                    onClick={() => void duplicateFolderAt(contextMenuFolderPath)}
                    className="flex w-full rounded-lg px-3 py-2 text-left text-[12px] hover:bg-zinc-900"
                  >
                    Duplicate Folder
                  </button>
                ) : null}
                {contextMenuFolderPath ? (
                  <button
                    type="button"
                    onClick={() => void deleteFolderAt(contextMenuFolderPath)}
                    className="flex w-full rounded-lg px-3 py-2 text-left text-[12px] text-red-300 hover:bg-red-950/50"
                  >
                    Delete Folder
                  </button>
                ) : null}
              </>
            ) : null}
            {contextMenuSelectionImages.length >= 1 ? (
              <button
                type="button"
                onMouseEnter={() => setContextSubmenu("background-remove")}
                onClick={() =>
                  setContextSubmenu((prev) =>
                    prev === "background-remove" ? null : "background-remove",
                  )
                }
                className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-[12px] hover:bg-zinc-900"
              >
                <span>
                  {contextMenuSelectionItems.length > 1
                    ? `Remove Background for Selected (${contextMenuSelectionImages.length})`
                    : "Remove Background"}
                </span>
                <span className="text-zinc-500">&gt;</span>
              </button>
            ) : null}
            {contextMenuSelectionImages.length >= 2 ? (
              <button
                type="button"
                onClick={() => openAnimationPreview(contextMenuSelectionImages)}
                className="flex w-full rounded-lg px-3 py-2 text-left text-[12px] hover:bg-zinc-900"
              >
                {`Animation Preview (${contextMenuSelectionImages.length})`}
              </button>
            ) : null}
            {contextMenuSelectionImages.length >= 2 ? (
              <button
                type="button"
                onClick={() => void handleExportPortfolioSheet()}
                className="flex w-full rounded-lg px-3 py-2 text-left text-[12px] hover:bg-zinc-900"
              >
                {`Portfolio Sheet (${contextMenuSelectionImages.length})`}
              </button>
            ) : null}
            {contextMenuSingleVideo ? (
              <button
                type="button"
                onClick={() => void handleExportBestCuts(contextMenuSingleVideo)}
                className="flex w-full rounded-lg px-3 py-2 text-left text-[12px] hover:bg-zinc-900"
              >
                Auto Best Cuts
              </button>
            ) : null}
            {contextMenuSingleVideo ? (
              <button
                type="button"
                onClick={() => void handleExportVideoContactSheet(contextMenuSingleVideo)}
                className="flex w-full rounded-lg px-3 py-2 text-left text-[12px] hover:bg-zinc-900"
              >
                Video Contact Sheet
              </button>
            ) : null}
            {contextMenuSingleVideo ? (
              <button
                type="button"
                onClick={() => void handleExportLoopClip(contextMenuSingleVideo)}
                className="flex w-full rounded-lg px-3 py-2 text-left text-[12px] hover:bg-zinc-900"
              >
                Extract Clip
              </button>
            ) : null}
            {contextMenuSingleVideo ? (
              <button
                type="button"
                onClick={() => void handleSplitVideoScenes(contextMenuSingleVideo)}
                className="flex w-full rounded-lg px-3 py-2 text-left text-[12px] hover:bg-zinc-900"
              >
                Split by Scenes
              </button>
            ) : null}
            {contextMenuSelectionVideos.length >= 1 ? (
              <button
                type="button"
                onMouseEnter={() => setContextSubmenu("extract-frames")}
                onClick={() =>
                  setContextSubmenu((prev) =>
                    prev === "extract-frames" ? null : "extract-frames",
                  )
                }
                className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-[12px] hover:bg-zinc-900"
              >
                <span>
                  {contextMenuSelectionItems.length > 1
                    ? `Extract Frames for Selected (${contextMenuSelectionVideos.length})`
                    : "Extract Frames"}
                </span>
                <span className="text-zinc-500">&gt;</span>
              </button>
            ) : null}
            {contextMenuSelectionItems.length >= 1 || contextMenuFolderPath !== null ? (
              <button
                type="button"
                onClick={applySearchQueryFromContext}
                className="flex w-full rounded-lg px-3 py-2 text-left text-[12px] hover:bg-zinc-900"
              >
                {`Search (${Math.min(
                  contextMenuSelectionItems.length || (contextMenuFolderPath !== null ? 1 : 0),
                  10,
                )})`}
              </button>
            ) : null}
            {contextMenuSelectionItems.length >= 1 ? (
              <button
                type="button"
                onClick={() => void handleResizeSelection()}
                className="flex w-full rounded-lg px-3 py-2 text-left text-[12px] hover:bg-zinc-900"
              >
                {contextMenuSelectionItems.length > 1
                  ? `Resize Preset (${contextMenuSelectionItems.length})`
                  : "Resize Preset"}
              </button>
            ) : null}
            {contextMenuItem && contextMenuSelectionItems.length === 1 && !contextMenuItem.archivePath ? (
              <button
                type="button"
                onClick={() => {
                  if (contextMenuItem) {
                    void duplicateItem(contextMenuItem);
                  }
                }}
                className="flex w-full rounded-lg px-3 py-2 text-left text-[12px] hover:bg-zinc-900"
              >
                Duplicate
              </button>
            ) : null}
            {contextMenuItem && contextMenuSelectionItems.length === 1 && !contextMenuItem.archivePath ? (
              <button
                type="button"
                onClick={() => {
                  if (contextMenuItem) {
                    openRenameForItem(contextMenuItem);
                  }
                }}
                className="flex w-full rounded-lg px-3 py-2 text-left text-[12px] hover:bg-zinc-900"
              >
                Rename
              </button>
            ) : null}
            {contextMenuSelectionItems.length >= 1 &&
            !contextMenuSelectionItems.some((item) => Boolean(item.archivePath)) ? (
              <button
                type="button"
                onClick={() => {
                  setContextSubmenu(null);
                  setContextMenu(null);
                  if (contextMenuSelectionItems.length > 1) {
                    void deleteSelectedItems();
                    return;
                  }
                  if (contextMenuItem) {
                    setActiveId(contextMenuItem.id);
                    void deleteItem(contextMenuItem);
                  } else if (contextMenuSelectionItems[0]) {
                    setActiveId(contextMenuSelectionItems[0].id);
                    void deleteItem(contextMenuSelectionItems[0]);
                  }
                }}
                className="flex w-full rounded-lg px-3 py-2 text-left text-[12px] text-red-300 hover:bg-red-950/50"
              >
                {contextMenuSelectionItems.length > 1
                  ? `Delete Selected (${contextMenuSelectionItems.length})`
                  : "Delete"}
              </button>
            ) : null}
          </div>

          {contextMenuSelectionImages.length >= 1 && contextSubmenu === "background-remove" ? (
            <div
              className="fixed z-[41] min-w-56 rounded-xl border border-zinc-800 bg-[#121217] p-1.5 shadow-2xl"
              style={{
                left: `${backgroundSubmenuPosition?.x ?? 0}px`,
                top: `${backgroundSubmenuPosition?.y ?? 0}px`,
              }}
            >
              <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
                Choose Engine
              </div>
              {BACKGROUND_ENGINES.map((engine) => (
                <button
                  key={engine.key}
                  type="button"
                  onClick={() =>
                    contextMenuSelectionItems.length > 1
                      ? void handleRemoveBackgroundSelected(engine.key)
                      : contextMenuSelectionImages[0]
                        ? void handleRemoveBackground(contextMenuSelectionImages[0], engine.key)
                        : undefined
                  }
                  disabled={contextMenuSelectionImages.length === 0}
                  className="flex w-full rounded-lg px-3 py-2 text-left text-[12px] hover:bg-zinc-900"
                >
                  {engine.label}
                </button>
              ))}
            </div>
          ) : null}
          {contextMenuSelectionVideos.length >= 1 && contextSubmenu === "extract-frames" ? (
            <div
              className="fixed z-[41] min-w-56 rounded-xl border border-zinc-800 bg-[#121217] p-1.5 shadow-2xl"
              style={{
                left: `${extractSubmenuPosition?.x ?? 0}px`,
                top: `${extractSubmenuPosition?.y ?? 0}px`,
              }}
            >
              <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
                Choose Extract Mode
              </div>
              {FRAME_EXTRACT_PRESETS.map((preset) => (
                <button
                  key={preset.key}
                  type="button"
                  onClick={() =>
                    contextMenuSelectionItems.length > 1
                      ? void handleExtractFramesSelected(preset.key)
                      : contextMenuSelectionVideos[0]
                        ? void handleExtractFrames(contextMenuSelectionVideos[0], preset.key)
                        : undefined
                  }
                  disabled={contextMenuSelectionVideos.length === 0}
                  className="flex w-full rounded-lg px-3 py-2 text-left text-[12px] hover:bg-zinc-900"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : null}

      {animationPreviewOpen && animationPreviewItems.length ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/82 p-4">
          <div className="relative flex h-[88vh] w-full max-w-6xl flex-col overflow-hidden rounded-3xl border border-zinc-800 bg-[#101115] shadow-2xl">
            <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-5 py-4">
              <div className="min-w-0">
                <div className="truncate text-[16px] font-semibold">Animation Preview</div>
                <div className="mt-1 truncate text-[11px] text-zinc-500">
                  {animationPreviewItems.length} frames / {animationPreviewFps} FPS
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setAnimationPreviewOpen(false)}
                  className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-[12px] text-zinc-200 hover:bg-zinc-900"
                >
                  Close
                </button>
              </div>
            </div>

            <div className="relative flex-1 overflow-hidden bg-black">
              {currentAnimationFrame ? (
                <img
                  src={currentAnimationFrameUrl}
                  alt={currentAnimationFrame.name}
                  className="h-full w-full object-contain"
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setAnimationContextMenu({ x: event.clientX, y: event.clientY });
                  }}
                />
              ) : null}
            </div>

            <div className="border-t border-zinc-800 px-5 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setAnimationPreviewPlaying((prev) => !prev)}
                  className="rounded-lg bg-white px-3 py-2 text-[12px] font-semibold text-zinc-950"
                >
                  {animationPreviewPlaying ? "Pause" : "Play"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAnimationPreviewPlaying(false);
                    setAnimationPreviewIndex((prev) =>
                      prev === 0 ? animationPreviewItems.length - 1 : prev - 1,
                    );
                  }}
                  className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-[12px] hover:bg-zinc-900"
                >
                  Prev
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAnimationPreviewPlaying(false);
                    setAnimationPreviewIndex((prev) =>
                      prev >= animationPreviewItems.length - 1 ? 0 : prev + 1,
                    );
                  }}
                  className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-[12px] hover:bg-zinc-900"
                >
                  Next
                </button>
                <button
                  type="button"
                  onClick={() => setAnimationPreviewLoop((prev) => !prev)}
                  className={classNames(
                    "rounded-lg border px-3 py-2 text-[12px]",
                    animationPreviewLoop
                      ? "border-emerald-700 bg-emerald-950/50 text-emerald-200"
                      : "border-zinc-800 bg-zinc-950 hover:bg-zinc-900",
                  )}
                >
                  {animationPreviewLoop ? "Loop On" : "Loop Off"}
                </button>
                <button
                  type="button"
                  onClick={() => setAnimationPreviewReverse((prev) => !prev)}
                  className={classNames(
                    "rounded-lg border px-3 py-2 text-[12px]",
                    animationPreviewReverse
                      ? "border-amber-700 bg-amber-950/50 text-amber-200"
                      : "border-zinc-800 bg-zinc-950 hover:bg-zinc-900",
                  )}
                >
                  {animationPreviewReverse ? "Reverse On" : "Reverse Off"}
                </button>
                <div className="ml-2 flex min-w-[220px] items-center gap-3">
                  <span className="text-[11px] text-zinc-500">FPS</span>
                  <input
                    type="range"
                    min={1}
                    max={ANIMATION_PREVIEW_FPS_MAX}
                    value={animationPreviewFps}
                    onChange={(event) => setAnimationPreviewFps(Number(event.target.value))}
                    className="w-full accent-white"
                  />
                  <span className="w-8 text-right text-[11px] font-semibold text-zinc-200">
                    {animationPreviewFps}
                  </span>
                </div>
                <div className="ml-auto text-[11px] text-zinc-500">
                  Frame {Math.min(animationPreviewIndex + 1, animationPreviewItems.length)} /{" "}
                  {animationPreviewItems.length}
                </div>
              </div>
              <div className="mt-2 text-[11px] text-zinc-500">
                Right-click the preview image to export as GIF, WebP, or APNG.
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {animationContextMenu && animationPreviewOpen ? (
        <div
          className="fixed z-[61] min-w-44 rounded-xl border border-zinc-800 bg-[#121217] p-1.5 shadow-2xl"
          style={{ left: `${animationContextMenu.x}px`, top: `${animationContextMenu.y}px` }}
        >
          <button
            type="button"
            onClick={() => void exportAnimationFromPreview("gif")}
            disabled={animationExporting}
            className="flex w-full rounded-lg px-3 py-2 text-left text-[12px] hover:bg-zinc-900 disabled:cursor-wait disabled:opacity-60"
          >
            {animationExporting ? "Exporting..." : "Export as GIF"}
          </button>
          <button
            type="button"
            onClick={() => void exportAnimationFromPreview("webp")}
            disabled={animationExporting}
            className="flex w-full rounded-lg px-3 py-2 text-left text-[12px] hover:bg-zinc-900 disabled:cursor-wait disabled:opacity-60"
          >
            {animationExporting ? "Exporting..." : "Export as WebP"}
          </button>
          <button
            type="button"
            onClick={() => void exportAnimationFromPreview("apng")}
            disabled={animationExporting}
            className="flex w-full rounded-lg px-3 py-2 text-left text-[12px] hover:bg-zinc-900 disabled:cursor-wait disabled:opacity-60"
          >
            {animationExporting ? "Exporting..." : "Export as APNG"}
          </button>
        </div>
      ) : null}

      {actionDialog ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
          <div className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-[#121217] p-4 shadow-2xl">
            <div className="text-[15px] font-semibold">{actionDialogTitle}</div>
            <div className="mt-1 text-[12px] text-zinc-400">{actionDialogDescription}</div>

            {actionDialog.kind === "bestCuts" ? (
              <div className="mt-4 space-y-3">
                <label className="block">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                    Best Cut Count
                  </div>
                  <input
                    autoFocus
                    value={actionDialog.count}
                    onChange={(event) =>
                      setActionDialog((prev) =>
                        prev?.kind === "bestCuts" ? { ...prev, count: event.target.value } : prev,
                      )
                    }
                    className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-[13px] outline-none focus:border-zinc-600"
                  />
                </label>
                <label className="block">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                    Scene Sensitivity
                  </div>
                  <input
                    value={actionDialog.threshold}
                    onChange={(event) =>
                      setActionDialog((prev) =>
                        prev?.kind === "bestCuts" ? { ...prev, threshold: event.target.value } : prev,
                      )
                    }
                    className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-[13px] outline-none focus:border-zinc-600"
                  />
                  <div className="mt-1 text-[11px] text-zinc-500">Recommended: `0.25` to `0.40`. Higher values create fewer cuts.</div>
                </label>
              </div>
            ) : null}

            {actionDialog.kind === "contactSheet" ? (
              <div className="mt-4 grid grid-cols-2 gap-3">
                <label className="block">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Columns</div>
                  <input
                    autoFocus
                    value={actionDialog.columns}
                    onChange={(event) =>
                      setActionDialog((prev) =>
                        prev?.kind === "contactSheet" ? { ...prev, columns: event.target.value } : prev,
                      )
                    }
                    className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-[13px] outline-none focus:border-zinc-600"
                  />
                </label>
                <label className="block">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Rows</div>
                  <input
                    value={actionDialog.rows}
                    onChange={(event) =>
                      setActionDialog((prev) =>
                        prev?.kind === "contactSheet" ? { ...prev, rows: event.target.value } : prev,
                      )
                    }
                    className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-[13px] outline-none focus:border-zinc-600"
                  />
                </label>
              </div>
            ) : null}

            {actionDialog.kind === "loopClip" ? (
              <div className="mt-4 space-y-3">
                <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-black">
                  <video
                    ref={clipPreviewRef}
                    src={actionDialog.item ? assetUrl(actionDialog.item.path) : ""}
                    className="h-[280px] w-full object-contain"
                    controls
                    preload="metadata"
                    muted={videoMuted}
                    onLoadedMetadata={(event) => {
                      const duration = event.currentTarget.duration || 0;
                      setClipPreviewDuration(duration);
                      setClipPreviewCurrentTime(event.currentTarget.currentTime || 0);
                      setActionDialog((prev) =>
                        prev?.kind === "loopClip"
                          ? {
                              ...prev,
                              endSeconds:
                                Number(prev.endSeconds) > 0
                                  ? prev.endSeconds
                                  : duration > 0
                                    ? Math.min(duration, 2.5).toFixed(2)
                                    : "2.5",
                            }
                          : prev,
                      );
                    }}
                    onTimeUpdate={(event) => {
                      setClipPreviewCurrentTime(event.currentTarget.currentTime || 0);
                    }}
                  />
                  <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800 bg-zinc-950/80 px-3 py-2 text-[11px] text-zinc-400">
                    <span>Current: {formatSecondsLabel(clipPreviewCurrentTime)}</span>
                    <span>Duration: {formatSecondsLabel(clipPreviewDuration)}</span>
                    <button
                      type="button"
                      onClick={() =>
                        setActionDialog((prev) =>
                          prev?.kind === "loopClip"
                            ? { ...prev, startSeconds: clipPreviewCurrentTime.toFixed(2) }
                            : prev,
                        )
                      }
                      className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-200 hover:bg-zinc-800"
                    >
                      Use Current as Start
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setActionDialog((prev) =>
                          prev?.kind === "loopClip"
                            ? { ...prev, endSeconds: clipPreviewCurrentTime.toFixed(2) }
                            : prev,
                        )
                      }
                      className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-200 hover:bg-zinc-800"
                    >
                      Use Current as End
                    </button>
                  </div>
                </div>
                <div className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-950/40 p-3">
                  <div className="flex items-center justify-between text-[11px] text-zinc-400">
                    <span>Start</span>
                    <span>{formatSecondsLabel(clipDialogStartValue)}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(clipPreviewDuration, 0.1)}
                    step={0.1}
                    value={clipDialogStartValue}
                    onChange={(event) =>
                      setActionDialog((prev) => {
                        if (prev?.kind !== "loopClip") return prev;
                        const nextStart = Number(event.target.value);
                        const nextEnd = Math.max(nextStart, Number(prev.endSeconds) || nextStart);
                        return {
                          ...prev,
                          startSeconds: nextStart.toFixed(2),
                          endSeconds: nextEnd.toFixed(2),
                        };
                      })
                    }
                    className="w-full accent-white"
                  />
                  <div className="flex items-center justify-between text-[11px] text-zinc-400">
                    <span>End</span>
                    <span>{formatSecondsLabel(clipDialogEndValue)}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(clipPreviewDuration, 0.1)}
                    step={0.1}
                    value={clipDialogEndValue}
                    onChange={(event) =>
                      setActionDialog((prev) => {
                        if (prev?.kind !== "loopClip") return prev;
                        const nextEnd = Number(event.target.value);
                        const nextStart = Math.min(Number(prev.startSeconds) || 0, nextEnd);
                        return {
                          ...prev,
                          startSeconds: nextStart.toFixed(2),
                          endSeconds: nextEnd.toFixed(2),
                        };
                      })
                    }
                    className="w-full accent-white"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Start Time</div>
                    <input
                      value={actionDialog.startSeconds}
                      onChange={(event) =>
                        setActionDialog((prev) =>
                          prev?.kind === "loopClip" ? { ...prev, startSeconds: event.target.value } : prev,
                        )
                      }
                      className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-[13px] outline-none focus:border-zinc-600"
                    />
                  </label>
                  <label className="block">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">End Time</div>
                    <input
                      value={actionDialog.endSeconds}
                      onChange={(event) =>
                        setActionDialog((prev) =>
                          prev?.kind === "loopClip" ? { ...prev, endSeconds: event.target.value } : prev,
                        )
                      }
                      className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-[13px] outline-none focus:border-zinc-600"
                    />
                  </label>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Format</div>
                    <select
                      value={actionDialog.format}
                      onChange={(event) =>
                        setActionDialog((prev) =>
                          prev?.kind === "loopClip"
                            ? { ...prev, format: event.target.value as LoopExportFormat }
                            : prev,
                        )
                      }
                      className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-[13px] outline-none focus:border-zinc-600"
                    >
                      <option value="mp4">MP4</option>
                      <option value="gif">GIF</option>
                      <option value="webp">Animated WebP</option>
                    </select>
                  </label>
                  <label className="block">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">FPS</div>
                    <select
                      value={actionDialog.fps}
                      onChange={(event) =>
                        setActionDialog((prev) =>
                          prev?.kind === "loopClip" ? { ...prev, fps: event.target.value } : prev,
                        )
                      }
                      className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-[13px] outline-none focus:border-zinc-600"
                    >
                      <option value="8">8 FPS</option>
                      <option value="12">12 FPS</option>
                      <option value="15">15 FPS</option>
                      <option value="24">24 FPS</option>
                      <option value="30">30 FPS</option>
                      <option value="60">60 FPS</option>
                    </select>
                  </label>
                </div>
                <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-[12px] text-zinc-300">
                  Output: save the selected range as {actionDialog.format.toUpperCase()} using {actionDialog.fps} FPS.
                </div>
              </div>
            ) : null}

            {actionDialog.kind === "splitScenes" ? (
              <div className="mt-4 space-y-3">
                <label className="block">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Scene Sensitivity</div>
                  <input
                    autoFocus
                    value={actionDialog.threshold}
                    onChange={(event) =>
                      setActionDialog((prev) =>
                        prev?.kind === "splitScenes" ? { ...prev, threshold: event.target.value } : prev,
                      )
                    }
                    className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-[13px] outline-none focus:border-zinc-600"
                  />
                </label>
                <label className="block">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Minimum Scene Length</div>
                  <input
                    value={actionDialog.minSceneSeconds}
                    onChange={(event) =>
                      setActionDialog((prev) =>
                        prev?.kind === "splitScenes" ? { ...prev, minSceneSeconds: event.target.value } : prev,
                      )
                    }
                    className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-[13px] outline-none focus:border-zinc-600"
                  />
                </label>
              </div>
            ) : null}

            {actionDialog.kind === "portfolioSheet" ? (
              <div className="mt-4 space-y-3">
                <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-[12px] text-zinc-300">
                  {actionDialog.imageCount} selected images will be placed on one JPG sheet.
                </div>
                <label className="block">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Columns</div>
                  <input
                    autoFocus
                    value={actionDialog.columns}
                    onChange={(event) =>
                      setActionDialog((prev) =>
                        prev?.kind === "portfolioSheet" ? { ...prev, columns: event.target.value } : prev,
                      )
                    }
                    className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-[13px] outline-none focus:border-zinc-600"
                  />
                </label>
              </div>
            ) : null}

            {actionDialog.kind === "resizePreset" ? (
              <div className="mt-4 space-y-3">
                <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-[12px] text-zinc-300">
                  Apply one output size to {actionDialog.itemCount} selected item(s). Target kinds: {actionDialog.targetKinds}.
                </div>
                <label className="block">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Preset</div>
                  <select
                    autoFocus
                    value={actionDialog.presetKey}
                    onChange={(event) =>
                      setActionDialog((prev) =>
                        prev?.kind === "resizePreset"
                          ? { ...prev, presetKey: event.target.value as ResizePresetKey }
                          : prev,
                      )
                    }
                    className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-[13px] outline-none focus:border-zinc-600"
                  >
                    <option value="square_1080">Square 1080x1080</option>
                    <option value="story_1080x1920">Story 1080x1920</option>
                    <option value="landscape_1920x1080">Landscape 1920x1080</option>
                    <option value="thumb_1280x720">Thumbnail 1280x720</option>
                  </select>
                </label>
              </div>
            ) : null}

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setActionDialog(null)}
                className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-[12px] hover:bg-zinc-900"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submitActionDialog()}
                disabled={isSaving}
                className="rounded-lg bg-white px-3 py-2 text-[12px] font-semibold text-zinc-950 disabled:cursor-wait disabled:opacity-60"
              >
                {isSaving ? "Working..." : "Run"}
              </button>
            </div>
          </div>
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
                <div className="mt-1">
                  {active.kind === "video"
                    ? "Video"
                    : active.kind === "zip"
                      ? "ZIP Archive"
                      : "Image"}
                </div>
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
                <div className="mt-1 break-words">{activeFullPath}</div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {aboutOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
          <div className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-[#121217] p-4 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[15px] font-semibold">About MViewer</div>
                <div className="mt-1 text-[11px] text-zinc-500">Desktop media viewer for local images, videos, and archives.</div>
              </div>
              <button
                type="button"
                onClick={() => setAboutOpen(false)}
                className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-[12px] hover:bg-zinc-900"
              >
                Close
              </button>
            </div>
            <div className="mt-4 space-y-3 rounded-2xl border border-zinc-800 bg-zinc-950/60 p-3 text-[12px] text-zinc-300">
              <div>MViewer is focused on quick browsing, previewing, and lightweight utility actions for local media.</div>
              <div className="text-zinc-500">Current flow: folder browsing, image/video preview, ZIP browsing, background tasks, and utility exports.</div>
            </div>
          </div>
        </div>
      ) : null}

      {manualOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
          <div className="w-full max-w-2xl rounded-2xl border border-zinc-800 bg-[#121217] p-4 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[15px] font-semibold">Manual</div>
                <div className="mt-1 text-[11px] text-zinc-500">Quick guide for the current desktop workflow.</div>
              </div>
              <button
                type="button"
                onClick={() => setManualOpen(false)}
                className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-[12px] hover:bg-zinc-900"
              >
                Close
              </button>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-3">
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Browse</div>
                <div className="mt-2 text-[12px] text-zinc-300">Choose a folder, browse the explorer, and click files to preview them.</div>
              </div>
              <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-3">
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Preview</div>
                <div className="mt-2 text-[12px] text-zinc-300">Keep `Preview` on to inspect the current file. Turn it off for a simpler browsing layout.</div>
              </div>
              <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-3">
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Context Menu</div>
                <div className="mt-2 text-[12px] text-zinc-300">Right-click files or folders to run export, extraction, and utility actions.</div>
              </div>
              <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-3">
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Tasks</div>
                <div className="mt-2 text-[12px] text-zinc-300">Long-running jobs appear in the background task panel at the bottom-right.</div>
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
                  <>
                    {(
                      [
                        ["standard", "Standard"],
                        ["left", "Left Eye"],
                        ["right", "Right Eye"],
                      ] as const
                    ).map(([mode, label]) => (
                      <button
                        key={mode}
                        className={classNames(
                          "rounded-md border px-3 py-1.5 text-xs",
                          videoEyeMode === mode
                            ? "border-sky-700 bg-sky-950/70 text-sky-100 hover:bg-sky-900/70"
                            : "border-zinc-700 bg-zinc-900 hover:bg-zinc-800",
                        )}
                        type="button"
                        onClick={() => setVideoEyeMode(mode)}
                      >
                        {label}
                      </button>
                    ))}
                    <button
                      className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs hover:bg-zinc-800"
                      type="button"
                      onClick={cycleVideoVrLayout}
                    >
                      Layout {videoVrLayoutSetting === "auto" ? "Auto" : resolvedVideoVrLayout.toUpperCase()}
                    </button>
                    <button
                      className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs hover:bg-zinc-800"
                      type="button"
                      onClick={() => setVideoMuted((value) => !value)}
                    >
                      Audio {videoMuted ? "Off" : "On"}
                    </button>
                  </>
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
                  ) : active.kind === "video" ? (
                    renderVideoPreview("bg-black")
                  ) : (
                    <div className="flex h-full w-full items-center justify-center rounded-2xl bg-zinc-950 text-center text-sm text-zinc-400">
                      ZIP archive preview is not available yet.
                    </div>
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




