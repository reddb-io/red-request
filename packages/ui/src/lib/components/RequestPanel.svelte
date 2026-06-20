<script lang="ts">
  import { ws } from "../store.svelte";
  import { httpMethodSchema, requestKindSchema } from "@red-request/core";
  import KeyValueEditor from "./KeyValueEditor.svelte";
  import AuthEditor from "./AuthEditor.svelte";
  import EnvBar from "./EnvBar.svelte";
  import RunnerPanel from "./RunnerPanel.svelte";
  import ProtocolForm from "./ProtocolForm.svelte";
  import VarField from "./VarField.svelte";
  import Select from "./ui/Select.svelte";

  let showRunner = $state(false);

  const methods = httpMethodSchema.options;
  const kinds = requestKindSchema.options;
  const methodColor: Record<string, string> = {
    GET: "text-emerald-400",
    POST: "text-amber-400",
    PUT: "text-blue-400",
    PATCH: "text-purple-400",
    DELETE: "text-red-400",
    HEAD: "text-zinc-400",
    OPTIONS: "text-zinc-400",
  };
  type Tab =
    | "params"
    | "path"
    | "headers"
    | "body"
    | "auth"
    | "scripts"
    | "config";
  let tab = $state<Tab>("params");
  const httpTabs: Tab[] = ["params", "path", "headers", "body", "auth", "scripts"];
  const netTabs: Tab[] = ["config", "scripts"];
  const tabs = $derived(ws.activeReq?.kind === "http" ? httpTabs : netTabs);
  $effect(() => {
    if (!tabs.includes(tab)) tab = tabs[0]!;
  });
  const bodyTypes = ["none", "json", "raw", "form", "xml", "graphql"] as const;

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
          class="flex h-8 flex-1 items-center rounded-md border border-border bg-[var(--color-bg-2)] focus-within:border-[var(--color-accent)] focus-within:ring-1 focus-within:ring-[var(--color-accent)]"
        >
          <!-- method stays borderless/transparent to preserve the joined-bar look -->
          <Select
            bind:value={ws.activeReq.method}
            items={methods.map((m) => ({ value: m, label: m, class: methodColor[m] }))}
            bare
            ariaLabel="HTTP method"
            class="h-8 px-3 text-sm font-bold"
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
          class="mono flex h-8 flex-1 items-center truncate rounded-md border border-border bg-[var(--color-bg-2)] px-3 text-sm text-fg-muted"
        >
          {ws.activeReq.net.host || "set target in Config →"}
        </span>
      {/if}
      <button
        onclick={() => ws.send()}
        disabled={ws.sending}
        class="btn btn-primary shrink-0"
        >{ws.sending ? "…" : "Send"}</button
      >
      <button
        onclick={() => ws.save()}
        class="btn btn-ghost shrink-0"
        >Save</button
      >
      <button
        onclick={() => (showRunner = true)}
        class="btn btn-ghost shrink-0"
        title="Run loops: repeat, data-driven, or flow">Run…</button
      >
    </div>

    <div class="flex gap-1 border-b border-border px-3 text-sm">
      {#each tabs as t (t)}
        <button
          onclick={() => (tab = t)}
          class="tab"
          class:is-active={tab === t}
        >
          {t}{#if t === "path" && detected.length}<span class="ml-1 text-[10px] text-fg-subtle">{detected.length}</span>{/if}
        </button>
      {/each}
    </div>

    <div class="flex-1 overflow-auto p-3">
      {#if tab === "params"}
        <KeyValueEditor bind:items={ws.activeReq.query} placeholder="param" />
      {:else if tab === "path"}
        {#if detected.length === 0}
          <p class="text-sm text-fg-faint">
            No path params. Add <code class="mono text-[var(--color-accent)]">:name</code> to the URL
            (e.g. <code class="mono">/users/:id</code>).
          </p>
        {:else}
          <div class="flex flex-col gap-2">
            {#each ws.activeReq.pathParams.filter((p) => detected.includes(p.name)) as p (p.name)}
              <label class="flex items-center gap-2 text-sm">
                <span class="mono w-32 shrink-0 text-[var(--color-accent)]">:{p.name}</span>
                <input bind:value={p.value} placeholder="value" class="input flex-1" />
              </label>
            {/each}
          </div>
        {/if}
      {:else if tab === "headers"}
        <KeyValueEditor bind:items={ws.activeReq.headers} placeholder="header" />
      {:else if tab === "auth"}
        <AuthEditor bind:auth={ws.activeReq.auth} />
      {:else if tab === "scripts"}
        <div class="flex flex-col gap-4">
          <div>
            <div class="mb-1 flex items-center justify-between">
              <h4 class="label">Pre-request</h4>
              <span class="mono text-[10px] text-fg-faint">rr.setHeader · rr.setVar · rr.req.url</span>
            </div>
            <textarea bind:value={ws.activeReq.scripts.preRequest} rows="6" class="textarea mono text-xs"
              placeholder={"rr.setVar('ts', Date.now())\nrr.setHeader('X-Trace', rr.getVar('ts'))"}></textarea>
          </div>
          <div>
            <div class="mb-1 flex items-center justify-between">
              <h4 class="label">Post-response</h4>
              <span class="mono text-[10px] text-fg-faint">rr.res · rr.test · rr.expect · rr.setVar</span>
            </div>
            <textarea bind:value={ws.activeReq.scripts.postResponse} rows="8" class="textarea mono text-xs"
              placeholder={"rr.test('200 OK', () => rr.expect(rr.res.status).toBe(200))\nrr.setVar('token', rr.res.json.token)"}></textarea>
          </div>
        </div>
      {:else if tab === "config"}
        <ProtocolForm kind={ws.activeReq.kind} bind:net={ws.activeReq.net} />
      {:else}
        <div class="flex flex-col gap-2">
          <Select
            bind:value={ws.activeReq.body.type}
            items={bodyTypes}
            ariaLabel="body type"
            class="w-auto"
          />
          {#if ws.activeReq.body.type === "form" || ws.activeReq.body.type === "multipart"}
            <KeyValueEditor bind:items={ws.activeReq.body.fields} placeholder="field" />
          {:else if ws.activeReq.body.type !== "none"}
            <VarField
              bind:value={ws.activeReq.body.content}
              known={ws.knownVars}
              values={ws.varTitles}
              multiline
              rows={12}
              ariaLabel="Request body"
              placeholder={"request body (vars via {{NAME}})"}
            />
          {/if}
        </div>
      {/if}
    </div>
  </section>

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
