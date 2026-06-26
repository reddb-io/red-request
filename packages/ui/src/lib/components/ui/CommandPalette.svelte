<script lang="ts">
  // Command palette: search stored request documents to jump to one, plus quick actions.
  import * as Command from "./command/index.js";
  import { ws } from "../../store.svelte";
  import * as repo from "../../repo";
  import type { RequestDefinition } from "@red-request/core";

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

  async function navigateToRequest(r: PaletteRequest): Promise<void> {
    ws.view = "requests";
    ws.selectRequest(r.colId, r.reqId);
    if (ws.activeColId === r.colId && ws.activeReq?.id === r.reqId) return;
    await ws.reload().catch(() => {});
    ws.view = "requests";
    ws.selectRequest(r.colId, r.reqId);
  }
</script>

{#snippet action(label: string, hint: string, fn: () => void)}
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

    <Command.Group heading="Actions">
      {@render action("New request", "create", () => ws.addRequest(""))}
      {#if ws.activeReq}
        {@render action("Send request", "⏎", () => ws.send())}
        {@render action("Save request", "save", () => ws.save())}
        {@render action("Duplicate request", "copy", () =>
          ws.duplicateRequest(ws.activeReq!.id)
        )}
      {/if}
      {@render action("Home", "view", () => (ws.view = "home"))}
      {@render action("Requests", "view", () => (ws.view = "requests"))}
      {@render action("Settings", "view", () => (ws.view = "settings"))}
      {@render action("Switch project…", "selector", () => ws.backToSelector())}
    </Command.Group>
  </Command.List>
</Command.Dialog>
