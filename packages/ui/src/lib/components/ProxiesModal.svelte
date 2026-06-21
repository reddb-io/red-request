<script lang="ts">
  // Manage a collection's proxies (http/https/socks5/socks5h) and user profiles
  // (User-Agent + headers + a bound proxy). Fields accept {{vars}} — a password can be a
  // sealed secret like {{PROXY_PASS}}, resolved at send-time.
  import Modal from "./ui/Modal.svelte";
  import Select from "./ui/Select.svelte";
  import { Input } from "./ui/input/index.js";
  import { Button } from "./ui/button/index.js";
  import KeyValueEditor from "./KeyValueEditor.svelte";
  import { ws } from "../store.svelte";

  let { onClose }: { onClose: () => void } = $props();
  let tab = $state<"proxies" | "profiles">("proxies");

  const save = () => ws.saveProxiesProfiles();
  const close = () => {
    void save(); // flush any header edits not captured by an input blur
    onClose();
  };
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
</script>

<Modal onClose={close} class="flex h-[80vh] w-[760px] max-w-[94vw] flex-col rounded-xl">
  <div class="flex items-center gap-2 border-b border-border px-4 py-2">
    <h2 class="text-sm font-semibold text-fg">Proxies &amp; profiles</h2>
    <div class="ml-3 flex gap-1">
      <button class="seg" class:is-active={tab === "proxies"} onclick={() => (tab = "proxies")}
        >proxies ({ws.proxies.length})</button
      >
      <button class="seg" class:is-active={tab === "profiles"} onclick={() => (tab = "profiles")}
        >profiles ({ws.profiles.length})</button
      >
    </div>
    <Button onclick={close} variant="ghost" size="icon-xs" class="ml-auto" aria-label="close"
      >✕</Button
    >
  </div>

  <div class="flex-1 overflow-y-auto p-3">
    {#if tab === "proxies"}
      <p class="hint mb-2">
        Reusable proxies. Host / port / user / password accept <code class="mono">{"{{vars}}"}</code
        > — use a sealed secret for the password.
      </p>
      {#each ws.proxies as proxy (proxy.id)}
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
            <span class="hint ml-auto mono truncate">{proxy.type}://{proxy.host}:{proxy.port}</span>
            <Button onclick={() => ws.removeProxy(proxy.id)} variant="ghost" size="icon-xs"
              aria-label="delete proxy" class="hover:text-red-400">✕</Button
            >
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
      <Button onclick={() => ws.addProxy()} variant="outline" size="xs">+ Proxy</Button>
    {:else}
      <p class="hint mb-2">
        A profile applies a User-Agent + headers + a proxy to any request that selects it.
      </p>
      {#each ws.profiles as profile (profile.id)}
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
            <Button onclick={() => ws.removeProfile(profile.id)} variant="ghost" size="icon-xs"
              aria-label="delete profile" class="ml-auto hover:text-red-400">✕</Button
            >
          </div>
          <Input
            bind:value={profile.userAgent}
            onblur={save}
            placeholder="User-Agent (blank = leave default)"
            class="mono mt-2 h-7 w-full"
          />
          <div class="mt-2">
            <span class="hint">extra headers</span>
            <KeyValueEditor bind:items={profile.headers} placeholder="header" />
          </div>
        </div>
      {/each}
      <Button onclick={() => ws.addProfile()} variant="outline" size="xs">+ Profile</Button>
    {/if}
  </div>
</Modal>
