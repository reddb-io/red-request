<script lang="ts">
  import type { ResponseResult, Timings } from "@red-request/core";

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
    alpn?: string | null;
    /** Remote IP + port the connection actually landed on (post-DNS / post-proxy). */
    remote?: { ip?: string; port?: number } | null;
    cert: TlsCert | null;
  }

  const tlsMeta = $derived(response?.meta?.tls as TlsMeta | undefined);
  const timings = $derived<Timings | undefined>(response?.timings);
  const url = $derived(response?.url ?? "");
  const isHttps = $derived(url.startsWith("https://"));

  // Pretty-print each ms value, only when the engine actually reported one.
  // `null` means "not measured"; `undefined` would mean "didn't happen".
  const timingRows = $derived(
    [
      { label: "queued", ms: timings?.queuing },
      { label: "DNS", ms: timings?.dns },
      { label: "TCP connect", ms: timings?.tcp },
      { label: "TLS handshake", ms: timings?.tls },
      { label: "first byte", ms: timings?.firstByte },
      { label: "content", ms: timings?.content },
      { label: "proxy connect", ms: timings?.proxyConnect },
      { label: "proxy TLS", ms: timings?.proxyTls },
      { label: "origin", ms: timings?.originConnect },
    ].filter((r) => typeof r.ms === "number" && r.ms! > 0)
  );

  function fmtMs(ms: number | undefined): string {
    if (ms === undefined) return "—";
    if (ms < 1) return "<1 ms";
    if (ms < 1000) return `${Math.round(ms)} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
  }
</script>

{#if tlsMeta}
  <div class="flex flex-col gap-4 text-xs">
    <!-- Connection facts -->
    <div class="rounded border border-border bg-[var(--color-bg-1)] p-3">
      <div class="mb-2 text-[10px] font-semibold tracking-wide text-fg-faint uppercase">
        Connection
      </div>
      <div class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 items-baseline">
        {#if tlsMeta.version}
          <span class="text-fg-muted">version</span>
          <span class="mono text-fg font-medium">{tlsMeta.version}</span>
        {/if}
        {#if tlsMeta.cipher}
          <span class="text-fg-muted">cipher</span>
          <span class="mono text-fg">{tlsMeta.cipher}</span>
        {/if}
        {#if tlsMeta.alpn}
          <span class="text-fg-muted">ALPN</span>
          <span class="mono text-fg">{tlsMeta.alpn}</span>
        {/if}
        {#if tlsMeta.sni}
          <span class="text-fg-muted">SNI</span>
          <span class="mono text-fg">{tlsMeta.sni}</span>
        {/if}
        {#if tlsMeta.remote?.ip}
          <span class="text-fg-muted">remote</span>
          <span class="mono text-fg"
            >{tlsMeta.remote.ip}{tlsMeta.remote.port ? `:${tlsMeta.remote.port}` : ""}</span
          >
        {/if}
      </div>
    </div>

    <!-- Certificate -->
    {#if tlsMeta.cert}
      <div class="rounded border border-border bg-[var(--color-bg-1)] p-3">
        <div class="mb-2 text-[10px] font-semibold tracking-wide text-fg-faint uppercase">
          Certificate
        </div>
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

    <!-- Timing breakdown — recker already gives us DNS / TCP / TLS / firstByte /
         content split out. Rendered as a small waterfall so the user can spot
         where a slow request actually stalled. -->
    {#if timingRows.length > 0}
      <div class="rounded border border-border bg-[var(--color-bg-1)] p-3">
        <div class="mb-2 text-[10px] font-semibold tracking-wide text-fg-faint uppercase">
          Timing
        </div>
        <ul class="space-y-1">
          {#each timingRows as r (r.label)}
            <li class="flex items-center justify-between gap-3">
              <span class="text-fg-muted">{r.label}</span>
              <span class="mono text-fg">{fmtMs(r.ms)}</span>
            </li>
          {/each}
          {#if timings?.total !== undefined}
            <li class="flex items-center justify-between gap-3 border-t border-border pt-1 mt-1">
              <span class="text-fg-strong">total</span>
              <span class="mono text-fg-strong">{fmtMs(timings.total)}</span>
            </li>
          {/if}
        </ul>
      </div>
    {/if}
  </div>
{:else if isHttps}
  <!-- https:// target but the engine didn't surface TLS metadata. Tell the
       user we're investigating rather than leaving the tab blank. -->
  <div class="flex flex-col items-center gap-2 py-8 text-sm text-fg-muted">
    <span class="text-2xl text-fg-faint">⌛</span>
    <span class="font-medium">TLS metadata unavailable</span>
    <span class="text-xs text-fg-faint">
      The recker engine reported an https:// target without handshake details.
      Check the engine logs (Developer → reddb → engine).
    </span>
  </div>
{:else}
  <div class="flex flex-col items-center gap-2 py-8 text-sm text-fg-muted">
    <span class="text-2xl text-fg-faint">[ ]</span>
    <span class="font-medium">No encryption</span>
    <span class="text-xs text-fg-faint">Connection is plaintext — no TLS was negotiated</span>
  </div>
{/if}
