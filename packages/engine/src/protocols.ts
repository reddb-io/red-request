// Non-HTTP request kinds. WHOIS/DNS use recker; TCP/ping use node:net (TCP-connect, since
// ICMP needs privileges); UDP uses node:dgram (recker/udp's client hung in testing). Each
// returns a ResponseResult so history/dashboard/runner/scripts work uniformly.
import net from "node:net";
import dgram from "node:dgram";
import tls from "node:tls";
import { createClient } from "recker/client";
import { createDNS } from "recker/dns";
import type { ResponseResult } from "@red-request/core";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A datagram is "binary" if it carries control bytes other than the common text whitespace
 *  (tab, LF, CR). Such payloads are surfaced as base64 so the UI can render them as hex. */
function isBinary(buf: Buffer): boolean {
  for (const b of buf) {
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) return true;
  }
  return false;
}

function ok(
  bodyText: string,
  durationMs: number,
  extra: Partial<ResponseResult> = {}
): ResponseResult {
  return {
    status: 200,
    statusText: "OK",
    ok: true,
    url: "",
    headers: {},
    bodyText,
    size: Buffer.byteLength(bodyText),
    durationMs: Math.round(durationMs),
    ...extra,
  };
}

function fail(message: string, durationMs: number): ResponseResult {
  return {
    status: 0,
    statusText: "",
    ok: false,
    url: "",
    headers: {},
    bodyText: "",
    size: 0,
    durationMs: Math.round(durationMs),
    error: { message },
  };
}

export async function runWhois(host: string): Promise<ResponseResult> {
  const t0 = performance.now();
  try {
    const c = createClient({}) as unknown as {
      whois: (d: string) => Promise<unknown>;
    };
    const w = (await c.whois(host)) as
      | {
          raw?: string;
          server?: string;
          data?: unknown;
        }
      | string;
    const dur = performance.now() - t0;
    const raw =
      typeof w === "string" ? w : (w.raw ?? JSON.stringify(w, null, 2));
    const meta =
      typeof w === "string" ? undefined : { server: w.server, data: w.data };
    return ok(raw, dur, meta ? { meta } : {});
  } catch (e) {
    return fail(errMsg(e), performance.now() - t0);
  }
}

const DNS_METHOD: Record<string, string> = {
  A: "resolve4",
  AAAA: "resolve6",
  MX: "resolveMx",
  TXT: "resolveTxt",
  NS: "resolveNs",
  SOA: "resolveSoa",
  SRV: "resolveSrv",
  CAA: "resolveCaa",
};

export async function runDns(
  host: string,
  recordType: string
): Promise<ResponseResult> {
  const t0 = performance.now();
  try {
    const dns = createDNS() as unknown as Record<
      string,
      (h: string, t?: string) => Promise<unknown>
    >;
    const method = DNS_METHOD[recordType];
    const records =
      method && typeof dns[method] === "function"
        ? await dns[method]!(host)
        : await dns.resolve!(host, recordType);
    const dur = performance.now() - t0;
    const body = JSON.stringify(records, null, 2);
    return ok(body, dur, { meta: { recordType, host, records } });
  } catch (e) {
    return fail(errMsg(e), performance.now() - t0);
  }
}

export function runTcp(
  host: string,
  port: number,
  payload: string,
  timeoutMs: number
): Promise<ResponseResult> {
  const t0 = performance.now();
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let connectMs = 0;
    let settled = false;
    const sock = net.createConnection({ host, port });
    const finish = (res: ResponseResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(res);
    };
    const timer = setTimeout(
      () =>
        finish(fail(`timeout after ${timeoutMs}ms`, performance.now() - t0)),
      timeoutMs
    );
    sock.once("connect", () => {
      connectMs = performance.now() - t0;
      if (!payload) {
        finish(
          ok(`connected to ${host}:${port}`, connectMs, {
            timings: { tcp: connectMs, total: connectMs },
          })
        );
        return;
      }
      sock.write(payload);
      // brief read window for the response
      setTimeout(
        () => {
          const recv = Buffer.concat(chunks).toString("utf8");
          const total = performance.now() - t0;
          finish(
            ok(
              `connected to ${host}:${port}\n` +
                (recv ? `\n${recv}` : "(no data received)"),
              total,
              { timings: { tcp: connectMs, total } }
            )
          );
        },
        Math.min(1000, timeoutMs)
      );
    });
    sock.on("data", (d) => chunks.push(d));
    // `on` (persistent) so a late error after finish can't go uncaught.
    sock.on("error", (e) => finish(fail(errMsg(e), performance.now() - t0)));
  });
}

