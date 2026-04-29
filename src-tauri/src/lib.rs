use chrono::Local;
use rfd::FileDialog;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::fs;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};
use walkdir::WalkDir;

const BACKGROUND_TASK_EVENT: &str = "background-task-updated";
const MAX_BACKGROUND_TASK_HISTORY: usize = 30;
const LARGE_IMAGE_WARNING_BYTES: u64 = 12 * 1024 * 1024;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaItem {
    id: String,
    kind: String,
    name: String,
    path: String,
    relative_path: String,
    ext: String,
    size_bytes: u64,
    modified_ms: u128,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanResult {
    root_path: String,
    root_name: String,
    items: Vec<MediaItem>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackgroundTask {
    id: String,
    kind: String,
    engine_key: String,
    engine_label: String,
    source_path: String,
    output_path: String,
    file_name: String,
    status: String,
    progress: u8,
    message: String,
    created_at_ms: u128,
    updated_at_ms: u128,
    error: Option<String>,
    warning: Option<String>,
}

struct BackgroundRemovalState {
    inner: Arc<Mutex<BackgroundRemovalQueue>>,
}

struct BackgroundRemovalQueue {
    tasks: HashMap<String, BackgroundTask>,
    order: Vec<String>,
    pending: VecDeque<String>,
    worker_running: bool,
    next_id: u64,
}

impl BackgroundRemovalQueue {
    fn new() -> Self {
        Self {
            tasks: HashMap::new(),
            order: Vec::new(),
            pending: VecDeque::new(),
            worker_running: false,
            next_id: 1,
        }
    }

    fn snapshots(&self) -> Vec<BackgroundTask> {
        self.order
            .iter()
            .rev()
            .filter_map(|id| self.tasks.get(id).cloned())
            .collect()
    }

    fn prune_history(&mut self) {
        while self.order.len() > MAX_BACKGROUND_TASK_HISTORY {
            let Some(oldest_id) = self.order.first().cloned() else {
                break;
            };

            if self
                .tasks
                .get(&oldest_id)
                .is_some_and(|task| matches!(task.status.as_str(), "queued" | "running"))
            {
                break;
            }

            self.order.remove(0);
            self.tasks.remove(&oldest_id);
        }
    }

    fn remove_from_pending(&mut self, task_id: &str) {
        self.pending.retain(|pending_id| pending_id != task_id);
    }
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn media_kind_for_extension(ext: &str) -> Option<&'static str> {
    match ext {
        ".jpg" | ".jpeg" | ".png" | ".gif" | ".webp" | ".bmp" | ".svg" | ".avif" => {
            Some("image")
        }
        ".mp4" | ".mov" | ".m4v" | ".webm" | ".mkv" | ".avi" | ".wmv" => Some("video"),
        _ => None,
    }
}

fn modified_ms(metadata: &std::fs::Metadata) -> u128 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn silent_command(program: &str) -> Command {
    let mut command = Command::new(program);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

fn detect_python_launcher() -> Result<(String, Vec<String>), String> {
    let candidates = [
        ("py", vec!["-3".to_string(), "--version".to_string()]),
        ("python", vec!["--version".to_string()]),
    ];

    for (program, args) in candidates {
        let output = silent_command(program).args(&args).output();
        if let Ok(output) = output {
            if output.status.success() {
                let run_args = if program == "py" {
                    vec!["-3".to_string()]
                } else {
                    Vec::new()
                };
                return Ok((program.to_string(), run_args));
            }
        }
    }

    Err("Python 3 was not found. Install Python to use background removal.".to_string())
}

fn rembg_venv_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".rembg-venv")
}

fn rembg_python_path() -> PathBuf {
    if cfg!(target_os = "windows") {
        rembg_venv_dir().join("Scripts").join("python.exe")
    } else {
        rembg_venv_dir().join("bin").join("python3")
    }
}

fn run_command(program: &str, args: &[String], working_dir: &Path) -> Result<(), String> {
    let output = silent_command(program)
        .args(args)
        .current_dir(working_dir)
        .output()
        .map_err(|error| error.to_string())?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let details = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        "Command failed without output.".to_string()
    };

    Err(details)
}

