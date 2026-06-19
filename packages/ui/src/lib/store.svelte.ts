import {
  mergeScopes,
  type LoadedCollection,
  type RequestDefinition,
  type ResponseResult,
  type EnvironmentFile,
} from "@red-requester/core";
import * as repo from "./repo";
import * as keychain from "./keychain";
import { httpSend } from "./rpc";
import { isTauri } from "./tauri";

const collectionId = (folder: string): string =>
  folder.split("/").filter(Boolean).pop() ?? folder;

class Workspace {
  ready = $state(false);
  bridgeMissing = $state(false);
  collections = $state<LoadedCollection[]>([]);

  activeColPath = $state<string | null>(null);
  activeReq = $state<RequestDefinition | null>(null);
  activeEnvName = $state<string | null>(null);

  sending = $state(false);
  response = $state<ResponseResult | null>(null);
  unresolved = $state<string[]>([]);
  effectiveUrl = $state("");
  errorMsg = $state<string | null>(null);

  get activeCollection(): LoadedCollection | null {
    return this.collections.find((c) => c.path === this.activeColPath) ?? null;
  }

  get environments(): EnvironmentFile[] {
    return this.activeCollection?.environments ?? [];
  }

  async init(): Promise<void> {
    if (!isTauri) {
      this.bridgeMissing = true;
      this.ready = true;
      return;
    }
    await repo.ensureSample();
    this.collections = await repo.loadAll();
    const first = this.collections[0];
    if (first) {
      this.activeColPath = first.path;
      this.activeEnvName = first.environments[0]?.name ?? null;
      if (first.requests[0])
        this.selectRequest(first.path, first.requests[0].id);
    }
    this.ready = true;
  }

  selectRequest(colPath: string, reqId: string): void {
    const col = this.collections.find((c) => c.path === colPath);
    const req = col?.requests.find((r) => r.id === reqId);
    if (!col || !req) return;
    this.activeColPath = colPath;
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
    const secrets: Record<string, string> = {};
    if (env) {
      for (const ref of env.secretRefs) {
        const v = await keychain.getSecret(collectionId(col.path), ref);
        if (v != null) secrets[ref] = v;
      }
    }
    // Precedence (earlier wins): secret > environment > collection.
    return mergeScopes([secrets, env?.vars ?? {}, col.collection.vars]);
  }

  async send(): Promise<void> {
    if (!this.activeReq || this.sending) return;
    this.sending = true;
    this.errorMsg = null;
    try {
      const variables = await this.buildVariables();
      const result = await httpSend({
        request: $state.snapshot(this.activeReq) as RequestDefinition,
        variables,
      });
      this.response = result.response;
      this.unresolved = result.unresolved;
      this.effectiveUrl = result.effectiveUrl;
    } catch (e) {
      this.errorMsg = e instanceof Error ? e.message : String(e);
    } finally {
      this.sending = false;
    }
  }

  async save(): Promise<void> {
    if (!this.activeReq || !this.activeColPath) return;
    const snapshot = structuredClone(
      $state.snapshot(this.activeReq)
    ) as RequestDefinition;
    await repo.saveRequest(this.activeColPath, snapshot);
    const col = this.activeCollection;
    if (col) {
      const idx = col.requests.findIndex((r) => r.id === snapshot.id);
      if (idx >= 0) col.requests[idx] = snapshot;
      else col.requests.push(snapshot);
    }
  }

  async setSecret(name: string, value: string): Promise<void> {
    const col = this.activeCollection;
    const env = col?.environments.find((e) => e.name === this.activeEnvName);
    if (!col || !env) return;
    await keychain.setSecret(collectionId(col.path), name, value);
    if (!env.secretRefs.includes(name)) env.secretRefs.push(name);
    await repo.saveEnvironment(
      col.path,
      $state.snapshot(env) as EnvironmentFile
    );
  }

  async removeSecret(name: string): Promise<void> {
    const col = this.activeCollection;
    const env = col?.environments.find((e) => e.name === this.activeEnvName);
    if (!col || !env) return;
    await keychain.deleteSecret(collectionId(col.path), name);
    env.secretRefs = env.secretRefs.filter((r) => r !== name);
    await repo.saveEnvironment(
      col.path,
      $state.snapshot(env) as EnvironmentFile
    );
  }
}

export const ws = new Workspace();
