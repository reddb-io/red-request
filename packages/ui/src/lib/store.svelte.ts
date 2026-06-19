import {
  mergeScopes,
  storedEnvironmentSchema,
  type LoadedCollection,
  type RequestDefinition,
  type ResponseResult,
  type StoredEnvironment,
  type ScriptTest,
  type HistoryEntry,
} from "@red-requester/core";
import * as repo from "./repo";
import * as secrets from "./secrets";
import { httpSend } from "./rpc";
import { isTauri } from "./tauri";
import { projectInfo, type ProjectInfo } from "./project";

class Workspace {
  ready = $state(false);
  bridgeMissing = $state(false);
  loadError = $state<string | null>(null);
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

  get activeCollection(): LoadedCollection | null {
    return this.collections.find((c) => c.id === this.activeColId) ?? null;
  }

  get environments(): StoredEnvironment[] {
    return this.activeCollection?.environments ?? [];
  }

  get activeEnv(): StoredEnvironment | null {
    return this.environments.find((e) => e.name === this.activeEnvName) ?? null;
  }

  async init(): Promise<void> {
    if (!isTauri) {
      this.bridgeMissing = true;
      this.ready = true;
      return;
    }
    this.project = await projectInfo().catch(() => null);
    await this.loadStore();
    this.ready = true;
  }

  /** (Re)load the store; sets loadError on failure. Used by init and Retry. */
  async loadStore(): Promise<void> {
    this.loadError = null;
    try {
      await repo.ensureStore();
      await repo.ensureSample();
      await this.reload();
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
      await this.recordRun(
        this.activeReq,
        result.response,
        result.effectiveUrl,
        sr?.tests ?? []
      );
    } catch (e) {
      this.errorMsg = e instanceof Error ? e.message : String(e);
    } finally {
      this.sending = false;
    }
  }

  /** Record one run in history (best-effort; never breaks the send). */
  private async recordRun(
    req: RequestDefinition,
    response: ResponseResult,
    effectiveUrl: string,
    tests: ScriptTest[]
  ): Promise<void> {
    if (!this.activeColId) return;
    const ts = Date.now();
    const entry: HistoryEntry = {
      id: `${req.id}__${ts}`,
      reqId: req.id,
      collectionId: this.activeColId,
      name: req.name,
      method: req.method,
      url: effectiveUrl || req.url,
      ts,
      status: response.status,
      ok: response.ok,
      durationMs: response.durationMs,
      size: response.size,
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
