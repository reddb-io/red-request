<script lang="ts">
  // A variable-aware text field. Renders {{var}} tokens highlighted (green when the name
  // is known, red when not) via a backdrop layer behind a transparent input, and offers an
  // autocomplete dropdown of known variables while you type inside {{ … }}.
  import { tick } from "svelte";

  type Props = {
    value: string;
    known?: string[];
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

  type Seg = { text: string; kind: "plain" | "ok" | "bad" };
  const segments = $derived.by<Seg[]>(() => {
    const v = value ?? "";
    const out: Seg[] = [];
    const re = /\{\{\s*([^{}]*?)\s*\}\}/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(v))) {
      if (m.index > last) out.push({ text: v.slice(last, m.index), kind: "plain" });
      out.push({ text: m[0], kind: knownSet.has(m[1]!) ? "ok" : "bad" });
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

  const pad = $derived(dense ? "px-2" : "px-3");
  const metrics = $derived(
    multiline ? "py-1.5 leading-5" : dense ? "h-7 leading-7" : "h-8 leading-8"
  );
  const wrap = $derived(
    multiline ? "whitespace-pre-wrap break-words" : "whitespace-pre"
  );
  const shared = $derived(`mono ${pad} ${metrics} ${wrap} text-sm`);
  const frame = $derived(
    flush
      ? "bg-transparent"
      : "rounded-md border border-[var(--color-bg-3)] bg-[var(--color-bg-2)] transition focus-within:border-[var(--color-accent)] focus-within:ring-1 focus-within:ring-[var(--color-accent)]"
  );
</script>

<div class="relative {frame}">
  <div
    bind:this={backdrop}
    aria-hidden="true"
    class="{shared} pointer-events-none absolute inset-0 overflow-hidden text-zinc-200"
  >{#each segments as s, i (i)}{#if s.kind === "plain"}<span>{s.text}</span
        >{:else}<span
          class="rounded-sm {s.kind === 'ok'
            ? 'bg-emerald-500/15 text-emerald-300'
            : 'bg-red-500/15 text-red-300'}">{s.text}</span
        >{/if}{/each}</div>

  {#if multiline}
    <textarea
      bind:this={el}
      bind:value
      {placeholder}
      {rows}
      aria-label={ariaLabel}
      spellcheck="false"
      class="{shared} relative w-full resize-none bg-transparent text-transparent caret-[var(--color-accent)] outline-none placeholder:text-zinc-600"
      oninput={refreshMenu}
      onkeyup={refreshMenu}
      onclick={refreshMenu}
      onkeydown={onKeydown}
      onscroll={syncScroll}
      onblur={() => (showMenu = false)}
    ></textarea>
  {:else}
    <input
      bind:this={el}
      bind:value
      {placeholder}
      aria-label={ariaLabel}
      spellcheck="false"
      class="{shared} relative w-full bg-transparent text-transparent caret-[var(--color-accent)] outline-none placeholder:text-zinc-600"
      oninput={refreshMenu}
      onkeyup={refreshMenu}
      onclick={refreshMenu}
      onkeydown={onKeydown}
      onscroll={syncScroll}
      onblur={() => (showMenu = false)}
    />
  {/if}

  {#if showMenu}
    <ul
      class="absolute top-full left-1 z-50 mt-1 max-h-48 w-52 overflow-auto rounded-md border border-[var(--color-bg-3)] bg-[var(--color-bg-1)] py-1 shadow-xl"
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
              ? 'bg-[var(--color-bg-2)] text-zinc-100'
              : 'text-zinc-400'} hover:bg-[var(--color-bg-2)]"
          >
            <span class="text-[10px] text-emerald-400">⬩</span>
            <span class="truncate">{item}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>
