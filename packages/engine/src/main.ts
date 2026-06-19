#!/usr/bin/env node
// red-requester engine — the recker sidecar.
//
// Speaks NDJSON-RPC over stdio: one JSON object per line on stdin, one reply per line on
// stdout. The Rust shell owns this process and correlates replies by `id`. Nothing is
// ever printed to stdout except RPC replies/notifications — all diagnostics go to stderr.
import { createInterface } from "node:readline";
import { rpcRequestSchema } from "@red-requester/core";
import { handlers } from "./handlers.js";

function send(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function log(...args: unknown[]): void {
  // stderr only — stdout is reserved for the RPC channel.
  console.error("[engine]", ...args);
}

async function handleLine(line: string): Promise<void> {
  const trimmed = line.trim();
  if (trimmed === "") return;

  let id: number | string | null = null;
  try {
    const parsed = JSON.parse(trimmed);
    const req = rpcRequestSchema.parse(parsed);
    id = req.id;
    const handler = handlers[req.method];
    if (!handler) {
      send({ id, error: { message: `unknown method: ${req.method}` } });
      return;
    }
    const result = await handler(req.params);
    send({ id, result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (id === null) {
      log("failed to parse request:", message);
      send({ id: null, error: { message: `bad request: ${message}` } });
    } else {
      send({ id, error: { message } });
    }
  }
}

function main(): void {
  log(`up (node ${process.version}); waiting for NDJSON on stdin`);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    void handleLine(line);
  });
  rl.on("close", () => {
    log("stdin closed; exiting");
    process.exit(0);
  });
}

main();
