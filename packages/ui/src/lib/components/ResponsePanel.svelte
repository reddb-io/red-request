<script lang="ts">
  import { ws } from "../store.svelte";
  import type { ResponseResult } from "@reddb-io/request-core";
  import { detectBodyMode } from "@reddb-io/request-core";
  import { Button } from "./ui/button/index.js";
  import { Input } from "./ui/input/index.js";
  import JsonTree from "./JsonTree.svelte";
  import XmlTree from "./XmlTree.svelte";
  import HexViewer from "./HexViewer.svelte";
  import TlsPanel from "./TlsPanel.svelte";
  import { save } from "@tauri-apps/plugin-dialog";
  import * as fs from "../fs";
  import { buildResponseInsights } from "../responseInsights";

  let tab = $state<
    "body" | "request" | "insights" | "timings" | "tls" | "tests"
  >("body");
  let bodyQuery = $state("");
  // Response headers now live in a collapsible accordion at the top of the body tab, so the
  // body gets the full panel when collapsed. Persists across responses.
  let headersOpen = $state(true);
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

  const r = $derived(ws.exampleView ?? ws.response);
  let exName = $state("");
  async function doSaveExample() {
    await ws.saveExample(exName);
    exName = "";
  }
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

  // Response → variable: extract a value by dotted/bracket path and save it to a var, so the
  // next request can use {{name}} — chaining without writing a post-response script.
  type ParsedJson = { ok: true; value: unknown } | { ok: false };
  const parsedJson = $derived.by<ParsedJson>(() => {
    if (!r) return { ok: false };
    try {
      return { ok: true, value: JSON.parse(r.bodyText) };
    } catch {
      return { ok: false };
    }
  });
  const json = $derived(parsedJson.ok ? parsedJson.value : null);

  const prettyBody = $derived.by(() => {
    if (!r) return "";
    const ct = r.contentType ?? "";
    if (ct.includes("json") && parsedJson.ok) {
      return JSON.stringify(parsedJson.value, null, 2);
    }
    return r.bodyText;
  });
  const bodyLines = $derived(prettyBody.split("\n"));

  // Body zoom: bump the font size of the rendered body (raw text, tree views, search hits) so
  // it stays readable when sharing a screen. Shared inline style keeps the line-number gutter
  // aligned with the <pre>. Persists across responses; reset returns to the default.
  const DEFAULT_FONT_PX = 12;
  let bodyFontPx = $state(DEFAULT_FONT_PX);
  function zoom(delta: number) {
    bodyFontPx = Math.min(28, Math.max(8, bodyFontPx + delta));
  }
  const bodyStyle = $derived(
    `font-size:${bodyFontPx}px; line-height:${Math.round(bodyFontPx * 1.5)}px`
  );
  // Soft-wrap long body lines. Wrapping drops the line-number gutter (numbers can't track a
  // logical line once it spills onto several visual rows) and breaks anywhere to stay in view.
  let bodyWrap = $state(false);
  const preWrap = $derived(bodyWrap ? "whitespace-pre-wrap break-all" : "whitespace-pre");

  // XML tree: parse once with DOMParser so structured XML bodies get the same collapsible
  // chevrons as JSON. Returns the document element, or null on non-XML / parse errors.
  const parsedXmlRoot = $derived.by<Element | null>(() => {
    if (!r) return null;
    const ct = r.contentType ?? "";
    if (!ct.includes("xml")) return null;
    try {
      const doc = new DOMParser().parseFromString(r.bodyText, "application/xml");
      if (doc.getElementsByTagName("parsererror").length > 0) return null;
      return doc.documentElement;
    } catch {
      return null;
    }
  });
  const isXml = $derived(parsedXmlRoot !== null);
  let xmlView = $state<"raw" | "tree">("raw");

  // Rich preview for HTML / image responses (toggle to source for HTML).
  let preview = $state(true);
  const ct = $derived(r?.contentType ?? "");
  const isHtml = $derived(ct.includes("html"));
  const isImage = $derived(ct.startsWith("image/") && !!r?.bodyBase64);
  const imageSrc = $derived(isImage ? `data:${ct};base64,${r!.bodyBase64}` : "");

  // text/hex toggle for the active response body. detectBodyMode() decides the default:
  // binary payloads open in hex, text/JSON payloads open in text view. The user can still
  // flip the toggle manually via viewOverride. `viewOverride` resets on each new response
  // (see $effect below) so each response falls back to its own auto-detected default.
  const autoMode = $derived(
    r
      ? detectBodyMode({
          contentType: r.contentType,
          bodyBase64: r.bodyBase64,
          bodyText: r.bodyText,
        })
      : "text"
  );
  let viewOverride = $state<"text" | "hex" | null>(null);
  const bodyView = $derived<"text" | "hex">(
    viewOverride ?? (autoMode === "binary" ? "hex" : "text")
  );
  // Bytes for the hex view: prefer the raw binary payload, else the UTF-8 of the text body.
  const hexBytes = $derived(
    r?.bodyBase64 ? undefined : new TextEncoder().encode(r?.bodyText ?? "")
  );
  // Drop a manual text/hex choice when the active response changes, so each response falls
  // back to its own default (hex for binary, text otherwise).
  $effect(() => {
    void r;
    viewOverride = null;
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
  let jsonView = $state<"raw" | "tree">("raw");
  // Whichever structured format is showing its collapsible tree (hides raw-only controls).
  const showingTree = $derived(
    (!!json && jsonView === "tree") || (isXml && xmlView === "tree")
  );
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
    { key: "proxyConnect", label: "Proxy", color: "#fb923c" },
    { key: "proxyTls", label: "Proxy TLS", color: "#f97316" },
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

  const insights = $derived(r ? buildResponseInsights(r) : []);

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

  {#if ws.sending}
    <div class="grid flex-1 place-items-center gap-3 text-fg-faint">
      <span
        class="h-7 w-7 animate-spin rounded-full border-2 border-border border-t-[var(--color-brand)]"
      ></span>
      <span class="text-sm">Sending…</span>
    </div>
  {:else if !r}
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
        {@const failed = ws.unresolved.filter((n) =>
          ws.secretDecryptFailures.includes(n)
        )}
        <span
          class="text-amber-400"
          title={failed.length
            ? `couldn't open RedDB secret(s): ${failed.join(", ")} — re-enter them in this environment or check the embedded vault/config state`
            : "unresolved variables"}
        >
          ⚠ {ws.unresolved.join(", ")}{failed.length ? " 🔒" : ""}
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
      {#if ws.response && !ws.exampleView}
        <Button
          onclick={doSaveExample}
          variant="outline"
          size="xs"
          title="Save this response as an example on the request">+ Example</Button
        >
      {/if}
    </div>
    {#if ws.exampleView}
      <div
        class="flex items-center gap-2 border-b border-border bg-[var(--color-bg-1)] px-3 py-1 text-xs text-fg-muted"
      >
        <span class="text-[var(--color-brand)]">● viewing saved example</span>
        <button class="ml-auto underline hover:text-fg" onclick={() => ws.viewExample(null)}
          >back to live</button
        >
      </div>
    {/if}
    {#if ws.activeReq?.examples?.length}
      <div class="flex flex-wrap items-center gap-1 border-b border-border px-3 py-1.5">
        <span class="hint mr-1">examples:</span>
        {#each ws.activeReq.examples as ex (ex.id)}
          <span
            class="group/ex inline-flex items-center gap-1 rounded border border-border bg-[var(--color-bg-2)] px-1.5 py-0.5 text-xs"
          >
            <button class="hover:text-[var(--color-brand)]" onclick={() => ws.viewExample(ex)}
              title={`${ex.status} · ${ex.name}`}>{ex.name}</button
            >
            <button
              class="text-fg-faint opacity-0 group-hover/ex:opacity-100 hover:text-red-400"
              title="delete example"
              onclick={() => ws.deleteExample(ex.id)}>✕</button
            >
          </span>
        {/each}
      </div>
    {/if}

    <div class="flex min-h-0 flex-1 overflow-hidden">
      <div
        class="flex shrink-0 flex-col gap-0.5 border-r border-border px-1.5 py-2 text-sm"
      >
        <span class="px-1.5 pb-0.5 text-[10px] font-medium tracking-wide text-fg-faint uppercase">Request</span>
        <button
          onclick={() => (tab = "request")}
          class="tab w-full rounded text-left"
          class:is-active={tab === "request"}
          title="The request as actually sent — headers, auth, body; vars resolved, secrets redacted"
          >request</button
        >
        <span class="mt-2 px-1.5 pb-0.5 text-[10px] font-medium tracking-wide text-fg-faint uppercase">Response</span>
        {#each ["body", "insights", "timings"] as const as t (t)}
          <button
            onclick={() => (tab = t)}
            class="tab w-full rounded text-left"
            class:is-active={tab === t}>{t}</button
          >
        {/each}
      <button
        onclick={() => (tab = "tls")}
        class="tab w-full rounded text-left"
        class:is-active={tab === "tls"}
        title="TLS / encryption details"
      >
        {#if r.meta?.tls}
          <span class="mr-1 text-emerald-400">&#x25CF;</span>
        {/if}tls</button
      >
      {#if hasScripts}
        <button
          onclick={() => (tab = "tests")}
          class="tab w-full rounded text-left"
          class:is-active={tab === "tests"}
        >
          tests
          {#if failed}<span class="ml-1 text-red-400">{failed}✗</span>{:else if ws.tests.length}<span class="ml-1 text-emerald-400">✓</span>{/if}
        </button>
      {/if}
    </div>

    <div class="flex-1 overflow-auto p-3">
      {#if tab === "body"}
        {@const headerCount = Object.keys(r.headers).length}
        {#if headerCount}
          <div class="mb-2 rounded border border-border">
            <button
              onclick={() => (headersOpen = !headersOpen)}
              class="flex w-full items-center gap-2 px-2 py-1 text-xs text-fg-muted hover:text-fg"
              title="Response headers"
            >
              <span class="text-fg-subtle">{headersOpen ? "▾" : "▸"}</span>
              <span class="label">Headers</span>
              <span class="hint">{headerCount}</span>
            </button>
            {#if headersOpen}
              <div class="max-h-48 overflow-auto border-t border-border px-2 py-1">
                <table class="mono w-full text-xs">
                  <tbody>
                    {#each Object.entries(r.headers) as [k, v] (k)}
                      <tr class="border-b border-[var(--color-bg-2)]">
                        <td class="py-1 pr-4 align-top text-fg-muted">{k}</td>
                        <td class="py-1 break-all text-fg">{v}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {/if}
          </div>
        {/if}
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
        {#if (r.bodyText || r.bodyBase64) && !isImage}
          <div class="mb-2 flex gap-1">
            <button class="seg" class:is-active={bodyView === "text"} onclick={() => (viewOverride = "text")}
              >text</button
            >
            <button class="seg" class:is-active={bodyView === "hex"} onclick={() => (viewOverride = "hex")}
              >hex</button
            >
          </div>
        {/if}
        {#if isHtml && bodyView === "text"}
          <div class="mb-2 flex gap-1">
            <button class="seg" class:is-active={preview} onclick={() => (preview = true)}
              >preview</button
            >
            <button class="seg" class:is-active={!preview} onclick={() => (preview = false)}
              >source</button
            >
          </div>
        {/if}
        {#if bodyView === "hex" && !isImage}
          <HexViewer bytes={hexBytes} base64={r.bodyBase64} />
        {:else if isImage}
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
              {#if json}
                <div class="flex gap-1">
                  <button class="seg" class:is-active={jsonView === "raw"} onclick={() => (jsonView = "raw")}
                    >raw</button
                  >
                  <button class="seg" class:is-active={jsonView === "tree"} onclick={() => (jsonView = "tree")}
                    >tree</button
                  >
                </div>
              {:else if isXml}
                <div class="flex gap-1">
                  <button class="seg" class:is-active={xmlView === "raw"} onclick={() => (xmlView = "raw")}
                    >raw</button
                  >
                  <button class="seg" class:is-active={xmlView === "tree"} onclick={() => (xmlView = "tree")}
                    >tree</button
                  >
                </div>
              {/if}
              {#if !showingTree}
                <Input bind:value={bodyQuery} placeholder="Search in body…" class="h-6 flex-1" />
                {#if bodyQuery.trim()}
                  <span class="hint shrink-0">{matchCount} match{matchCount === 1 ? "" : "es"}</span>
                {/if}
              {/if}
              {#if !showingTree}
                <label
                  class="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-fg-muted"
                  title="Soft-wrap long lines (hides line numbers while on)"
                >
                  <input type="checkbox" bind:checked={bodyWrap} class="accent-accent" /> wrap
                </label>
              {/if}
              <div class="flex shrink-0 items-center gap-1 {showingTree ? 'ml-auto' : ''}">
                <button class="seg" title="Zoom out" aria-label="Zoom out" onclick={() => zoom(-1)}>A−</button>
                <button
                  class="seg tabular-nums"
                  title="Reset zoom"
                  aria-label="Reset zoom"
                  onclick={() => (bodyFontPx = DEFAULT_FONT_PX)}>{bodyFontPx}px</button
                >
                <button class="seg" title="Zoom in" aria-label="Zoom in" onclick={() => zoom(1)}>A+</button>
              </div>
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
        {#if json && jsonView === "tree"}
          <div class="overflow-auto pl-1" style={bodyStyle}>
            <JsonTree data={json} onpick={(p) => (xPath = p)} />
          </div>
        {:else if isXml && xmlView === "tree"}
          <div class="overflow-auto pl-1" style={bodyStyle}>
            <XmlTree node={parsedXmlRoot!} />
          </div>
        {:else}
        {#if matches}
          {#if matches.length === 0}
            <div class="hint p-4 text-center">No matches.</div>
          {:else}
            <div class="flex" style={bodyStyle}>
              {#if !bodyWrap}
                <div
                  class="mono sticky left-0 shrink-0 border-r border-border bg-[var(--color-bg-0)] pr-2 pl-1 text-right text-fg-faint select-none"
                  aria-hidden="true"
                >
                  {#each matches as m (m.n)}<div>{m.n}</div>{/each}
                </div>
              {/if}
              <pre class="mono flex-1 pl-2 {preWrap} text-fg">{#each matches as m (m.n)}<div>{#each splitLine(m.line) as p}{#if p.hit}<mark class="rounded-sm bg-[var(--color-brand)]/30 text-fg-strong">{p.text}</mark>{:else}{p.text}{/if}{/each}</div>{/each}</pre>
            </div>
          {/if}
        {:else}
          <div class="flex" style={bodyStyle}>
            {#if !bodyWrap}
              <div
                class="mono sticky left-0 shrink-0 border-r border-border bg-[var(--color-bg-0)] pr-2 pl-1 text-right text-fg-faint select-none"
                aria-hidden="true"
              >
                {#each bodyLines as _, i (i)}<div>{i + 1}</div>{/each}
              </div>
            {/if}
            <pre class="mono flex-1 pl-2 {preWrap} text-fg">{prettyBody}</pre>
          </div>
          {/if}
        {/if}
        {/if}
      {:else if tab === "request"}
        {#if ws.renderedRequest}
          {@const rr = ws.renderedRequest}
          <div class="flex flex-col gap-3 text-xs">
            <div class="flex items-center gap-2">
              <span
                class="mono rounded bg-[var(--color-bg-2)] px-2 py-0.5 font-bold text-fg-strong"
                >{rr.method}</span
              >
              <span class="mono break-all text-fg">{rr.url}</span>
            </div>
            {#each [{ label: "headers", items: rr.headers.filter((h) => h.enabled) }, { label: "query", items: rr.query.filter((q) => q.enabled) }] as grp (grp.label)}
              {#if grp.items.length}
                <div>
                  <div class="label mb-1">{grp.label}</div>
                  <table class="mono w-full">
                    <tbody>
                      {#each grp.items as kv (kv.name)}
                        <tr class="border-b border-[var(--color-bg-2)]">
                          <td class="py-1 pr-4 text-fg-muted">{kv.name}</td>
                          <td class="py-1 break-all text-fg">{kv.value}</td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              {/if}
            {/each}
            {#if rr.body?.content?.trim()}
              <div>
                <div class="label mb-1">body</div>
                <pre
                  class="mono rounded bg-[var(--color-bg-1)] p-2 break-all whitespace-pre-wrap text-fg">{rr.body
                    .content}</pre>
              </div>
            {/if}
            <p class="text-fg-faint">Secret values are redacted (••••••).</p>
          </div>
        {:else}
          <div class="text-fg-faint">Send the request to see what was sent.</div>
        {/if}
      {:else if tab === "insights"}
        <div class="grid gap-2 text-xs">
          {#each insights as insight (insight.title)}
            <div
              class="rounded border border-border bg-[var(--color-bg-1)] p-3"
              class:border-amber-500={insight.tone === "warn"}
              class:border-red-500={insight.tone === "bad"}
              class:border-emerald-500={insight.tone === "good"}
            >
              <div class="flex items-start gap-3">
                <div>
                  <div class="label mb-1">{insight.title}</div>
                  <div class="break-all text-fg">{insight.detail}</div>
                </div>
                {#if insight.value}
                  <div class="mono ml-auto shrink-0 rounded bg-[var(--color-bg-2)] px-2 py-0.5 text-fg-muted">
                    {insight.value}
                  </div>
                {/if}
              </div>
            </div>
          {/each}
          <div class="rounded border border-border bg-[var(--color-bg-1)] p-3 text-fg-muted">
            Request-phase diagnostics use the data this run already exposed. Hop-by-hop
            traceroute/MTR is not inferred here.
          </div>
        </div>
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
      {:else if tab === "tls"}
        <TlsPanel response={r} />
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
    </div>
  {/if}
</section>
