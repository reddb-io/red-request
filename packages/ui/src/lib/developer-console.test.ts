import { describe, expect, it } from "vitest";
import {
  DeveloperConsoleStore,
  sanitizeRqlForConsole,
} from "./developer-console.svelte";

describe("DeveloperConsoleStore", () => {
  it("keeps a bounded newest-first activity buffer", () => {
    const consoleStore = new DeveloperConsoleStore(2);

    consoleStore.logApp("info", "first");
    consoleStore.logApp("warn", "second");
    consoleStore.logApp("error", "third");

    expect(consoleStore.entries.map((entry) => entry.message)).toEqual([
      "third",
      "second",
    ]);
    expect(consoleStore.errorCount).toBe(1);
  });

  it("filters by event source", () => {
    const consoleStore = new DeveloperConsoleStore();

    consoleStore.logApp("info", "boot");
    consoleStore.logReddbHttp({
      method: "GET",
      path: "/stats",
      ok: true,
      status: 200,
      durationMs: 12,
    });

    consoleStore.setFilter("reddb");

    expect(consoleStore.filteredEntries).toHaveLength(1);
    expect(consoleStore.filteredEntries[0]?.message).toBe("GET /stats");
  });

  it("redacts KV PUT payloads from RQL display", () => {
    const query =
      'KV PUT rr_settings.\'globals\' = \'{"token":"secret","nested":"value"}\'';

    expect(sanitizeRqlForConsole(query)).toBe(
      "KV PUT rr_settings.'globals' = '<redacted>'"
    );
  });

  it("redacts native RedDB config payloads from RQL display", () => {
    const query =
      'PUT CONFIG red_request env_646576 = {"name":"dev","vars":{"token":"secret"}} WITH TYPE object';

    expect(sanitizeRqlForConsole(query)).toBe(
      "PUT CONFIG red_request env_646576 = <redacted> WITH TYPE object"
    );
  });

  it("redacts native RedDB secret SQL payloads from RQL display", () => {
    expect(
      sanitizeRqlForConsole("SET SECRET mycompany.stripe.key = 'sk_live'")
    ).toBe("SET SECRET mycompany.stripe.key = <redacted>");
    expect(
      sanitizeRqlForConsole(
        "VAULT PUT red.secret.ai.openai.default.api_key = 'sk_live' TAGS [scope:prod]"
      )
    ).toBe(
      "VAULT PUT red.secret.ai.openai.default.api_key = <redacted> TAGS [scope:prod]"
    );
    expect(
      sanitizeRqlForConsole("SET SECRET mycompany.stripe.key = NULL")
    ).toBe("SET SECRET mycompany.stripe.key = NULL");
  });

  it("summarizes native vault operations without exposing values", () => {
    const consoleStore = new DeveloperConsoleStore();

    consoleStore.logReddbRql({
      query: "DELETE VAULT red_request_secrets.e_646576.s_4150495f4b4559",
      ok: true,
      durationMs: 3,
    });

    expect(consoleStore.entries[0]?.message).toBe(
      "RQL DELETE VAULT red_request_secrets.e_646576.s_4150495f4b4559"
    );
  });

  it("records failed RQL with sanitized detail", () => {
    const consoleStore = new DeveloperConsoleStore();

    consoleStore.logReddbRql({
      query: "KV PUT rr_oauth_tokens.'conn' = '{\"access\":\"secret\"}'",
      ok: false,
      durationMs: 20,
      attempts: 2,
      error: "disk full",
    });

    expect(consoleStore.entries[0]?.level).toBe("error");
    expect(consoleStore.entries[0]?.detail).toContain("<redacted>");
    expect(consoleStore.entries[0]?.detail).toContain("disk full");
    expect(consoleStore.entries[0]?.detail).not.toContain("secret");
  });
});
