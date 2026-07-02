<script lang="ts">
  import type { Component } from "svelte";
  import { ws } from "../store.svelte";
  import { proxyToUrl } from "@reddb-io/request-core";
  import { HTTP_METHODS, REQUEST_KINDS } from "@reddb-io/request-core/constants";
  import KeyValueEditor from "./KeyValueEditor.svelte";
  import AuthEditor from "./AuthEditor.svelte";
  import EnvBar from "./EnvBar.svelte";
  import ProtocolForm from "./ProtocolForm.svelte";
  import WebSocketPanel from "./WebSocketPanel.svelte";
  import GrpcPanel from "./GrpcPanel.svelte";
  import HistoryTimeline from "./HistoryTimeline.svelte";
  import VarField from "./VarField.svelte";
  import Select from "./ui/Select.svelte";
  import Tooltip from "./ui/Tooltip.svelte";
  import { appLog } from "../log";
  import { Button } from "./ui/button/index.js";
  import { Textarea } from "./ui/textarea/index.js";

  let showRunner = $state(false);
  let showCode = $state(false);
  let showSchema = $state(false);
  type ModalComponent = Component<{ onClose: () => void }>;
  let RunnerPanelComponent = $state<ModalComponent | null>(null);
  let CodeModalComponent = $state<ModalComponent | null>(null);
  let GraphQlSchemaComponent = $state<ModalComponent | null>(null);
  let gqlTab = $state<"query" | "variables">("query");
  // Soft-wrap long lines in the body editor (drops the line-number gutter while on).
  let bodyWrap = $state(false);

  function reportLazyLoadFailure(label: string, error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    ws.errorMsg = `Could not load ${label}. Try again.`;
    appLog("error", `lazy load ${label} failed: ${detail}`);
  }

  async function openRunner() {
    if (!RunnerPanelComponent) {
      try {
        RunnerPanelComponent = (await import("./RunnerPanel.svelte")).default;
      } catch (error) {
        reportLazyLoadFailure("Run", error);
        return;
      }
    }
    showRunner = true;
  }

  async function openCode() {
    if (!CodeModalComponent) {
      try {
        CodeModalComponent = (await import("./CodeModal.svelte")).default;
      } catch (error) {
        reportLazyLoadFailure("Code", error);
        return;
      }
    }
    showCode = true;
  }

  async function openSchema() {
    if (!GraphQlSchemaComponent) {
      try {
        GraphQlSchemaComponent = (await import("./GraphQlSchema.svelte")).default;
      } catch (error) {
        reportLazyLoadFailure("GraphQL schema", error);
        return;
      }
    }
    showSchema = true;
  }

  // Lazy-loaded tab bodies. Run / Code used to open as modals; they're now sibling
  // tabs so the user doesn't lose request context when configuring them. Cast to
  // Component<any> because Runner/Code expect onClose prop in modal mode but we
  // render them in-place (no close button needed).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let RunnerTabComponent = $state<Component<any> | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let CodeTabComponent = $state<Component<any> | null>(null);
  async function ensureRunnerLoaded() {
    if (RunnerTabComponent) return true;
    try {
      RunnerTabComponent = (await import("./RunnerPanel.svelte")).default;
      return true;
    } catch (error) {
      reportLazyLoadFailure("Run", error);
      return false;
    }
  }
  async function ensureCodeLoaded() {
    if (CodeTabComponent) return true;
    try {
      CodeTabComponent = (await import("./CodeModal.svelte")).default;
      return true;
    } catch (error) {
      reportLazyLoadFailure("Code", error);
      return false;
    }
  }

  const gqlVarsError = $derived.by(() => {
    if (ws.activeReq?.body.type !== "graphql") return null;
    const v = ws.activeReq.body.variables;
    if (!v || !v.trim() || v.trim() === "{}") return null;
    try { JSON.parse(v); return null; } catch { return "Invalid JSON"; }
  });

  function prettifyVars() {
    const req = ws.activeReq;
    if (!req) return;
    try {
      req.body.variables = JSON.stringify(JSON.parse(req.body.variables ?? "{}"), null, 2);
    } catch { /* not valid JSON — leave untouched */ }
  }

  // Ensure variables field is initialised for loaded graphql requests.
  $effect(() => {
    if (ws.activeReq?.body.type === "graphql") {
      ws.activeReq.body.variables ??= "{}";
    }
  });

  const methods = HTTP_METHODS;
  const kinds = REQUEST_KINDS;
  const methodColor: Record<string, string> = {
    GET: "text-emerald-400",
    POST: "text-amber-400",
    PUT: "text-blue-400",
    PATCH: "text-purple-400",
    DELETE: "text-red-400",
    HEAD: "text-fg-muted",
    OPTIONS: "text-fg-muted",
  };
  type Tab =
    | "params"
    | "headers"
    | "auth"
    | "body"
    | "scripts"
    | "run"
    | "code"
    | "history"
    | "settings"
    | "config";
  let tab = $state<Tab>("params");
  // Order is user-facing: most-edited → orchestration → outcomes → per-request knobs.
  const httpTabs: Tab[] = [
    "params",
    "headers",
    "auth",
    "body",
    "scripts",
    "run",
    "code",
    "history",
    "settings",
  ];
  const netTabs: Tab[] = ["config", "scripts", "history"];
  const tabs = $derived(ws.activeReq?.kind === "http" ? httpTabs : netTabs);
  $effect(() => {
    if (!tabs.includes(tab)) tab = tabs[0]!;
  });
  const bodyTypes = ["none", "json", "raw", "form", "xml", "graphql"] as const;
  const CUSTOM_PROXY = "__custom_proxy__";
  const identityCapable = $derived(
    ws.activeReq?.kind === "http" ||
      ws.activeReq?.kind === "ws" ||
      ws.activeReq?.kind === "sse" ||
      ws.activeReq?.kind === "grpc"
  );

  const activeProfileProxy = $derived(ws.activeProfileProxy);
  const activeRequestProxySelection = $derived.by(() => {
    const proxyUrl = ws.activeReq?.proxy?.trim() ?? "";
    if (!proxyUrl) return "";
    const match = ws.proxies.find((p) => proxyToUrl(p) === proxyUrl);
    return match?.id ?? CUSTOM_PROXY;
  });

  const proxyOptions = $derived([
    { value: "", label: "Direct connection" },
    ...ws.proxies.map((p) => ({
      value: p.id,
      label: p.name || `${p.type}://${p.host}:${p.port}` || "Proxy",
    })),
    { value: CUSTOM_PROXY, label: "Custom URL" },
  ]);

  function setRequestProxySelection(value: string) {
    const req = ws.activeReq;
    if (!req) return;
    if (activeProfileProxy) return;
    if (!value) {
      req.proxy = undefined;
      return;
    }
    if (value === CUSTOM_PROXY) {
      req.proxy = req.proxy?.trim() ? req.proxy : "http://127.0.0.1:8080";
      return;
    }
    const proxy = ws.proxies.find((p) => p.id === value);
    if (proxy) req.proxy = proxyToUrl(proxy);
  }

  // Pretty-print the body (JSON / GraphQL payloads); leaves content as-is if it doesn't parse.
  const canPrettify = $derived(ws.activeReq?.body.type === "json");
  function prettify() {
    const req = ws.activeReq;
    if (!req) return;
    try {
      req.body.content = JSON.stringify(JSON.parse(req.body.content), null, 2);
    } catch {
      /* not valid JSON — leave the content untouched */
    }
  }

  // Path params auto-detected from `:name` segments in the URL.
  const detected = $derived(
    ws.activeReq
      ? [
          ...new Set(
            [...ws.activeReq.url.matchAll(/:([A-Za-z_][\w-]*)/g)].map((m) => m[1]!)
          ),
        ]
      : []
  );
  // Ensure a pathParams entry exists for each detected name (keeps typed values).
  $effect(() => {
    const req = ws.activeReq;
    if (!req) return;
    for (const name of detected) {
      if (!req.pathParams.some((p) => p.name === name)) {
        req.pathParams.push({ name, value: "", enabled: true });
      }
    }
  });

  // Resync profile → headers whenever:
  //   • the bound profile id changes (request-level profileId, falls back to
  //     the collection default), or
  //   • the profile's own header/UA list changes (user edits the profile).
  // Track profile content (not just id) so editing the profile mid-session
  // propagates to any request that references it.
  // NOTE: the chain uses `(profile?.headers ?? [])` — `profile?.headers` alone
  // is undefined when no profile is bound, and `.map()` on undefined throws,
  // which used to break the effect and freeze the panel.
  $effect(() => {
    const req = ws.activeReq;
    if (!req) return;
    const pid = req.profileId || ws.activeCollection?.collection.defaultProfileId || "";
    const profile = pid ? ws.profiles.find((p) => p.id === pid) : undefined;
    // Touch profile.userAgent + headers so this effect re-runs on edits.
    void profile?.userAgent;
    void profile?.headers.length;
    void (profile?.headers ?? []).map((h) => `${h.name}=${h.value}=${h.enabled}`).join("|");
    ws.syncProfileHeaders();
  });

  // Path params with a value count as "resolved" (green); detected-but-empty stay red.
  const pathOk = $derived(
    (ws.activeReq?.pathParams ?? [])
      .filter((p) => p.enabled && p.value.trim() !== "")
      .map((p) => p.name)
  );
  const pathValues = $derived(
    Object.fromEntries(
      (ws.activeReq?.pathParams ?? []).map((p) => [p.name, p.value])
    )
  );

