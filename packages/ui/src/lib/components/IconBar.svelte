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

  function switchProject() {
    ws.backToSelector();
  }

  let lastRailAction = "";
  let lastRailActionAt = 0;

  function railButtonFromEvent(event: Event): HTMLElement | null {
    if (!(event.target instanceof Element)) return null;
    return event.target.closest<HTMLElement>("[data-app-rail-action]");
  }

  function activateRailButton(button: HTMLElement) {
    const view = button.dataset.appRailView as AppView | undefined;
    const action = view ? `view:${view}` : button.dataset.appRailAction;
    const now = Date.now();
    if (action === lastRailAction && now - lastRailActionAt < 250) return;
    lastRailAction = action ?? "";
    lastRailActionAt = now;

    if (view) {
      selectView(view);
      return;
    }
    if (button.dataset.appRailAction === "switch-project") switchProject();
  }

  function handleRailActivation(event: MouseEvent | PointerEvent) {
    if (event.button !== 0) return;
    const button = railButtonFromEvent(event);
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    activateRailButton(button);
  }
</script>

<nav
  class="pointer-events-auto relative z-[3000] isolate flex w-12 shrink-0 select-none flex-col items-center gap-1 border-r border-border bg-[var(--color-bg-0)] py-2"
  aria-label="Primary"
  onpointerdowncapture={handleRailActivation}
  onmousedowncapture={handleRailActivation}
  onclickcapture={handleRailActivation}
>
  {#each items as it (it.view)}
    {@const active = ws.view === it.view}
    <button
      type="button"
      title={it.label}
      data-app-rail-action="view"
      data-app-rail-view={it.view}
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
    data-app-rail-action="switch-project"
    class="mt-auto grid h-9 w-9 place-items-center rounded-lg text-red-900 transition-colors hover:bg-[var(--color-bg-1)] hover:text-[var(--color-brand)]"
    aria-label="switch project"
  >
    <ArrowLeftRight size={16} strokeWidth={2} />
  </button>
</nav>
