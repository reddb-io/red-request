<script lang="ts">
  import type { ResponseResult } from "@red-request/core";

  let { response }: { response: ResponseResult | null } = $props();

  interface TlsCert {
    subject: string;
    issuer: string;
    validFrom: string | null;
    validTo: string | null;
    san: string[];
  }

  interface TlsMeta {
    version: string | null;
    cipher: string | null;
    sni: string | null;
    cert: TlsCert | null;
  }

  const tlsMeta = $derived(response?.meta?.tls as TlsMeta | undefined);
</script>

{#if tlsMeta}
  <div class="flex flex-col gap-3 text-xs">
    <div class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 items-baseline">
      {#if tlsMeta.version}
        <span class="text-fg-muted">version</span>
        <span class="mono text-fg font-medium">{tlsMeta.version}</span>
      {/if}
      {#if tlsMeta.cipher}
        <span class="text-fg-muted">cipher</span>
        <span class="mono text-fg">{tlsMeta.cipher}</span>
      {/if}
      {#if tlsMeta.sni}
        <span class="text-fg-muted">SNI</span>
        <span class="mono text-fg">{tlsMeta.sni}</span>
      {/if}
    </div>

    {#if tlsMeta.cert}
      <div class="rounded border border-border bg-[var(--color-bg-1)] p-3">
        <div class="mb-2 text-xs font-medium text-fg-muted uppercase tracking-wide">Certificate</div>
        <div class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 items-baseline">
          {#if tlsMeta.cert.subject}
            <span class="text-fg-muted">subject</span>
            <span class="mono text-fg break-all">{tlsMeta.cert.subject}</span>
          {/if}
          {#if tlsMeta.cert.issuer}
            <span class="text-fg-muted">issuer</span>
            <span class="mono text-fg break-all">{tlsMeta.cert.issuer}</span>
          {/if}
          {#if tlsMeta.cert.validFrom}
            <span class="text-fg-muted">valid from</span>
            <span class="mono text-fg">{tlsMeta.cert.validFrom}</span>
          {/if}
          {#if tlsMeta.cert.validTo}
            <span class="text-fg-muted">valid to</span>
            <span class="mono text-fg">{tlsMeta.cert.validTo}</span>
          {/if}
          {#if tlsMeta.cert.san.length}
            <span class="text-fg-muted">SAN</span>
            <span class="mono text-fg break-all">{tlsMeta.cert.san.join(", ")}</span>
          {/if}
        </div>
      </div>
    {/if}
  </div>
{:else}
  <div class="flex flex-col items-center gap-2 py-8 text-sm text-fg-muted">
    <span class="text-2xl text-fg-faint">[ ]</span>
    <span class="font-medium">No encryption</span>
    <span class="text-xs text-fg-faint">Connection is plaintext — no TLS was negotiated</span>
  </div>
{/if}
