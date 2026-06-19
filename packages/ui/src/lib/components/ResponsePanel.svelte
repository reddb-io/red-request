<script lang="ts">
  import { ws } from "../store.svelte";

  let tab = $state<"body" | "headers" | "timings">("body");

  const r = $derived(ws.response);

  function statusColor(s: number): string {
    if (s === 0) return "text-zinc-500";
    if (s < 300) return "text-emerald-400";
    if (s < 400) return "text-blue-400";
    if (s < 500) return "text-amber-400";
    return "text-red-400";
  }

  const prettyBody = $derived.by(() => {
    if (!r) return "";
    const ct = r.contentType ?? "";
    if (ct.includes("json")) {
      try {
        return JSON.stringify(JSON.parse(r.bodyText), null, 2);
      } catch {
        return r.bodyText;
      }
    }
    return r.bodyText;
  });

  function fmtSize(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }
</script>

<section class="flex h-full flex-col bg-[var(--color-bg-0)]">
  {#if ws.errorMsg}
    <div class="m-3 rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
      {ws.errorMsg}
    </div>
  {/if}

  {#if !r}
    <div class="grid flex-1 place-items-center text-sm text-zinc-600">
      Send a request to see the response.
    </div>
  {:else}
    <div
      class="flex items-center gap-4 border-b border-[var(--color-bg-3)] px-4 py-2 text-sm"
    >
      <span class="mono font-bold {statusColor(r.status)}">
        {r.status || "—"}
        {r.statusText}
      </span>
      <span class="text-zinc-500">{r.durationMs} ms</span>
      <span class="text-zinc-500">{fmtSize(r.size)}</span>
      {#if r.error}
        <span class="text-red-400">{r.error.message}</span>
      {/if}
      {#if ws.unresolved.length}
        <span class="text-amber-400" title="unresolved variables">
          ⚠ {ws.unresolved.join(", ")}
        </span>
      {/if}
    </div>

    <div class="flex gap-1 border-b border-[var(--color-bg-3)] px-3 py-1 text-sm">
      {#each ["body", "headers", "timings"] as const as t (t)}
        <button
          onclick={() => (tab = t)}
          class="rounded px-2 py-1 capitalize"
          class:text-[var(--color-accent)]={tab === t}
          class:text-zinc-400={tab !== t}>{t}</button
        >
      {/each}
    </div>

    <div class="flex-1 overflow-auto p-3">
      {#if tab === "body"}
        <pre class="mono text-xs whitespace-pre-wrap text-zinc-200">{prettyBody}</pre>
      {:else if tab === "headers"}
        <table class="mono w-full text-xs">
          <tbody>
            {#each Object.entries(r.headers) as [k, v] (k)}
              <tr class="border-b border-[var(--color-bg-2)]">
                <td class="py-1 pr-4 text-zinc-400">{k}</td>
                <td class="py-1 break-all text-zinc-200">{v}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <table class="mono w-full text-xs">
          <tbody>
            {#each Object.entries(r.timings ?? {}) as [k, v] (k)}
              <tr class="border-b border-[var(--color-bg-2)]">
                <td class="py-1 pr-4 text-zinc-400">{k}</td>
                <td class="py-1 text-zinc-200">{Number(v).toFixed(1)} ms</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>
  {/if}
</section>
