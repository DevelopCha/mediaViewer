import type { CSSProperties } from "react";
import { bi } from "./i18n";

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
  readonly label: string;
}> = [
  { key: "anime", get label() { return bi("ISNet Anime (Anime)", "ISNet 애니메 (애니)"); } },
  { key: "real", get label() { return bi("ISNet General (Real)", "ISNet 일반형 (실사)"); } },
  { key: "bria", get label() { return bi("BRIA RMBG (Real)", "BRIA RMBG (실사)"); } },
  { key: "withoutbg", get label() { return bi("withoutBG (HQ)", "withoutBG (고품질)"); } },
];

export const FRAME_EXTRACT_PRESETS: Array<{
  key: FrameExtractPresetKey;
  readonly label: string;
}> = [
  { key: "summary_12", get label() { return bi("Summary 12 Frames", "요약 12프레임"); } },
  { key: "summary_24", get label() { return bi("Summary 24 Frames", "요약 24프레임"); } },
  { key: "summary_60", get label() { return bi("Summary 60 Frames", "요약 60프레임"); } },
  { key: "fps_30", get label() { return bi("Animation Extract 30 FPS", "애니메이션 추출 30 FPS"); } },
  { key: "fps_45", get label() { return bi("Animation Extract 45 FPS", "애니메이션 추출 45 FPS"); } },
  { key: "fps_60", get label() { return bi("Animation Extract 60 FPS", "애니메이션 추출 60 FPS"); } },
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
      return bi("Queued", "대기 중");
    case "running":
      return bi("Running", "실행 중");
    case "completed":
      return bi("Completed", "완료");
    case "failed":
      return bi("Failed", "실패");
    default:
      return status;
  }
}

export function backgroundTaskProgressLabel(task: BackgroundTask) {
  if (task.status === "queued") {
    return bi("Waiting", "대기");
  }
  if (task.status === "running") {
    return `${Math.max(1, task.progress)}%`;
  }
  if (task.status === "failed") {
    return bi("Failed", "실패");
  }
  return `${task.progress}%`;
}
