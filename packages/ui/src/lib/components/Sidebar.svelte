<script lang="ts">
  import { ws } from "../store.svelte";
  import { brand } from "../brand.generated";

  const methodColor: Record<string, string> = {
    GET: "text-emerald-400",
    POST: "text-amber-400",
    PUT: "text-blue-400",
    PATCH: "text-purple-400",
    DELETE: "text-red-400",
    HEAD: "text-zinc-400",
    OPTIONS: "text-zinc-400",
  };
</script>

<aside
  class="flex h-full w-64 shrink-0 flex-col border-r border-[var(--color-bg-3)] bg-[var(--color-bg-1)]"
>
  <div class="flex items-center gap-2 px-4 py-3">
    <span
      class="grid h-6 w-6 place-items-center rounded bg-[var(--color-accent)] text-sm font-bold text-black"
      >R</span
    >
    <span class="text-sm font-semibold">{brand.productName}</span>
  </div>

  <div class="flex-1 overflow-y-auto px-2 pb-4">
    {#each ws.collections as col (col.path)}
      <div class="mt-2">
        <div class="px-2 py-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase">
          {col.collection.name}
        </div>
        {#each col.requests as req (req.id)}
          <button
            onclick={() => ws.selectRequest(col.path, req.id)}
            class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-[var(--color-bg-2)]"
            class:bg-[var(--color-bg-2)]={ws.activeReq?.id === req.id &&
              ws.activeColPath === col.path}
          >
            <span class="mono w-12 shrink-0 text-[11px] font-bold {methodColor[req.method]}"
              >{req.method}</span
            >
            <span class="truncate text-zinc-300">{req.name}</span>
          </button>
        {/each}
      </div>
    {/each}
  </div>
</aside>
