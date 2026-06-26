import { invoke } from "@tauri-apps/api/core";
import { developerConsole } from "./developer-console.svelte";

export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

/**
 * Mirror a log line to the devtools console AND the backend file sink
 * (`app_log` → ~/.red/request/logs/red-request.log), so the FE↔BE flow lands in
 * one place instead of an invisible webview console. Never throws.
 */
export function appLog(level: LogLevel, message: string): void {
  developerConsole.logApp(level, message);
  const c = console[level === "trace" ? "debug" : level] ?? console.log;
  c(`[ui] ${message}`);
  void invoke("app_log", { level, message }).catch(() => {});
}
