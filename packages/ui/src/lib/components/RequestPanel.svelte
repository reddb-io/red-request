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
  import VarField from "./VarField.svelte";
  import Select from "./ui/Select.svelte";
  import { Button } from "./ui/button/index.js";
  import { Textarea } from "./ui/textarea/index.js";

  let showRunner = $state(false);
  let showCode = $state(false);
  let showSchema = $state(false);

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
  type Tab = "params" | "headers" | "body" | "auth" | "scripts" | "config";
  let tab = $state<Tab>("params");
  const httpTabs: Tab[] = ["params", "headers", "body", "auth", "scripts"];
  const netTabs: Tab[] = ["config", "scripts"];
  const tabs = $derived(ws.activeReq?.kind === "http" ? httpTabs : netTabs);
  $effect(() => {
    if (!tabs.includes(tab)) tab = tabs[0]!;
  });
  const bodyTypes = ["none", "json", "raw", "form", "xml", "graphql"] as const;

  // Pretty-print the body (JSON / GraphQL payloads); leaves content as-is if it doesn't parse.
  const canPrettify = $derived(
    ws.activeReq?.body.type === "json" || ws.activeReq?.body.type === "graphql"
  );
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
      {:else}
        <span
          class="mono flex h-7 flex-1 items-center truncate rounded-md border border-border bg-[var(--color-bg-2)] px-2.5 text-sm text-fg-muted"
        >
          {ws.activeReq.net.host || "set target in Config →"}
        </span>
      {/if}
      <Button
        onclick={() => ws.send()}
        disabled={ws.sending}
        title="Send (⌘↵ / Ctrl+↵)"
        size="xs"
        class="shrink-0"
        >{ws.sending ? "…" : "Send"}</Button
      >
      <Button
        onclick={() => ws.save()}
        variant="outline"
        size="xs"
        class="shrink-0"
        >Save</Button
      >
      <Button
        onclick={() => (showRunner = true)}
        variant="outline"
        size="xs"
        class="shrink-0"
        title="Run loops: repeat, data-driven, or flow">Run…</Button
      >
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
            <div class="flex items-center justify-between">
              <h4 class="label">Query</h4>
              <Button variant="outline" size="xs" onclick={() => (showSchema = true)}
                title="Fetch the GraphQL schema (introspection)">Schema</Button
              >
            </div>
            <VarField
              bind:value={ws.activeReq.body.content}
              known={ws.knownVars}
              values={ws.varTitles}
              multiline
              lineNumbers
              rows={9}
              ariaLabel="GraphQL query"
              placeholder={"query {\n  viewer { id name }\n}"}
            />
            <h4 class="label mt-1">Variables (JSON)</h4>
            <VarField
              bind:value={ws.activeReq.body.variables}
              known={ws.knownVars}
              values={ws.varTitles}
              multiline
              lineNumbers
              rows={4}
              ariaLabel="GraphQL variables"
              placeholder={'{ "id": 1 }'}
            />
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
