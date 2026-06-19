use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
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

/// Filesystem root for YAML export/import — the directory holding `app.rdb`
/// (`.red/request/`), so exports live next to the project DB.
fn collections_root_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let db = app
        .state::<EmbeddedDb>()
        .db_path
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let dir = std::path::Path::new(&db)
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "db path has no parent".to_string())?;
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

// ---------------------------------------------------------------------------
// Secret sealing — AES-256-GCM with a master key kept in the OS keychain. The
// `.rdb` is plaintext at rest, so secret VALUES are sealed before being stored.
// The master key never enters the webview.
// ---------------------------------------------------------------------------

const MASTER_KEY_SERVICE: &str = "io.reddb.requester";
const MASTER_KEY_NAME: &str = "master-key";

#[derive(Serialize, Deserialize)]
struct Sealed {
    iv: String,
    ct: String,
}

fn master_key() -> Result<[u8; 32], String> {
    let entry =
        keyring::Entry::new(MASTER_KEY_SERVICE, MASTER_KEY_NAME).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(b64s) => {
            let bytes = B64.decode(b64s).map_err(|e| e.to_string())?;
            bytes
                .try_into()
                .map_err(|_| "master key has wrong length".to_string())
        }
        Err(keyring::Error::NoEntry) => {
            use rand::RngCore;
            let mut key = [0u8; 32];
            rand::rngs::OsRng.fill_bytes(&mut key);
            entry.set_password(&B64.encode(key)).map_err(|e| e.to_string())?;
            Ok(key)
        }
        Err(e) => Err(e.to_string()),
    }
}

fn seal_with_key(key: &[u8; 32], plaintext: &str) -> Result<Sealed, String> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Key, Nonce};
    use rand::RngCore;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let mut nb = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nb);
    let nonce = Nonce::from_slice(&nb);
    let ct = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(Sealed {
        iv: B64.encode(nb),
        ct: B64.encode(ct),
    })
}

fn open_with_key(key: &[u8; 32], iv: &str, ct: &str) -> Result<String, String> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Key, Nonce};
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nb = B64.decode(iv).map_err(|e| e.to_string())?;
    let ctb = B64.decode(ct).map_err(|e| e.to_string())?;
    let pt = cipher
        .decrypt(Nonce::from_slice(&nb), ctb.as_ref())
        .map_err(|_| "decryption failed".to_string())?;
    String::from_utf8(pt).map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_seal(plaintext: String) -> Result<Sealed, String> {
    seal_with_key(&master_key()?, &plaintext)
}

#[tauri::command]
fn secret_open(iv: String, ct: String) -> Result<String, String> {
    open_with_key(&master_key()?, &iv, &ct)
}

// ---------------------------------------------------------------------------
// Embedded RedDB sidecar — `red server` on a local .rdb, the app's persistence.
// ---------------------------------------------------------------------------

#[derive(Default)]
struct EmbeddedDb {
    url: Mutex<Option<String>>,
    child: Mutex<Option<CommandChild>>,
    db_path: Mutex<String>,
    project_dir: Mutex<Option<String>>,
    /// Whether the app was launched with a directory arg (`rr <dir>`), in which case
    /// the UI skips the project selector and opens straight in.
    arg_launched: Mutex<bool>,
    /// Serializes (re)spawn so a dead sidecar isn't replaced by several at once
    /// (multiple `red server` on one .rdb corrupts the B-tree).
    spawn_lock: tokio::sync::Mutex<()>,
}

/// Resolve which `.rdb` to open. A path arg (`rr .` / `rr <dir>`) → project mode at
/// `<dir>/.red/request/app.rdb`; otherwise the global `~/.red/request/app.rdb`.
/// (The `.red` dir name is the family convention; brandify later.)
fn resolve_db_target() -> (std::path::PathBuf, Option<String>) {
    let arg = std::env::args().skip(1).find(|a| !a.starts_with('-'));
    if let Some(a) = arg {
        let base = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
        let abs = std::fs::canonicalize(&a).unwrap_or_else(|_| base.join(&a));
        let dir = if abs.is_file() {
            abs.parent().map(|p| p.to_path_buf()).unwrap_or(abs.clone())
        } else {
            abs
        };
        let db = dir.join(".red").join("request").join("app.rdb");
        return (db, Some(dir.to_string_lossy().to_string()));
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let db = std::path::Path::new(&home)
        .join(".red")
        .join("request")
        .join("app.rdb");
    (db, None)
}

#[derive(Serialize)]
struct ProjectInfo {
    db_path: String,
    project_dir: Option<String>,
    is_project: bool,
    arg_launched: bool,
}

fn project_info_for(app: &tauri::AppHandle) -> Result<ProjectInfo, String> {
    let s = app.state::<EmbeddedDb>();
    let db_path = s.db_path.lock().map_err(|e| e.to_string())?.clone();
    let project_dir = s.project_dir.lock().map_err(|e| e.to_string())?.clone();
    let arg_launched = *s.arg_launched.lock().map_err(|e| e.to_string())?;
    Ok(ProjectInfo {
        is_project: project_dir.is_some(),
        db_path,
        project_dir,
        arg_launched,
    })
}

#[tauri::command]
fn project_info(app: tauri::AppHandle) -> Result<ProjectInfo, String> {
    project_info_for(&app)
}

#[derive(Serialize, Deserialize, Clone)]
struct RecentProject {
    dir: String,
    name: String,
    last_opened: u64,
}

fn recents_path() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    std::path::Path::new(&home)
        .join(".red")
        .join("request")
        .join("recents.json")
}

