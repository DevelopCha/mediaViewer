use serde::Serialize;

pub const BACKGROUND_TASK_EVENT: &str = "background-task-updated";
pub const LARGE_IMAGE_WARNING_BYTES: u64 = 12 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaItem {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub path: String,
    pub archive_path: Option<String>,
    pub archive_entry_path: Option<String>,
    pub relative_path: String,
    pub ext: String,
    pub size_bytes: u64,
    pub modified_ms: u128,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub root_path: String,
    pub root_name: String,
    pub items: Vec<MediaItem>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundTask {
    pub id: String,
    pub kind: String,
    pub engine_key: String,
    pub engine_label: String,
    pub input_paths: Option<Vec<String>>,
    pub duration_seconds: Option<u32>,
    pub extract_eye_mode: Option<String>,
    pub extract_layout: Option<String>,
    pub source_path: String,
    pub output_path: String,
    pub file_name: String,
    pub status: String,
    pub progress: u8,
    pub message: String,
    pub created_at_ms: u128,
    pub updated_at_ms: u128,
    pub error: Option<String>,
    pub warning: Option<String>,
}

pub fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}
