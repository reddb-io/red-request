import { describe, expect, it, vi } from "vitest";
import { embeddedRedUiFetch } from "./red-ui-embed";

describe("red-ui embed fetch adapter", () => {
  it("routes red-ui HTTP calls through the managed reddb_request bridge", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({ ok: true }),
    }));
    const fetcher = embeddedRedUiFetch("http://127.0.0.1:15055", request);

    const res = await fetcher("http://127.0.0.1:15055/query?debug=1", {
      method: "POST",
      body: JSON.stringify({ query: "SELECT 1" }),
    });

    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ ok: true });
    expect(request).toHaveBeenCalledWith(
      "POST",
      "/query?debug=1",
      JSON.stringify({ query: "SELECT 1" })
    );

    await fetcher("http://127.0.0.1:15055/stats");
    expect(request).toHaveBeenLastCalledWith("GET", "/stats", null);
  });

  it("refuses requests outside the managed RedDB endpoint", async () => {
    const request = vi.fn();
    const fetcher = embeddedRedUiFetch("http://127.0.0.1:15055", request);

    await expect(fetcher("http://127.0.0.1:15056/stats")).rejects.toThrow(
      /managed RedDB endpoint/
    );
    expect(request).not.toHaveBeenCalled();
  });
});
