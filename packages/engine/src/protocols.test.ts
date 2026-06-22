import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import type { AddressInfo } from "node:net";
import {
  runTcp,
  runTls,
  runUdp,
  runPing,
  runDns,
  parseHexPayload,
} from "./protocols.js";

// Self-signed certificate for loopback TLS tests (CN=localhost, SAN=DNS:localhost,IP:127.0.0.1).
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCrCajtVfHS49hi
aSFdzQuGEbfJWxFrmxf4OrTH0EzHhee/a/7XcsUmBEc0iH1VnMs7EfnQNUFscyza
Zcs05fxc90HVxOjpcR1fGBkqV0Yl333vbI9Mxr4Z2PdwDfuO8/nkHSUNYGM9LFA5
YGgJ6o+lXs8SgrSNVblqJSjHUCZSqYl5x0ochbhOpwRdCq/BBhmraNtifuSAEKXy
UHr81nsTZzFjelOjUHIl9rmKfRXfY3H5bDbgr5aRxVOMJQovOMD8/L+lDKGpOniS
T9meZCQtSM8itCmnNJbchXrUBekJdiMYwdlJcbfC+CmpHPhCAq0W8NBY2yRcPyXo
0A/uVTKbAgMBAAECggEAIas8IsRJX09U2EKDu/hSLWkteajArCMSu92qmq7pfllg
vnDe8MB6CLrM3Y2Exqaf5xfpyk/BejzN9owVTWt8mzxdLFyf0NxggMi4o3ocp/Xv
z4LaTq3M3D+2rctC2ugyJ/KIybJQtskTXcgZkuImttIMB0PNkQjv//IireGcOact
SVG5WqoyiR3gaGOg5jGZ/mqBsu55lkp5VUjnX1KjZGWLus5D3+vXKaL3hPcJf3ys
wSnTQtm+Sdpzdb60rbDdYOPuuBDIM+onOmMS2YjAK51QEoeC1qUbTo9mhoemeSyh
Yo6RQ41IVPXFNylOWC3946pa+2CSLwFVjDQvgApQMQKBgQDnWb7r4pOAoToEHWGD
I6utJhGrtMZFFi4gXcTQfktb0HPkqVRUPYMzlcxN8yZ6I8vR+MWRQjAaHn4AP8lA
obCT+OhY+hbZBrWZXwBjnePOjS/qzHYA6qzA8WwhZlnzN/6IaP0T+ZTuG/fH0uH/
ohjrw5VEQC/Izv7R6ppF/IrO+QKBgQC9QtZ8+ddJNnnjh6wBk+rrhLcqpkbFTKJq
R85tEw0pZpw5aZqkxOCR+bXWSmTyKQuQue/1wNjMcnhfQo13gySeuT50/qtnvtQa
lMFlrbj0IJ0OK4IiqUiYeEpwtMRoQjw90M8Ssu4IsKnIMMkPVfMzA/B6qMf7BZx4
UM3BcnBvMwKBgBx780LNucV7lE4PZAMmcCu4ZTKT5ll5OqKniOT2t8aNKse7hXN9
w1qller/BfzBzYWDsKeK06tTl8XmFJxNjBUb71eNKyT7a35/sOeS+AplXcH1/I1u
V2jGEL8n/+kvOrqG2qoL76dFcEN9FnBH//N/ODCYCooZ2kv0K5x0VI7ZAoGATlAP
zJrc+FBwUzPaerSoKlg6Ko2vDwjM08luozeU5KKu1hragH9upTh8g3U5G/Lb9EDc
CAaKLt7W7CPvwZokVwEz1NlkN4OA5JbVB6vAslOkaS6bpJgDkAOGWeiStMljf/id
FpGvaS0gs9Nr/sqD3YItybN5PGdv/WECIp+l4n0CgYBVCMywA2ZBOLbm4+qL1i8h
u4E1rc51BGBlieQZNoRVGhwrMgJLYhm/KJbKbp/ZDd6fGvisHMjaHu3cpRrb/6JG
gDIbkeM6EfC3WHpx1C7hPQ0oFq845mWQrSzOZxAVrIx66J+Iqrz4lELRksu+WcLQ
+22N84W0bSgnhnqMsLMjTw==
-----END PRIVATE KEY-----`;

const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUZB559eMBJsnQGRh7MwoVXajew0QwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDYyMjE2NDAxOFoXDTM2MDYx
OTE2NDAxOFowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAqwmo7VXx0uPYYmkhXc0LhhG3yVsRa5sX+Dq0x9BMx4Xn
v2v+13LFJgRHNIh9VZzLOxH50DVBbHMs2mXLNOX8XPdB1cTo6XEdXxgZKldGJd99
72yPTMa+Gdj3cA37jvP55B0lDWBjPSxQOWBoCeqPpV7PEoK0jVW5aiUox1AmUqmJ
ecdKHIW4TqcEXQqvwQYZq2jbYn7kgBCl8lB6/NZ7E2cxY3pTo1ByJfa5in0V32Nx
+Ww24K+WkcVTjCUKLzjA/Py/pQyhqTp4kk/ZnmQkLUjPIrQppzSW3IV61AXpCXYj
GMHZSXG3wvgpqRz4QgKtFvDQWNskXD8l6NAP7lUymwIDAQABo28wbTAdBgNVHQ4E
FgQUQfircYvDgfWywWO01XxlTbaxmxQwHwYDVR0jBBgwFoAUQfircYvDgfWywWO0
1XxlTbaxmxQwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH
BH8AAAEwDQYJKoZIhvcNAQELBQADggEBAGI/F8jf/wgi1OQFGtu5DBiR4vyeoUc/
UniVRhdG98m0lEo7kY4eCm73691SPXGH/WBSKXsNdVAGtNus35cTt9302Z3ctDHu
KyZqZcyaUz1/pyU1QanKYkzoZmtAcslel5rQXGvB7VGbCBCLiH65BBwaW0jJq0mJ
d6+y9iJDbSiMa0TUCS8cY/LpDqGM/+PdM9/+bVIbbGmlmY+ENPCrYo01vKodIf4O
CRybeX5dENhKh7eHgKo37Uu7LuR0UP1Vb7LVkGN2aBHDoanFa29y4tMwck/5UT+L
BcTCTa31tpwZEubvFdLvZC/ICzN3t+0TFewCDeJR+ANyjQUgVCD6DMg=
-----END CERTIFICATE-----`;

