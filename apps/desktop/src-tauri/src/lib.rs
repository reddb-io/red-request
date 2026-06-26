use base64::engine::general_purpose::STANDARD as B64;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Instant;
use tauri::{Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::oneshot;

const PERF_LOG_MIN_MS: u128 = 5;
const CLOSE_WATCHDOG_MS: u64 = 2_500;

fn perf_ms(start: Instant) -> u128 {
    start.elapsed().as_millis()
}

fn log_perf_slow(op: &str, detail: &str, start: Instant) {
    let ms = perf_ms(start);
    if ms >= PERF_LOG_MIN_MS {
        log::debug!(target: "perf", "{op} {detail} in {ms}ms");
    }
}

fn arm_close_watchdog(window: tauri::Window) {
    let label = window.label().to_string();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(CLOSE_WATCHDOG_MS)).await;
        match window.destroy() {
            Ok(()) => log::warn!(
                target: "app",
                "window close watchdog forced destroy for {label}"
            ),
            Err(e) => log::debug!(
                target: "app",
                "window close watchdog found {label} already closed: {e}"
            ),
        }
    });
}

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
    if candidate
        .components()
        .any(|c| c == std::path::Component::ParentDir)
    {
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
    let started = Instant::now();
    let dir = ensure_under_root(&app, &path)?;
    if !dir.exists() {
        log_perf_slow("fs.list_dir", &format!("empty path={path}"), started);
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
    log_perf_slow(
        "fs.list_dir",
        &format!("{} entries path={path}", out.len()),
        started,
    );
    Ok(out)
}

#[tauri::command]
fn fs_read_text(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let started = Instant::now();
    let file = ensure_under_root(&app, &path)?;
    let result = std::fs::read_to_string(&file).map_err(|e| e.to_string());
    if let Ok(contents) = &result {
        log_perf_slow(
            "fs.read_text",
            &format!("{} bytes path={path}", contents.len()),
            started,
        );
    }
    result
}

#[tauri::command]
fn fs_write_text(app: tauri::AppHandle, path: String, contents: String) -> Result<(), String> {
    let started = Instant::now();
    let bytes = contents.len();
    let file = ensure_under_root(&app, &path)?;
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let result = std::fs::write(&file, contents).map_err(|e| e.to_string());
    if result.is_ok() {
        log_perf_slow(
            "fs.write_text",
            &format!("{bytes} bytes path={path}"),
            started,
        );
    }
    result
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

// External read/write for paths the user explicitly chose via the OS open/save
// dialog (Postman/Insomnia export, file import). Deliberately NOT sandboxed to the
// collections root — the native dialog IS the user's consent boundary, and the whole
// point is to write/read outside the store (Downloads, Documents, …). The guarded
// `fs_*` commands above stay for the internal `_exports`/backups tree.
#[tauri::command]
fn fs_read_external(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn fs_write_external(path: String, contents: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileMeta {
    exists: bool,
    size: u64,
    modified_ms: u64,
}

/// Size + last-modified for an arbitrary path (e.g. the project's app.rdb). Read-only
/// metadata, so it isn't sandboxed to the collections root.
#[tauri::command]
fn file_meta(path: String) -> FileMeta {
    match std::fs::metadata(&path) {
        Ok(m) => {
            let modified_ms = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            FileMeta {
                exists: true,
                size: m.len(),
                modified_ms,
            }
        }
        Err(_) => FileMeta {
            exists: false,
            size: 0,
            modified_ms: 0,
        },
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

/// Environment for our bundled sidecars: the host env minus the dynamic-loader vars an
/// AppImage's AppRun injects (LD_LIBRARY_PATH, GTK/GIO module paths, …). The static `red`
/// and the Bun-compiled engine don't need the AppImage's bundled GTK libs; inheriting them
/// makes ld.so segfault in its symbol-version check when the host glibc is newer than the
/// one the AppImage was built on (#47 — black screen). Applied as env_clear()+envs() so the
/// sidecars start under the system loader. A no-op outside an AppImage (those vars are unset).
fn sidecar_env() -> std::collections::HashMap<String, String> {
    const STRIP: &[&str] = &[
        "LD_LIBRARY_PATH",
        "LD_PRELOAD",
        "GTK_PATH",
        "GIO_MODULE_DIR",
        "GDK_PIXBUF_MODULE_FILE",
        "GDK_PIXBUF_MODULEDIR",
        "GST_PLUGIN_PATH",
        "GST_PLUGIN_SYSTEM_PATH",
    ];
    std::env::vars()
        .filter(|(k, _)| !STRIP.contains(&k.as_str()))
        .collect()
}

fn spawn_engine(
    app: &tauri::AppHandle,
) -> Result<(tauri::async_runtime::Receiver<CommandEvent>, CommandChild), String> {
    let shell = app.shell();
    // Prefer Node when the built engine JS is present (dev, or any host with node):
    // recker's per-phase connection timings (dns/tcp/tls) only populate on Node — the
    // Bun-compiled binary returns them as 0. Fall back to the bundled sidecar otherwise.
    let engine_js = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/engine/dist/main.js");
    if engine_js.exists() {
        if let Ok(pair) = shell
            .command("node")
            .args([engine_js.to_string_lossy().to_string()])
            .spawn()
        {
            return Ok(pair);
        }
    }
    // Packaged: the bundled, bun-compiled sidecar binary.
    shell
        .sidecar("red-request-engine")
        .map_err(|e| e.to_string())?
        .env_clear()
        .envs(sidecar_env())
        .spawn()
        .map(|(rx, child)| (rx, child))
        .map_err(|e| format!("failed to start engine sidecar: {e}"))
}

fn handle_engine_line(app: &tauri::AppHandle, line: &str) {
    if line.is_empty() {
        return;
    }
    let value: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => {
            log::warn!(target: "engine", "unparseable line: {e}");
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
                Ok(value
                    .get("result")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null))
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
    let started = Instant::now();
    let method_name = method.clone();
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

    let result = match tokio::time::timeout(std::time::Duration::from_secs(120), rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => {
            app.state::<EngineState>()
                .pending
                .lock()
                .ok()
                .map(|mut m| m.remove(&id));
            Err("engine channel closed".to_string())
        }
        Err(_) => {
            app.state::<EngineState>()
                .pending
                .lock()
                .ok()
                .map(|mut m| m.remove(&id));
            Err("engine call timed out".to_string())
        }
    };
    log_perf_slow(
        "engine.call",
        &format!(
            "{method_name} {}",
            if result.is_ok() { "ok" } else { "err" }
        ),
        started,
    );
    result
}

// ---------------------------------------------------------------------------
// Secret sealing — AES-256-GCM with a master key kept in the OS keychain. The
// `.rdb` is plaintext at rest, so secret VALUES are sealed before being stored.
// The master key never enters the webview.
// ---------------------------------------------------------------------------

const MASTER_KEY_SERVICE: &str = "io.reddb.request";
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
            use rand::TryRngCore;
            let mut key = [0u8; 32];
            rand::rngs::OsRng
                .try_fill_bytes(&mut key)
                .map_err(|e| e.to_string())?;
            entry
                .set_password(&B64.encode(key))
                .map_err(|e| e.to_string())?;
            Ok(key)
        }
        Err(e) => Err(e.to_string()),
    }
}

fn seal_with_key(key: &[u8; 32], plaintext: &str) -> Result<Sealed, String> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Key, Nonce};
    use rand::TryRngCore;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let mut nb = [0u8; 12];
    rand::rngs::OsRng
        .try_fill_bytes(&mut nb)
        .map_err(|e| e.to_string())?;
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
    let started = Instant::now();
    let result = seal_with_key(&master_key()?, &plaintext);
    log_perf_slow(
        "secret.seal",
        if result.is_ok() { "ok" } else { "err" },
        started,
    );
    result
}

#[tauri::command]
fn secret_open(iv: String, ct: String) -> Result<String, String> {
    let started = Instant::now();
    let result = open_with_key(&master_key()?, &iv, &ct);
    log_perf_slow(
        "secret.open",
        if result.is_ok() { "ok" } else { "err" },
        started,
    );
    result
}

// ---------------------------------------------------------------------------
// Embedded RedDB sidecar — `red server` on a local .rdb, the app's persistence.
// ---------------------------------------------------------------------------

#[derive(Default)]
struct EmbeddedDb {
    url: Mutex<Option<String>>,
    /// gRPC address (host:port) of the embedded server — the conduit for `red connect`
    /// (RQL over the native protocol). Bare host:port, no scheme.
    grpc: Mutex<Option<String>>,
    child: Mutex<Option<CommandChild>>,
    db_path: Mutex<String>,
    project_dir: Mutex<Option<String>>,
    /// Whether the app was launched with a directory arg (`rr <dir>`), in which case
    /// the UI skips the project selector and opens straight in.
    arg_launched: Mutex<bool>,
    /// Serializes (re)spawn so a dead sidecar isn't replaced by several at once
    /// (multiple `red server` on one .rdb corrupts the B-tree).
    spawn_lock: tokio::sync::Mutex<()>,
    /// A long-lived `red connect` REPL (the RQL conduit). One persistent connection
    /// reused for every query — the async mutex also serializes calls (one in-flight).
    rql: tokio::sync::Mutex<Option<RqlSession>>,
    /// Monotonic sidecar generation, bumped on every (re)spawn. A terminated child's
    /// watcher only clears shared state when its generation is still current — so a
    /// project switch (kill old child → spawn new) can't have the old child's async
    /// Terminated event null the URL the new sidecar just published (black screen).
    gen: std::sync::atomic::AtomicU64,
}

/// A persistent `red connect <grpc> --json` REPL: write an RQL line to stdin, read one
/// response line. `buf` carries partial stdout between reads; `errbuf` carries partial
/// stderr — reddb writes query errors there, not to stdout (#rql-error-hang).
struct RqlSession {
    child: CommandChild,
    rx: tauri::async_runtime::Receiver<CommandEvent>,
    buf: String,
    errbuf: String,
}

/// Resolve which `.rdb` to open. A path arg (`rr .` / `rr <dir>`) → project mode at
/// `<dir>/.red/request/app.rdb`; otherwise the global `~/.red/request/app.rdb`.
/// (The `.red` dir name is the family convention; brandify later.)
fn resolve_db_target() -> (std::path::PathBuf, Option<String>) {
    let argv: Vec<String> = std::env::args().collect();
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let arg = std::env::args().skip(1).find(|a| !a.starts_with('-'));
    if let Some(a) = arg {
        let abs = std::fs::canonicalize(&a).unwrap_or_else(|_| cwd.join(&a));
        let dir = if abs.is_file() {
            abs.parent().map(|p| p.to_path_buf()).unwrap_or(abs.clone())
        } else {
            abs
        };
        let db = dir.join(".red").join("request").join("app.rdb");
        log::info!(
            target: "startup",
            "db target: PROJECT (arg {a:?}, cwd {}) -> dir {} db {} | argv {argv:?}",
            cwd.display(), dir.display(), db.display()
        );
        return (db, Some(dir.to_string_lossy().to_string()));
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let db = std::path::Path::new(&home)
        .join(".red")
        .join("request")
        .join("app.rdb");
    log::info!(
        target: "startup",
        "db target: GLOBAL (no dir arg, cwd {}) -> db {} | argv {argv:?}",
        cwd.display(), db.display()
    );
    (db, None)
}

/// Shared log directory for the app and reddb sidecar: `~/.red/request/logs`.
/// Created on demand so the log-plugin's file target always has a home.
fn app_log_dir() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let dir = std::path::Path::new(&home)
        .join(".red")
        .join("request")
        .join("logs");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

#[derive(Serialize)]
struct ProjectInfo {
    db_path: String,
    project_dir: Option<String>,
    is_project: bool,
    arg_launched: bool,
    /// Custom display name from recents (falls back to the folder name on the UI side).
    name: Option<String>,
}

fn project_info_for(app: &tauri::AppHandle) -> Result<ProjectInfo, String> {
    let s = app.state::<EmbeddedDb>();
    let db_path = s.db_path.lock().map_err(|e| e.to_string())?.clone();
    let project_dir = s.project_dir.lock().map_err(|e| e.to_string())?.clone();
    let arg_launched = *s.arg_launched.lock().map_err(|e| e.to_string())?;
    let name = project_dir.as_ref().and_then(|d| {
        recent_list()
            .into_iter()
            .find(|r| &r.dir == d)
            .map(|r| r.name)
    });
    Ok(ProjectInfo {
        is_project: project_dir.is_some(),
        db_path,
        project_dir,
        arg_launched,
        name,
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
    #[serde(default)]
    pinned: bool,
    #[serde(default)]
    request_count: u64,
}

fn save_recents(list: &[RecentProject]) -> Result<(), String> {
    let p = recents_path();
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let s = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    std::fs::write(&p, s).map_err(|e| e.to_string())
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
    let prev = list.iter().find(|r| r.dir == abs).cloned();
    list.retain(|r| r.dir != abs);
    list.insert(
        0,
        RecentProject {
            dir: abs,
            name,
            last_opened: now,
            pinned: prev.as_ref().map(|p| p.pinned).unwrap_or(false),
            request_count: prev.as_ref().map(|p| p.request_count).unwrap_or(0),
        },
    );
    list.truncate(20);
    let _ = save_recents(&list);
}

#[tauri::command]
fn recent_pin(dir: String, pinned: bool) -> Result<(), String> {
    let mut list = recent_list();
    for r in list.iter_mut() {
        if r.dir == dir {
            r.pinned = pinned;
        }
    }
    save_recents(&list)
}

#[tauri::command]
fn recent_set_count(dir: String, count: u64) -> Result<(), String> {
    let mut list = recent_list();
    let mut changed = false;
    for r in list.iter_mut() {
        if r.dir == dir && r.request_count != count {
            r.request_count = count;
            changed = true;
        }
    }
    if changed {
        save_recents(&list)?;
    }
    Ok(())
}

/// Set a custom display name for a recent project (does not touch the folder).
#[tauri::command]
fn recent_rename(dir: String, name: String) -> Result<(), String> {
    let mut list = recent_list();
    for r in list.iter_mut() {
        if r.dir == dir {
            r.name = name.clone();
        }
    }
    save_recents(&list)
}

/// Forget a project: remove it from the recents list. Touches no files on disk.
#[tauri::command]
fn recent_remove(dir: String) -> Result<(), String> {
    let mut list = recent_list();
    list.retain(|r| r.dir != dir);
    save_recents(&list)
}

/// Permanently delete a project's red-request data (`<dir>/.red/request`, i.e. the app.rdb
/// and any backups) and forget it. Leaves the rest of the folder untouched. The caller must
/// switch the embedded reddb away from this dir first (e.g. `open_project(None)`), else the
/// running sidecar keeps the unlinked file open.
#[tauri::command]
fn delete_project_data(dir: String) -> Result<(), String> {
    let abs = std::fs::canonicalize(&dir).unwrap_or_else(|_| std::path::PathBuf::from(&dir));
    let red_dir = abs.join(".red").join("request");
    if red_dir.exists() {
        std::fs::remove_dir_all(&red_dir).map_err(|e| e.to_string())?;
    }
    let mut list = recent_list();
    list.retain(|r| r.dir != dir);
    let _ = save_recents(&list);
    Ok(())
}

/// Switch the embedded reddb to another project (or the global store with `dir = None`)
/// at runtime: stop the current sidecar, repoint the path, respawn, return the new info.
#[tauri::command]
async fn open_project(app: tauri::AppHandle, dir: Option<String>) -> Result<ProjectInfo, String> {
    let started = Instant::now();
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
    let from = st
        .project_dir
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_else(|| "global".to_string());
    log::info!(
        target: "project",
        "open_project: {from} -> {} (db {db_path})",
        project_dir.as_deref().unwrap_or("global")
    );
    let _guard = st.spawn_lock.lock().await;
    // Take the child OUT of the lock first, then stop it gracefully outside the lock
    // (SIGTERM → checkpoint the collection contracts; SIGKILL would lose the KV model).
    let old_child = st.child.lock().ok().and_then(|mut c| c.take());
    if let Some(child) = old_child {
        graceful_kill_reddb(child);
    }
    // Drop the RQL connection — it points at the server we're replacing; the next
    // query respawns it against the new project's gRPC port.
    if let Some(sess) = st.rql.lock().await.take() {
        let _ = sess.child.kill();
    }
    if let Ok(mut u) = st.url.lock() {
        *u = None;
    }
    if let Ok(mut g) = st.grpc.lock() {
        *g = None;
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
    let result = project_info_for(&app);
    log::debug!(
        target: "perf",
        "project.open {} in {}ms",
        if result.is_ok() { "ok" } else { "err" },
        perf_ms(started)
    );
    result
}

/// Back up the current project's reddb files and restart on a fresh store. Used to
/// heal a collection in an incompatible on-disk model — e.g. a legacy `table` where
/// the app expects `kv` (`model mismatch: expected kv, got table`). That mismatch
/// only surfaces once queries run, so start_reddb's whole-db open-failure backup
/// never catches it. Every `app.rdb*` file is moved to `…incompatible-<ts>.bak`
/// (preserved for recovery, not deleted), then reddb is recreated fresh.
#[tauri::command]
async fn reset_incompatible_db(app: tauri::AppHandle) -> Result<(), String> {
    let db = app.state::<EmbeddedDb>();
    let db_path = std::path::PathBuf::from(db.db_path.lock().map_err(|e| e.to_string())?.clone());
    let _guard = db.spawn_lock.lock().await;
    // Tear down the live sidecar + RQL session so the files are released. Graceful
    // SIGTERM so reddb checkpoints the contracts before we move its files.
    let old_child = db.child.lock().ok().and_then(|mut c| c.take());
    if let Some(child) = old_child {
        graceful_kill_reddb(child);
    }
    if let Some(sess) = db.rql.lock().await.take() {
        let _ = sess.child.kill();
    }
    if let Ok(mut u) = db.url.lock() {
        *u = None;
    }
    if let Ok(mut g) = db.grpc.lock() {
        *g = None;
    }
    kill_stale_reddb(&db_path);
    // Move every `app.rdb*` sibling aside (data preserved, not lost).
    let parent = db_path
        .parent()
        .ok_or_else(|| "db path has no parent".to_string())?
        .to_path_buf();
    let stem = db_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "app.rdb".to_string());
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut moved = 0u32;
    if let Ok(entries) = std::fs::read_dir(&parent) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(&stem) && !name.contains(".incompatible-") {
                let dst = parent.join(format!("{name}.incompatible-{stamp}.bak"));
                if std::fs::rename(entry.path(), &dst).is_ok() {
                    moved += 1;
                }
            }
        }
    }
    log::warn!(
        target: "reddb",
        "incompatible project data: backed up {moved} file(s) in {} (stamp {stamp}); recreating fresh",
        parent.display()
    );
    // Recreate a fresh store on the same path.
    start_reddb(app.clone()).await
}

/// Locate the bundled `red` binary in `binaries/` (dev fallback when the Tauri
/// sidecar copy isn't present). Excludes the `red-request-engine` binary.
fn find_red_binary() -> Option<String> {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
    for e in std::fs::read_dir(&dir).ok()?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with("red-") && !name.starts_with("red-request") {
            return Some(e.path().to_string_lossy().to_string());
        }
    }
    None
}

/// The app's own version (from Cargo/tauri.conf), e.g. "0.1.1".
#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// The embedded RedDB version, by running the bundled `red --version` one-shot.
/// Works on the project selector (no live sidecar needed). Returns just the number,
/// e.g. "1.11.0" from "reddb 1.11.0".
#[tauri::command]
async fn reddb_version(app: tauri::AppHandle) -> Result<String, String> {
    let shell = app.shell();
    let output = match shell.sidecar("red") {
        Ok(cmd) => cmd.args(["--version"]).output().await,
        Err(_) => {
            let bin = find_red_binary().ok_or_else(|| "red binary not found".to_string())?;
            shell.command(bin).args(["--version"]).output().await
        }
    }
    .map_err(|e| format!("failed to run red --version: {e}"))?;
    let text = String::from_utf8_lossy(&output.stdout);
    let ver = text
        .trim()
        .split_whitespace()
        .last()
        .unwrap_or("")
        .to_string();
    if ver.is_empty() {
        Err("could not parse reddb version".to_string())
    } else {
        Ok(ver)
    }
}

async fn reddb_wait_ready(bind: &str) -> Result<(), String> {
    let started = Instant::now();
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
                        log::debug!(
                            target: "perf",
                            "reddb.wait_ready ok bind={bind} in {}ms",
                            perf_ms(started)
                        );
                        return Ok(());
                    }
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
}

