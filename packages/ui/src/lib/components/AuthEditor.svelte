<script lang="ts">
  import {
    SELECTABLE_AUTH_TYPES,
    type AuthConfig,
    type AuthType,
  } from "@reddb-io/request-core";
  import { ws } from "../store.svelte";
  import VarField from "./VarField.svelte";
  import Select from "./ui/Select.svelte";
  import KeyValueEditor from "./KeyValueEditor.svelte";
  import { Button } from "./ui/button/index.js";

  let { auth = $bindable() }: { auth: AuthConfig } = $props();

  const defaults: Record<AuthType, AuthConfig> = {
    none: { type: "none" },
    inherit: { type: "inherit" },
    basic: { type: "basic", username: "", password: "" },
    bearer: { type: "bearer", token: "" },
    apiKey: { type: "apiKey", key: "X-API-Key", value: "", in: "header" },
    digest: { type: "digest", username: "", password: "" },
    oauth2: {
      type: "oauth2",
      grantType: "client_credentials",
      issuer: "",
      authorizeUrl: "",
      tokenUrl: "",
      clientId: "",
      clientSecret: "",
      scope: "",
      audience: "",
      usePkce: true,
      redirect: "loopback",
      username: "",
      password: "",
      extraParams: [],
    },
    awsSigV4: {
      type: "awsSigV4",
      accessKeyId: "",
      secretAccessKey: "",
      region: "us-east-1",
      service: "execute-api",
    },
  };

  function setType(t: AuthType) {
    auth = structuredClone(defaults[t]);
  }

  // --- OAuth2 token status + actions ---------------------------------------
  type Status = { state: "none" | "valid" | "expired"; expiresAt: number; scope?: string };
  let status = $state<Status>({ state: "none", expiresAt: 0 });
  let busy = $state(false);
  let oauthError = $state("");

  // Refetch status only when the token identity (the connId inputs) changes.
  const idKey = $derived(
    auth.type === "oauth2"
      ? `${auth.grantType}|${auth.issuer}|${auth.tokenUrl}|${auth.clientId}|${auth.scope}`
      : ""
  );
  $effect(() => {
    idKey;
    void refresh();
  });

  async function refresh() {
    if (auth.type !== "oauth2") return;
    try {
      status = await ws.oauthStatus(auth);
    } catch {
      status = { state: "none", expiresAt: 0 };
    }
  }
  async function login() {
    if (auth.type !== "oauth2" || busy) return;
    busy = true;
    oauthError = "";
    try {
      await ws.oauthLogin(auth);
      await refresh();
    } catch (e) {
      oauthError = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
  async function clear() {
    if (auth.type !== "oauth2") return;
    await ws.clearOauthToken(auth);
    await refresh();
  }

  function rel(ms: number): string {
    if (!ms) return "no expiry";
    const d = ms - Date.now();
    if (d <= 0) return "expired";
    const m = Math.round(d / 60000);
    if (m < 60) return `expires in ${m}m`;
    return `expires in ${Math.round(m / 60)}h`;
  }
</script>

<div class="flex flex-col gap-3">
  <label class="flex items-center gap-2 text-sm">
    <span class="w-24 text-fg-muted">Type</span>
    <Select
      value={auth.type}
      items={SELECTABLE_AUTH_TYPES}
      onChange={setType}
      ariaLabel="auth type"
      class="flex-1"
    />
  </label>

  {#if auth.type === "basic" || auth.type === "digest"}
    <VarField bind:value={auth.username} known={ws.knownVars} values={ws.varTitles} dense placeholder="username" />
    <VarField bind:value={auth.password} known={ws.knownVars} values={ws.varTitles} dense placeholder={"password (secrets via {{NAME}})"} />
  {:else if auth.type === "bearer"}
    <VarField bind:value={auth.token} known={ws.knownVars} values={ws.varTitles} dense placeholder={"token (secrets via {{NAME}})"} />
  {:else if auth.type === "apiKey"}
    <VarField bind:value={auth.key} known={ws.knownVars} values={ws.varTitles} dense placeholder="header / param name" />
    <VarField bind:value={auth.value} known={ws.knownVars} values={ws.varTitles} dense placeholder={"value (secrets via {{NAME}})"} />
    <Select bind:value={auth.in} items={["header", "query"] as const} ariaLabel="api key location" />
  {:else if auth.type === "oauth2"}
    <Select
      bind:value={auth.grantType}
      items={["client_credentials", "password", "authorization_code"] as const}
      ariaLabel="grant type"
    />

    {#if auth.grantType === "authorization_code"}
      <VarField bind:value={auth.issuer} known={ws.knownVars} values={ws.varTitles} dense placeholder={"OIDC issuer (optional — autofills endpoints)"} />
      <VarField bind:value={auth.authorizeUrl} known={ws.knownVars} values={ws.varTitles} dense placeholder="authorize URL" />
    {/if}
    <VarField bind:value={auth.tokenUrl} known={ws.knownVars} values={ws.varTitles} dense placeholder="token URL" />
    <VarField bind:value={auth.clientId} known={ws.knownVars} values={ws.varTitles} dense placeholder="client id" />
    <VarField bind:value={auth.clientSecret} known={ws.knownVars} values={ws.varTitles} dense placeholder={"client secret (optional with PKCE)"} />
    <VarField bind:value={auth.scope} known={ws.knownVars} values={ws.varTitles} dense placeholder="scope (space-separated)" />

    {#if auth.grantType === "password"}
      <VarField bind:value={auth.username} known={ws.knownVars} values={ws.varTitles} dense placeholder="username" />
      <VarField bind:value={auth.password} known={ws.knownVars} values={ws.varTitles} dense placeholder={"password (secrets via {{NAME}})"} />
    {/if}

    {#if auth.grantType === "authorization_code"}
      <VarField bind:value={auth.audience} known={ws.knownVars} values={ws.varTitles} dense placeholder="audience (optional)" />
      <div class="flex items-center gap-3 text-sm">
        <span class="w-24 text-fg-muted">Redirect</span>
        <Select bind:value={auth.redirect} items={["loopback", "deeplink"] as const} ariaLabel="redirect method" class="w-auto" />
        <label class="flex items-center gap-1.5 text-xs text-fg-muted">
          <input type="checkbox" bind:checked={auth.usePkce} /> PKCE (S256)
        </label>
      </div>
      <div>
        <span class="hint mb-1 block">extra authorize params (optional)</span>
        <KeyValueEditor bind:items={auth.extraParams} placeholder="prompt / login_hint…" />
      </div>
    {/if}

    <!-- Token actions + status -->
    <div class="mt-1 flex items-center gap-2 border-t border-border pt-2">
      <Button onclick={login} disabled={busy} size="xs">
        {busy ? "Signing in…" : "Get new access token"}
      </Button>
      {#if status.state === "valid"}
        <span class="mono rounded bg-emerald-900/30 px-1.5 py-0.5 text-[10px] text-emerald-300"
          >● {rel(status.expiresAt)}</span
        >
      {:else if status.state === "expired"}
        <span class="mono rounded bg-amber-900/30 px-1.5 py-0.5 text-[10px] text-amber-300">expired</span>
      {:else}
        <span class="hint">no token</span>
      {/if}
      {#if status.state !== "none"}
        <Button onclick={clear} variant="ghost" size="xs" class="ml-auto hover:text-red-400">Clear</Button>
      {/if}
    </div>
    {#if oauthError}
      <div class="text-xs text-red-400">{oauthError}</div>
    {/if}
  {:else if auth.type === "awsSigV4"}
    <VarField bind:value={auth.accessKeyId} known={ws.knownVars} values={ws.varTitles} dense placeholder="access key id" />
    <VarField bind:value={auth.secretAccessKey} known={ws.knownVars} values={ws.varTitles} dense placeholder="secret access key" />
    <VarField bind:value={auth.region} known={ws.knownVars} values={ws.varTitles} dense placeholder="region" />
    <VarField bind:value={auth.service} known={ws.knownVars} values={ws.varTitles} dense placeholder="service (e.g. s3)" />
  {:else}
    <p class="text-sm text-fg-subtle">No authentication.</p>
  {/if}
</div>
