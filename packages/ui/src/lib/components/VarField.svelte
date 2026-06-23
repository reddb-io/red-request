<script lang="ts">
  // A variable-aware text field. Renders {{var}} tokens highlighted (green when the name
  // is known, red when not) via a backdrop layer behind a transparent input, and offers an
  // autocomplete dropdown of known variables while you type inside {{ … }}.
  import { tick } from "svelte";
  import {
    TEMPLATE_FUNCTION_CATALOG,
    suggestGraphQL,
    type GqlSchema,
    type GqlSuggestion,
    type TemplateFunctionCatalogEntry,
  } from "@red-request/core";

  type Props = {
    // optional so callers can bind an optional field (e.g. graphql variables); "" when unset.
    value?: string;
    known?: string[];
    /** name → hover tooltip text for {{vars}}. */
    values?: Record<string, string>;
    /** when provided, also highlight `:name` path params against this list. */
    pathNames?: string[];
    /** name → hover tooltip text for path params. */
    pathValues?: Record<string, string>;
    placeholder?: string;
    multiline?: boolean;
    rows?: number;
    dense?: boolean;
    flush?: boolean;
    ariaLabel?: string;
    /** Code-editor mode (multiline only): line-number gutter + current-line highlight, no wrap. */
    lineNumbers?: boolean;
    /** When provided, offer GraphQL field/argument autocomplete from this introspected schema. */
    gqlSchema?: GqlSchema | null;
  };
  let {
    value = $bindable(""),
    known = [],
    values = {},
    pathNames = undefined,
    pathValues = {},
    placeholder = "",
    multiline = false,
    rows = 6,
    dense = false,
    flush = false,
    ariaLabel = "",
    lineNumbers = false,
    gqlSchema = null,
  }: Props = $props();

  let el = $state<HTMLInputElement | HTMLTextAreaElement | undefined>();
  let backdrop = $state<HTMLDivElement | undefined>();
  let gutter = $state<HTMLDivElement | undefined>();

  // Code-editor gutter (multiline + lineNumbers): line metrics measured from the textarea
  // so the numbers + current-line band line up exactly, whatever the density.
  const gutterMode = $derived(multiline && lineNumbers);
  let caretLine = $state(0);
  let scrollTop = $state(0);
  let lineH = $state(17.5);
  let padTop = $state(6);
  function countLines(text: string): number {
    let count = 1;
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
      count++;
    }
    return count;
  }
  function lineAtOffset(text: string, offset: number): number {
    let line = 0;
    for (
      let i = text.indexOf("\n");
      i !== -1 && i < offset;
      i = text.indexOf("\n", i + 1)
    ) {
      line++;
    }
    return line;
  }
  const lineCount = $derived(countLines(value ?? ""));
  const lines = $derived(Array.from({ length: lineCount }, (_, i) => i));
  function updateCaret() {
    if (!el) return;
    const pos = el.selectionStart ?? 0;
    caretLine = lineAtOffset(value ?? "", pos);
  }
  $effect(() => {
    if (!gutterMode || !el) return;
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight);
    const pt = parseFloat(cs.paddingTop);
    if (!Number.isNaN(lh)) lineH = lh;
    if (!Number.isNaN(pt)) padTop = pt;
  });

  let showMenu = $state(false);
  type MenuItem =
    | { kind: "var"; label: string; insertText: string; desc?: string }
    | {
        kind: "fn";
        label: string;
        insertText: string;
        desc: string;
        args: readonly string[];
      }
    | { kind: "gql"; label: string; insertText: string; gql: GqlSuggestion };

  let menuItems = $state<MenuItem[]>([]);
  let menuIndex = $state(0);
  let tokenStart = $state(-1);
  // "var" inserts {{name}} for a {{ … }} token; "gql" replaces the partial identifier under the
  // cursor with a schema-sourced GraphQL field/argument name.
  let menuMode = $state<"var" | "gql">("var");
  let wordStart = $state(-1);

  const knownSet = $derived(new Set(known));
  const functionCatalog = TEMPLATE_FUNCTION_CATALOG;
  const functionByName = new Map(functionCatalog.map((fn) => [fn.name, fn]));
  const pathSet = $derived(new Set(pathNames ?? []));
  const enablePath = $derived(pathNames !== undefined);

  type Seg = {
    text: string;
    kind: "plain" | "ok" | "bad";
    token?: "var" | "path" | "fn";
    title?: string;
  };
  const segments = $derived.by<Seg[]>(() => {
    const v = value ?? "";
    const out: Seg[] = [];
    // {{var}} (groups 1/2) or :pathParam (groups 3/4, only when enabled)
    const re = enablePath
      ? /(\{\{\s*([^{}]*?)\s*\}\})|(:([A-Za-z_]\w*))/g
      : /(\{\{\s*([^{}]*?)\s*\}\})/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(v))) {
      if (m.index > last) out.push({ text: v.slice(last, m.index), kind: "plain" });
      if (m[1] !== undefined) {
        const name = m[2]!;
        const fnName = /^([\w.$-]+)\s*\([^}]*\)$/.exec(name)?.[1];
        const fn = fnName ? functionByName.get(fnName) : undefined;
        const ok = fn ? true : knownSet.has(name);
        out.push({
          text: m[1],
          kind: ok ? "ok" : "bad",
          token: fn ? "fn" : "var",
          title: fn
            ? `${fn.signature} — ${fn.desc}`
            : ok
              ? (values[name] ?? "")
              : "undefined variable",
        });
      } else {
        const name = m[4]!;
        const ok = pathSet.has(name);
        out.push({
          text: m[3]!,
          kind: ok ? "ok" : "bad",
          token: "path",
          title: ok ? (pathValues[name] || "(no value)") : "undefined path param",
        });
      }
      last = m.index + m[0].length;
    }
    if (last < v.length) out.push({ text: v.slice(last), kind: "plain" });
    return out;
  });

  function syncScroll() {
    if (!el) return;
    scrollTop = el.scrollTop;
    if (backdrop) {
      backdrop.scrollLeft = el.scrollLeft;
      backdrop.scrollTop = el.scrollTop;
    }
    if (gutter) gutter.scrollTop = el.scrollTop;
  }

  // Hover tooltip: hit-test the token rects under the pointer (backdrop stays behind, so
  // the input keeps full editing/click behaviour).
  let tip = $state<{ text: string; x: number; y: number } | null>(null);
  function onMove(e: MouseEvent) {
    if (!backdrop) return;
    for (const t of backdrop.querySelectorAll<HTMLElement>("[data-token]")) {
      const r = t.getBoundingClientRect();
      if (
        e.clientX >= r.left &&
        e.clientX <= r.right &&
        e.clientY >= r.top &&
        e.clientY <= r.bottom
      ) {
        const txt = t.dataset.title ?? "";
        if (txt) {
          tip = { text: txt, x: r.left, y: r.bottom + 4 };
          return;
        }
      }
    }
    tip = null;
  }

  function refreshMenu() {
    if (!el) return;
    updateCaret();
    const caret = el.selectionStart ?? (value ?? "").length;
    const before = (value ?? "").slice(0, caret);
    const open = before.lastIndexOf("{{");
    if (open !== -1 && before.indexOf("}}", open) === -1) {
      // Inside a {{ … }} token: suggest known variables (takes priority over schema fields).
      const q = before
        .slice(open + 2)
        .trim()
        .toLowerCase();
      menuMode = "var";
      tokenStart = open;
      const variableItems: MenuItem[] = known
        .filter((n) => !n.startsWith("$") && n.toLowerCase().includes(q))
        .map((n) => ({
          kind: "var",
          label: n,
          insertText: n,
          desc: values[n],
        }));
      const functionItems: MenuItem[] = functionCatalog
        .filter((fn) => {
          const haystack = `${fn.name} ${fn.signature} ${fn.desc}`.toLowerCase();
          return haystack.includes(q);
        })
        .map((fn: TemplateFunctionCatalogEntry) => ({
          kind: "fn",
          label: fn.signature,
          insertText: `${fn.name}()`,
          desc: fn.desc,
          args: fn.args,
        }));
      menuItems = [...functionItems, ...variableItems];
      menuIndex = 0;
      showMenu = menuItems.length > 0;
      return;
    }
    if (gqlSchema) {
      // Schema-driven GraphQL field/argument autocomplete on the partial identifier.
      const suggestions = suggestGraphQL(gqlSchema, value ?? "", caret).slice(0, 8);
      const word = /([A-Za-z_]\w*)$/.exec(before)?.[1] ?? "";
      menuMode = "gql";
      wordStart = caret - word.length;
      menuItems = suggestions.map((s) => ({
        kind: "gql",
        label: s.label,
        insertText: s.label,
        gql: s,
      }));
      menuIndex = 0;
      showMenu = menuItems.length > 0;
      return;
    }
    showMenu = false;
  }

  async function accept(item: MenuItem) {
    if (!el) return;
    const caret = el.selectionStart ?? (value ?? "").length;
    let pos: number;
    if (menuMode === "gql") {
      value = (value ?? "").slice(0, wordStart) + item.insertText + (value ?? "").slice(caret);
      pos = wordStart + item.insertText.length;
    } else {
      const rest = (value ?? "").slice(caret);
      const tail = rest.startsWith("}}") ? rest.slice(2) : rest;
      value = (value ?? "").slice(0, tokenStart) + "{{" + item.insertText + "}}" + tail;
      pos =
        item.kind === "fn" && item.args.length > 0
          ? tokenStart + 2 + item.insertText.length - 1
          : tokenStart + 2 + item.insertText.length + 2;
    }
    showMenu = false;
    await tick();
    el.setSelectionRange(pos, pos);
    el.focus();
  }

  function onKeydown(e: KeyboardEvent) {
    if (!showMenu) return;
    if (e.key === "ArrowDown") {
      menuIndex = (menuIndex + 1) % menuItems.length;
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      menuIndex = (menuIndex - 1 + menuItems.length) % menuItems.length;
      e.preventDefault();
    } else if (e.key === "Enter" || e.key === "Tab") {
      accept(menuItems[menuIndex]!);
      e.preventDefault();
    } else if (e.key === "Escape") {
      showMenu = false;
      e.preventDefault();
    }
  }

  const pad = $derived(dense ? "px-2" : "px-2.5");
  const metrics = $derived(
    multiline ? "py-1.5 leading-5" : dense ? "h-6 leading-6" : "h-7 leading-7"
  );
  const wrap = $derived(
    gutterMode
      ? "whitespace-pre"
      : multiline
        ? "whitespace-pre-wrap break-words"
        : "whitespace-pre"
  );
  const shared = $derived(`mono ${pad} ${metrics} ${wrap} text-sm`);
  const frame = $derived(
    flush
      ? "bg-transparent"
      : "rounded-md border border-border bg-[var(--color-bg-2)] transition focus-within:border-[var(--color-brand)] focus-within:ring-1 focus-within:ring-[var(--color-brand)]"
  );