fn comparable_db_path(path: &std::path::Path) -> String {
    let normalized = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let value = normalized.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        value.to_ascii_lowercase()
    } else {
        value
    }
}

fn red_server_db_path_arg(args: &[String]) -> Option<&str> {
    for (idx, arg) in args.iter().enumerate() {
        if arg == "--path" {
            return args.get(idx + 1).map(String::as_str);
        }
        if let Some(path) = arg.strip_prefix("--path=") {
            return Some(path);
        }
    }
    None
}

fn is_red_executable(arg: &str) -> bool {
    let name = std::path::Path::new(arg)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(arg);
    name == "red" || name.eq_ignore_ascii_case("red.exe")
}

fn reddb_server_argv_matches_db(args: &[String], db_path: &std::path::Path) -> bool {
    if !args.first().is_some_and(|arg| is_red_executable(arg)) {
        return false;
    }
    if !args.iter().skip(1).any(|arg| arg == "server") {
        return false;
    }
    let Some(path) = red_server_db_path_arg(args) else {
        return false;
    };
    comparable_db_path(std::path::Path::new(path)) == comparable_db_path(db_path)
}

fn process_args(process: &sysinfo::Process) -> Vec<String> {
    process
        .cmd()
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect()
}

fn process_snapshot() -> sysinfo::System {
    let mut system = sysinfo::System::new();
    system.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::All,
        sysinfo::ProcessRefreshKind::new()
            .with_cmd(sysinfo::UpdateKind::Always)
            .with_exe(sysinfo::UpdateKind::OnlyIfNotSet),
    );
    system
}

