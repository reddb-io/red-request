type TauriWindow = {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  onResized(cb: () => void | Promise<void>): Promise<() => void>;
};

async function currentWindow(): Promise<TauriWindow> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

export async function watchMaximizedState(
  setMaximized: (value: boolean) => void
): Promise<() => void> {
  const w = await currentWindow();
  setMaximized(await w.isMaximized());
  return w.onResized(async () => {
    setMaximized(await w.isMaximized());
  });
}

export async function minimizeWindow(): Promise<void> {
  await (await currentWindow()).minimize();
}

export async function toggleMaximizeWindow(): Promise<boolean> {
  const w = await currentWindow();
  await w.toggleMaximize();
  return w.isMaximized();
}

export async function closeWindow(): Promise<void> {
  await (await currentWindow()).close();
}
