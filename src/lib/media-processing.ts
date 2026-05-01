import type { CSSProperties } from "react";

export type BackgroundTaskStatus = "queued" | "running" | "completed" | "failed";
export type BackgroundEngineKey = "anime" | "real" | "bria" | "withoutbg";
export type FrameExtractPresetKey =
  | "summary_12"
  | "summary_24"
  | "summary_60"
  | "fps_30"
  | "fps_45"
  | "fps_60";
export type AnimationExportFormat = "gif" | "webp" | "apng";
export type ContextSubmenu =
  | "background-remove"
  | "extract-frames"
  | null;
export type VideoVrLayout = "sbs" | "ou";
export type VideoVrLayoutSetting = "auto" | VideoVrLayout;
export type VideoEyeMode = "standard" | "left" | "right";
export type ContextMenuState =
  | { x: number; y: number; target: "item"; itemId: string }
  | { x: number; y: number; target: "folder"; folderPath: string };

export type BackgroundTask = {
  id: string;
  kind: string;
  engineKey: string;
  engineLabel: string;
  inputPaths?: string[] | null;
  durationSeconds?: number | null;
  extractEyeMode?: VideoEyeMode | null;
  extractLayout?: VideoVrLayout | null;
  sourcePath: string;
  outputPath: string;
  fileName: string;
  status: BackgroundTaskStatus;
  progress: number;
  message: string;
  createdAtMs: number;
  updatedAtMs: number;
  error: string | null;
  warning?: string | null;
};

export const BACKGROUND_ENGINES: Array<{
  key: BackgroundEngineKey;
  label: string;
}> = [
  { key: "anime", label: "ISNet Anime (Anime)" },
  { key: "real", label: "ISNet General (Real)" },
  { key: "bria", label: "BRIA RMBG (Real)" },
  { key: "withoutbg", label: "withoutBG (HQ)" },
];

export const FRAME_EXTRACT_PRESETS: Array<{
  key: FrameExtractPresetKey;
  label: string;
}> = [
  { key: "summary_12", label: "Summary 12 Frames" },
  { key: "summary_24", label: "Summary 24 Frames" },
  { key: "summary_60", label: "Summary 60 Frames" },
  { key: "fps_30", label: "Animation Extract 30 FPS" },
  { key: "fps_45", label: "Animation Extract 45 FPS" },
  { key: "fps_60", label: "Animation Extract 60 FPS" },
];

export function resolveVideoVrLayout(
  setting: VideoVrLayoutSetting,
  dimensions: { width: number; height: number } | null,
): VideoVrLayout {
  if (setting !== "auto") {
    return setting;
  }

  if (dimensions && dimensions.height > dimensions.width) {
    return "ou";
  }

  return "sbs";
}

export function videoVrTransformStyle(
  mode: VideoEyeMode,
  layout: VideoVrLayout,
): CSSProperties | undefined {
  if (mode === "standard") {
    return undefined;
  }

  if (layout === "ou") {
    if (mode === "right") {
      return {
        transform: "translateY(-100%) scaleY(2)",
        transformOrigin: "center top",
      };
    }

    return {
      transform: "scaleY(2)",
      transformOrigin: "center top",
    };
  }

  if (mode === "right") {
    return {
      transform: "translateX(-100%) scaleX(2)",
      transformOrigin: "left center",
    };
  }

  return {
    transform: "scaleX(2)",
    transformOrigin: "left center",
  };
}

export function upsertBackgroundTask(tasks: BackgroundTask[], task: BackgroundTask) {
  const existingIndex = tasks.findIndex((candidate) => candidate.id === task.id);
  if (existingIndex < 0) {
    return [task, ...tasks];
  }

  const next = [...tasks];
  next[existingIndex] = task;
  return next.sort((a, b) => b.createdAtMs - a.createdAtMs);
}

export function backgroundTaskLabel(status: BackgroundTaskStatus) {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    default:
      return status;
  }
}

export function backgroundTaskProgressLabel(task: BackgroundTask) {
  if (task.status === "queued") {
    return "Waiting";
  }
  if (task.status === "running") {
    return `${Math.max(1, task.progress)}%`;
  }
  if (task.status === "failed") {
    return "Failed";
  }
  return `${task.progress}%`;
}
