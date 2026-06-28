<script lang="ts">
  // Project-level pool of proxies (http/https/socks5/socks5h) and user profiles
  // (User-Agent + headers + a bound proxy). Rendered as a stackable panel on the
  // Home view (no modal wrapper) — the shared project-level network pool lives
  // outside any collection's git YAML so credentials stay local.
  import Select from "./ui/Select.svelte";
  import Tooltip from "./ui/Tooltip.svelte";
  import Menu from "./ui/Menu.svelte";
  import { Input } from "./ui/input/index.js";
  import { Button } from "./ui/button/index.js";
  import KeyValueEditor from "./KeyValueEditor.svelte";
  import { ws } from "../store.svelte";
  import { USER_AGENTS } from "@reddb-io/request-core/constants";
  import { onDestroy } from "svelte";

  // Which panels to render. Defaults to both (legacy); Settings renders one at a time.
  let { show = "both" }: { show?: "proxies" | "profiles" | "both" } = $props();

  const uaPresets = [
    { value: "", label: "UA preset…" },
    ...USER_AGENTS.map((u) => ({ value: u.value, label: u.name })),
  ];

  const save = () => ws.saveProxiesProfiles();
  // Inputs persist on blur; also flush on unmount so a field edited and left focused
  // when the panel/app closes can't be lost — making network settings autosave too.
  onDestroy(save);

  const TYPES = [
    { value: "http", label: "HTTP" },
    { value: "https", label: "HTTPS" },
    { value: "socks5", label: "SOCKS5" },
    { value: "socks5h", label: "SOCKS5h" },
  ];

  const proxyOptions = $derived([
    { value: "", label: "— direct —" },
    ...ws.proxies.map((p) => ({ value: p.id, label: p.name || p.host || "proxy" })),
  ]);

  // --- live validation (non-blocking — users may leave rows blank while drafting) --
  const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g;
  const missingVars = (s: string): string[] => {
    const known = new Set(Object.keys(ws.varInfo));
    const out = new Set<string>();
    for (const m of s.matchAll(PLACEHOLDER)) if (!known.has(m[1]!)) out.add(m[1]!);
    return [...out];
  };
  type Issue = string | null;
  const proxyIssue = (p: {
    host: string;
    port: string;
    username: string;
    password: string;
  }): Issue => {
    const missingHost = !p.host.trim() || /\s/.test(p.host);
    const missingPort = !p.port.trim();
    const badPort =
      !missingPort &&
      (Number.isNaN(Number(p.port)) ||
        Number(p.port) < 1 ||
        Number(p.port) > 65535);
    const unresolved = [
      ...missingVars(p.host),
      ...missingVars(p.port),
      ...missingVars(p.username),
      ...missingVars(p.password),
    ];
    if (missingHost) return "missing host";
    if (badPort) return "invalid port";
    if (missingPort) return "missing port";
    if (unresolved.length) return `unresolved: ${unresolved.join(", ")}`;
    return null;
  };
  const profileIssue = (p: {
    name: string;
    headers: { name: string; enabled: boolean }[];
  }): Issue => {
    const orphans = p.headers.filter((h) => h.enabled && !h.name.trim() && h.name !== "");
    if (!p.name.trim()) return "missing name";
    if (orphans.length) return `${orphans.length} empty header${orphans.length > 1 ? "s" : ""}`;
    return null;
  };

  // --- common headers users reach for when impersonating a client. Clicking a
  // preset inserts a new row + saves (the picker lives in the profiles section).
  const HEADER_PRESETS = [
    { name: "Accept", value: "application/json" },
    { name: "Accept-Language", value: "en-US,en;q=0.9" },
    { name: "Authorization", value: "Bearer {{TOKEN}}" },
    { name: "Cache-Control", value: "no-cache" },
    { name: "Content-Type", value: "application/json" },
    { name: "Origin", value: "https://example.com" },
    { name: "Referer", value: "https://example.com/" },
    { name: "User-Agent", value: "(see UA field)" },
    { name: "X-Requested-With", value: "XMLHttpRequest" },
  ];

  // --- test-button status pill (per proxy) -----------------------------------
  function probeState(
    id: string
  ): { state: "idle" | "running" } | { ok: boolean; ms: number; via: string; error?: string } | null {
    return ws.proxyProbeById[id] ?? null;
  }
</script>

