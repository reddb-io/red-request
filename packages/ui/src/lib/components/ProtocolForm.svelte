<script lang="ts">
  import {
    dnsRecordTypeSchema,
    type NetConfig,
    type RequestKind,
  } from "@red-request/core";
  import { ws } from "../store.svelte";
  import VarField from "./VarField.svelte";
  import Select from "./ui/Select.svelte";
  import { Input } from "./ui/input/index.js";

  let {
    kind,
    net = $bindable(),
  }: { kind: RequestKind; net: NetConfig } = $props();

  const recordTypes = dnsRecordTypeSchema.options;
  const hostLabel = $derived(
    kind === "whois" ? "domain" : kind === "dns" ? "name" : "host"
  );
</script>

<div class="flex flex-col gap-3">
  <label class="flex items-center gap-2 text-sm">
    <span class="w-24 text-fg-muted">{hostLabel}</span>
    <div class="flex-1">
      <VarField
        bind:value={net.host}
        known={ws.knownVars}
        values={ws.varTitles}
        dense
        ariaLabel={hostLabel}
        placeholder={kind === "whois" || kind === "dns" ? "example.com" : "{{host}}"}
      />
    </div>
  </label>

  {#if kind === "tcp" || kind === "udp" || kind === "ping"}
    <label class="flex items-center gap-2 text-sm">
      <span class="w-24 text-fg-muted">port</span>
      <Input type="number" min="0" max="65535" bind:value={net.port} class="h-7 w-28" />
    </label>
  {/if}

  {#if kind === "tcp" || kind === "udp"}
    <label class="flex items-start gap-2 text-sm">
      <span class="w-24 pt-1 text-fg-muted">payload</span>
      <div class="flex-1">
        <VarField
          bind:value={net.payload}
          known={ws.knownVars}
        values={ws.varTitles}
          multiline
          rows={3}
          ariaLabel="payload"
          placeholder="bytes to send (optional)"
        />
      </div>
    </label>
  {/if}

  {#if kind === "udp"}
    <label class="flex items-center gap-2 text-sm">
      <span class="w-24 text-fg-muted">wait reply</span>
      <input type="checkbox" bind:checked={net.waitResponse} class="accent-[var(--color-brand)]" />
    </label>
  {/if}

  {#if kind === "ping"}
    <label class="flex items-center gap-2 text-sm">
      <span class="w-24 text-fg-muted">count</span>
      <Input type="number" min="1" max="50" bind:value={net.count} class="h-7 w-28" />
    </label>
    <p class="hint">TCP-connect ping (no root needed). Defaults to port 80.</p>
  {/if}

  {#if kind === "dns"}
    <label class="flex items-center gap-2 text-sm">
      <span class="w-24 text-fg-muted">record</span>
      <Select bind:value={net.recordType} items={recordTypes} class="w-28" ariaLabel="record type" />
    </label>
  {/if}

  {#if kind !== "whois"}
    <label class="flex items-center gap-2 text-sm">
      <span class="w-24 text-fg-muted">timeout</span>
      <Input type="number" min="100" max="60000" bind:value={net.timeoutMs} class="h-7 w-28" />
      <span class="hint">ms</span>
    </label>
  {/if}
</div>
