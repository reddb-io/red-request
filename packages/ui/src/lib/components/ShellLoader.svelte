<script lang="ts">
  import { onMount, type Component } from "svelte";

  let AppShellComponent = $state<Component | null>(null);
  let bootError = $state<unknown>(null);
  let loading = $state(true);

  function errorText(error: unknown): string {
    if (error instanceof Error) return error.stack ?? error.message;
    return String(error);
  }

  async function loadShell() {
    loading = true;
    bootError = null;
    AppShellComponent = null;
    try {
      AppShellComponent = (await import("$lib/components/AppShell.svelte")).default;
    } catch (error) {
      bootError = error;
    } finally {
      loading = false;
    }
  }

  async function chooseAnotherProject() {
    try {
      const { ws } = await import("$lib/store.svelte");
      ws.backToSelector();
      await loadShell();
    } catch (error) {
      bootError = error;
    }
  }

  function exportBootCrashReport(error: unknown) {
    const report = {
      kind: "red-request-shell-boot-crash",
      createdAt: new Date().toISOString(),
      error: errorText(error),
      url: location.href,
      userAgent: navigator.userAgent,
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `red-request-shell-crash-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function reloadWindow() {
    try {
      location.reload();
    } catch {
      /* webview shell will handle it */
    }
  }

  onMount(() => {
    void loadShell();
  });
</script>

{#snippet bootFailed(error: unknown, retry: () => void)}
  <div class="grid h-full place-items-center px-8 text-center">
    <div class="max-w-lg">
      <h1 class="mb-2 text-lg font-semibold text-red-400">Project shell failed to start</h1>
      <p class="mb-4 text-sm text-fg-muted">
        red-request could not load the project workspace. The window controls remain
        available; use the recovery actions below instead of waiting on a blank screen.
      </p>
      <pre
        class="mono mb-4 max-h-44 overflow-auto whitespace-pre-wrap rounded bg-[var(--color-bg-1)] p-3 text-left text-[11px] text-fg-muted"
      >{errorText(error)}</pre>
      <div class="flex flex-wrap items-center justify-center gap-2">
        <button
          class="rounded border border-border px-2 py-1 text-xs text-fg hover:bg-[var(--color-bg-1)]"
          type="button"
          onclick={retry}
        >
          Retry shell
        </button>
        <button
          class="rounded border border-border px-2 py-1 text-xs text-fg hover:bg-[var(--color-bg-1)]"
          type="button"
          onclick={() => exportBootCrashReport(error)}
        >
          Export crash report
        </button>
        <button
          class="rounded px-2 py-1 text-xs text-fg-muted hover:bg-[var(--color-bg-1)] hover:text-fg"
          type="button"
          onclick={chooseAnotherProject}
        >
          Choose another project
        </button>
        <button
          class="rounded px-2 py-1 text-xs text-fg-muted hover:bg-[var(--color-bg-1)] hover:text-fg"
          type="button"
          onclick={reloadWindow}
        >
          Reload window
        </button>
      </div>
    </div>
  </div>
{/snippet}

{#snippet appFailed(error: unknown, reset: () => void)}
  {@render bootFailed(error, () => {
    reset();
    void loadShell();
  })}
{/snippet}

<div class="min-h-0 flex-1 overflow-hidden">
  {#if AppShellComponent}
    <svelte:boundary failed={appFailed}>
      <AppShellComponent />
    </svelte:boundary>
  {:else if bootError}
    {@render bootFailed(bootError, () => void loadShell())}
  {:else if loading}
    <div class="grid h-full place-items-center text-sm text-fg-subtle">
      loading shell…
    </div>
  {/if}
</div>
