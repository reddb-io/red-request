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
  } from "@reddb-io/request-core";

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
    /** Soft-wrap long lines (multiline). Wrapping drops the line-number gutter, which can't
     * stay aligned once a logical line spans several visual rows. */
    wrap?: boolean;
    /** When provided, offer GraphQL field/argument autocomplete from this introspected schema. */
    gqlSchema?: GqlSchema | null;
    /** Let multiline editor fill its parent instead of using the row-derived fixed height. */
    fill?: boolean;
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
    wrap = false,
    gqlSchema = null,
    fill = false,
  }: Props = $props();

  let el = $state<HTMLInputElement | HTMLTextAreaElement | undefined>();
  let backdrop = $state<HTMLDivElement | undefined>();
  let gutter = $state<HTMLDivElement | undefined>();

  // Code-editor gutter (multiline + lineNumbers): line metrics measured from the textarea
  // so the numbers + current-line band line up exactly, whatever the density.
  // Wrapping and the line-number gutter are mutually exclusive: numbers can't track a logical
  // line once it spills onto several visual rows, so enabling wrap falls back to the plain
  // multiline layout (which already soft-wraps).
  const gutterMode = $derived(multiline && lineNumbers && !wrap);
  let caretLine = $state(0);
  let scrollTop = $state(0);
  let lineH = $state(17.5);
  let padTop = $state(6);
  const editorHeight = $derived(Math.ceil(rows * lineH + padTop * 2));
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
  let menuStyle = $state("");
  // "var" inserts {{name}} for a {{ … }} token; "gql" replaces the partial identifier under the
  // cursor with a schema-sourced GraphQL field/argument name.
  let menuMode = $state<"var" | "gql">("var");
  let wordStart = $state(-1);
  const MENU_MARGIN = 12;
  const MENU_MIN_WIDTH = 576;
  const MENU_MAX_HEIGHT = 288;

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

  function positionMenu() {
    if (!el || typeof window === "undefined") return;
    const r = el.getBoundingClientRect();
    const width = Math.max(
      280,
      Math.min(Math.max(MENU_MIN_WIDTH, r.width), window.innerWidth - MENU_MARGIN * 2)
    );
    const left = Math.min(
      Math.max(MENU_MARGIN, r.left),
      Math.max(MENU_MARGIN, window.innerWidth - MENU_MARGIN - width)
    );
    const below = window.innerHeight - r.bottom - MENU_MARGIN;
    const above = r.top - MENU_MARGIN;
    const openAbove = below < 180 && above > below;
    const maxHeight = Math.max(
      160,
      Math.min(MENU_MAX_HEIGHT, openAbove ? above : below)
    );
    const top = openAbove
      ? Math.max(MENU_MARGIN, r.top - maxHeight - 4)
      : Math.min(r.bottom + 4, window.innerHeight - MENU_MARGIN - maxHeight);
    menuStyle = `left:${Math.round(left)}px;top:${Math.round(top)}px;width:${Math.round(
      width
    )}px;max-height:${Math.round(maxHeight)}px`;
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
      if (showMenu) void tick().then(positionMenu);
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
      if (showMenu) void tick().then(positionMenu);
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

  const MENU_NAV_KEYS = ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"];

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

  // Refresh the menu as the caret moves on keyup — but NOT for the menu-navigation
  // keys, whose keydown already moved the selection. Refreshing on those rebuilt the
  // list and reset menuIndex to 0, which made ArrowDown snap back to the first item.
  function onKeyup(e: KeyboardEvent) {
    if (showMenu && MENU_NAV_KEYS.includes(e.key)) return;
    refreshMenu();
  }

  // Keep the highlighted item visible while navigating with the keyboard.
  let menuEl = $state<HTMLUListElement | undefined>();
  $effect(() => {
    if (!showMenu || !menuEl) return;
    const active = menuEl.children[menuIndex] as HTMLElement | undefined;
    if (typeof active?.scrollIntoView === "function")
      active.scrollIntoView({ block: "nearest" });
  });

  const pad = $derived(dense ? "px-2" : "px-2.5");
  const metrics = $derived(
    multiline ? "py-1.5 leading-5" : dense ? "h-6 leading-6" : "h-7 leading-7"
  );
  const wrapCls = $derived(
    gutterMode
      ? "whitespace-pre"
      : multiline
        ? "whitespace-pre-wrap break-words"
        : "whitespace-pre"
  );
  const shared = $derived(`mono ${pad} ${metrics} ${wrapCls} text-sm`);
  const frame = $derived(
    flush
      ? "bg-transparent"
      : "rounded-md border border-border bg-[var(--color-bg-2)] transition focus-within:border-[var(--color-brand)] focus-within:ring-1 focus-within:ring-[var(--color-brand)]"
  );
</script>

<svelte:window
  onresize={() => {
    if (showMenu) positionMenu();
  }}
/>

{#snippet backdropLayer()}
  <div
    bind:this={backdrop}
    data-slot="var-field-backdrop"
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
      data-slot="var-field-textarea"
      bind:value
      {placeholder}
      {rows}
      aria-label={ariaLabel}
      spellcheck="false"
      class="{shared} relative w-full {gutterMode
        ? 'h-full overflow-auto'
        : ''} resize-none bg-transparent text-transparent caret-[var(--color-brand)] outline-none placeholder:text-fg-faint"
      oninput={refreshMenu}
      onkeyup={onKeyup}
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
      data-slot="var-field-input"
      bind:value
      {placeholder}
      aria-label={ariaLabel}
      spellcheck="false"
      class="{shared} relative w-full bg-transparent text-transparent caret-[var(--color-brand)] outline-none placeholder:text-fg-faint"
      oninput={refreshMenu}
      onkeyup={onKeyup}
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
      bind:this={menuEl}
      data-slot="var-field-menu"
      style={menuStyle}
      class="panel fixed z-[80] overflow-y-auto py-1 shadow-xl"
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
            <span class="min-w-[12rem] flex-1 truncate">{item.label}</span>
            {#if item.kind === "gql" && item.gql.type}
              <span class="ml-3 max-w-[50%] shrink truncate text-xs text-[var(--color-brand)]">{item.gql.type}</span>
            {:else if item.kind !== "gql" && item.desc}
              <span class="ml-3 max-w-[50%] shrink truncate text-xs text-fg-faint">{item.desc}</span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
{/snippet}

<div
  data-slot="var-field"
  class="relative min-w-0 {frame} {gutterMode ? 'flex' : ''} {fill ? 'min-h-0 flex-1' : ''}"
  style={gutterMode && !fill ? `height:${editorHeight}px` : ""}
>
  {#if gutterMode}
    <div
      bind:this={gutter}
      data-slot="var-field-gutter"
      aria-hidden="true"
      class="mono shrink-0 overflow-hidden border-r border-border px-2 text-right text-xs text-fg-faint select-none"
      style="height:{fill ? '100%' : `${editorHeight}px`}; padding-top:{padTop}px; padding-bottom:{padTop}px"
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
    <div data-slot="var-field-editor-pane" class="relative h-full min-w-0 flex-1 overflow-hidden">
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
