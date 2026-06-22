import {
  mergeScopes,
  storedEnvironmentSchema,
  newRequest,
  curlToRequest,
  openapiToCollection,
  harToCollection,
  postmanToCollection,
  insomniaToCollection,
  collectionsToPostman,
  collectionsToInsomnia,
  collectionFileSchema,
  proxyToUrl,
  resolveTemplate,
  DYNAMIC_VARS,
  type AuthConfig,
  type Oauth2TokenResult,
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
  proxyProbe,
  oauth2Token,
  oidcDiscover,
  oauthAuthorize,
} from "./rpc";
import type { ProxyProbeResult } from "@red-request/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "./tauri";
import {
  projectInfo,
  openProject,
  recentSetCount,
  recentRename,
  recentRemove,
  deleteProjectData,
  projectLabel,
  type ProjectInfo,
} from "./project";
import * as fs from "./fs";
import {
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";

/** Reserved name for the always-on base environment (vars + secrets) that every
 *  named environment layers on top of. Stored alongside the others. */
const GLOBALS_ENV = "Globals";

const emptyGlobals = (): StoredEnvironment =>
  storedEnvironmentSchema.parse({ name: GLOBALS_ENV, vars: {}, secrets: {} });

class Workspace {
  ready = $state(false);
  bridgeMissing = $state(false);
  loadError = $state<string | null>(null);
  screen = $state<"selector" | "app">("selector");
  /** Cartoon "iris wipe" while a project opens: a black circle closes on the
   *  selector, the screen swaps to the app while fully black, then the iris opens
   *  on the workspace. `transitioning` mounts the overlay; `transitionPhase` drives
   *  the circle. Durations live in chooseProject(); the overlay CSS mirrors them. */
  transitioning = $state(false);
  transitionPhase = $state<"idle" | "closing" | "hold" | "opening">("idle");
  project = $state<ProjectInfo | null>(null);
  collections = $state<LoadedCollection[]>([]);

  activeColId = $state<string | null>(null);
  activeReq = $state<RequestDefinition | null>(null);
  activeEnvName = $state<string | null>(null);
  /** Top-level navigation: icon-bar selects one. Home bundles dashboard + proxy/profile
   *  management; Requests is the workspace (collections + active request); Settings holds
   *  project-level config. The Sidebar's old segmented [requests|dashboard] is gone. */
  view = $state<"home" | "requests" | "settings">("requests");

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

  /** OAuth2/OIDC token status by connection id — drives the AuthEditor status pill.
   *  Only metadata (expiry/scope); the token strings stay sealed in the store. */
  oauthTokens = $state<
    Record<string, { expiresAt: number; scope?: string; obtainedAt: number }>
  >({});

  /** Per-proxy probe state for the "Test" button in the Proxies modal.
   *  "idle" while the user hasn't probed yet, "running" while in flight, and the
   *  last result otherwise. The UI renders this as a colored pill on each row. */
  proxyProbeById = $state<
    Record<string, { state: "idle" | "running" } | ProxyProbeResult>
  >({});

  get activeCollection(): LoadedCollection | null {
    return this.collections.find((c) => c.id === this.activeColId) ?? null;
  }

  /** Project-level named environments (var/secret sets), shared by all collections. */
  environments = $state<StoredEnvironment[]>([]);
  /** The always-on "Globals" base environment (vars + secrets). Named environments
   *  layer on top — an environment value overrides the matching global one. */
  globals = $state<StoredEnvironment>(emptyGlobals());

  get activeEnv(): StoredEnvironment | null {
    return this.environments.find((e) => e.name === this.activeEnvName) ?? null;
  }

  /** Variable info in the current scope: name → resolved value + whether it's a secret.
   *  Precedence (later wins): global vars < global secrets < env vars < env secrets. */
  get varInfo(): Record<string, { value: string; secret: boolean }> {
    const out: Record<string, { value: string; secret: boolean }> = {};
    const layer = (env: StoredEnvironment | null) => {
      if (!env) return;
      for (const [k, v] of Object.entries(env.vars))
        out[k] = { value: v, secret: false };
      for (const k of Object.keys(env.secrets))
        out[k] = { value: "", secret: true };
    };
    layer(this.globals);
    layer(this.activeEnv);
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

  /** Open a project dir (or global with `null`): switch reddb, reset, load, enter app.
   *  Wrapped in a cartoon iris wipe — the screen swap happens while fully black so
   *  the selector→workspace cut is never visible. Phase durations below must stay in
   *  sync with ProjectTransition.svelte's CSS transitions. */
  async chooseProject(dir: string | null): Promise<void> {
    // A hair longer than the matching CSS transitions so each extreme is reached.
    const CLOSE_MS = 400; // circle shrinks to black  (CSS: 340ms close)
    const HOLD_MS = 130; // minimum fully-black beat
    const OPEN_MS = 460; // circle opens on the app   (CSS: 420ms open)
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

    this.transitioning = true;
    this.transitionPhase = "closing";
    this.activeColId = null;
    this.activeReq = null;
    this.activeEnvName = null;
    this.collections = [];
    this.response = null;
    this.runResult = null;
    this.view = "requests";

    // Load in parallel with the closing animation, but defer the visible screen
    // swap until we're fully black (avoids a flash inside the shrinking circle).
    const ready = (async () => {
      this.project = await openProject(dir).catch((e) => {
        this.loadError = e instanceof Error ? e.message : String(e);
        return this.project;
      });
      await this.loadStore();
    })();

    try {
      await delay(CLOSE_MS);
      this.transitionPhase = "hold";
      await ready; // black covers the swap below
      this.screen = "app";
      await delay(HOLD_MS);
      this.transitionPhase = "opening";
      await delay(OPEN_MS);
    } finally {
      this.transitioning = false;
      this.transitionPhase = "idle";
    }
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
      // RedDB-native migrations: register + APPLY MIGRATION * (pending → applied in
      // dependency order). No-op when nothing's pending; runs on every project boot.
      await repo.runMigrations();
      await repo.ensureSample();
      this.network = await repo.loadNetwork();
      await this.reload();
      await this.reloadEnvironments();
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

  /** Load project-level environments and split off the reserved "Globals" base env.
   *  Migrates first-run state: seeds Globals from a legacy `rr_settings.globals` doc,
   *  else from the union of every collection's legacy `vars`. */
  async reloadEnvironments(): Promise<void> {
    const all = await repo.loadEnvironments();
    const gi = all.findIndex((e) => e.name === GLOBALS_ENV);
    if (gi >= 0) {
      this.globals = all[gi]!;
      this.environments = all.filter((_, i) => i !== gi);
    } else {
      const legacy = await repo.loadGlobals();
      const seed: Record<string, string> = legacy ? { ...legacy } : {};
      if (!legacy)
        for (const c of this.collections)
          for (const [k, v] of Object.entries(c.collection.vars))
            if (!(k in seed)) seed[k] = v;
      this.globals = storedEnvironmentSchema.parse({
        name: GLOBALS_ENV,
        vars: seed,
        secrets: {},
      });
      await repo.saveEnvironment(
        $state.snapshot(this.globals) as StoredEnvironment
      );
      this.environments = all;
    }
    this.activeEnvName =
      this.activeEnvName ?? this.environments[0]?.name ?? null;
  }

  async reload(): Promise<void> {
    this.collections = await repo.loadAll();
    const first = this.collections[0];
    if (first && !this.activeColId) {
      this.activeColId = first.id;
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
      this.activeEnvName ?? this.environments[0]?.name ?? null;
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
    const open = async (env: StoredEnvironment | null) => {
      const out: Record<string, string> = {};
      if (env) {
        for (const [name, sealed] of Object.entries(env.secrets)) {
          try {
            out[name] = await secrets.open(sealed);
          } catch {
            /* leave unresolved if it can't be opened */
          }
        }
      }
      return out;
    };
    const env = this.activeEnv;
    const [envSecrets, globalSecrets] = await Promise.all([
      open(env),
      open(this.globals),
    ]);
    // Precedence (earlier wins): env secret > env var > global secret > global var.
    return mergeScopes([
      envSecrets,
      env?.vars ?? {},
      globalSecrets,
      this.globals.vars,
    ]);
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
      const request = await this.applyOAuth2(
        this.applyProfile(
          structuredClone($state.snapshot(this.activeReq)) as RequestDefinition
        )
      );
      const result = await httpSend({
        request,
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

  /** Set a variable (active env if any, else the project globals) and persist it. Powers
   *  the response → variable extraction (chain requests without writing a script). */
  async setVariable(name: string, value: string): Promise<void> {
    if (!name.trim()) return;
    const env = this.activeEnv ?? this.globals;
    env.vars[name] = value;
    await this.persistEnv(env);
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
  /** Duplicate a proxy — same fields, fresh id, name suffixed "(copy)". The
   *  original is left intact so the user can compare/edit side-by-side. */
  async duplicateProxy(id: string): Promise<void> {
    const src = this.network.proxies.find((p) => p.id === id);
    if (!src) return;
    this.network.proxies.push({
      ...(structuredClone($state.snapshot(src)) as Proxy),
      id: this.rid("px"),
      name: `${src.name || "proxy"} (copy)`,
    });
    await this.saveProxiesProfiles();
  }
  async removeProxy(id: string): Promise<void> {
    this.network.proxies = this.network.proxies.filter((p) => p.id !== id);
    for (const pr of this.network.profiles)
      if (pr.proxyId === id) pr.proxyId = "";
    delete this.proxyProbeById[id];
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
  /** Duplicate a profile — same UA/headers/proxy, fresh id, name suffixed "(copy)". */
  async duplicateProfile(id: string): Promise<void> {
    const src = this.network.profiles.find((p) => p.id === id);
    if (!src) return;
    const snap = structuredClone($state.snapshot(src)) as Profile;
    this.network.profiles.push({
      ...snap,
      id: this.rid("pf"),
      name: `${src.name || "profile"} (copy)`,
      headers: snap.headers.map((h) => ({ ...h })),
    });
    await this.saveProxiesProfiles();
  }
  async removeProfile(id: string): Promise<void> {
    this.network.profiles = this.network.profiles.filter((p) => p.id !== id);
    // Clear references in active requests / collections that pointed at this profile.
    for (const c of this.collections) {
      if (c.collection.defaultProfileId === id)
        c.collection.defaultProfileId = "";
      for (const r of c.requests) if (r.profileId === id) r.profileId = "";
    }
    await this.persistAllCollectionRefs();
    await this.saveProxiesProfiles();
  }

  /** Persist collection meta for every collection (used after stripping refs to a deleted profile). */
  private async persistAllCollectionRefs(): Promise<void> {
    for (const c of this.collections) {
      try {
        await repo.saveCollectionMeta(
          c.id,
          $state.snapshot(c.collection) as typeof c.collection
        );
      } catch {
        /* best-effort */
      }
    }
  }
  /** Persist the project-level proxy/profile pool (called on blur from the manager UI). */
  async saveProxiesProfiles(): Promise<void> {
    await repo.saveNetwork($state.snapshot(this.network) as NetworkSettings);
  }

  /**
   * Test a proxy's reachability: resolves `{{vars}}` against the current scope,
   * calls `engine.proxy.probe` (TCP / CONNECT / Socks handshake — no request
   * forwarded), and stores the result in `proxyProbeById` for the modal to read.
   * Resolves any in-flight probe for the same proxy before starting a new one.
   */
  async testProxy(proxyId: string): Promise<void> {
    const proxy = this.network.proxies.find((p) => p.id === proxyId);
    if (!proxy) return;
    // Build a proxy URL with `{{vars}}` resolved against the current scope (env + secrets).
    const url = await this.resolveProxyUrl(proxy);
    if (!url.ok) {
      this.proxyProbeById = {
        ...this.proxyProbeById,
        [proxyId]: { ok: false, ms: 0, via: "tcp", error: url.error },
      };
      return;
    }
    this.proxyProbeById = {
      ...this.proxyProbeById,
      [proxyId]: { state: "running" },
    };
    try {
      const result = await proxyProbe({
        proxyUrl: url.value,
        timeoutMs: 8_000,
      });
      this.proxyProbeById = { ...this.proxyProbeById, [proxyId]: result };
    } catch (e) {
      this.proxyProbeById = {
        ...this.proxyProbeById,
        [proxyId]: {
          ok: false,
          ms: 0,
          via: "tcp",
          error: e instanceof Error ? e.message : String(e),
        },
      };
    }
  }

  /** Resolve a proxy's host/port/user/pass `{{vars}}` against env+secrets, build its URL. */
  private async resolveProxyUrl(
    proxy: Proxy
  ): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
    const variables = await this.buildVariables();
    // Resolve each `{{var}}` — if any can't be resolved, surface the name so the user
    // can fix it (a sealed secret can be unresolved if the active env has no value yet).
    const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g;
    const missing: string[] = [];
    const resolve = (s: string): string =>
      s.replace(PLACEHOLDER, (_, name: string) => {
        const v = variables[name];
        if (v == null) {
          if (!missing.includes(name)) missing.push(name);
          return "";
        }
        return v;
      });
    const host = resolve(proxy.host).trim();
    const port = resolve(proxy.port).trim();
    const username = resolve(proxy.username).trim();
    const password = resolve(proxy.password);
    if (missing.length)
      return { ok: false, error: `unresolved: ${missing.join(", ")}` };
    if (!host || !port)
      return { ok: false, error: !host ? "missing host" : "missing port" };
    const auth = username ? `${username}:${password}@` : "";
    return { ok: true, value: `${proxy.type}://${auth}${host}:${port}` };
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

  /** Create a new, empty collection and make it active. Returns its id (so the UI
   *  can drop straight into an inline rename). */
  async addCollection(name = "New Collection"): Promise<string> {
    const colId = this.rid("col");
    await repo.saveCollectionMeta(
      colId,
      collectionFileSchema.parse({ name: name.trim() || "New Collection" })
    );
    await this.reload();
    this.activeColId = colId;
    this.activeReq = null;
    return colId;
  }

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
      if (
        Array.isArray(s.resources) &&
        (s.__export_format || s._type === "export")
      ) {
        await this.importCollection(insomniaToCollection(s));
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

  /** Persist an imported collection (meta + requests), reload, and open it. The
   *  imported variables fold into the project-level globals (vars are project-wide now). */
  private async importCollection(imported: ImportedCollection): Promise<void> {
    const colId = `imp-${Date.now().toString(36)}`;
    await repo.saveCollectionMeta(
      colId,
      collectionFileSchema.parse({
        name: imported.name,
        baseUrl: imported.baseUrl || undefined,
        folders: imported.folders,
        order: imported.requests.map((r) => r.id),
      })
    );
    for (const r of imported.requests) await repo.saveRequest(colId, r);
    if (Object.keys(imported.vars).length) {
      for (const [k, v] of Object.entries(imported.vars))
        this.globals.vars[k] = v;
      await this.persistEnv(this.globals);
    }
    await this.reload();
    this.activeColId = colId;
    const first = imported.requests[0];
    if (first) this.selectRequest(colId, first.id);
  }

  /** Pick a Postman / Insomnia / OpenAPI / HAR file and import it (auto-detected). */
  async importFile(): Promise<"collection" | "request" | null> {
    const picked = await openDialog({
      multiple: false,
      title: "Import a collection",
      filters: [{ name: "Collections", extensions: ["json", "yaml", "yml"] }],
    });
    if (typeof picked !== "string") return null;
    const text = await fs.readText(picked);
    return this.importText(text);
  }

  /** Export all collections as a Postman v2.1 collection (save dialog). Returns the path. */
  async exportPostman(): Promise<string | null> {
    const path = await saveDialog({
      defaultPath: "collections.postman_collection.json",
      filters: [{ name: "Postman collection", extensions: ["json"] }],
    });
    if (!path) return null;
    const data = collectionsToPostman(
      $state.snapshot(this.collections) as LoadedCollection[],
      projectLabel(this.project) || "red-request export"
    );
    await fs.writeText(path, JSON.stringify(data, null, 2));
    return path;
  }

  /** Export all collections as an Insomnia v4 export (save dialog). Returns the path. */
  async exportInsomnia(): Promise<string | null> {
    const path = await saveDialog({
      defaultPath: "insomnia_export.json",
      filters: [{ name: "Insomnia export", extensions: ["json"] }],
    });
    if (!path) return null;
    const data = collectionsToInsomnia(
      $state.snapshot(this.collections) as LoadedCollection[],
      projectLabel(this.project) || "red-request"
    );
    await fs.writeText(path, JSON.stringify(data, null, 2));
    return path;
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

  /** Move a request to a folder ("" = root), appended at the folder's end. */
  async moveRequest(reqId: string, folder: string): Promise<void> {
    await this.reorderRequest(reqId, folder, null);
  }

  /**
   * Reposition a request via drag-and-drop. `folder` is the destination ("" = root)
   * and `beforeId` is the sibling it should land *before* (null → append to the end
   * of that folder). Updates `collection.order` (the single source of sidebar order),
   * re-sorts the in-memory request array so the move shows immediately, and persists
   * both the request (if its folder changed) and the collection meta.
   */
  async reorderRequest(
    dragId: string,
    folder: string,
    beforeId: string | null
  ): Promise<void> {
    const col = this.activeCollection;
    if (!col || !this.activeColId) return;
    if (beforeId === dragId) return; // dropped onto itself → no-op
    const req = col.requests.find((r) => r.id === dragId);
    if (!req) return;

    const folderChanged = (req.folder ?? "") !== folder;
    req.folder = folder;
    if (this.activeReq?.id === dragId) this.activeReq.folder = folder;

    // Reposition dragId in the global order array.
    const order = col.collection.order.filter((id) => id !== dragId);
    if (beforeId) {
      const idx = order.indexOf(beforeId);
      if (idx < 0) order.push(dragId);
      else order.splice(idx, 0, dragId);
    } else {
      // Append after the last id currently living in `folder`.
      let insertAt = order.length;
      for (let i = order.length - 1; i >= 0; i--) {
        const r = col.requests.find((x) => x.id === order[i]);
        if (r && (r.folder ?? "") === folder) {
          insertAt = i + 1;
          break;
        }
      }
      order.splice(insertAt, 0, dragId);
    }
    col.collection.order = order;
    // Re-sort the live array so the sidebar reflects the new order without a reload.
    col.requests = [...col.requests].sort(
      (a, b) => order.indexOf(a.id) - order.indexOf(b.id)
    );

    if (folderChanged) {
      await repo.saveRequest(
        this.activeColId,
        $state.snapshot(req) as RequestDefinition
      );
    }
    await this.persistCollection();
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
    await repo.saveEnvironment($state.snapshot(env) as StoredEnvironment);
  }

  async createEnv(name: string): Promise<void> {
    if (!name.trim() || name === GLOBALS_ENV) return;
    if (this.environments.some((e) => e.name === name)) return;
    const env = storedEnvironmentSchema.parse({ name, vars: {}, secrets: {} });
    this.environments.push(env);
    await this.persistEnv(env);
    this.activeEnvName = name;
  }

  async duplicateEnv(source: StoredEnvironment): Promise<void> {
    let name = `${source.name}-copy`;
    let i = 2;
    while (this.environments.some((e) => e.name === name))
      name = `${source.name}-copy-${i++}`;
    const env = structuredClone(
      $state.snapshot({ ...source, name })
    ) as StoredEnvironment;
    this.environments.push(env);
    await this.persistEnv(env);
    this.activeEnvName = name;
  }

  async renameEnv(env: StoredEnvironment, newName: string): Promise<void> {
    if (!newName.trim() || newName === env.name || newName === GLOBALS_ENV)
      return;
    const oldName = env.name;
    await repo.deleteEnvironment(oldName);
    env.name = newName;
    await this.persistEnv(env);
    if (this.activeEnvName === oldName) this.activeEnvName = newName;
  }

  async deleteEnv(env: StoredEnvironment): Promise<void> {
    await repo.deleteEnvironment(env.name);
    this.environments = this.environments.filter((e) => e !== env);
    if (this.activeEnvName === env.name)
      this.activeEnvName = this.environments[0]?.name ?? null;
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

  // --- OAuth2 / OIDC -------------------------------------------------------

  /** Resolve {{vars}} in an oauth2 config and (for OIDC) fill endpoints from discovery. */
  private async resolveOauth(auth: Extract<AuthConfig, { type: "oauth2" }>) {
    const vars = await this.buildVariables();
    const r = (s?: string) => (s ? resolveTemplate(s, vars).value : "");
    let authorizeUrl = r(auth.authorizeUrl);
    let tokenUrl = r(auth.tokenUrl);
    const issuer = r(auth.issuer);
    if (issuer && (!authorizeUrl || !tokenUrl)) {
      const d = await oidcDiscover({ issuer });
      authorizeUrl = authorizeUrl || d.authorizationEndpoint || "";
      tokenUrl = tokenUrl || d.tokenEndpoint || "";
    }
    return {
      grantType: auth.grantType,
      authorizeUrl,
      tokenUrl,
      clientId: r(auth.clientId),
      clientSecret: r(auth.clientSecret),
      scope: r(auth.scope) || undefined,
      audience: r(auth.audience) || undefined,
      username: r(auth.username) || undefined,
      password: r(auth.password) || undefined,
      usePkce: auth.usePkce,
      redirect: auth.redirect,
      extraParams: (auth.extraParams ?? []).map((p) => ({
        name: p.name,
        value: r(p.value),
        enabled: p.enabled,
      })),
    };
  }

  /** Stable per-IdP key so all requests sharing tokenUrl|clientId|scope|grant reuse one token. */
  private oauthConnId(c: {
    tokenUrl: string;
    clientId: string;
    scope?: string;
    grantType: string;
  }): string {
    const s = `${c.tokenUrl}|${c.clientId}|${c.scope ?? ""}|${c.grantType}`;
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return `o${(h >>> 0).toString(36)}`;
  }

  private async persistOauthToken(
    connId: string,
    token: Oauth2TokenResult
  ): Promise<string> {
    const expiresAt = token.expiresIn ? Date.now() + token.expiresIn * 1000 : 0;
    const obtainedAt = Date.now();
    await repo.saveOauthToken(connId, {
      accessSealed: await secrets.seal(token.accessToken),
      refreshSealed: token.refreshToken
        ? await secrets.seal(token.refreshToken)
        : undefined,
      idSealed: token.idToken ? await secrets.seal(token.idToken) : undefined,
      expiresAt,
      scope: token.scope,
      tokenType: token.tokenType,
      obtainedAt,
    });
    this.oauthTokens[connId] = { expiresAt, scope: token.scope, obtainedAt };
    return token.accessToken;
  }

  /** Interactive login (authorization_code) or direct fetch — seal + cache the token. */
  async oauthLogin(
    auth: Extract<AuthConfig, { type: "oauth2" }>
  ): Promise<void> {
    const c = await this.resolveOauth(auth);
    if (!c.tokenUrl)
      throw new Error("Missing token URL — set tokenUrl or an OIDC issuer.");
    let token: Oauth2TokenResult;
    if (c.grantType === "authorization_code") {
      if (!c.authorizeUrl)
        throw new Error(
          "Missing authorize URL — set authorizeUrl or an OIDC issuer."
        );
      const authz = await oauthAuthorize({
        authorizeUrl: c.authorizeUrl,
        clientId: c.clientId,
        scope: c.scope,
        audience: c.audience,
        redirect: c.redirect,
        usePkce: c.usePkce,
        extraParams: c.extraParams,
      });
      token = await oauth2Token({
        grantType: "authorization_code",
        tokenUrl: c.tokenUrl,
        clientId: c.clientId,
        clientSecret: c.clientSecret,
        scope: c.scope,
        audience: c.audience,
        code: authz.code,
        codeVerifier: authz.codeVerifier,
        redirectUri: authz.redirectUri,
      });
    } else {
      token = await oauth2Token({
        grantType: c.grantType,
        tokenUrl: c.tokenUrl,
        clientId: c.clientId,
        clientSecret: c.clientSecret,
        scope: c.scope,
        audience: c.audience,
        username: c.username,
        password: c.password,
      });
    }
    await this.persistOauthToken(this.oauthConnId(c), token);
  }

  /** A usable access token: cache → refresh → non-interactive fetch. Null when an
   *  interactive login is required and nothing valid is cached. */
  private async ensureAccessToken(
    auth: Extract<AuthConfig, { type: "oauth2" }>
  ): Promise<string | null> {
    const c = await this.resolveOauth(auth);
    if (!c.tokenUrl) return null;
    const connId = this.oauthConnId(c);
    const stored = await repo.loadOauthToken(connId);
    const fresh =
      stored &&
      (stored.expiresAt === 0 || stored.expiresAt - Date.now() > 30_000);
    if (fresh && stored) {
      try {
        return await secrets.open(stored.accessSealed);
      } catch {
        /* fall through to refresh / refetch */
      }
    }
    if (stored?.refreshSealed) {
      try {
        const refreshToken = await secrets.open(stored.refreshSealed);
        const token = await oauth2Token({
          grantType: "refresh_token",
          tokenUrl: c.tokenUrl,
          clientId: c.clientId,
          clientSecret: c.clientSecret,
          scope: c.scope,
          refreshToken,
        });
        if (!token.refreshToken) token.refreshToken = refreshToken;
        return await this.persistOauthToken(connId, token);
      } catch {
        /* refresh failed — fall through */
      }
    }
    if (c.grantType !== "authorization_code") {
      const token = await oauth2Token({
        grantType: c.grantType,
        tokenUrl: c.tokenUrl,
        clientId: c.clientId,
        clientSecret: c.clientSecret,
        scope: c.scope,
        audience: c.audience,
        username: c.username,
        password: c.password,
      });
      return await this.persistOauthToken(connId, token);
    }
    return null;
  }

  /** Refresh the AuthEditor status pill for an oauth2 config. */
  async oauthStatus(auth: Extract<AuthConfig, { type: "oauth2" }>): Promise<{
    state: "none" | "valid" | "expired";
    expiresAt: number;
    scope?: string;
  }> {
    const c = await this.resolveOauth(auth);
    const connId = this.oauthConnId(c);
    const stored = await repo.loadOauthToken(connId);
    if (!stored) {
      delete this.oauthTokens[connId];
      this.oauthTokens = { ...this.oauthTokens };
      return { state: "none", expiresAt: 0 };
    }
    this.oauthTokens[connId] = {
      expiresAt: stored.expiresAt,
      scope: stored.scope,
      obtainedAt: stored.obtainedAt,
    };
    const valid = stored.expiresAt === 0 || stored.expiresAt > Date.now();
    return {
      state: valid ? "valid" : "expired",
      expiresAt: stored.expiresAt,
      scope: stored.scope,
    };
  }

  /** Forget a cached token (sign out). */
  async clearOauthToken(
    auth: Extract<AuthConfig, { type: "oauth2" }>
  ): Promise<void> {
    const c = await this.resolveOauth(auth);
    const connId = this.oauthConnId(c);
    await repo.deleteOauthToken(connId);
    delete this.oauthTokens[connId];
    this.oauthTokens = { ...this.oauthTokens };
  }

  /** The effective oauth2 auth for a request (its own, or the collection's via inherit). */
  private effectiveOauth(
    req: RequestDefinition
  ): Extract<AuthConfig, { type: "oauth2" }> | null {
    if (req.auth?.type === "oauth2") return req.auth;
    if (req.auth?.type === "inherit") {
      const colAuth = this.activeCollection?.collection.auth;
      if (colAuth?.type === "oauth2") return colAuth;
    }
    return null;
  }

  /** Swap an oauth2 request to a concrete Bearer token just before dispatch. */
  private async applyOAuth2(
    snap: RequestDefinition
  ): Promise<RequestDefinition> {
    const oauth = this.effectiveOauth(snap);
    if (!oauth) return snap;
    const token = await this.ensureAccessToken(oauth);
    if (!token)
      throw new Error(
        'OAuth: no valid token — open Auth and click "Get new access token" to sign in.'
      );
    snap.auth = { type: "bearer", token };
    return snap;
  }
}

export const ws = new Workspace();
