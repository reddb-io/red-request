import { invoke } from "@tauri-apps/api/core";

export interface ProjectInfo {
  db_path: string;
  project_dir: string | null;
  is_project: boolean;
  arg_launched: boolean;
  /** Custom display name from recents (null → fall back to the folder name). */
  name: string | null;
}

export interface RecentProject {
  dir: string;
  name: string;
  last_opened: number;
  pinned: boolean;
  request_count: number;
}

export const projectInfo = (): Promise<ProjectInfo> =>
  invoke<ProjectInfo>("project_info");

export const recentList = (): Promise<RecentProject[]> =>
  invoke<RecentProject[]>("recent_list");

export const recentPin = (dir: string, pinned: boolean): Promise<void> =>
  invoke<void>("recent_pin", { dir, pinned });

export const recentSetCount = (dir: string, count: number): Promise<void> =>
  invoke<void>("recent_set_count", { dir, count });

/** Set a custom display name for a project (recents only — does not touch the folder). */
export const recentRename = (dir: string, name: string): Promise<void> =>
  invoke<void>("recent_rename", { dir, name });

/** Forget a project: drop it from recents. Touches no files. */
export const recentRemove = (dir: string): Promise<void> =>
  invoke<void>("recent_remove", { dir });

/** Permanently delete a project's `.red/request` data (app.rdb) and forget it. */
export const deleteProjectData = (dir: string): Promise<void> =>
  invoke<void>("delete_project_data", { dir });

/** Switch the embedded reddb to a project dir (or global with `null`). */
export const openProject = (dir: string | null): Promise<ProjectInfo> =>
  invoke<ProjectInfo>("open_project", { dir });

/** Short label for the header: the project folder name, or "global". */
export function projectLabel(info: ProjectInfo | null): string {
  if (!info) return "";
  if (!info.is_project || !info.project_dir) return "global";
  if (info.name) return info.name;
  const parts = info.project_dir.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? info.project_dir;
}