/// Enforce single-writer on a `.rdb`: find any `red server` already bound to
/// this exact db file before we spawn ours. Such a process is either a crash
/// orphan (we can't reap on SIGKILL) or a second app instance on the same store.
/// Two writers on one .rdb corrupt the B-tree, so the newest launch wins.
fn stale_reddb_pids(db_path: &std::path::Path) -> Vec<u32> {
    let me = sysinfo::get_current_pid()
        .map(|pid| pid.as_u32())
        .unwrap_or_else(|_| std::process::id());
    process_snapshot()
        .processes()
        .values()
        .filter_map(|process| {
            let pid = process.pid().as_u32();
            if pid == me {
                return None;
            }
            if reddb_server_argv_matches_db(&process_args(process), db_path) {
                Some(pid)
            } else {
                None
            }
        })
        .collect()
}

fn kill_stale_reddb(db_path: &std::path::Path) {
    let me = sysinfo::get_current_pid()
        .map(|pid| pid.as_u32())
        .unwrap_or_else(|_| std::process::id());
    for process in process_snapshot().processes().values() {
        let pid = process.pid().as_u32();
        if pid == me {
            continue;
        }
        if !reddb_server_argv_matches_db(&process_args(process), db_path) {
            continue;
        }
        log::warn!(
            target: "reddb",
            "single-writer guard: terminating stale red server pid {pid} on {}",
            db_path.to_string_lossy()
        );
        let terminated = process
            .kill_with(sysinfo::Signal::Term)
            .unwrap_or_else(|| process.kill());
        if !terminated {
            log::warn!(target: "reddb", "single-writer guard: failed to signal pid {pid}");
        }
    }
}

