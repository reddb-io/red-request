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
  import { Textarea } from "./ui/textarea/index.js";

  let {
    kind,
    net = $bindable(),
  }: { kind: RequestKind; net: NetConfig } = $props();

  const recordTypes = dnsRecordTypeSchema.options;
  const hostLabel = $derived(
    kind === "whois" ? "domain" : kind === "dns" ? "name" : "host"
  );

  const isHexMode = $derived(net.payloadMode === "hex");

  function isValidHex(s: string): boolean {
    const clean = s.replace(/\s+/g, "");
    return clean.length === 0 || (/^[0-9a-fA-F]+$/.test(clean) && clean.length % 2 === 0);
  }

  const hexError = $derived(
    isHexMode && net.payload && !isValidHex(net.payload)
      ? "invalid hex: must be an even number of hex digits (0-9 a-f)"
      : null
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

  {#if kind === "tcp" || kind === "udp" || kind === "ping" || kind === "tls"}
    <label class="flex items-center gap-2 text-sm">
      <span class="w-24 text-fg-muted">port</span>
      <Input type="number" min="0" max="65535" bind:value={net.port} class="h-7 w-28" />
    </label>
  {/if}

  {#if kind === "tcp" || kind === "udp" || kind === "tls"}
    <div class="flex items-center gap-2 text-sm">
      <span class="w-24 text-fg-muted">payload</span>
      <div class="flex overflow-hidden rounded border border-border text-xs">
        <button
          type="button"
          onclick={() => (net.payloadMode = "text")}
          class="px-2 py-0.5 {net.payloadMode !== 'hex' ? 'bg-[var(--color-brand)] text-white' : 'text-fg-muted hover:text-fg'}"
        >text</button>
        <button
          type="button"
          onclick={() => (net.payloadMode = "hex")}
          class="px-2 py-0.5 {net.payloadMode === 'hex' ? 'bg-[var(--color-brand)] text-white' : 'text-fg-muted hover:text-fg'}"
        >hex</button>
      </div>
    </div>
    <label class="flex items-start gap-2 text-sm">
      <span class="w-24 pt-1 text-fg-muted"></span>
      <div class="flex-1">
        {#if isHexMode}
          <Textarea
            bind:value={net.payload}
            rows={3}
            class="mono text-xs {hexError ? 'border-red-500' : ''}"
            aria-label="payload (hex)"
            placeholder="de ad be ef  (hex pairs, spaces optional)"
          />
          {#if hexError}
            <p class="mt-1 text-xs text-red-400">{hexError}</p>
          {/if}
        {:else}
          <VarField
            bind:value={net.payload}
            known={ws.knownVars}
            values={ws.varTitles}
            multiline
            rows={3}
            ariaLabel="payload"
            placeholder="bytes to send (optional)"
          />
        {/if}
      </div>
    </label>
  {/if}

  {#if kind === "tls"}
    <label class="flex items-center gap-2 text-sm">
      <span class="w-24 text-fg-muted">SNI</span>
      <div class="flex-1">
        <VarField
          bind:value={net.sni}
          known={ws.knownVars}
          values={ws.varTitles}
          dense
          ariaLabel="SNI hostname"
          placeholder="hostname (defaults to host)"
        />
      </div>
    </label>
  {/if}

  {#if kind === "udp"}
    <label class="flex items-center gap-2 text-sm">
      <span class="w-24 text-fg-muted">wait reply</span>
      <input type="checkbox" bind:checked={net.waitResponse} class="accent-[var(--color-brand)]" />
    </label>
    <label class="flex items-center gap-2 text-sm">
      <span class="w-24 text-fg-muted">multicast</span>
      <input type="checkbox" bind:checked={net.multicast} class="accent-[var(--color-brand)]" />
      <span class="hint">join the group at <span class="mono">host</span> and collect responses</span>
    </label>
    {#if net.multicast}
      <label class="flex items-center gap-2 text-sm">
        <span class="w-24 text-fg-muted">TTL</span>
        <Input type="number" min="0" max="255" bind:value={net.multicastTtl} class="h-7 w-28" />
        <span class="hint">hop limit</span>
      </label>
      <label class="flex items-center gap-2 text-sm">
        <span class="w-24 text-fg-muted">interface</span>
        <div class="flex-1">
          <VarField
            bind:value={net.multicastInterface}
            known={ws.knownVars}
            values={ws.varTitles}
            dense
            ariaLabel="multicast interface"
            placeholder="local iface address (defaults to OS choice)"
          />
        </div>
      </label>
    {/if}
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
