mod background;
mod external_tools;
mod media_fs;
mod models;

use background::{clear_finished_tasks, cancel_task, enqueue_task, BackgroundRemovalQueue, BackgroundRemovalState, BackgroundTaskDraft};
use external_tools::{
    build_extract_frames_output_dir, build_remove_bg_output_path, detect_ffmpeg_binary,
    export_animation_from_images, frame_extraction_warning, remove_background_warning,
};
use media_fs::{
    create_media_folder as create_media_folder_impl,
    delete_media_file as delete_media_file_impl,
    delete_media_folder as delete_media_folder_impl,
    duplicate_media_file as duplicate_media_file_impl,
    duplicate_media_folder as duplicate_media_folder_impl,
    is_remove_bg_supported_image, media_kind_for_extension,
    rename_media_file as rename_media_file_impl, scan_media_path,
};
use models::{BackgroundTask, ScanResult};
use rfd::FileDialog;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State};

#[tauri::command]
fn pick_root_folder() -> Option<String> {
    FileDialog::new()
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
fn pick_root_archive() -> Option<String> {
    FileDialog::new()
        .add_filter("ZIP archive", &["zip"])
        .pick_file()
        .map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
fn scan_media_folder(root_path: String) -> Result<ScanResult, String> {
    scan_media_path(&PathBuf::from(root_path))
}

#[tauri::command]
fn rename_media_file(file_path: String, new_name: String) -> Result<String, String> {
    rename_media_file_impl(file_path, new_name)
}

#[tauri::command]
fn delete_media_file(file_path: String) -> Result<(), String> {
    delete_media_file_impl(file_path)
}

#[tauri::command]
fn duplicate_media_file(file_path: String) -> Result<String, String> {
    duplicate_media_file_impl(file_path)
}

#[tauri::command]
fn create_media_folder(root_path: String, relative_folder_path: String) -> Result<String, String> {
    create_media_folder_impl(root_path, relative_folder_path)
}

#[tauri::command]
fn duplicate_media_folder(
    root_path: String,
    relative_folder_path: String,
) -> Result<String, String> {
    duplicate_media_folder_impl(root_path, relative_folder_path)
}

#[tauri::command]
fn delete_media_folder(root_path: String, relative_folder_path: String) -> Result<(), String> {
    delete_media_folder_impl(root_path, relative_folder_path)
}

#[tauri::command]
fn enqueue_remove_image_background(
    app: AppHandle,
    state: State<'_, BackgroundRemovalState>,
    file_path: String,
    engine_key: Option<String>,
) -> Result<BackgroundTask, String> {
    let source = PathBuf::from(&file_path);
    if !source.exists() {
        return Err("Selected file no longer exists.".to_string());
    }
    if !source.is_file() {
        return Err("Selected path is not a file.".to_string());
    }
    if !is_remove_bg_supported_image(&source) {
        return Err(
            "Background removal currently supports PNG, JPG, JPEG, WEBP, and BMP files."
                .to_string(),
        );
    }

    let requested_engine = engine_key.unwrap_or_else(|| "auto".to_string());
    let (engine_key, engine_label) = match requested_engine.as_str() {
        "anime" => ("anime".to_string(), "ISNet Anime (Anime)".to_string()),
        "real" => ("real".to_string(), "ISNet General (Real)".to_string()),
        "bria" => ("bria".to_string(), "BRIA RMBG (Real)".to_string()),
        "withoutbg" => ("withoutbg".to_string(), "withoutBG (HQ)".to_string()),
        _ => ("auto".to_string(), "Auto Detect".to_string()),
    };

    let file_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("image")
        .to_string();
    let task = enqueue_task(
        &app,
        &state.inner,
        BackgroundTaskDraft {
            kind: "removeBackground".to_string(),
            engine_key,
            engine_label,
            extract_eye_mode: None,
            extract_layout: None,
            source_path: source.to_string_lossy().to_string(),
            output_path: build_remove_bg_output_path(&source)?.to_string_lossy().to_string(),
            file_name,
            warning: remove_background_warning(&source),
        },
    );
    Ok(task)
}

#[tauri::command]
fn list_background_tasks(state: State<'_, BackgroundRemovalState>) -> Vec<BackgroundTask> {
    state.inner.lock().unwrap().snapshots()
}

#[tauri::command]
fn enqueue_extract_video_frames(
    app: AppHandle,
    state: State<'_, BackgroundRemovalState>,
    file_path: String,
    preset_key: String,
    eye_mode: Option<String>,
    layout: Option<String>,
) -> Result<BackgroundTask, String> {
    let source = PathBuf::from(&file_path);
    if !source.exists() {
        return Err("Selected file no longer exists.".to_string());
    }
    if !source.is_file() {
        return Err("Selected path is not a file.".to_string());
    }

    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{}", value.to_lowercase()))
        .unwrap_or_default();
    if media_kind_for_extension(&extension) != Some("video") {
        return Err("Frame extraction is only available for videos.".to_string());
    }

    detect_ffmpeg_binary(&app, "ffmpeg")?;
    detect_ffmpeg_binary(&app, "ffprobe")?;

    let extract_eye_mode = eye_mode.unwrap_or_else(|| "standard".to_string());
    if !matches!(extract_eye_mode.as_str(), "standard" | "left" | "right") {
        return Err("Unknown eye mode.".to_string());
    }
    let extract_layout = layout.unwrap_or_else(|| "sbs".to_string());
    if !matches!(extract_layout.as_str(), "sbs" | "ou") {
        return Err("Unknown VR layout.".to_string());
    }
    let preset_label = match preset_key.as_str() {
        "summary_12" => "Summary 12 Frames",
        "summary_24" => "Summary 24 Frames",
        "summary_60" => "Summary 60 Frames",
        "fps_30" => "Animation Extract 30 FPS",
        "fps_45" => "Animation Extract 45 FPS",
        "fps_60" => "Animation Extract 60 FPS",
        _ => return Err("Unknown frame extraction preset.".to_string()),
    }
    .to_string();

    let file_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("video")
        .to_string();

    let task = enqueue_task(
        &app,
        &state.inner,
        BackgroundTaskDraft {
            kind: "extractFrames".to_string(),
            engine_key: preset_key,
            engine_label: preset_label,
            extract_eye_mode: Some(extract_eye_mode),
            extract_layout: Some(extract_layout),
            source_path: source.to_string_lossy().to_string(),
            output_path: build_extract_frames_output_dir(&source)?
                .to_string_lossy()
                .to_string(),
            file_name,
            warning: frame_extraction_warning(&source),
        },
    );
    Ok(task)
}

#[tauri::command]
fn export_image_sequence_animation(
    app: AppHandle,
    image_paths: Vec<String>,
    format: String,
    fps: u32,
) -> Result<String, String> {
    export_animation_from_images(&app, &image_paths, &format, fps)
}

#[tauri::command]
fn cancel_background_task(
    app: AppHandle,
    state: State<'_, BackgroundRemovalState>,
    task_id: String,
) -> Result<BackgroundTask, String> {
    cancel_task(&app, &state.inner, task_id)
}

#[tauri::command]
fn clear_finished_background_tasks(state: State<'_, BackgroundRemovalState>) {
    clear_finished_tasks(&state.inner)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(BackgroundRemovalState {
            inner: Arc::new(Mutex::new(BackgroundRemovalQueue::new())),
        })
        .invoke_handler(tauri::generate_handler![
            pick_root_folder,
            pick_root_archive,
            scan_media_folder,
            rename_media_file,
            delete_media_file,
            duplicate_media_file,
            create_media_folder,
            duplicate_media_folder,
            delete_media_folder,
            enqueue_remove_image_background,
            enqueue_extract_video_frames,
            export_image_sequence_animation,
            list_background_tasks,
            cancel_background_task,
            clear_finished_background_tasks
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
