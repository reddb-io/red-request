<script lang="ts">
  import {
    SELECTABLE_AUTH_TYPES,
    type AuthConfig,
    type AuthType,
  } from "@red-request/core";

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

  const field =
    "mono w-full rounded bg-[var(--color-bg-2)] px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-[var(--color-accent)]";
</script>

<div class="flex flex-col gap-3">
  <label class="flex items-center gap-2 text-sm">
    <span class="w-24 text-zinc-400">Type</span>
    <select value={auth.type} onchange={onType} class={field}>
      {#each SELECTABLE_AUTH_TYPES as t (t)}
        <option value={t}>{t}</option>
      {/each}
    </select>
  </label>

  {#if auth.type === "basic" || auth.type === "digest"}
    <input bind:value={auth.username} placeholder="username" class={field} />
    <input bind:value={auth.password} placeholder={"password (secrets via {{NAME}})"} class={field} />
  {:else if auth.type === "bearer"}
    <input bind:value={auth.token} placeholder={"token (secrets via {{NAME}})"} class={field} />
  {:else if auth.type === "apiKey"}
    <input bind:value={auth.key} placeholder="header / param name" class={field} />
    <input bind:value={auth.value} placeholder={"value (secrets via {{NAME}})"} class={field} />
    <select bind:value={auth.in} class={field}>
      <option value="header">header</option>
      <option value="query">query</option>
    </select>
  {:else if auth.type === "oauth2"}
    <select bind:value={auth.grantType} class={field}>
      <option value="client_credentials">client_credentials</option>
      <option value="password">password</option>
      <option value="authorization_code">authorization_code</option>
    </select>
    <input bind:value={auth.tokenUrl} placeholder="token URL" class={field} />
    <input bind:value={auth.clientId} placeholder="client id" class={field} />
    <input bind:value={auth.clientSecret} placeholder="client secret" class={field} />
  {:else if auth.type === "awsSigV4"}
    <input bind:value={auth.accessKeyId} placeholder="access key id" class={field} />
    <input bind:value={auth.secretAccessKey} placeholder="secret access key" class={field} />
    <input bind:value={auth.region} placeholder="region" class={field} />
    <input bind:value={auth.service} placeholder="service (e.g. s3)" class={field} />
  {:else}
    <p class="text-sm text-zinc-500">No authentication.</p>
  {/if}
</div>
