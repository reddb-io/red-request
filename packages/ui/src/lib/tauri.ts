// Whether we're running inside the Tauri shell (vs a plain browser dev server).
// The fs/keychain/engine bridges only exist under Tauri.
export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
