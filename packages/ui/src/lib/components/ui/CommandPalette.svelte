<script lang="ts">
  // ⌘K / Ctrl-K command palette: fuzzy-search every request to jump to it, plus quick
  // actions. bits-ui Command (filtering + keyboard) inside a Dialog (overlay + focus trap),
  // themed with our design system.
  import { Command, Dialog } from "bits-ui";
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
  <Command.Item
    value={label}
    onSelect={() => go(fn)}
    class="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-fg-muted select-none data-[selected]:bg-[var(--color-bg-2)] data-[selected]:text-fg"
  >
    <span class="truncate">{label}</span>
    <span class="hint ml-auto">{hint}</span>
  </Command.Item>
{/snippet}

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 bg-black/50" />
    <Dialog.Content
      class="panel fixed top-[14%] left-1/2 z-50 w-[560px] max-w-[92vw] -translate-x-1/2 overflow-hidden p-0 shadow-2xl outline-none"
    >
      <Command.Root class="flex max-h-[60vh] flex-col">
        <Command.Input
          placeholder="Search requests, run actions…"
          class="w-full border-b border-border bg-transparent px-3 py-2.5 text-sm text-fg outline-none placeholder:text-fg-faint"
        />
        <Command.List class="overflow-y-auto p-1">
          <Command.Empty class="hint px-3 py-6 text-center">No results.</Command.Empty>

          <Command.Group>
            <Command.GroupHeading class="label px-2 py-1">Requests</Command.GroupHeading>
            <Command.GroupItems>
              {#each requests as r (r.colId + r.req.id)}
                <Command.Item
                  value={`${r.col} ${r.req.name} ${r.req.kind === "http" ? r.req.method : r.req.kind}`}
                  onSelect={() => go(() => ws.selectRequest(r.colId, r.req.id))}
                  class="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-fg-muted select-none data-[selected]:bg-[var(--color-bg-2)] data-[selected]:text-fg"
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
            </Command.GroupItems>
          </Command.Group>

          <Command.Separator class="my-1 h-px bg-[var(--color-border)]" />

          <Command.Group>
            <Command.GroupHeading class="label px-2 py-1">Actions</Command.GroupHeading>
            <Command.GroupItems>
              {@render action("New request", "create", () => ws.addRequest(""))}
              {#if ws.activeReq}
                {@render action("Send request", "⏎", () => ws.send())}
                {@render action("Save request", "save", () => ws.save())}
                {@render action("Duplicate request", "copy", () =>
                  ws.duplicateRequest(ws.activeReq!.id)
                )}
              {/if}
              {@render action("Dashboard", "view", () => (ws.view = "dashboard"))}
              {@render action("Requests", "view", () => (ws.view = "requests"))}
              {@render action("Switch project…", "selector", () => ws.backToSelector())}
            </Command.GroupItems>
          </Command.Group>
        </Command.List>
      </Command.Root>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
