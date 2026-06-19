<script lang="ts">
  import { ws } from "../store.svelte";
  import { httpMethodSchema, requestKindSchema } from "@red-requester/core";
  import KeyValueEditor from "./KeyValueEditor.svelte";
  import AuthEditor from "./AuthEditor.svelte";
  import EnvBar from "./EnvBar.svelte";
  import RunnerPanel from "./RunnerPanel.svelte";
  import ProtocolForm from "./ProtocolForm.svelte";

  let showRunner = $state(false);

  const methods = httpMethodSchema.options;
  const kinds = requestKindSchema.options;
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

  const field =
    "mono rounded bg-[var(--color-bg-2)] px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-[var(--color-accent)]";
  const area =
    "mono w-full rounded bg-[var(--color-bg-2)] p-2 text-xs outline-none focus:ring-1 focus:ring-[var(--color-accent)]";
</script>

{#if ws.activeReq}
  <section class="flex h-full flex-col border-r border-[var(--color-bg-3)] bg-[var(--color-bg-1)]">
    <div class="flex items-center gap-2 border-b border-[var(--color-bg-3)] px-3 py-2">
      <input
        bind:value={ws.activeReq.name}
        class="flex-1 bg-transparent text-sm font-medium text-zinc-200 outline-none"
      />
      <EnvBar />
    </div>

    <div class="flex items-center gap-2 px-3 py-2">
      <select bind:value={ws.activeReq.kind} class="{field} font-bold uppercase">
        {#each kinds as k (k)}
          <option value={k}>{k}</option>
        {/each}
      </select>
      {#if ws.activeReq.kind === "http"}
        <select bind:value={ws.activeReq.method} class="{field} font-bold">
          {#each methods as m (m)}
            <option value={m}>{m}</option>
          {/each}
        </select>
        <input
          bind:value={ws.activeReq.url}
          placeholder={"https://{{host}}/users/:id"}
          class="{field} flex-1"
        />
      {:else}
        <span class="mono flex-1 truncate px-2 text-sm text-zinc-400">
          {ws.activeReq.net.host || "set target in Config →"}
        </span>
      {/if}
      <button
        onclick={() => ws.send()}
        disabled={ws.sending}
        class="rounded bg-[var(--color-accent)] px-4 py-1 text-sm font-semibold text-black disabled:opacity-50"
        >{ws.sending ? "…" : "Send"}</button
      >
      <button
        onclick={() => ws.save()}
        class="rounded border border-[var(--color-bg-3)] px-3 py-1 text-sm text-zinc-300 hover:bg-[var(--color-bg-2)]"
        >Save</button
      >
      <button
        onclick={() => (showRunner = true)}
        class="rounded border border-[var(--color-bg-3)] px-3 py-1 text-sm text-zinc-300 hover:bg-[var(--color-bg-2)]"
        title="Run loops: repeat, data-driven, or flow">Run…</button
      >
    </div>

    <div class="flex gap-1 border-b border-[var(--color-bg-3)] px-3 text-sm">
      {#each tabs as t (t)}
        <button
          onclick={() => (tab = t)}
          class="px-2 py-2 capitalize"
          class:text-[var(--color-accent)]={tab === t}
          class:text-zinc-400={tab !== t}
        >
          {t}{#if t === "path" && detected.length}<span class="ml-1 text-[10px] text-zinc-500">{detected.length}</span>{/if}
        </button>
      {/each}
    </div>

    <div class="flex-1 overflow-auto p-3">
      {#if tab === "params"}
        <KeyValueEditor bind:items={ws.activeReq.query} placeholder="param" />
      {:else if tab === "path"}
        {#if detected.length === 0}
          <p class="text-sm text-zinc-600">
            No path params. Add <code class="mono text-[var(--color-accent)]">:name</code> to the URL
            (e.g. <code class="mono">/users/:id</code>).
          </p>
        {:else}
          <div class="flex flex-col gap-2">
            {#each ws.activeReq.pathParams.filter((p) => detected.includes(p.name)) as p (p.name)}
              <label class="flex items-center gap-2 text-sm">
                <span class="mono w-32 shrink-0 text-[var(--color-accent)]">:{p.name}</span>
                <input bind:value={p.value} placeholder="value" class="{field} flex-1" />
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
              <h4 class="text-xs font-semibold tracking-wide text-zinc-400 uppercase">Pre-request</h4>
              <span class="mono text-[10px] text-zinc-600">rr.setHeader · rr.setVar · rr.req.url</span>
            </div>
            <textarea bind:value={ws.activeReq.scripts.preRequest} rows="6" class={area}
              placeholder={"rr.setVar('ts', Date.now())\nrr.setHeader('X-Trace', rr.getVar('ts'))"}></textarea>
          </div>
          <div>
            <div class="mb-1 flex items-center justify-between">
              <h4 class="text-xs font-semibold tracking-wide text-zinc-400 uppercase">Post-response</h4>
              <span class="mono text-[10px] text-zinc-600">rr.res · rr.test · rr.expect · rr.setVar</span>
            </div>
            <textarea bind:value={ws.activeReq.scripts.postResponse} rows="8" class={area}
              placeholder={"rr.test('200 OK', () => rr.expect(rr.res.status).toBe(200))\nrr.setVar('token', rr.res.json.token)"}></textarea>
          </div>
        </div>
      {:else if tab === "config"}
        <ProtocolForm kind={ws.activeReq.kind} bind:net={ws.activeReq.net} />
      {:else}
        <div class="flex flex-col gap-2">
          <select bind:value={ws.activeReq.body.type} class={field}>
            {#each bodyTypes as t (t)}
              <option value={t}>{t}</option>
            {/each}
          </select>
          {#if ws.activeReq.body.type === "form" || ws.activeReq.body.type === "multipart"}
            <KeyValueEditor bind:items={ws.activeReq.body.fields} placeholder="field" />
          {:else if ws.activeReq.body.type !== "none"}
            <textarea
              bind:value={ws.activeReq.body.content}
              rows="12"
              placeholder={"request body (vars via {{NAME}})"}
              class={area}
            ></textarea>
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
    class="grid h-full place-items-center border-r border-[var(--color-bg-3)] bg-[var(--color-bg-1)] text-sm text-zinc-600"
  >
    Select a request.
  </section>
{/if}
