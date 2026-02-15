mod batch;
mod image_engine;
mod path_policy;
mod pdf_engine;

use image_engine::{StampFileResult, StampSettingsInput};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::PathBuf;
use tauri::{path::BaseDirectory, AppHandle, Emitter, Manager};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchProgressEvent {
    request_id: String,
    total: usize,
    done: usize,
    input_path: String,
    ok: bool,
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn stamp_images(
    app: AppHandle,
    paths: Vec<String>,
    settings: StampSettingsInput,
) -> Vec<StampFileResult> {
    let logo_path = match app.path().resolve("logo.webp", BaseDirectory::Resource) {
        Ok(path) => path,
        Err(e) => {
            let message = format!("로고 리소스 경로를 찾지 못했습니다: {e}");
            return paths
                .into_iter()
                .map(|input_path| StampFileResult {
                    input_path,
                    ok: false,
                    output_path: None,
                    error: Some(message.clone()),
                })
                .collect();
        }
    };

    image_engine::stamp_images(&paths, settings, &logo_path, None)
}

#[tauri::command]
fn stamp_pdfs(
    app: AppHandle,
    paths: Vec<String>,
    settings: StampSettingsInput,
) -> Vec<StampFileResult> {
    let logo_path = match app.path().resolve("logo.webp", BaseDirectory::Resource) {
        Ok(path) => path,
        Err(e) => {
            let message = format!("로고 리소스 경로를 찾지 못했습니다: {e}");
            return paths
                .into_iter()
                .map(|input_path| StampFileResult {
                    input_path,
                    ok: false,
                    output_path: None,
                    error: Some(message.clone()),
                })
                .collect();
        }
    };

    pdf_engine::stamp_pdfs(&paths, settings, &logo_path, None)
}

#[tauri::command]
fn stamp_batch(
    app: AppHandle,
    paths: Vec<String>,
    settings: StampSettingsInput,
    logo_path: Option<String>,
    output_dir: Option<String>,
) -> Vec<StampFileResult> {
    let logo_path = match resolve_logo_path(&app, logo_path) {
        Ok(path) => path,
        Err(e) => {
            let message = format!("로고 파일 경로를 찾지 못했습니다: {e}");
            return paths
                .into_iter()
                .map(|input_path| StampFileResult {
                    input_path,
                    ok: false,
                    output_path: None,
                    error: Some(message.clone()),
                })
                .collect();
        }
    };

    let output_dir = output_dir
        .and_then(normalize_optional_path)
        .map(PathBuf::from);

    batch::stamp_batch(&paths, settings, &logo_path, output_dir.as_deref())
}

#[tauri::command]
fn cancel_stamp_batch(request_id: String) -> bool {
    batch::cancel_cancellation_request(&request_id)
}

#[tauri::command]
async fn stamp_batch_progress(
    app: AppHandle,
    paths: Vec<String>,
    settings: StampSettingsInput,
    logo_path: Option<String>,
    output_dir: Option<String>,
    request_id: String,
    size_percent_by_path: Option<BTreeMap<String, f32>>,
) -> Vec<StampFileResult> {
    let logo_path = match resolve_logo_path(&app, logo_path) {
        Ok(path) => path,
        Err(e) => {
            let message = format!("로고 파일 경로를 찾지 못했습니다: {e}");
            return paths
                .into_iter()
                .map(|input_path| StampFileResult {
                    input_path,
                    ok: false,
                    output_path: None,
                    error: Some(message.clone()),
                })
                .collect();
        }
    };

    let output_dir = output_dir
        .and_then(normalize_optional_path)
        .map(PathBuf::from);

    let app_for_emit = app.clone();
    let paths_for_error = paths.clone();
    let request_id_for_work = request_id.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let _request_guard = batch::begin_cancellation_request(&request_id_for_work);
        let mut emit_progress = |progress: batch::ProgressUpdate| {
            let payload = BatchProgressEvent {
                request_id: request_id.clone(),
                total: progress.total,
                done: progress.done,
                input_path: progress.input_path,
                ok: progress.ok,
            };
            let _ = app_for_emit.emit("cornerbrand://progress", payload);
        };

        batch::stamp_batch_with_progress(
            &paths,
            settings,
            &logo_path,
            output_dir.as_deref(),
            Some(&request_id_for_work),
            &mut emit_progress,
            size_percent_by_path.as_ref(),
        )
    })
    .await
    .unwrap_or_else(|error| {
        let message = format!("배치 처리 작업이 중단되었습니다: {error}");
        paths_for_error
            .into_iter()
            .map(|input_path| StampFileResult {
                input_path,
                ok: false,
                output_path: None,
                error: Some(message.clone()),
            })
            .collect()
    })
}

