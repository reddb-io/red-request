// Maps RPC method names to handlers. Each handler takes validated params and returns a
// serializable result. Schemas live in @red-requester/core so the UI and engine agree.
import {
  ENGINE_METHODS,
  httpSendParamsSchema,
  oauth2TokenParamsSchema,
  runnerParamsSchema,
  resolveRequest,
  type HttpSendResult,
  type Oauth2TokenResult,
  type RunnerResult,
} from "@red-requester/core";
import reckerPkg from "recker/package.json" with { type: "json" };
import { dispatch, oauth2Token } from "./recker.js";
import { runPipeline } from "./pipeline.js";
import { runLoop } from "./runner.js";

export type Handler = (params: unknown) => Promise<unknown>;

export const handlers: Record<string, Handler> = {
  [ENGINE_METHODS.httpSend]: async (raw): Promise<HttpSendResult> => {
    const { request, variables } = httpSendParamsSchema.parse(raw);
    const out = await runPipeline(request, variables);
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
