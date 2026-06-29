<script lang="ts">
  import * as Tooltip from "$lib/components/ui/tooltip/index.js";
  import Sidebar from "$lib/components/Sidebar.svelte";
</script>

<Tooltip.Provider delayDuration={0} disableHoverableContent>
  <Sidebar />
</Tooltip.Provider>
