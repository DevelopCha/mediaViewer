mod background;
mod external_tools;
mod media_fs;
mod models;

use background::{
    cancel_task, clear_finished_tasks, enqueue_task, BackgroundRemovalQueue,
    BackgroundRemovalState, BackgroundTaskDraft,
};
use external_tools::{
    build_best_cuts_output_dir, build_best_cuts_output_dir_in, build_extract_frames_output_dir,
    build_extract_frames_output_dir_in, build_loop_clip_output_path,
    build_loop_clip_output_path_in, build_portfolio_sheet_output_path,
    build_portfolio_sheet_output_path_in, build_remove_bg_output_path,
    build_remove_bg_output_path_in, build_resized_output_path, build_resized_output_path_in,
    build_scene_split_output_dir, build_scene_split_output_dir_in,
    build_video_contact_sheet_output_path, build_video_contact_sheet_output_path_in,
    detect_ffmpeg_binary, export_animation_from_images,
    export_portfolio_sheet as export_portfolio_sheet_impl,
    export_video_best_cuts as export_video_best_cuts_impl,
    export_video_contact_sheet as export_video_contact_sheet_impl,
    export_video_loop_clip as export_video_loop_clip_impl, frame_extraction_warning,
    remove_background_warning, resize_media_with_preset, split_video_into_scenes,
};
use media_fs::{
    create_media_folder as create_media_folder_impl, delete_media_file as delete_media_file_impl,
    delete_media_folder as delete_media_folder_impl,
    duplicate_media_file as duplicate_media_file_impl,
    duplicate_media_folder as duplicate_media_folder_impl, is_remove_bg_supported_image,
    media_kind_for_extension, rename_media_file as rename_media_file_impl, scan_media_path,
};
use models::{BackgroundTask, ScanResult};
use rfd::FileDialog;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{image::Image, AppHandle, Manager, State};

