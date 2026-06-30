<script lang="ts">
  import { onDestroy } from "svelte";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ChevronUp from "@lucide/svelte/icons/chevron-up";
  import CircleAlert from "@lucide/svelte/icons/circle-alert";
  import Copy from "@lucide/svelte/icons/copy";
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
  ];

  let state = $state(developerConsole.snapshot);
  const unsubscribe = developerConsole.subscribe((next) => {
    state = next;
  });
  onDestroy(unsubscribe);

  const filteredEntries = $derived(state.filteredEntries);
  const latest = $derived(state.latest);
  const selected = $derived(state.selected);
  const errorCount = $derived(state.errorCount);

  function timeLabel(ts: number): string {
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
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

  function levelDotClass(level: DeveloperConsoleEntry["level"]): string {
    if (level === "error") return "bg-red-400";
    if (level === "warn") return "bg-amber-300";
    if (level === "info") return "bg-emerald-400";
    return "bg-fg-faint";
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

  // Best-effort: if the detail looks like JSON, render it pretty-printed. Plain
  // text and SQL/RQL pass through with only whitespace collapsed.
  function prettify(detail: string): string {
    const trimmed = detail.trim();
    if (!trimmed) return "";
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        return JSON.stringify(JSON.parse(trimmed), null, 2);
      } catch {
        /* fall through */
      }
    }
    return detail.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  }

  // Pretty `key = value` lists into aligned columns when at least 2 lines match.
  // No-op otherwise — RQL/SQL flows through unchanged.
  function alignKv(detail: string): string {
    const lines = detail.split("\n").filter((line) => line.includes(" = "));
    if (lines.length < 2) return detail;
    const width = Math.max(...lines.map((line) => line.indexOf(" = ")));
    return lines
      .map((line) => {
        const i = line.indexOf(" = ");
        return `${line.slice(0, i).padEnd(width)}= ${line.slice(i + 3)}`;
      })
      .join("\n");
  }

  // Human-readable byte size for the Response header (e.g. "1.4 KB", "512 B").
  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }

  // Copy the selected entry (or just its payload) to the clipboard. Both shapes
  // are useful: full entry for "send this to support", payload-only for "paste
  // a RedDB response into a script".
  function copyPayload() {
    const sel = developerConsole.selected;
    if (!sel) return;
    const text = sel.payload ?? sel.detail ?? sel.message;
    navigator.clipboard
      ?.writeText(text)
      .catch(() => {
        /* clipboard may be unavailable (HTTP, sandboxed); ignore silently */
      });
  }
</script>

