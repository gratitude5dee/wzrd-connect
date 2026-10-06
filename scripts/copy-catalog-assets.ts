import type { ProviderDefinition } from "../src/core/types.ts";

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCatalogStore, resolveExecutableActionIds } from "../src/catalog-store.ts";

export const defaultCatalogChunkBytes = 4 * 1024 * 1024;

export interface CopyCatalogAssetsOptions {
  sourceDir: string;
  targetDir: string;
  maxChunkBytes?: number;
}

export interface CatalogAssetIndex {
  version: 1;
  providerCount: number;
  chunks: string[];
}

/** Copy generated provider definitions into deterministic, size-bounded static asset chunks. */
export async function copyCatalogAssets(options: CopyCatalogAssetsOptions): Promise<CatalogAssetIndex> {
  const maxChunkBytes = options.maxChunkBytes ?? defaultCatalogChunkBytes;
  if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 4) {
    throw new Error("Catalog chunk size must be a safe integer of at least 4 bytes");
  }

  const entries = (await readdir(options.sourceDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const providers = await Promise.all(
    entries.map(async (entry) => {
      const content = await readFile(join(options.sourceDir, entry.name), "utf8");
      try {
        return {
          filename: entry.name,
          json: JSON.stringify(JSON.parse(content) as unknown),
        };
      } catch (cause) {
        throw new Error(`Failed to parse catalog provider file: ${entry.name}`, { cause });
      }
    }),
  );
  const chunks = createChunks(providers, maxChunkBytes);

  await rm(options.targetDir, { recursive: true, force: true });
  await mkdir(options.targetDir, { recursive: true });

  const chunkNames = chunks.map((_, index) => `apps-${index.toString().padStart(4, "0")}.json`);
  const index: CatalogAssetIndex = {
    version: 1,
    providerCount: providers.length,
    chunks: chunkNames,
  };

  await Promise.all([
    writeFile(join(options.targetDir, "index.json"), `${JSON.stringify(index)}\n`),
    ...chunks.map((chunk, index) => writeFile(join(options.targetDir, chunkNames[index]!), chunk)),
  ]);

  return index;
}

export const actionsChunkBytes = 4 * 1024 * 1024;
export const actionsIndexFileName = "actions-index.json";

export interface WriteActionsAssetOptions {
  sourceDir: string;
  targetDir: string;
  /**
   * Services with local executor modules in the worker bundle
   * (`registry.cloudflare.generated.ts` keys) — the `execution` flags the
   * worker would compute.
   */
  executableServices: Iterable<string>;
}

export interface ActionsAssetIndex {
  version: 1;
  /** ETag `/api/actions` answers with, covering the whole serialized list. */
  etag: string;
  bytes: number;
  chunks: string[];
}

/**
 * Emit the prebuilt `/api/actions` payload (~40MB) next to the provider
 * chunks — too big for the worker to serialize on every request (the Worker
 * CPU-limit 503 seen on the console overview) and over the 25MiB single-asset
 * cap, so it lands as byte-slice `actions-NNNN.json` chunks plus an
 * `actions-index.json` carrying the chunk order and one ETag. Concatenating
 * the slices in order reproduces the exact serialization
 * `createCatalogStore` would emit, so the worker serves it with a memcpy
 * instead of a stringify.
 */
export async function writeActionsAsset(options: WriteActionsAssetOptions): Promise<ActionsAssetIndex> {
  const entries = (await readdir(options.sourceDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const definitions = await Promise.all(
    entries.map(async (entry) => {
      const content = await readFile(join(options.sourceDir, entry.name), "utf8");
      try {
        return JSON.parse(content) as ProviderDefinition;
      } catch (cause) {
        throw new Error(`Failed to parse catalog provider file: ${entry.name}`, { cause });
      }
    }),
  );
  const store = createCatalogStore(definitions, {
    executableActionIds: resolveExecutableActionIds(definitions, {
      executableServices: options.executableServices,
    }),
  });
  const body = Buffer.from(JSON.stringify(store.actions), "utf8");
  const etag = `"sha256-${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`;

  const chunks: string[] = [];
  for (let start = 0; start < body.length; start += actionsChunkBytes) {
    chunks.push(`actions-${chunks.length.toString().padStart(4, "0")}.json`);
    await writeFile(join(options.targetDir, chunks[chunks.length - 1]!), body.subarray(start, start + actionsChunkBytes));
  }
  const index: ActionsAssetIndex = { version: 1, etag, bytes: body.length, chunks };
  await writeFile(join(options.targetDir, actionsIndexFileName), `${JSON.stringify(index)}\n`);
  return index;
}

interface SerializedProvider {
  filename: string;
  json: string;
}

function createChunks(providers: SerializedProvider[], maxChunkBytes: number): string[] {
  const chunks: string[] = [];
  let entries: string[] = [];
  let chunkBytes = 3; // Opening and closing brackets plus the trailing newline.

  for (const provider of providers) {
    const providerBytes = Buffer.byteLength(provider.json);
    const addedBytes = providerBytes + (entries.length === 0 ? 0 : 1);
    if (providerBytes + 3 > maxChunkBytes) {
      throw new Error(
        `Catalog provider ${provider.filename} requires ${providerBytes + 3} bytes, exceeding the ${maxChunkBytes}-byte chunk limit`,
      );
    }

    if (entries.length > 0 && chunkBytes + addedBytes > maxChunkBytes) {
      chunks.push(`[${entries.join(",")}]\n`);
      entries = [];
      chunkBytes = 3;
    }

    chunkBytes += providerBytes + (entries.length === 0 ? 0 : 1);
    entries.push(provider.json);
  }

  if (entries.length > 0) {
    chunks.push(`[${entries.join(",")}]\n`);
  }

  return chunks;
}

if (import.meta.main) {
  const sourceDir = join(process.cwd(), "catalog/apps");
  const targetDir = join(process.cwd(), "dist/web/catalog");
  // The registry is written by `npm run generate:catalog`, which must run
  // first — its service keys are exactly the executables the worker reports.
  const { executorModules } = await import("../src/providers/registry.cloudflare.generated.ts");
  const index = await copyCatalogAssets({ sourceDir, targetDir });
  const actions = await writeActionsAsset({
    sourceDir,
    targetDir,
    executableServices: Object.keys(executorModules),
  });
  console.log(
    `Copied ${index.providerCount} catalog apps into ${index.chunks.length} static asset chunks ` +
      `and wrote the actions payload (${actions.bytes} bytes in ${actions.chunks.length} chunks).`,
  );
}
