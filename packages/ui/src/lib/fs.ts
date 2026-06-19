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