</script>

{#snippet backdropLayer()}
  <div
    bind:this={backdrop}
    aria-hidden="true"
    class="{shared} pointer-events-none absolute inset-0 overflow-hidden text-fg"
  >{#each segments as s, i (i)}{#if s.kind === "plain"}<span>{s.text}</span
        >{:else}<span
          data-token
          data-title={s.title}
          class="rounded-sm {s.kind === 'bad'
            ? 'bg-red-500/15 text-red-300'
            : s.token === 'path'
              ? 'bg-sky-500/15 text-sky-300'
              : 'bg-emerald-500/15 text-emerald-300'}">{s.text}</span
        >{/if}{/each}</div>
{/snippet}

{#snippet field()}
  {#if multiline}
    <textarea
      bind:this={el}
      bind:value
      {placeholder}
      {rows}
      aria-label={ariaLabel}
      spellcheck="false"
      class="{shared} relative w-full resize-none bg-transparent text-transparent caret-[var(--color-brand)] outline-none placeholder:text-fg-faint"
      oninput={refreshMenu}
      onkeyup={refreshMenu}
      onclick={refreshMenu}
      onkeydown={onKeydown}
      onscroll={syncScroll}
      onmousemove={onMove}
      onmouseleave={() => (tip = null)}
      onblur={() => {
        showMenu = false;
        tip = null;
      }}
    ></textarea>
  {:else}
    <input
      bind:this={el}
      bind:value
      {placeholder}
      aria-label={ariaLabel}
      spellcheck="false"
      class="{shared} relative w-full bg-transparent text-transparent caret-[var(--color-brand)] outline-none placeholder:text-fg-faint"
      oninput={refreshMenu}
      onkeyup={refreshMenu}
      onclick={refreshMenu}
      onkeydown={onKeydown}
      onscroll={syncScroll}
      onmousemove={onMove}
      onmouseleave={() => (tip = null)}
      onblur={() => {
        showMenu = false;
        tip = null;
      }}
    />
  {/if}
{/snippet}

{#snippet menu()}
  {#if showMenu}
    <ul
      class="panel absolute top-full left-1 z-50 mt-1 max-h-48 w-52 overflow-auto py-1 shadow-xl"
    >
      {#each menuItems as item, i (item.label)}
        <li>
          <button
            type="button"
            onmousedown={(e) => {
              e.preventDefault();
              accept(item);
            }}
            class="mono flex w-full items-center gap-2 px-2 py-1 text-left text-sm {i ===
            menuIndex
              ? 'bg-[var(--color-bg-2)] text-fg-strong'
              : 'text-fg-muted'} hover:bg-[var(--color-bg-2)]"
          >
            <span class="text-xs {item.kind === 'gql' && item.gql.kind === 'argument'
              ? 'text-sky-400'
              : item.kind === 'fn'
                ? 'text-[var(--color-brand)]'
                : 'text-emerald-400'}">{item.kind === "gql" && item.gql.kind === "argument"
                ? "›"
                : item.kind === "fn"
                  ? "ƒ"
                  : "⬩"}</span>
            <span class="min-w-0 flex-1 truncate">{item.label}</span>
            {#if item.kind === "gql" && item.gql.type}
              <span class="ml-auto truncate text-xs text-[var(--color-brand)]">{item.gql.type}</span>
            {:else if item.kind !== "gql" && item.desc}
              <span class="ml-auto truncate text-xs text-fg-faint">{item.desc}</span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
{/snippet}

<div class="relative {frame} {gutterMode ? 'flex' : ''}">
  {#if gutterMode}
    <div
      bind:this={gutter}
      aria-hidden="true"
      class="mono shrink-0 overflow-hidden border-r border-border px-2 text-right text-xs text-fg-faint select-none"
      style="padding-top:{padTop}px; padding-bottom:{padTop}px"
    >
      {#each lines as i (i)}
        <div
          style="height:{lineH}px; line-height:{lineH}px"
          class={i === caretLine ? "text-fg-muted" : ""}
        >
          {i + 1}
        </div>
      {/each}
    </div>
    <div class="relative min-w-0 flex-1 overflow-hidden">
      <div
        class="pointer-events-none absolute inset-x-0 bg-white/[0.04]"
        style="top:{padTop + caretLine * lineH - scrollTop}px; height:{lineH}px"
      ></div>
      {@render backdropLayer()}
      {@render field()}
    </div>
    {@render menu()}
  {:else}
    {@render backdropLayer()}
    {@render field()}
    {@render menu()}
  {/if}

  {#if tip}
    <div
      class="pointer-events-none fixed z-[60] max-w-xs truncate rounded border border-border bg-[var(--color-bg-0)] px-2 py-1 text-xs text-fg shadow-xl"
      style="left: {tip.x}px; top: {tip.y}px"
    >
      {tip.text}
    </div>
  {/if}
</div>
