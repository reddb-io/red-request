<script lang="ts">
  import { folderName, type FolderConfig, type Kv } from "@reddb-io/request-core";
  import { ws } from "../store.svelte";
  import AuthEditor from "./AuthEditor.svelte";
  import KeyValueEditor from "./KeyValueEditor.svelte";
  import { Button } from "./ui/button/index.js";
  import * as Tabs from "./ui/tabs/index.js";

  type VarRow = { name: string; value: string };

  let tab = $state("auth");
  let vars = $state<VarRow[]>([]);
  let headerRows = $state<Kv[]>([]);
  let varsKey = $state("");
  let syncingRows = false;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  const target = $derived(ws.scopeConfigTarget);
  const col = $derived(ws.scopeConfigCollection);
  const folder = $derived<FolderConfig | null>(
    target?.kind === "folder" && col
      ? (col.collection.folders.find((item) => folderName(item) === target.folder) ?? null)
      : null
  );
  const scope = $derived(
    target?.kind === "folder" ? folder : (col?.collection ?? null)
  );
  const title = $derived(
    target?.kind === "folder"
      ? target.folder
      : (col?.collection.name ?? "Scope")
  );
  const subtitle = $derived(
    target?.kind === "folder"
      ? (col ? `${col.collection.name} / folder` : "Folder")
      : "Collection"
  );
  const canInheritAuth = $derived(target?.kind === "folder");

  function schedulePersist() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void ws.persistScopeConfig();
    }, 150);
  }

  function syncVarsFromScope() {
    const nextKey = target
      ? `${target.kind}:${target.colId}:${target.kind === "folder" ? target.folder : ""}`
      : "";
    if (nextKey === varsKey) return;
    syncingRows = true;
    varsKey = nextKey;
    vars = Object.entries(scope?.vars ?? {}).map(([name, value]) => ({
      name,
      value,
    }));
    headerRows =
      target?.kind === "folder"
        ? structuredClone(folder?.headers ?? [])
        : structuredClone(col?.collection.defaultHeaders ?? []);
    queueMicrotask(() => {
      syncingRows = false;
    });
  }

  $effect(syncVarsFromScope);

  $effect(() => {
    if (!target || !scope) return;
    JSON.stringify(scope.auth);
    schedulePersist();
  });

  $effect(() => {
    if (!target || !scope || syncingRows) return;
    JSON.stringify(headerRows);
    if (target.kind === "folder" && folder) {
      folder.headers = headerRows;
    } else if (col) {
      col.collection.defaultHeaders = headerRows;
    }
    schedulePersist();
  });

  function addVar() {
    vars = [...vars, { name: "", value: "" }];
    applyVars();
  }

  function removeVar(index: number) {
    vars = vars.filter((_, candidate) => candidate !== index);
    applyVars();
  }

  function applyVars() {
    if (!scope) return;
    const next: Record<string, string> = {};
    for (const row of vars) {
      const name = row.name.trim();
      if (name) next[name] = row.value;
    }
    scope.vars = next;
    schedulePersist();
  }

</script>

{#if target && col && scope}
  <div class="flex h-full min-w-0 flex-col overflow-hidden bg-[var(--color-bg-0)]">
    <div class="border-b border-border px-4 py-3">
      <div class="flex min-w-0 items-center justify-between gap-3">
        <div class="min-w-0">
          <p class="label text-[var(--color-brand)]">{subtitle}</p>
          <h2 class="truncate text-base font-semibold text-fg-strong">{title}</h2>
        </div>
        <Button onclick={() => (ws.view = "requests")} variant="ghost" size="xs">
          Close
        </Button>
      </div>
    </div>

    <Tabs.Root bind:value={tab} class="min-h-0 flex-1 overflow-hidden p-4">
      <Tabs.List variant="line" class="mb-3">
        <Tabs.Trigger value="auth">Auth</Tabs.Trigger>
        <Tabs.Trigger value="headers">Headers</Tabs.Trigger>
        <Tabs.Trigger value="vars">Vars</Tabs.Trigger>
      </Tabs.List>

      <Tabs.Content value="auth" class="min-h-0 overflow-auto">
        <AuthEditor bind:auth={scope.auth} includeInherit={canInheritAuth} />
      </Tabs.Content>

      <Tabs.Content value="headers" class="min-h-0 overflow-auto">
        <KeyValueEditor bind:items={headerRows} placeholder="header" />
      </Tabs.Content>

      <Tabs.Content value="vars" class="min-h-0 overflow-auto">
        <div class="flex flex-col gap-1">
          {#each vars as row, i (i)}
            <div class="flex items-center gap-2 rounded">
              <div class="flex-1">
                <input
                  bind:value={row.name}
                  oninput={applyVars}
                  placeholder="variable"
                  class="mono h-6 w-full rounded-md border border-border bg-[var(--color-bg-2)] px-2 text-sm outline-none transition placeholder:text-fg-faint focus:border-[var(--color-brand)] focus:ring-1 focus:ring-[var(--color-brand)]"
                />
              </div>
              <div class="flex-1">
                <input
                  bind:value={row.value}
                  oninput={applyVars}
                  placeholder="value"
                  class="mono h-6 w-full rounded-md border border-border bg-[var(--color-bg-2)] px-2 text-sm outline-none transition placeholder:text-fg-faint focus:border-[var(--color-brand)] focus:ring-1 focus:ring-[var(--color-brand)]"
                />
              </div>
              <Button
                onclick={() => removeVar(i)}
                variant="ghost"
                size="icon-xs"
                aria-label="remove variable">✕</Button
              >
            </div>
          {/each}
          <Button onclick={addVar} variant="ghost" size="xs" class="mt-1 self-start">
            + add
          </Button>
        </div>
      </Tabs.Content>
    </Tabs.Root>
  </div>
{:else}
  <div class="grid h-full place-items-center px-4 text-center text-sm text-fg-subtle">
    Select a collection or folder scope.
  </div>
{/if}
