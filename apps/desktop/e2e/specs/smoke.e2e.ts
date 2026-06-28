// Smoke: the real app launches, boots its reddb sidecar, and renders its UI.
// Robust (no app-specific selectors) so it stays green as the UI evolves — it
// proves the whole harness (tauri-driver → WebKitWebDriver → app → sidecar) works.
// Build feature-specific flows (e.g. the History/time-travel modal) on top of this.

describe("app smoke", () => {
  it("launches and renders a non-empty UI", async () => {
    // The webview is up the moment the session starts; give the SvelteKit app a
    // beat to mount and the sidecar to answer the first RQL.
    await browser.waitUntil(
      async () => (await $("body").getText()).trim().length > 0,
      { timeout: 60_000, timeoutMsg: "UI never rendered visible text" }
    );

    const title = await browser.getTitle();
    expect(title.toLowerCase()).toContain("red");

    // Regression guard for the project-open black-screen class: the native
    // titlebar is part of the route shell and must remain visible even while
    // the app workspace is loading or recovering.
    await browser.waitUntil(
      async () => {
        let visible = 0;
        for (const selector of [
          "[aria-label='Minimize window']",
          "[aria-label='Maximize window'], [aria-label='Restore window']",
          "[aria-label='Close window']",
        ]) {
          const control = await $(selector);
          if ((await control.isExisting()) && (await control.isDisplayed()))
            visible++;
        }
        return visible >= 3;
      },
      { timeout: 15_000, timeoutMsg: "native titlebar controls disappeared" }
    );

    // Something interactive exists (button or the project selector / sidebar).
    const interactive = await $$("button, [role='button'], input");
    expect(interactive.length).toBeGreaterThan(0);
  });
});
