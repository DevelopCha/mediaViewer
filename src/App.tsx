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

const LIST_ITEM_HEIGHT = 96;
const LIST_OVERSCAN = 6;
const IMAGE_ZOOM_MIN = 0.5;
const IMAGE_ZOOM_MAX = 6;
const IMAGE_ZOOM_STEP = 0.2;

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
  onSelect,
}: {
  item: MediaItem;
  isActive: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      className={classNames(
        "flex h-[88px] w-full items-center gap-3 rounded-xl border p-2 text-left transition",
        isActive
          ? "border-zinc-950 bg-zinc-950 text-white dark:border-white dark:bg-white dark:text-zinc-950"
          : "border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900",
      )}
    >
      <div className="h-16 w-20 shrink-0 overflow-hidden rounded-lg bg-zinc-200 dark:bg-zinc-800">
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
        <div className="truncate text-sm font-semibold">
          {item.name}
          <span
            className={classNames(
              "ml-1 text-xs font-normal",
              isActive ? "text-zinc-300 dark:text-zinc-600" : "text-zinc-500 dark:text-zinc-400",
            )}
          >
            {item.ext}
          </span>
        </div>
        <div
          className={classNames(
            "mt-1 truncate text-xs",
            isActive ? "text-zinc-300 dark:text-zinc-600" : "text-zinc-500 dark:text-zinc-400",
          )}
        >
          {item.relativePath}
        </div>
        <div
          className={classNames(
            "mt-1 text-xs",
            isActive ? "text-zinc-300 dark:text-zinc-600" : "text-zinc-500 dark:text-zinc-400",
          )}
        >
          {formatBytes(item.sizeBytes)}
        </div>
      </div>
    </button>
  );
});

