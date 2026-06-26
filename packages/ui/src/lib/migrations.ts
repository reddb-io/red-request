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
];
