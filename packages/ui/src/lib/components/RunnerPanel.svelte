<script lang="ts">
  import { ws } from "../store.svelte";

  let { onClose }: { onClose: () => void } = $props();

  type Mode = "repeat" | "data" | "flow";
  let mode = $state<Mode>("repeat");
  let count = $state(5);
  let datasetText = $state('[\n  { "id": "1" },\n  { "id": "2" }\n]');
  let parseError = $state<string | null>(null);

  function statusColor(s: number): string {
    if (s === 0) return "text-zinc-500";
    if (s < 300) return "text-emerald-400";
    if (s < 400) return "text-blue-400";
    if (s < 500) return "text-amber-400";
    return "text-red-400";
  }

  async function run() {
    parseError = null;
    if (mode === "data") {
      let dataset: Record<string, string>[];
      try {
        dataset = JSON.parse(datasetText);
        if (!Array.isArray(dataset)) throw new Error("dataset must be a JSON array");
      } catch (e) {
        parseError = e instanceof Error ? e.message : String(e);
        return;
      }
      await ws.runLoop({ mode, dataset });
    } else if (mode === "repeat") {
      await ws.runLoop({ mode, count });
    } else {
      await ws.runLoop({ mode });
    }
  }

  const field =
    "mono rounded bg-[var(--color-bg-2)] px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-[var(--color-accent)]";
</script>

<div
  class="fixed inset-0 z-50 grid place-items-center bg-black/60"
  onclick={(e) => e.target === e.currentTarget && onClose()}
  role="presentation"
>
  <div
    class="flex h-[80vh] w-[760px] flex-col overflow-hidden rounded-xl border border-[var(--color-bg-3)] bg-[var(--color-bg-1)] shadow-2xl"
  >
    <div class="flex items-center justify-between border-b border-[var(--color-bg-3)] px-4 py-2">
      <h2 class="text-sm font-semibold text-zinc-200">Run</h2>
      <button onclick={onClose} class="text-zinc-500 hover:text-zinc-200">✕</button>
    </div>

    <div class="flex gap-1 border-b border-[var(--color-bg-3)] px-3 text-sm">
      {#each ["repeat", "data", "flow"] as const as m (m)}
        <button
          onclick={() => (mode = m)}
          class="px-2 py-2 capitalize"
          class:text-[var(--color-accent)]={mode === m}
          class:text-zinc-400={mode !== m}>{m}</button
        >
      {/each}
    </div>

    <div class="flex items-end gap-3 border-b border-[var(--color-bg-3)] p-3">
      {#if mode === "repeat"}
        <label class="text-sm text-zinc-400">
          Count
          <input type="number" min="1" max="1000" bind:value={count} class="{field} ml-2 w-20" />
        </label>
        <span class="text-xs text-zinc-600">Runs “{ws.activeReq?.name}” {count}×.</span>
      {:else if mode === "data"}
        <div class="flex-1">
          <div class="mb-1 text-xs text-zinc-500">
            Dataset (JSON array of objects — keys become variables per iteration)
          </div>
          <textarea bind:value={datasetText} rows="5" class="{field} w-full"></textarea>
          {#if parseError}<div class="mt-1 text-xs text-red-400">{parseError}</div>{/if}
        </div>
      {:else}
        <span class="text-xs text-zinc-500">
          Runs all {ws.activeCollection?.requests.length ?? 0} requests of “{ws.activeCollection
            ?.collection.name}” in order; each post-response <code class="mono">setVar</code> threads into the next.
        </span>
      {/if}
      <button
        onclick={run}
        disabled={ws.running}
        class="ml-auto rounded bg-[var(--color-accent)] px-4 py-1.5 text-sm font-semibold text-black disabled:opacity-50"
        >{ws.running ? "Running…" : "Run"}</button
      >
    </div>

    <div class="flex-1 overflow-auto p-3">
      {#if ws.runError}
        <div class="rounded border border-red-500/40 bg-red-500/10 p-2 text-sm text-red-300">
          {ws.runError}
        </div>
      {:else if ws.runResult}
        {@const a = ws.runResult.aggregate}
        <div class="mb-3 flex gap-4 text-sm">
          <span class="text-zinc-300">{a.total} runs</span>
          <span class="text-emerald-400">{a.okCount} ok</span>
          <span class="text-zinc-400">avg {a.avgMs}ms</span>
          <span class="text-emerald-400">{a.passed} ✓</span>
          <span class={a.failed ? "text-red-400" : "text-zinc-600"}>{a.failed} ✗</span>
        </div>
        <table class="w-full text-sm">
          <tbody>
            {#each ws.runResult.iterations as it (it.index)}
              {@const failed = it.scriptResult?.tests.filter((t) => !t.passed).length ?? 0}
              <tr class="border-b border-[var(--color-bg-2)]">
                <td class="mono py-1 pr-3 text-zinc-500">{it.method}</td>
                <td class="py-1 pr-3 text-zinc-300">{it.label}</td>
                <td class="mono py-1 pr-3 {statusColor(it.response.status)}">{it.response.status || "—"}</td>
                <td class="mono py-1 pr-3 text-zinc-500">{it.response.durationMs}ms</td>
                <td class="py-1">
                  {#if it.scriptResult?.tests.length}
                    <span class={failed ? "text-red-400" : "text-emerald-400"}
                      >{failed ? `${failed}✗` : "✓"}</span
                    >
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <p class="text-sm text-zinc-600">Configure a mode and press Run.</p>
      {/if}
    </div>
  </div>
</div>
