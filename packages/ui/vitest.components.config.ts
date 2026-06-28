import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";

// Component-render tests: the svelte plugin compiles .svelte files; tests mock the
// store/repo modules so a single component renders in isolation. File suffix
// `*.svelte.test.ts` keeps these separate from the plain-logic config.
export default defineConfig({
  plugins: [svelte()],
  resolve: {
    conditions: ["browser"],
    alias: [
      {
        find: "$lib",
        replacement: fileURLToPath(new URL("./src/lib", import.meta.url)),
      },
      {
        find: /^@reddb-io\/request-core$/,
        replacement: fileURLToPath(
          new URL("../core/src/index.ts", import.meta.url)
        ),
      },
      {
        find: /^@reddb-io\/request-core\/(.+)$/,
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
    include: ["src/**/*.svelte.{test,spec}.ts"],
  },
});
