import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ScanResult } from "./media-browser";
import type {
  AnimationExportFormat,
  BackgroundEngineKey,
  BackgroundTask,
  FrameExtractPresetKey,
  VideoEyeMode,
  VideoVrLayout,
} from "./media-processing";

export function assetUrl(path: string) {
  return convertFileSrc(path);
}

export function listBackgroundTasks() {
  return invoke<BackgroundTask[]>("list_background_tasks");
}

export function onBackgroundTaskUpdate(
  listener: (task: BackgroundTask) => void,
) {
  return listen<BackgroundTask>("background-task-updated", (event) => {
    listener(event.payload);
  });
}

export function scanMediaFolder(rootPath: string) {
  return invoke<ScanResult>("scan_media_folder", { rootPath });
}

export function pickRootFolder() {
  return invoke<string | null>("pick_root_folder");
}

export function pickRootArchive() {
  return invoke<string | null>("pick_root_archive");
}

export function renameMediaFile(filePath: string, newName: string) {
  return invoke<string>("rename_media_file", { filePath, newName });
}

export function deleteMediaFile(filePath: string) {
  return invoke("delete_media_file", { filePath });
}

export function duplicateMediaFile(filePath: string) {
  return invoke<string>("duplicate_media_file", { filePath });
}

export function createMediaFolder(rootPath: string, relativeFolderPath: string) {
  return invoke<string>("create_media_folder", { rootPath, relativeFolderPath });
}

export function duplicateMediaFolder(rootPath: string, relativeFolderPath: string) {
  return invoke<string>("duplicate_media_folder", { rootPath, relativeFolderPath });
}

export function deleteMediaFolder(rootPath: string, relativeFolderPath: string) {
  return invoke("delete_media_folder", { rootPath, relativeFolderPath });
}

export function enqueueRemoveImageBackground(
  filePath: string,
  engineKey: BackgroundEngineKey,
  preferredOutputRoot?: string | null,
) {
  return invoke<BackgroundTask>("enqueue_remove_image_background", {
    filePath,
    engineKey,
    preferredOutputRoot,
  });
}

export function enqueueExtractVideoFrames(
  filePath: string,
  presetKey: FrameExtractPresetKey,
  eyeMode: VideoEyeMode,
  layout: VideoVrLayout,
  preferredOutputRoot?: string | null,
) {
  return invoke<BackgroundTask>("enqueue_extract_video_frames", {
    filePath,
    presetKey,
    eyeMode,
    layout,
    preferredOutputRoot,
  });
}

export function cancelBackgroundTask(taskId: string) {
  return invoke<BackgroundTask>("cancel_background_task", { taskId });
}

export function clearFinishedBackgroundTasks() {
  return invoke("clear_finished_background_tasks");
}

export function exportImageSequenceAnimation(
  imagePaths: string[],
  format: AnimationExportFormat,
  fps: number,
  reverse: boolean,
  preferredOutputRoot?: string | null,
) {
  return invoke<string>("export_image_sequence_animation", {
    imagePaths,
    format,
    fps,
    reverse,
    preferredOutputRoot,
  });
}

export function exportVideoBestCuts(
  filePath: string,
  count: number,
  threshold: number,
  preferredOutputRoot?: string | null,
) {
  return invoke<string>("export_video_best_cuts", {
    filePath,
    count,
    threshold,
    preferredOutputRoot,
  });
}

export function exportVideoContactSheet(
  filePath: string,
  columns: number,
  rows: number,
  preferredOutputRoot?: string | null,
) {
  return invoke<string>("export_video_contact_sheet", {
    filePath,
    columns,
    rows,
    preferredOutputRoot,
  });
}

export function exportVideoLoopClip(
  filePath: string,
  startSeconds: number,
  durationSeconds: number,
  format: "mp4" | "gif" | "webp",
  fps: number,
  preferredOutputRoot?: string | null,
) {
  return invoke<string>("export_video_loop_clip", {
    filePath,
    startSeconds,
    durationSeconds,
    format,
    fps,
    preferredOutputRoot,
  });
}

export function splitVideoByScenes(
  filePath: string,
  threshold: number,
  minSceneSeconds: number,
  preferredOutputRoot?: string | null,
) {
  return invoke<string>("split_video_by_scenes", {
    filePath,
    threshold,
    minSceneSeconds,
    preferredOutputRoot,
  });
}

export function exportPortfolioSheet(
  imagePaths: string[],
  columns: number,
  preferredOutputRoot?: string | null,
) {
  return invoke<string>("export_portfolio_sheet", {
    imagePaths,
    columns,
    preferredOutputRoot,
  });
}

export function resizeMediaFileWithPreset(
  filePath: string,
  presetKey: string,
  preferredOutputRoot?: string | null,
) {
  return invoke<string>("resize_media_file_with_preset", {
    filePath,
    presetKey,
    preferredOutputRoot,
  });
}
