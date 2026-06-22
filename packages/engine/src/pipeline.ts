// The single request pipeline: pre-request script → resolve {{vars}}/path → dispatch →
// post-response script. Shared by `http.send` and the runner so behavior is identical.
import {
  resolveRequest,
  type RequestDefinition,
  type ResponseResult,
  type ScriptResult,
} from "@red-request/core";
import { dispatch } from "./recker.js";
import { runPreRequest, runPostResponse } from "./sandbox.js";
import {
  runWhois,
  runDns,
  runTcp,
  runTls,
  runUdp,
  runPing,
} from "./protocols.js";

/** Dispatch a non-HTTP kind to its protocol handler. */
function dispatchProtocol(def: RequestDefinition): Promise<ResponseResult> {
  const n = def.net;
  switch (def.kind) {
    case "tcp":
      return runTcp(n.host, n.port, n.payload, n.timeoutMs, n.payloadMode);
    case "tls":
      return runTls(
        n.host,
        n.port,
        n.payload,
        n.sni,
        def.insecure,
        n.timeoutMs,
        n.payloadMode
      );
    case "udp":
      return runUdp(
        n.host,
        n.port,
        n.payload,
        n.waitResponse,
        n.timeoutMs,
        n.payloadMode
      );
    case "ping":
      return runPing(n.host, n.port, n.count, n.timeoutMs);
    case "whois":
      return runWhois(n.host);
    case "dns":
      return runDns(n.host, n.recordType);
    default:
      return Promise.resolve({
        status: 0,
        statusText: "",
        ok: false,
        url: "",
        headers: {},
        bodyText: "",
        size: 0,
        durationMs: 0,
        error: { message: `unsupported kind: ${def.kind}` },
      });
  }
}

export interface PipelineOutcome {
  response: ResponseResult;
  effectiveUrl: string;
  unresolved: string[];
  scriptResult: ScriptResult;
  /** The variable map after pre/post `setVar` — used to thread vars in a flow. */
  vars: Record<string, string>;
}

export async function runPipeline(
  def: RequestDefinition,
  variables: Record<string, string>,
  cookieJarKey?: string
): Promise<PipelineOutcome> {
  const vars: Record<string, string> = { ...variables };
  const pre = await runPreRequest(def, vars);
  const { request: resolved, unresolved } = resolveRequest(def, vars);
  const response =
    resolved.kind === "http"
      ? await dispatch(resolved, cookieJarKey)
      : await dispatchProtocol(resolved);
  const post = await runPostResponse(def.scripts.postResponse, response, vars);
  return {
    response,
    effectiveUrl: resolved.url,
    unresolved,
    scriptResult: {
      logs: [...pre.logs, ...post.logs],
      tests: post.tests,
      varChanges: post.varChanges,
      error: pre.error ?? post.error,
    },
    vars,
  };
}