#[tauri::command]
fn recent_list() -> Vec<RecentProject> {
    std::fs::read_to_string(recents_path())
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<RecentProject>>(&s).ok())
        .unwrap_or_default()
}

fn recent_add_dir(dir: &str) {
    let abs = std::fs::canonicalize(dir)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| dir.to_string());
    let name = std::path::Path::new(&abs)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| abs.clone());
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut list = recent_list();
    list.retain(|r| r.dir != abs);
    list.insert(
        0,
        RecentProject {
            dir: abs,
            name,
            last_opened: now,
        },
    );
    list.truncate(12);
    let p = recents_path();
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(s) = serde_json::to_string_pretty(&list) {
        let _ = std::fs::write(&p, s);
    }
}

/// Switch the embedded reddb to another project (or the global store with `dir = None`)
/// at runtime: stop the current sidecar, repoint the path, respawn, return the new info.
#[tauri::command]
async fn open_project(
    app: tauri::AppHandle,
    dir: Option<String>,
) -> Result<ProjectInfo, String> {
    let (db_path, project_dir) = match dir.as_deref() {
        Some(d) => {
            let abs = std::fs::canonicalize(d).unwrap_or_else(|_| std::path::PathBuf::from(d));
            (
                abs.join(".red")
                    .join("request")
                    .join("app.rdb")
                    .to_string_lossy()
                    .to_string(),
                Some(abs.to_string_lossy().to_string()),
            )
        }
        None => {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
            (
                std::path::Path::new(&home)
                    .join(".red")
                    .join("request")
                    .join("app.rdb")
                    .to_string_lossy()
                    .to_string(),
                None,
            )
        }
    };

    let st = app.state::<EmbeddedDb>();
    let _guard = st.spawn_lock.lock().await;
    if let Ok(mut c) = st.child.lock() {
        if let Some(child) = c.take() {
            let _ = child.kill();
        }
    }
    if let Ok(mut u) = st.url.lock() {
        *u = None;
    }
    if let Ok(mut p) = st.db_path.lock() {
        *p = db_path;
    }
    if let Ok(mut d) = st.project_dir.lock() {
        *d = project_dir.clone();
    }
    start_reddb(app.clone()).await?;
    if let Some(d) = &project_dir {
        recent_add_dir(d);
    }
    project_info_for(&app)
}

/// Locate the bundled `red` binary in `binaries/` (dev fallback when the Tauri
/// sidecar copy isn't present). Excludes the `red-requester-engine` binary.
fn find_red_binary() -> Option<String> {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
    for e in std::fs::read_dir(&dir).ok()?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with("red-") && !name.starts_with("red-requester") {
            return Some(e.path().to_string_lossy().to_string());
        }
    }
    None
}

async fn reddb_wait_ready(bind: &str) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        if std::time::Instant::now() > deadline {
            return Err("embedded reddb did not become ready within 20s".to_string());
        }
        if let Ok(mut stream) = tokio::net::TcpStream::connect(bind).await {
            let req = format!("GET /stats HTTP/1.0\r\nHost: {bind}\r\nConnection: close\r\n\r\n");
            if stream.write_all(req.as_bytes()).await.is_ok() {
                let mut buf = [0u8; 32];
                if let Ok(n) = stream.read(&mut buf).await {
                    if String::from_utf8_lossy(&buf[..n]).contains(" 200") {
                        return Ok(());
                    }
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
}

async fn start_reddb(app: tauri::AppHandle) -> Result<(), String> {
    let db_path = std::path::PathBuf::from(
        app.state::<EmbeddedDb>()
            .db_path
            .lock()
            .map_err(|e| e.to_string())?
            .clone(),
    );
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .map_err(|e| e.to_string())?;
    let bind = format!("127.0.0.1:{port}");
    let args = [
        "server".to_string(),
        "--http".to_string(),
        "--path".to_string(),
        db_path.to_string_lossy().to_string(),
        "--http-bind".to_string(),
        bind.clone(),
    ];
    let shell = app.shell();
    let sidecar = shell
        .sidecar("red")
        .ok()
        .map(|c| c.args(args.clone()).env("RED_HTTP_TLS_DEV", "1").spawn());
    let (mut rx, child) = match sidecar {
        Some(Ok(pair)) => pair,
        _ => {
            let bin = find_red_binary().ok_or_else(|| "red binary not found".to_string())?;
            shell
                .command(bin)
                .args(args)
                .env("RED_HTTP_TLS_DEV", "1")
                .spawn()
                .map_err(|e| format!("failed to start reddb: {e}"))?
        }
    };
    // Drain output; if the sidecar dies, clear the URL so the next request respawns it.
    let watch = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            if let CommandEvent::Terminated(_) = ev {
                if let Some(s) = watch.try_state::<EmbeddedDb>() {
                    if let Ok(mut u) = s.url.lock() {
                        *u = None;
                    }
                }
                eprintln!("[reddb] sidecar terminated");
                break;
            }
        }
    });
    reddb_wait_ready(&bind).await?;
    let state = app.state::<EmbeddedDb>();
    *state.url.lock().map_err(|e| e.to_string())? = Some(format!("http://{bind}"));
    *state.child.lock().map_err(|e| e.to_string())? = Some(child);
    Ok(())
}