fn run_command_without_capture(
    program: &str,
    args: &[String],
    working_dir: &Path,
) -> Result<(), String> {
    let status = silent_command(program)
        .args(args)
        .current_dir(working_dir)
        .status()
        .map_err(|error| error.to_string())?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("Command failed with status {status}."))
    }
}

fn ensure_rembg_python() -> Result<PathBuf, String> {
    let venv_python = rembg_python_path();
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));

    if !venv_python.exists() {
        let (launcher, launcher_args) = detect_python_launcher()?;
        let mut args = launcher_args;
        args.extend([
            "-m".to_string(),
            "venv".to_string(),
            rembg_venv_dir().to_string_lossy().to_string(),
        ]);
        run_command(&launcher, &args, &manifest_dir).map_err(|error| {
            format!("Failed to create the background-removal environment. {error}")
        })?;
    }

    let check_args = vec![
        "-c".to_string(),
        "import rembg, onnxruntime, withoutbg, PIL".to_string(),
    ];

    if run_command(&venv_python.to_string_lossy(), &check_args, &manifest_dir).is_err() {
        let install_args = vec![
            "-m".to_string(),
            "pip".to_string(),
            "install".to_string(),
            "--disable-pip-version-check".to_string(),
            "rembg==2.0.66".to_string(),
            "onnxruntime".to_string(),
            "pillow".to_string(),
            "huggingface_hub".to_string(),
            "withoutbg".to_string(),
        ];

        run_command(&venv_python.to_string_lossy(), &install_args, &manifest_dir).map_err(
            |error| format!("Failed to install background-removal dependencies. {error}"),
        )?;
    }

    Ok(venv_python)
}

fn is_remove_bg_supported_image(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_lowercase())
            .as_deref(),
        Some("png" | "jpg" | "jpeg" | "webp" | "bmp")
    )
}

fn numbered_child_dir(parent: &Path, base_name: &str) -> PathBuf {
    let mut index = 1;
    let mut candidate = parent.join(format!("{base_name}_{index}"));

    while candidate.exists() {
        index += 1;
        candidate = parent.join(format!("{base_name}_{index}"));
    }

    candidate
}

fn remove_bg_output_path(source: &Path) -> Result<PathBuf, String> {
    let parent = source
        .parent()
        .ok_or_else(|| "Could not resolve the parent folder.".to_string())?;
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Could not resolve the file name.".to_string())?;
    let folder_prefix = format!("rmbg_{}", Local::now().format("%Y%m%d"));
    let output_dir = numbered_child_dir(parent, &folder_prefix);

    Ok(output_dir.join(format!("{stem}_rmbg.png")))
}

fn unique_child_dir(parent: &Path, base_name: &str) -> PathBuf {
    let mut candidate = parent.join(base_name);
    let mut index = 2;

    while candidate.exists() {
        candidate = parent.join(format!("{base_name}_{index}"));
        index += 1;
    }

    candidate
}

fn extract_frames_output_dir(source: &Path) -> Result<PathBuf, String> {
    let parent = source
        .parent()
        .ok_or_else(|| "Could not resolve the parent folder.".to_string())?;
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Could not resolve the file name.".to_string())?;

    Ok(unique_child_dir(parent, stem))
}

fn unique_output_file(parent: &Path, base_name: &str, extension: &str) -> PathBuf {
    let mut candidate = parent.join(format!("{base_name}.{extension}"));
    let mut index = 2;

    while candidate.exists() {
        candidate = parent.join(format!("{base_name}_{index}.{extension}"));
        index += 1;
    }

    candidate
}

fn unique_named_path(parent: &Path, base_name: &str, extension: Option<&str>) -> PathBuf {
    let initial_name = match extension {
        Some(ext) if !ext.is_empty() => format!("{base_name}.{ext}"),
        _ => base_name.to_string(),
    };
    let mut candidate = parent.join(initial_name);
    let mut index = 2;

    while candidate.exists() {
        let next_name = match extension {
            Some(ext) if !ext.is_empty() => format!("{base_name}_{index}.{ext}"),
            _ => format!("{base_name}_{index}"),
        };
        candidate = parent.join(next_name);
        index += 1;
    }

    candidate
}

fn copy_dir_recursive(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|error| error.to_string())?;

    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());

        if source_path.is_dir() {
            copy_dir_recursive(&source_path, &target_path)?;
        } else {
            fs::copy(&source_path, &target_path).map_err(|error| error.to_string())?;
        }
    }

    Ok(())
}