#[tauri::command]
async fn stamp_batch_preview(
    app: AppHandle,
    paths: Vec<String>,
    settings: StampSettingsInput,
    logo_path: Option<String>,
    request_id: String,
    size_percent_by_path: Option<BTreeMap<String, f32>>,
) -> Vec<StampFileResult> {
    let logo_path = match resolve_logo_path(&app, logo_path) {
        Ok(path) => path,
        Err(e) => {
            let message = format!("로고 파일 경로를 찾지 못했습니다: {e}");
            return paths
                .into_iter()
                .map(|input_path| StampFileResult {
                    input_path,
                    ok: false,
                    output_path: None,
                    error: Some(message.clone()),
                })
                .collect();
        }
    };

    let preview_output_dir = match prepare_preview_output_dir(&request_id) {
        Ok(path) => path,
        Err(e) => {
            let message = format!("미리보기 출력 디렉터리를 준비하지 못했습니다: {e}");
            return paths
                .into_iter()
                .map(|input_path| StampFileResult {
                    input_path,
                    ok: false,
                    output_path: None,
                    error: Some(message.clone()),
                })
                .collect();
        }
    };

    let app_for_emit = app.clone();
    let paths_for_error = paths.clone();
    let request_id_for_work = request_id.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let _request_guard = batch::begin_cancellation_request(&request_id_for_work);
        let mut emit_progress = |progress: batch::ProgressUpdate| {
            let payload = BatchProgressEvent {
                request_id: request_id.clone(),
                total: progress.total,
                done: progress.done,
                input_path: progress.input_path,
                ok: progress.ok,
            };
            let _ = app_for_emit.emit("cornerbrand://progress", payload);
        };

        batch::stamp_batch_with_progress(
            &paths,
            settings,
            &logo_path,
            Some(preview_output_dir.as_path()),
            Some(&request_id_for_work),
            &mut emit_progress,
            size_percent_by_path.as_ref(),
        )
    })
    .await
    .unwrap_or_else(|error| {
        let message = format!("배치 처리 작업이 중단되었습니다: {error}");
        paths_for_error
            .into_iter()
            .map(|input_path| StampFileResult {
                input_path,
                ok: false,
                output_path: None,
                error: Some(message.clone()),
            })
            .collect()
    })
}

fn resolve_logo_path(app: &AppHandle, logo_path: Option<String>) -> Result<PathBuf, String> {
    if let Some(user_logo_path) = logo_path.and_then(normalize_optional_path) {
        let candidate = PathBuf::from(user_logo_path);
        if candidate.is_file() {
            return Ok(candidate);
        }
        return Err("선택한 로고 파일이 존재하지 않거나 파일이 아닙니다.".to_string());
    }

    let mut candidates = Vec::new();
    if let Ok(path) = app.path().resolve("logo.png", BaseDirectory::Resource) {
        candidates.push(path);
    }
    if let Ok(path) = app.path().resolve("logo.webp", BaseDirectory::Resource) {
        candidates.push(path);
    }

    let cwd =
        std::env::current_dir().map_err(|e| format!("현재 경로를 확인하지 못했습니다: {e}"))?;
    candidates.push(cwd.join("logo.png"));
    candidates.push(cwd.join("logo.webp"));

    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            "기본 로고를 찾지 못했습니다. (resource logo.png/logo.webp, cwd logo.png/logo.webp)"
                .to_string()
        })
}

fn normalize_optional_path(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn prepare_preview_output_dir(request_id: &str) -> Result<PathBuf, String> {
    let preview_dir = std::env::temp_dir()
        .join("cornerbrand-preview")
        .join(request_id);

    if preview_dir.exists() {
        std::fs::remove_dir_all(&preview_dir)
            .map_err(|e| format!("기존 미리보기 디렉터리 삭제 실패: {e}"))?;
    }

    std::fs::create_dir_all(&preview_dir)
        .map_err(|e| format!("미리보기 디렉터리 생성 실패: {e}"))?;

    Ok(preview_dir)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            greet,
            stamp_images,
            stamp_pdfs,
            stamp_batch,
            cancel_stamp_batch,
            stamp_batch_progress,
            stamp_batch_preview
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
