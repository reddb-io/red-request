<script lang="ts">
  // gRPC request UI (kind === "grpc"): server address, a pasted .proto (Load → services/methods),
  // a JSON request message (+ skeleton from the proto), metadata, and Invoke (unary).
  import { ws } from "../store.svelte";
  import { Button } from "./ui/button/index.js";
  import { Textarea } from "./ui/textarea/index.js";
  import Select from "./ui/Select.svelte";
  import VarField from "./VarField.svelte";
  import KeyValueEditor from "./KeyValueEditor.svelte";

  const g = $derived(ws.activeReq!.grpc);
  const services = $derived(ws.grpcServices);
  const methods = $derived(services.find((s) => s.name === g.service)?.methods ?? []);
  const selectedMethod = $derived(methods.find((m) => m.name === g.method));

  function onService(name: string) {
    g.service = name;
    g.method = services.find((s) => s.name === name)?.methods[0]?.name ?? "";
  }
  function useSkeleton() {
    if (selectedMethod) g.message = selectedMethod.skeleton;
  }
</script>

<div class="flex h-full flex-col gap-2 overflow-y-auto">
  <div class="flex items-center gap-2">
    <span class="hint w-14 shrink-0">address</span>
    <div class="min-w-0 flex-1">
      <VarField
        bind:value={ws.activeReq!.url}
        known={ws.knownVars}
        values={ws.varTitles}
        ariaLabel="gRPC server address"
        placeholder={"grpcb.in:9000"}
      />
    </div>
    <label class="flex items-center gap-1 text-xs text-fg-muted">
      <input type="checkbox" bind:checked={g.plaintext} class="accent-[var(--color-brand)]" /> plaintext
    </label>
    <Button
      onclick={() => ws.grpcInvoke()}
      disabled={ws.sending || !g.service || !g.method}
      size="xs"
      class="shrink-0">{ws.sending ? "…" : "Invoke"}</Button
    >
  </div>

  <div class="flex items-center gap-2">
    <h4 class="label">Proto</h4>
    <Button onclick={() => ws.grpcLoadMethods()} variant="outline" size="xs" disabled={ws.grpcLoading}
      >{ws.grpcLoading ? "Loading…" : "Load"}</Button
    >
    {#if services.length}
      <Select
        value={g.service}
        onChange={onService}
        items={services.map((s) => ({ value: s.name, label: s.name }))}
        ariaLabel="service"
        class="w-auto text-xs"
      />
      <Select
        bind:value={g.method}
        items={methods.map((m) => ({
          value: m.name,
          label: m.name + (m.requestStream || m.responseStream ? " (stream)" : ""),
        }))}
        ariaLabel="method"
        class="w-auto text-xs"
      />
    {/if}
  </div>
  <Textarea
    bind:value={g.proto}
    rows={5}
    class="mono text-xs"
    placeholder={"syntax = \"proto3\";\nservice Greeter { rpc Hello(Req) returns (Res); }\n…"}
  />

  <div class="flex items-center justify-between">
    <h4 class="label">Message (JSON)</h4>
    {#if selectedMethod}
      <Button onclick={useSkeleton} variant="ghost" size="xs" title="Fill from the proto">skeleton</Button
      >
    {/if}
  </div>
  <VarField
    bind:value={g.message}
    known={ws.knownVars}
    values={ws.varTitles}
    multiline
    lineNumbers
    rows={6}
    ariaLabel="gRPC request message"
    placeholder={'{ "greeting": "hi" }'}
  />

  <h4 class="label">Metadata</h4>
  <KeyValueEditor bind:items={g.metadata} placeholder="metadata" />
</div>
