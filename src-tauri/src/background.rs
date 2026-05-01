use crate::external_tools::{perform_background_removal_with_engine, perform_frame_extraction};
use crate::models::{now_ms, BackgroundTask, BACKGROUND_TASK_EVENT};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

const MAX_BACKGROUND_TASK_HISTORY: usize = 30;

pub struct BackgroundTaskDraft {
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
    pub warning: Option<String>,
}

pub struct BackgroundRemovalState {
    pub inner: Arc<Mutex<BackgroundRemovalQueue>>,
}

pub struct BackgroundRemovalQueue {
    tasks: HashMap<String, BackgroundTask>,
    order: Vec<String>,
    pending: VecDeque<String>,
    worker_running: bool,
    next_id: u64,
}

impl BackgroundRemovalQueue {
    pub fn new() -> Self {
        Self {
            tasks: HashMap::new(),
            order: Vec::new(),
            pending: VecDeque::new(),
            worker_running: false,
            next_id: 1,
        }
    }

    pub fn snapshots(&self) -> Vec<BackgroundTask> {
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

pub fn emit_task_update(app: &AppHandle, task: &BackgroundTask) {
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

pub fn enqueue_task(
    app: &AppHandle,
    queue_state: &Arc<Mutex<BackgroundRemovalQueue>>,
    draft: BackgroundTaskDraft,
) -> BackgroundTask {
    let created_at_ms = now_ms();

    let (task, should_start_worker) = {
        let mut queue = queue_state.lock().unwrap();
        let task_id = format!("bg-remove-{}", queue.next_id);
        queue.next_id += 1;

        let task = BackgroundTask {
            id: task_id.clone(),
            kind: draft.kind,
            engine_key: draft.engine_key,
            engine_label: draft.engine_label,
            input_paths: draft.input_paths,
            duration_seconds: draft.duration_seconds,
            extract_eye_mode: draft.extract_eye_mode,
            extract_layout: draft.extract_layout,
            source_path: draft.source_path,
            output_path: draft.output_path,
            file_name: draft.file_name,
            status: "queued".to_string(),
            progress: 0,
            message: "Waiting in queue...".to_string(),
            created_at_ms,
            updated_at_ms: created_at_ms,
            error: None,
            warning: draft.warning,
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

    task
}

pub fn cancel_task(
    app: &AppHandle,
    queue_state: &Arc<Mutex<BackgroundRemovalQueue>>,
    task_id: String,
) -> Result<BackgroundTask, String> {
    let task = {
        let mut queue = queue_state.lock().unwrap();
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

    emit_task_update(app, &task);
    Ok(task)
}

pub fn clear_finished_tasks(queue_state: &Arc<Mutex<BackgroundRemovalQueue>>) {
    let mut queue = queue_state.lock().unwrap();
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

fn spawn_background_worker(app: AppHandle, tasks: Arc<Mutex<BackgroundRemovalQueue>>) {
    tauri::async_runtime::spawn(async move {
        loop {
            let next_job = {
                let mut state = tasks.lock().unwrap();
                if let Some(task_id) = state.pending.pop_front() {
                    if let Some(task) = state.tasks.get_mut(&task_id) {
                        task.status = "running".to_string();
                        task.progress = 12;
                        task.message = if task.kind == "extractFrames" {
                            "Preparing frame extraction...".to_string()
                        } else {
                            "Preparing background removal...".to_string()
                        };
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
                if task.kind == "extractFrames" {
                    "Preparing video decoder..."
                } else {
                    "Preparing model and runtime..."
                },
                None,
            );
            update_task(
                &tasks,
                &app,
                &task.id,
                "running",
                68,
                if task.kind == "extractFrames" {
                    "Extracting frames. Large videos can take a while..."
                } else {
                    "Removing background. Large images can take a while..."
                },
                None,
            );

            let source_path = task.source_path.clone();
            let output_path = task.output_path.clone();
            let engine_key = task.engine_key.clone();
            let extract_eye_mode = task
                .extract_eye_mode
                .clone()
                .unwrap_or_else(|| "standard".to_string());
            let extract_layout = task
                .extract_layout
                .clone()
                .unwrap_or_else(|| "sbs".to_string());
            let task_kind = task.kind.clone();
            let worker_app = app.clone();
            let result = tauri::async_runtime::spawn_blocking(move || match task_kind.as_str() {
                "extractFrames" => perform_frame_extraction(
                    &worker_app,
                    &source_path,
                    &output_path,
                    &engine_key,
                    &extract_eye_mode,
                    &extract_layout,
                ),
                _ => perform_background_removal_with_engine(
                    &worker_app,
                    &source_path,
                    &output_path,
                    &engine_key,
                ),
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