/// Wait until no `red server` holds `db_path` — the kill above is async to the OS, and the
/// dying process keeps the file lock until it's fully reaped. Spawning before then makes reddb
/// report the db as unopenable, which used to trigger a DESTRUCTIVE "incompatible" backup of a
/// perfectly good store (the data-loss-on-upgrade bug). Bounded so a wedged process can't hang
/// startup.
async fn wait_for_no_stale(db_path: &std::path::Path) {
    for _ in 0..40 {
        if stale_reddb_pids(db_path).is_empty() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(75)).await;
    }
    kill_stale_reddb_force(db_path);
    for _ in 0..20 {
        if stale_reddb_pids(db_path).is_empty() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(75)).await;
    }
    log::warn!(
        target: "reddb",
        "stale red server still holding {} after wait — proceeding anyway",
        db_path.to_string_lossy()
    );
}

fn kill_stale_reddb_force(db_path: &std::path::Path) {
    let me = sysinfo::get_current_pid()
        .map(|pid| pid.as_u32())
        .unwrap_or_else(|_| std::process::id());
    for process in process_snapshot().processes().values() {
        let pid = process.pid().as_u32();
        if pid == me {
            continue;
        }
        if !reddb_server_argv_matches_db(&process_args(process), db_path) {
            continue;
        }
        log::warn!(
            target: "reddb",
            "single-writer guard: force-killing stale red server pid {pid} on {}",
            db_path.to_string_lossy()
        );
        if !process.kill() {
            log::warn!(target: "reddb", "single-writer guard: failed to force-kill pid {pid}");
        }
    }
}

/// Spawn one reddb sidecar for `db_path` and wait until it answers /stats.
/// On readiness failure the child is killed (so a failed start can't orphan a process).
async fn spawn_reddb_once(
    app: &tauri::AppHandle,
    db_path: &std::path::Path,
) -> Result<(String, String, CommandChild), String> {
    let started = Instant::now();
    // Single-writer guard: clear any stale/concurrent server on this exact db first, then wait
    // for it to actually exit so the file lock is released before we open (avoids a false
    // "unopenable" that used to nuke the store on upgrade).
    kill_stale_reddb(db_path);
    wait_for_no_stale(db_path).await;
    let free_port = || {
        std::net::TcpListener::bind("127.0.0.1:0")
            .and_then(|l| l.local_addr())
            .map(|a| a.port())
            .map_err(|e| e.to_string())
    };
    let bind = format!("127.0.0.1:{}", free_port()?);
    // gRPC front-door for `red connect` (RQL conduit), alongside the HTTP API.
    let grpc = format!("127.0.0.1:{}", free_port()?);
    let args = [
        "server".to_string(),
        "--http".to_string(),
        "--path".to_string(),
        db_path.to_string_lossy().to_string(),
        "--http-bind".to_string(),
        bind.clone(),
        "--grpc".to_string(),
        "--grpc-bind".to_string(),
        grpc.clone(),
    ];
    let shell = app.shell();
    let sidecar = shell.sidecar("red").ok().map(|c| {
        c.env_clear()
            .envs(sidecar_env())
            .args(args.clone())
            .env("RED_HTTP_TLS_DEV", "1")
            .spawn()
    });
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
    // Claim this spawn's generation. The watcher below uses it to tell "my child
    // died" from "a child I replaced during a project switch died".
    let my_gen = app
        .state::<EmbeddedDb>()
        .gen
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        + 1;
    log::info!(
        target: "reddb",
        "sidecar spawned (gen {my_gen}) for {} — http {bind} grpc {grpc}",
        db_path.display()
    );
    // Drain output; if the *current* sidecar dies, clear the URL so the next request
    // respawns it. A managed project switch kills the old child and spawns a new one
    // (bumping `gen`); without the generation guard the old child's async Terminated
    // event would null the URL the NEW sidecar just published → app stuck "reddb not
    // ready" (black screen on switch).
    let watch = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            if let CommandEvent::Terminated(_) = ev {
                if let Some(s) = watch.try_state::<EmbeddedDb>() {
                    // Stale child from a superseded generation — its death is expected
                    // (we killed it to switch projects); leave the current state alone.
                    if s.gen.load(std::sync::atomic::Ordering::SeqCst) != my_gen {
                        break;
                    }
                    if let Ok(mut u) = s.url.lock() {
                        *u = None;
                    }
                    // Clear the gRPC addr too so the next RQL call respawns the server, and
                    // drop the now-orphaned `red connect` REPL that pointed at it.
                    if let Ok(mut g) = s.grpc.lock() {
                        *g = None;
                    }
                    if let Ok(mut sess) = s.rql.try_lock() {
                        if let Some(old) = sess.take() {
                            let _ = old.child.kill();
                        }
                    }
                    log::warn!(target: "reddb", "sidecar terminated (gen {my_gen}); url cleared, next request will respawn");
                }
                break;
            }
        }
    });
    if let Err(e) = reddb_wait_ready(&bind).await {
        log::error!(target: "reddb", "sidecar not ready (gen {my_gen}) on {bind}: {e}; killing it");
        let _ = child.kill();
        return Err(e);
    }
    log::info!(target: "reddb", "sidecar ready (gen {my_gen}) — http {bind} grpc {grpc}");
    log::debug!(
        target: "perf",
        "reddb.spawn_ready gen={my_gen} in {}ms",
        perf_ms(started)
    );
    Ok((bind, grpc, child))
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Bring back data a prior (buggy) boot wrongly filed away. The old startup path renamed a
/// store it failed to open to `<name>.incompatible-<ts>.bak` and started fresh — but that
/// failure was almost always a stale `red` holding the file lock during an upgrade, not real
/// corruption. On boot, if such a backup exists and holds MORE than the current (fresh/empty)
/// store, restore the largest one. Nothing is deleted: the current file is moved aside first.
/// The backup is consumed (renamed onto db_path) and last-resort backups now use a different
/// suffix (`.corrupt-`), so this can't loop.
fn recover_incompatible_backup(db_path: &std::path::Path) {
    let Some(dir) = db_path.parent() else {
        return;
    };
    let stem = db_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "app.rdb".to_string());
    let prefix = format!("{stem}.incompatible-");
    // Pick the LARGEST matching backup (most data) — repeated wipes can leave several.
    let mut best: Option<(u64, std::path::PathBuf)> = None;
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with(&prefix) && name.ends_with(".bak") {
                let len = e.metadata().map(|m| m.len()).unwrap_or(0);
                if best.as_ref().map(|(b, _)| len > *b).unwrap_or(true) {
                    best = Some((len, e.path()));
                }
            }
        }
    }
    let Some((bak_size, bak_path)) = best else {
        return;
    };
    if bak_size == 0 {
        return;
    }
    let cur_size = std::fs::metadata(db_path).map(|m| m.len()).unwrap_or(0);
    // Only restore when the backup clearly holds more than the current store, i.e. the current
    // file is the wiped/fresh one. Never clobber a store the user has since filled.
    if cur_size >= bak_size {
        return;
    }
    if cur_size > 0 {
        let aside = db_path.with_file_name(format!("{stem}.superseded-{}", now_secs()));
        if let Err(e) = std::fs::rename(db_path, &aside) {
            log::error!(target: "reddb", "recovery: could not move current store aside: {e}");
            return;
        }
    }
    match std::fs::rename(&bak_path, db_path) {
        Ok(_) => log::warn!(
            target: "reddb",
            "recovery: restored {} ({bak_size} bytes) over the fresh store at {}",
            bak_path.display(), db_path.display()
        ),
        Err(e) => log::error!(
            target: "reddb", "recovery: failed to restore {}: {e}", bak_path.display()
        ),
    }
}

