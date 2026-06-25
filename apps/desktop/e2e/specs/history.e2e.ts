// Native VCS / History flow — template. Drives the real app to open a request,
// open the History modal (data-testid="request-history-btn"), and assert the
// time-travel UI shows up. Marked `.skip` because the steps to reach a selected
// request depend on the local project state (project selector → collection →
// request); fill those in for your environment, then remove `.skip`.
//
// This is the layer that smoke-tests the feature end to end: clicking History
// triggers reddb_request(GET /repo/commits) + reddb_rql(SELECT ... AS OF) against
// the real sidecar.

describe.skip("request history (native VCS)", () => {
  it("opens the History modal for a request and lists versions", async () => {
    // 1. Reach a selected request. Depending on first-run state this is either
    //    picking the seeded "Sample · httpbingo" project then a request in the
    //    sidebar, or selecting an existing one. Example (adjust selectors):
    //
    //    await (await $("=Sample · httpbingo")).click();
    //    await (await $("=GET anything")).click();

    // 2. Open History.
    const historyBtn = await $('[data-testid="request-history-btn"]');
    await historyBtn.waitForClickable({ timeout: 30_000 });
    await historyBtn.click();

    // 3. The modal renders — either versions or the empty state.
    const heading = await $("h2=History");
    await heading.waitForExist({ timeout: 10_000 });
    expect(await heading.isDisplayed()).toBe(true);

    // 4. (Optional) make an edit first so there is real history, then assert a
    //    "Restore this version" button appears and restoring re-selects the req.
  });
});
