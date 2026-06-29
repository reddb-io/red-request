import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/svelte";

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
        secrets: {
          API_KEY: {
            ref: "red_request_secrets.e_4c6f63616c.s_4150495f4b4559",
            vault: "red_request_secrets",
            configKey: "secret_4c6f63616c_4150495f4b4559",
          },
        },
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

  it("renames an environment after double-clicking its tab name", async () => {
    const renameEnv = vi.spyOn(ws, "renameEnv").mockResolvedValue();

    render(EnvironmentsEditor, { props: { inline: true } });

    await fireEvent.dblClick(screen.getByRole("button", { name: /Local/ }));
    const input = (await screen.findAllByDisplayValue("Local"))[0]!;
    await fireEvent.input(input, { target: { value: "Staging" } });
    await fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(renameEnv).toHaveBeenCalledWith(ws.environments[0], "Staging");
    });
  });

  it("overwrites an existing secret from its row action", async () => {
    const setSecret = vi.spyOn(ws, "setSecret").mockResolvedValue();

    render(EnvironmentsEditor, { props: { inline: true } });

    await fireEvent.click(
      screen.getByRole("button", { name: "overwrite API_KEY secret" })
    );
    expect(
      (screen.getByPlaceholderText("NAME") as HTMLInputElement).value
    ).toBe("API_KEY");

    const secretValueInput = document.querySelector<HTMLInputElement>(
      'input[type="password"][placeholder="value"]'
    );
    expect(secretValueInput).toBeTruthy();
    await fireEvent.input(secretValueInput!, {
      target: { value: "sk_next" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Overwrite" }));

    await waitFor(() => {
      expect(setSecret).toHaveBeenCalledWith(
        ws.environments[0],
        "API_KEY",
        "sk_next"
      );
    });
  });
});
