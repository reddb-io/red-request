<script lang="ts">
  import {
    dnsRecordTypeSchema,
    type NetConfig,
    type RequestKind,
  } from "@red-requester/core";

  let {
    kind,
    net = $bindable(),
  }: { kind: RequestKind; net: NetConfig } = $props();

  const recordTypes = dnsRecordTypeSchema.options;
  const field =
    "mono rounded bg-[var(--color-bg-2)] px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-[var(--color-accent)]";
  const hostLabel = $derived(
    kind === "whois" ? "domain" : kind === "dns" ? "name" : "host"
  );
</script>

<div class="flex flex-col gap-3">
  <label class="flex items-center gap-2 text-sm">
    <span class="w-24 text-zinc-400">{hostLabel}</span>
    <input
      bind:value={net.host}
      placeholder={kind === "whois" || kind === "dns" ? "example.com" : "{{host}}"}
      class="{field} flex-1"
    />
  </label>

  {#if kind === "tcp" || kind === "udp" || kind === "ping"}
    <label class="flex items-center gap-2 text-sm">
      <span class="w-24 text-zinc-400">port</span>
      <input type="number" min="0" max="65535" bind:value={net.port} class="{field} w-28" />
    </label>
  {/if}

  {#if kind === "tcp" || kind === "udp"}
    <label class="flex items-start gap-2 text-sm">
      <span class="w-24 pt-1 text-zinc-400">payload</span>
      <textarea bind:value={net.payload} rows="3" placeholder="bytes to send (optional)" class="{field} flex-1"></textarea>
    </label>
  {/if}

  {#if kind === "udp"}
    <label class="flex items-center gap-2 text-sm">
      <span class="w-24 text-zinc-400">wait reply</span>
      <input type="checkbox" bind:checked={net.waitResponse} class="accent-[var(--color-accent)]" />
    </label>
  {/if}

  {#if kind === "ping"}
    <label class="flex items-center gap-2 text-sm">
      <span class="w-24 text-zinc-400">count</span>
      <input type="number" min="1" max="50" bind:value={net.count} class="{field} w-28" />
    </label>
    <p class="text-xs text-zinc-600">TCP-connect ping (no root needed). Defaults to port 80.</p>
  {/if}

  {#if kind === "dns"}
    <label class="flex items-center gap-2 text-sm">
      <span class="w-24 text-zinc-400">record</span>
      <select bind:value={net.recordType} class={field}>
        {#each recordTypes as t (t)}
          <option value={t}>{t}</option>
        {/each}
      </select>
    </label>
  {/if}

  {#if kind !== "whois"}
    <label class="flex items-center gap-2 text-sm">
      <span class="w-24 text-zinc-400">timeout</span>
      <input type="number" min="100" max="60000" bind:value={net.timeoutMs} class="{field} w-28" />
      <span class="text-xs text-zinc-600">ms</span>
    </label>
  {/if}
</div>