<section class="flex flex-col gap-4">
  {#if show !== "profiles"}
  <!-- ============================================================== PROXIES -->
  <div class="panel p-3">
    <div class="mb-2 flex items-center gap-3">
      <span class="hint">{ws.proxies.length} configured</span>
      <Button onclick={() => ws.addProxy()} variant="outline" size="xs" class="ml-auto"
        >+ Proxy</Button
      >
    </div>
    {#if ws.proxies.length === 0}
      <div class="rounded-lg border border-dashed border-border p-4 text-center">
        <div class="text-fg-muted text-sm">No proxies yet.</div>
        <div class="hint mt-1">
          Add an HTTP(S) proxy for plain forwarding, or a SOCKS5(h) one for tunneled traffic.
          Both reuse the same connection for the whole project.
        </div>
      </div>
    {/if}
    {#each ws.proxies as proxy (proxy.id)}
      {@const issue = proxyIssue(proxy)}
      {@const probe = probeState(proxy.id)}
      <div class="mb-2 rounded-lg border border-border p-2">
        <div class="flex items-center gap-2">
          <Input bind:value={proxy.name} onblur={save} placeholder="name" class="h-7 w-40" />
          <Select
            bind:value={proxy.type}
            items={TYPES}
            ariaLabel="type"
            class="w-auto"
            onChange={save}
          />
          {#if issue}
            <Tooltip text={issue} side="bottom">
              {#snippet children(p)}
                <span
                  {...p}
                  class="mono rounded bg-red-900/30 px-1.5 py-0.5 text-[10px] text-red-300"
                  aria-label={issue}>!</span
                >
              {/snippet}
            </Tooltip>
          {/if}
          <span class="hint ml-auto mono truncate">{proxy.type}://{proxy.host}:{proxy.port}</span>
          {#if probe}
            {#if "state" in probe && probe.state === "running"}
              <span class="mono rounded bg-[var(--color-bg-2)] px-1.5 py-0.5 text-[10px] text-fg-muted"
                >testing…</span
              >
            {:else if "ok" in probe && probe.ok}
              <Tooltip text={`verified via ${probe.via} (${probe.ms} ms)`} side="bottom">
                {#snippet children(p)}
                  <span
                    {...p}
                    class="mono rounded bg-emerald-900/30 px-1.5 py-0.5 text-[10px] text-emerald-300"
                    >✓ {probe.ms}ms</span
                  >
                {/snippet}
              </Tooltip>
            {:else if "ok" in probe && !probe.ok}
              <Tooltip text={probe.error ?? "failed"} side="bottom">
                {#snippet children(p)}
                  <span
                    {...p}
                    class="mono max-w-[18ch] truncate rounded bg-red-900/30 px-1.5 py-0.5 text-[10px] text-red-300"
                    >✗ {probe.error ?? "fail"}</span
                  >
                {/snippet}
              </Tooltip>
            {/if}
          {/if}
          <Tooltip text="Verify the proxy is reachable (TCP / CONNECT / SOCKS handshake)">
            {#snippet children(p)}
              <Button
                {...p}
                onclick={() => ws.testProxy(proxy.id)}
                variant="outline"
                size="icon-xs"
                disabled={!!(probe && "state" in probe && probe.state === "running")}
                aria-label="test proxy">Test</Button
              >
            {/snippet}
          </Tooltip>
          <Menu
            items={[
              { label: "Duplicate", onSelect: () => ws.duplicateProxy(proxy.id) },
              {
                label: "Delete",
                onSelect: () => ws.removeProxy(proxy.id),
                destructive: true,
              },
            ]}
          >
            {#snippet trigger(p)}
              <Button {...p} variant="ghost" size="icon-xs" aria-label="row actions">⋯</Button>
            {/snippet}
          </Menu>
        </div>
        <div class="mt-2 flex flex-wrap gap-2">
          <Input bind:value={proxy.host} onblur={save} placeholder="host" class="mono h-7 flex-1" />
          <Input bind:value={proxy.port} onblur={save} placeholder="port" class="mono h-7 w-20" />
          <Input bind:value={proxy.username} onblur={save} placeholder="username" class="mono h-7 w-36" />
          <Input
            bind:value={proxy.password}
            onblur={save}
            type="password"
            placeholder={"password or {{secret}}"}
            class="mono h-7 w-44"
          />
        </div>
      </div>
    {/each}
  </div>
  {/if}

  {#if show !== "proxies"}
  <!-- ============================================================== PROFILES -->
  <div class="panel p-3">
    <div class="mb-2 flex items-center gap-3">
      <span class="hint">{ws.profiles.length} configured</span>
      <span class="hint ml-auto max-w-[42ch] text-right">
        Explicit request values always win over the profile.
      </span>
      <Button onclick={() => ws.addProfile()} variant="outline" size="xs">+ Profile</Button>
    </div>
    {#if ws.activeCollection}
      <div class="mb-3 flex items-center gap-2 rounded-lg border border-border bg-[var(--color-bg-1)] p-2">
        <span class="hint">Default for “{ws.activeCollection.collection.name}”</span>
        <Select
          value={ws.activeCollection.collection.defaultProfileId}
          onChange={(v) => ws.setCollectionDefaultProfile(v)}
          items={[
            { value: "", label: "no default" },
            ...ws.profiles.map((p) => ({ value: p.id, label: p.name || "profile" })),
          ]}
          ariaLabel="collection default profile"
          class="w-auto"
        />
        {#if ws.activeCollection.collection.defaultProfileId}
          <Button
            onclick={() => ws.setCollectionDefaultProfile("")}
            variant="ghost"
            size="icon-xs"
            aria-label="clear default"
            class="hover:text-red-400">✕</Button
          >
        {/if}
      </div>
    {/if}
    {#if ws.profiles.length === 0}
      <div class="rounded-lg border border-dashed border-border p-4 text-center">
        <div class="text-fg-muted text-sm">No profiles yet.</div>
        <div class="hint mt-1">
          Bundle a User-Agent + extra headers + a proxy, then pick the profile in the URL bar of
          any request — explicit request values always win over the profile.
        </div>
      </div>
    {/if}
    {#each ws.profiles as profile (profile.id)}
      {@const issue = profileIssue(profile)}
      <div class="mb-2 rounded-lg border border-border p-2">
        <div class="flex items-center gap-2">
          <Input bind:value={profile.name} onblur={save} placeholder="name" class="h-7 w-40" />
          <span class="hint">proxy</span>
          <Select
            bind:value={profile.proxyId}
            items={proxyOptions}
            ariaLabel="proxy"
            class="w-auto"
            onChange={save}
          />
          <label class="flex items-center gap-1 text-xs text-fg-muted">
            <input
              type="checkbox"
              checked={profile.cookieJar}
              onchange={(e) =>
                ws.setProfileCookieJar(
                  profile.id,
                  (e.currentTarget as HTMLInputElement).checked
                )}
              class="accent-[var(--color-brand)]"
            />
            Cookie jar
          </label>
          {#if issue}
            <Tooltip text={issue} side="bottom">
              {#snippet children(p)}
                <span
                  {...p}
                  class="mono rounded bg-red-900/30 px-1.5 py-0.5 text-[10px] text-red-300"
                  aria-label={issue}>!</span
                >
              {/snippet}
            </Tooltip>
          {/if}
          <div class="ml-auto flex items-center gap-1">
            <Menu
              items={[
                { label: "Duplicate", onSelect: () => ws.duplicateProfile(profile.id) },
                {
                  label: "Delete",
                  onSelect: () => ws.removeProfile(profile.id),
                  destructive: true,
                },
              ]}
            >
              {#snippet trigger(p)}
                <Button {...p} variant="ghost" size="icon-xs" aria-label="row actions">⋯</Button>
              {/snippet}
            </Menu>
            <Button onclick={() => ws.removeProfile(profile.id)} variant="ghost" size="icon-xs"
              aria-label="delete profile" class="hover:text-red-400">✕</Button
            >
          </div>
        </div>
        <div class="mt-2 flex items-center gap-2">
          <Input
            bind:value={profile.userAgent}
            onblur={save}
            placeholder="User-Agent (blank = leave default)"
            class="mono h-7 flex-1"
          />
          <Select
            value=""
            onChange={(v) => {
              if (v) {
                profile.userAgent = v;
                void save();
              }
            }}
            items={uaPresets}
            ariaLabel="user-agent preset"
            class="w-auto shrink-0"
          />
        </div>
        <div class="mt-2">
          <div class="mb-1 flex items-center gap-2">
            <span class="hint">extra headers</span>
            <Menu
              items={HEADER_PRESETS.map((h) => ({
                label: `${h.name}${h.value === "(see UA field)" ? "" : ` · ${h.value}`}`,
                onSelect: () => {
                  profile.headers.push({
                    name: h.name,
                    value: h.value === "(see UA field)" ? "" : h.value,
                    enabled: true,
                  });
                  void save();
                },
              }))}
            >
              {#snippet trigger(p)}
                <Button {...p} variant="ghost" size="xs" aria-label="insert preset header">+ preset</Button>
              {/snippet}
            </Menu>
          </div>
          <KeyValueEditor bind:items={profile.headers} placeholder="header" />
        </div>
      </div>
    {/each}
  </div>
  {/if}
</section>
