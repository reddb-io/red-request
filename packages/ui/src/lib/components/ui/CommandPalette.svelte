<script lang="ts">
  // Command palette: search stored request documents to jump to one, plus quick actions.
  import * as Command from "./command/index.js";
  import { ws } from "../../store.svelte";
  import * as repo from "../../repo";
  import type { HistoryEntry, RequestDefinition } from "@reddb-io/request-core";

  let { open = $bindable(false) }: { open?: boolean } = $props();

  const methodColor: Record<string, string> = {
    GET: "text-emerald-400",
    POST: "text-amber-400",
    PUT: "text-blue-400",
    PATCH: "text-purple-400",
    DELETE: "text-red-400",
  };

  type PaletteRequest = {
    colId: string;
    col: string;
    reqId: string;
    name: string;
    kind: RequestDefinition["kind"];
    method: string;
    target: string;
    folder: string;
    searchValue: string;
  };

  let query = $state("");
  let searchResults = $state<PaletteRequest[]>([]);
  let searchedQuery = $state<string | null>(null);
  let searchFailed = $state(false);
  let searchLoading = $state(false);
  let searchTicket = 0;
  let recentHistory = $state<HistoryEntry[]>([]);
  let historyTicket = 0;

  const collectionNameById = $derived(
    new Map(ws.collections.map((c) => [c.id, c.collection.name]))
  );

  const localRequests = $derived(
    ws.collections.flatMap((c) =>
      c.requests.map((r) => requestFromLocal(c.id, c.collection.name, r))
    )
  );

  const normalizedQuery = $derived(normalizeQuery(query));
  const filteredLocalRequests = $derived(
    localRequests.filter((r) => matchesRequest(r, normalizedQuery))
  );
  const useSearchResults = $derived(
    searchedQuery === normalizedQuery && !searchFailed
  );
  const requests = $derived(
    useSearchResults
      ? mergeRequests(searchResults, filteredLocalRequests)
      : filteredLocalRequests
  );
  const runnableRequests = $derived(
    orderRunnableRequests(localRequests, recentHistory, normalizedQuery)
  );

  $effect(() => {
    if (!open) return;
    const q = query.trim();
    const ticket = ++searchTicket;
    searchLoading = true;
    searchFailed = false;
    const delay = q ? 120 : 0;
    const timer = window.setTimeout(() => {
      void repo
        .searchRequests(q, 40)
        .then((results) => {
          if (ticket !== searchTicket) return;
          searchResults = results.map(requestFromSearchResult);
          searchedQuery = normalizeQuery(q);
          searchLoading = false;
        })
        .catch(() => {
          if (ticket !== searchTicket) return;
          searchResults = [];
          searchedQuery = normalizeQuery(q);
          searchFailed = true;
          searchLoading = false;
        });
    }, delay);

    return () => window.clearTimeout(timer);
  });

  $effect(() => {
    if (!open) return;
    const ticket = ++historyTicket;
    void repo
      .loadHistory()
      .then((history) => {
        if (ticket !== historyTicket) return;
        recentHistory = history;
      })
      .catch(() => {
        if (ticket !== historyTicket) return;
        recentHistory = [];
      });
  });

  function normalizeQuery(value: string): string {
    return value.trim().toLowerCase();
  }

  function requestTarget(req: RequestDefinition): string {
    if (req.kind === "grpc") {
      const method = [req.grpc.service, req.grpc.method]
        .filter(Boolean)
        .join("/");
      return [req.url, method].filter(Boolean).join(" ");
    }
    if (req.url) return req.url;
    if (!req.net.host) return "";
    return req.net.port ? `${req.net.host}:${req.net.port}` : req.net.host;
  }

  function requestFromLocal(
    colId: string,
    col: string,
    req: RequestDefinition
  ): PaletteRequest {
    const target = requestTarget(req);
    const method = req.kind === "http" ? req.method : "";
    const folder = req.folder ?? "";
    return {
      colId,
      col,
      reqId: req.id,
      name: req.name,
      kind: req.kind,
      method,
      target,
      folder,
      searchValue: searchValue({
        col,
        folder,
        name: req.name,
        kind: req.kind,
        method,
        target,
      }),
    };
  }

  function requestFromSearchResult(
    result: repo.RequestSearchResult
  ): PaletteRequest {
    const col = collectionNameById.get(result.collectionId) ?? result.collectionId;
    return {
      colId: result.collectionId,
      col,
      reqId: result.requestId,
      name: result.name,
      kind: result.kind,
      method: result.method,
      target: result.target || result.url,
      folder: result.folder,
      searchValue: searchValue({
        col,
        folder: result.folder,
        name: result.name,
        kind: result.kind,
        method: result.method,
        target: result.target || result.url,
      }),
    };
  }

  function searchValue(parts: {
    col: string;
    folder: string;
    name: string;
    kind: string;
    method: string;
    target: string;
  }): string {
    return [
      parts.col,
      parts.folder,
      parts.name,
      parts.kind,
      parts.method,
      parts.target,
    ]
      .filter(Boolean)
      .join(" ");
  }

  function matchesRequest(r: PaletteRequest, q: string): boolean {
    if (!q) return true;
    const haystack = r.searchValue.toLowerCase();
    return q.split(/\s+/).every((term) => haystack.includes(term));
  }

  function mergeRequests(
    primary: PaletteRequest[],
    fallback: PaletteRequest[]
  ): PaletteRequest[] {
    const seen = new Set<string>();
    const out: PaletteRequest[] = [];
    for (const r of [...primary, ...fallback]) {
      const key = `${r.colId}.${r.reqId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
    return out;
  }

  function orderRunnableRequests(
    candidates: PaletteRequest[],
    history: HistoryEntry[],
    q: string
  ): PaletteRequest[] {
    const byKey = new Map(candidates.map((r) => [requestKey(r), r]));
    const seen = new Set<string>();
    const out: PaletteRequest[] = [];
    for (const h of [...history].sort((a, b) => b.ts - a.ts)) {
      const key = `${h.collectionId}.${h.reqId}`;
      if (seen.has(key)) continue;
      const request = byKey.get(key);
      if (!request || !matchesRequest(request, q)) continue;
      seen.add(key);
      out.push(request);
    }
    for (const request of candidates) {
      const key = requestKey(request);
      if (seen.has(key) || !matchesRequest(request, q)) continue;
      seen.add(key);
      out.push(request);
    }
    return out.slice(0, 12);
  }

  function requestKey(r: PaletteRequest): string {
    return `${r.colId}.${r.reqId}`;
  }

  function badge(r: PaletteRequest): string {
    return r.kind === "http" ? r.method : r.kind.toUpperCase();
  }

  function locationLabel(r: PaletteRequest): string {
    return r.folder ? `${r.col}/${r.folder}` : r.col;
  }

  function go(fn: () => void | Promise<void>) {
    open = false;
    void fn();
  }

  function openSettings(section: typeof ws.settingsSection) {
    ws.settingsSection = section;
    ws.view = "settings";
  }

  async function createCollection() {
    ws.view = "requests";
    await ws.addCollection();
  }

  async function createRequest() {
    ws.view = "requests";
    if (!ws.activeColId) {
      await ws.addCollection();
    }
    await ws.addRequest("");
  }

  async function selectPaletteRequest(r: PaletteRequest): Promise<boolean> {
    ws.view = "requests";
    ws.selectRequest(r.colId, r.reqId);
    if (ws.activeColId === r.colId && ws.activeReq?.id === r.reqId) return true;
    await ws.reload().catch(() => {});
    ws.view = "requests";
    ws.selectRequest(r.colId, r.reqId);
    return ws.activeColId === r.colId && ws.activeReq?.id === r.reqId;
  }

  async function navigateToRequest(r: PaletteRequest): Promise<void> {
    await selectPaletteRequest(r);
  }

  async function runRequest(r: PaletteRequest): Promise<void> {
    if (!(await selectPaletteRequest(r))) return;
    await ws.send();
  }
</script>

{#snippet action(label: string, hint: string, fn: () => void | Promise<void>)}
  <Command.Item value={label} onSelect={() => go(fn)}>
    <span class="truncate">{label}</span>
    <span class="hint ml-auto">{hint}</span>
  </Command.Item>
{/snippet}

<Command.Dialog bind:open>
  <Command.Input bind:value={query} placeholder="Search requests, run actions…" />
  <Command.List>
    <Command.Empty>{searchLoading ? "Searching…" : "No results."}</Command.Empty>

    <Command.Group heading="Requests">
      {#each requests as r (r.colId + r.reqId)}
        <Command.Item
          value={r.searchValue}
          class="items-start py-2"
          onSelect={() => go(() => navigateToRequest(r))}
        >
          <span
            class="mono w-12 shrink-0 pt-0.5 text-xs font-bold {r.kind === 'http'
              ? (methodColor[r.method] ?? 'text-fg-muted')
              : 'text-fg-muted'}"
            >{badge(r)}</span
          >
          <span class="min-w-0 flex-1">
            <span class="block truncate">{r.name}</span>
            {#if r.target}
              <span class="hint block truncate text-xs">{r.target}</span>
            {/if}
          </span>
          <span class="hint ml-auto max-w-[38%] truncate pl-2 text-right"
            >{locationLabel(r)}</span
          >
        </Command.Item>
      {/each}
    </Command.Group>

    <Command.Separator />

    <Command.Group heading="Run">
      {#each runnableRequests as r (r.colId + r.reqId)}
        <Command.Item
          value={`run ${r.searchValue}`}
          class="items-start py-2"
          onSelect={() => go(() => runRequest(r))}
        >
          <span
            class="mono w-12 shrink-0 pt-0.5 text-xs font-bold {r.kind === 'http'
              ? (methodColor[r.method] ?? 'text-fg-muted')
              : 'text-fg-muted'}"
            >{badge(r)}</span
          >
          <span class="min-w-0 flex-1">
            <span class="block truncate">Run: {r.name}</span>
            {#if r.target}
              <span class="hint block truncate text-xs">{r.target}</span>
            {/if}
          </span>
          <span class="hint ml-auto max-w-[38%] truncate pl-2 text-right"
            >{locationLabel(r)}</span
          >
        </Command.Item>
      {/each}
    </Command.Group>

    <Command.Separator />

    <Command.Group heading="Actions">
      {@render action("Create collection", "new", createCollection)}
      {@render action("New request", "create", createRequest)}
      {#if ws.activeReq}
        {@render action("Send request", "⏎", () => ws.send())}
        {@render action("Save request", "save", () => ws.save())}
        {@render action("Duplicate request", "copy", () =>
          ws.duplicateRequest(ws.activeReq!.id)
        )}
      {/if}
      {@render action("Home", "view", () => {
        ws.view = "home";
      })}
      {@render action("Requests", "view", () => {
        ws.view = "requests";
      })}
      {#if ws.redUiEnabled}
        {@render action("Database", "view", () => {
          ws.view = "database";
        })}
      {/if}
      {@render action("Settings", "view", () => {
        ws.view = "settings";
      })}
      {@render action("Settings: environments", "config", () => openSettings("environments"))}
      {@render action("Settings: globals", "config", () => openSettings("environments"))}
      {@render action("Settings: global variable", "config", () => openSettings("environments"))}
      {@render action("Settings: global secret", "config", () => openSettings("environments"))}
      {@render action("Settings: proxies", "config", () => openSettings("proxies"))}
      {@render action("Settings: profiles", "config", () => openSettings("profiles"))}
      {@render action("Settings: data", "config", () => openSettings("data"))}
      {@render action("Switch project…", "selector", () => ws.backToSelector())}
    </Command.Group>
  </Command.List>
</Command.Dialog>
