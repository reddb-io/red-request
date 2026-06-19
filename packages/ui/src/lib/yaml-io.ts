// YAML export/import — the git-friendly artifact layer over the RedDB store.
//
// Export writes a plain-text tree (one request per file) under `<collections>/_exports`;
// secret VALUES are never written (only their names, via environmentToFile). Import reads
// that tree back into RedDB. This keeps the Bruno-style git workflow while RedDB stays the
// live store.
import { parse, stringify } from "yaml";
import {
  collectionFileSchema,
  requestDefinitionSchema,
  environmentFileSchema,
  storedEnvironmentSchema,
  environmentToFile,
  type LoadedCollection,
} from "@red-requester/core";
import * as fs from "./fs";
import * as repo from "./repo";

const EXPORTS = "_exports";
const join = (...p: string[]) => p.join("/");

/** Write every collection to `<collections_root>/_exports/`. Returns that folder path. */
export async function exportAll(
  collections: LoadedCollection[]
): Promise<string> {
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
    for (const env of col.environments) {
      await fs.mkdirp(join(dir, "environments"));
      // environmentToFile strips secret values, keeping only names.
      await fs.writeText(
        join(dir, "environments", `${repo.slugify(env.name)}.yaml`),
        stringify(environmentToFile(env))
      );
    }
  }
  return outRoot;
}

/** Read the `_exports` tree back into RedDB. Secrets come in empty (values aren't in YAML). */
export async function importAll(): Promise<number> {
  const root = await fs.collectionsRoot();
  const outRoot = join(root, EXPORTS);
  let imported = 0;
  for (const colDir of await fs.listDir(outRoot)) {
    if (!colDir.is_dir) continue;
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
      // Re-hydrate as a stored env with empty secrets (values must be re-entered).
      await repo.saveEnvironment(
        colId,
        storedEnvironmentSchema.parse({
          name: file.name,
          vars: file.vars,
          secrets: {},
        })
      );
    }
    imported++;
  }
  return imported;
}
