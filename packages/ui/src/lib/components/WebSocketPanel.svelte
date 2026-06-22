<script lang="ts">
  // Live WebSocket client for a kind === "ws" request: a ws:// URL bar, connect/disconnect,
  // a streaming frame log (▲ sent / ▼ received / · system) and a send composer.
  import { ws } from "../store.svelte";
  import { Button } from "./ui/button/index.js";
  import VarField from "./VarField.svelte";
  import HexViewer from "./HexViewer.svelte";
  import { RotateCcw } from "@lucide/svelte";

  let draft = $state("");
  const connected = $derived(ws.wsStatus === "open");
  const pending = $derived(ws.wsStatus === "connecting");
  const isSse = $derived(ws.activeReq?.kind === "sse");

  function toggle() {
    if (connected || pending) void ws.streamDisconnect();
    else void ws.streamConnect();
  }
  async function send() {
    if (!draft.trim()) return;
    const d = draft;
    draft = "";
    await ws.wsSendMessage(d);
  }
  async function replay(data: string) {
    await ws.wsSendMessage(data);
  }

  const dot: Record<string, string> = {
    idle: "text-fg-faint",
    connecting: "text-amber-400",
    open: "text-emerald-400",
    closed: "text-fg-muted",
    error: "text-red-400",
  };
  const fmtTime = (t: number) =>
    new Date(t).toLocaleTimeString(undefined, { hour12: false });
</script>

<div class="flex h-full flex-col gap-2">
  <div class="flex items-center gap-2">
    <span class={`text-lg leading-none ${dot[ws.wsStatus]}`}>●</span>
    <span class="hint w-16 shrink-0 capitalize">{ws.wsStatus}</span>
    <div class="min-w-0 flex-1">
      <VarField
        bind:value={ws.activeReq!.url}
        known={ws.knownVars}
        values={ws.varTitles}
        ariaLabel={isSse ? "SSE URL" : "WebSocket URL"}
        placeholder={isSse ? "https://{{host}}/events" : "wss://{{host}}/socket"}
      />
    </div>
    <Button
      onclick={toggle}
      size="xs"
      variant={connected || pending ? "outline" : "default"}
      class="shrink-0">{connected || pending ? "Disconnect" : "Connect"}</Button
    >
  </div>

  <div
    class="mono flex-1 overflow-y-auto rounded border border-border bg-[var(--color-bg-0)] p-2 text-xs"
  >
    {#if ws.wsMessages.length === 0}
      <div class="hint grid h-full place-items-center">
        No frames yet — connect, then send a message.
      </div>
    {:else}
      {#each ws.wsMessages as m, i (i)}
        <div
          class="group flex gap-2 py-0.5 {m.dir === 'in' && m.correlationId
            ? 'border-l-2 border-[var(--color-brand)] pl-1 opacity-90'
            : ''}"
        >
          <span class="shrink-0 text-fg-faint">{fmtTime(m.ts)}</span>
          <span
            class="shrink-0 {m.dir === 'out'
              ? m.status === 'error'
                ? 'text-red-400'
                : 'text-[var(--color-brand)]'
              : m.dir === 'in'
                ? 'text-emerald-400'
                : 'text-fg-faint'}"
            >{m.dir === "out" ? "▲" : m.dir === "in" ? "▼" : "·"}</span
          >
          {#if m.dir === "out"}
            <span
              class="shrink-0 {m.status === 'error'
                ? 'text-red-400'
                : m.status === 'sent'
                  ? 'text-fg-faint'
                  : 'text-fg-faint'}"
              title={m.status === "sent" ? "delivered" : m.status === "error" ? "send failed" : ""}
              >{m.status === "sent" ? "✓" : m.status === "error" ? "✗" : ""}</span
            >
          {/if}
          {#if m.isBinary}
            <div class="min-w-0 flex-1 max-h-32 overflow-auto rounded border border-border p-1">
              <HexViewer base64={m.data} />
            </div>
          {:else}
            <span
              class="break-all min-w-0 flex-1 whitespace-pre-wrap {m.dir === 'sys' ? 'text-fg-faint' : 'text-fg'}"
              >{m.data}</span
            >
          {/if}
          {#if m.dir === "in" && m.correlationId}
            <span
              class="shrink-0 text-fg-faint"
              title="Response to sent frame {m.correlationId}"
              >↳</span
            >
          {/if}
          {#if m.dir === "out"}
            <button
              onclick={() => replay(m.data)}
              disabled={!connected}
              title="Re-send this frame"
              class="shrink-0 invisible rounded p-0.5 text-fg-faint opacity-0 transition-opacity group-hover:visible group-hover:opacity-100 hover:text-[var(--color-brand)] disabled:pointer-events-none disabled:opacity-30"
            ><RotateCcw size={11} /></button>
          {/if}
        </div>
      {/each}
    {/if}
  </div>

  {#if !isSse}
    <div class="flex items-center gap-2">
      <input
        bind:value={draft}
        disabled={!connected}
        onkeydown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void send();
          }
        }}
        placeholder={connected ? "message… (Enter to send)" : "connect to send"}
        class="mono h-8 flex-1 rounded-md border border-border bg-[var(--color-bg-2)] px-2 text-sm text-fg outline-none focus:border-[var(--color-brand)] disabled:opacity-50"
      />
      <Button onclick={send} size="xs" disabled={!connected || !draft.trim()}>Send</Button>
    </div>
  {/if}
</div>
