<script lang="ts">
  import { onDestroy } from "svelte";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ChevronUp from "@lucide/svelte/icons/chevron-up";
  import CircleAlert from "@lucide/svelte/icons/circle-alert";
  import Database from "@lucide/svelte/icons/database";
  import ListFilter from "@lucide/svelte/icons/list-filter";
  import TerminalSquare from "@lucide/svelte/icons/terminal-square";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    developerConsole,
    type DeveloperConsoleEntry,
    type DeveloperConsoleFilter,
  } from "$lib/developer-console.svelte";

  const filters: { value: DeveloperConsoleFilter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "app", label: "App" },
    { value: "reddb", label: "RedDB" },
    { value: "engine", label: "Engine" },
  ];

  let state = $state(developerConsole.snapshot);
  const unsubscribe = developerConsole.subscribe((next) => {
    state = next;
  });
  onDestroy(unsubscribe);

  const filteredEntries = $derived(state.filteredEntries);
  const latest = $derived(state.latest);
  const errorCount = $derived(state.errorCount);

  function timeLabel(ts: number): string {
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function levelClass(level: DeveloperConsoleEntry["level"]): string {
    if (level === "error") return "text-red-300";
    if (level === "warn") return "text-amber-300";
    if (level === "info") return "text-fg";
    return "text-fg-muted";
  }

  function sourceLabel(source: DeveloperConsoleEntry["source"]): string {
    return source === "reddb" ? "RedDB" : source;
  }

  function meta(entry: DeveloperConsoleEntry): string {
    const parts: string[] = [];
    if (entry.status !== undefined) parts.push(String(entry.status));
    if (entry.rows !== undefined) parts.push(`${entry.rows} rows`);
    if (entry.durationMs !== undefined) parts.push(`${entry.durationMs} ms`);
    if (entry.attempts && entry.attempts > 1) parts.push(`${entry.attempts} tries`);
    if (entry.bytes !== undefined) parts.push(`${entry.bytes} B`);
    return parts.join(" · ");
  }
</script>

<section class="shrink-0 border-t border-border bg-[var(--color-bg-0)]">
  <div class="flex h-9 items-center gap-2 px-3">
    <button
      type="button"
      class="flex min-w-0 flex-1 items-center gap-2 text-left text-xs text-fg-muted transition-colors hover:text-fg"
      aria-label={state.open ? "Close developer console" : "Open developer console"}
      aria-expanded={state.open}
      onclick={() => developerConsole.toggle()}
    >
      <TerminalSquare size={14} aria-hidden="true" />
      <span class="font-semibold text-fg">Developer</span>
      <span class="text-fg-subtle">{state.entries.length} events</span>
      {#if errorCount > 0}
        <span class="inline-flex items-center gap-1 text-red-300">
          <CircleAlert size={13} aria-hidden="true" />{errorCount}
        </span>
      {/if}
      {#if latest}
        <span class="min-w-0 truncate">
          <span class="text-fg-subtle">{sourceLabel(latest.source)}</span>
          <span class="mx-1 text-fg-faint">/</span>{latest.message}
        </span>
      {:else}
        <span class="text-fg-subtle">No activity yet</span>
      {/if}
    </button>

    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={state.open ? "Collapse developer console" : "Expand developer console"}
      title={state.open ? "Close developer console" : "Open developer console"}
      onclick={() => developerConsole.toggle()}
    >
      {#if state.open}
        <ChevronDown size={14} />
      {:else}
        <ChevronUp size={14} />
      {/if}
    </Button>
  </div>

  {#if state.open}
    <div class="h-64 border-t border-border bg-[var(--color-bg-1)]">
      <div class="flex h-10 items-center gap-2 border-b border-border px-3">
        <Database size={14} class="text-[var(--color-brand)]" aria-hidden="true" />
        <div class="text-xs font-semibold text-fg">App and RedDB activity</div>
        <div class="ml-auto flex items-center gap-1" aria-label="Developer console filters">
          <ListFilter size={13} class="mr-1 text-fg-subtle" aria-hidden="true" />
          {#each filters as filter (filter.value)}
            <button
              type="button"
              class="rounded px-2 py-1 text-[11px] transition-colors {state.filter ===
              filter.value
                ? 'bg-[var(--color-bg-3)] text-fg'
                : 'text-fg-subtle hover:bg-[var(--color-bg-2)] hover:text-fg'}"
              aria-pressed={state.filter === filter.value}
              onclick={() => developerConsole.setFilter(filter.value)}
            >
              {filter.label}
            </button>
          {/each}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Clear developer console"
            title="Clear developer console"
            onclick={() => developerConsole.clear()}
          >
            <Trash2 size={13} />
          </Button>
        </div>
      </div>

      {#if filteredEntries.length === 0}
        <div class="grid h-[calc(16rem-2.5rem)] place-items-center text-xs text-fg-subtle">
          No events for this filter.
        </div>
      {:else}
        <ol class="h-[calc(16rem-2.5rem)] overflow-auto px-3 py-2">
          {#each filteredEntries as entry (entry.id)}
            <li class="grid grid-cols-[5.5rem_4.5rem_minmax(0,1fr)_auto] gap-2 border-b border-border/70 py-1.5 text-xs last:border-b-0">
              <time class="mono text-fg-faint" datetime={new Date(entry.ts).toISOString()}
                >{timeLabel(entry.ts)}</time
              >
              <span class="capitalize {levelClass(entry.level)}">{sourceLabel(entry.source)}</span>
              <div class="min-w-0">
                <div class="truncate text-fg">{entry.message}</div>
                {#if entry.detail}
                  <pre class="mono mt-1 max-h-20 overflow-auto whitespace-pre-wrap rounded bg-[var(--color-bg-0)] px-2 py-1 text-[11px] leading-5 text-fg-muted">{entry.detail}</pre>
                {/if}
              </div>
              <span class="mono whitespace-nowrap text-fg-subtle">{meta(entry)}</span>
            </li>
          {/each}
        </ol>
      {/if}
    </div>
  {/if}
</section>
