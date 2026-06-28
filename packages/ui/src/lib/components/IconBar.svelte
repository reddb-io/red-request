<script lang="ts">
  // Vertical icon rail (VSCode-style) — the app's top-level navigation. Selects
  // ws.view: Home (dashboard + network pool), Requests, optional Database, Settings.
  // Icons go vivid brand-red when their view is active, dark red when idle and
  // brighten toward brand on hover. The brand monogram sits at the top; the
  // project switcher anchors the bottom.
  import { ws } from "../store.svelte";
  import { projectLabel } from "../project";
  import House from "@lucide/svelte/icons/house";
  import Send from "@lucide/svelte/icons/send";
  import Database from "@lucide/svelte/icons/database";
  import Settings from "@lucide/svelte/icons/settings";
  import ArrowLeftRight from "@lucide/svelte/icons/arrow-left-right";
  import type { Component } from "svelte";
  import type { AppView } from "../store.svelte";

  type NavItem = { view: AppView; icon: Component<any>; label: string };
  const items = $derived.by<NavItem[]>(() => {
    const out: NavItem[] = [
      { view: "home", icon: House, label: "Home: dashboard and network pool" },
      { view: "requests", icon: Send, label: "Requests: collections and workspace" },
    ];
    if (ws.redUiEnabled) {
      out.push({
        view: "database",
        icon: Database,
        label: "Database: inspect request store",
      });
    }
    out.push({ view: "settings", icon: Settings, label: "Settings: project configuration" });
    return out;
  });

  function selectView(view: AppView) {
    ws.view = view;
  }

  function selectViewFromPointer(event: PointerEvent, view: AppView) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    selectView(view);
  }

  function switchProject() {
    ws.backToSelector();
  }

  function switchProjectFromPointer(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    switchProject();
  }
</script>

<nav
  class="relative z-[1500] isolate flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border bg-[var(--color-bg-0)] py-2"
  aria-label="Primary"
>
  {#each items as it (it.view)}
    {@const active = ws.view === it.view}
    <button
      type="button"
      title={it.label}
      onpointerdown={(event) => selectViewFromPointer(event, it.view)}
      onclick={() => selectView(it.view)}
      class="grid h-9 w-9 place-items-center rounded-lg transition-colors
        {active
        ? 'bg-[var(--color-bg-2)] text-[var(--color-brand)]'
        : 'text-red-900 hover:bg-[var(--color-bg-1)] hover:text-[var(--color-brand)]'}"
      aria-label={it.label}
      aria-current={active ? "page" : undefined}
    >
      <it.icon size={18} strokeWidth={active ? 2.5 : 2} />
    </button>
  {/each}

  <button
    type="button"
    title="Switch project — {projectLabel(ws.project)}"
    onpointerdown={switchProjectFromPointer}
    onclick={switchProject}
    class="mt-auto grid h-9 w-9 place-items-center rounded-lg text-red-900 transition-colors hover:bg-[var(--color-bg-1)] hover:text-[var(--color-brand)]"
    aria-label="switch project"
  >
    <ArrowLeftRight size={16} strokeWidth={2} />
  </button>
</nav>
