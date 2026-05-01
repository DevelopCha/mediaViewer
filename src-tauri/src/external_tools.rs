use crate::media_fs::{
    common_parent_dir, extract_frames_output_dir, large_media_warning, remove_bg_output_path,
    unique_named_path, unique_output_file,
};
use crate::models::now_ms;
use image::{
    imageops::{overlay, FilterType},
    DynamicImage, ImageBuffer, Rgba, RgbaImage,
};
use std::fs;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager};

const BUNDLED_VENV_DIR: &str = ".rembg-venv";
const BUNDLED_SCRIPTS_DIR: &str = "scripts";
const BUNDLED_TOOLS_DIR: &str = "resources/tools";
const CONTACT_SHEET_TILE_WIDTH: u32 = 360;
const PORTFOLIO_TILE_WIDTH: u32 = 420;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub fn bundled_resource_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().resource_dir().ok()
}

pub fn bundled_resource_path(app: &AppHandle, relative: impl AsRef<Path>) -> Option<PathBuf> {
    let candidate = bundled_resource_dir(app)?.join(relative);
    candidate.exists().then_some(candidate)
}

pub fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn runtime_base_dir(app: &AppHandle) -> PathBuf {
    bundled_resource_dir(app).unwrap_or_else(manifest_dir)
}

fn silent_command(program: &str) -> Command {
    let mut command = Command::new(program);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn platform_tools_dir() -> &'static str {
    "windows-x86_64"
}

#[cfg(all(target_os = "windows", target_arch = "aarch64"))]
fn platform_tools_dir() -> &'static str {
    "windows-aarch64"
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn platform_tools_dir() -> &'static str {
    "macos-aarch64"
}

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
fn platform_tools_dir() -> &'static str {
    "macos-x86_64"
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn platform_tools_dir() -> &'static str {
    "linux-x86_64"
}

#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
fn platform_tools_dir() -> &'static str {
    "linux-aarch64"
}

#[cfg(not(any(
    all(target_os = "windows", target_arch = "x86_64"),
    all(target_os = "windows", target_arch = "aarch64"),
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "macos", target_arch = "x86_64"),
    all(target_os = "linux", target_arch = "x86_64"),
    all(target_os = "linux", target_arch = "aarch64")
)))]
fn platform_tools_dir() -> &'static str {
    "unsupported-platform"
}

fn tool_file_name(base: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        return format!("{base}.exe");
    }

    #[cfg(not(target_os = "windows"))]
    {
        base.to_string()
    }
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
    manifest_dir().join(BUNDLED_VENV_DIR)
}

fn rembg_python_path_from_dir(venv_dir: &Path) -> PathBuf {
    if cfg!(target_os = "windows") {
        venv_dir.join("Scripts").join("python.exe")
    } else {
        venv_dir.join("bin").join("python3")
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
        format!("Command failed with status {}.", output.status)
    };

    Err(details)
}

fn ensure_bundled_rembg_python(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let Some(venv_dir) = bundled_resource_path(app, BUNDLED_VENV_DIR) else {
        return Ok(None);
    };
    let venv_python = rembg_python_path_from_dir(&venv_dir);
    if !venv_python.exists() {
        return Err(
            "The bundled background-removal runtime is missing Python. Rebuild the installer with the packaged runtime."
                .to_string(),
        );
    }

    let check_args = vec![
        "-c".to_string(),
        "import rembg, onnxruntime, withoutbg, PIL".to_string(),
    ];

    run_command(&venv_python.to_string_lossy(), &check_args, &venv_dir).map_err(|error| {
        format!("The bundled background-removal runtime is incomplete. {error}")
    })?;

    Ok(Some(venv_python))
}