async fn start_reddb(app: tauri::AppHandle) -> Result<(), String> {
    let started = Instant::now();
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
    log::info!(target: "reddb", "start_reddb: opening {}", db_path.display());

    // Embedded recovery: undo a prior boot's destructive "incompatible" backup (data wrongly
    // filed away when a stale `red` held the lock during an upgrade) before we try to open.
    recover_incompatible_backup(&db_path);

    // Retry before doing anything destructive: a failure here is almost always a stale `red`
    // from a just-replaced binary (upgrade) still releasing the file lock. spawn_reddb_once
    // kills + waits for stale servers, so a retry nearly always succeeds — far better than
    // destroying a good store.
    let mut spawned = None;
    let mut last_err = String::new();
    for attempt in 1..=4 {
        match spawn_reddb_once(&app, &db_path).await {
            Ok(triple) => {
                spawned = Some(triple);
                break;
            }
            Err(e) => {
                log::warn!(target: "reddb", "start_reddb: spawn attempt {attempt}/4 failed: {e}");
                last_err = e;
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            }
        }
    }

    let (bind, grpc, child) = match spawned {
        Some(triple) => triple,
        None => {
            // Still unopenable after retries — now it's likely a genuinely incompatible on-disk
            // format (RedDB files aren't backward-compatible across major versions). An
            // empty/missing file means a real error: propagate it. Otherwise back it up — as
            // `.corrupt-` (NOT `.incompatible-`, so recover_incompatible_backup won't restore it
            // into a loop) — and start fresh rather than leaving the app permanently broken.
            let e = last_err;
            let nonempty = std::fs::metadata(&db_path)
                .map(|m| m.len() > 0)
                .unwrap_or(false);
            if !nonempty {
                return Err(e);
            }
            let bak = db_path.with_file_name(format!(
                "{}.corrupt-{}.bak",
                db_path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| "app.rdb".to_string()),
                now_secs()
            ));
            std::fs::rename(&db_path, &bak).map_err(|re| {
                format!("reddb could not open the database ({e}) and backup failed: {re}")
            })?;
            log::warn!(
                target: "reddb",
                "could not open {} after retries ({e}); backed it up to {} and started fresh",
                db_path.display(), bak.display()
            );
            spawn_reddb_once(&app, &db_path).await?
        }
    };

    let state = app.state::<EmbeddedDb>();
    *state.url.lock().map_err(|e| e.to_string())? = Some(format!("http://{bind}"));
    *state.grpc.lock().map_err(|e| e.to_string())? = Some(grpc);
    *state.child.lock().map_err(|e| e.to_string())? = Some(child);
    log::info!(target: "reddb", "start_reddb: url published http://{bind}");
    log::debug!(
        target: "perf",
        "reddb.start ok path={} in {}ms",
        db_path.display(),
        perf_ms(started)
    );
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
    let started = Instant::now();
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
    log::debug!(target: "http", "{method} {path} -> {base}");
    // Bounded: reddb accepting the socket but never answering must NOT hang the app
    // forever (black screen). A timeout turns it into a clean, logged error instead.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let mut rb = client
        .request(m, format!("{base}{path}"))
        .header("content-type", "application/json");
    if let Some(b) = body {
        rb = rb.body(b);
    }
    let res = rb.send().await.map_err(|e| {
        log::warn!(target: "http", "{method} {path} failed: {e}");
        e.to_string()
    })?;
    let status = res.status().as_u16();
    let body = res.text().await.unwrap_or_default();
    log::debug!(target: "http", "{method} {path} <- {status} ({} bytes)", body.len());
    log_perf_slow(
        "reddb.http",
        &format!("{method} {path} -> {status} {} bytes", body.len()),
        started,
    );
    Ok(HttpReply { status, body })
}

/// Current gRPC front-door address, bringing the embedded server up if needed.
async fn ensure_grpc(app: &tauri::AppHandle) -> Result<String, String> {
    let read = |a: &tauri::AppHandle| -> Result<Option<String>, String> {
        Ok(a.state::<EmbeddedDb>()
            .grpc
            .lock()
            .map_err(|e| e.to_string())?
            .clone())
    };
    if read(app)?.is_none() {
        let db = app.state::<EmbeddedDb>();
        let _guard = db.spawn_lock.lock().await;
        if read(app)?.is_none() {
            let _ = start_reddb(app.clone()).await;
        }
    }
    read(app)?.ok_or_else(|| "reddb gRPC not ready".to_string())
}

