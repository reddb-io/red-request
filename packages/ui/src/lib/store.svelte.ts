import {
  mergeScopes,
  storedEnvironmentSchema,
  newRequest,
  curlToRequest,
  openapiToCollection,
  harToCollection,
  postmanToCollection,
  collectionFileSchema,
  proxyToUrl,
  DYNAMIC_VARS,
  type BodyType,
  type ImportedCollection,
  type LoadedCollection,
  type RequestDefinition,
  type ResponseResult,
  type SavedExample,
  type GrpcService,
  type Proxy,
  type Profile,
  type NetworkSettings,
  type StoredEnvironment,
  type ScriptTest,
  type HistoryEntry,
  type RunnerParams,
  type RunnerResult,
} from "@red-request/core";
import { parse as parseYaml } from "yaml";
import { INTROSPECTION_QUERY, parseSchema, type GqlSchema } from "./graphql";
import * as repo from "./repo";
import * as secrets from "./secrets";
import {
  httpSend,
  runnerRun,
  onEngineStream,
  wsOpen,
  wsSend as rpcWsSend,
  wsClose,
  sseOpen,
  sseClose,
  cookiesClear,
  grpcMethods as rpcGrpcMethods,
  grpcCall as rpcGrpcCall,
} from "./rpc";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "./tauri";
import {
  projectInfo,
  openProject,
  recentSetCount,
  recentRename,
  recentRemove,
  deleteProjectData,
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
  /** When set, the response panel shows this saved example instead of the live response. */
  exampleView = $state<ResponseResult | null>(null);
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

  // --- websocket (kind === "ws") — live connection state for the active request ---
  wsStatus = $state<"idle" | "connecting" | "open" | "closed" | "error">(
    "idle"
  );
  wsMessages = $state<
    { dir: "in" | "out" | "sys"; data: string; ts: number }[]
  >([]);
  private wsConnId: string | null = null;
  private wsUnlisten: UnlistenFn | null = null;

  // --- grpc (kind === "grpc") ---
  grpcServices = $state<GrpcService[]>([]);
  grpcLoading = $state(false);

  // --- project-level network pool (proxies + profiles) ---
  network = $state<NetworkSettings>({ proxies: [], profiles: [] });

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

  /** Variable names resolvable in the current scope, plus the dynamic {{$…}} generators. */
  get knownVars(): string[] {
    return [...Object.keys(this.varInfo), ...Object.keys(DYNAMIC_VARS)].sort(
      (a, b) => a.localeCompare(b)
    );
  }

  /** name → hover-tooltip text (value for vars; masked for secrets — never the plaintext). */
  get varTitles(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, info] of Object.entries(this.varInfo))
      out[k] = info.secret ? "🔒 secret" : info.value || "(empty)";
    for (const [k, info] of Object.entries(DYNAMIC_VARS))
      out[k] = `⚡ ${info.desc}`;
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

  /** Rename the current project (display alias in recents — does not touch the folder). */
  async renameProject(name: string): Promise<void> {
    const dir = this.project?.project_dir;
    if (!dir || !name.trim()) return;
    await recentRename(dir, name.trim()).catch(() => {});
    this.project = await projectInfo().catch(() => this.project);
  }

  /** Forget the current project (remove from recents) and return to the selector. No files touched. */
  async forgetProject(): Promise<void> {
    const dir = this.project?.project_dir;
    if (dir) await recentRemove(dir).catch(() => {});
    this.backToSelector();
  }

  /** Permanently delete the current project's data (.red/request) and return to the selector. */
  async deleteProjectData(): Promise<void> {
    const dir = this.project?.project_dir;
    if (!dir) return;
    // Switch reddb off this dir first so the sidecar releases app.rdb before we delete it.
    await openProject(null).catch(() => {});
    await deleteProjectData(dir).catch((e) => {
      this.loadError = e instanceof Error ? e.message : String(e);
    });
    this.backToSelector();
  }

  /** (Re)load the store; sets loadError on failure. Used by init and Retry. */
  async loadStore(): Promise<void> {
    this.loadError = null;
    try {
      await repo.ensureStore();
      await repo.ensureSample();
      this.network = await repo.loadNetwork();
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
    this.exampleView = null;
    this.errorMsg = null;
    this.unresolved = [];
    // reset the stream panel; close any connection from the previously selected request
    if (this.wsConnId && this.wsConnId !== reqId) {
      const id = this.wsConnId;
      void wsClose({ id }).catch(() => {});
      void sseClose({ id }).catch(() => {});
    }
    this.wsConnId = null;
    this.wsStatus = "idle";
    this.wsMessages = [];
    this.grpcServices = [];
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
    this.exampleView = null;
    this.errorMsg = null;
    this.tests = [];
    this.logs = [];
    this.scriptError = null;
    try {
      const variables = await this.buildVariables();
      const result = await httpSend({
        request: this.applyProfile(
          structuredClone($state.snapshot(this.activeReq)) as RequestDefinition
        ),
        variables,
        cookieJarKey:
          this.activeCollection?.collection.cookieJar && this.activeColId
            ? this.activeColId
            : undefined,
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

  /** Set a variable (active env if any, else the collection) and persist it. Powers the
   *  response → variable extraction (chain requests without writing a script). */
  async setVariable(name: string, value: string): Promise<void> {
    if (!name.trim()) return;
    const env = this.activeEnv;
    if (env) {
      env.vars[name] = value;
      await this.persistEnv(env);
      return;
    }
    const col = this.activeCollection;
    if (col) {
      col.collection.vars[name] = value;
      await this.persistCollection();
    }
  }

  // --- proxies & profiles (project-level pool, shared by all collections) ----
  get proxies(): Proxy[] {
    return this.network.proxies;
  }
  get profiles(): Profile[] {
    return this.network.profiles;
  }

  /** Merge the bound profile (request's, else the collection default) into a snapshot:
   *  User-Agent + headers + proxy. Explicit request headers/proxy win. */
  private applyProfile(snap: RequestDefinition): RequestDefinition {
    const pid =
      snap.profileId ||
      this.activeCollection?.collection.defaultProfileId ||
      "";
    const profile = pid
      ? this.network.profiles.find((p) => p.id === pid)
      : undefined;
    if (!profile) return snap;
    const has = (n: string) =>
      snap.headers.some((h) => h.name.toLowerCase() === n.toLowerCase());
    if (profile.userAgent && !has("user-agent"))
      snap.headers = [
        ...snap.headers,
        { name: "User-Agent", value: profile.userAgent, enabled: true },
      ];
    for (const h of profile.headers)
      if (h.enabled && h.name.trim() && !has(h.name))
        snap.headers = [
          ...snap.headers,
          { name: h.name, value: h.value, enabled: true },
        ];
    const proxy = profile.proxyId
      ? this.network.proxies.find((p) => p.id === profile.proxyId)
      : undefined;
    if (proxy?.host.trim() && !snap.proxy?.trim())
      snap.proxy = proxyToUrl(proxy);
    return snap;
  }

  private rid(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1296).toString(36)}`;
  }
  /** Set the collection's default profile (applied to requests that don't pick one). */
  async setCollectionDefaultProfile(id: string): Promise<void> {
    const col = this.activeCollection;
    if (!col) return;
    col.collection.defaultProfileId = id;
    await this.persistCollection();
  }
  async addProxy(): Promise<void> {
    this.network.proxies.push({
      id: this.rid("px"),
      name: "New proxy",
      type: "http",
      host: "",
      port: "8080",
      username: "",
      password: "",
    });
    await this.saveProxiesProfiles();
  }
  async removeProxy(id: string): Promise<void> {
    this.network.proxies = this.network.proxies.filter((p) => p.id !== id);
    for (const pr of this.network.profiles)
      if (pr.proxyId === id) pr.proxyId = "";
    await this.saveProxiesProfiles();
  }
  async addProfile(): Promise<void> {
    this.network.profiles.push({
      id: this.rid("pf"),
      name: "New profile",
      userAgent: "",
      headers: [],
      proxyId: "",
    });
    await this.saveProxiesProfiles();
  }
  async removeProfile(id: string): Promise<void> {
    this.network.profiles = this.network.profiles.filter((p) => p.id !== id);
    await this.saveProxiesProfiles();
  }
  /** Persist the project-level proxy/profile pool (called on blur from the manager UI). */
  async saveProxiesProfiles(): Promise<void> {
    await repo.saveNetwork($state.snapshot(this.network) as NetworkSettings);
  }

  // --- grpc -----------------------------------------------------------------
  /** Parse the active request's .proto and list its services/methods. */
  async grpcLoadMethods(): Promise<void> {
    const req = this.activeReq;
    if (!req || !req.grpc.proto.trim()) return;
    this.grpcLoading = true;
    this.errorMsg = null;
    try {
      const r = await rpcGrpcMethods({ proto: req.grpc.proto });
      this.grpcServices = r.services;
      if (r.error) this.errorMsg = r.error;
      // default the selection to the first service/method
      if (!req.grpc.service && r.services[0]) {
        req.grpc.service = r.services[0].name;
        req.grpc.method = r.services[0].methods[0]?.name ?? "";
      }
    } catch (e) {
      this.errorMsg = e instanceof Error ? e.message : String(e);
    } finally {
      this.grpcLoading = false;
    }
  }

  /** Invoke the active gRPC request (unary) and show the result in the response panel. */
  async grpcInvoke(): Promise<void> {
    const req = this.activeReq;
    if (!req || this.sending) return;
    this.sending = true;
    this.exampleView = null;
    this.errorMsg = null;
    this.response = null;
    try {
      const variables = await this.buildVariables();
      const result = await rpcGrpcCall({
        request: $state.snapshot(req) as RequestDefinition,
        variables,
      });
      this.response = result.response;
      this.effectiveUrl = result.effectiveUrl;
      await this.recordEntry(
        req.id,
        req.name,
        "GRPC",
        result.effectiveUrl,
        result.response,
        []
      );
    } catch (e) {
      this.errorMsg = e instanceof Error ? e.message : String(e);
    } finally {
      this.sending = false;
      void this.refreshReqHistory();
    }
  }

  // --- saved examples -------------------------------------------------------
  /** Snapshot the current live response as a named example on the active request. */
  async saveExample(name: string): Promise<void> {
    const req = this.activeReq;
    const res = this.response;
    if (!req || !res) return;
    const ex: SavedExample = {
      id: `ex-${Date.now().toString(36)}`,
      name: name.trim() || `${res.status} · ${new Date().toLocaleString()}`,
      status: res.status,
      statusText: res.statusText,
      contentType: res.contentType,
      bodyText: res.bodyText,
      savedAt: Date.now(),
    };
    req.examples = [...(req.examples ?? []), ex];
    await this.save();
  }

  /** Show a saved example in the response panel (or clear with null). */
  viewExample(ex: SavedExample | null): void {
    this.exampleView = ex
      ? {
          status: ex.status,
          statusText: ex.statusText,
          ok: ex.status > 0 && ex.status < 400,
          url: "",
          headers: {},
          bodyText: ex.bodyText,
          contentType: ex.contentType,
          size: ex.bodyText.length,
          durationMs: 0,
        }
      : null;
  }

  async deleteExample(id: string): Promise<void> {
    const req = this.activeReq;
    if (!req) return;
    req.examples = (req.examples ?? []).filter((e) => e.id !== id);
    this.exampleView = null;
    await this.save();
  }

  // --- websocket ------------------------------------------------------------
  private async ensureWsListener(): Promise<void> {
    if (this.wsUnlisten) return;
    this.wsUnlisten = await onEngineStream((n) =>
      this.onWsEvent(n as { stream: string; event: string; data?: unknown })
    );
  }

  private pushWs(dir: "in" | "out" | "sys", data: string): void {
    this.wsMessages = [
      ...this.wsMessages.slice(-499),
      { dir, data, ts: Date.now() },
    ];
  }

  private onWsEvent(n: {
    stream: string;
    event: string;
    data?: unknown;
  }): void {
    if (n.stream !== this.wsConnId) return;
    const d = (n.data ?? {}) as Record<string, any>;
    switch (n.event) {
      case "open":
        this.wsStatus = "open";
        this.pushWs("sys", `● connected ${d.url ?? ""}`.trim());
        break;
      case "message":
        this.pushWs(d.dir === "out" ? "out" : "in", String(d.data ?? ""));
        break;
      case "close":
        this.wsStatus = "closed";
        this.pushWs("sys", `● closed ${d.code ?? ""} ${d.reason ?? ""}`.trim());
        break;
      case "error":
        this.wsStatus = "error";
        this.pushWs("sys", `● ${d.message ?? "error"}`);
        break;
    }
  }

  /** Open a stream (WebSocket or SSE) for the active request; frames land in wsMessages. */
  async streamConnect(): Promise<void> {
    const req = this.activeReq;
    if (!req || (req.kind !== "ws" && req.kind !== "sse")) return;
    await this.ensureWsListener();
    this.wsMessages = [];
    this.wsStatus = "connecting";
    this.wsConnId = req.id;
    const variables = await this.buildVariables();
    const params = {
      id: req.id,
      request: $state.snapshot(req) as RequestDefinition,
      variables,
    };
    try {
      await (req.kind === "sse" ? sseOpen(params) : wsOpen(params));
    } catch (e) {
      this.wsStatus = "error";
      this.pushWs("sys", `● ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Send a frame (WebSocket only — SSE is server→client). */
  async wsSendMessage(data: string): Promise<void> {
    if (!data || !this.wsConnId || this.wsStatus !== "open") return;
    const r = await rpcWsSend({ id: this.wsConnId, data });
    if (!r.ok && r.error) this.pushWs("sys", `● ${r.error}`);
  }

  async streamDisconnect(): Promise<void> {
    const id = this.wsConnId;
    if (id)
      await (
        this.activeReq?.kind === "sse" ? sseClose({ id }) : wsClose({ id })
      ).catch(() => {});
    this.wsStatus = "closed";
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

  /** Media type sent for each body kind (Content-Type). */
  private static readonly CONTENT_TYPES: Partial<Record<BodyType, string>> = {
    json: "application/json",
    xml: "application/xml",
    graphql: "application/json",
    raw: "text/plain",
    form: "application/x-www-form-urlencoded",
    multipart: "multipart/form-data",
  };

  /** Upsert a header by case-insensitive name (re-enables it if it was disabled). */
  private upsertHeader(
    req: RequestDefinition,
    name: string,
    value: string
  ): void {
    const h = req.headers.find(
      (x) => x.name.toLowerCase() === name.toLowerCase()
    );
    if (h) {
      h.value = value;
      h.enabled = true;
    } else {
      req.headers.push({ name, value, enabled: true });
    }
  }

  /**
   * Set the request body type and keep the headers in sync: Content-Type for what we send,
   * plus a matching Accept for what we expect back (json↔json, xml↔xml).
   */
  setBodyType(type: BodyType): void {
    const req = this.activeReq;
    if (!req) return;
    req.body.type = type;
    if (type === "graphql") {
      // GraphQL is always POSTed; give the variables editor something to bind to.
      if (req.method === "GET") req.method = "POST";
      req.body.variables ??= "{}";
    }
    if (type === "none") return;
    const ct = Workspace.CONTENT_TYPES[type];
    if (ct) this.upsertHeader(req, "Content-Type", ct);
    this.upsertHeader(
      req,
      "Accept",
      type === "xml" ? "application/xml" : "application/json"
    );
  }

  /** Run GraphQL introspection against the active request's endpoint and parse the schema. */
  async introspectGraphQL(): Promise<GqlSchema> {
    const req = this.activeReq;
    if (!req) throw new Error("no active request");
    const variables = await this.buildVariables();
    const probe = structuredClone($state.snapshot(req)) as RequestDefinition;
    probe.kind = "http";
    probe.method = "POST";
    probe.body = {
      type: "graphql",
      content: INTROSPECTION_QUERY,
      variables: "{}",
      fields: [],
    };
    probe.scripts = { preRequest: "", postResponse: "" };
    const res = await httpSend({ request: probe, variables });
    if (res.response.error) throw new Error(res.response.error.message);
    let json: { data?: { __schema?: unknown }; errors?: { message: string }[] };
    try {
      json = JSON.parse(res.response.bodyText || "{}");
    } catch {
      throw new Error(
        `endpoint did not return JSON (status ${res.response.status})`
      );
    }
    if (json.errors?.length) throw new Error(json.errors[0]!.message);
    if (!json.data?.__schema)
      throw new Error("no __schema in the response (introspection disabled?)");
    return parseSchema(json.data.__schema);
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

  /** Toggle the per-collection cookie jar (persist Set-Cookie across its requests). */
  async toggleCookieJar(colId: string): Promise<void> {
    const col = this.collections.find((c) => c.id === colId);
    if (!col) return;
    col.collection.cookieJar = !col.collection.cookieJar;
    await repo.saveCollectionMeta(
      colId,
      $state.snapshot(col.collection) as typeof col.collection
    );
    if (!col.collection.cookieJar)
      await cookiesClear({ key: colId }).catch(() => {});
  }

  /** Clear the cookies stored for a collection's jar. */
  async clearCookies(colId: string): Promise<void> {
    await cookiesClear({ key: colId }).catch(() => {});
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

  /**
   * Smart paste import: a structured doc becomes a whole new collection — OpenAPI/Swagger
   * (`paths`), a HAR file (`log.entries`), or a Postman v2.1 collection (`info`+`item`).
   * Anything else is treated as a cURL command added to the active collection. Returns what
   * it did (or throws on a malformed doc).
   */
  async importText(text: string): Promise<"collection" | "request"> {
    const trimmed = text.trim();
    let spec: unknown = null;
    try {
      spec = JSON.parse(trimmed);
    } catch {
      try {
        spec = parseYaml(trimmed);
      } catch {
        /* not structured — fall through to cURL */
      }
    }
    const s = spec as Record<string, any> | null;
    if (s && typeof s === "object") {
      if (s.paths) {
        await this.importCollection(openapiToCollection(s));
        return "collection";
      }
      if (s.log?.entries) {
        await this.importCollection(harToCollection(s));
        return "collection";
      }
      if (s.info && Array.isArray(s.item)) {
        await this.importCollection(postmanToCollection(s));
        return "collection";
      }
    }
    await this.importCurl(trimmed);
    return "request";
  }

  /** Build a fresh collection from a parsed OpenAPI/Swagger document and open it. */
  async importOpenAPI(spec: unknown): Promise<void> {
    await this.importCollection(openapiToCollection(spec));
  }

  /** Persist an imported collection (meta + requests), reload, and open it. */
  private async importCollection(imported: ImportedCollection): Promise<void> {
    const colId = `imp-${Date.now().toString(36)}`;
    await repo.saveCollectionMeta(
      colId,
      collectionFileSchema.parse({
        name: imported.name,
        baseUrl: imported.baseUrl || undefined,
        vars: imported.vars,
        folders: imported.folders,
        order: imported.requests.map((r) => r.id),
      })
    );
    for (const r of imported.requests) await repo.saveRequest(colId, r);
    await this.reload();
    this.activeColId = colId;
    const first = imported.requests[0];
    if (first) this.selectRequest(colId, first.id);
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