</script>

{#if ws.activeReq}
  <section class="flex h-full flex-col border-r border-border bg-[var(--color-bg-1)]">
    <div class="flex items-center gap-2 border-b border-border px-3 py-2">
      <input
        bind:value={ws.activeReq.name}
        class="flex-1 bg-transparent text-sm font-medium text-fg outline-none"
      />
      <!-- Folder picker: only meaningful when the collection actually has folders,
           so hide the otherwise-confusing "(root)"-only dropdown. -->
      {#if (ws.activeCollection?.collection.folders?.length ?? 0) > 0}
        <Select
          value={ws.activeReq.folder}
          items={[
            { value: "", label: "(no folder)" },
            ...(ws.activeCollection?.collection.folders ?? []).map((f) => ({
              value: f,
            })),
          ]}
          onChange={(v) => ws.moveRequest(ws.activeReq!.id, v)}
          ariaLabel="Folder"
          class="w-auto text-xs text-fg-muted"
        />
      {/if}
      {#if identityCapable && (ws.profiles.length || ws.proxies.length || ws.activeReq.proxy)}
        {@const pid = ws.activeReq.profileId || ws.activeCollection?.collection.defaultProfileId || ""}
        {@const fromDefault = !ws.activeReq.profileId && !!pid}
        {@const active = pid ? ws.profiles.find((p) => p.id === pid) : null}
        {#if ws.profiles.length}
          <Select
            bind:value={ws.activeReq.profileId}
            items={[
              { value: "", label: "no profile" },
              ...ws.profiles.map((p) => ({ value: p.id, label: `👤 ${p.name || "profile"}` })),
            ]}
            ariaLabel="User profile"
            class="w-auto text-xs text-fg-muted"
          />
        {/if}
        {#if activeProfileProxy}
          <span
            class="inline-flex max-w-44 shrink-0 items-center gap-1 rounded bg-[var(--color-bg-2)] px-1.5 py-0.5 text-[10px] text-fg-muted"
            title={`Proxy locked by profile ${active?.name || "profile"}`}
          >
            <span>Profile proxy</span>
            <span class="mono truncate text-fg">{activeProfileProxy.name || `${activeProfileProxy.type}://${activeProfileProxy.host}:${activeProfileProxy.port}`}</span>
          </span>
        {:else}
          <Select
            value={activeRequestProxySelection}
            items={proxyOptions}
            onChange={setRequestProxySelection}
            ariaLabel="Request proxy route"
            class="w-auto max-w-56 text-xs text-fg-muted"
          />
        {/if}
        {#if active?.userAgent}
          {@const overridden = ws.activeReq.headers.some(
            (h) => h.enabled && h.name.toLowerCase() === "user-agent"
          )}
          <Tooltip
            text={fromDefault
              ? `UA from collection default (${active.name})`
              : `UA from profile (${active.name})`}
            side="bottom"
          >
            {#snippet children(p)}
              <span
                {...p}
                class="mono shrink-0 rounded bg-[var(--color-bg-2)] px-1 text-[10px] {overridden
                  ? 'text-amber-300'
                  : 'text-fg-muted'}"
                title={overridden ? "overridden by request" : ""}
                >{overridden ? "UA override" : "UA"}</span
              >
            {/snippet}
          </Tooltip>
        {/if}
      {/if}
      <EnvBar />
    </div>

    <div class="flex min-w-0 items-center gap-2 px-3 py-2">
      <!-- request kind: compact pill -->
      <Select
        bind:value={ws.activeReq.kind}
        items={kinds}
        ariaLabel="Request type"
        class="w-auto shrink-0 text-xs font-semibold tracking-wide uppercase"
      />

      {#if ws.activeReq.kind === "http"}
        <!-- method + url joined as one bar, like Insomnia/Postman -->
        <div
          class="flex h-7 min-w-0 flex-1 items-center rounded-md border border-border bg-[var(--color-bg-2)] focus-within:border-[var(--color-brand)] focus-within:ring-1 focus-within:ring-[var(--color-brand)]"
        >
          <!-- method stays borderless/transparent to preserve the joined-bar look -->
          <Select
            bind:value={ws.activeReq.method}
            items={methods.map((m) => ({ value: m, label: m, class: methodColor[m] }))}
            bare
            ariaLabel="HTTP method"
            class="h-7 px-2.5 text-sm font-bold"
          />
          <span class="h-4 w-px shrink-0 bg-[var(--color-bg-3)]"></span>
          <div class="min-w-0 flex-1">
            <VarField
              bind:value={ws.activeReq.url}
              known={ws.knownVars}
              values={ws.varTitles}
              pathNames={pathOk}
              pathValues={pathValues}
              flush
              ariaLabel="URL"
              placeholder={"https://{{host}}/users/:id"}
            />
          </div>
        </div>
      {:else if ws.activeReq.kind === "ws" || ws.activeReq.kind === "sse" || ws.activeReq.kind === "grpc"}
        <div class="flex-1"></div>
      {:else}
        <span
          class="mono flex h-7 flex-1 items-center truncate rounded-md border border-border bg-[var(--color-bg-2)] px-2.5 text-sm text-fg-muted"
        >
          {ws.activeReq.net.host || "set target in Config →"}
        </span>
      {/if}
      {#if ws.activeReq.kind !== "ws" && ws.activeReq.kind !== "sse" && ws.activeReq.kind !== "grpc"}
        <!-- Send: brand-red paper-plane icon, like WhatsApp/Telegram. ⌘↵ / Ctrl+↵ to fire.
             Icon (not text) saves ~40px of bar width — important now that Run and
             Code moved out of this row into sibling tabs. -->
        <button
          type="button"
          onclick={() => ws.send()}
          disabled={ws.sending}
          title="Send (⌘↵ / Ctrl+↵)"
          aria-label="Send request"
          class="grid h-7 w-9 shrink-0 place-items-center rounded-md bg-[var(--color-brand)] text-white shadow-sm transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {#if ws.sending}
            <span class="mono text-xs font-bold">…</span>
          {:else}
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M22 2L11 13" />
              <path d="M22 2L15 22L11 13L2 9L22 2Z" />
            </svg>
          {/if}
        </button>
      {/if}
    </div>

    {#if ws.activeReq.kind === "ws" || ws.activeReq.kind === "sse"}
      <div class="min-h-0 flex-1 p-3">
        <WebSocketPanel />
      </div>
    {:else if ws.activeReq.kind === "grpc"}
      <div class="min-h-0 flex-1 p-3">
        <GrpcPanel />
      </div>
    {:else}
    <div class="flex gap-1 border-b border-border px-3 text-sm">
      {#each tabs as t (t)}
        <button
          onclick={() => (tab = t)}
          class="tab"
          class:is-active={tab === t}
        >
          {t.charAt(0).toUpperCase() + t.slice(1)}{#if t === "params" && detected.length}<span class="ml-1 text-xs text-fg-subtle" title="path params">:{detected.length}</span>{/if}
        </button>
      {/each}
    </div>

    <!-- Outer wrapper never scrolls, so the URL bar + tabs + env picker stay
     pinned while the user scrolls a long body / headers list / history.
     The inner <div class="h-full overflow-auto p-3"> carries the scroll. -->
<div class="min-h-0 flex-1 overflow-hidden">
<div class="h-full overflow-auto p-3">
      {#if tab === "params"}
        <div class="flex flex-col gap-5">
          <!-- Path params first: usually only 1–3 of them, anchored to the URL's
               structure (`:id`, `:slug`, …). Query string grows with usage and
               is the longer-running editor, so it sits below. -->
          <section>
            <h4 class="label mb-1.5">Path</h4>
            {#if detected.length === 0}
              <p class="hint">
                Add <code class="mono text-[var(--color-brand)]">:name</code> to the URL (e.g.
                <code class="mono">/users/:id</code>) to set path params here.
              </p>
            {:else}
              <p class="hint mb-2">
                Values for the <code class="mono">:name</code> segments — a literal or a
                <code class="mono">{"{{var}}"}</code> (e.g. an id saved in your environment).
              </p>
              <div class="flex flex-col gap-2">
                {#each ws.activeReq.pathParams.filter((p) => detected.includes(p.name)) as p (p.name)}
                  <label class="flex items-center gap-2 text-sm">
                    <span class="mono w-32 shrink-0 text-[var(--color-brand)]">:{p.name}</span>
                    <div class="flex-1">
                      <VarField
                        bind:value={p.value}
                        known={ws.knownVars}
                        values={ws.varTitles}
                        dense
                        ariaLabel={`value for :${p.name}`}
                        placeholder={"value or {{var}}"}
                      />
                    </div>
                  </label>
                {/each}
              </div>
            {/if}
          </section>

          <section>
            <h4 class="label mb-1.5">Query</h4>
            <p class="hint mb-2">
              Appended to the URL as <code class="mono">?key=value</code>. Values may use
              <code class="mono">{"{{vars}}"}</code>.
            </p>
            <KeyValueEditor bind:items={ws.activeReq.query} placeholder="param" />
          </section>
        </div>
      {:else if tab === "headers"}
        <!-- Profile-injected headers are now real rows in the list below —
             see syncProfileHeaders() in the store + the "profile" badge
             that KeyValueEditor renders for fromProfile rows. No preview
             banner needed; the user can edit/disable/delete like any other row. -->
        <KeyValueEditor bind:items={ws.activeReq.headers} placeholder="header" />
      {:else if tab === "auth"}
        <AuthEditor bind:auth={ws.activeReq.auth} />
      {:else if tab === "scripts"}
        <div class="flex flex-col gap-4">
          <div>
            <div class="mb-1 flex items-center justify-between">
              <h4 class="label">Pre-request</h4>
              <span class="mono text-xs text-fg-faint">rr.setHeader · rr.setVar · rr.req.url</span>
            </div>
            <Textarea bind:value={ws.activeReq.scripts.preRequest} rows={6} class="mono text-xs"
              placeholder={"rr.setVar('ts', Date.now())\nrr.setHeader('X-Trace', rr.getVar('ts'))"} />
          </div>
          <div>
            <div class="mb-1 flex items-center justify-between">
              <h4 class="label">Post-response</h4>
              <span class="mono text-xs text-fg-faint">rr.res · rr.test · rr.expect · rr.setVar</span>
            </div>
            <Textarea bind:value={ws.activeReq.scripts.postResponse} rows={8} class="mono text-xs"
              placeholder={"rr.test('200 OK', () => rr.expect(rr.res.status).toBe(200))\nrr.setVar('token', rr.res.json.token)"} />
          </div>
        </div>
      {:else if tab === "settings"}
        <!-- Per-request settings. Wider container (was max-w-md) so the
             labels/controls breathe, with subtitle groupings so timeout /
             redirect / proxy / TLS knobs are visually distinct sections. -->
        {@const inputCls =
          "h-7 w-32 rounded-md border border-border bg-[var(--color-bg-2)] px-2 text-sm text-fg outline-none focus:border-[var(--color-brand)]"}
        <div class="flex flex-col gap-6 text-sm">
          <section class="flex flex-col gap-3">
            <h4 class="label">Network</h4>
            <p class="hint -mt-2">How the request reaches its target.</p>
            <label class="flex items-center justify-between gap-3">
              <span class="text-fg-muted">Timeout <span class="hint">ms</span></span>
              <input
                type="number"
                min="0"
                value={ws.activeReq.timeout ?? ""}
                placeholder="none"
                class={inputCls}
                oninput={(e) => {
                  const v = e.currentTarget.value;
                  ws.activeReq!.timeout = v ? Math.max(0, Number(v)) : undefined;
                }}
              />
            </label>
            <label class="flex items-center justify-between gap-3">
              <span class="text-fg-muted">Follow redirects</span>
              <input
                type="checkbox"
                bind:checked={ws.activeReq.followRedirects}
                class="accent-[var(--color-brand)]"
              />
            </label>
            {#if ws.activeReq.followRedirects}
              <label class="flex items-center justify-between gap-3 pl-4">
                <span class="text-fg-muted">Max redirects</span>
                <input
                  type="number"
                  min="0"
                  max="50"
                  value={ws.activeReq.maxRedirects}
                  class={inputCls}
                  oninput={(e) => {
                    const v = e.currentTarget.value;
                    ws.activeReq!.maxRedirects = v ? Math.min(50, Number(v)) : 0;
                  }}
                />
              </label>
            {/if}
          </section>

          <section class="flex flex-col gap-3">
            <h4 class="label">TLS</h4>
            <p class="hint -mt-2">Certificate handling for https:// targets.</p>
            <label class="flex items-center justify-between gap-3">
              <span class="text-fg-muted"
                >Skip verification <span class="hint">self-signed / dev</span></span
              >
              <input
                type="checkbox"
                bind:checked={ws.activeReq.insecure}
                class="accent-[var(--color-brand)]"
              />
            </label>
          </section>

          <section class="flex flex-col gap-3">
            <h4 class="label">Proxy</h4>
            {#if activeProfileProxy}
              <p class="hint -mt-2">
                Locked by profile “{ws.activeProfile?.name || "profile"}”. Change the profile
                to use another proxy.
              </p>
              <div
                class="flex items-center justify-between gap-3 rounded-md border border-border bg-[var(--color-bg-2)] px-2 py-1.5"
              >
                <span class="text-fg-muted">Profile proxy</span>
                <span class="mono truncate text-xs text-fg">
                  {activeProfileProxy.name || `${activeProfileProxy.type}://${activeProfileProxy.host}:${activeProfileProxy.port}`}
                </span>
              </div>
            {:else}
              <p class="hint -mt-2">Route this request directly, through a saved proxy, or through a custom proxy URL.</p>
              <label class="flex items-center justify-between gap-3">
                <span class="text-fg-muted">Route</span>
                <Select
                  value={activeRequestProxySelection}
                  items={proxyOptions}
                  onChange={setRequestProxySelection}
                  ariaLabel="Request proxy route"
                  class="w-72"
                />
              </label>
              {#if activeRequestProxySelection === CUSTOM_PROXY}
                <label class="flex items-center justify-between gap-3">
                  <span class="text-fg-muted"
                    >Custom URL <span class="hint">http/https/socks</span></span
                  >
                  <input
                    type="text"
                    value={ws.activeReq.proxy ?? ""}
                    placeholder="http://127.0.0.1:8080"
                    class="mono h-7 w-72 rounded-md border border-border bg-[var(--color-bg-2)] px-2 text-xs text-fg outline-none focus:border-[var(--color-brand)]"
                    oninput={(e) => {
                      const v = e.currentTarget.value.trim();
                      ws.activeReq!.proxy = v || undefined;
                    }}
                  />
                </label>
              {/if}
            {/if}
          </section>
        </div>
      {:else if tab === "config"}
        <ProtocolForm kind={ws.activeReq.kind} bind:net={ws.activeReq.net} />
      {:else if tab === "run"}
        <!-- Lazy-load the runner on first switch — same component that used
             to live in a modal, now in-place so headers/body context stays put. -->
        {#if !RunnerTabComponent}
          {#await ensureRunnerLoaded()}{/await}
        {/if}
        {#if RunnerTabComponent}
          <RunnerTabComponent embedded />
        {:else}
          <p class="text-fg-faint">Loading runner…</p>
        {/if}
      {:else if tab === "code"}
        {#if !CodeTabComponent}
          {#await ensureCodeLoaded()}{/await}
        {/if}
        {#if CodeTabComponent}
          <CodeTabComponent embedded />
        {:else}
          <p class="text-fg-faint">Loading code generators…</p>
        {/if}
      {:else if tab === "history"}
        <HistoryTimeline embedded />
      {:else}
        <div class="flex h-full min-h-0 flex-col gap-2">
          <div class="flex shrink-0 items-center gap-2">
            <Select
              value={ws.activeReq.body.type}
              items={bodyTypes}
              onChange={(v) => ws.setBodyType(v)}
              ariaLabel="body type"
              class="w-auto"
            />
            {#if canPrettify}
              <Button variant="outline" size="xs" onclick={prettify} title="Format JSON"
                >Prettify</Button
              >
            {/if}
            {#if ws.activeReq.body.type !== "none" && ws.activeReq.body.type !== "form" && ws.activeReq.body.type !== "multipart"}
              <label
                class="ml-auto flex items-center gap-1.5 text-xs text-fg-muted"
                title="Soft-wrap long lines (hides line numbers while on)"
              >
                <input type="checkbox" bind:checked={bodyWrap} class="accent-accent" /> wrap
              </label>
            {/if}
          </div>
          {#if ws.activeReq.body.type === "form" || ws.activeReq.body.type === "multipart"}
            <KeyValueEditor bind:items={ws.activeReq.body.fields} placeholder="field" />
          {:else if ws.activeReq.body.type === "graphql"}
            <div class="flex items-center gap-2 border-b border-border pb-1">
              <div class="flex gap-1">
                <button onclick={() => (gqlTab = "query")} class="tab" class:is-active={gqlTab === "query"}>Query</button>
                <button onclick={() => (gqlTab = "variables")} class="tab" class:is-active={gqlTab === "variables"}>
                  Variables{#if gqlVarsError}<span class="ml-1 text-red-400">!</span>{/if}
                </button>
              </div>
              <Button variant="outline" size="xs" onclick={() => void openSchema()} class="ml-auto"
                title="Fetch the GraphQL schema (introspection)">Schema</Button>
            </div>
            {#if gqlTab === "query"}
              <VarField
                bind:value={ws.activeReq.body.content}
                known={ws.knownVars}
                values={ws.varTitles}
                gqlSchema={ws.activeGqlSchema}
                multiline
                lineNumbers
                wrap={bodyWrap}
                fill
                rows={13}
                ariaLabel="GraphQL query"
                placeholder={"query {\n  viewer { id name }\n}"}
              />
            {:else}
              <div class="flex items-center justify-between">
                <p class="hint">JSON object sent alongside the query.</p>
                <Button variant="outline" size="xs" onclick={prettifyVars}>Prettify</Button>
              </div>
              <VarField
                bind:value={ws.activeReq.body.variables}
                known={ws.knownVars}
                values={ws.varTitles}
                multiline
                lineNumbers
                wrap={bodyWrap}
                fill
                rows={12}
                ariaLabel="GraphQL variables"
                placeholder={'{\n  "id": 1\n}'}
              />
              {#if gqlVarsError}
                <p class="mt-1 text-xs text-red-400">{gqlVarsError}</p>
              {/if}
            {/if}
          {:else if ws.activeReq.body.type !== "none"}
            <VarField
              bind:value={ws.activeReq.body.content}
              known={ws.knownVars}
              values={ws.varTitles}
              multiline
              lineNumbers
              wrap={bodyWrap}
              fill
              rows={12}
              ariaLabel="Request body"
              placeholder={"request body (vars via {{NAME}})"}
            />
          {/if}
        </div>
      {/if}
    </div>
    </div>
    {/if}
  </section>

  {#if showSchema && GraphQlSchemaComponent}
    <GraphQlSchemaComponent onClose={() => (showSchema = false)} />
  {/if}
{:else}
  <section
    class="grid h-full place-items-center border-r border-border bg-[var(--color-bg-1)] text-sm text-fg-faint"
  >
    Select a request.
  </section>
{/if}