fn resolve_folder_path(root_path: &str, relative_folder_path: &str) -> PathBuf {
    let root = PathBuf::from(root_path);
    if relative_folder_path.is_empty() {
        return root;
    }

    relative_folder_path
        .split('/')
        .fold(root, |current, segment| current.join(segment))
}

fn common_parent_dir(paths: &[PathBuf]) -> Option<PathBuf> {
    let first_parent = paths.first()?.parent()?.to_path_buf();
    if paths
        .iter()
        .all(|path| path.parent().is_some_and(|parent| parent == first_parent))
    {
        Some(first_parent)
    } else {
        None
    }
}

fn large_media_warning(source: &Path) -> Option<String> {
    let metadata = fs::metadata(source).ok()?;
    if metadata.len() < LARGE_IMAGE_WARNING_BYTES {
        return None;
    }

    Some("Large file detected. This may take longer and use more memory.".to_string())
}

fn scan_folder(root: &Path) -> Result<ScanResult, String> {
    let mut items = Vec::new();

    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| format!(".{}", value.to_lowercase()))
            .unwrap_or_default();

        let Some(kind) = media_kind_for_extension(&ext) else {
            continue;
        };

        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let modified = modified_ms(&metadata);

        let relative_path = path
            .strip_prefix(root)
            .map(normalize_path)
            .unwrap_or_else(|_| path.file_name().unwrap_or_default().to_string_lossy().to_string());

        let name = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_string();

        items.push(MediaItem {
            id: format!("{}-{}", relative_path, modified),
            kind: kind.to_string(),
            name,
            path: path.to_string_lossy().to_string(),
            relative_path,
            ext,
            size_bytes: metadata.len(),
            modified_ms: modified,
        });
    }

    items.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));

    let root_name = root
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| root.to_string_lossy().to_string());

    Ok(ScanResult {
        root_path: root.to_string_lossy().to_string(),
        root_name,
        items,
    })
}

fn emit_task_update(app: &AppHandle, task: &BackgroundTask) {
    let _ = app.emit(BACKGROUND_TASK_EVENT, task);
}

fn update_task(
    tasks: &Arc<Mutex<BackgroundRemovalQueue>>,
    app: &AppHandle,
    task_id: &str,
    status: &str,
    progress: u8,
    message: &str,
    error: Option<String>,
) {
    let task_snapshot = {
        let mut state = tasks.lock().unwrap();
        let Some(task) = state.tasks.get_mut(task_id) else {
            return;
        };
        task.status = status.to_string();
        task.progress = progress;
        task.message = message.to_string();
        task.updated_at_ms = now_ms();
        task.error = error;
        task.clone()
    };

    emit_task_update(app, &task_snapshot);
}

fn enqueue_background_task(
    app: &AppHandle,
    queue_state: &Arc<Mutex<BackgroundRemovalQueue>>,
    source: &Path,
    engine_key: String,
    engine_label: String,
) -> Result<BackgroundTask, String> {
    let output_path = remove_bg_output_path(source)?;
    let warning = large_media_warning(source);
    let file_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("image")
        .to_string();
    let created_at_ms = now_ms();

    let (task, should_start_worker) = {
        let mut queue = queue_state.lock().unwrap();
        let task_id = format!("bg-remove-{}", queue.next_id);
        queue.next_id += 1;

        let task = BackgroundTask {
            id: task_id.clone(),
            kind: "removeBackground".to_string(),
            engine_key,
            engine_label,
            source_path: source.to_string_lossy().to_string(),
            output_path: output_path.to_string_lossy().to_string(),
            file_name,
            status: "queued".to_string(),
            progress: 0,
            message: "Waiting in queue...".to_string(),
            created_at_ms,
            updated_at_ms: created_at_ms,
            error: None,
            warning,
        };

        queue.pending.push_back(task_id.clone());
        queue.order.push(task_id.clone());
        queue.tasks.insert(task_id, task.clone());
        queue.prune_history();

        let should_start_worker = if queue.worker_running {
            false
        } else {
            queue.worker_running = true;
            true
        };

        (task, should_start_worker)
    };

    emit_task_update(app, &task);

    if should_start_worker {
        spawn_background_worker(app.clone(), queue_state.clone());
    }

    Ok(task)
}

