import type { ResponseResult } from "@reddb-io/request-core";

type Timings = NonNullable<ResponseResult["timings"]>;

interface TlsMeta {
  version?: string | null;
  cipher?: string | null;
  sni?: string | null;
  alpn?: string | null;
  remote?: { ip?: string; port?: number } | null;
  cert?: {
    subject?: string | null;
    issuer?: string | null;
    validTo?: string | null;
    san?: string[] | null;
  } | null;
}

export type InsightTone = "info" | "good" | "warn" | "bad";

export type ResponseInsight = {
  title: string;
  detail: string;
  value?: string;
  tone: InsightTone;
};

const PHASES = [
  { key: "proxyConnect", label: "Proxy" },
  { key: "proxyTls", label: "Proxy TLS" },
  { key: "dns", label: "DNS" },
  { key: "tcp", label: "TCP" },
  { key: "tls", label: "TLS" },
  { key: "originConnect", label: "Origin" },
  { key: "firstByte", label: "Wait" },
  { key: "total", label: "Download" },
] as const;

function header(res: ResponseResult, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(res.headers)) {
    if (k.toLowerCase() === wanted) return v;
  }
  return undefined;
}

function firstHeader(
  res: ResponseResult,
  names: string[]
): { name: string; value: string } | null {
  for (const name of names) {
    const value = header(res, name);
    if (value) return { name, value };
  }
  return null;
}

function hostFor(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url || "unknown";
  }
}

function tlsFor(res: ResponseResult): TlsMeta | undefined {
  return res.meta?.tls as TlsMeta | undefined;
}

function remoteFor(tls: TlsMeta | undefined): string | undefined {
  const ip = tls?.remote?.ip;
  if (!ip) return undefined;
  return tls.remote?.port ? `${ip}:${tls.remote.port}` : ip;
}

function fmtMs(ms: number): string {
  if (ms < 1) return "<1 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function segments(
  t: Timings | undefined
): { label: string; key: string; ms: number }[] {
  if (!t) return [];
  let prev = t.queuing ?? 0;
  const out: { label: string; key: string; ms: number }[] = [];
  for (const ph of PHASES) {
    const cur = t[ph.key];
    if (typeof cur !== "number") continue;
    const ms = cur - prev;
    if (ms > 0.05) out.push({ label: ph.label, key: ph.key, ms });
    prev = Math.max(prev, cur);
  }
  return out;
}

function phaseMs(t: Timings | undefined, key: string): number | undefined {
  return segments(t).find((s) => s.key === key)?.ms;
}

function protocolName(alpn: string): string {
  switch (alpn.toLowerCase()) {
    case "h2":
      return "HTTP/2";
    case "h3":
      return "HTTP/3";
    case "http/1.1":
      return "HTTP/1.1";
    default:
      return alpn;
  }
}

function looksTextual(contentType: string | undefined): boolean {
  const ct = contentType?.toLowerCase() ?? "";
  return (
    ct.startsWith("text/") ||
    ct.includes("json") ||
    ct.includes("xml") ||
    ct.includes("html") ||
    ct.includes("javascript")
  );
}

