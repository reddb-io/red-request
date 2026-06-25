// Backup / restore the app's RedDB store as a portable JSON file. Every rr_* KV collection is
// read through the LIVE server (the RQL conduit, like the rest of the app) — NOT a file-level
// `red dump`, so it never fights the embedded server's single-writer lock — and written next to
// the .rdb under `backups/`. Restore KV PUTs every entry back. This is the durable safety net
// while reddb's native VCS commit lands (reddb-io/reddb#1382 — commits are workset/per-connection
// today, so per-change auto-commit can't capture our RQL-conduit writes yet).
import { kvList, kvPut, ensureKvCollection } from "./reddb";
import {
  writeText,
  readText,
  listDir,
  mkdirp,
  remove,
  type DirEntry,
} from "./fs";
import { projectInfo } from "./project";
import { COL, REQ, ENV, HIST, SETTINGS, OAUTH } from "./repo";
import { appLog } from "./log";

/** Every collection that holds the user's work. History is included for a faithful restore. */
const COLLECTIONS = [COL, REQ, ENV, SETTINGS, OAUTH, HIST] as const;

export interface BackupFile {
  format: "red-request-backup";
  version: 1;
  createdAt: string; // ISO 8601
  collections: Record<string, Array<{ key: string; value: unknown }>>;
}

function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(0, i) : ".";
}
function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/** `<dir of the active .rdb>/backups` — per-project, next to the store it backs up. */
async function backupsDir(): Promise<string> {
  const info = await projectInfo();
  return joinPath(dirOf(info.db_path), "backups");
}

/** Read every collection (via the live RQL conduit) into a backup object. */
export async function snapshot(): Promise<BackupFile> {
  const collections: BackupFile["collections"] = {};
  for (const c of COLLECTIONS) {
    collections[c] = await kvList<unknown>(c).catch(() => []);
  }
  return {
    format: "red-request-backup",
    version: 1,
    createdAt: new Date().toISOString(),
    collections,
  };
}

function isEmpty(b: BackupFile): boolean {
  return Object.values(b.collections).every((rows) => rows.length === 0);
}

/** Write a timestamped backup to `backups/`; returns its path. Prunes to the `keep` newest.
 *  Refuses to write an all-empty snapshot (don't bury real backups under fresh-store noise). */
export async function createBackup(keep = 20): Promise<string | null> {
  const data = await snapshot();
  if (isEmpty(data)) {
    appLog("debug", "backup: store is empty — skipping");
    return null;
  }
  const dir = await backupsDir();
  await mkdirp(dir);
  const stamp = data.createdAt.replace(/[:.]/g, "-");
  const path = joinPath(dir, `backup-${stamp}.json`);
  await writeText(path, JSON.stringify(data));
  appLog("info", `backup: wrote ${path}`);
  await pruneBackups(keep).catch(() => {});
  return path;
}

/** Backup files in `backups/`, newest first (the name is ISO-timestamped, so name sort works). */
export async function listBackups(): Promise<DirEntry[]> {
  const dir = await backupsDir();
  const entries = await listDir(dir).catch(() => []);
  return entries
    .filter(
      (e) =>
        !e.is_dir && e.name.startsWith("backup-") && e.name.endsWith(".json")
    )
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

async function pruneBackups(keep: number): Promise<void> {
  const all = await listBackups();
  for (const old of all.slice(keep)) await remove(old.path).catch(() => {});
}

/** Delete a single backup file. Its path lives under the guarded `backups/` dir, so the
 *  sandboxed `fs.remove` accepts it. Refuses anything that isn't a `backup-*.json`. */
export async function deleteBackup(path: string): Promise<void> {
  const name = path.slice(
    Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1
  );
  if (!name.startsWith("backup-") || !name.endsWith(".json"))
    throw new Error("refusing to delete a non-backup file");
  await remove(path);
  appLog("info", `backup: deleted ${path}`);
}

/** One rotating backup per app launch (after the store loads), so every session's good state is
 *  captured before any later mishap. Idempotent within a session; keep ~20 launches of history. */
let backedUpThisSession = false;
export async function autoBackup(): Promise<void> {
  if (backedUpThisSession) return;
  backedUpThisSession = true;
  try {
    await createBackup();
  } catch (e) {
    backedUpThisSession = false;
    appLog("warn", `autoBackup failed: ${e instanceof Error ? e.message : e}`);
  }
}

/** Restore a backup file: KV PUT every entry back into its collection (overwrites live values). */
export async function restoreBackup(
  path: string
): Promise<{ collections: number; entries: number }> {
  const raw = await readText(path);
  const data = JSON.parse(raw) as BackupFile;
  if (data?.format !== "red-request-backup")
    throw new Error("not a Red Request backup file");
  let entries = 0;
  const names = Object.keys(data.collections);
  for (const c of names) {
    await ensureKvCollection(c).catch(() => {});
    for (const { key, value } of data.collections[c] ?? []) {
      await kvPut(c, key, value);
      entries++;
    }
  }
  appLog(
    "info",
    `backup: restored ${entries} entries (${names.length} collections) from ${path}`
  );
  return { collections: names.length, entries };
}
