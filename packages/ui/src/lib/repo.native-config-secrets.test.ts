import { afterEach, describe, expect, it, vi } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import {
  storedEnvironmentSchema,
  type StoredEnvironment,
} from "@reddb-io/request-core";
import * as repo from "./repo";

const reply = (status: number, body: unknown) => ({
  status,
  body: typeof body === "string" ? body : JSON.stringify(body),
});

function rqlOk(records: Array<Record<string, unknown>> = []) {
  return reply(200, {
    ok: true,
    data: {
      columns: Object.keys(records[0] ?? {}),
      records,
    },
  });
}

function kvRow(key: string, value: unknown) {
  return { key, value: JSON.stringify(value) };
}

function ipc(handlers: {
  rql?: (query: string) => unknown;
  secretOpen?: (iv: string, ct: string) => string;
}) {
  mockIPC((cmd, args) => {
    const a = args as Record<string, unknown>;
    if (cmd === "reddb_rql")
      return handlers.rql?.(a.query as string) ?? rqlOk([]);
    if (cmd === "secret_open")
      return handlers.secretOpen?.(a.iv as string, a.ct as string) ?? "opened";
    return null;
  });
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("native RedDB config/secrets repository", () => {
  it("saves environment metadata and secret values through RedDB-native CONFIG and SECRET", async () => {
    const queries: string[] = [];
    ipc({
      rql: (query) => {
        queries.push(query);
        if (query === "RESOLVE CONFIG red_request secret_646576_4150495f4b4559")
          return rqlOk([{ value: "sk_live" }]);
        return rqlOk([{ message: "ok" }]);
      },
    });

    const env = storedEnvironmentSchema.parse({
      name: "dev",
      vars: { host: "api.local" },
      secrets: {},
    });

    await repo.saveEnvironmentSecret(env, "API_KEY", "sk_live");
    const resolved = await repo.resolveEnvironmentSecret(env, "API_KEY");

    expect(resolved).toBe("sk_live");
    expect(queries).toContain(
      "CREATE VAULT IF NOT EXISTS red_request_secrets WITH OWN MASTER KEY"
    );
    expect(queries).toContain(
      "VAULT PUT red_request_secrets.e_646576.s_4150495f4b4559 = 'sk_live'"
    );
    expect(queries).toContain(
      "PUT CONFIG red_request secret_646576_4150495f4b4559 = SECRET_REF(vault, red_request_secrets.e_646576.s_4150495f4b4559)"
    );
    expect(
      queries.some((query) =>
        query.startsWith("PUT CONFIG red_request env_646576 = ")
      )
    ).toBe(true);
    expect(
      queries.some((query) => query.startsWith("KV PUT rr_environments"))
    ).toBe(false);
  });

  it("migrates legacy rr_environments sealed secrets into native CONFIG and SECRET", async () => {
    const legacy: StoredEnvironment = {
      name: "dev",
      vars: { host: "legacy.local" },
      secrets: {
        API_KEY: { iv: "iv", ct: "ct" },
      },
    };
    const queries: string[] = [];
    ipc({
      secretOpen: () => "legacy-secret",
      rql: (query) => {
        queries.push(query);
        if (query === "LIST CONFIG red_request PREFIX env_") return rqlOk([]);
        if (query === "LIST KV rr_environments")
          return rqlOk([kvRow("dev", legacy)]);
        return rqlOk([{ message: "ok" }]);
      },
    });

    const envs = await repo.loadEnvironments();

    expect(envs).toHaveLength(1);
    expect(envs[0]?.secrets.API_KEY).toMatchObject({
      ref: "red_request_secrets.e_646576.s_4150495f4b4559",
      configKey: "secret_646576_4150495f4b4559",
      missing: false,
    });
    expect(queries).toContain(
      "CREATE VAULT IF NOT EXISTS red_request_secrets WITH OWN MASTER KEY"
    );
    expect(queries).toContain(
      "VAULT PUT red_request_secrets.e_646576.s_4150495f4b4559 = 'legacy-secret'"
    );
    expect(queries).toContain(
      "PUT CONFIG red_request secret_646576_4150495f4b4559 = SECRET_REF(vault, red_request_secrets.e_646576.s_4150495f4b4559)"
    );
    expect(
      queries.some((query) =>
        query.startsWith("PUT CONFIG red_request env_646576 = ")
      )
    ).toBe(true);
    expect(
      queries.some((query) => query.startsWith("KV PUT rr_environments"))
    ).toBe(false);
  });

  it("loads native environments in the persisted RedDB config order", async () => {
    const dev = storedEnvironmentSchema.parse({
      name: "dev",
      vars: {},
      secrets: {},
    });
    const prod = storedEnvironmentSchema.parse({
      name: "prod",
      vars: {},
      secrets: {},
    });

    ipc({
      rql: (query) => {
        if (query === "LIST CONFIG red_request PREFIX env_")
          return rqlOk([
            { key: "env_646576", value: dev, tombstone: false },
            { key: "env_70726f64", value: prod, tombstone: false },
          ]);
        if (query === "LIST KV rr_environments") return rqlOk([]);
        if (query === "GET CONFIG red_request settings_env_order")
          return rqlOk([{ value: ["prod", "dev"], tombstone: false }]);
        return rqlOk([{ message: "ok" }]);
      },
    });

    const envs = await repo.loadEnvironments();

    expect(envs.map((env) => env.name)).toEqual(["prod", "dev"]);
  });

  it("rekeys native environment secrets when an environment is renamed", async () => {
    const queries: string[] = [];
    ipc({
      rql: (query) => {
        queries.push(query);
        if (query === "RESOLVE CONFIG red_request secret_646576_4150495f4b4559")
          return rqlOk([{ value: "sk_live" }]);
        return rqlOk([{ message: "ok" }]);
      },
    });

    const env = storedEnvironmentSchema.parse({
      name: "prod",
      vars: { host: "api.prod" },
      secrets: {
        API_KEY: {
          ref: "red_request_secrets.e_646576.s_4150495f4b4559",
          vault: "red_request_secrets",
          configKey: "secret_646576_4150495f4b4559",
        },
      },
    });

    await repo.renameEnvironment("dev", env);

    expect(env.secrets.API_KEY).toMatchObject({
      ref: "red_request_secrets.e_70726f64.s_4150495f4b4559",
      configKey: "secret_70726f64_4150495f4b4559",
      missing: false,
    });
    expect(queries).toContain(
      "VAULT PUT red_request_secrets.e_70726f64.s_4150495f4b4559 = 'sk_live'"
    );
    expect(queries).toContain(
      "PUT CONFIG red_request secret_70726f64_4150495f4b4559 = SECRET_REF(vault, red_request_secrets.e_70726f64.s_4150495f4b4559)"
    );
    expect(queries).toContain("DELETE CONFIG red_request env_646576");
    expect(queries).toContain(
      "DELETE CONFIG red_request secret_646576_4150495f4b4559"
    );
    expect(queries).toContain(
      "DELETE VAULT red_request_secrets.e_646576.s_4150495f4b4559"
    );
  });
});
