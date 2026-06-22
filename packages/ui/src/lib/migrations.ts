// App-shipped RedDB migrations, applied (in dependency order) on every project boot
// via `runMigrations()` → `APPLY MIGRATION *`. RedDB tracks applied state in its
// `red_migrations` system collection, so each runs exactly once per store and the
// boot call is a no-op once everything is applied.
//
// To add one: append a `{ name, sql }` entry (optionally `dependsOn`). `sql` is the
// body after `AS`. RedDB auto-infers dependencies from the SQL when unambiguous;
// declare `dependsOn` when it isn't. Names must be unique and stable — never rename
// or reorder an already-shipped migration (its applied state is keyed by name).
//
//   { name: "0001_add_request_tags",
//     sql: "ALTER TABLE rr_requests ADD COLUMN tags TEXT" }
import type { MigrationDef } from "./reddb";

export const MIGRATIONS: MigrationDef[] = [
  // No migrations yet — the runner is wired and will apply any added here on boot.
];
