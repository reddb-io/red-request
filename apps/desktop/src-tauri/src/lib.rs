use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::oneshot;

// ---------------------------------------------------------------------------
// OS keychain bridge (verbatim pattern from red-ui). Secrets referenced by an
// environment's `secretRefs` live here, never in the YAML on disk.
// ---------------------------------------------------------------------------

#[tauri::command]
fn keychain_set(service: String, key: String, value: String) -> Result<(), String> {
    let entry = keyring::Entry::new(&service, &key).map_err(|e| e.to_string())?;
    entry.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
fn keychain_get(service: String, key: String) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(&service, &key).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn keychain_delete(service: String, key: String) -> Result<(), String> {
    let entry = keyring::Entry::new(&service, &key).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ---------------------------------------------------------------------------
// Collections filesystem IO. The UI/core owns YAML parsing; Rust only does
// scoped text IO under the app's collections directory.
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

fn collections_root_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("collections");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Guard every fs op to stay within the collections root (block path traversal).
fn ensure_under_root(app: &tauri::AppHandle, path: &str) -> Result<std::path::PathBuf, String> {
    let root = collections_root_path(app)?;
    let p = std::path::Path::new(path);
    let candidate = if p.is_absolute() {
        p.to_path_buf()
    } else {
        root.join(p)
    };
    // Normalize by rejecting any `..` component rather than canonicalizing (which
    // fails for not-yet-created files on write).
    if candidate.components().any(|c| c == std::path::Component::ParentDir) {
        return Err("path traversal is not allowed".to_string());
    }
    if !candidate.starts_with(&root) {
        return Err("path is outside the collections directory".to_string());
    }
    Ok(candidate)
}

#[tauri::command]
fn collections_root(app: tauri::AppHandle) -> Result<String, String> {
    Ok(collections_root_path(&app)?.to_string_lossy().to_string())
}

#[tauri::command]
fn fs_list_dir(app: tauri::AppHandle, path: String) -> Result<Vec<DirEntry>, String> {
    let dir = ensure_under_root(&app, &path)?;
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = vec![];
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        out.push(DirEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path().to_string_lossy().to_string(),
            is_dir: meta.is_dir(),
        });
    }
    out.sort_by(|a, b| (b.is_dir, &a.name).cmp(&(a.is_dir, &b.name)));
    Ok(out)
}

#[tauri::command]
fn fs_read_text(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let file = ensure_under_root(&app, &path)?;
    std::fs::read_to_string(&file).map_err(|e| e.to_string())
}

#[tauri::command]
fn fs_write_text(app: tauri::AppHandle, path: String, contents: String) -> Result<(), String> {
    let file = ensure_under_root(&app, &path)?;
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&file, contents).map_err(|e| e.to_string())
}

#[tauri::command]
fn fs_mkdirp(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let dir = ensure_under_root(&app, &path)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())
}

