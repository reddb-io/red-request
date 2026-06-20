import {
  mergeScopes,
  storedEnvironmentSchema,
  newRequest,
  curlToRequest,
  type LoadedCollection,
  type RequestDefinition,
  type ResponseResult,
  type StoredEnvironment,
  type ScriptTest,
  type HistoryEntry,
  type RunnerParams,
  type RunnerResult,
} from "@red-request/core";
import * as repo from "./repo";
import * as secrets from "./secrets";
import { httpSend, runnerRun } from "./rpc";
import { isTauri } from "./tauri";
import {
  projectInfo,
  openProject,
  recentSetCount,
  type ProjectInfo,
} from "./project";

class Workspace {
  ready = $state(false);
  bridgeMissing = $state(false);
  loadError = $state<string | null>(null);
  screen = $state<"selector" | "app">("selector");
  project = $state<ProjectInfo | null>(null);
  collections = $state<LoadedCollection[]>([]);

  activeColId = $state<string | null>(null);
  activeReq = $state<RequestDefinition | null>(null);
  activeEnvName = $state<string | null>(null);
  view = $state<"requests" | "dashboard">("requests");

  sending = $state(false);
  response = $state<ResponseResult | null>(null);
  unresolved = $state<string[]>([]);
  effectiveUrl = $state("");
  errorMsg = $state<string | null>(null);
  tests = $state<ScriptTest[]>([]);
  logs = $state<string[]>([]);
  scriptError = $state<string | null>(null);

  running = $state(false);
  runResult = $state<RunnerResult | null>(null);
  runError = $state<string | null>(null);

  /** History for the active request (newest first) — powers the Timings panel. */
  reqHistory = $state<HistoryEntry[]>([]);

  get activeCollection(): LoadedCollection | null {
    return this.collections.find((c) => c.id === this.activeColId) ?? null;
  }

  get environments(): StoredEnvironment[] {
    return this.activeCollection?.environments ?? [];
  }

  get activeEnv(): StoredEnvironment | null {
    return this.environments.find((e) => e.name === this.activeEnvName) ?? null;
  }

  /** Variable info in the current scope: name → resolved value + whether it's a secret.
   *  Precedence (later wins): collection vars < env vars < secrets. */
  get varInfo(): Record<string, { value: string; secret: boolean }> {
    const out: Record<string, { value: string; secret: boolean }> = {};
    const col = this.activeCollection;
    if (!col) return out;
    for (const [k, v] of Object.entries(col.collection.vars))
      out[k] = { value: v, secret: false };
    const env = this.activeEnv;
    if (env) {
      for (const [k, v] of Object.entries(env.vars))
        out[k] = { value: v, secret: false };
      for (const k of Object.keys(env.secrets))
        out[k] = { value: "", secret: true };
    }
    return out;
  }

  /** Variable names resolvable in the current scope. */
  get knownVars(): string[] {
    return Object.keys(this.varInfo).sort((a, b) => a.localeCompare(b));
  }

