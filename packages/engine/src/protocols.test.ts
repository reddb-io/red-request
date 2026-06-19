import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import dgram from "node:dgram";
import type { AddressInfo } from "node:net";
import { runTcp, runUdp, runPing, runDns } from "./protocols.js";

let tcpServer: net.Server;
let tcpPort = 0;
let udpServer: dgram.Socket;
let udpPort = 0;
const liveSockets = new Set<net.Socket>();

beforeAll(async () => {
  tcpServer = net.createServer((sock) => {
    liveSockets.add(sock);
    sock.on("error", () => {});
    sock.on("close", () => liveSockets.delete(sock));
    sock.end("hello-from-server");
  });
  await new Promise<void>((r) => tcpServer.listen(0, "127.0.0.1", r));
  tcpPort = (tcpServer.address() as AddressInfo).port;

  udpServer = dgram.createSocket("udp4");
  udpServer.on("message", (msg, rinfo) =>
    udpServer.send(
      Buffer.concat([Buffer.from("echo:"), msg]),
      rinfo.port,
      rinfo.address
    )
  );
  await new Promise<void>((r) => udpServer.bind(0, "127.0.0.1", r));
  udpPort = (udpServer.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const s of liveSockets) s.destroy();
  await new Promise<void>((r) => tcpServer.close(() => r()));
  await new Promise<void>((r) => udpServer.close(() => r()));
});

describe("runTcp", () => {
  it("connects and reads the response", async () => {
    const r = await runTcp("127.0.0.1", tcpPort, "ping", 3000);
    expect(r.ok).toBe(true);
    expect(r.bodyText).toContain("connected to 127.0.0.1");
    expect(r.bodyText).toContain("hello-from-server");
    expect(r.timings?.tcp).toBeGreaterThanOrEqual(0);
  });

  it("fails on a closed port", async () => {
    const r = await runTcp("127.0.0.1", 1, "", 1000);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toBeTruthy();
  });
});

describe("runPing", () => {
  it("measures N TCP connects with stats", async () => {
    const r = await runPing("127.0.0.1", tcpPort, 3, 2000);
    expect(r.ok).toBe(true);
    expect((r.meta?.rtts as number[]).length).toBe(3);
    expect(r.meta?.lossPct).toBe(0);
    expect(r.bodyText).toContain("min/avg/max");
  });
});

describe("runUdp", () => {
  it("sends a datagram and receives the echo", async () => {
    const r = await runUdp("127.0.0.1", udpPort, "hi", true, 2000);
    expect(r.ok).toBe(true);
    expect(r.bodyText).toContain("echo:hi");
  });
});

describe("runDns", () => {
  it("resolves A records (live)", async () => {
    const r = await runDns("example.com", "A");
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.meta?.records)).toBe(true);
    expect((r.meta?.records as string[]).length).toBeGreaterThan(0);
  }, 15000);
});