function formatDN(dn: Record<string, string> | undefined): string {
  if (!dn) return "";
  return Object.entries(dn)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

export function runTls(
  host: string,
  port: number,
  payload: string,
  sni: string,
  insecure: boolean,
  timeoutMs: number
): Promise<ResponseResult> {
  const t0 = performance.now();
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let connectMs = 0;
    let settled = false;
    const servername = sni || host;
    // IP addresses cannot be used as TLS servername (RFC 6066 §3); omit when host is a raw IP.
    const isIp = /^[\d.:]+$/.test(servername);

    const sock = tls.connect({
      host,
      port,
      ...(isIp ? {} : { servername }),
      rejectUnauthorized: !insecure,
    });

    const finish = (res: ResponseResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(res);
    };

    const timer = setTimeout(
      () =>
        finish(fail(`timeout after ${timeoutMs}ms`, performance.now() - t0)),
      timeoutMs
    );

    sock.once("secureConnect", () => {
      connectMs = performance.now() - t0;

      const cipher = sock.getCipher();
      const cert = sock.getPeerCertificate();
      const protocol = sock.getProtocol();

      const san: string[] = cert?.subjectaltname
        ? cert.subjectaltname
            .split(",")
            .map((s) => s.trim().replace(/^(?:DNS:|IP Address:)/, ""))
        : [];

      const tlsMeta = {
        version: protocol ?? null,
        cipher: cipher?.name ?? null,
        sni: isIp ? null : servername,
        cert:
          cert && Object.keys(cert).length > 0
            ? {
                subject: formatDN(
                  cert.subject as unknown as Record<string, string>
                ),
                issuer: formatDN(
                  cert.issuer as unknown as Record<string, string>
                ),
                validFrom: cert.valid_from ?? null,
                validTo: cert.valid_to ?? null,
                san,
              }
            : null,
      };

      if (!payload) {
        finish(
          ok(`TLS connected to ${host}:${port}`, connectMs, {
            timings: { tls: connectMs, total: connectMs },
            meta: { tls: tlsMeta },
          })
        );
        return;
      }

      sock.write(payload);
      setTimeout(
        () => {
          const recv = Buffer.concat(chunks).toString("utf8");
          const total = performance.now() - t0;
          finish(
            ok(
              `TLS connected to ${host}:${port}\n` +
                (recv ? `\n${recv}` : "(no data received)"),
              total,
              {
                timings: { tls: connectMs, total },
                meta: { tls: tlsMeta },
              }
            )
          );
        },
        Math.min(1000, timeoutMs)
      );
    });

    sock.on("data", (d) => chunks.push(d));
    // `on` (persistent) so a late error after finish can't go uncaught.
    sock.on("error", (e) => finish(fail(errMsg(e), performance.now() - t0)));
  });
}

function tcpRtt(
  host: string,
  port: number,
  timeoutMs: number
): Promise<number | null> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const sock = net.createConnection({ host, port });
    let settled = false;
    const done = (v: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    // `on` (persistent) so a late RST after we resolve can't go uncaught.
    sock.on("error", () => done(null));
    sock.once("connect", () => done(performance.now() - t0));
  });
}

export async function runPing(
  host: string,
  port: number,
  count: number,
  timeoutMs: number
): Promise<ResponseResult> {
  const target = port || 80;
  const rtts: number[] = [];
  const lines: string[] = [];
  let lost = 0;
  for (let i = 0; i < count; i++) {
    const ms = await tcpRtt(host, target, timeoutMs);
    if (ms === null) {
      lost++;
      lines.push(`#${i + 1}  timeout`);
    } else {
      rtts.push(ms);
      lines.push(`#${i + 1}  ${ms.toFixed(1)} ms`);
    }
  }
  const okAny = rtts.length > 0;
  const min = okAny ? Math.min(...rtts) : 0;
  const max = okAny ? Math.max(...rtts) : 0;
  const avg = okAny ? rtts.reduce((a, b) => a + b, 0) / rtts.length : 0;
  const lossPct = Math.round((lost / count) * 100);
  const body = [
    `TCP ping ${host}:${target}`,
    ...lines,
    "",
    `${count} sent, ${rtts.length} ok, ${lossPct}% loss`,
    okAny
      ? `min/avg/max = ${min.toFixed(1)}/${avg.toFixed(1)}/${max.toFixed(1)} ms`
      : "",
  ]
    .filter((l) => l !== undefined)
    .join("\n");
  return {
    status: okAny ? 200 : 0,
    statusText: okAny ? "OK" : "",
    ok: okAny,
    url: "",
    headers: {},
    bodyText: body,
    size: Buffer.byteLength(body),
    durationMs: Math.round(avg),
    timings: okAny ? { total: avg } : undefined,
    meta: { rtts, min, avg, max, lossPct, sent: count },
  };
}

export function runUdp(
  host: string,
  port: number,
  payload: string,
  waitResponse: boolean,
  timeoutMs: number
): Promise<ResponseResult> {
  const t0 = performance.now();
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    let settled = false;
    const done = (res: ResponseResult) => {
      if (settled) return;
      settled = true;
      try {
        sock.close();
      } catch {
        /* already closed */
      }
      resolve(res);
    };
    const buf = Buffer.from(payload, "utf8");
    const timer = waitResponse
      ? setTimeout(
          () =>
            done(
              ok(
                `sent ${buf.length} bytes to ${host}:${port}\n(no response within ${timeoutMs}ms)`,
                performance.now() - t0
              )
            ),
          timeoutMs
        )
      : null;
    sock.on("message", (m) => {
      if (timer) clearTimeout(timer);
      // Surface the raw datagram bytes when they aren't clean text, so the response panel's
      // hex viewer can inspect a binary UDP reply end-to-end (offset│hex│ASCII).
      const binary = isBinary(m);
      const extra: Partial<ResponseResult> = { meta: { received: m.length } };
      if (binary) {
        extra.bodyBase64 = m.toString("base64");
        extra.contentType = "application/octet-stream";
      }
      done(
        ok(
          `sent ${buf.length} bytes to ${host}:${port}\nreceived ${m.length} bytes:\n` +
            (binary ? "(binary payload — view as hex)" : m.toString("utf8")),
          performance.now() - t0,
          extra
        )
      );
    });
    sock.on("error", (e) => {
      if (timer) clearTimeout(timer);
      done(fail(errMsg(e), performance.now() - t0));
    });
    sock.send(buf, port, host, (err) => {
      if (err) {
        if (timer) clearTimeout(timer);
        done(fail(errMsg(err), performance.now() - t0));
      } else if (!waitResponse) {
        done(
          ok(
            `sent ${buf.length} bytes to ${host}:${port}`,
            performance.now() - t0
          )
        );
      }
    });
  });
}