fn perform_background_removal_with_engine(
    source_path: &str,
    output_path: &str,
    engine_key: &str,
) -> Result<(), String> {
    let source = PathBuf::from(source_path);
    let output = PathBuf::from(output_path);
    let output_dir = output
        .parent()
        .ok_or_else(|| "Could not resolve the output folder.".to_string())?;
    let source_name = source
        .file_name()
        .ok_or_else(|| "Could not resolve the source file name.".to_string())?;
    let copied_source = output_dir.join(source_name);
    let created_dir = !output_dir.exists();

    fs::create_dir_all(output_dir).map_err(|error| error.to_string())?;
    fs::copy(&source, &copied_source)
        .map_err(|error| format!("Failed to copy the original file. {error}"))?;

    let python = ensure_rembg_python()?;
    let script_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("scripts")
        .join("remove_background.py");

    let args = vec![
        script_path.to_string_lossy().to_string(),
        source.to_string_lossy().to_string(),
        output.to_string_lossy().to_string(),
        engine_key.to_string(),
    ];

    let result = run_command(
        &python.to_string_lossy(),
        &args,
        &PathBuf::from(env!("CARGO_MANIFEST_DIR")),
    );

    if let Err(error) = result {
        let _ = fs::remove_file(&copied_source);
        let _ = fs::remove_file(&output);
        if created_dir {
            let _ = fs::remove_dir(output_dir);
        }
        return Err(format!("Background removal failed. {error}"));
    }

    Ok(())
}

fn detect_ffmpeg_binary(name: &str) -> Result<String, String> {
    let output = silent_command(name)
        .arg("-version")
        .output()
        .map_err(|_| format!("{name} was not found. Install FFmpeg to extract video frames."))?;

    if output.status.success() {
        Ok(name.to_string())
    } else {
        Err(format!("{name} is not available. Install FFmpeg to extract video frames."))
    }
}

fn video_duration_seconds(source: &Path) -> Result<f64, String> {
    let ffprobe = detect_ffmpeg_binary("ffprobe")?;
    let args = vec![
        "-v".to_string(),
        "error".to_string(),
        "-show_entries".to_string(),
        "format=duration".to_string(),
        "-of".to_string(),
        "default=noprint_wrappers=1:nokey=1".to_string(),
        source.to_string_lossy().to_string(),
    ];

    let output = silent_command(&ffprobe)
        .args(&args)
        .output()
        .map_err(|error| error.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    value
        .parse::<f64>()
        .map_err(|_| "Failed to read the video duration.".to_string())
}

fn frame_extraction_filter(preset_key: &str, duration_seconds: f64) -> Result<String, String> {
    let safe_duration = duration_seconds.max(0.1);
    let filter = match preset_key {
        "summary_12" => format!("fps={:.8}", (12.0 / safe_duration).max(0.001)),
        "summary_24" => format!("fps={:.8}", (24.0 / safe_duration).max(0.001)),
        "summary_60" => format!("fps={:.8}", (60.0 / safe_duration).max(0.001)),
        "fps_30" => "fps=30".to_string(),
        "fps_45" => "fps=45".to_string(),
        "fps_60" => "fps=60".to_string(),
        _ => return Err("Unknown frame extraction preset.".to_string()),
    };

    Ok(filter)
}

fn perform_frame_extraction(source_path: &str, output_dir: &str, preset_key: &str) -> Result<(), String> {
    let source = PathBuf::from(source_path);
    let output = PathBuf::from(output_dir);
    let ffmpeg = detect_ffmpeg_binary("ffmpeg")?;
    let duration_seconds = video_duration_seconds(&source)?;
    let fps_filter = frame_extraction_filter(preset_key, duration_seconds)?;

    fs::create_dir_all(&output).map_err(|error| error.to_string())?;
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("frame");
    let output_pattern = output.join(format!("{stem}_%04d.png"));

    let args = vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-i".to_string(),
        source.to_string_lossy().to_string(),
        "-vf".to_string(),
        fps_filter,
        "-vsync".to_string(),
        "vfr".to_string(),
        "-q:v".to_string(),
        "1".to_string(),
        output_pattern.to_string_lossy().to_string(),
    ];

    run_command_without_capture(&ffmpeg, &args, &output)
        .map_err(|error| format!("Frame extraction failed. {error}"))
}