/// Spawn a `red connect <grpc> --json` REPL we drive over stdio.
fn spawn_rql_session(app: &tauri::AppHandle, grpc: &str) -> Result<RqlSession, String> {
    let args = [grpc.to_string(), "--json".to_string()];
    let shell = app.shell();
    let (rx, child) = match shell.sidecar("red") {
        Ok(cmd) => cmd
            .env_clear()
            .envs(sidecar_env())
            .args(std::iter::once("connect".to_string()).chain(args.clone()))
            .spawn(),
        Err(_) => {
            let bin = find_red_binary().ok_or_else(|| "red binary not found".to_string())?;
            shell
                .command(bin)
                .args(std::iter::once("connect".to_string()).chain(args))
                .spawn()
        }
    }
    .map_err(|e| format!("failed to start `red connect`: {e}"))?;
    Ok(RqlSession {
        child,
        rx,
        buf: String::new(),
        errbuf: String::new(),
    })
}

/// Strip leading `red> ` prompt tokens from a REPL output line.
fn strip_prompt(line: &str) -> &str {
    let mut s = line.trim_start();
    while let Some(rest) = s.strip_prefix("red> ") {
        s = rest.trim_start();
    }
    s
}

/// Read one RQL response line from the session (skipping banner / prompt lines). Returns the
/// normalized `{ok,data}`/`{ok:false,error}` envelope the webview expects.
async fn read_rql_response(sess: &mut RqlSession) -> Result<String, String> {
    let deadline = std::time::Duration::from_secs(30);
    loop {
        // A complete stdout line is the normal success / `error:`-on-stdout path.
        if let Some(nl) = sess.buf.find('\n') {
            let raw: String = sess.buf.drain(..=nl).collect();
            let line = strip_prompt(raw.trim_end());
            if line.starts_with('{') {
                return Ok(format!("{{\"ok\":true,\"data\":{line}}}"));
            }
            if let Some(msg) = line.strip_prefix("error:") {
                return Ok(serde_json::json!({ "ok": false, "error": msg.trim() }).to_string());
            }
            continue; // banner / blank / prompt-only — skip
        }
        // reddb's `red connect` writes QUERY ERRORS to stderr, not stdout. Without
        // reading stderr a failed query yields no stdout line, so the read stalled to
        // the 30s timeout (then retried) — any RQL error froze the whole app. Surface
        // the error immediately instead.
        if let Some(nl) = sess.errbuf.find('\n') {
            let raw: String = sess.errbuf.drain(..=nl).collect();
            let line = strip_prompt(raw.trim_end());
            if let Some(msg) = line.strip_prefix("error:") {
                return Ok(serde_json::json!({ "ok": false, "error": msg.trim() }).to_string());
            }
            continue; // non-error stderr (logs/banner) — skip, keep awaiting stdout
        }
        match tokio::time::timeout(deadline, sess.rx.recv()).await {
            Ok(Some(CommandEvent::Stdout(b))) => {
                sess.buf.push_str(&String::from_utf8_lossy(&b));
            }
            Ok(Some(CommandEvent::Stderr(b))) => {
                sess.errbuf.push_str(&String::from_utf8_lossy(&b));
            }
            Ok(Some(CommandEvent::Terminated(_))) | Ok(None) => {
                return Err("`red connect` session ended".to_string());
            }
            Ok(Some(_)) => {}
            Err(_) => return Err("RQL response timed out".to_string()),
        }
    }
}

/// Run one RQL statement over the persistent `red connect` REPL — the native conduit shared
/// by local and (later) remote `reds://` connections. The async mutex serializes calls so
/// only one query is ever in flight on the single long-lived connection.
#[tauri::command]
async fn reddb_rql(app: tauri::AppHandle, query: String) -> Result<HttpReply, String> {
    let started = Instant::now();
    let db = app.state::<EmbeddedDb>();
    let preview: String = query.replace('\n', " ").chars().take(120).collect();
    log::debug!(target: "rql", "query: {preview}");
    let mut guard = db.rql.lock().await;

    // Drive the query once on the live session; respawn + retry on a dead/missing session.
    for attempt in 0..2 {
        if guard.is_none() {
            log::debug!(target: "rql", "no live session — spawning red connect (attempt {attempt})");
            let grpc = ensure_grpc(&app).await?;
            *guard = Some(spawn_rql_session(&app, &grpc)?);
        }
        let sess = guard.as_mut().unwrap();
        let one_line = query.replace('\n', " ");
        if sess
            .child
            .write(format!("{one_line}\n").as_bytes())
            .is_err()
        {
            log::warn!(target: "rql", "stdin write failed — respawning session");
            *guard = None; // stdin closed → respawn
            continue;
        }
        match read_rql_response(sess).await {
            Ok(body) => {
                log::debug!(target: "rql", "ok ({} bytes): {preview}", body.len());
                log_perf_slow(
                    "reddb.rql",
                    &format!("ok {} bytes query={preview}", body.len()),
                    started,
                );
                return Ok(HttpReply { status: 200, body });
            }
            Err(e) if attempt == 0 => {
                log::warn!(target: "rql", "read failed ({e}) — respawning once: {preview}");
                *guard = None; // session died mid-read → respawn once
            }
            Err(e) => {
                log::error!(target: "rql", "failed after retry ({e}): {preview}");
                log::debug!(
                    target: "perf",
                    "reddb.rql err query={preview} in {}ms",
                    perf_ms(started)
                );
                return Err(e);
            }
        }
    }
    Err("RQL session could not be established".to_string())
}

#[cfg(test)]
mod tests {
    use super::{open_with_key, reddb_server_argv_matches_db, seal_with_key};

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

    #[test]
    fn matches_reddb_server_for_exact_db_path() {
        let db = std::path::Path::new("/tmp/red request/app.rdb");
        let args = vec![
            "/opt/red-request/red".to_string(),
            "server".to_string(),
            "--path".to_string(),
            "/tmp/red request/app.rdb".to_string(),
            "--http-bind".to_string(),
            "127.0.0.1:1234".to_string(),
        ];
        assert!(reddb_server_argv_matches_db(&args, db));
    }

    #[test]
    fn matches_reddb_server_path_equals_form() {
        let db = std::path::Path::new("/tmp/red-request/app.rdb");
        let args = vec![
            "red.exe".to_string(),
            "server".to_string(),
            "--path=/tmp/red-request/app.rdb".to_string(),
        ];
        assert!(reddb_server_argv_matches_db(&args, db));
    }

    #[test]
    fn rejects_non_server_red_processes() {
        let db = std::path::Path::new("/tmp/red-request/app.rdb");
        let args = vec![
            "red".to_string(),
            "connect".to_string(),
            "127.0.0.1:1234".to_string(),
            "--path".to_string(),
            "/tmp/red-request/app.rdb".to_string(),
        ];
        assert!(!reddb_server_argv_matches_db(&args, db));
    }

    #[test]
    fn rejects_engine_sidecar_and_different_db_paths() {
        let db = std::path::Path::new("/tmp/red-request/app.rdb");
        let engine = vec![
            "red-request-engine".to_string(),
            "server".to_string(),
            "--path".to_string(),
            "/tmp/red-request/app.rdb".to_string(),
        ];
        let other_db = vec![
            "red".to_string(),
            "server".to_string(),
            "--path".to_string(),
            "/tmp/red-request-other/app.rdb".to_string(),
        ];
        assert!(!reddb_server_argv_matches_db(&engine, db));
        assert!(!reddb_server_argv_matches_db(&other_db, db));
    }
}