<section class="shrink-0 border-t border-border bg-[var(--color-bg-0)]">
  <div class="flex h-9 items-center gap-2 px-3">
    <button
      type="button"
      class="flex min-w-0 shrink-0 items-center gap-2 text-left text-xs text-fg-muted transition-colors hover:text-fg"
      aria-label={state.open ? "Close developer console" : "Open developer console"}
      aria-expanded={state.open}
      onclick={() => developerConsole.toggle()}
    >
      <TerminalSquare size={14} aria-hidden="true" />
      <span class="font-semibold text-fg">Developer</span>
      <span class="text-fg-subtle">{state.entries.length}</span>
      {#if errorCount > 0}
        <span class="inline-flex items-center gap-1 text-red-300">
          <CircleAlert size={13} aria-hidden="true" />{errorCount}
        </span>
      {/if}
    </button>

    <div class="ml-auto flex items-center gap-1" aria-label="Developer console filters">
      <ListFilter size={13} class="mr-1 text-fg-subtle" aria-hidden="true" />
      {#each filters as filter (filter.value)}
        <button
          type="button"
          class="rounded px-2 py-0.5 text-[11px] transition-colors {state.filter ===
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
    <!-- Two columns: compact log list (left) + detail/prettified payload (right). -->
    <div class="grid h-72 grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] border-t border-border bg-[var(--color-bg-1)]">
      <!-- LEFT: single-row entries. Click loads the right pane. -->
      <div class="overflow-auto border-r border-border">
        {#if filteredEntries.length === 0}
          <div class="grid h-full place-items-center px-4 text-center text-xs text-fg-subtle">
            {state.entries.length === 0
              ? "No activity yet — send a request or open the database view."
              : "No events for this filter."}
          </div>
        {:else}
          <ol>
            {#each filteredEntries as entry (entry.id)}
              <li>
                <button
                  type="button"
                  aria-pressed={state.selected?.id === entry.id}
                  onclick={() => developerConsole.select(entry.id)}
                  class="grid w-full grid-cols-[0.5rem_3.75rem_3.75rem_minmax(0,1fr)_auto] items-center gap-2 border-b border-border/60 px-2 py-1 text-left text-xs transition-colors hover:bg-[var(--color-bg-2)] {state.selected?.id ===
                  entry.id
                    ? 'bg-[var(--color-bg-2)]'
                    : ''}"
                >
                  <span class="h-1.5 w-1.5 rounded-full {levelDotClass(entry.level)}"></span>
                  <time
                    class="mono whitespace-nowrap text-fg-faint"
                    datetime={new Date(entry.ts).toISOString()}
                    >{timeLabel(entry.ts)}</time
                  >
                  <span class="capitalize {levelClass(entry.level)}">{sourceLabel(entry.source)}</span>
                  <span class="truncate text-fg">{entry.message}</span>
                  <span class="mono whitespace-nowrap text-fg-subtle">{meta(entry)}</span>
                </button>
              </li>
            {/each}
          </ol>
        {/if}
      </div>

      <!-- RIGHT: prettified detail. Empty until the user picks an entry. -->
      <div class="flex min-h-0 flex-col">
        {#if selected}
          <div class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
            <time class="mono text-fg-faint" datetime={new Date(selected.ts).toISOString()}
              >{timeLabel(selected.ts)}</time
            >
            <span class="capitalize {levelClass(selected.level)}">{sourceLabel(selected.source)}</span>
            <span class="truncate text-fg">{selected.message}</span>
            <span class="mono whitespace-nowrap text-fg-subtle">{meta(selected)}</span>
            <button
              type="button"
              class="ml-auto rounded p-1 text-fg-subtle transition-colors hover:bg-[var(--color-bg-2)] hover:text-fg"
              aria-label="copy entry payload"
              title="Copy entry payload"
              onclick={copyPayload}
            >
              <Copy size={13} />
            </button>
          </div>
          <div class="min-h-0 flex-1 overflow-auto px-3 py-2">
            {#if selected.detail}
              <div class="mb-2">
                <div
                  class="mb-1 text-[10px] font-semibold tracking-wide text-fg-faint uppercase"
                >
                  Request
                </div>
                <pre
                  class="mono whitespace-pre-wrap break-words rounded bg-[var(--color-bg-0)] px-2 py-1.5 text-[11px] leading-5 text-fg-muted">{alignKv(prettify(selected.detail))}</pre>
              </div>
            {/if}
            {#if selected.payload}
              <div>
                <div
                  class="mb-1 flex items-center gap-2 text-[10px] font-semibold tracking-wide text-fg-faint uppercase"
                >
                  <span>Response</span>
                  {#if selected.bytes !== undefined}
                    <span class="mono font-normal">({formatBytes(selected.bytes)})</span>
                  {/if}
                </div>
                <pre
                  class="mono whitespace-pre-wrap break-words rounded bg-[var(--color-bg-0)] px-2 py-1.5 text-[11px] leading-5 text-fg-muted">{alignKv(prettify(selected.payload))}</pre>
              </div>
            {:else if !selected.detail}
              <!-- Fallback when the entry has neither detail nor payload (e.g. app logs). -->
              <pre
                class="mono whitespace-pre-wrap break-words rounded bg-[var(--color-bg-0)] px-2 py-1.5 text-[11px] leading-5 text-fg-muted">{alignKv(prettify(selected.message))}</pre>
            {/if}
          </div>
        {:else}
          <div class="grid h-full place-items-center px-4 text-center text-xs text-fg-subtle">
            {#if latest}
              <div>
                <p>Select a log entry to inspect it.</p>
                <p class="mono mt-1 text-fg-faint">Latest: {latest.message}</p>
              </div>
            {:else}
              <p>Select a log entry to inspect it.</p>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  {/if}
</section>
