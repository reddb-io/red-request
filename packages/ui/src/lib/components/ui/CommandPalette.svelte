<script lang="ts">
  // ⌘K / Ctrl-K command palette: fuzzy-search every request to jump to it, plus quick
  // actions. Built on shadcn-svelte's Command (cmdk) inside its Command.Dialog.
  import * as Command from "./command/index.js";
  import { ws } from "../../store.svelte";

  let { open = $bindable(false) }: { open?: boolean } = $props();

  const methodColor: Record<string, string> = {
    GET: "text-emerald-400",
    POST: "text-amber-400",
    PUT: "text-blue-400",
    PATCH: "text-purple-400",
    DELETE: "text-red-400",
  };

  const requests = $derived(
    ws.collections.flatMap((c) =>
      c.requests.map((r) => ({ colId: c.id, col: c.collection.name, req: r }))
    )
  );

  function go(fn: () => void) {
    open = false;
    fn();
  }
</script>

{#snippet action(label: string, hint: string, fn: () => void)}
  <Command.Item value={label} onSelect={() => go(fn)}>
    <span class="truncate">{label}</span>
    <span class="hint ml-auto">{hint}</span>
  </Command.Item>
{/snippet}

<Command.Dialog bind:open>
  <Command.Input placeholder="Search requests, run actions…" />
  <Command.List>
    <Command.Empty>No results.</Command.Empty>

    <Command.Group heading="Requests">
      {#each requests as r (r.colId + r.req.id)}
        <Command.Item
          value={`${r.col} ${r.req.name} ${r.req.kind === "http" ? r.req.method : r.req.kind}`}
          onSelect={() => go(() => ws.selectRequest(r.colId, r.req.id))}
        >
          <span
            class="mono w-11 shrink-0 text-xs font-bold {r.req.kind === 'http'
              ? (methodColor[r.req.method] ?? 'text-fg-muted')
              : 'text-fg-muted'}"
            >{r.req.kind === "http" ? r.req.method : r.req.kind.toUpperCase()}</span
          >
          <span class="truncate">{r.req.name}</span>
          <span class="hint ml-auto truncate pl-2">{r.col}</span>
        </Command.Item>
      {/each}
    </Command.Group>

    <Command.Separator />

    <Command.Group heading="Actions">
      {@render action("New request", "create", () => ws.addRequest(""))}
      {#if ws.activeReq}
        {@render action("Send request", "⏎", () => ws.send())}
        {@render action("Save request", "save", () => ws.save())}
        {@render action("Duplicate request", "copy", () =>
          ws.duplicateRequest(ws.activeReq!.id)
        )}
      {/if}
      {@render action("Home", "view", () => (ws.view = "home"))}
      {@render action("Requests", "view", () => (ws.view = "requests"))}
      {@render action("Settings", "view", () => (ws.view = "settings"))}
      {@render action("Switch project…", "selector", () => ws.backToSelector())}
    </Command.Group>
  </Command.List>
</Command.Dialog>
