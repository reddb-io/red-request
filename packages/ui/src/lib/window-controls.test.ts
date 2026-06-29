import { beforeEach, describe, expect, it, vi } from "vitest";

const tauriCore = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

const tauriWindow = vi.hoisted(() => ({
  window: {
    minimize: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    isMaximized: vi.fn(async () => false),
    onResized: vi.fn(async () => vi.fn()),
  },
  getCurrentWindow: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => tauriCore);
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: tauriWindow.getCurrentWindow,
}));

describe("window controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tauriCore.invoke.mockResolvedValue(true);
    tauriWindow.getCurrentWindow.mockReturnValue(tauriWindow.window);
    tauriWindow.window.isMaximized.mockResolvedValue(false);
  });

  it("uses the Rust maximize command as the primary path", async () => {
    const { toggleMaximizeWindow } = await import("./window-controls");

    await expect(toggleMaximizeWindow()).resolves.toBe(true);

    expect(tauriCore.invoke).toHaveBeenCalledWith("window_toggle_maximize");
    expect(tauriWindow.getCurrentWindow).not.toHaveBeenCalled();
  });

  it("falls back to the Tauri window API when the Rust command is unavailable", async () => {
    tauriCore.invoke.mockRejectedValueOnce(new Error("command missing"));
    tauriWindow.window.isMaximized.mockResolvedValueOnce(true);
    const { toggleMaximizeWindow } = await import("./window-controls");

    await expect(toggleMaximizeWindow()).resolves.toBe(true);

    expect(tauriWindow.getCurrentWindow).toHaveBeenCalledTimes(1);
    expect(tauriWindow.window.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(tauriWindow.window.isMaximized).toHaveBeenCalledTimes(1);
  });
});
