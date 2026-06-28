import { describe, expect, it } from "vitest";
import type { ResponseResult } from "@reddb-io/request-core";
import { buildResponseInsights } from "./responseInsights";

function response(patch: Partial<ResponseResult> = {}): ResponseResult {
  return {
    status: 200,
    statusText: "OK",
    ok: true,
    url: "https://api.example.test/v1/users",
    headers: {},
    bodyText: "{}",
    contentType: "application/json",
    size: 2,
    durationMs: 50,
    ...patch,
  };
}

describe("buildResponseInsights", () => {
  it("adds destination diagnostics from request-visible DNS, TCP, TLS and protocol data", () => {
    const insights = buildResponseInsights(
      response({
        durationMs: 740,
        timings: {
          dns: 32,
          tcp: 96,
          tls: 180,
          firstByte: 640,
          total: 740,
        },
        meta: {
          tls: {
            version: "TLSv1.3",
            cipher: "TLS_AES_128_GCM_SHA256",
            sni: "api.example.test",
            alpn: "h2",
            remote: { ip: "203.0.113.10", port: 443 },
            cert: {
              subject: "CN=api.example.test",
              issuer: "CN=Example CA",
              validFrom: "2026-01-01T00:00:00Z",
              validTo: "2026-12-31T00:00:00Z",
              san: ["DNS:api.example.test"],
            },
          },
        },
      })
    );

    expect(insights.map((i) => i.title)).toEqual(
      expect.arrayContaining([
        "Destination",
        "DNS lookup",
        "TCP connect",
        "TLS handshake",
        "Protocol negotiated",
        "Remote certificate",
      ])
    );
    expect(insights.find((i) => i.title === "Destination")?.value).toBe(
      "203.0.113.10:443"
    );
    expect(insights.find((i) => i.title === "Protocol negotiated")?.value).toBe(
      "h2"
    );
  });

  it("surfaces operational hints the user did not explicitly ask for", () => {
    const insights = buildResponseInsights(
      response({
        status: 429,
        statusText: "Too Many Requests",
        ok: false,
        headers: {
          "retry-after": "30",
          "x-ratelimit-remaining": "0",
          "x-request-id": "req-123",
          "server-timing": "edge;dur=42, app;dur=250",
        },
        bodyText: "x".repeat(150 * 1024),
        contentType: "application/json",
        size: 150 * 1024,
        durationMs: 320,
      })
    );

    expect(insights.map((i) => i.title)).toEqual(
      expect.arrayContaining([
        "Retry-After",
        "Rate limit remaining",
        "Trace identifier",
        "Server-Timing",
        "Compression opportunity",
      ])
    );
  });
});
