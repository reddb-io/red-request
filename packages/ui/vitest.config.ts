import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// UI unit/logic tests. jsdom gives mockIPC a `window` to patch; no SvelteKit
// plugin (that pulls SSR/router machinery). Component-render tests live under a
// separate config (vitest.components.config.ts) that adds the svelte plugin.
export default defineConfig({
  resolve: {
    alias: [
      {
        find: "$lib",
        replacement: fileURLToPath(new URL("./src/lib", import.meta.url)),
      },
      {
        find: /^@red-request\/core$/,
        replacement: fileURLToPath(
          new URL("../core/src/index.ts", import.meta.url)
        ),
      },
      {
        find: /^@red-request\/core\/(.+)$/,
        replacement: fileURLToPath(
          new URL("../core/src/$1.ts", import.meta.url)
        ),
      },
    ],
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.{test,spec}.ts"],
    exclude: ["src/**/*.svelte.{test,spec}.ts", "node_modules/**"],
  },
});