function App() {
  const [dark, setDark] = useState(true);
  const [kindFilter, setKindFilter] = useState<"all" | MediaKind>("all");
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("date");
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
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [imageZoom, setImageZoom] = useState(1);
  const [imageOffset, setImageOffset] = useState({ x: 0, y: 0 });
  const [isDraggingImage, setIsDraggingImage] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  const deferredQuery = useDeferredValue(query);

  const filtered = useMemo(() => {
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
          return a.name.localeCompare(b.name);
        case "size":
          return b.sizeBytes - a.sizeBytes;
        case "date":
        default:
          return b.modifiedMs - a.modifiedMs;
      }
    });
    return next;
  }, [filtered, sortKey]);

  const active = useMemo(
    () => (activeId ? items.find((item) => item.id === activeId) ?? null : null),
    [items, activeId],
  );

  const previewSourceUrl = useMemo(
    () => (active ? assetUrl(active.path) : ""),
    [active?.path],
  );

  useEffect(() => {
    setRenameValue(active?.name ?? "");
  }, [active?.id, active?.name]);

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
      await loadFolder(rootPath, renamedPath);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to rename the selected file.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete() {
    if (!active || !rootPath) return;
    const confirmed = window.confirm(`Delete "${active.name + active.ext}"?`);
    if (!confirmed) return;

    setIsSaving(true);
    setErrorMessage("");

    try {
      await invoke("delete_media_file", {
        filePath: active.path,
      });
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

  const previewContent = active ? (
    active.kind === "image" ? (
      <img
        src={previewSourceUrl}
        alt={active.name}
        className="h-full w-full object-contain"
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
      if (event.key === "Escape" && viewerExpanded) {
        event.preventDefault();
        setViewerExpanded(false);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        selectNext(-1);
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        selectNext(1);
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        selectNext(-1);
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        selectNext(1);
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
  }, [active, imageZoom, sorted, viewerExpanded]);

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

  const totalHeight = sorted.length * LIST_ITEM_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollTop / LIST_ITEM_HEIGHT) - LIST_OVERSCAN);
  const visibleCount = Math.ceil((viewportHeight || 0) / LIST_ITEM_HEIGHT) + LIST_OVERSCAN * 2;
  const endIndex = Math.min(sorted.length, startIndex + visibleCount);
  const visibleItems = sorted.slice(startIndex, endIndex);

  return (
    <div className="h-dvh w-dvw overflow-hidden bg-zinc-100 text-zinc-950 dark:bg-[#0d0d10] dark:text-zinc-50">
      <div className="grid h-full w-full grid-cols-[310px_minmax(0,1fr)_272px]">
        <aside className="flex min-h-0 flex-col border-r border-zinc-200 bg-white/90 dark:border-zinc-800 dark:bg-[#121217]">
          <div className="border-b border-zinc-200 p-4 dark:border-zinc-800">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xl font-semibold">Media Vault</div>
                <div className="mt-1 truncate text-sm text-zinc-500 dark:text-zinc-400">
                  Optimized list rendering with lighter video previews.
                </div>
              </div>
              <button
                className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:hover:bg-zinc-900"
                onClick={() => setDark((value) => !value)}
                type="button"
              >
                {dark ? "Dark" : "Light"}
              </button>
            </div>

            <button
              className="mt-4 w-full rounded-lg bg-zinc-950 px-4 py-3 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-wait disabled:opacity-70 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
              type="button"
              onClick={handlePickRootFolder}
              disabled={isLoading || isSaving}
            >
              {isLoading ? "Scanning Folder..." : "Choose Root Folder"}
            </button>

            <div className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/60">
              <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Root
              </div>
              <div className="mt-1 text-sm font-medium">{rootFolderName || "No folder selected"}</div>
              {rootPath ? (
                <div className="mt-2 break-words text-xs text-zinc-500 dark:text-zinc-400">
                  {rootPath}
                </div>
              ) : null}
            </div>

            <div className="mt-4 space-y-3">
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search in the list"
                className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-sm outline-none placeholder:text-zinc-400 focus:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-950 dark:focus:border-zinc-600"
              />

              <div className="flex items-center gap-2">
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
                      "rounded-md px-3 py-1.5 text-xs",
                      kindFilter === key
                        ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"
                        : "border border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900",
                    )}
                  >
                    {label}
                  </button>
                ))}

                <select
                  className="ml-auto rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-xs dark:border-zinc-800 dark:bg-zinc-950"
                  value={sortKey}
                  onChange={(event) => setSortKey(event.target.value as SortKey)}
                >
                  <option value="date">Date</option>
                  <option value="name">Name</option>
                  <option value="size">Size</option>
                </select>
              </div>

              <div className="text-xs text-zinc-500 dark:text-zinc-400">
                {sorted.length} items
              </div>
            </div>
          </div>

          <div
            ref={listRef}
            className="min-h-0 flex-1 overflow-auto p-3"
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
                      onSelect={setActiveId}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </aside>

        <main className="flex min-h-0 flex-col bg-zinc-200/40 dark:bg-[#0b0b0d]">
          <div className="border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
            <div className="text-xs uppercase tracking-[0.2em] text-zinc-500 dark:text-zinc-400">
              Preview
            </div>
            <div className="mt-1 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="truncate text-base font-semibold">
                  {active ? active.name + active.ext : "Select a file"}
                </div>
                <div className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
                  {active ? active.relativePath : "The center view stays focused on one file."}
                </div>
              </div>
              {active ? (
                <div className="flex shrink-0 items-center gap-2">
                  <div className="rounded-full border border-zinc-200 bg-white px-3 py-1 text-xs dark:border-zinc-800 dark:bg-zinc-950">
                    {active.kind === "video" ? "Video" : "Image"}
                  </div>
                  <button
                    type="button"
                    onClick={() => setViewerExpanded(true)}
                    className="rounded-full border border-zinc-200 bg-white px-3 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900"
                  >
                    Expand
                  </button>
                </div>
              ) : null}
            </div>
          </div>

          <div className="min-h-0 flex-1 p-3">
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
                    className="absolute left-3 top-1/2 z-10 -translate-y-1/2 rounded-full border border-zinc-700 bg-black/70 px-3 py-2 text-lg font-semibold text-white hover:bg-black/85"
                    aria-label="Previous item"
                  >
                    &lt;
                  </button>
                  <button
                    type="button"
                    onClick={() => selectNext(1)}
                    className="absolute right-3 top-1/2 z-10 -translate-y-1/2 rounded-full border border-zinc-700 bg-black/70 px-3 py-2 text-lg font-semibold text-white hover:bg-black/85"
                    aria-label="Next item"
                  >
                    &gt;
                  </button>
                </>
              ) : null}
            </div>
          </div>
        </main>

        <aside className="flex min-h-0 flex-col border-l border-zinc-200 bg-white/90 dark:border-zinc-800 dark:bg-[#121217]">
          <div className="border-b border-zinc-200 p-5 dark:border-zinc-800">
            <div className="text-base font-semibold">Actions</div>
            <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              Rename or delete the currently selected target.
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-5">
            {active ? (
              <div className="space-y-5">
                <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950/60">
                  <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                    Selected item
                  </div>
                  <div className="mt-2 break-words text-lg font-semibold">
                    {active.name + active.ext}
                  </div>
                  <div className="mt-2 break-words text-xs text-zinc-500 dark:text-zinc-400">
                    {active.path}
                  </div>
                </div>

                <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950/60">
                  <div className="text-sm font-semibold">Rename</div>
                  <input
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                    className="mt-3 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-sm outline-none placeholder:text-zinc-400 focus:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-950 dark:focus:border-zinc-600"
                    placeholder="New file name"
                  />
                  <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                    Keep the extension out if you only want to rename the title.
                  </div>
                  <button
                    type="button"
                    onClick={handleRename}
                    disabled={isSaving || isLoading || !renameValue.trim()}
                    className="mt-3 w-full rounded-lg bg-zinc-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-wait disabled:opacity-60 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
                  >
                    {isSaving ? "Applying..." : "Rename Selected File"}
                  </button>
                </div>

                <div className="rounded-2xl border border-red-200 bg-red-50 p-4 dark:border-red-900/70 dark:bg-red-950/30">
                  <div className="text-sm font-semibold text-red-700 dark:text-red-200">
                    Delete
                  </div>
                  <div className="mt-2 text-sm text-red-700/80 dark:text-red-200/80">
                    This removes the selected file from disk.
                  </div>
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={isSaving || isLoading}
                    className="mt-3 w-full rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-500 disabled:cursor-wait disabled:opacity-60"
                  >
                    {isSaving ? "Applying..." : "Delete Selected File"}
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-3 rounded-2xl border border-zinc-200 bg-zinc-50 p-4 text-sm dark:border-zinc-800 dark:bg-zinc-950/60">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                      Size
                    </div>
                    <div className="mt-1">{formatBytes(active.sizeBytes)}</div>
                  </div>
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                      Modified
                    </div>
                    <div className="mt-1 text-xs">{formatDate(active.modifiedMs)}</div>
                  </div>
                  <div className="col-span-2">
                    <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                      Relative path
                    </div>
                    <div className="mt-1 break-words text-xs">{active.relativePath}</div>
                  </div>
                </div>

                {active.kind === "video" ? (
                  <button
                    className="w-full rounded-lg border border-zinc-200 bg-white px-4 py-2.5 text-sm font-semibold hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900"
                    type="button"
                    onClick={() => setVideoMuted((value) => !value)}
                  >
                    Audio {videoMuted ? "Off" : "On"}
                  </button>
                ) : null}
              </div>
            ) : (
              <div className="text-sm text-zinc-500 dark:text-zinc-400">
                Select a file from the list to work on it here.
              </div>
            )}

            {errorMessage ? (
              <div className="mt-5 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/70 dark:bg-red-950/40 dark:text-red-200">
                {errorMessage}
              </div>
            ) : null}
          </div>
        </aside>
      </div>

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
