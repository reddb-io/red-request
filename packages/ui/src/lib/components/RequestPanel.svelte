<script lang="ts">
  import { ws } from "../store.svelte";
  import { httpMethodSchema, requestKindSchema } from "@red-request/core";
  import KeyValueEditor from "./KeyValueEditor.svelte";
  import AuthEditor from "./AuthEditor.svelte";
  import EnvBar from "./EnvBar.svelte";
  import RunnerPanel from "./RunnerPanel.svelte";
  import CodeModal from "./CodeModal.svelte";
  import GraphQlSchema from "./GraphQlSchema.svelte";
  import ProtocolForm from "./ProtocolForm.svelte";
  import WebSocketPanel from "./WebSocketPanel.svelte";
  import GrpcPanel from "./GrpcPanel.svelte";
  import VarField from "./VarField.svelte";
  import Select from "./ui/Select.svelte";
  import Tooltip from "./ui/Tooltip.svelte";
  import { Button } from "./ui/button/index.js";
  import { Textarea } from "./ui/textarea/index.js";

  let showRunner = $state(false);
  let showCode = $state(false);
  let showSchema = $state(false);
  let gqlTab = $state<"query" | "variables">("query");

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

  const methods = httpMethodSchema.options;
  const kinds = requestKindSchema.options;
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
    | "body"
    | "auth"
    | "scripts"
    | "settings"
    | "config";
  let tab = $state<Tab>("params");
  const httpTabs: Tab[] = ["params", "headers", "body", "auth", "scripts", "settings"];
  const netTabs: Tab[] = ["config", "scripts"];
  const tabs = $derived(ws.activeReq?.kind === "http" ? httpTabs : netTabs);
  $effect(() => {
    if (!tabs.includes(tab)) tab = tabs[0]!;
  });
  const bodyTypes = ["none", "json", "raw", "form", "xml", "graphql"] as const;

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
      <Select
        value={ws.activeReq.folder}
        items={[
          { value: "", label: "(root)" },
          ...(ws.activeCollection?.collection.folders ?? []).map((f) => ({
            value: f,
          })),
        ]}
        onChange={(v) => ws.moveRequest(ws.activeReq!.id, v)}
        ariaLabel="Folder"
        class="w-auto text-xs text-fg-muted"
      />
      {#if ws.profiles.length && (ws.activeReq.kind === "http" || ws.activeReq.kind === "grpc")}
        {@const pid = ws.activeReq.profileId || ws.activeCollection?.collection.defaultProfileId || ""}
        {@const fromDefault = !ws.activeReq.profileId && !!pid}
        {@const active = pid ? ws.profiles.find((p) => p.id === pid) : null}
        <Select
          bind:value={ws.activeReq.profileId}
          items={[
            { value: "", label: "no profile" },
            ...ws.profiles.map((p) => ({ value: p.id, label: `👤 ${p.name || "profile"}` })),
          ]}
          ariaLabel="User profile"
          class="w-auto text-xs text-fg-muted"
        />
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

    <div class="flex items-center gap-2 px-3 py-2">
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
          class="flex h-7 flex-1 items-center rounded-md border border-border bg-[var(--color-bg-2)] focus-within:border-[var(--color-brand)] focus-within:ring-1 focus-within:ring-[var(--color-brand)]"
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
        <Button
          onclick={() => ws.send()}
          disabled={ws.sending}
          title="Send (⌘↵ / Ctrl+↵)"
          size="xs"
          class="shrink-0"
          >{ws.sending ? "…" : "Send"}</Button
        >
      {/if}
      <Button
        onclick={() => ws.save()}
        variant="outline"
        size="xs"
        class="shrink-0"
        >Save</Button
      >
      {#if ws.activeReq.kind !== "ws" && ws.activeReq.kind !== "sse" && ws.activeReq.kind !== "grpc"}
        <Button
          onclick={() => (showRunner = true)}
          variant="outline"
          size="xs"
          class="shrink-0"
          title="Run loops: repeat, data-driven, or flow">Run…</Button
        >
      {/if}
      {#if ws.activeReq.kind === "http"}
        <Button
          onclick={() => (showCode = true)}
          variant="outline"
          size="xs"
          class="shrink-0"
          title="Generate code (curl, fetch, python…)">Code</Button
        >
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
          {t}{#if t === "params" && detected.length}<span class="ml-1 text-xs text-fg-subtle" title="path params">:{detected.length}</span>{/if}
        </button>
      {/each}
    </div>

    <div class="flex-1 overflow-auto p-3">
      {#if tab === "params"}
        <div class="flex flex-col gap-5">
          <section>
            <h4 class="label mb-1.5">Query</h4>
            <p class="hint mb-2">
              Appended to the URL as <code class="mono">?key=value</code>. Values may use
              <code class="mono">{"{{vars}}"}</code>.
            </p>
            <KeyValueEditor bind:items={ws.activeReq.query} placeholder="param" />
          </section>

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
        </div>
      {:else if tab === "headers"}
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
        {@const inputCls =
          "h-7 w-28 rounded-md border border-border bg-[var(--color-bg-2)] px-2 text-sm text-fg outline-none focus:border-[var(--color-brand)]"}
        <div class="flex max-w-md flex-col gap-3 text-sm">
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
            <label class="flex items-center justify-between gap-3">
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
          <label class="flex items-center justify-between gap-3">
            <span class="text-fg-muted"
              >Skip TLS verification <span class="hint">self-signed / dev</span></span
            >
            <input
              type="checkbox"
              bind:checked={ws.activeReq.insecure}
              class="accent-[var(--color-brand)]"
            />
          </label>
          <label class="flex items-center justify-between gap-3">
            <span class="text-fg-muted">Proxy <span class="hint">http/https/socks URL</span></span>
            <input
              type="text"
              value={ws.activeReq.proxy ?? ""}
              placeholder="http://127.0.0.1:8080"
              class="mono h-7 w-56 rounded-md border border-border bg-[var(--color-bg-2)] px-2 text-xs text-fg outline-none focus:border-[var(--color-brand)]"
              oninput={(e) => {
                const v = e.currentTarget.value.trim();
                ws.activeReq!.proxy = v || undefined;
              }}
            />
          </label>
        </div>
      {:else if tab === "config"}
        <ProtocolForm kind={ws.activeReq.kind} bind:net={ws.activeReq.net} />
      {:else}
        <div class="flex flex-col gap-2">
          <div class="flex items-center gap-2">
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
              <Button variant="outline" size="xs" onclick={() => (showSchema = true)} class="ml-auto"
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
              rows={12}
              ariaLabel="Request body"
              placeholder={"request body (vars via {{NAME}})"}
            />
          {/if}
        </div>
      {/if}
    </div>
    {/if}
  </section>

  {#if showCode}
    <CodeModal onClose={() => (showCode = false)} />
  {/if}
  {#if showSchema}
    <GraphQlSchema onClose={() => (showSchema = false)} />
  {/if}
  {#if showRunner}
    <RunnerPanel onClose={() => (showRunner = false)} />
  {/if}
{:else}
  <section
    class="grid h-full place-items-center border-r border-border bg-[var(--color-bg-1)] text-sm text-fg-faint"
  >
    Select a request.
  </section>
{/if}
