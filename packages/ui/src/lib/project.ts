import { invoke } from "@tauri-apps/api/core";

export interface ProjectInfo {
  db_path: string;
  project_dir: string | null;
  is_project: boolean;
  arg_launched: boolean;
}

export interface RecentProject {
  dir: string;
  name: string;
  last_opened: number;
}

export const projectInfo = (): Promise<ProjectInfo> =>
  invoke<ProjectInfo>("project_info");

export const recentList = (): Promise<RecentProject[]> =>
  invoke<RecentProject[]>("recent_list");

/** Switch the embedded reddb to a project dir (or global with `null`). */
export const openProject = (dir: string | null): Promise<ProjectInfo> =>
  invoke<ProjectInfo>("open_project", { dir });

/** Short label for the header: the project folder name, or "global". */
export function projectLabel(info: ProjectInfo | null): string {
  if (!info) return "";
  if (!info.is_project || !info.project_dir) return "global";
  const parts = info.project_dir.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? info.project_dir;
}