  /** name → hover-tooltip text (value for vars; masked for secrets — never the plaintext). */
  get varTitles(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, info] of Object.entries(this.varInfo))
      out[k] = info.secret ? "🔒 secret" : info.value || "(empty)";
    return out;
  }

  async init(): Promise<void> {
    if (!isTauri) {
      this.bridgeMissing = true;
      this.ready = true;
      return;
    }
    this.project = await projectInfo().catch(() => null);
    // Launched via `rr <dir>` → straight into the project; otherwise show the selector.
    if (this.project?.arg_launched) {
      await this.loadStore();
      this.screen = "app";
    } else {
      this.screen = "selector";
    }
    this.ready = true;
  }

  /** Open a project dir (or global with `null`): switch reddb, reset, load, enter app. */
  async chooseProject(dir: string | null): Promise<void> {
    this.activeColId = null;
    this.activeReq = null;
    this.activeEnvName = null;
    this.collections = [];
    this.response = null;
    this.runResult = null;
    this.view = "requests";
    this.project = await openProject(dir).catch((e) => {
      this.loadError = e instanceof Error ? e.message : String(e);
      return this.project;
    });
    await this.loadStore();
    this.screen = "app";
  }

  /** Return to the project selector. */
  backToSelector(): void {
    this.screen = "selector";
  }

  /** (Re)load the store; sets loadError on failure. Used by init and Retry. */
  async loadStore(): Promise<void> {
    this.loadError = null;
    try {
      await repo.ensureStore();
      await repo.ensureSample();
      await this.reload();
      // Persist this project's request count for the selector cards.
      if (this.project?.is_project && this.project.project_dir) {
        const total = this.collections.reduce(
          (s, c) => s + c.requests.length,
          0
        );
        void recentSetCount(this.project.project_dir, total);
      }
    } catch (e) {
      this.loadError = e instanceof Error ? e.message : String(e);
    }
  }

  async retry(): Promise<void> {
    this.project = await projectInfo().catch(() => this.project);
    await this.loadStore();
  }

  async reload(): Promise<void> {
    this.collections = await repo.loadAll();
    const first = this.collections[0];
    if (first && !this.activeColId) {
      this.activeColId = first.id;
      this.activeEnvName = first.environments[0]?.name ?? null;
      if (first.requests[0]) this.selectRequest(first.id, first.requests[0].id);
    }
  }

  selectRequest(colId: string, reqId: string): void {
    const col = this.collections.find((c) => c.id === colId);
    const req = col?.requests.find((r) => r.id === reqId);
    if (!col || !req) return;
    this.activeColId = colId;
    this.activeReq = structuredClone($state.snapshot(req)) as RequestDefinition;
    this.activeEnvName =
      this.activeEnvName ?? col.environments[0]?.name ?? null;
    this.response = null;
    this.errorMsg = null;
    this.unresolved = [];
    void this.refreshReqHistory();
  }

  private async buildVariables(): Promise<Record<string, string>> {
    const col = this.activeCollection;
    if (!col) return {};
    const env = col.environments.find((e) => e.name === this.activeEnvName);
    const openedSecrets: Record<string, string> = {};
    if (env) {
      for (const [name, sealed] of Object.entries(env.secrets)) {
        try {
          openedSecrets[name] = await secrets.open(sealed);
        } catch {
          /* leave unresolved if it can't be opened */
        }
      }
    }
    // Precedence (earlier wins): secret > environment > collection.
    return mergeScopes([openedSecrets, env?.vars ?? {}, col.collection.vars]);
  }

  async send(): Promise<void> {
    if (!this.activeReq || this.sending) return;
    this.sending = true;
    this.errorMsg = null;
    this.tests = [];
    this.logs = [];
    this.scriptError = null;
    try {
      const variables = await this.buildVariables();
      const result = await httpSend({
        request: $state.snapshot(this.activeReq) as RequestDefinition,
        variables,
      });
      this.response = result.response;
      this.unresolved = result.unresolved;
      this.effectiveUrl = result.effectiveUrl;
      const sr = result.scriptResult;
      if (sr) {
        this.tests = sr.tests;
        this.logs = sr.logs;
        this.scriptError = sr.error ?? null;
        await this.applyVarChanges(sr.varChanges);
      }
      await this.recordEntry(
        this.activeReq.id,
        this.activeReq.name,
        this.activeReq.method,
        result.effectiveUrl,
        result.response,
        sr?.tests ?? []
      );
    } catch (e) {
      this.errorMsg = e instanceof Error ? e.message : String(e);
    } finally {
      this.sending = false;
      void this.refreshReqHistory();
    }
  }

  /** Record one run in history (best-effort; never breaks the send). */
  private async recordEntry(
    reqId: string,
    name: string,
    method: string,
    url: string,
    response: ResponseResult,
    tests: ScriptTest[]
  ): Promise<void> {
    if (!this.activeColId) return;
    const ts = Date.now();
    const entry: HistoryEntry = {
      id: `${reqId}__${ts}`,
      reqId,
      collectionId: this.activeColId,
      name,
      method,
      url,
      ts,
      status: response.status,
      ok: response.ok,
      durationMs: response.durationMs,
      size: response.size,
      timings: response.timings,
      testsPassed: tests.filter((t) => t.passed).length,
      testsFailed: tests.filter((t) => !t.passed).length,
      env: this.activeEnvName ?? undefined,
    };
    try {
      await repo.saveHistory(entry);
    } catch {
      /* history is best-effort */
    }
  }

  /**
   * Run a loop (repeat / data-driven / flow). The UI supplies only the mode-specific
   * bits; we attach the active request/collection + resolved variables. Each iteration
   * is recorded in history.
   */
  async runLoop(opts: {
    mode: "repeat" | "data" | "flow";
    count?: number;
    dataset?: Record<string, string>[];
  }): Promise<void> {
    if (this.running) return;
    const col = this.activeCollection;
    if (!col || (opts.mode !== "flow" && !this.activeReq)) return;
    this.running = true;
    this.runResult = null;
    this.runError = null;
    try {
      const variables = await this.buildVariables();
      const snap = (r: RequestDefinition) =>
        structuredClone($state.snapshot(r)) as RequestDefinition;
      let params: RunnerParams;
      if (opts.mode === "repeat") {
        params = {
          mode: "repeat",
          request: snap(this.activeReq!),
          count: opts.count ?? 1,
          variables,
        };
      } else if (opts.mode === "data") {
        params = {
          mode: "data",
          request: snap(this.activeReq!),
          dataset: opts.dataset ?? [],
          variables,
        };
      } else {
        params = {
          mode: "flow",
          requests: col.requests.map(snap),
          variables,
        };
      }
      const result = await runnerRun(params);
      this.runResult = result;
      for (const it of result.iterations) {
        await this.recordEntry(
          it.reqId,
          it.reqName,
          it.method,
          it.url,
          it.response,
          it.scriptResult?.tests ?? []
        );
      }
    } catch (e) {
      this.runError = e instanceof Error ? e.message : String(e);
    } finally {
      this.running = false;
      void this.refreshReqHistory();
    }
  }

  /** Load history for the active request (newest first). */
  async refreshReqHistory(): Promise<void> {
    const req = this.activeReq;
    if (!req || !this.activeColId) {
      this.reqHistory = [];
      return;
    }
    try {
      const all = await repo.loadHistory(this.activeColId);
      this.reqHistory = all.filter((h) => h.reqId === req.id);
    } catch {
      /* best-effort */
    }
  }

  /** Persist variables a post-response script set into the active environment. */
  private async applyVarChanges(
    changes: Record<string, string>
  ): Promise<void> {
    const entries = Object.entries(changes);
    if (entries.length === 0) return;
    const env = this.activeEnv;
    if (!env) return;
    for (const [k, v] of entries) env.vars[k] = v;
    await this.persistEnv(env);
  }

  async save(): Promise<void> {
    if (!this.activeReq || !this.activeColId) return;
    const snap = structuredClone(
      $state.snapshot(this.activeReq)
    ) as RequestDefinition;
    await repo.saveRequest(this.activeColId, snap);
    const col = this.activeCollection;
    if (col) {
      const idx = col.requests.findIndex((r) => r.id === snap.id);
      if (idx >= 0) col.requests[idx] = snap;
      else col.requests.push(snap);
    }
  }

  // --- collection structure (requests + folders) --------------------------

  private async persistCollection(): Promise<void> {
    const col = this.activeCollection;
    if (!col || !this.activeColId) return;
    await repo.saveCollectionMeta(
      this.activeColId,
      $state.snapshot(col.collection) as typeof col.collection
    );
  }

  /** Rename a collection and persist. */
  async renameCollection(colId: string, name: string): Promise<void> {
    const col = this.collections.find((c) => c.id === colId);
    if (!col || !name.trim()) return;
    col.collection.name = name.trim();
    await repo.saveCollectionMeta(
      colId,
      $state.snapshot(col.collection) as typeof col.collection
    );
  }

  /** Delete a collection (and everything it owns); select another if it was active. */
  async deleteCollection(colId: string): Promise<void> {
    await repo.deleteCollection(colId);
    this.collections = this.collections.filter((c) => c.id !== colId);
    if (this.activeColId === colId) {
      this.activeReq = null;
      this.activeColId = this.collections[0]?.id ?? null;
      const first = this.collections[0];
      if (first?.requests[0])
        this.selectRequest(first.id, first.requests[0].id);
    }
  }

  /** Create a new request (optionally inside a folder) and select it. */
  async addRequest(folder = ""): Promise<void> {
    const col = this.activeCollection;
    if (!col || !this.activeColId) return;
    const id = `req-${Date.now().toString(36)}-${Math.floor(
      Math.random() * 1296
    ).toString(36)}`;
    const req: RequestDefinition = {
      ...newRequest(id),
      name: "New Request",
      folder,
      url: "https://",
    };
    await repo.saveRequest(this.activeColId, req);
    col.requests.push(req);
    col.collection.order.push(id);
    this.selectRequest(this.activeColId, id);
  }

  /** Import a curl command as a new request and select it. */
  async importCurl(text: string): Promise<void> {
    const col = this.activeCollection;
    if (!col || !this.activeColId || !text.trim()) return;
    const id = `req-${Date.now().toString(36)}-${Math.floor(
      Math.random() * 1296
    ).toString(36)}`;
    const req = curlToRequest(text, id);
    await repo.saveRequest(this.activeColId, req);
    col.requests.push(req);
    col.collection.order.push(id);
    this.selectRequest(this.activeColId, id);
  }

  /** Duplicate a request (same folder) and select the copy. */
  async duplicateRequest(reqId: string): Promise<void> {
    const col = this.activeCollection;
    if (!col || !this.activeColId) return;
    const src = col.requests.find((r) => r.id === reqId);
    if (!src) return;
    const id = `req-${Date.now().toString(36)}-${Math.floor(
      Math.random() * 1296
    ).toString(36)}`;
    const copy = {
      ...(structuredClone($state.snapshot(src)) as RequestDefinition),
      id,
      name: `${src.name} (copy)`,
    };
    await repo.saveRequest(this.activeColId, copy);
    col.requests.push(copy);
    col.collection.order.push(id);
    this.selectRequest(this.activeColId, id);
  }

  async addFolder(name: string): Promise<void> {
    const col = this.activeCollection;
    if (!col || !name.trim()) return;
    if (col.collection.folders.includes(name)) return;
    col.collection.folders.push(name);
    await this.persistCollection();
  }

  /** Delete a folder; its requests move back to the collection root. */
  async deleteFolder(name: string): Promise<void> {
    const col = this.activeCollection;
    if (!col || !this.activeColId) return;
    col.collection.folders = col.collection.folders.filter((f) => f !== name);
    for (const r of col.requests) {
      if (r.folder === name) {
        r.folder = "";
        await repo.saveRequest(
          this.activeColId,
          $state.snapshot(r) as RequestDefinition
        );
      }
    }
    await this.persistCollection();
  }

  /** Move a request to a folder ("" = root) and persist. */
  async moveRequest(reqId: string, folder: string): Promise<void> {
    const col = this.activeCollection;
    if (!col || !this.activeColId) return;
    const req = col.requests.find((r) => r.id === reqId);
    if (!req) return;
    req.folder = folder;
    if (this.activeReq?.id === reqId) this.activeReq.folder = folder;
    await repo.saveRequest(
      this.activeColId,
      $state.snapshot(req) as RequestDefinition
    );
  }

  /** Rename a request and persist. */
  async renameRequest(reqId: string, name: string): Promise<void> {
    const col = this.activeCollection;
    if (!col || !this.activeColId || !name.trim()) return;
    const req = col.requests.find((r) => r.id === reqId);
    if (!req) return;
    req.name = name.trim();
    if (this.activeReq?.id === reqId) this.activeReq.name = name.trim();
    await repo.saveRequest(
      this.activeColId,
      $state.snapshot(req) as RequestDefinition
    );
  }

  async deleteRequest(reqId: string): Promise<void> {
    const col = this.activeCollection;
    if (!col || !this.activeColId) return;
    await repo.deleteRequest(this.activeColId, reqId);
    col.requests = col.requests.filter((r) => r.id !== reqId);
    col.collection.order = col.collection.order.filter((id) => id !== reqId);
    await this.persistCollection();
    if (this.activeReq?.id === reqId) {
      this.activeReq = null;
      const first = col.requests[0];
      if (first) this.selectRequest(this.activeColId, first.id);
    }
  }

  // --- environment management ---------------------------------------------

  private async persistEnv(env: StoredEnvironment): Promise<void> {
    if (!this.activeColId) return;
    await repo.saveEnvironment(
      this.activeColId,
      $state.snapshot(env) as StoredEnvironment
    );
  }

  async createEnv(name: string): Promise<void> {
    const col = this.activeCollection;
    if (!col || !name.trim()) return;
    if (col.environments.some((e) => e.name === name)) return;
    const env = storedEnvironmentSchema.parse({ name, vars: {}, secrets: {} });
    col.environments.push(env);
    await this.persistEnv(env);
    this.activeEnvName = name;
  }

  async duplicateEnv(source: StoredEnvironment): Promise<void> {
    const col = this.activeCollection;
    if (!col) return;
    let name = `${source.name}-copy`;
    let i = 2;
    while (col.environments.some((e) => e.name === name))
      name = `${source.name}-copy-${i++}`;
    const env = structuredClone(
      $state.snapshot({ ...source, name })
    ) as StoredEnvironment;
    col.environments.push(env);
    await this.persistEnv(env);
    this.activeEnvName = name;
  }

  async renameEnv(env: StoredEnvironment, newName: string): Promise<void> {
    const col = this.activeCollection;
    if (!col || !newName.trim() || newName === env.name) return;
    const oldName = env.name;
    await repo.deleteEnvironment(col.id, oldName);
    env.name = newName;
    await this.persistEnv(env);
    if (this.activeEnvName === oldName) this.activeEnvName = newName;
  }

  async deleteEnv(env: StoredEnvironment): Promise<void> {
    const col = this.activeCollection;
    if (!col) return;
    await repo.deleteEnvironment(col.id, env.name);
    col.environments = col.environments.filter((e) => e !== env);
    if (this.activeEnvName === env.name)
      this.activeEnvName = col.environments[0]?.name ?? null;
  }

  /** Persist edits to an environment's plain vars. */
  async saveEnvVars(env: StoredEnvironment): Promise<void> {
    await this.persistEnv(env);
  }

  async setSecret(
    env: StoredEnvironment,
    name: string,
    value: string
  ): Promise<void> {
    if (!name.trim()) return;
    env.secrets[name] = await secrets.seal(value);
    await this.persistEnv(env);
  }

  async removeSecret(env: StoredEnvironment, name: string): Promise<void> {
    delete env.secrets[name];
    await this.persistEnv(env);
  }
}

export const ws = new Workspace();
