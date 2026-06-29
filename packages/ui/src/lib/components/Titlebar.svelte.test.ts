import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/svelte";

import Titlebar from "./Titlebar.svelte";

const controls = vi.hoisted(() => ({
  minimizeWindow: vi.fn(async () => {}),
  toggleMaximizeWindow: vi.fn(async () => true),
  closeWindow: vi.fn(async () => {}),
  watchMaximizedState: vi.fn(async (setMaximized: (value: boolean) => void) => {
    setMaximized(false);
    return vi.fn();
  }),
}));

vi.mock("../window-controls", () => controls);

describe("Titlebar window controls", () => {
  beforeEach(() => {
    controls.minimizeWindow.mockClear();
    controls.toggleMaximizeWindow.mockClear();
    controls.toggleMaximizeWindow.mockResolvedValue(true);
    controls.closeWindow.mockClear();
    controls.watchMaximizedState.mockClear();
    controls.watchMaximizedState.mockImplementation(
      async (setMaximized: (value: boolean) => void) => {
        setMaximized(false);
        return vi.fn();
      }
    );
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps window control buttons out of the native drag region", () => {
    render(Titlebar);

    expect(
      screen
        .getByLabelText("Minimize window")
        .closest("[data-tauri-drag-region]")
    ).toBeNull();
    expect(
      screen
        .getByLabelText("Maximize window")
        .closest("[data-tauri-drag-region]")
    ).toBeNull();
    expect(
      screen.getByLabelText("Close window").closest("[data-tauri-drag-region]")
    ).toBeNull();
  });

  it("dispatches minimize, maximize and close to the current Tauri window", async () => {
    render(Titlebar);

    await fireEvent.click(screen.getByLabelText("Minimize window"));
    await fireEvent.click(screen.getByLabelText("Maximize window"));
    await fireEvent.click(screen.getByLabelText("Close window"));

    await waitFor(() => {
      expect(controls.minimizeWindow).toHaveBeenCalledTimes(1);
      expect(controls.toggleMaximizeWindow).toHaveBeenCalledTimes(1);
      expect(controls.closeWindow).toHaveBeenCalledTimes(1);
    });
  });

  it("restores the current Tauri window when already maximized", async () => {
    controls.watchMaximizedState.mockImplementation(
      async (setMaximized: (value: boolean) => void) => {
        setMaximized(true);
        return vi.fn();
      }
    );
    controls.toggleMaximizeWindow.mockResolvedValue(false);

    render(Titlebar);

    await waitFor(() => {
      expect(screen.getByLabelText("Restore window")).toBeTruthy();
    });
    await fireEvent.click(screen.getByLabelText("Restore window"));

    await waitFor(() => {
      expect(controls.toggleMaximizeWindow).toHaveBeenCalledTimes(1);
    });
  });
});
