<script lang="ts">
  // A variable-aware text field. Renders {{var}} tokens highlighted (green when the name
  // is known, red when not) via a backdrop layer behind a transparent input, and offers an
  // autocomplete dropdown of known variables while you type inside {{ … }}.
  import { tick } from "svelte";

  type Props = {
    value: string;
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
  }: Props = $props();

  let el = $state<HTMLInputElement | HTMLTextAreaElement | undefined>();
  let backdrop = $state<HTMLDivElement | undefined>();

  let showMenu = $state(false);
  let menuItems = $state<string[]>([]);
  let menuIndex = $state(0);
  let tokenStart = $state(-1);

  const knownSet = $derived(new Set(known));
  const pathSet = $derived(new Set(pathNames ?? []));
  const enablePath = $derived(pathNames !== undefined);

  type Seg = {
    text: string;
    kind: "plain" | "ok" | "bad";
    token?: "var" | "path";
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
        const ok = knownSet.has(name);
        out.push({
          text: m[1],
          kind: ok ? "ok" : "bad",
          token: "var",
          title: ok ? (values[name] ?? "") : "undefined variable",
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
    if (!backdrop || !el) return;
    backdrop.scrollLeft = el.scrollLeft;
    backdrop.scrollTop = el.scrollTop;
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
    const caret = el.selectionStart ?? (value ?? "").length;
    const before = (value ?? "").slice(0, caret);
    const open = before.lastIndexOf("{{");
    if (open === -1 || before.indexOf("}}", open) !== -1) {
      showMenu = false;
      return;
    }
    const q = before
      .slice(open + 2)
      .trim()
      .toLowerCase();
    tokenStart = open;
    menuItems = known.filter((n) => n.toLowerCase().includes(q)).slice(0, 8);
    menuIndex = 0;
    showMenu = menuItems.length > 0;
  }

  async function accept(name: string) {
    if (!el) return;
    const caret = el.selectionStart ?? (value ?? "").length;
    const rest = (value ?? "").slice(caret);
    const tail = rest.startsWith("}}") ? rest.slice(2) : rest;
    value = (value ?? "").slice(0, tokenStart) + "{{" + name + "}}" + tail;
    showMenu = false;
    const pos = tokenStart + 2 + name.length + 2;
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
    multiline ? "whitespace-pre-wrap break-words" : "whitespace-pre"
  );
  const shared = $derived(`mono ${pad} ${metrics} ${wrap} text-sm`);
  const frame = $derived(
    flush
      ? "bg-transparent"
      : "rounded-md border border-border bg-[var(--color-bg-2)] transition focus-within:border-[var(--color-accent)] focus-within:ring-1 focus-within:ring-[var(--color-accent)]"
  );
</script>

<div class="relative {frame}">
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

  {#if tip}
    <div
      class="pointer-events-none fixed z-[60] max-w-xs truncate rounded border border-border bg-[var(--color-bg-0)] px-2 py-1 text-xs text-fg shadow-xl"
      style="left: {tip.x}px; top: {tip.y}px"
    >
      {tip.text}
    </div>
  {/if}

  {#if multiline}
    <textarea
      bind:this={el}
      bind:value
      {placeholder}
      {rows}
      aria-label={ariaLabel}
      spellcheck="false"
      class="{shared} relative w-full resize-none bg-transparent text-transparent caret-[var(--color-accent)] outline-none placeholder:text-fg-faint"
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
      class="{shared} relative w-full bg-transparent text-transparent caret-[var(--color-accent)] outline-none placeholder:text-fg-faint"
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

  {#if showMenu}
    <ul
      class="panel absolute top-full left-1 z-50 mt-1 max-h-48 w-52 overflow-auto py-1 shadow-xl"
    >
      {#each menuItems as item, i (item)}
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
            <span class="text-xs text-emerald-400">⬩</span>
            <span class="truncate">{item}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>
