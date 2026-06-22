<script lang="ts">
  // Custom window chrome — replaces the OS title bar (decorations:false in
  // tauri.conf.json). Brand monogram sits left; a full-width drag region carries
  // the window; our own minimize / maximize / close controls sit right and call
  // the Tauri window API. Renders inert (no buttons) outside the desktop shell.
  import { brand } from "../brand.generated";
  import Minus from "@lucide/svelte/icons/minus";
  import Square from "@lucide/svelte/icons/square";
  import Copy from "@lucide/svelte/icons/copy";
  import X from "@lucide/svelte/icons/x";

  const inTauri =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  let maximized = $state(false);

  async function appWindow() {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow();
  }

  async function minimize() {
    if (!inTauri) return;
    await (await appWindow()).minimize();
  }
  async function toggleMaximize() {
    if (!inTauri) return;
    const w = await appWindow();
    await w.toggleMaximize();
    maximized = await w.isMaximized();
  }
  async function close() {
    if (!inTauri) return;
    await (await appWindow()).close();
  }

  $effect(() => {
    if (!inTauri) return;
    void (async () => {
      const w = await appWindow();
      maximized = await w.isMaximized();
      const un = await w.onResized(async () => {
        maximized = await w.isMaximized();
      });
      return un;
    })();
  });
</script>

<div
  data-tauri-drag-region
  class="flex h-8 shrink-0 select-none items-center border-b border-border bg-[var(--color-bg-0)]"
>
  <!-- Brand, left -->
  <div class="pointer-events-none flex items-center gap-2 pl-2.5 pr-3">
    <span
      class="grid h-5 w-5 place-items-center rounded bg-[var(--color-brand)] text-xs font-bold text-black"
      >{brand.monogram}</span
    >
    <span class="text-xs font-medium text-fg-subtle">{brand.productName}</span>
  </div>

  <!-- Drag spacer -->
  <div data-tauri-drag-region class="h-full flex-1"></div>

  <!-- Window controls, right -->
  {#if inTauri}
    <div class="flex h-full items-stretch">
      <button
        onclick={minimize}
        aria-label="Minimize"
        class="grid w-11 place-items-center text-fg-muted transition-colors hover:bg-[var(--color-bg-2)] hover:text-fg-strong"
      >
        <Minus size={15} strokeWidth={2} />
      </button>
      <button
        onclick={toggleMaximize}
        aria-label={maximized ? "Restore" : "Maximize"}
        class="grid w-11 place-items-center text-fg-muted transition-colors hover:bg-[var(--color-bg-2)] hover:text-fg-strong"
      >
        {#if maximized}
          <Copy size={13} strokeWidth={2} />
        {:else}
          <Square size={12} strokeWidth={2} />
        {/if}
      </button>
      <button
        onclick={close}
        aria-label="Close"
        class="grid w-11 place-items-center text-fg-muted transition-colors hover:bg-red-600 hover:text-white"
      >
        <X size={16} strokeWidth={2} />
      </button>
    </div>
  {/if}
</div>