fn export_animation_from_images(
    image_paths: &[String],
    format: &str,
    fps: u32,
) -> Result<String, String> {
    if image_paths.len() < 2 {
        return Err("Select at least two images to export an animation.".to_string());
    }

    if !matches!(format, "gif" | "webp") {
        return Err("Unsupported animation format.".to_string());
    }

    let ffmpeg = detect_ffmpeg_binary("ffmpeg")?;
    let paths: Vec<PathBuf> = image_paths.iter().map(PathBuf::from).collect();
    let parent_dir = common_parent_dir(&paths)
        .or_else(|| paths.first().and_then(|path| path.parent()).map(Path::to_path_buf))
        .ok_or_else(|| "Could not resolve the output folder.".to_string())?;
    let base_name = parent_dir
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("animation");
    let output_path = unique_output_file(&parent_dir, base_name, format);
    let frame_duration = 1.0 / fps.max(1) as f64;

    let mut list_content = String::new();
    for image_path in &paths {
        let safe_path = image_path
            .to_string_lossy()
            .replace('\\', "/")
            .replace('\'', "'\\''");
        list_content.push_str(&format!("file '{}'\n", safe_path));
        list_content.push_str(&format!("duration {:.6}\n", frame_duration));
    }
    if let Some(last_path) = paths.last() {
        let safe_path = last_path
            .to_string_lossy()
            .replace('\\', "/")
            .replace('\'', "'\\''");
        list_content.push_str(&format!("file '{}'\n", safe_path));
    }

    let list_path = std::env::temp_dir().join(format!("media-vault-animation-{}.txt", now_ms()));
    fs::write(&list_path, list_content).map_err(|error| error.to_string())?;

    let result = (|| {
        let mut args = vec![
            "-hide_banner".to_string(),
            "-loglevel".to_string(),
            "error".to_string(),
            "-f".to_string(),
            "concat".to_string(),
            "-safe".to_string(),
            "0".to_string(),
            "-i".to_string(),
            list_path.to_string_lossy().to_string(),
        ];

        if format == "gif" {
            args.extend([
                "-filter_complex".to_string(),
                format!(
                    "fps={fps},split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse"
                ),
                "-loop".to_string(),
                "0".to_string(),
                output_path.to_string_lossy().to_string(),
            ]);
        } else {
            args.extend([
                "-loop".to_string(),
                "0".to_string(),
                "-c:v".to_string(),
                "libwebp_anim".to_string(),
                "-quality".to_string(),
                "90".to_string(),
                "-lossless".to_string(),
                "0".to_string(),
                "-pix_fmt".to_string(),
                "yuva420p".to_string(),
                output_path.to_string_lossy().to_string(),
            ]);
        }

        run_command(&ffmpeg, &args, &parent_dir)
    })();

    let _ = fs::remove_file(&list_path);
    result
        .map(|_| output_path.to_string_lossy().to_string())
        .map_err(|error| format!("Animation export failed. {error}"))
}

fn spawn_background_worker(app: AppHandle, tasks: Arc<Mutex<BackgroundRemovalQueue>>) {
    tauri::async_runtime::spawn(async move {
        loop {
            let next_job = {
                let mut state = tasks.lock().unwrap();
                if let Some(task_id) = state.pending.pop_front() {
                    if let Some(task) = state.tasks.get_mut(&task_id) {
                        task.status = "running".to_string();
                        task.progress = 12;
                        task.message = "Preparing background removal...".to_string();
                        task.updated_at_ms = now_ms();
                        Some(task.clone())
                    } else {
                        None
                    }
                } else {
                    state.worker_running = false;
                    None
                }
            };

            let Some(task) = next_job else {
                break;
            };

            emit_task_update(&app, &task);
            update_task(
                &tasks,
                &app,
                &task.id,
                "running",
                30,
                "Preparing model and runtime...",
                None,
            );
            update_task(
                &tasks,
                &app,
                &task.id,
                "running",
                68,
                "Removing background. Large images can take a while...",
                None,
            );

            let source_path = task.source_path.clone();
            let output_path = task.output_path.clone();
            let engine_key = task.engine_key.clone();
            let task_kind = task.kind.clone();
            let result = tauri::async_runtime::spawn_blocking(move || match task_kind.as_str() {
                "extractFrames" => perform_frame_extraction(&source_path, &output_path, &engine_key),
                _ => perform_background_removal_with_engine(&source_path, &output_path, &engine_key),
            })
            .await
            .map_err(|error| error.to_string())
            .and_then(|result| result);

            match result {
                Ok(()) => {
                    let success_message = if task.kind == "extractFrames" {
                        "Frames extracted."
                    } else {
                        "Background removed."
                    };
                    update_task(
                        &tasks,
                        &app,
                        &task.id,
                        "completed",
                        100,
                        success_message,
                        None,
                    );
                }
                Err(error) => {
                    let failure_message = if task.kind == "extractFrames" {
                        "Frame extraction failed."
                    } else {
                        "Background removal failed."
                    };
                    update_task(
                        &tasks,
                        &app,
                        &task.id,
                        "failed",
                        100,
                        failure_message,
                        Some(error),
                    );
                }
            }
        }
    });
}

