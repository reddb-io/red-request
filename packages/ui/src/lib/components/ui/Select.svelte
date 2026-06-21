<script lang="ts" generics="T extends string = string">
  // Ergonomic wrapper over shadcn-svelte's Select (which itself wraps bits-ui):
  // `<Select bind:value items={[...]} />`. items = string[] or { value, label?, class? }[].
  // Generic over the value type so it binds type-safely to enum fields (kind, method, …).
  import * as SelectPrimitive from "./select/index.js";
  import { cn } from "$lib/utils.js";

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

<SelectPrimitive.Root
  type="single"
  bind:value
  onValueChange={onChange ? (v) => onChange(v as T) : undefined}
>
  <SelectPrimitive.Trigger
    size="sm"
    aria-label={ariaLabel}
    class={cn(
      "h-7",
      bare && "border-0 bg-transparent px-2 shadow-none hover:bg-transparent",
      cls,
      current?.class
    )}
  >
    <span class="truncate">{current?.label ?? placeholder}</span>
  </SelectPrimitive.Trigger>
  <SelectPrimitive.Content class="max-h-64 min-w-[8rem]">
    {#each norm as item (item.value)}
      <SelectPrimitive.Item value={item.value} label={item.label} class={item.class}>
        {item.label}
      </SelectPrimitive.Item>
    {/each}
  </SelectPrimitive.Content>
</SelectPrimitive.Root>
