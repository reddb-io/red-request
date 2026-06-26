<script lang="ts">
  import { brand } from "../brand.generated";
</script>

<div class="closing-overlay" role="status" aria-live="assertive" aria-label="Closing">
  <div class="closing-panel">
    <div class="closing-spinner" aria-hidden="true"></div>
    <div class="min-w-0">
      <div class="text-sm font-semibold text-fg-strong">Closing...</div>
      <div class="mt-1 truncate text-xs text-fg-muted">
        {brand.productName} is finishing up.
      </div>
    </div>
  </div>
</div>