#[tauri::command]
fn pick_root_folder() -> Option<String> {
    FileDialog::new()
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
fn scan_media_folder(root_path: String) -> Result<ScanResult, String> {
    let root = PathBuf::from(root_path);
    if !root.exists() {
        return Err("Selected folder no longer exists.".to_string());
    }
    if !root.is_dir() {
        return Err("Selected path is not a folder.".to_string());
    }
    scan_folder(&root)
}

#[tauri::command]
fn rename_media_file(file_path: String, new_name: String) -> Result<String, String> {
    let source = PathBuf::from(&file_path);
    if !source.exists() {
        return Err("Selected file no longer exists.".to_string());
    }

    let parent = source
        .parent()
        .ok_or_else(|| "Could not resolve the parent folder.".to_string())?;
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();

    let trimmed_name = new_name.trim();
    if trimmed_name.is_empty() {
        return Err("New name cannot be empty.".to_string());
    }

    let target_name = if Path::new(trimmed_name).extension().is_some() || extension.is_empty() {
        trimmed_name.to_string()
    } else {
        format!("{trimmed_name}.{extension}")
    };

    let target = parent.join(target_name);
    fs::rename(&source, &target).map_err(|error| error.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
fn delete_media_file(file_path: String) -> Result<(), String> {
    let source = PathBuf::from(&file_path);
    if !source.exists() {
        return Err("Selected file no longer exists.".to_string());
    }
    fs::remove_file(source).map_err(|error| error.to_string())
}

#[tauri::command]
fn duplicate_media_file(file_path: String) -> Result<String, String> {
    let source = PathBuf::from(&file_path);
    if !source.exists() {
        return Err("Selected file no longer exists.".to_string());
    }
    if !source.is_file() {
        return Err("Selected path is not a file.".to_string());
    }

    let parent = source
        .parent()
        .ok_or_else(|| "Could not resolve the parent folder.".to_string())?;
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Could not resolve the file name.".to_string())?;
    let extension = source.extension().and_then(|value| value.to_str());
    let target = unique_named_path(parent, &format!("{stem}_copy"), extension);

    fs::copy(&source, &target).map_err(|error| error.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
fn create_media_folder(root_path: String, relative_folder_path: String) -> Result<String, String> {
    let parent = resolve_folder_path(&root_path, &relative_folder_path);
    if !parent.exists() {
        return Err("Selected folder no longer exists.".to_string());
    }
    if !parent.is_dir() {
        return Err("Selected path is not a folder.".to_string());
    }

    let target = unique_named_path(&parent, "New Folder", None);
    fs::create_dir(&target).map_err(|error| error.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
fn duplicate_media_folder(root_path: String, relative_folder_path: String) -> Result<String, String> {
    if relative_folder_path.is_empty() {
        return Err("The root folder cannot be duplicated.".to_string());
    }

    let source = resolve_folder_path(&root_path, &relative_folder_path);
    if !source.exists() {
        return Err("Selected folder no longer exists.".to_string());
    }
    if !source.is_dir() {
        return Err("Selected path is not a folder.".to_string());
    }

    let parent = source
        .parent()
        .ok_or_else(|| "Could not resolve the parent folder.".to_string())?;
    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Could not resolve the folder name.".to_string())?;
    let target = unique_named_path(parent, &format!("{name}_copy"), None);

    copy_dir_recursive(&source, &target)?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
fn delete_media_folder(root_path: String, relative_folder_path: String) -> Result<(), String> {
    if relative_folder_path.is_empty() {
        return Err("The root folder cannot be deleted.".to_string());
    }

    let source = resolve_folder_path(&root_path, &relative_folder_path);
    if !source.exists() {
        return Err("Selected folder no longer exists.".to_string());
    }
    if !source.is_dir() {
        return Err("Selected path is not a folder.".to_string());
    }

    fs::remove_dir_all(source).map_err(|error| error.to_string())
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

    enqueue_background_task(&app, &state.inner, &source, engine_key, engine_label)
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

    detect_ffmpeg_binary("ffmpeg")?;
    detect_ffmpeg_binary("ffprobe")?;

    let output_dir = extract_frames_output_dir(&source)?;
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

    let created_at_ms = now_ms();
    let warning = large_media_warning(&source);
    let file_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("video")
        .to_string();

    let (task, should_start_worker) = {
        let mut queue = state.inner.lock().unwrap();
        let task_id = format!("bg-remove-{}", queue.next_id);
        queue.next_id += 1;

        let task = BackgroundTask {
            id: task_id.clone(),
            kind: "extractFrames".to_string(),
            engine_key: preset_key,
            engine_label: preset_label,
            source_path: source.to_string_lossy().to_string(),
            output_path: output_dir.to_string_lossy().to_string(),
            file_name,
            status: "queued".to_string(),
            progress: 0,
            message: "Waiting in queue...".to_string(),
            created_at_ms,
            updated_at_ms: created_at_ms,
            error: None,
            warning,
        };

        queue.pending.push_back(task_id.clone());
        queue.order.push(task_id.clone());
        queue.tasks.insert(task_id, task.clone());
        queue.prune_history();

        let should_start_worker = if queue.worker_running {
            false
        } else {
            queue.worker_running = true;
            true
        };

        (task, should_start_worker)
    };

    emit_task_update(&app, &task);

    if should_start_worker {
        spawn_background_worker(app.clone(), state.inner.clone());
    }

    Ok(task)
}

#[tauri::command]
fn export_image_sequence_animation(
    image_paths: Vec<String>,
    format: String,
    fps: u32,
) -> Result<String, String> {
    export_animation_from_images(&image_paths, &format, fps)
}

#[tauri::command]
fn cancel_background_task(
    app: AppHandle,
    state: State<'_, BackgroundRemovalState>,
    task_id: String,
) -> Result<BackgroundTask, String> {
    let task = {
        let mut queue = state.inner.lock().unwrap();
        let is_queued = queue
            .tasks
            .get(&task_id)
            .is_some_and(|task| task.status == "queued");
        if !is_queued {
            return Err("Only queued tasks can be cancelled.".to_string());
        }

        queue.remove_from_pending(&task_id);
        let task = queue
            .tasks
            .get_mut(&task_id)
            .ok_or_else(|| "Task was not found.".to_string())?;
        task.status = "failed".to_string();
        task.progress = 100;
        task.message = "Cancelled by user.".to_string();
        task.error = Some("Task was cancelled before it started.".to_string());
        task.updated_at_ms = now_ms();
        task.clone()
    };

    emit_task_update(&app, &task);
    Ok(task)
}

#[tauri::command]
fn clear_finished_background_tasks(state: State<'_, BackgroundRemovalState>) {
    let mut queue = state.inner.lock().unwrap();
    let keep_ids: Vec<String> = queue
        .order
        .iter()
        .filter(|task_id| {
            queue
                .tasks
                .get(*task_id)
                .is_some_and(|task| matches!(task.status.as_str(), "queued" | "running"))
        })
        .cloned()
        .collect();

    queue.tasks.retain(|task_id, task| {
        matches!(task.status.as_str(), "queued" | "running") && keep_ids.contains(task_id)
    });
    queue.order = keep_ids;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(BackgroundRemovalState {
            inner: Arc::new(Mutex::new(BackgroundRemovalQueue::new())),
        })
        .invoke_handler(tauri::generate_handler![
            pick_root_folder,
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
