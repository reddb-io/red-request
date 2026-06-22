<script lang="ts">
  // Classic cartoon "iris wipe" played while a project opens. A transparent
  // circle centered on screen is ringed by an enormous black box-shadow that fills
  // everything else — shrink the circle to 0 and the screen goes black; grow it
  // back and the workspace is revealed. The store sequences the phases (closing →
  // hold → opening) and swaps the underlying screen while we're fully black.
  //
  // The open/closed sizes are real lengths toggled via a CLASS (not a CSS var):
  // custom-property changes don't trigger `transition`, which is what made the
  // earlier version jump between 3 sizes instead of animating. Durations here
  // MIRROR the delays in store.svelte.ts chooseProject().
  import { onMount } from "svelte";
  import { ws } from "../store.svelte";

  let mounted = $state(false);
  onMount(() => {
    // Paint one frame at the OPEN size, then flip to closed so the circle
    // animates shut instead of starting already-closed.
    requestAnimationFrame(() => requestAnimationFrame(() => (mounted = true)));
  });

  // Circle is large (revealed) before the close starts and again while opening.
  const open = $derived(!mounted || ws.transitionPhase === "opening");
</script>

<!-- .iris / .hole styles live in app.css (global) — see note there. -->
<div class="iris" aria-hidden="true">
  <div
    class="hole"
    class:open={open}
    class:opening={ws.transitionPhase === "opening"}
  ></div>
</div>
