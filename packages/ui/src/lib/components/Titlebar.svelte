<script lang="ts">
  // App identity strip + window controls. Now that tauri.conf.json disables
  // native decorations (decorations: false), the close / minimize / maximize
  // buttons live here so the user can always reach them — even when the
  // webview freezes. The data-tauri-drag-region on the bar keeps it draggable
  // across all three OSes.
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { brand } from "../brand.generated";
  import { onMount } from "svelte";

  let isMaximized = $state(false);

  // Refresh the maximized indicator so the toggle glyph stays accurate when
  // the user double-clicks the title bar to maximize.
  onMount(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const w = getCurrentWindow();
        isMaximized = await w.isMaximized();
        unlisten = await w.onResized(async () => {
          isMaximized = await w.isMaximized();
        });
      } catch {
        /* not running inside the Tauri shell (browser dev) — controls just no-op */
      }
    })();
    return () => unlisten?.();
  });

  async function minimize() {
    try {
      await getCurrentWindow().minimize();
    } catch {
      /* ignore — running outside Tauri */
    }
  }
  async function toggleMaximize() {
    try {
      const w = getCurrentWindow();
      if (await w.isMaximized()) await w.unmaximize();
      else await w.maximize();
    } catch {
      /* ignore */
    }
  }
  async function closeWindow() {
    try {
      await getCurrentWindow().close();
    } catch {
      /* ignore */
    }
  }
</script>

<div
  class="sticky top-0 z-[2000] isolate flex h-8 shrink-0 select-none items-center border-b border-border bg-[var(--color-bg-0)]"
  data-tauri-drag-region
>
  <!-- Brand, left -->
  <div class="flex items-center gap-2 pl-2.5 pr-3">
    <span
      class="grid h-5 w-5 place-items-center rounded bg-[var(--color-brand)] text-xs font-bold text-black"
      >{brand.monogram}</span
    >
    <span class="text-xs font-medium text-fg-subtle">{brand.productName}</span>
  </div>

  <!-- Spacer so window controls stay right-aligned -->
  <div class="flex-1"></div>

  <!-- Window controls (only meaningful inside Tauri — no-op in browser dev).
       Order matches OS convention: minimize → maximize → close. The close
       button turns red on hover for the classic destructive affordance. -->
  <div class="flex items-center">
    <button
      type="button"
      onclick={minimize}
      aria-label="Minimize window"
      title="Minimize"
      class="grid h-8 w-9 place-items-center text-fg-subtle transition-colors hover:bg-[var(--color-bg-2)] hover:text-fg"
    >
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <rect x="1" y="4.5" width="8" height="1" fill="currentColor" />
      </svg>
    </button>
    <button
      type="button"
      onclick={toggleMaximize}
      aria-label={isMaximized ? "Restore window" : "Maximize window"}
      title={isMaximized ? "Restore" : "Maximize"}
      class="grid h-8 w-9 place-items-center text-fg-subtle transition-colors hover:bg-[var(--color-bg-2)] hover:text-fg"
    >
      {#if isMaximized}
        <!-- Two overlapping squares (restore). -->
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <rect x="0.5" y="2.5" width="6" height="6" fill="none" stroke="currentColor" stroke-width="1" />
          <rect x="2.5" y="0.5" width="6" height="6" fill="none" stroke="currentColor" stroke-width="1" />
        </svg>
      {:else}
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <rect x="1" y="1" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1" />
        </svg>
      {/if}
    </button>
    <button
      type="button"
      onclick={closeWindow}
      aria-label="Close window"
      title="Close"
      class="grid h-8 w-9 place-items-center text-fg-subtle transition-colors hover:bg-red-500 hover:text-white"
    >
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path
          d="M1 1 L9 9 M9 1 L1 9"
          stroke="currentColor"
          stroke-width="1.2"
          stroke-linecap="round"
        />
      </svg>
    </button>
  </div>
</div>
