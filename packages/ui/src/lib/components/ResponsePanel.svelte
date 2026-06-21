<script lang="ts">
  import { ws } from "../store.svelte";
  import type { ResponseResult } from "@red-request/core";
  import { Button } from "./ui/button/index.js";
  import { Input } from "./ui/input/index.js";
  import { save } from "@tauri-apps/plugin-dialog";
  import * as fs from "../fs";

  let tab = $state<"body" | "headers" | "timings" | "tests">("body");
  let bodyQuery = $state("");
  let saved = $state(false);

  function extFor(ct: string): string {
    if (ct.includes("json")) return "json";
    if (ct.includes("html")) return "html";
    if (ct.includes("xml")) return "xml";
    if (ct.includes("csv")) return "csv";
    if (ct.includes("javascript")) return "js";
    return "txt";
  }
  async function saveToFile() {
    if (!r) return;
    try {
      const path = await save({ defaultPath: `response.${extFor(r.contentType ?? "")}` });
      if (!path) return;
      await fs.writeText(path, prettyBody);
      saved = true;
      setTimeout(() => (saved = false), 1200);
    } catch {
      /* user cancelled or fs error */
    }
  }

  // Body search: matching lines (with their real line number), and a per-line split for
  // highlighting. Empty query → the fast full <pre> render below.
  const matches = $derived.by(() => {
    const q = bodyQuery.trim().toLowerCase();
    if (!q) return null;
    return bodyLines
      .map((line, i) => ({ n: i + 1, line }))
      .filter((x) => x.line.toLowerCase().includes(q));
  });
  const matchCount = $derived.by(() => {
    const q = bodyQuery.trim();
    if (!q || !matches) return 0;
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    return matches.reduce((c, m) => c + (m.line.match(re)?.length ?? 0), 0);
  });
  function splitLine(line: string): { text: string; hit: boolean }[] {
    const q = bodyQuery.trim();
    if (!q) return [{ text: line, hit: false }];
    const out: { text: string; hit: boolean }[] = [];
    const lc = line.toLowerCase();
    const ql = q.toLowerCase();
    let i = 0;
    for (let j = lc.indexOf(ql); j !== -1; j = lc.indexOf(ql, i)) {
      if (j > i) out.push({ text: line.slice(i, j), hit: false });
      out.push({ text: line.slice(j, j + q.length), hit: true });
      i = j + q.length;
    }
    if (i < line.length) out.push({ text: line.slice(i), hit: false });
    return out;
  }

  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  async function copyBody() {
    try {
      await navigator.clipboard.writeText(prettyBody);
      copied = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  }

  const r = $derived(ws.response);
  const failed = $derived(ws.tests.filter((t) => !t.passed).length);
  const hasScripts = $derived(
    ws.tests.length > 0 || ws.logs.length > 0 || ws.scriptError !== null
  );

  function statusColor(s: number): string {
    if (s === 0) return "text-fg-subtle";
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
  const bodyLines = $derived(prettyBody.split("\n"));

  // Rich preview for HTML / image responses (toggle to source for HTML).
  let preview = $state(true);
  const ct = $derived(r?.contentType ?? "");
  const isHtml = $derived(ct.includes("html"));
  const isImage = $derived(ct.startsWith("image/") && !!r?.bodyBase64);
  const imageSrc = $derived(isImage ? `data:${ct};base64,${r!.bodyBase64}` : "");

  // Response → variable: extract a value by dotted/bracket path and save it to a var, so the
  // next request can use {{name}} — chaining without writing a post-response script.
  const json = $derived.by<unknown>(() => {
    if (!r) return null;
    try {
      return JSON.parse(r.bodyText);
    } catch {
      return null;
    }
  });
  function getPath(obj: unknown, path: string): unknown {
    const keys = path
      .replace(/\[(\d+)\]/g, ".$1")
      .split(".")
      .filter(Boolean);
    let cur: unknown = obj;
    for (const k of keys) cur = (cur as Record<string, unknown>)?.[k];
    return cur;
  }
  let xPath = $state("");
  let xVar = $state("");
  let xSaved = $state(false);
  const xValue = $derived(xPath.trim() ? getPath(json, xPath.trim()) : undefined);
  async function extract() {
    if (!xVar.trim() || xValue === undefined) return;
    await ws.setVariable(
      xVar.trim(),
      typeof xValue === "object" ? JSON.stringify(xValue) : String(xValue)
    );
    xSaved = true;
    setTimeout(() => (xSaved = false), 1200);
  }

  function fmtSize(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }

  // --- timing waterfall ---
  type Timings = NonNullable<ResponseResult["timings"]>;
  const PHASES = [
    { key: "dns", label: "DNS", color: "#60a5fa" },
    { key: "tcp", label: "TCP", color: "#a78bfa" },
    { key: "tls", label: "TLS", color: "#fbbf24" },
    { key: "firstByte", label: "Wait", color: "var(--color-brand)" },
    { key: "total", label: "Download", color: "#34d399" },
  ] as const;

  function segments(t: Timings | undefined): { label: string; ms: number; color: string }[] {
    if (!t) return [];
    let prev = t.queuing ?? 0;
    const out: { label: string; ms: number; color: string }[] = [];
    for (const ph of PHASES) {
      const cur = t[ph.key];
      if (typeof cur !== "number") continue;
      const ms = cur - prev;
      if (ms > 0.05) out.push({ label: ph.label, ms, color: ph.color });
      prev = Math.max(prev, cur);
    }
    return out;
  }

  const totalMs = (h: { timings?: Timings; durationMs: number }) =>
    h.timings?.total ?? h.durationMs;

  const avg = $derived(
    ws.reqHistory.length
      ? Math.round(
          ws.reqHistory.reduce((s, h) => s + h.durationMs, 0) / ws.reqHistory.length
        )
      : null
  );
  const maxTotal = $derived(Math.max(1, ...ws.reqHistory.map(totalMs)));

  function ago(ts: number): string {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  }
</script>

{#snippet bar(t: Timings | undefined, h: number)}
  {@const segs = segments(t)}
  {@const tot = segs.reduce((s, x) => s + x.ms, 0) || 1}
  <div class="flex overflow-hidden rounded" style="height:{h}px; width:100%">
    {#each segs as s (s.label)}
      <div
        style="width:{((s.ms / tot) * 100).toFixed(2)}%; background:{s.color}"
        title="{s.label} {s.ms.toFixed(0)}ms"
      ></div>
    {/each}
  </div>
{/snippet}

<section class="flex h-full flex-col bg-[var(--color-bg-0)]">
  {#if ws.errorMsg}
    <div class="m-3 rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
      {ws.errorMsg}
    </div>
  {/if}

  {#if !r}
    <div class="grid flex-1 place-items-center text-sm text-fg-faint">
      Send a request to see the response.
    </div>
  {:else}
    <div
      class="flex items-center gap-4 border-b border-border px-4 py-2 text-sm"
    >
      <span class="mono font-bold {statusColor(r.status)}">
        {r.status || "—"}
        {r.statusText}
      </span>
      <span class="text-fg-subtle">{r.durationMs} ms</span>
      <span class="text-fg-subtle">{fmtSize(r.size)}</span>
      {#if r.error}
        <span class="text-red-400">{r.error.message}</span>
      {/if}
      {#if ws.unresolved.length}
        <span class="text-amber-400" title="unresolved variables">
          ⚠ {ws.unresolved.join(", ")}
        </span>
      {/if}
      <Button
        onclick={copyBody}
        variant="outline"
        size="xs"
        class="ml-auto"
        title="Copy response body">{copied ? "Copied ✓" : "Copy"}</Button
      >
      {#if prettyBody}
        <Button onclick={saveToFile} variant="outline" size="xs" title="Save response body to a file"
          >{saved ? "Saved ✓" : "Save"}</Button
        >
      {/if}
    </div>

    <div class="flex gap-1 border-b border-border px-3 py-1 text-sm">
      {#each ["body", "headers", "timings"] as const as t (t)}
        <button
          onclick={() => (tab = t)}
          class="tab"
          class:is-active={tab === t}>{t}</button
        >
      {/each}
      {#if hasScripts}
        <button
          onclick={() => (tab = "tests")}
          class="tab"
          class:is-active={tab === "tests"}
        >
          tests
          {#if failed}<span class="ml-1 text-red-400">{failed}✗</span>{:else if ws.tests.length}<span class="ml-1 text-emerald-400">✓</span>{/if}
        </button>
      {/if}
    </div>

    <div class="flex-1 overflow-auto p-3">
      {#if tab === "body"}
        {#if r.meta}
          <div class="mb-2 flex flex-wrap gap-2 text-xs text-fg-muted">
            {#each Object.entries(r.meta) as [k, v] (k)}
              {#if typeof v === "number" || typeof v === "string"}
                <span class="rounded bg-[var(--color-bg-2)] px-2 py-0.5"
                  ><b class="text-fg"
                    >{typeof v === "number" ? Math.round(v * 10) / 10 : v}</b
                  > {k}</span
                >
              {/if}
            {/each}
          </div>
        {/if}
        {#if isHtml}
          <div class="mb-2 flex gap-1">
            <button class="seg" class:is-active={preview} onclick={() => (preview = true)}
              >preview</button
            >
            <button class="seg" class:is-active={!preview} onclick={() => (preview = false)}
              >source</button
            >
          </div>
        {/if}
        {#if isImage}
          <div class="grid place-items-center p-4">
            <img
              src={imageSrc}
              alt="response"
              class="max-h-[60vh] max-w-full rounded border border-border"
            />
          </div>
        {:else if isHtml && preview}
          <iframe
            srcdoc={r.bodyText}
            sandbox=""
            title="HTML preview"
            class="h-[60vh] w-full rounded border border-border bg-white"
          ></iframe>
        {:else}
          {#if prettyBody}
            <div class="mb-2 flex items-center gap-2">
              <Input bind:value={bodyQuery} placeholder="Search in body…" class="h-6 flex-1" />
            {#if bodyQuery.trim()}
              <span class="hint shrink-0">{matchCount} match{matchCount === 1 ? "" : "es"}</span>
            {/if}
          </div>
        {/if}
        {#if json}
          <div class="mb-2 flex items-center gap-2">
            <Input bind:value={xPath} placeholder="path e.g. data.token" class="mono h-6 flex-1" />
            <span class="text-fg-faint">→</span>
            <Input bind:value={xVar} placeholder="var name" class="mono h-6 w-32" />
            <Button
              onclick={extract}
              variant="outline"
              size="xs"
              disabled={!xVar.trim() || xValue === undefined}
              title="Save the value at that path as a variable for chaining"
              >{xSaved ? "Saved ✓" : "Save var"}</Button
            >
            {#if xPath.trim()}
              <span class="hint max-w-[28%] shrink-0 truncate" title={String(xValue)}>
                {xValue === undefined ? "no match" : `= ${String(xValue)}`}
              </span>
            {/if}
          </div>
        {/if}
        {#if matches}
          {#if matches.length === 0}
            <div class="hint p-4 text-center">No matches.</div>
          {:else}
            <div class="flex text-xs">
              <div
                class="mono sticky left-0 shrink-0 border-r border-border bg-[var(--color-bg-0)] pr-2 pl-1 text-right text-fg-faint select-none"
                aria-hidden="true"
              >
                {#each matches as m (m.n)}<div class="leading-5">{m.n}</div>{/each}
              </div>
              <pre class="mono flex-1 pl-2 leading-5 whitespace-pre text-fg">{#each matches as m (m.n)}<div>{#each splitLine(m.line) as p}{#if p.hit}<mark class="rounded-sm bg-[var(--color-brand)]/30 text-fg-strong">{p.text}</mark>{:else}{p.text}{/if}{/each}</div>{/each}</pre>
            </div>
          {/if}
        {:else}
          <div class="flex text-xs">
            <div
              class="mono sticky left-0 shrink-0 border-r border-border bg-[var(--color-bg-0)] pr-2 pl-1 text-right text-fg-faint select-none"
              aria-hidden="true"
            >
              {#each bodyLines as _, i (i)}<div class="leading-5">{i + 1}</div>{/each}
            </div>
            <pre class="mono flex-1 pl-2 leading-5 whitespace-pre text-fg">{prettyBody}</pre>
          </div>
          {/if}
        {/if}
      {:else if tab === "headers"}
        <table class="mono w-full text-xs">
          <tbody>
            {#each Object.entries(r.headers) as [k, v] (k)}
              <tr class="border-b border-[var(--color-bg-2)]">
                <td class="py-1 pr-4 text-fg-muted">{k}</td>
                <td class="py-1 break-all text-fg">{v}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else if tab === "timings"}
        <div class="flex flex-col gap-4">
          <div>
            <div class="mb-1.5 flex items-center gap-3 text-xs">
              {#if avg !== null}
                <span class="rounded bg-[var(--color-bg-2)] px-2 py-0.5 text-fg-muted">
                  endpoint avg <b class="text-fg-strong">{avg}ms</b>
                  <span class="text-fg-faint">· {ws.reqHistory.length} runs</span>
                </span>
              {/if}
              <span class="text-fg-subtle">this run {totalMs(r).toFixed(0)}ms</span>
            </div>
            {@render bar(r.timings, 18)}
            <div class="mt-2 flex flex-wrap gap-3 text-xs text-fg-muted">
              {#each segments(r.timings) as s (s.label)}
                <span class="flex items-center gap-1">
                  <span class="inline-block h-2 w-2 rounded-sm" style="background:{s.color}"></span>
                  {s.label} {s.ms.toFixed(0)}ms
                </span>
              {/each}
            </div>
          </div>

          {#if ws.reqHistory.length > 1}
            <div>
              <div class="label mb-1.5">
                Recent runs
              </div>
              <div class="flex flex-col gap-1">
                {#each ws.reqHistory.slice(0, 15) as h (h.id)}
                  <div class="flex items-center gap-2 text-xs">
                    <span class="mono w-14 shrink-0 text-fg-subtle"
                      >{totalMs(h).toFixed(0)}ms</span
                    >
                    <div class="flex-1">
                      <div style="width:{((totalMs(h) / maxTotal) * 100).toFixed(1)}%">
                        {@render bar(h.timings, 9)}
                      </div>
                    </div>
                    <span class="w-10 shrink-0 text-right text-fg-faint">{ago(h.ts)}</span>
                  </div>
                {/each}
              </div>
            </div>
          {/if}
        </div>
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
                  <span class="text-fg">{t.name}</span>
                  {#if !t.passed && t.error}<span class="text-red-400/80">— {t.error}</span>{/if}
                </div>
              {/each}
            </div>
          {/if}
          {#if ws.logs.length}
            <div>
              <div class="label mb-1">console</div>
              <pre class="mono whitespace-pre-wrap text-fg-muted">{ws.logs.join("\n")}</pre>
            </div>
          {/if}
          {#if !ws.tests.length && !ws.logs.length && !ws.scriptError}
            <p class="text-fg-faint">No script output.</p>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</section>
