<script lang="ts">
  // Vertical icon rail (VSCode-style) — the app's top-level navigation. Selects
  // ws.view: Home (dashboard + network pool), Requests (the workspace), Settings.
  // Icons go vivid brand-red when their view is active, dark red when idle and
  // brighten toward brand on hover. The brand monogram sits at the top; the
  // project switcher anchors the bottom.
  import { ws } from "../store.svelte";
  import Tooltip from "./ui/Tooltip.svelte";
  import { projectLabel } from "../project";
  import House from "@lucide/svelte/icons/house";
  import Send from "@lucide/svelte/icons/send";
  import Settings from "@lucide/svelte/icons/settings";
  import ArrowLeftRight from "@lucide/svelte/icons/arrow-left-right";
  import type { Component } from "svelte";

  type View = "home" | "requests" | "settings";
  const items: { view: View; icon: Component; label: string }[] = [
    { view: "home", icon: House, label: "Home — dashboard & network pool" },
    { view: "requests", icon: Send, label: "Requests — collections & workspace" },
    { view: "settings", icon: Settings, label: "Settings — project configuration" },
  ];
</script>

<nav
  class="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border bg-[var(--color-bg-0)] py-2"
  aria-label="Primary"
>
  {#each items as it (it.view)}
    {@const active = ws.view === it.view}
    <Tooltip text={it.label} side="right">
      {#snippet children(p)}
        <button
          {...p}
          onclick={() => (ws.view = it.view)}
          class="grid h-9 w-9 place-items-center rounded-lg transition-colors
            {active
            ? 'bg-[var(--color-bg-2)] text-[var(--color-brand)]'
            : 'text-red-900 hover:bg-[var(--color-bg-1)] hover:text-[var(--color-brand)]'}"
          aria-label={it.label}
          aria-current={active ? "page" : undefined}
        >
          <it.icon size={18} strokeWidth={active ? 2.5 : 2} />
        </button>
      {/snippet}
    </Tooltip>
  {/each}

  <Tooltip text="Switch project — {projectLabel(ws.project)}" side="right">
    {#snippet children(p)}
      <button
        {...p}
        onclick={() => ws.backToSelector()}
        class="mt-auto grid h-9 w-9 place-items-center rounded-lg text-red-900 transition-colors hover:bg-[var(--color-bg-1)] hover:text-[var(--color-brand)]"
        aria-label="switch project"
      >
        <ArrowLeftRight size={16} strokeWidth={2} />
      </button>
    {/snippet}
  </Tooltip>
</nav>
