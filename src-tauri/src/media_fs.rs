use crate::models::{MediaItem, ScanResult, LARGE_IMAGE_WARNING_BYTES};
use chrono::Local;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;
use zip::ZipArchive;

pub fn media_kind_for_extension(ext: &str) -> Option<&'static str> {
    match ext {
        ".jpg" | ".jpeg" | ".png" | ".gif" | ".webp" | ".bmp" | ".svg" | ".avif" => Some("image"),
        ".mp4" | ".mov" | ".m4v" | ".webm" | ".mkv" | ".avi" | ".wmv" => Some("video"),
        _ => None,
    }
}

pub fn extension_from_path(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{}", value.to_lowercase()))
        .unwrap_or_default()
}

pub fn is_zip_archive(path: &Path) -> bool {
    extension_from_path(path) == ".zip"
}

pub fn modified_ms(metadata: &std::fs::Metadata) -> u128 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

pub fn normalize_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

pub fn is_remove_bg_supported_image(path: &Path) -> bool {
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

pub fn remove_bg_output_path(source: &Path) -> Result<PathBuf, String> {
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

pub fn extract_frames_output_dir(source: &Path) -> Result<PathBuf, String> {
    let parent = source
        .parent()
        .ok_or_else(|| "Could not resolve the parent folder.".to_string())?;
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Could not resolve the file name.".to_string())?;

    Ok(unique_child_dir(parent, stem))
}

pub fn unique_output_file(parent: &Path, base_name: &str, extension: &str) -> PathBuf {
    let mut candidate = parent.join(format!("{base_name}.{extension}"));
    let mut index = 2;

    while candidate.exists() {
        candidate = parent.join(format!("{base_name}_{index}.{extension}"));
        index += 1;
    }

    candidate
}

pub fn unique_named_path(parent: &Path, base_name: &str, extension: Option<&str>) -> PathBuf {
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

pub fn resolve_folder_path(root_path: &str, relative_folder_path: &str) -> PathBuf {
    let root = PathBuf::from(root_path);
    if relative_folder_path.is_empty() {
        return root;
    }

    relative_folder_path
        .split('/')
        .fold(root, |current, segment| current.join(segment))
}

pub fn common_parent_dir(paths: &[PathBuf]) -> Option<PathBuf> {
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

pub fn large_media_warning(source: &Path) -> Option<String> {
    let metadata = fs::metadata(source).ok()?;
    if metadata.len() < LARGE_IMAGE_WARNING_BYTES {
        return None;
    }

    Some("Large file detected. This may take longer and use more memory.".to_string())
}

fn archive_cache_dir(source: &Path) -> Result<PathBuf, String> {
    let metadata = fs::metadata(source).map_err(|error| error.to_string())?;
    let modified = modified_ms(&metadata);
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    normalize_path(source).hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    modified.hash(&mut hasher);
    let cache_key = format!("{:016x}", hasher.finish());
    Ok(std::env::temp_dir()
        .join("media-vault-archive-cache")
        .join(cache_key))
}

fn extract_zip_media_to_cache(source: &Path, target_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(target_dir).map_err(|error| error.to_string())?;

    let file = fs::File::open(source).map_err(|error| error.to_string())?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("Failed to open ZIP archive. {error}"))?;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("Failed to read ZIP entry. {error}"))?;
        if entry.is_dir() {
            continue;
        }

        let Some(relative_path) = entry.enclosed_name() else {
            continue;
        };
        let extension = extension_from_path(&relative_path);
        if media_kind_for_extension(&extension).is_none() {
            continue;
        }

        let output_path = target_dir.join(&relative_path);
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }

        let mut output_file = fs::File::create(&output_path).map_err(|error| error.to_string())?;
        std::io::copy(&mut entry, &mut output_file).map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn scan_zip_archive(source: &Path) -> Result<ScanResult, String> {
    let cache_dir = archive_cache_dir(source)?;
    if !cache_dir.exists() {
        extract_zip_media_to_cache(source, &cache_dir)?;
    }

    let mut result = scan_folder(&cache_dir)?;
    result.root_path = source.to_string_lossy().to_string();
    result.root_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| "Archive".to_string());
    Ok(result)
}

pub fn scan_folder(root: &Path) -> Result<ScanResult, String> {
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
        let ext = extension_from_path(path);

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
            .unwrap_or_else(|_| {
                path.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string()
            });

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

pub fn scan_media_path(root: &Path) -> Result<ScanResult, String> {
    if !root.exists() {
        return Err("Selected folder no longer exists.".to_string());
    }
    if root.is_dir() {
        return scan_folder(root);
    }
    if is_zip_archive(root) {
        return scan_zip_archive(root);
    }
    Err("Selected path must be a folder or ZIP archive.".to_string())
}

pub fn rename_media_file(file_path: String, new_name: String) -> Result<String, String> {
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

pub fn delete_media_file(file_path: String) -> Result<(), String> {
    let source = PathBuf::from(&file_path);
    if !source.exists() {
        return Err("Selected file no longer exists.".to_string());
    }
    fs::remove_file(source).map_err(|error| error.to_string())
}

pub fn duplicate_media_file(file_path: String) -> Result<String, String> {
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

pub fn create_media_folder(root_path: String, relative_folder_path: String) -> Result<String, String> {
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

pub fn duplicate_media_folder(
    root_path: String,
    relative_folder_path: String,
) -> Result<String, String> {
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

pub fn delete_media_folder(root_path: String, relative_folder_path: String) -> Result<(), String> {
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
