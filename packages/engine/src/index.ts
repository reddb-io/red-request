// Library entry — what other packages (e.g. @red-request/cli) import. The sidecar binary
// (NDJSON loop) lives in main.ts and is the package `bin`, kept separate from this.
export { runPipeline, type PipelineOutcome } from "./pipeline.js";
export { dispatch } from "./recker.js";
