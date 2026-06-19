// The single request pipeline: pre-request script → resolve {{vars}}/path → dispatch →
// post-response script. Shared by `http.send` and the runner so behavior is identical.
import {
  resolveRequest,
  type RequestDefinition,
  type ResponseResult,
  type ScriptResult,
} from "@red-requester/core";
import { dispatch } from "./recker.js";
import { runPreRequest, runPostResponse } from "./sandbox.js";

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
  variables: Record<string, string>
): Promise<PipelineOutcome> {
  const vars: Record<string, string> = { ...variables };
  const pre = await runPreRequest(def, vars);
  const { request: resolved, unresolved } = resolveRequest(def, vars);
  const response = await dispatch(resolved);
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
