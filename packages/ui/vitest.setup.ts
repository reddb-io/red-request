import { afterEach } from "vitest";
import { clearMocks } from "@tauri-apps/api/mocks";

// Tauri's mockIPC patches window internals; reset between tests so each test
// declares its own IPC behaviour.
afterEach(() => {
  clearMocks();
});
