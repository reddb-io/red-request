// gRPC over @grpc/grpc-js + @grpc/proto-loader. v1 supports a pasted single-file .proto and
// unary calls. The .proto is written to a temp file (proto-loader needs a path); imports
// across files aren't resolved yet. Streaming methods are flagged but not invoked.
import * as protoLoader from "@grpc/proto-loader";
import grpc from "@grpc/grpc-js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ResponseResult } from "@reddb-io/request-core";

/* eslint-disable @typescript-eslint/no-explicit-any */
const LOAD_OPTS = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
};

function loadProto(proto: string): any {
  const dir = mkdtempSync(join(tmpdir(), "rr-grpc-"));
  const file = join(dir, "service.proto");
  writeFileSync(file, proto);
  return grpc.loadPackageDefinition(protoLoader.loadSync(file, LOAD_OPTS));
}

function sampleType(t: unknown): unknown {
  const s = String(t).toUpperCase();
  if (s.includes("STRING") || s.includes("BYTES")) return "";
  if (s.includes("BOOL")) return false;
  if (
    s.includes("INT") ||
    s.includes("FLOAT") ||
    s.includes("DOUBLE") ||
    s.includes("FIXED")
  )
    return 0;
  if (s.includes("MESSAGE")) return {};
  return null;
}
function skeletonFor(type: any): string {
  const fields = type?.field;
  if (!Array.isArray(fields)) return "{}";
  const obj: Record<string, unknown> = {};
  for (const f of fields) {
    const repeated = f.label === 3 || String(f.label).includes("REPEATED");
    const base = sampleType(f.type);
    obj[f.name] = repeated ? [base] : base;
  }
  return JSON.stringify(obj, null, 2);
}

export interface GrpcMethod {
  name: string;
  requestStream: boolean;
  responseStream: boolean;
  requestType?: string;
  skeleton: string;
}
export interface GrpcService {
  name: string;
  methods: GrpcMethod[];
}

/** Parse a .proto and list its services + unary/streaming methods (+ a request skeleton). */
export function grpcListMethods(proto: string): {
  services: GrpcService[];
  error?: string;
} {
  try {
    const pkg = loadProto(proto);
    const services: GrpcService[] = [];
    const walk = (obj: any, prefix: string): void => {
      for (const [k, v] of Object.entries<any>(obj)) {
        const name = prefix ? `${prefix}.${k}` : k;
        if (typeof v === "function" && v.service) {
          const methods: GrpcMethod[] = Object.entries<any>(v.service).map(
            ([m, d]) => ({
              name: m,
              requestStream: !!d.requestStream,
              responseStream: !!d.responseStream,
              requestType: d.requestType?.type?.name,
              skeleton: skeletonFor(d.requestType?.type),
            })
          );
          services.push({ name, methods });
        } else if (v && typeof v === "object" && !Array.isArray(v)) {
          walk(v, name);
        }
      }
    };
    walk(pkg, "");
    return { services };
  } catch (e) {
    return { services: [], error: e instanceof Error ? e.message : String(e) };
  }
}

export interface GrpcCallInput {
  address: string;
  proto: string;
  service: string;
  method: string;
  message: string;
  plaintext: boolean;
  metadata: { name: string; value: string }[];
}

/** Make a unary gRPC call and map it onto a ResponseResult (status 0; gRPC status in meta). */
export function grpcCall(input: GrpcCallInput): Promise<ResponseResult> {
  const started = Date.now();
  const fail = (message: string, classification = "ERROR"): ResponseResult => ({
    status: 0,
    statusText: classification,
    ok: false,
    url: input.address,
    headers: {},
    bodyText: "",
    size: 0,
    durationMs: Date.now() - started,
    error: { message, classification },
  });

  return new Promise<ResponseResult>((resolve) => {
    let pkg: any;
    try {
      pkg = loadProto(input.proto);
    } catch (e) {
      return resolve(fail(e instanceof Error ? e.message : String(e), "PROTO"));
    }
    const Svc = input.service.split(".").reduce((o: any, k) => o?.[k], pkg);
    if (typeof Svc !== "function")
      return resolve(fail(`service not found: ${input.service}`, "NOT_FOUND"));

    const methodDef = (Svc.service ?? {})[input.method];
    if (!methodDef)
      return resolve(fail(`method not found: ${input.method}`, "NOT_FOUND"));
    if (methodDef.requestStream || methodDef.responseStream)
      return resolve(
        fail(
          "streaming methods are not supported yet (unary only)",
          "UNIMPLEMENTED"
        )
      );

    let msg: unknown;
    try {
      msg = JSON.parse(input.message || "{}");
    } catch {
      return resolve(
        fail("request message is not valid JSON", "INVALID_ARGUMENT")
      );
    }

    const creds = input.plaintext
      ? grpc.credentials.createInsecure()
      : grpc.credentials.createSsl();
    const client: any = new Svc(input.address, creds);
    const md = new grpc.Metadata();
    for (const m of input.metadata) if (m.name) md.set(m.name, m.value);

    const fn = client[input.method];
    const deadline = new Date(Date.now() + 30_000);
    fn.call(client, msg, md, { deadline }, (err: any, res: any) => {
      client.close?.();
      if (err) {
        const code = grpc.status[err.code] ?? String(err.code ?? "ERROR");
        return resolve(fail(err.details || err.message || "gRPC error", code));
      }
      const bodyText = JSON.stringify(res, null, 2);
      resolve({
        status: 0,
        statusText: "OK",
        ok: true,
        url: input.address,
        headers: {},
        bodyText,
        contentType: "application/json",
        size: bodyText.length,
        durationMs: Date.now() - started,
        meta: { grpcStatus: "OK", method: `${input.service}/${input.method}` },
      });
    });
  });
}
