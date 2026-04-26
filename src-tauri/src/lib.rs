use rfd::FileDialog;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            pick_root_folder,
            scan_media_folder,
            rename_media_file,
            delete_media_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
