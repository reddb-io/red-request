import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import type { ResponseResult } from "@reddb-io/request-core";
import { ws } from "../store.svelte";
import ResponsePanel from "./ResponsePanel.svelte";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
}));

vi.mock("../fs", () => ({
  writeText: vi.fn(),
}));

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

describe("ResponsePanel insights", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    ws.sending = false;
    ws.errorMsg = null;
    ws.exampleView = null;
    ws.tests = [];
    ws.logs = [];
    ws.scriptError = null;
    ws.unresolved = [];
    ws.secretDecryptFailures = [];
    ws.reqHistory = [];
    ws.activeReq = null;
  });

  afterEach(() => {
    cleanup();
    ws.response = null;
  });

  it("surfaces destination, route, redirect, cache, payload and bottleneck signals", async () => {
    ws.response = response({
      status: 302,
      statusText: "Found",
      ok: false,
      headers: {
        location: "https://api.example.test/login",
        "cache-control": "no-store",
      },
      size: 7 * 1024 * 1024,
      durationMs: 1800,
      timings: {
        dns: 24,
        tcp: 82,
        proxyConnect: 240,
        firstByte: 1320,
        total: 1800,
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
    });

    render(ResponsePanel);
    await fireEvent.click(screen.getByRole("button", { name: "insights" }));

    expect(screen.getByText("Destination")).toBeTruthy();
    expect(screen.getByText("api.example.test")).toBeTruthy();
    expect(screen.getByText("203.0.113.10:443")).toBeTruthy();
    expect(screen.getByText("Proxy route observed")).toBeTruthy();
    expect(screen.getByText("Origin after proxy")).toBeTruthy();
    expect(screen.getByText("Redirect target")).toBeTruthy();
    expect(screen.getByText("https://api.example.test/login")).toBeTruthy();
    expect(screen.getByText("Response is not cacheable")).toBeTruthy();
    expect(screen.getByText("Large payload")).toBeTruthy();
    expect(screen.getByText("Dominant phase")).toBeTruthy();
  });

  it("calls out transport failures and retriable errors", async () => {
    ws.response = response({
      status: 0,
      statusText: "",
      ok: false,
      url: "https://api.example.test/v1/users",
      bodyText: "",
      size: 0,
      durationMs: 3100,
      error: {
        message: "getaddrinfo ENOTFOUND api.example.test",
        classification: "dns_error",
        retriable: true,
      },
    });

    render(ResponsePanel);
    await fireEvent.click(screen.getByRole("button", { name: "insights" }));

    expect(screen.getByText("Transport failure")).toBeTruthy();
    expect(screen.getByText("dns_error")).toBeTruthy();
    expect(screen.getByText("Retry may help")).toBeTruthy();
    expect(
      screen.getAllByText("getaddrinfo ENOTFOUND api.example.test").length
    ).toBeGreaterThan(0);
  });

  it("renders gRPC method, status and duration insights", async () => {
    ws.response = response({
      status: 0,
      statusText: "OK",
      ok: true,
      url: "grpcb.in:9000",
      durationMs: 82,
      meta: {
        grpcStatus: "OK",
        method: "grpcbin.GRPCBin/DummyUnary",
      },
    });

    render(ResponsePanel);
    await fireEvent.click(screen.getByRole("button", { name: "insights" }));

    expect(screen.getByText("gRPC method")).toBeTruthy();
    expect(screen.getByText("grpcbin.GRPCBin/DummyUnary")).toBeTruthy();
    expect(screen.getByText("gRPC status")).toBeTruthy();
    expect(screen.getByText("Unary call duration")).toBeTruthy();
    expect(screen.getAllByText("82 ms").length).toBeGreaterThan(0);
  });
});