export function buildResponseInsights(res: ResponseResult): ResponseInsight[] {
  const out: ResponseInsight[] = [];
  const tls = tlsFor(res);
  const remote = remoteFor(tls);
  out.push({
    title: "Destination",
    detail: hostFor(res.url),
    value: remote ?? tls?.alpn ?? undefined,
    tone: "info",
  });

  const dnsMs = phaseMs(res.timings, "dns");
  if (dnsMs !== undefined) {
    out.push({
      title: "DNS lookup",
      detail: "Hostname resolution was measured for this run.",
      value: fmtMs(dnsMs),
      tone: dnsMs > 250 ? "warn" : "info",
    });
  }

  const tcpMs = phaseMs(res.timings, "tcp");
  if (tcpMs !== undefined) {
    out.push({
      title: "TCP connect",
      detail: remote
        ? `Connected to ${remote}.`
        : "The origin TCP connection phase was measured.",
      value: fmtMs(tcpMs),
      tone: tcpMs > 500 ? "warn" : "info",
    });
  }

  const tlsMs = phaseMs(res.timings, "tls");
  if (tlsMs !== undefined || tls?.version || tls?.cipher) {
    out.push({
      title: "TLS handshake",
      detail:
        [tls?.version, tls?.cipher].filter(Boolean).join(" | ") ||
        "TLS metadata was captured.",
      value: tlsMs !== undefined ? fmtMs(tlsMs) : undefined,
      tone: tlsMs !== undefined && tlsMs > 500 ? "warn" : "info",
    });
  }

  if (tls?.alpn) {
    out.push({
      title: "Protocol negotiated",
      detail: `ALPN selected ${protocolName(tls.alpn)} for the encrypted connection.`,
      value: tls.alpn,
      tone: "info",
    });
  }

  if (tls?.cert?.subject || tls?.cert?.issuer || tls?.sni) {
    out.push({
      title: "Remote certificate",
      detail: [
        tls.cert?.subject,
        tls.cert?.issuer,
        tls.sni ? `SNI ${tls.sni}` : undefined,
      ]
        .filter(Boolean)
        .join(" | "),
      value: tls.cert?.san?.[0],
      tone: "info",
    });
  }

  if (res.error) {
    out.push({
      title: "Transport failure",
      detail: res.error.message,
      value: res.error.classification,
      tone: "bad",
    });
    if (res.error.retriable) {
      out.push({
        title: "Retry may help",
        detail: "The engine classified this failure as retriable.",
        tone: "warn",
      });
    }
  } else if (res.status >= 500) {
    out.push({
      title: "Server error",
      detail: "The origin returned a 5xx response.",
      value: `${res.status}`,
      tone: "bad",
    });
  } else if (res.status >= 400) {
    out.push({
      title: "Client error",
      detail: "The origin rejected the request.",
      value: `${res.status}`,
      tone: "warn",
    });
  }

  const location = header(res, "location");
  if (res.status >= 300 && res.status < 400 && location) {
    out.push({
      title: "Redirect target",
      detail: location,
      value: `${res.status}`,
      tone: "warn",
    });
  }

  const retryAfter = header(res, "retry-after");
  if (retryAfter) {
    out.push({
      title: "Retry-After",
      detail: "The server asked clients to wait before trying again.",
      value: retryAfter,
      tone: "warn",
    });
  }

  const rateLimit = firstHeader(res, [
    "ratelimit-remaining",
    "x-ratelimit-remaining",
    "x-rate-limit-remaining",
  ]);
  if (rateLimit) {
    out.push({
      title: "Rate limit remaining",
      detail: rateLimit.name,
      value: rateLimit.value,
      tone: rateLimit.value.trim() === "0" ? "warn" : "info",
    });
  }

  const trace = firstHeader(res, [
    "traceparent",
    "x-request-id",
    "x-correlation-id",
    "x-amzn-trace-id",
    "cf-ray",
  ]);
  if (trace) {
    out.push({
      title: "Trace identifier",
      detail: trace.name,
      value: trace.value,
      tone: "info",
    });
  }

  const serverTiming = header(res, "server-timing");
  if (serverTiming) {
    out.push({
      title: "Server-Timing",
      detail: serverTiming,
      tone: "info",
    });
  }

  const cacheControl = header(res, "cache-control");
  if (cacheControl) {
    const lc = cacheControl.toLowerCase();
    if (lc.includes("no-store") || lc.includes("no-cache")) {
      out.push({
        title: "Response is not cacheable",
        detail: cacheControl,
        tone: "info",
      });
    } else if (lc.includes("max-age") || lc.includes("public")) {
      out.push({
        title: "Cacheable response",
        detail: cacheControl,
        tone: "good",
      });
    }
  }

  if (res.size >= 5 * 1024 * 1024) {
    out.push({
      title: "Large payload",
      detail: "Body transfer can dominate perceived latency.",
      value: fmtSize(res.size),
      tone: "warn",
    });
  }

  if (
    res.size >= 100 * 1024 &&
    looksTextual(res.contentType) &&
    !header(res, "content-encoding")
  ) {
    out.push({
      title: "Compression opportunity",
      detail:
        "Large textual response arrived without a Content-Encoding header.",
      value: fmtSize(res.size),
      tone: "info",
    });
  }

  if (
    typeof res.timings?.proxyConnect === "number" ||
    typeof res.timings?.proxyTls === "number"
  ) {
    const proxyMs =
      (phaseMs(res.timings, "proxyConnect") ?? 0) +
      (phaseMs(res.timings, "proxyTls") ?? 0);
    const totalMs = res.timings?.total ?? res.durationMs;
    out.push({
      title: "Proxy route observed",
      detail: "This request reported proxy handshake or tunnel timing.",
      value: proxyMs ? fmtMs(proxyMs) : undefined,
      tone: proxyMs > Math.max(500, totalMs * 0.4) ? "warn" : "info",
    });
    if (totalMs > proxyMs) {
      out.push({
        title: "Origin after proxy",
        detail:
          "Remaining measured time after the proxy route was established.",
        value: fmtMs(totalMs - proxyMs),
        tone: "info",
      });
    }
  }

  const dominant = segments(res.timings).reduce<
    { label: string; key: string; ms: number } | undefined
  >((best, cur) => (!best || cur.ms > best.ms ? cur : best), undefined);
  if (dominant) {
    out.push({
      title: "Dominant phase",
      detail: `${dominant.label} was the largest measured phase.`,
      value: fmtMs(dominant.ms),
      tone: dominant.ms > Math.max(750, res.durationMs * 0.5) ? "warn" : "info",
    });
  }

  const validTo = tls?.cert?.validTo ? Date.parse(tls.cert.validTo) : NaN;
  if (!Number.isNaN(validTo)) {
    const days = Math.ceil((validTo - Date.now()) / 86_400_000);
    if (days < 0) {
      out.push({
        title: "Certificate expired",
        detail: tls!.cert!.validTo!,
        tone: "bad",
      });
    } else if (days <= 30) {
      out.push({
        title: "Certificate expires soon",
        detail: `${days} day${days === 1 ? "" : "s"} left`,
        tone: "warn",
      });
    }
  }

  return out;
}
