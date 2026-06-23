// YAML export/import — the git-friendly artifact layer over the RedDB store.
//
// Export writes a plain-text tree (one request per file) under `<collections>/_exports`;
// secret VALUES are never written (only their names, via environmentToFile). Import reads
// that tree back into RedDB. This keeps the Bruno-style git workflow while RedDB stays the
// live store.
import {
  collectionFileSchema,
  requestDefinitionSchema,
  environmentFileSchema,
  storedEnvironmentSchema,
  environmentToFile,
  type LoadedCollection,
  type StoredEnvironment,
} from "@red-request/core";
import * as fs from "./fs";
import * as repo from "./repo";

const EXPORTS = "_exports";
// Project-level environments + globals live in a reserved sibling of the collections
// (the `_` prefix keeps it out of the per-collection import loop).
const PROJECT = "_project";
const join = (...p: string[]) => p.join("/");

/** Write every collection plus the project-level environments (incl. the reserved
 *  "Globals" base env) to `<collections_root>/_exports/`. Returns that folder path.
 *  Secret values are never written — only their names (via environmentToFile). */
export async function exportAll(
  collections: LoadedCollection[],
  environments: StoredEnvironment[] = []
): Promise<string> {
  const { stringify } = await import("yaml");
  const root = await fs.collectionsRoot();
  const outRoot = join(root, EXPORTS);
  for (const col of collections) {
    const dir = join(outRoot, col.id);
    await fs.mkdirp(dir);
    await fs.writeText(join(dir, "collection.yaml"), stringify(col.collection));
    for (const req of col.requests) {
      await fs.mkdirp(join(dir, "requests"));
      await fs.writeText(
        join(dir, "requests", `${req.id}.yaml`),
        stringify(req)
      );
    }
  }
  const projDir = join(outRoot, PROJECT);
  await fs.mkdirp(join(projDir, "environments"));
  for (const env of environments) {
    await fs.writeText(
      join(projDir, "environments", `${repo.slugify(env.name)}.yaml`),
      stringify(environmentToFile(env))
    );
  }
  return outRoot;
}

/** Read the `_exports` tree back into RedDB. Secrets come in empty (values aren't in YAML). */
export async function importAll(): Promise<number> {
  const { parse } = await import("yaml");
  const root = await fs.collectionsRoot();
  const outRoot = join(root, EXPORTS);
  let imported = 0;
  for (const colDir of await fs.listDir(outRoot)) {
    if (!colDir.is_dir || colDir.name === PROJECT) continue;
    const colId = colDir.name;
    const entries = await fs.listDir(colDir.path);
    const collFile = entries.find((e) => e.name === "collection.yaml");
    if (!collFile) continue;
    const collection = collectionFileSchema.parse(
      parse(await fs.readText(collFile.path))
    );
    await repo.saveCollectionMeta(colId, collection);

    for (const e of await fs.listDir(join(colDir.path, "requests"))) {
      if (!e.name.endsWith(".yaml")) continue;
      const req = requestDefinitionSchema.parse(
        parse(await fs.readText(e.path))
      );
      await repo.saveRequest(colId, req);
    }
    for (const e of await fs.listDir(join(colDir.path, "environments"))) {
      if (!e.name.endsWith(".yaml")) continue;
      const file = environmentFileSchema.parse(
        parse(await fs.readText(e.path))
      );
      // Re-hydrate as a project-level stored env with empty secrets (re-enter values).
      await repo.saveEnvironment(
        storedEnvironmentSchema.parse({
          name: file.name,
          vars: file.vars,
          secrets: {},
        })
      );
    }
    imported++;
  }

  // Project-level environments (incl. the "Globals" base env) under `_project`.
  const projDir = join(outRoot, PROJECT);
  for (const e of await fs
    .listDir(join(projDir, "environments"))
    .catch(() => [])) {
    if (!e.name.endsWith(".yaml")) continue;
    const file = environmentFileSchema.parse(parse(await fs.readText(e.path)));
    // Re-hydrate with empty secrets (values aren't in YAML — re-enter them).
    await repo.saveEnvironment(
      storedEnvironmentSchema.parse({
        name: file.name,
        vars: file.vars,
        secrets: {},
      })
    );
  }
  return imported;
}