#[tauri::command]
fn fs_remove(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let target = ensure_under_root(&app, &path)?;
    if target.is_dir() {
        std::fs::remove_dir_all(&target).map_err(|e| e.to_string())
    } else if target.exists() {
        std::fs::remove_file(&target).map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// recker engine sidecar — one long-lived child, NDJSON-RPC over stdio.
// engine_call writes a line to stdin and awaits the reply correlated by id.
// Stream notifications (no id) are re-emitted to the webview as Tauri events.
// ---------------------------------------------------------------------------

#[derive(Default)]
struct EngineState {
    child: Mutex<Option<CommandChild>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<serde_json::Value, String>>>>,
    counter: AtomicU64,
}

fn spawn_engine(
    app: &tauri::AppHandle,
) -> Result<(tauri::async_runtime::Receiver<CommandEvent>, CommandChild), String> {
    let shell = app.shell();
    // Production: the bundled, bun-compiled sidecar binary.
    if let Some(Ok(pair)) = shell.sidecar("red-requester-engine").ok().map(|c| c.spawn()) {
        return Ok(pair);
    }
    // Dev (`tauri dev`): the sidecar binary isn't built, so run the engine's
    // compiled JS with `node` from PATH. Path is resolved relative to this crate.
    let engine_js = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/engine/dist/main.js");
    shell
        .command("node")
        .args([engine_js.to_string_lossy().to_string()])
        .spawn()
        .map(|(rx, child)| (rx, child))
        .map_err(|e| format!("failed to start engine (no sidecar binary, and `node` failed): {e}"))
}

fn handle_engine_line(app: &tauri::AppHandle, line: &str) {
    if line.is_empty() {
        return;
    }
    let value: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[engine] unparseable line: {e}");
            return;
        }
    };
    // Stream notification (SSE/WS/progress) — forward to the webview.
    if value.get("stream").is_some() {
        let _ = app.emit("engine://stream", value);
        return;
    }
    // RPC reply — resolve the pending call.
    if let Some(id) = value.get("id").and_then(|i| i.as_u64()) {
        let state = app.state::<EngineState>();
        let sender = state.pending.lock().ok().and_then(|mut m| m.remove(&id));
        if let Some(tx) = sender {
            let payload = if let Some(err) = value.get("error") {
                Err(err
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("engine error")
                    .to_string())
            } else {
                Ok(value.get("result").cloned().unwrap_or(serde_json::Value::Null))
            };
            let _ = tx.send(payload);
        }
    }
}

#[tauri::command]
async fn engine_call(
    app: tauri::AppHandle,
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let id = app
        .state::<EngineState>()
        .counter
        .fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = oneshot::channel();
    app.state::<EngineState>()
        .pending
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, tx);

    let line = format!(
        "{}\n",
        serde_json::json!({ "id": id, "method": method, "params": params })
    );
    {
        let state = app.state::<EngineState>();
        let mut guard = state.child.lock().map_err(|e| e.to_string())?;
        let child = guard
            .as_mut()
            .ok_or_else(|| "engine is not running".to_string())?;
        child.write(line.as_bytes()).map_err(|e| e.to_string())?;
    }

    match tokio::time::timeout(std::time::Duration::from_secs(120), rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("engine channel closed".to_string()),
        Err(_) => {
            app.state::<EngineState>()
                .pending
                .lock()
                .ok()
                .map(|mut m| m.remove(&id));
            Err("engine call timed out".to_string())
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .manage(EngineState::default())
        .setup(|app| {
            // Deep links (rr:// branded scheme).
            let dl_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let urls: Vec<String> =
                    event.urls().into_iter().map(|u| u.to_string()).collect();
                let _ = dl_handle.emit("deep-link", urls);
            });

            // Start the recker engine sidecar and pump its stdout.
            let app_handle = app.handle().clone();
            match spawn_engine(&app_handle) {
                Ok((mut rx, child)) => {
                    *app.state::<EngineState>()
                        .child
                        .lock()
                        .expect("engine child lock") = Some(child);
                    let reader = app_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        let mut buf = String::new();
                        while let Some(event) = rx.recv().await {
                            match event {
                                CommandEvent::Stdout(bytes) => {
                                    buf.push_str(&String::from_utf8_lossy(&bytes));
                                    while let Some(pos) = buf.find('\n') {
                                        let line: String = buf.drain(..=pos).collect();
                                        handle_engine_line(&reader, line.trim_end());
                                    }
                                }
                                CommandEvent::Stderr(bytes) => {
                                    eprint!("{}", String::from_utf8_lossy(&bytes));
                                }
                                CommandEvent::Terminated(_) => break,
                                _ => {}
                            }
                        }
                    });
                }
                Err(e) => eprintln!("[engine] {e}"),
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            keychain_set,
            keychain_get,
            keychain_delete,
            collections_root,
            fs_list_dir,
            fs_read_text,
            fs_write_text,
            fs_mkdirp,
            fs_remove,
            engine_call,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Reap the engine sidecar on exit.
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<EngineState>() {
                    if let Ok(mut guard) = state.child.lock() {
                        if let Some(child) = guard.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        });
}