fn ensure_rembg_python(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(venv_python) = ensure_bundled_rembg_python(app)? {
        return Ok(venv_python);
    }

    let venv_dir = rembg_venv_dir();
    let venv_python = rembg_python_path_from_dir(&venv_dir);
    let manifest_dir = manifest_dir();

    if !venv_python.exists() {
        let (launcher, launcher_args) = detect_python_launcher()?;
        let mut args = launcher_args;
        args.extend([
            "-m".to_string(),
            "venv".to_string(),
            venv_dir.to_string_lossy().to_string(),
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

fn remove_background_script_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(script_path) = bundled_resource_path(
        app,
        Path::new(BUNDLED_SCRIPTS_DIR).join("remove_background.py"),
    ) {
        return Ok(script_path);
    }

    let script_path = manifest_dir()
        .join(BUNDLED_SCRIPTS_DIR)
        .join("remove_background.py");
    if script_path.exists() {
        Ok(script_path)
    } else {
        Err("The background-removal script could not be found in the app bundle.".to_string())
    }
}

pub fn remove_background_warning(source: &Path) -> Option<String> {
    large_media_warning(source)
}

pub fn frame_extraction_warning(source: &Path) -> Option<String> {
    large_media_warning(source)
}

pub fn build_remove_bg_output_path(source: &Path) -> Result<PathBuf, String> {
    remove_bg_output_path(source)
}

pub fn build_remove_bg_output_path_in(parent: &Path, source_name: &str) -> Result<PathBuf, String> {
    let stem = Path::new(source_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Could not resolve the file name.".to_string())?;
    let folder_prefix = format!("rmbg_{}", chrono::Local::now().format("%Y%m%d"));
    let output_dir = unique_named_path(parent, &folder_prefix, None);
    Ok(output_dir.join(format!("{stem}_rmbg.png")))
}

pub fn build_extract_frames_output_dir(source: &Path) -> Result<PathBuf, String> {
    extract_frames_output_dir(source)
}

pub fn build_extract_frames_output_dir_in(
    parent: &Path,
    source_name: &str,
) -> Result<PathBuf, String> {
    let stem = Path::new(source_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Could not resolve the file name.".to_string())?;
    Ok(unique_named_path(parent, stem, None))
}

pub fn build_best_cuts_output_dir(source: &Path) -> Result<PathBuf, String> {
    let parent = source
        .parent()
        .ok_or_else(|| "Could not resolve the parent folder.".to_string())?;
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Could not resolve the file name.".to_string())?;

    Ok(unique_named_path(parent, &format!("{stem}_bestcuts"), None))
}

pub fn build_best_cuts_output_dir_in(parent: &Path, source_name: &str) -> Result<PathBuf, String> {
    let stem = Path::new(source_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Could not resolve the file name.".to_string())?;
    Ok(unique_named_path(parent, &format!("{stem}_bestcuts"), None))
}

pub fn build_scene_split_output_dir(source: &Path) -> Result<PathBuf, String> {
    let parent = source
        .parent()
        .ok_or_else(|| "Could not resolve the parent folder.".to_string())?;
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Could not resolve the file name.".to_string())?;

    Ok(unique_named_path(parent, &format!("{stem}_scenes"), None))
}

pub fn build_scene_split_output_dir_in(
    parent: &Path,
    source_name: &str,
) -> Result<PathBuf, String> {
    let stem = Path::new(source_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Could not resolve the file name.".to_string())?;
    Ok(unique_named_path(parent, &format!("{stem}_scenes"), None))
}

pub fn build_video_contact_sheet_output_path(source: &Path) -> Result<PathBuf, String> {
    let parent = source
        .parent()
        .ok_or_else(|| "Could not resolve the parent folder.".to_string())?;
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Could not resolve the file name.".to_string())?;

    Ok(unique_output_file(
        parent,
        &format!("{stem}_contact_sheet"),
        "jpg",
    ))
}

pub fn build_video_contact_sheet_output_path_in(
    parent: &Path,
    source_name: &str,
) -> Result<PathBuf, String> {
    let stem = Path::new(source_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Could not resolve the file name.".to_string())?;
    Ok(unique_output_file(
        parent,
        &format!("{stem}_contact_sheet"),
        "jpg",
    ))
}

pub fn build_loop_clip_output_path(source: &Path, format: &str) -> Result<PathBuf, String> {
    let parent = source
        .parent()
        .ok_or_else(|| "Could not resolve the parent folder.".to_string())?;
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Could not resolve the file name.".to_string())?;

    Ok(unique_output_file(parent, &format!("{stem}_loop"), format))
}

pub fn build_loop_clip_output_path_in(
    parent: &Path,
    source_name: &str,
    format: &str,
) -> Result<PathBuf, String> {
    let stem = Path::new(source_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Could not resolve the file name.".to_string())?;
    Ok(unique_output_file(parent, &format!("{stem}_clip"), format))
}

pub fn build_resized_output_path(
    source: &Path,
    suffix: &str,
    extension: &str,
) -> Result<PathBuf, String> {
    let parent = source
        .parent()
        .ok_or_else(|| "Could not resolve the parent folder.".to_string())?;
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Could not resolve the file name.".to_string())?;

    Ok(unique_output_file(
        parent,
        &format!("{stem}_{suffix}"),
        extension,
    ))
}

pub fn build_resized_output_path_in(
    parent: &Path,
    source_name: &str,
    suffix: &str,
    extension: &str,
) -> Result<PathBuf, String> {
    let stem = Path::new(source_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Could not resolve the file name.".to_string())?;
    Ok(unique_output_file(
        parent,
        &format!("{stem}_{suffix}"),
        extension,
    ))
}

pub fn build_portfolio_sheet_output_path(image_paths: &[PathBuf]) -> Result<PathBuf, String> {
    let parent = common_parent_dir(image_paths)
        .or_else(|| {
            image_paths
                .first()
                .and_then(|path| path.parent())
                .map(Path::to_path_buf)
        })
        .ok_or_else(|| "Could not resolve the output folder.".to_string())?;
    let base_name = parent
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("portfolio");
    Ok(unique_output_file(
        &parent,
        &format!("{base_name}_portfolio"),
        "jpg",
    ))
}

pub fn build_portfolio_sheet_output_path_in(
    parent: &Path,
    base_name: &str,
) -> Result<PathBuf, String> {
    Ok(unique_output_file(
        parent,
        &format!("{base_name}_portfolio"),
        "jpg",
    ))
}

pub fn perform_background_removal_with_engine(
    app: &AppHandle,
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

    let python = ensure_rembg_python(app)?;
    let script_path = remove_background_script_path(app)?;
    let runtime_dir = runtime_base_dir(app);

    let args = vec![
        script_path.to_string_lossy().to_string(),
        source.to_string_lossy().to_string(),
        output.to_string_lossy().to_string(),
        engine_key.to_string(),
    ];

    let result = run_command(&python.to_string_lossy(), &args, &runtime_dir);

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

pub fn detect_ffmpeg_binary(app: &AppHandle, name: &str) -> Result<String, String> {
    let bundled_name = tool_file_name(name);
    if let Some(tool_path) = bundled_resource_path(
        app,
        Path::new(BUNDLED_TOOLS_DIR)
            .join(platform_tools_dir())
            .join(&bundled_name),
    ) {
        let output = silent_command(&tool_path.to_string_lossy())
            .arg("-version")
            .output()
            .map_err(|error| format!("Failed to launch the bundled {name}. {error}"))?;

        if output.status.success() {
            return Ok(tool_path.to_string_lossy().to_string());
        }

        return Err(format!("The bundled {name} is not executable."));
    }

    let output = silent_command(name)
        .arg("-version")
        .output()
        .map_err(|_| format!("{name} was not found. Install FFmpeg to extract video frames."))?;

    if output.status.success() {
        Ok(name.to_string())
    } else {
        Err(format!(
            "{name} is not available. Install FFmpeg to extract video frames."
        ))
    }
}

fn run_command_capture(
    program: &str,
    args: &[String],
    working_dir: &Path,
) -> Result<(String, String), String> {
    let output = silent_command(program)
        .args(args)
        .current_dir(working_dir)
        .output()
        .map_err(|error| error.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok((stdout, stderr))
    } else {
        let details = if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else if !stdout.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            format!("Command failed with status {}.", output.status)
        };
        Err(details)
    }
}

fn video_duration_seconds(app: &AppHandle, source: &Path) -> Result<f64, String> {
    let ffprobe = detect_ffmpeg_binary(app, "ffprobe")?;
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

fn video_duration_seconds_from_ffmpeg(ffmpeg_output: &str) -> Vec<f64> {
    let mut timestamps = Vec::new();
    for line in ffmpeg_output.lines() {
        let Some(index) = line.find("pts_time:") else {
            continue;
        };
        let value = &line[index + "pts_time:".len()..];
        let end = value
            .find(char::is_whitespace)
            .map(|inner_index| &value[..inner_index])
            .unwrap_or(value);
        if let Ok(parsed) = end.parse::<f64>() {
            timestamps.push(parsed);
        }
    }
    timestamps
}

fn dedupe_timestamps(values: Vec<f64>, min_gap: f64) -> Vec<f64> {
    let mut deduped = Vec::new();
    for value in values {
        if deduped
            .last()
            .is_none_or(|previous: &f64| (value - previous).abs() >= min_gap)
        {
            deduped.push(value);
        }
    }
    deduped
}

fn fallback_even_timestamps(duration_seconds: f64, count: usize) -> Vec<f64> {
    if count == 0 || duration_seconds <= 0.0 {
        return Vec::new();
    }

    let step = duration_seconds / (count as f64 + 1.0);
    (0..count)
        .map(|index| step * (index as f64 + 1.0))
        .collect()
}

fn scene_change_timestamps(
    app: &AppHandle,
    source: &Path,
    threshold: f64,
) -> Result<Vec<f64>, String> {
    let ffmpeg = detect_ffmpeg_binary(app, "ffmpeg")?;
    let runtime_dir = runtime_base_dir(app);
    let args = vec![
        "-hide_banner".to_string(),
        "-i".to_string(),
        source.to_string_lossy().to_string(),
        "-vf".to_string(),
        format!("select='gt(scene,{threshold})',showinfo"),
        "-an".to_string(),
        "-f".to_string(),
        "null".to_string(),
        "-".to_string(),
    ];

    let (_, stderr) = run_command_capture(&ffmpeg, &args, &runtime_dir)
        .map_err(|error| format!("Scene analysis failed. {error}"))?;
    Ok(dedupe_timestamps(
        video_duration_seconds_from_ffmpeg(&stderr),
        0.15,
    ))
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

fn frame_extraction_output_settings(
    preset_key: &str,
) -> Result<(&'static str, Vec<String>), String> {
    match preset_key {
        "summary_12" | "summary_24" | "summary_60" => Ok((
            "png",
            vec!["-compression_level".to_string(), "2".to_string()],
        )),
        "fps_30" | "fps_45" | "fps_60" => Ok((
            "webp",
            vec![
                "-c:v".to_string(),
                "libwebp".to_string(),
                "-lossless".to_string(),
                "1".to_string(),
                "-compression_level".to_string(),
                "4".to_string(),
                "-quality".to_string(),
                "100".to_string(),
            ],
        )),
        _ => Err("Unknown frame extraction preset.".to_string()),
    }
}

fn frame_extraction_crop_filter(eye_mode: &str, layout: &str) -> Result<Option<String>, String> {
    match eye_mode {
        "standard" => Ok(None),
        "left" => match layout {
            "sbs" => Ok(Some("crop=iw/2:ih:0:0".to_string())),
            "ou" => Ok(Some("crop=iw:ih/2:0:0".to_string())),
            _ => Err("Unknown VR layout.".to_string()),
        },
        "right" => match layout {
            "sbs" => Ok(Some("crop=iw/2:ih:iw/2:0".to_string())),
            "ou" => Ok(Some("crop=iw:ih/2:0:ih/2".to_string())),
            _ => Err("Unknown VR layout.".to_string()),
        },
        _ => Err("Unknown eye mode.".to_string()),
    }
}

pub fn perform_frame_extraction(
    app: &AppHandle,
    source_path: &str,
    output_dir: &str,
    preset_key: &str,
    eye_mode: &str,
    layout: &str,
) -> Result<(), String> {
    let source = PathBuf::from(source_path);
    let output = PathBuf::from(output_dir);
    let ffmpeg = detect_ffmpeg_binary(app, "ffmpeg")?;
    let duration_seconds = video_duration_seconds(app, &source)?;
    let fps_filter = frame_extraction_filter(preset_key, duration_seconds)?;
    let (output_extension, output_args) = frame_extraction_output_settings(preset_key)?;
    let crop_filter = frame_extraction_crop_filter(eye_mode, layout)?;
    let video_filter = match crop_filter {
        Some(crop) => format!("{crop},{fps_filter}"),
        None => fps_filter,
    };

    fs::create_dir_all(&output).map_err(|error| error.to_string())?;
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("frame");
    let output_pattern = output.join(format!("{stem}_%04d.{output_extension}"));

    let mut args = vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-i".to_string(),
        source.to_string_lossy().to_string(),
        "-vf".to_string(),
        video_filter,
        "-vsync".to_string(),
        "vfr".to_string(),
    ];
    args.extend(output_args);
    args.push(output_pattern.to_string_lossy().to_string());

    run_command_without_capture(&ffmpeg, &args, &output)
        .map_err(|error| format!("Frame extraction failed. {error}"))
}

pub fn export_animation_from_images(
    app: &AppHandle,
    image_paths: &[String],
    format: &str,
    fps: u32,
    reverse: bool,
    preferred_output_root: Option<&Path>,
) -> Result<String, String> {
    if image_paths.len() < 2 {
        return Err("Select at least two images to export an animation.".to_string());
    }

    if !matches!(format, "gif" | "webp" | "apng") {
        return Err("Unsupported animation format.".to_string());
    }

    let ffmpeg = detect_ffmpeg_binary(app, "ffmpeg")?;
    let mut paths: Vec<PathBuf> = image_paths.iter().map(PathBuf::from).collect();
    if reverse {
        paths.reverse();
    }
    let parent_dir = preferred_output_root
        .map(Path::to_path_buf)
        .or_else(|| {
            common_parent_dir(&paths).or_else(|| {
                paths
                    .first()
                    .and_then(|path| path.parent())
                    .map(Path::to_path_buf)
            })
        })
        .ok_or_else(|| "Could not resolve the output folder.".to_string())?;
    let base_name = if preferred_output_root.is_some() {
        paths
            .first()
            .and_then(|path| path.file_stem())
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("animation")
    } else {
        parent_dir
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("animation")
    };
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

    let list_path = std::env::temp_dir().join(format!("mviewer-animation-{}.txt", now_ms()));
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
                format!("fps={fps},split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse"),
                "-loop".to_string(),
                "0".to_string(),
                output_path.to_string_lossy().to_string(),
            ]);
        } else if format == "apng" {
            args.extend([
                "-plays".to_string(),
                "0".to_string(),
                "-f".to_string(),
                "apng".to_string(),
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

fn extract_frame_at_timestamp(
    ffmpeg: &str,
    source: &Path,
    output_path: &Path,
    timestamp_seconds: f64,
) -> Result<(), String> {
    let working_dir = output_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(std::env::temp_dir);
    let args = vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-ss".to_string(),
        format!("{timestamp_seconds:.3}"),
        "-i".to_string(),
        source.to_string_lossy().to_string(),
        "-frames:v".to_string(),
        "1".to_string(),
        "-q:v".to_string(),
        "2".to_string(),
        output_path.to_string_lossy().to_string(),
    ];
    run_command_without_capture(ffmpeg, &args, &working_dir)
}

pub fn export_video_best_cuts(
    app: &AppHandle,
    file_path: &str,
    output_dir: &str,
    count: usize,
    threshold: f64,
) -> Result<(), String> {
    let source = PathBuf::from(file_path);
    let output = PathBuf::from(output_dir);
    let ffmpeg = detect_ffmpeg_binary(app, "ffmpeg")?;
    let duration_seconds = video_duration_seconds(app, &source)?;
    let mut timestamps = scene_change_timestamps(app, &source, threshold)?;

    if timestamps.len() > count {
        let step = timestamps.len() as f64 / count as f64;
        timestamps = (0..count)
            .filter_map(|index| {
                timestamps
                    .get((index as f64 * step).floor() as usize)
                    .copied()
            })
            .collect();
    }

    if timestamps.is_empty() {
        timestamps = fallback_even_timestamps(duration_seconds, count.max(1));
    }

    fs::create_dir_all(&output).map_err(|error| error.to_string())?;
    for (index, timestamp) in timestamps.iter().enumerate() {
        let output_file = output.join(format!("bestcut_{:03}.jpg", index + 1));
        extract_frame_at_timestamp(&ffmpeg, &source, &output_file, *timestamp)
            .map_err(|error| format!("Best-cut extraction failed. {error}"))?;
    }

    Ok(())
}

pub fn export_video_contact_sheet(
    app: &AppHandle,
    file_path: &str,
    output_path: &str,
    columns: u32,
    rows: u32,
) -> Result<(), String> {
    let source = PathBuf::from(file_path);
    let output = PathBuf::from(output_path);
    let ffmpeg = detect_ffmpeg_binary(app, "ffmpeg")?;
    let duration_seconds = video_duration_seconds(app, &source)?;
    let frame_count = (columns.max(1) * rows.max(1)).max(1);
    let fps = (frame_count as f64 / duration_seconds.max(1.0)).max(0.01);
    let args = vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-i".to_string(),
        source.to_string_lossy().to_string(),
        "-vf".to_string(),
        format!(
            "fps={fps:.6},scale={}:-1:force_original_aspect_ratio=decrease,tile={}x{}",
            CONTACT_SHEET_TILE_WIDTH, columns, rows
        ),
        "-frames:v".to_string(),
        "1".to_string(),
        output.to_string_lossy().to_string(),
    ];

    let working_dir = output
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(std::env::temp_dir);
    run_command_without_capture(&ffmpeg, &args, &working_dir)
        .map_err(|error| format!("Contact sheet export failed. {error}"))
}

pub fn export_video_loop_clip(
    app: &AppHandle,
    file_path: &str,
    output_path: &str,
    start_seconds: f64,
    duration_seconds: f64,
    format: &str,
    fps: u32,
) -> Result<(), String> {
    let source = PathBuf::from(file_path);
    let output = PathBuf::from(output_path);
    let ffmpeg = detect_ffmpeg_binary(app, "ffmpeg")?;
    let safe_duration = duration_seconds.max(0.2);
    let mut args = vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-ss".to_string(),
        format!("{:.3}", start_seconds.max(0.0)),
        "-t".to_string(),
        format!("{safe_duration:.3}"),
        "-i".to_string(),
        source.to_string_lossy().to_string(),
    ];

    match format {
        "mp4" => args.extend([
            "-vf".to_string(),
            format!("fps={}", fps.max(1)),
            "-an".to_string(),
            "-c:v".to_string(),
            "libx264".to_string(),
            "-pix_fmt".to_string(),
            "yuv420p".to_string(),
            "-movflags".to_string(),
            "+faststart".to_string(),
        ]),
        "gif" => args.extend([
            "-filter_complex".to_string(),
            format!(
                "fps={},scale=720:-1:force_original_aspect_ratio=decrease,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
                fps.max(1)
            ),
            "-loop".to_string(),
            "0".to_string(),
        ]),
        "webp" => args.extend([
            "-vf".to_string(),
            format!(
                "fps={},scale=720:-1:force_original_aspect_ratio=decrease",
                fps.max(1)
            ),
            "-loop".to_string(),
            "0".to_string(),
            "-c:v".to_string(),
            "libwebp_anim".to_string(),
            "-quality".to_string(),
            "90".to_string(),
        ]),
        _ => return Err("Unsupported loop export format.".to_string()),
    }
    args.push(output.to_string_lossy().to_string());

    let working_dir = output
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(std::env::temp_dir);
    run_command_without_capture(&ffmpeg, &args, &working_dir)
        .map_err(|error| format!("Loop clip export failed. {error}"))
}

pub fn split_video_into_scenes(
    app: &AppHandle,
    file_path: &str,
    output_dir: &str,
    threshold: f64,
    min_scene_seconds: f64,
) -> Result<(), String> {
    let source = PathBuf::from(file_path);
    let output = PathBuf::from(output_dir);
    let ffmpeg = detect_ffmpeg_binary(app, "ffmpeg")?;
    let duration_seconds = video_duration_seconds(app, &source)?;
    let mut markers = scene_change_timestamps(app, &source, threshold)?;
    markers.retain(|value| *value > 0.0 && *value < duration_seconds);

    let mut bounds = Vec::with_capacity(markers.len() + 2);
    bounds.push(0.0);
    bounds.extend(markers);
    bounds.push(duration_seconds);

    fs::create_dir_all(&output).map_err(|error| error.to_string())?;

    let mut exported = 0usize;
    for window in bounds.windows(2) {
        let start = window[0];
        let end = window[1];
        let scene_duration = end - start;
        if scene_duration < min_scene_seconds {
            continue;
        }

        let output_file = output.join(format!("scene_{:03}.mp4", exported + 1));
        let args = vec![
            "-hide_banner".to_string(),
            "-loglevel".to_string(),
            "error".to_string(),
            "-ss".to_string(),
            format!("{start:.3}"),
            "-t".to_string(),
            format!("{scene_duration:.3}"),
            "-i".to_string(),
            source.to_string_lossy().to_string(),
            "-c:v".to_string(),
            "libx264".to_string(),
            "-preset".to_string(),
            "veryfast".to_string(),
            "-crf".to_string(),
            "20".to_string(),
            "-c:a".to_string(),
            "aac".to_string(),
            "-movflags".to_string(),
            "+faststart".to_string(),
            output_file.to_string_lossy().to_string(),
        ];
        run_command_without_capture(&ffmpeg, &args, &output)
            .map_err(|error| format!("Scene split failed. {error}"))?;
        exported += 1;
    }

    if exported == 0 {
        return Err("No scene boundaries were found with the current threshold.".to_string());
    }

    Ok(())
}

fn resize_for_canvas(image: DynamicImage, max_width: u32) -> DynamicImage {
    if image.width() <= max_width {
        image
    } else {
        image.resize(max_width, u32::MAX, FilterType::Lanczos3)
    }
}

pub fn export_portfolio_sheet(
    image_paths: &[String],
    output_path: &str,
    columns: u32,
) -> Result<(), String> {
    if image_paths.len() < 2 {
        return Err("Select at least two images to create a portfolio sheet.".to_string());
    }

    let columns = columns.max(1);
    let rows = ((image_paths.len() as f32) / columns as f32).ceil() as u32;
    let gap = 24u32;
    let margin = 32u32;

    let mut thumbnails = Vec::new();
    let mut max_tile_height = 0u32;
    for path in image_paths {
        let image = image::open(path).map_err(|error| format!("Failed to open image. {error}"))?;
        let resized = resize_for_canvas(image, PORTFOLIO_TILE_WIDTH);
        max_tile_height = max_tile_height.max(resized.height());
        thumbnails.push(resized.to_rgba8());
    }

    let canvas_width = margin * 2 + columns * PORTFOLIO_TILE_WIDTH + (columns - 1) * gap;
    let canvas_height = margin * 2 + rows * max_tile_height + (rows - 1) * gap;
    let mut canvas: RgbaImage =
        ImageBuffer::from_pixel(canvas_width, canvas_height, Rgba([245, 245, 245, 255]));

    for (index, thumbnail) in thumbnails.iter().enumerate() {
        let column = index as u32 % columns;
        let row = index as u32 / columns;
        let x = margin + column * (PORTFOLIO_TILE_WIDTH + gap);
        let y = margin + row * (max_tile_height + gap);
        overlay(&mut canvas, thumbnail, x.into(), y.into());
    }

    DynamicImage::ImageRgba8(canvas)
        .save(output_path)
        .map_err(|error| format!("Failed to save the portfolio sheet. {error}"))
}

fn resize_dimensions_for_preset(preset_key: &str) -> Result<(u32, u32), String> {
    match preset_key {
        "square_1080" => Ok((1080, 1080)),
        "story_1080x1920" => Ok((1080, 1920)),
        "landscape_1920x1080" => Ok((1920, 1080)),
        "thumb_1280x720" => Ok((1280, 720)),
        _ => Err("Unknown resize preset.".to_string()),
    }
}

pub fn resize_media_with_preset(
    app: &AppHandle,
    file_path: &str,
    output_path: &str,
    preset_key: &str,
) -> Result<(), String> {
    let source = PathBuf::from(file_path);
    let output = PathBuf::from(output_path);
    let ffmpeg = detect_ffmpeg_binary(app, "ffmpeg")?;
    let (width, height) = resize_dimensions_for_preset(preset_key)?;
    let extension = output
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase();

    let scale_filter = format!(
        "scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black"
    );
    let mut args = vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-i".to_string(),
        source.to_string_lossy().to_string(),
    ];

    if matches!(
        extension.as_str(),
        "mp4" | "mov" | "m4v" | "webm" | "mkv" | "avi" | "wmv"
    ) {
        args.extend([
            "-vf".to_string(),
            scale_filter,
            "-c:v".to_string(),
            "libx264".to_string(),
            "-preset".to_string(),
            "veryfast".to_string(),
            "-crf".to_string(),
            "20".to_string(),
            "-c:a".to_string(),
            "aac".to_string(),
            "-movflags".to_string(),
            "+faststart".to_string(),
        ]);
    } else {
        args.extend(["-vf".to_string(), scale_filter]);
    }
    args.push(output.to_string_lossy().to_string());

    let working_dir = output
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(std::env::temp_dir);
    run_command_without_capture(&ffmpeg, &args, &working_dir)
        .map_err(|error| format!("Resize export failed. {error}"))
}