let tcpServer: net.Server;
let tcpPort = 0;
let tlsServer: tls.Server;
let tlsPort = 0;
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

  const liveTlsSockets = new Set<tls.TLSSocket>();
  tlsServer = tls.createServer({ key: TEST_KEY, cert: TEST_CERT }, (sock) => {
    liveTlsSockets.add(sock);
    sock.on("error", () => {});
    sock.on("close", () => liveTlsSockets.delete(sock));
    sock.end("tls-hello");
  });
  await new Promise<void>((r) => tlsServer.listen(0, "127.0.0.1", r));
  tlsPort = (tlsServer.address() as AddressInfo).port;
  // expose for afterAll cleanup
  (tlsServer as unknown as Record<string, unknown>).__liveSockets =
    liveTlsSockets;

  udpServer = dgram.createSocket("udp4");
  udpServer.on("message", (msg, rinfo) => {
    // A "bin" request triggers a binary reply (control bytes); otherwise echo as text.
    const reply =
      msg.toString("utf8") === "bin"
        ? Buffer.from([0x00, 0x01, 0xff, 0x7f, 0x41])
        : Buffer.concat([Buffer.from("echo:"), msg]);
    udpServer.send(reply, rinfo.port, rinfo.address);
  });
  await new Promise<void>((r) => udpServer.bind(0, "127.0.0.1", r));
  udpPort = (udpServer.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const s of liveSockets) s.destroy();
  const liveTlsSockets = (tlsServer as unknown as Record<string, unknown>)
    .__liveSockets as Set<tls.TLSSocket> | undefined;
  if (liveTlsSockets) for (const s of liveTlsSockets) s.destroy();
  await new Promise<void>((r) => tcpServer.close(() => r()));
  await new Promise<void>((r) => tlsServer.close(() => r()));
  await new Promise<void>((r) => udpServer.close(() => r()));
});

