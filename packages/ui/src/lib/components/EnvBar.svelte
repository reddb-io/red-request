<script lang="ts">
  import { ws } from "../store.svelte";
  import EnvironmentsEditor from "./EnvironmentsEditor.svelte";
  import Select from "./ui/Select.svelte";

  // Sentinel value for the last selector option that opens the editor instead of
  // selecting an environment.
  const MANAGE = "__manage_envs__";
  let showEditor = $state(false);
</script>

<div class="flex items-center gap-2">
  <!-- One selector: pick an env, or the last option opens the editor. -->
  <Select
    value={ws.activeEnvName ?? ""}
    items={[
      ...ws.environments.map((e) => ({ value: e.name, label: e.name })),
      { value: MANAGE, label: "⚙ Manage environments…" },
    ]}
    placeholder="no env"
    onChange={(v) => {
      if (v === MANAGE) {
        showEditor = true;
        return;
      }
      ws.activeEnvName = v || null;
    }}
    ariaLabel="environment"
    class="w-auto"
  />
</div>

{#if showEditor}
  <EnvironmentsEditor onClose={() => (showEditor = false)} />
{/if}
