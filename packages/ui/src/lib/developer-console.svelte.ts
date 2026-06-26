export type DeveloperConsoleLevel =
  | "error"
  | "warn"
  | "info"
  | "debug"
  | "trace";
export type DeveloperConsoleSource = "app" | "reddb" | "engine";
export type DeveloperConsoleFilter = "all" | DeveloperConsoleSource;

export interface DeveloperConsoleEntry {
  id: string;
  ts: number;
  level: DeveloperConsoleLevel;
  source: DeveloperConsoleSource;
  message: string;
  detail?: string;
  durationMs?: number;
  status?: number;
  rows?: number;
  attempts?: number;
  bytes?: number;
}

export interface DeveloperConsoleSnapshot {
  entries: DeveloperConsoleEntry[];
  open: boolean;
  filter: DeveloperConsoleFilter;
  filteredEntries: DeveloperConsoleEntry[];
  latest: DeveloperConsoleEntry | null;
  errorCount: number;
}

export interface ReddbRqlLogInput {
  query: string;
  ok: boolean;
  durationMs: number;
  rows?: number;
  attempts?: number;
  error?: string;
}

export interface ReddbHttpLogInput {
  method: string;
  path: string;
  ok: boolean;
  status: number;
  durationMs: number;
  bodyBytes?: number;
  error?: string;
}

const DEFAULT_MAX_ENTRIES = 400;
const MAX_DETAIL_CHARS = 2000;