// ---------------------------------------------------------------------------
// OAuth2 / OIDC authorization_code — the native half (PKCE, browser, callback).
// The webview asks for an authorization code; we generate PKCE + state, open the
// system browser, and capture the redirect via a loopback HTTP server (default)
// or the redrequest:// deep link. Token exchange + refresh happen in the engine.
// ---------------------------------------------------------------------------

#[derive(Default)]
struct OauthState {
    /// A login awaiting its deep-link redirect (when redirect == "deeplink").
    pending: Mutex<Option<oneshot::Sender<String>>>,
}

#[derive(Deserialize)]
struct KvParam {
    name: String,
    value: String,
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OauthAuthorizeArgs {
    authorize_url: String,
    client_id: String,
    scope: Option<String>,
    audience: Option<String>,
    redirect: String, // "loopback" | "deeplink"
    use_pkce: bool,
    extra_params: Vec<KvParam>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OauthAuthorizeResult {
    code: String,
    code_verifier: Option<String>,
    redirect_uri: String,
    state: String,
}

fn rand_b64url(n: usize) -> String {
    use rand::TryRngCore;
    let mut bytes = vec![0u8; n];
    rand::rngs::OsRng
        .try_fill_bytes(&mut bytes)
        .expect("OS RNG unavailable");
    URL_SAFE_NO_PAD.encode(bytes)
}

fn build_authorize_url(
    args: &OauthAuthorizeArgs,
    redirect_uri: &str,
    state: &str,
    challenge: Option<&str>,
) -> Result<String, String> {
    let mut pairs: Vec<(String, String)> = vec![
        ("response_type".into(), "code".into()),
        ("client_id".into(), args.client_id.clone()),
        ("redirect_uri".into(), redirect_uri.to_string()),
        ("state".into(), state.to_string()),
    ];
    if let Some(s) = args.scope.as_ref().filter(|s| !s.is_empty()) {
        pairs.push(("scope".into(), s.clone()));
    }
    if let Some(a) = args.audience.as_ref().filter(|a| !a.is_empty()) {
        pairs.push(("audience".into(), a.clone()));
    }
    if let Some(c) = challenge {
        pairs.push(("code_challenge".into(), c.to_string()));
        pairs.push(("code_challenge_method".into(), "S256".into()));
    }
    for kv in &args.extra_params {
        if kv.enabled && !kv.name.is_empty() {
            pairs.push((kv.name.clone(), kv.value.clone()));
        }
    }
    reqwest::Url::parse_with_params(&args.authorize_url, &pairs)
        .map(|u| u.to_string())
        .map_err(|e| format!("bad authorize url: {e}"))
}

/// Pull (code, state) out of a redirect URL, or surface the IdP's error.
fn extract_code(url: &reqwest::Url) -> Result<(String, String), String> {
    let (mut code, mut state, mut err, mut err_desc) = (None, None, None, None);
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            "error" => err = Some(v.into_owned()),
            "error_description" => err_desc = Some(v.into_owned()),
            _ => {}
        }
    }
    if let Some(e) = err {
        return Err(format!("authorization failed: {}", err_desc.unwrap_or(e)));
    }
    match (code, state) {
        (Some(c), Some(s)) => Ok((c, s)),
        _ => Err("redirect missing code/state".to_string()),
    }
}

#[tauri::command]
async fn oauth_authorize(
    app: tauri::AppHandle,
    args: OauthAuthorizeArgs,
) -> Result<OauthAuthorizeResult, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let state = rand_b64url(16);
    let (verifier, challenge) = if args.use_pkce {
        let v = rand_b64url(32);
        let c = URL_SAFE_NO_PAD.encode(Sha256::digest(v.as_bytes()));
        (Some(v), Some(c))
    } else {
        (None, None)
    };
    let timeout = std::time::Duration::from_secs(180);

    // Deep-link redirect: wait for redrequest://oauth/callback via on_open_url.
    if args.redirect == "deeplink" {
        let redirect_uri = "redrequest://oauth/callback".to_string();
        let url = build_authorize_url(&args, &redirect_uri, &state, challenge.as_deref())?;
        let (tx, rx) = oneshot::channel::<String>();
        *app.state::<OauthState>()
            .pending
            .lock()
            .map_err(|e| e.to_string())? = Some(tx);
        app.shell()
            .open(url, None)
            .map_err(|e| format!("failed to open browser: {e}"))?;
        let got = tokio::time::timeout(timeout, rx)
            .await
            .map_err(|_| "login timed out".to_string())?
            .map_err(|_| "login cancelled".to_string())?;
        let parsed = reqwest::Url::parse(&got).map_err(|e| format!("bad redirect: {e}"))?;
        let (code, ret_state) = extract_code(&parsed)?;
        if ret_state != state {
            return Err("state mismatch (possible CSRF)".to_string());
        }
        return Ok(OauthAuthorizeResult {
            code,
            code_verifier: verifier,
            redirect_uri,
            state,
        });
    }

    // Loopback redirect (default): ephemeral 127.0.0.1 server captures the code.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("loopback bind failed: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");
    let url = build_authorize_url(&args, &redirect_uri, &state, challenge.as_deref())?;
    app.shell()
        .open(url, None)
        .map_err(|e| format!("failed to open browser: {e}"))?;

    let (mut stream, _) = tokio::time::timeout(timeout, listener.accept())
        .await
        .map_err(|_| "login timed out".to_string())?
        .map_err(|e| format!("accept failed: {e}"))?;

    let mut buf = [0u8; 8192];
    let n = stream.read(&mut buf).await.map_err(|e| e.to_string())?;
    let req = String::from_utf8_lossy(&buf[..n]);
    let target = req
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .unwrap_or("/");
    let parsed = reqwest::Url::parse(&format!("http://127.0.0.1{target}"))
        .map_err(|e| format!("bad callback: {e}"))?;
    let result = extract_code(&parsed);

    let body = match &result {
        Ok((_, s)) if *s == state => {
            "<h2>Login complete</h2><p>You can close this tab and return to the app.</p>"
        }
        Ok(_) => "<h2>State mismatch</h2><p>Possible CSRF — please retry from the app.</p>",
        Err(_) => "<h2>Login failed</h2><p>Return to the app for details.</p>",
    };
    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(resp.as_bytes()).await;
    let _ = stream.shutdown().await;

    let (code, ret_state) = result?;
    if ret_state != state {
        return Err("state mismatch (possible CSRF)".to_string());
    }
    Ok(OauthAuthorizeResult {
        code,
        code_verifier: verifier,
        redirect_uri,
        state,
    })
}

