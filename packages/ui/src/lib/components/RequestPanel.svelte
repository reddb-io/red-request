<script lang="ts">
  import { ws } from "../store.svelte";
  import { httpMethodSchema } from "@red-requester/core";
  import KeyValueEditor from "./KeyValueEditor.svelte";
  import AuthEditor from "./AuthEditor.svelte";
  import EnvBar from "./EnvBar.svelte";

  const methods = httpMethodSchema.options;
  let tab = $state<"params" | "headers" | "body" | "auth">("params");
  const bodyTypes = ["none", "json", "raw", "form", "xml", "graphql"] as const;

  const field =
    "mono rounded bg-[var(--color-bg-2)] px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-[var(--color-accent)]";
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
      <select bind:value={ws.activeReq.method} class="{field} font-bold">
        {#each methods as m (m)}
          <option value={m}>{m}</option>
        {/each}
      </select>
      <input
        bind:value={ws.activeReq.url}
        placeholder={"https://{{host}}/path"}
        class="{field} flex-1"
      />
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
    </div>

    <div class="flex gap-1 border-b border-[var(--color-bg-3)] px-3 text-sm">
      {#each ["params", "headers", "body", "auth"] as const as t (t)}
        <button
          onclick={() => (tab = t)}
          class="px-2 py-2 capitalize"
          class:text-[var(--color-accent)]={tab === t}
          class:text-zinc-400={tab !== t}>{t}</button
        >
      {/each}
    </div>

    <div class="flex-1 overflow-auto p-3">
      {#if tab === "params"}
        <KeyValueEditor bind:items={ws.activeReq.query} placeholder="param" />
      {:else if tab === "headers"}
        <KeyValueEditor bind:items={ws.activeReq.headers} placeholder="header" />
      {:else if tab === "auth"}
        <AuthEditor bind:auth={ws.activeReq.auth} />
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
              class="mono w-full rounded bg-[var(--color-bg-2)] p-2 text-xs outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
            ></textarea>
          {/if}
        </div>
      {/if}
    </div>
  </section>
{:else}
  <section
    class="grid h-full place-items-center border-r border-[var(--color-bg-3)] bg-[var(--color-bg-1)] text-sm text-zinc-600"
  >
    Select a request.
  </section>
{/if}
