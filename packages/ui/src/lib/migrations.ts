// App-shipped RedDB migrations, applied (in dependency order) on every project boot
// via `runMigrations()` → `APPLY MIGRATION *`. RedDB tracks applied state in its
// `red_migrations` system collection, so each runs exactly once per store and the
// boot call is a no-op once everything is applied.
//
// To add one: append a `{ name, sql }` entry. `sql` is the body after `AS`.
// Declare `dependsOn` explicitly whenever a migration must run after another one;
// do not rely on RedDB's inference as an app-level contract. Names must be unique
// and stable — never rename an already-shipped migration (its applied state is keyed
// by name).
//
//   { name: "add_request_tags",
//     sql: "ALTER TABLE rr_requests ADD COLUMN tags TEXT" }
//
// Migration names are RedDB identifiers: start with a letter/underscore, then
// letters/digits/underscores. Use stable, descriptive names; ordering belongs in
// dependencies, not in name prefixes.
import type { MigrationDef } from "./reddb";

export const MIGRATIONS: MigrationDef[] = [
  {
    name: "request_document_search_indexes",
    sql: `
      CREATE INDEX IF NOT EXISTS rr_requests_app_key ON rr_requests (app_key) USING HASH;
      CREATE INDEX IF NOT EXISTS rr_requests_collection_id ON rr_requests (collection_id) USING HASH;
      CREATE INDEX IF NOT EXISTS rr_requests_kind ON rr_requests (request_kind) USING BITMAP;
      CREATE INDEX IF NOT EXISTS rr_requests_name ON rr_requests (request_name)
    `,
  },
  {
    name: "run_history_document_indexes",
    sql: `
      CREATE INDEX IF NOT EXISTS rr_history_app_key ON rr_history (app_key) USING HASH;
      CREATE INDEX IF NOT EXISTS rr_history_collection_id ON rr_history (collection_id) USING HASH;
      CREATE INDEX IF NOT EXISTS rr_history_request_id ON rr_history (request_id) USING HASH;
      CREATE INDEX IF NOT EXISTS rr_history_run_ts ON rr_history (run_ts)
    `,
  },
];