describe("runTls", () => {
  it("connects and reports TLS version, cipher, cert, and SNI in meta.tls", async () => {
    const r = await runTls("127.0.0.1", tlsPort, "", "localhost", true, 5000);
    expect(r.ok).toBe(true);
    expect(r.bodyText).toContain("TLS connected to 127.0.0.1");
    expect(r.timings?.tls).toBeGreaterThanOrEqual(0);

    const t = r.meta?.tls as Record<string, unknown>;
    expect(t).toBeTruthy();
    expect(typeof t.version).toBe("string");
    expect(typeof t.cipher).toBe("string");
    expect(t.sni).toBe("localhost");

    const cert = t.cert as Record<string, unknown>;
    expect(cert).toBeTruthy();
    expect(String(cert.subject)).toContain("localhost");
    expect(String(cert.issuer)).toContain("localhost");
    expect(typeof cert.validFrom).toBe("string");
    expect(typeof cert.validTo).toBe("string");
    expect(Array.isArray(cert.san)).toBe(true);
    expect((cert.san as string[]).some((s) => s.includes("localhost"))).toBe(
      true
    );
  });

  it("reads server data when payload is provided", async () => {
    const r = await runTls(
      "127.0.0.1",
      tlsPort,
      "ping",
      "localhost",
      true,
      5000
    );
    expect(r.ok).toBe(true);
    expect(r.bodyText).toContain("tls-hello");
    expect(r.meta?.tls).toBeTruthy();
  });

  it("fails on a closed port", async () => {
    const r = await runTls("127.0.0.1", 1, "", "", true, 1000);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toBeTruthy();
  });
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

  it("surfaces a binary reply as base64 for the hex viewer", async () => {
    const r = await runUdp("127.0.0.1", udpPort, "bin", true, 2000);
    expect(r.ok).toBe(true);
    expect(r.contentType).toBe("application/octet-stream");
    expect(r.bodyBase64).toBe(
      Buffer.from([0x00, 0x01, 0xff, 0x7f, 0x41]).toString("base64")
    );
    expect(r.meta?.received).toBe(5);
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

describe("parseHexPayload", () => {
  it("parses lowercase hex", () => {
    expect(parseHexPayload("deadbeef")).toEqual(
      Buffer.from([0xde, 0xad, 0xbe, 0xef])
    );
  });

  it("parses uppercase hex", () => {
    expect(parseHexPayload("DEADBEEF")).toEqual(
      Buffer.from([0xde, 0xad, 0xbe, 0xef])
    );
  });

  it("ignores whitespace between pairs", () => {
    expect(parseHexPayload("de ad be ef")).toEqual(
      Buffer.from([0xde, 0xad, 0xbe, 0xef])
    );
  });

  it("returns empty buffer for empty string", () => {
    expect(parseHexPayload("")).toEqual(Buffer.alloc(0));
    expect(parseHexPayload("   ")).toEqual(Buffer.alloc(0));
  });

  it("throws on odd number of hex digits", () => {
    expect(() => parseHexPayload("abc")).toThrow(/invalid hex/);
  });

  it("throws on non-hex characters", () => {
    expect(() => parseHexPayload("zz")).toThrow(/invalid hex/);
    expect(() => parseHexPayload("0g")).toThrow(/invalid hex/);
  });
});

describe("runUdp hex mode", () => {
  it("sends exact bytes from hex payload and echoes them", async () => {
    // UDP loopback server echoes: Buffer.concat([Buffer.from("echo:"), msg])
    // We send hex "68656c6c6f" = "hello" → expect "echo:hello"
    const r = await runUdp(
      "127.0.0.1",
      udpPort,
      "68 65 6c 6c 6f",
      true,
      2000,
      "hex"
    );
    expect(r.ok).toBe(true);
    expect(r.bodyText).toContain("echo:hello");
  });

  it("returns an error result for invalid hex without opening a socket", async () => {
    const r = await runUdp("127.0.0.1", udpPort, "xyz", true, 2000, "hex");
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/invalid hex/);
  });
});

describe("runTcp hex mode", () => {
  it("returns an error result for invalid hex without connecting", async () => {
    const r = await runTcp("127.0.0.1", tcpPort, "xyz", 2000, "hex");
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/invalid hex/);
  });
});

describe("runUdp multicast", () => {
  // 239.x.x.x is the administratively-scoped (organisation-local) multicast range —
  // safe for a loopback test that never leaves the host.
  const GROUP = "239.255.42.99";

  it("sends to a multicast group and collects a response", async () => {
    // A group member bound to the group port that echoes datagrams back to the sender.
    const member = dgram.createSocket({ type: "udp4", reuseAddr: true });
    member.on("message", (msg, rinfo) => {
      member.send(
        Buffer.concat([Buffer.from("mcast:"), msg]),
        rinfo.port,
        rinfo.address
      );
    });
    const groupPort = await new Promise<number>((res) => {
      member.bind(0, () => {
        member.addMembership(GROUP);
        member.setMulticastLoopback(true);
        res((member.address() as AddressInfo).port);
      });
    });

    try {
      const r = await runUdp(
        "239.255.42.99",
        groupPort,
        "ping",
        true,
        2000,
        "text",
        {
          ttl: 1,
        }
      );
      expect(r.ok).toBe(true);
      expect(r.bodyText).toContain("mcast:ping");
    } finally {
      await new Promise<void>((res) => member.close(() => res()));
    }
  });

  it("reports no response when the group is silent (send still succeeds)", async () => {
    const r = await runUdp(
      "239.255.42.123",
      45999,
      "hello",
      true,
      400,
      "text",
      {
        ttl: 1,
      }
    );
    expect(r.ok).toBe(true);
    expect(r.bodyText).toContain("no response");
  });
});
