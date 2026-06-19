// Runner / loops: repeat N, data-driven (one run per dataset row), and flow (a sequence
// of requests where each post-response `setVar` threads into the next).
import type {
  RunnerParams,
  RunnerResult,
  RunIteration,
} from "@red-request/core";
import { runPipeline } from "./pipeline.js";

function iteration(
  index: number,
  label: string,
  reqId: string,
  reqName: string,
  method: string,
  out: Awaited<ReturnType<typeof runPipeline>>
): RunIteration {
  return {
    index,
    label,
    reqId,
    reqName,
    method,
    url: out.effectiveUrl,
    response: out.response,
    scriptResult: out.scriptResult,
  };
}

export async function runLoop(params: RunnerParams): Promise<RunnerResult> {
  const iterations: RunIteration[] = [];

  if (params.mode === "repeat") {
    const r = params.request;
    for (let i = 0; i < params.count; i++) {
      const out = await runPipeline(r, params.variables);
      iterations.push(iteration(i, `#${i + 1}`, r.id, r.name, r.method, out));
    }
  } else if (params.mode === "data") {
    const r = params.request;
    for (let i = 0; i < params.dataset.length; i++) {
      const row = params.dataset[i] ?? {};
      const out = await runPipeline(r, { ...params.variables, ...row });
      const label = Object.entries(row)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")
        .slice(0, 48);
      iterations.push(
        iteration(i, label || `row ${i + 1}`, r.id, r.name, r.method, out)
      );
    }
  } else {
    // flow: run requests in order, carrying setVar changes forward.
    let vars: Record<string, string> = { ...params.variables };
    for (let i = 0; i < params.requests.length; i++) {
      const def = params.requests[i]!;
      const out = await runPipeline(def, vars);
      vars = { ...vars, ...out.vars };
      iterations.push(
        iteration(i, def.name, def.id, def.name, def.method, out)
      );
    }
  }

  const okCount = iterations.filter((it) => it.response.ok).length;
  const passed = iterations.reduce(
    (s, it) => s + (it.scriptResult?.tests.filter((t) => t.passed).length ?? 0),
    0
  );
  const failed = iterations.reduce(
    (s, it) =>
      s + (it.scriptResult?.tests.filter((t) => !t.passed).length ?? 0),
    0
  );
  const avgMs = iterations.length
    ? Math.round(
        iterations.reduce((s, it) => s + it.response.durationMs, 0) /
          iterations.length
      )
    : 0;

  return {
    iterations,
    aggregate: { total: iterations.length, okCount, passed, failed, avgMs },
  };
}
