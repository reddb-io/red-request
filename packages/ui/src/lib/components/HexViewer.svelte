<script lang="ts">
  // Classic three-column hex viewer (offset │ hex │ ASCII) for a binary payload. The
  // bytes→rows formatting is the pure `hexRows` helper from core (unit-tested in isolation);
  // this component is only the rendering. Reusable: pass either raw `bytes` or a base64
  // string (e.g. ResponseResult.bodyBase64). Later slices feed it WebSocket binary frames.
  import { hexRows, bytesFromBase64, type HexRow } from "@reddb-io/request-core";

  interface Props {
    bytes?: Uint8Array;
    base64?: string;
    bytesPerRow?: number;
  }
  let { bytes, base64, bytesPerRow = 16 }: Props = $props();

  const data = $derived(bytes ?? (base64 ? bytesFromBase64(base64) : new Uint8Array()));
  const rows = $derived<HexRow[]>(hexRows(data, bytesPerRow));
</script>

{#if data.length === 0}
  <div class="hint p-4 text-center">No bytes to display.</div>
{:else}
  <div class="mono overflow-auto text-xs leading-5 whitespace-pre">
    <div class="mb-1 text-fg-faint">{data.length} bytes</div>
    {#each rows as row (row.offset)}
      <div class="flex gap-3">
        <span class="shrink-0 text-fg-faint select-none">{row.offset}</span>
        <span class="shrink-0 text-fg">
          {#each Array(bytesPerRow) as _, i (i)}<span
              class="inline-block w-[1.4em] text-center {i === bytesPerRow / 2
                ? 'ml-2'
                : ''}">{row.hex[i] ?? "  "}</span
            >{/each}
        </span>
        <span class="shrink-0 border-l border-border pl-3 text-fg-muted"
          >{row.ascii}</span
        >
      </div>
    {/each}
  </div>
{/if}
