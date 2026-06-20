<script lang="ts">
  import {
    SELECTABLE_AUTH_TYPES,
    type AuthConfig,
    type AuthType,
  } from "@red-request/core";
  import { ws } from "../store.svelte";
  import VarField from "./VarField.svelte";

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
      tokenUrl: "",
      clientId: "",
      clientSecret: "",
    },
    awsSigV4: {
      type: "awsSigV4",
      accessKeyId: "",
      secretAccessKey: "",
      region: "us-east-1",
      service: "execute-api",
    },
  };

  function onType(e: Event) {
    const t = (e.target as HTMLSelectElement).value as AuthType;
    auth = structuredClone(defaults[t]);
  }
</script>

<div class="flex flex-col gap-3">
  <label class="flex items-center gap-2 text-sm">
    <span class="w-24 text-fg-muted">Type</span>
    <select value={auth.type} onchange={onType} class="select">
      {#each SELECTABLE_AUTH_TYPES as t (t)}
        <option value={t}>{t}</option>
      {/each}
    </select>
  </label>

  {#if auth.type === "basic" || auth.type === "digest"}
    <VarField bind:value={auth.username} known={ws.knownVars} values={ws.varTitles} dense placeholder="username" />
    <VarField bind:value={auth.password} known={ws.knownVars} values={ws.varTitles} dense placeholder={"password (secrets via {{NAME}})"} />
  {:else if auth.type === "bearer"}
    <VarField bind:value={auth.token} known={ws.knownVars} values={ws.varTitles} dense placeholder={"token (secrets via {{NAME}})"} />
  {:else if auth.type === "apiKey"}
    <VarField bind:value={auth.key} known={ws.knownVars} values={ws.varTitles} dense placeholder="header / param name" />
    <VarField bind:value={auth.value} known={ws.knownVars} values={ws.varTitles} dense placeholder={"value (secrets via {{NAME}})"} />
    <select bind:value={auth.in} class="select">
      <option value="header">header</option>
      <option value="query">query</option>
    </select>
  {:else if auth.type === "oauth2"}
    <select bind:value={auth.grantType} class="select">
      <option value="client_credentials">client_credentials</option>
      <option value="password">password</option>
      <option value="authorization_code">authorization_code</option>
    </select>
    <VarField bind:value={auth.tokenUrl} known={ws.knownVars} values={ws.varTitles} dense placeholder="token URL" />
    <VarField bind:value={auth.clientId} known={ws.knownVars} values={ws.varTitles} dense placeholder="client id" />
    <VarField bind:value={auth.clientSecret} known={ws.knownVars} values={ws.varTitles} dense placeholder="client secret" />
  {:else if auth.type === "awsSigV4"}
    <VarField bind:value={auth.accessKeyId} known={ws.knownVars} values={ws.varTitles} dense placeholder="access key id" />
    <VarField bind:value={auth.secretAccessKey} known={ws.knownVars} values={ws.varTitles} dense placeholder="secret access key" />
    <VarField bind:value={auth.region} known={ws.knownVars} values={ws.varTitles} dense placeholder="region" />
    <VarField bind:value={auth.service} known={ws.knownVars} values={ws.varTitles} dense placeholder="service (e.g. s3)" />
  {:else}
    <p class="text-sm text-fg-subtle">No authentication.</p>
  {/if}
</div>
