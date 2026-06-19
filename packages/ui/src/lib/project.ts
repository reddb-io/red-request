import { invoke } from "@tauri-apps/api/core";

export interface ProjectInfo {
  db_path: string;
  project_dir: string | null;
  is_project: boolean;
}

export const projectInfo = (): Promise<ProjectInfo> =>
  invoke<ProjectInfo>("project_info");

/** Short label for the header: the project folder name, or "global". */
export function projectLabel(info: ProjectInfo | null): string {
  if (!info) return "";
  if (!info.is_project || !info.project_dir) return "global";
  const parts = info.project_dir.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? info.project_dir;
}
