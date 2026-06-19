// Non-HTTP request kinds. WHOIS/DNS use recker; TCP/ping use node:net (TCP-connect, since
// ICMP needs privileges); UDP uses node:dgram (recker/udp's client hung in testing). Each
// returns a ResponseResult so history/dashboard/runner/scripts work uniformly.
import net from "node:net";
import dgram from "node:dgram";
import { createClient } from "recker/client";
import { createDNS } from "recker/dns";
import type { ResponseResult } from "@red-request/core";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
      done(
        ok(
          `sent ${buf.length} bytes to ${host}:${port}\nreceived ${m.length} bytes:\n${m.toString("utf8")}`,
          performance.now() - t0,
          { meta: { received: m.length } }
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