#[tauri::command]
fn reddb_url(app: tauri::AppHandle) -> Result<String, String> {
    app.state::<EmbeddedDb>()
        .url
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or_else(|| "reddb not ready".to_string())
}

#[derive(Serialize)]
struct HttpReply {
    status: u16,
    body: String,
}

/// Proxy a reddb HTTP request through Rust (reqwest) — controls the framing so reddb
/// 0.1.5 gets a Content-Length body, and sidesteps the webview's mixed-content block.
#[tauri::command]
async fn reddb_request(
    app: tauri::AppHandle,
    method: String,
    path: String,
    body: Option<String>,
) -> Result<HttpReply, String> {
    let current = || -> Result<Option<String>, String> {
        Ok(app
            .state::<EmbeddedDb>()
            .url
            .lock()
            .map_err(|e| e.to_string())?
            .clone())
    };
    let mut base = current()?;
    if base.is_none() {
        // Self-heal: serialize the respawn, re-check after acquiring the lock.
        let db = app.state::<EmbeddedDb>();
        let _guard = db.spawn_lock.lock().await;
        if current()?.is_none() {
            let _ = start_reddb(app.clone()).await;
        }
        base = current()?;
    }
    let base = base.ok_or_else(|| "reddb not ready".to_string())?;
    let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let mut rb = reqwest::Client::new()
        .request(m, format!("{base}{path}"))
        .header("content-type", "application/json");
    if let Some(b) = body {
        rb = rb.body(b);
    }
    let res = rb.send().await.map_err(|e| e.to_string())?;
    Ok(HttpReply {
        status: res.status().as_u16(),
        body: res.text().await.unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::{open_with_key, seal_with_key};

    #[test]
    fn seal_open_roundtrip() {
        let key = [7u8; 32];
        let sealed = seal_with_key(&key, "s3cr3t-value").unwrap();
        assert_ne!(sealed.ct, "s3cr3t-value");
        let opened = open_with_key(&key, &sealed.iv, &sealed.ct).unwrap();
        assert_eq!(opened, "s3cr3t-value");
    }

    #[test]
    fn wrong_key_fails() {
        let sealed = seal_with_key(&[1u8; 32], "x").unwrap();
        assert!(open_with_key(&[2u8; 32], &sealed.iv, &sealed.ct).is_err());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(EngineState::default())
        .manage(EmbeddedDb::default())
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

            // Resolve which .rdb to open (project-local vs global) and record it.
            let (db_path, project_dir) = resolve_db_target();
            if let Ok(mut p) = app.state::<EmbeddedDb>().db_path.lock() {
                *p = db_path.to_string_lossy().to_string();
            }
            if let Ok(mut a) = app.state::<EmbeddedDb>().arg_launched.lock() {
                *a = project_dir.is_some();
            }
            if let Some(d) = &project_dir {
                recent_add_dir(d);
            }
            if let Ok(mut d) = app.state::<EmbeddedDb>().project_dir.lock() {
                *d = project_dir;
            }

            // Start the embedded RedDB sidecar (async; the UI polls reddb_url()
            // until it is ready).
            let db_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = start_reddb(db_handle).await {
                    eprintln!("[reddb] {e}");
                }
            });
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
            reddb_url,
            reddb_request,
            project_info,
            open_project,
            recent_list,
            secret_seal,
            secret_open,
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
                if let Some(db) = app_handle.try_state::<EmbeddedDb>() {
                    if let Ok(mut guard) = db.child.lock() {
                        if let Some(child) = guard.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        });
}