fn preferred_output_parent(
    preferred_output_root: Option<String>,
) -> Result<Option<PathBuf>, String> {
    let Some(root) = preferred_output_root else {
        return Ok(None);
    };
    let path = PathBuf::from(root);
    if !path.exists() {
        return Err("Preferred output folder no longer exists.".to_string());
    }
    if !path.is_dir() {
        return Err("Preferred output path is not a folder.".to_string());
    }
    Ok(Some(path))
}

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
    preferred_output_root: Option<String>,
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
    let preferred_parent = preferred_output_parent(preferred_output_root)?;
    let output_path = if let Some(parent) = preferred_parent.as_deref() {
        build_remove_bg_output_path_in(
            parent,
            source
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("image"),
        )?
    } else {
        build_remove_bg_output_path(&source)?
    };
    let task = enqueue_task(
        &app,
        &state.inner,
        BackgroundTaskDraft {
            kind: "removeBackground".to_string(),
            engine_key,
            engine_label,
            input_paths: None,
            duration_seconds: None,
            extract_eye_mode: None,
            extract_layout: None,
            source_path: source.to_string_lossy().to_string(),
            output_path: output_path.to_string_lossy().to_string(),
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
    preferred_output_root: Option<String>,
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

    let preferred_parent = preferred_output_parent(preferred_output_root)?;
    let output_path = if let Some(parent) = preferred_parent.as_deref() {
        build_extract_frames_output_dir_in(
            parent,
            source
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("video"),
        )?
    } else {
        build_extract_frames_output_dir(&source)?
    };
    let task = enqueue_task(
        &app,
        &state.inner,
        BackgroundTaskDraft {
            kind: "extractFrames".to_string(),
            engine_key: preset_key,
            engine_label: preset_label,
            input_paths: None,
            duration_seconds: None,
            extract_eye_mode: Some(extract_eye_mode),
            extract_layout: Some(extract_layout),
            source_path: source.to_string_lossy().to_string(),
            output_path: output_path.to_string_lossy().to_string(),
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
    reverse: bool,
    preferred_output_root: Option<String>,
) -> Result<String, String> {
    let preferred_parent = preferred_output_parent(preferred_output_root)?;
    export_animation_from_images(
        &app,
        &image_paths,
        &format,
        fps,
        reverse,
        preferred_parent.as_deref(),
    )
}

#[tauri::command]
fn export_video_best_cuts(
    app: AppHandle,
    file_path: String,
    count: usize,
    threshold: f64,
    preferred_output_root: Option<String>,
) -> Result<String, String> {
    let source = PathBuf::from(&file_path);
    if !source.exists() || !source.is_file() {
        return Err("Selected video no longer exists.".to_string());
    }
    let preferred_parent = preferred_output_parent(preferred_output_root)?;
    let output_dir = if let Some(parent) = preferred_parent.as_deref() {
        build_best_cuts_output_dir_in(
            parent,
            source
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("video"),
        )?
    } else {
        build_best_cuts_output_dir(&source)?
    };
    export_video_best_cuts_impl(
        &app,
        &file_path,
        &output_dir.to_string_lossy(),
        count.max(1),
        threshold,
    )?;
    Ok(output_dir.to_string_lossy().to_string())
}

#[tauri::command]
fn export_video_contact_sheet(
    app: AppHandle,
    file_path: String,
    columns: u32,
    rows: u32,
    preferred_output_root: Option<String>,
) -> Result<String, String> {
    let source = PathBuf::from(&file_path);
    if !source.exists() || !source.is_file() {
        return Err("Selected video no longer exists.".to_string());
    }
    let preferred_parent = preferred_output_parent(preferred_output_root)?;
    let output_path = if let Some(parent) = preferred_parent.as_deref() {
        build_video_contact_sheet_output_path_in(
            parent,
            source
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("video"),
        )?
    } else {
        build_video_contact_sheet_output_path(&source)?
    };
    export_video_contact_sheet_impl(
        &app,
        &file_path,
        &output_path.to_string_lossy(),
        columns.max(1),
        rows.max(1),
    )?;
    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
fn export_video_loop_clip(
    app: AppHandle,
    file_path: String,
    start_seconds: f64,
    duration_seconds: f64,
    format: String,
    fps: u32,
    preferred_output_root: Option<String>,
) -> Result<String, String> {
    let source = PathBuf::from(&file_path);
    if !source.exists() || !source.is_file() {
        return Err("Selected video no longer exists.".to_string());
    }
    let preferred_parent = preferred_output_parent(preferred_output_root)?;
    let output_path = if let Some(parent) = preferred_parent.as_deref() {
        build_loop_clip_output_path_in(
            parent,
            source
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("video"),
            &format,
        )?
    } else {
        build_loop_clip_output_path(&source, &format)?
    };
    export_video_loop_clip_impl(
        &app,
        &file_path,
        &output_path.to_string_lossy(),
        start_seconds,
        duration_seconds,
        &format,
        fps.max(1),
    )?;
    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
fn split_video_by_scenes(
    app: AppHandle,
    file_path: String,
    threshold: f64,
    min_scene_seconds: f64,
    preferred_output_root: Option<String>,
) -> Result<String, String> {
    let source = PathBuf::from(&file_path);
    if !source.exists() || !source.is_file() {
        return Err("Selected video no longer exists.".to_string());
    }
    let preferred_parent = preferred_output_parent(preferred_output_root)?;
    let output_dir = if let Some(parent) = preferred_parent.as_deref() {
        build_scene_split_output_dir_in(
            parent,
            source
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("video"),
        )?
    } else {
        build_scene_split_output_dir(&source)?
    };
    split_video_into_scenes(
        &app,
        &file_path,
        &output_dir.to_string_lossy(),
        threshold,
        min_scene_seconds,
    )?;
    Ok(output_dir.to_string_lossy().to_string())
}

#[tauri::command]
fn export_portfolio_sheet(
    image_paths: Vec<String>,
    columns: u32,
    preferred_output_root: Option<String>,
) -> Result<String, String> {
    let paths: Vec<PathBuf> = image_paths.iter().map(PathBuf::from).collect();
    let preferred_parent = preferred_output_parent(preferred_output_root)?;
    let output_path = if let Some(parent) = preferred_parent.as_deref() {
        let base_name = paths
            .first()
            .and_then(|path| path.file_stem())
            .and_then(|value| value.to_str())
            .unwrap_or("portfolio");
        build_portfolio_sheet_output_path_in(parent, base_name)?
    } else {
        build_portfolio_sheet_output_path(&paths)?
    };
    export_portfolio_sheet_impl(&image_paths, &output_path.to_string_lossy(), columns.max(1))?;
    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
fn resize_media_file_with_preset(
    app: AppHandle,
    file_path: String,
    preset_key: String,
    preferred_output_root: Option<String>,
) -> Result<String, String> {
    let source = PathBuf::from(&file_path);
    if !source.exists() || !source.is_file() {
        return Err("Selected file no longer exists.".to_string());
    }
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_lowercase())
        .unwrap_or_default();
    let is_video = matches!(
        extension.as_str(),
        "mp4" | "mov" | "m4v" | "webm" | "mkv" | "avi" | "wmv"
    );
    let output_extension = if is_video {
        "mp4".to_string()
    } else if matches!(extension.as_str(), "jpg" | "jpeg" | "png" | "webp" | "bmp") {
        extension.clone()
    } else {
        "png".to_string()
    };
    let suffix = match preset_key.as_str() {
        "square_1080" => "sq1080",
        "story_1080x1920" => "story",
        "landscape_1920x1080" => "hd",
        "thumb_1280x720" => "thumb",
        _ => return Err("Unknown resize preset.".to_string()),
    };
    let preferred_parent = preferred_output_parent(preferred_output_root)?;
    let output_path = if let Some(parent) = preferred_parent.as_deref() {
        build_resized_output_path_in(
            parent,
            source
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("file"),
            suffix,
            &output_extension,
        )?
    } else {
        build_resized_output_path(&source, suffix, &output_extension)?
    };
    resize_media_with_preset(
        &app,
        &file_path,
        &output_path.to_string_lossy(),
        &preset_key,
    )?;
    Ok(output_path.to_string_lossy().to_string())
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
        .setup(|app| {
            let icon_path = std::env::current_dir()
                .map(|dir| dir.join("icons").join("32x32.png"))
                .map_err(|error| error.to_string())?;
            let icon_image = image::open(&icon_path)
                .map_err(|error| format!("Failed to open dev icon at {}: {error}", icon_path.display()))?
                .into_rgba8();
            let (width, height) = icon_image.dimensions();
            let icon = Image::new_owned(icon_image.into_raw(), width, height);

            for window in app.webview_windows().values() {
                window
                    .set_icon(icon.clone())
                    .map_err(|error| error.to_string())?;
            }

            Ok(())
        })
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
            export_video_best_cuts,
            export_video_contact_sheet,
            export_video_loop_clip,
            split_video_by_scenes,
            export_portfolio_sheet,
            resize_media_file_with_preset,
            list_background_tasks,
            cancel_background_task,
            clear_finished_background_tasks
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
