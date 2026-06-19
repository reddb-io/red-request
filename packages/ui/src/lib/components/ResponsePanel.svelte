<script lang="ts">
  import { ws } from "../store.svelte";

  let tab = $state<"body" | "headers" | "timings" | "tests">("body");

  const r = $derived(ws.response);
  const failed = $derived(ws.tests.filter((t) => !t.passed).length);
  const hasScripts = $derived(
    ws.tests.length > 0 || ws.logs.length > 0 || ws.scriptError !== null
  );

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
      {#if hasScripts}
        <button
          onclick={() => (tab = "tests")}
          class="rounded px-2 py-1 capitalize"
          class:text-[var(--color-accent)]={tab === "tests"}
          class:text-zinc-400={tab !== "tests"}
        >
          tests
          {#if failed}<span class="ml-1 text-red-400">{failed}✗</span>{:else if ws.tests.length}<span class="ml-1 text-emerald-400">✓</span>{/if}
        </button>
      {/if}
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
      {:else if tab === "timings"}
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
      {:else}
        <div class="flex flex-col gap-3 text-xs">
          {#if ws.scriptError}
            <div class="rounded border border-red-500/40 bg-red-500/10 p-2 text-red-300">
              script error: {ws.scriptError}
            </div>
          {/if}
          {#if ws.tests.length}
            <div class="flex flex-col gap-1">
              {#each ws.tests as t (t.name)}
                <div class="flex items-start gap-2">
                  <span class={t.passed ? "text-emerald-400" : "text-red-400"}>
                    {t.passed ? "✓" : "✗"}
                  </span>
                  <span class="text-zinc-200">{t.name}</span>
                  {#if !t.passed && t.error}<span class="text-red-400/80">— {t.error}</span>{/if}
                </div>
              {/each}
            </div>
          {/if}
          {#if ws.logs.length}
            <div>
              <div class="mb-1 text-[10px] tracking-wide text-zinc-500 uppercase">console</div>
              <pre class="mono whitespace-pre-wrap text-zinc-400">{ws.logs.join("\n")}</pre>
            </div>
          {/if}
          {#if !ws.tests.length && !ws.logs.length && !ws.scriptError}
            <p class="text-zinc-600">No script output.</p>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</section>
