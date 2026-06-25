import { invoke } from "@tauri-apps/api/core";

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export const collectionsRoot = (): Promise<string> =>
  invoke<string>("collections_root");

export const listDir = (path: string): Promise<DirEntry[]> =>
  invoke<DirEntry[]>("fs_list_dir", { path });

export const readText = (path: string): Promise<string> =>
  invoke<string>("fs_read_text", { path });

export const writeText = (path: string, contents: string): Promise<void> =>
  invoke<void>("fs_write_text", { path, contents });

export const mkdirp = (path: string): Promise<void> =>
  invoke<void>("fs_mkdirp", { path });

export const remove = (path: string): Promise<void> =>
  invoke<void>("fs_remove", { path });

// External read/write for OS-dialog-chosen paths (export/import to/from anywhere on
// disk). NOT sandboxed to the collections root — the native dialog is the user's
// consent boundary. Use these only with a path returned by an open/save dialog.
export const readTextExternal = (path: string): Promise<string> =>
  invoke<string>("fs_read_external", { path });

export const writeTextExternal = (
  path: string,
  contents: string
): Promise<void> => invoke<void>("fs_write_external", { path, contents });
