import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/svelte";

import { storedEnvironmentSchema } from "@reddb-io/request-core";
import { ws } from "../store.svelte";
import EnvironmentsEditor from "./EnvironmentsEditor.svelte";

describe("EnvironmentsEditor", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    ws.activeEnvName = "Local";
    ws.globals = storedEnvironmentSchema.parse({
      name: "Globals",
      vars: {},
      secrets: {},
    });
    ws.environments = [
      storedEnvironmentSchema.parse({
        name: "Local",
        vars: { LOCAL_TOKEN: "local" },
        secrets: {},
      }),
    ];
    ws.settingsIntent = null;
  });

  it("prepares a new global variable row when opened from the command palette", async () => {
    ws.settingsIntent = "global-variable";

    render(EnvironmentsEditor, { props: { inline: true } });

    await waitFor(() => {
      expect(screen.getByText(/base variables/)).toBeTruthy();
      expect(screen.getByPlaceholderText("VAR_NAME")).toBeTruthy();
      expect(ws.settingsIntent).toBeNull();
    });
  });

  it("prepares the global secret field when opened from the command palette", async () => {
    ws.settingsIntent = "global-secret";

    render(EnvironmentsEditor, { props: { inline: true } });

    await waitFor(() => {
      expect(screen.getByText(/base variables/)).toBeTruthy();
      expect(screen.getByPlaceholderText("NAME")).toBeTruthy();
      expect(ws.settingsIntent).toBeNull();
    });
  });
});
