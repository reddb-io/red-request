// Maps RPC method names to handlers. Each handler takes validated params and returns a
// serializable result. Schemas live in @red-request/core so the UI and engine agree.
import {
  ENGINE_METHODS,
  httpSendParamsSchema,
  oauth2TokenParamsSchema,
  runnerParamsSchema,
  wsOpenParamsSchema,
  wsSendParamsSchema,
  wsCloseParamsSchema,
  cookiesClearParamsSchema,
  grpcMethodsParamsSchema,
  grpcCallParamsSchema,
  resolveRequest,
  resolveTemplate,
  type HttpSendResult,
  type GrpcMethodsResult,
  type Oauth2TokenResult,
  type RunnerResult,
} from "@red-request/core";
import reckerPkg from "recker/package.json" with { type: "json" };
import { dispatch, oauth2Token } from "./recker.js";
import { runPipeline } from "./pipeline.js";
import { runLoop } from "./runner.js";
import { wsOpen, wsSend, wsClose, sseOpen, sseClose } from "./stream.js";
import { clearJar } from "./cookies.js";
import { grpcListMethods, grpcCall } from "./grpc.js";

export type Handler = (params: unknown) => Promise<unknown>;

export const handlers: Record<string, Handler> = {
  [ENGINE_METHODS.httpSend]: async (raw): Promise<HttpSendResult> => {
    const { request, variables, cookieJarKey } =
      httpSendParamsSchema.parse(raw);
    const out = await runPipeline(request, variables, cookieJarKey);
    return {
      response: out.response,
      unresolved: out.unresolved,
      effectiveUrl: out.effectiveUrl,
      scriptResult: out.scriptResult,
    };
  },

  [ENGINE_METHODS.runnerRun]: async (raw): Promise<RunnerResult> => {
    return runLoop(runnerParamsSchema.parse(raw));
  },

  [ENGINE_METHODS.collectionDryRun]: async (raw): Promise<HttpSendResult> => {
    const { request, variables } = httpSendParamsSchema.parse(raw);
    const { request: resolved, unresolved } = resolveRequest(
      request,
      variables
    );
    // No dispatch — return what WOULD be sent (status 0 = not sent).
    return {
      response: {
        status: 0,
        statusText: "dry-run",
        ok: false,
        url: resolved.url,
        headers: {},
        bodyText: "",
        size: 0,
        durationMs: 0,
      },
      unresolved,
      effectiveUrl: resolved.url,
    };
  },

  [ENGINE_METHODS.wsOpen]: async (raw): Promise<{ ok: boolean }> => {
    const { id, request, variables } = wsOpenParamsSchema.parse(raw);
    return wsOpen(id, request, variables);
  },

  [ENGINE_METHODS.wsSend]: async (
    raw
  ): Promise<{ ok: boolean; error?: string }> => {
    const { id, data } = wsSendParamsSchema.parse(raw);
    return wsSend(id, data);
  },

  [ENGINE_METHODS.wsClose]: async (raw): Promise<{ ok: boolean }> => {
    const { id } = wsCloseParamsSchema.parse(raw);
    return wsClose(id);
  },

  [ENGINE_METHODS.sseOpen]: async (raw): Promise<{ ok: boolean }> => {
    const { id, request, variables } = wsOpenParamsSchema.parse(raw);
    return sseOpen(id, request, variables);
  },

  [ENGINE_METHODS.sseClose]: async (raw): Promise<{ ok: boolean }> => {
    const { id } = wsCloseParamsSchema.parse(raw);
    return sseClose(id);
  },

  [ENGINE_METHODS.cookiesClear]: async (raw): Promise<{ ok: boolean }> => {
    const { key } = cookiesClearParamsSchema.parse(raw);
    clearJar(key);
    return { ok: true };
  },

  [ENGINE_METHODS.grpcMethods]: async (raw): Promise<GrpcMethodsResult> => {
    const { proto } = grpcMethodsParamsSchema.parse(raw);
    return grpcListMethods(proto);
  },

  [ENGINE_METHODS.grpcCall]: async (raw): Promise<HttpSendResult> => {
    const { request, variables } = grpcCallParamsSchema.parse(raw);
    const t = (s: string) => resolveTemplate(s, variables).value;
    const g = request.grpc;
    const address = t(request.url);
    const response = await grpcCall({
      address,
      proto: g.proto,
      service: g.service,
      method: g.method,
      message: t(g.message),
      plaintext: g.plaintext,
      metadata: g.metadata
        .filter((m) => m.enabled && m.name.trim())
        .map((m) => ({ name: t(m.name), value: t(m.value) })),
    });
    return { response, unresolved: [], effectiveUrl: address };
  },

  [ENGINE_METHODS.oauth2Token]: async (raw): Promise<Oauth2TokenResult> => {
    const params = oauth2TokenParamsSchema.parse(raw);
    return oauth2Token(params);
  },

  [ENGINE_METHODS.metaReckerVersion]: async (): Promise<{
    version: string;
  }> => {
    return { version: (reckerPkg as { version: string }).version };
  },
};
