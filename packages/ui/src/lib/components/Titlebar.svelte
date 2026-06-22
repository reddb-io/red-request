<script lang="ts">
  // App identity strip. Window controls (minimize / maximize / close) are the OS-native
  // titlebar's now (decorations:true in tauri.conf.json) — rendered by the window manager,
  // so they are ALWAYS available at the top, even if the webview stops painting. They must
  // never be gated behind app components, or a frontend crash leaves the window unclosable.
  import { brand } from "../brand.generated";
</script>

<div
  class="flex h-8 shrink-0 select-none items-center border-b border-border bg-[var(--color-bg-0)]"
>
  <!-- Brand, left -->
  <div class="flex items-center gap-2 pl-2.5 pr-3">
    <span
      class="grid h-5 w-5 place-items-center rounded bg-[var(--color-brand)] text-xs font-bold text-black"
      >{brand.monogram}</span
    >
    <span class="text-xs font-medium text-fg-subtle">{brand.productName}</span>
  </div>
</div>
