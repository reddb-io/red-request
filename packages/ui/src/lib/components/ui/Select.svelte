<script lang="ts" generics="T extends string = string">
  // Design-system Select: bits-ui's accessible single-select primitive, styled with our
  // tokens. Near drop-in for a native <select>: `<Select bind:value items={[...]} />`.
  // items accepts string[] or { value, label?, class? }[]. Generic over the value type so
  // it binds type-safely to enum fields (kind, method, recordType, …).
  import { Select } from "bits-ui";

  type Item = { value: T; label?: string; class?: string };

  let {
    value = $bindable(),
    items,
    placeholder = "Select…",
    class: cls = "",
    ariaLabel = undefined,
    bare = false,
    onChange = undefined,
  }: {
    value?: T;
    items: readonly (Item | T)[];
    placeholder?: string;
    class?: string;
    ariaLabel?: string;
    /** Borderless/transparent trigger (e.g. the method picker inside the URL bar). */
    bare?: boolean;
    /** Called on selection — use instead of bind:value when the change has a side effect. */
    onChange?: (value: T) => void;
  } = $props();

  const norm = $derived(
    items.map((i) =>
      typeof i === "string"
        ? { value: i, label: i, class: undefined }
        : { value: i.value, label: i.label ?? i.value, class: i.class }
    )
  );
  const current = $derived(norm.find((i) => i.value === value));
</script>

<Select.Root
  type="single"
  bind:value
  items={norm}
  onValueChange={onChange ? (v) => onChange(v as T) : undefined}
>
  <Select.Trigger
    class="{bare ? '' : 'select'} inline-flex items-center text-left {cls}"
    aria-label={ariaLabel}
  >
    <span class="truncate {current?.class ?? ''}"
      >{current?.label ?? placeholder}</span
    >
  </Select.Trigger>
  <Select.Portal>
    <Select.Content
      sideOffset={4}
      class="panel z-50 max-h-64 min-w-[var(--bits-select-anchor-width)] overflow-auto p-1 shadow-xl"
    >
      <Select.Viewport>
        {#each norm as item (item.value)}
          <Select.Item
            value={item.value}
            label={item.label}
            class="flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1 text-sm text-fg-muted outline-none select-none data-[highlighted]:bg-[var(--color-bg-2)] data-[highlighted]:text-fg {item.class ??
              ''}"
          >
            {#snippet children({ selected })}
              <span class="truncate">{item.label}</span>
              {#if selected}<span class="text-[var(--color-brand)]">✓</span>{/if}
            {/snippet}
          </Select.Item>
        {/each}
      </Select.Viewport>
    </Select.Content>
  </Select.Portal>
</Select.Root>