/// Kill every child process we spawned — the recker engine sidecar, the embedded
/// `red server`, and the long-lived `red connect` REPL. Idempotent (each `take()`
/// leaves `None`, so a second call is a no-op), so it is safe to call from every
/// shutdown path. Without this a closed/killed app leaves orphaned `red server`
/// processes squatting on the single-writer `.rdb` lock, and the next launch's
/// sidecar can't open the DB → respawn loop ("[reddb] sidecar terminated").
fn reap_sidecars(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<EngineState>() {
        if let Ok(mut guard) = state.child.lock() {
            if let Some(child) = guard.take() {
                let _ = child.kill();
            }
        }
    }
    if let Some(db) = app.try_state::<EmbeddedDb>() {
        // Graceful SIGTERM so reddb checkpoints the collection contracts on exit —
        // a plain SIGKILL here loses the KV model and the next launch heals (wipes).
        let reddb_child = db.child.lock().ok().and_then(|mut g| g.take());
        if let Some(child) = reddb_child {
            graceful_kill_reddb(child);
        }
        // Best-effort reap of the long-lived `red connect` REPL.
        if let Ok(mut guard) = db.rql.try_lock() {
            if let Some(sess) = guard.take() {
                let _ = sess.child.kill();
            }
        }
    }
}

/// Stop a reddb sidecar gracefully: SIGTERM so it checkpoints + flushes the
/// collection contracts (declared_model) before exiting, wait briefly for it to
/// exit, then hard-kill as a backstop. A plain CommandChild::kill() is SIGKILL —
/// reddb never checkpoints, the KV model never reaches disk, and the next open
/// fails "model mismatch: expected kv, got table" (which the heal then wipes).
fn graceful_kill_reddb(child: CommandChild) {
    #[cfg(unix)]
    {
        let pid = nix::unistd::Pid::from_raw(child.pid() as i32);
        if nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGTERM).is_ok() {
            // reddb's graceful shutdown is tens of ms; poll up to ~3s for it to exit.
            for _ in 0..60 {
                std::thread::sleep(std::time::Duration::from_millis(50));
                if nix::sys::signal::kill(pid, None).is_err() {
                    return; // exited cleanly — contracts checkpointed
                }
            }
        }
    }
    let _ = child.kill(); // non-unix, or backstop if SIGTERM didn't take
}

/// Bridge for the webview to funnel its logs into the same sink as the backend
/// (`~/.red/request/logs/red-request.log`). `level` is error|warn|info|debug|trace;
/// anything else falls back to info. Lets us trace the FE↔BE flow (e.g. which
/// screen `init()` chose) in one place instead of an invisible devtools console.
#[tauri::command]
fn app_log(level: String, message: String) {
    match level.as_str() {
        "error" => log::error!(target: "ui", "{message}"),
        "warn" => log::warn!(target: "ui", "{message}"),
        "debug" => log::debug!(target: "ui", "{message}"),
        "trace" => log::trace!(target: "ui", "{message}"),
        _ => log::info!(target: "ui", "{message}"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Headless `--version` / `-V`: print and exit BEFORE building the GUI, so installers and
    // users can verify the binary without a window opening. resolve_db_target() ignores args
    // starting with `-`, so without this the flag would be silently dropped and the app would
    // launch normally instead.
    if std::env::args()
        .skip(1)
        .any(|a| a == "--version" || a == "-V")
    {
        println!("red-request {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Debug)
                // Quiet the chatty deps; keep our own crate + targets verbose.
                .level_for("reqwest", log::LevelFilter::Info)
                .level_for("hyper", log::LevelFilter::Info)
                .max_file_size(5_000_000)
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stdout,
                ))
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Folder {
                        path: app_log_dir(),
                        file_name: Some("red-request".into()),
                    },
                ))
                .build(),
        )
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(EngineState::default())
        .manage(EmbeddedDb::default())
        .manage(OauthState::default())
        .on_window_event(|window, event| {
            // Reap on Destroyed (not CloseRequested) so the webview can flush a pending
            // autosave to reddb on close *before* the sidecar is torn down. The frontend
            // intercepts CloseRequested, flushes the active request, then destroys the window.
            //
            // Close must still be native-fail-safe: if the webview event loop is wedged after
            // registering its close listener, the JS timeout cannot run and the OS close button
            // would be trapped behind preventDefault(). Arm a Rust watchdog on every close
            // request; normal closes destroy first, hung closes are force-destroyed here.
            match event {
                tauri::WindowEvent::CloseRequested { .. } => {
                    arm_close_watchdog(window.clone());
                }
                tauri::WindowEvent::Destroyed => {
                    reap_sidecars(window.app_handle());
                }
                _ => {}
            }
        })
        .setup(|app| {
            let setup_started = Instant::now();
            // Reap sidecars on SIGTERM/SIGINT/SIGHUP (kill, Ctrl-C, terminal/session
            // close). Tauri only reaps on a graceful window close + RunEvent::Exit, so
            // a signalled exit would otherwise orphan `red server` on the .rdb. ctrlc
            // runs this on its own thread, so normal Rust (locks, kill) is safe here.
            let sig_handle = app.handle().clone();
            if let Err(e) = ctrlc::set_handler(move || {
                log::warn!(target: "app", "termination signal — reaping sidecars and exiting");
                reap_sidecars(&sig_handle);
                std::process::exit(0);
            }) {
                log::warn!(target: "app", "could not install signal handler: {e}");
            }

            // Deep links (rr:// branded scheme).
            let dl_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let urls: Vec<String> = event.urls().into_iter().map(|u| u.to_string()).collect();
                // Complete a pending OAuth login waiting on its deep-link redirect.
                if let Some(st) = dl_handle.try_state::<OauthState>() {
                    if let Ok(mut pending) = st.pending.lock() {
                        if let Some(tx) = pending.take() {
                            if let Some(first) = urls.first() {
                                let _ = tx.send(first.clone());
                            }
                        }
                    }
                }
                let _ = dl_handle.emit("deep-link", urls);
            });

            // Start the recker engine sidecar and pump its stdout.
            let app_handle = app.handle().clone();
            let engine_started = Instant::now();
            match spawn_engine(&app_handle) {
                Ok((mut rx, child)) => {
                    log::debug!(
                        target: "perf",
                        "engine.spawn ok in {}ms",
                        perf_ms(engine_started)
                    );
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
                Err(e) => {
                    log::debug!(
                        target: "perf",
                        "engine.spawn err in {}ms",
                        perf_ms(engine_started)
                    );
                    log::error!(target: "engine", "spawn failed: {e}");
                }
            }

            // Resolve which .rdb to open (project-local vs global) and record it.
            let (db_path, project_dir) = resolve_db_target();
            log::info!(
                target: "startup",
                "boot: app v{} | {} mode | arg_launched={} | project_dir={:?}",
                app.package_info().version,
                if project_dir.is_some() { "PROJECT" } else { "GLOBAL" },
                project_dir.is_some(),
                project_dir
            );
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
                    log::error!(target: "reddb", "start_reddb failed: {e}");
                }
            });
            log::debug!(
                target: "perf",
                "app.setup scheduled in {}ms",
                perf_ms(setup_started)
            );
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
            fs_read_external,
            fs_write_external,
            file_meta,
            engine_call,
            reddb_url,
            reddb_request,
            reddb_rql,
            project_info,
            open_project,
            reset_incompatible_db,
            recent_list,
            recent_pin,
            recent_set_count,
            recent_rename,
            recent_remove,
            delete_project_data,
            secret_seal,
            secret_open,
            app_version,
            reddb_version,
            oauth_authorize,
            app_log,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Reap our sidecars on every graceful shutdown path. ExitRequested fires when
            // the last window closes (before teardown); Exit fires as the process ends.
            // The helper is idempotent, so covering both never double-kills.
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                reap_sidecars(&app_handle);
            }
        });
}