function truncate(value: string, max = MAX_DETAIL_CHARS): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}...`;
}

function compactWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function nowMs(): number {
  return Date.now();
}

function elapsedSince(start: number): number {
  const current =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  return Math.max(0, Math.round(current - start));
}

export function markDeveloperConsoleStart(): number {
  return typeof performance !== "undefined" &&
    typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

export function developerConsoleDuration(start: number): number {
  return elapsedSince(start);
}

/**
 * RedDB RQL is useful teaching material, but app writes can contain request
 * headers, env vars, sealed tokens, and body snippets. Keep the operation visible
 * while redacting persisted JSON/string payloads.
 */
export function sanitizeRqlForConsole(query: string): string {
  let out = compactWhitespace(query);
  out = out.replace(
    /(KV\s+PUT\s+[A-Za-z_][A-Za-z0-9_]*\.'(?:''|[^'])*'\s*=\s*)'(?:''|[^'])*'/gi,
    "$1'<redacted>'"
  );
  out = out.replace(
    /(PUT\s+CONFIG\s+[A-Za-z_][A-Za-z0-9_.]*\s+(?:'(?:''|[^'])*'|[A-Za-z_][A-Za-z0-9_-]*)\s*=\s*)(.*?)(\s+WITH\b|\s+TAGS\b|$)/gi,
    "$1<redacted>$3"
  );
  out = out.replace(
    /(SET\s+SECRET\s+[A-Za-z_][A-Za-z0-9_.]*\s*=\s*)(NULL|[^;]+)/gi,
    (_match, prefix: string, value: string) =>
      `${prefix}${value.trim().toUpperCase() === "NULL" ? "NULL" : "<redacted>"}`
  );
  out = out.replace(
    /(VAULT\s+PUT\s+[A-Za-z_][A-Za-z0-9_.]*\s*=\s*)(.*?)(\s+TAGS\b|\s+EXPIRE\b|$)/gi,
    (_match, prefix: string, value: string, suffix: string) =>
      `${prefix}${value.trim().toUpperCase() === "NULL" ? "NULL" : "<redacted>"}${suffix}`
  );
  return truncate(out);
}

function rqlSummary(query: string): string {
  const q = sanitizeRqlForConsole(query);
  const kv = q.match(/^KV\s+(PUT|GET|DELETE)\s+([A-Za-z_][A-Za-z0-9_]*)/i);
  if (kv) return `RQL ${kv[1]!.toUpperCase()} ${kv[2]}`;
  const listKv = q.match(/^LIST\s+KV\s+([A-Za-z_][A-Za-z0-9_]*)/i);
  if (listKv) return `RQL LIST KV ${listKv[1]}`;
  const create = q.match(
    /^CREATE\s+(KV|DOCUMENT|MIGRATION|INDEX)\s+([A-Za-z_][A-Za-z0-9_]*)/i
  );
  if (create) return `RQL CREATE ${create[1]!.toUpperCase()} ${create[2]}`;
  const setSecret = q.match(/^SET\s+SECRET\s+([A-Za-z_][A-Za-z0-9_.]*)/i);
  if (setSecret) return `RQL SET SECRET ${setSecret[1]}`;
  const deleteSecret = q.match(/^DELETE\s+SECRET\s+([A-Za-z_][A-Za-z0-9_.]*)/i);
  if (deleteSecret) return `RQL DELETE SECRET ${deleteSecret[1]}`;
  const showSecret = q.match(/^SHOW\s+SECRETS?\s*([A-Za-z_][A-Za-z0-9_.]*)?/i);
  if (showSecret)
    return `RQL SHOW SECRET${showSecret[1] ? ` ${showSecret[1]}` : ""}`;
  const vaultPut = q.match(/^VAULT\s+PUT\s+([A-Za-z_][A-Za-z0-9_.]*)/i);
  if (vaultPut) return `RQL VAULT PUT ${vaultPut[1]}`;
  const deleteVault = q.match(/^DELETE\s+VAULT\s+([A-Za-z_][A-Za-z0-9_.]*)/i);
  if (deleteVault) return `RQL DELETE VAULT ${deleteVault[1]}`;
  const drop = q.match(
    /^DROP\s+COLLECTION(?:\s+IF\s+EXISTS)?\s+([A-Za-z_][A-Za-z0-9_]*)/i
  );
  if (drop) return `RQL DROP COLLECTION ${drop[1]}`;
  const alter = q.match(/^ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)/i);
  if (alter) return `RQL ALTER TABLE ${alter[1]}`;
  const select = q.match(/^SELECT\b.+?\bFROM\s+([A-Za-z_][A-Za-z0-9_.]*)/i);
  if (select) return `RQL SELECT ${select[1]}`;
  if (/^APPLY\s+MIGRATION\s+\*/i.test(q)) return "RQL APPLY MIGRATION *";
  return `RQL ${q.split(" ").slice(0, 3).join(" ")}`;
}

export class DeveloperConsoleStore {
  entries: DeveloperConsoleEntry[] = [];
  open = false;
  filter: DeveloperConsoleFilter = "all";
  private sequence = 0;
  private listeners = new Set<(snapshot: DeveloperConsoleSnapshot) => void>();

  constructor(private maxEntries = DEFAULT_MAX_ENTRIES) {}

  get filteredEntries(): DeveloperConsoleEntry[] {
    return this.filter === "all"
      ? this.entries
      : this.entries.filter((entry) => entry.source === this.filter);
  }

  get latest(): DeveloperConsoleEntry | null {
    return this.entries[0] ?? null;
  }

  get errorCount(): number {
    return this.entries.filter((entry) => entry.level === "error").length;
  }

  get snapshot(): DeveloperConsoleSnapshot {
    return {
      entries: this.entries,
      open: this.open,
      filter: this.filter,
      filteredEntries: this.filteredEntries,
      latest: this.latest,
      errorCount: this.errorCount,
    };
  }

  subscribe(run: (snapshot: DeveloperConsoleSnapshot) => void): () => void {
    this.listeners.add(run);
    run(this.snapshot);
    return () => this.listeners.delete(run);
  }

  private notify(): void {
    const snapshot = this.snapshot;
    for (const run of this.listeners) run(snapshot);
  }

  add(input: Omit<DeveloperConsoleEntry, "id" | "ts"> & { ts?: number }): void {
    const ts = input.ts ?? nowMs();
    const entry: DeveloperConsoleEntry = {
      ...input,
      id: `dev-${ts}-${this.sequence++}`,
      ts,
      message: truncate(input.message, 240),
      detail: input.detail ? truncate(input.detail) : undefined,
    };
    this.entries = [entry, ...this.entries].slice(0, this.maxEntries);
    this.notify();
  }

  clear(): void {
    this.entries = [];
    this.notify();
  }

  setFilter(filter: DeveloperConsoleFilter): void {
    this.filter = filter;
    this.notify();
  }

  toggle(): void {
    this.open = !this.open;
    this.notify();
  }

  logApp(level: DeveloperConsoleLevel, message: string): void {
    this.add({
      level,
      source: "app",
      message,
    });
  }

  logReddbRql(input: ReddbRqlLogInput): void {
    const detail = sanitizeRqlForConsole(input.query);
    this.add({
      level: input.ok ? "debug" : "error",
      source: "reddb",
      message: input.ok
        ? rqlSummary(input.query)
        : `RQL failed: ${rqlSummary(input.query).replace(/^RQL\s+/, "")}`,
      detail: input.error ? `${detail}\n${input.error}` : detail,
      durationMs: input.durationMs,
      rows: input.rows,
      attempts: input.attempts,
    });
  }

  logReddbHttp(input: ReddbHttpLogInput): void {
    this.add({
      level: input.ok ? "debug" : "error",
      source: "reddb",
      message: `${input.method.toUpperCase()} ${input.path}`,
      detail: input.error,
      durationMs: input.durationMs,
      status: input.status,
      bytes: input.bodyBytes,
    });
  }
}

export const developerConsole = new DeveloperConsoleStore();
