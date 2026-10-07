import type { CatalogStore, ExecutableActionOptions } from "../../catalog-store.ts";
import type { ProviderDefinition } from "../../core/types.ts";
import type { AssetsBinding } from "./cloudflare-bindings.ts";

import { createCatalogStore, resolveExecutableActionIds } from "../../catalog-store.ts";

const catalogIndexPath = "/catalog/index.json";
const chunkNamePattern = /^apps-\d{4}\.json$/;
const jsonContentTypePattern = /^application\/(?:[\w.+-]+\+)?json$/i;

interface CatalogAssetIndex {
  version: 1;
  providerCount: number;
  chunks: string[];
}

export async function loadCatalogFromAssets(
  assets: AssetsBinding,
  options: ExecutableActionOptions = {},
): Promise<CatalogStore> {
  const index = parseCatalogIndex(await readJsonAsset(assets, catalogIndexPath), catalogIndexPath);
  const chunks = await Promise.all(index.chunks.map((chunk) => requireProviderArrayAsset(assets, `/catalog/${chunk}`)));
  const providers = chunks.flat();
  if (providers.length !== index.providerCount) {
    throw new Error(
      `Cloudflare asset catalog provider count mismatch: index declares ${index.providerCount}, loaded ${providers.length}`,
    );
  }

  return createCatalog(providers, options);
}

function createCatalog(providers: ProviderDefinition[], options: ExecutableActionOptions): CatalogStore {
  return createCatalogStore(providers, {
    executableActionIds: resolveExecutableActionIds(providers, options),
  });
}

function parseCatalogIndex(value: unknown, path: string): CatalogAssetIndex {
  if (!isRecord(value)) {
    throw new Error(`Cloudflare asset catalog index must be an object: ${path}`);
  }
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "chunks,providerCount,version") {
    throw new Error("Cloudflare asset catalog index must contain only version, providerCount, and chunks");
  }
  if (value.version !== 1) {
    throw new Error(`Unsupported Cloudflare asset catalog index version: ${String(value.version)}`);
  }
  if (
    typeof value.providerCount !== "number" ||
    !Number.isSafeInteger(value.providerCount) ||
    value.providerCount < 0
  ) {
    throw new Error("Cloudflare asset catalog index providerCount must be a non-negative safe integer");
  }
  if (!Array.isArray(value.chunks) || !value.chunks.every((chunk): chunk is string => typeof chunk === "string")) {
    throw new Error("Cloudflare asset catalog index chunks must be an array of strings");
  }
  if (!value.chunks.every((chunk) => chunkNamePattern.test(chunk))) {
    throw new Error("Cloudflare asset catalog index contains an invalid chunk name");
  }
  if (new Set(value.chunks).size !== value.chunks.length) {
    throw new Error("Cloudflare asset catalog index contains duplicate chunks");
  }

  return {
    version: 1,
    providerCount: value.providerCount,
    chunks: value.chunks,
  };
}

async function requireProviderArrayAsset(assets: AssetsBinding, path: string): Promise<ProviderDefinition[]> {
  return requireProviderArray(await readJsonAsset(assets, path), path);
}

function requireProviderArray(value: unknown, path: string): ProviderDefinition[] {
  if (!Array.isArray(value)) {
    throw new Error(`Cloudflare asset catalog must be an array: ${path}`);
  }

  return value as ProviderDefinition[];
}

/**
 * Read one catalog asset as JSON.
 *
 * `not_found_handling: "single-page-application"` (see `wrangler.example.jsonc`) makes the assets
 * binding answer an unknown path with `index.html` and status 200 rather than 404, and it does so
 * for binding fetches regardless of the request's `Accept` header. A missing index or chunk is
 * therefore detected by the response content type as well as by the status, otherwise the SPA shell
 * would be parsed as catalog JSON.
 */

async function readJsonAsset(assets: AssetsBinding, path: string): Promise<unknown> {
  const response = await fetchAsset(assets, path);
  if (response.status === 404) {
    throw assetRequestError(path, "returned 404");
  }
  if (!response.ok) {
    throw assetRequestError(path, `returned ${response.status}`);
  }

  const contentType = response.headers.get("content-type");
  if (!isJsonContentType(contentType)) {
    throw assetRequestError(path, `returned content type ${contentType ?? "(none)"} instead of JSON`);
  }

  return await readResponseJson(response, path);
}

function fetchAsset(assets: AssetsBinding, path: string): Promise<Response> {
  return assets.fetch(
    new Request(new URL(path, "https://assets.local"), {
      headers: { accept: "application/json" },
    }),
  );
}

function isJsonContentType(contentType: string | null): boolean {
  return contentType !== null && jsonContentTypePattern.test(contentType.split(";", 1)[0]!.trim());
}

async function readResponseJson(response: Response, path: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(`Cloudflare asset catalog contains invalid JSON: ${path}`);
  }
}

function assetRequestError(path: string, reason: string): Error {
  return new Error(`Cloudflare asset catalog request failed: ${path} ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `/api/actions` serves a byte-identical response without touching the worker
 * CPU budget: the payload is ~40MB (25MiB is the single-asset ceiling), so
 * `copy-catalog-assets.ts` emits it as `actions-NNNN.json` byte slices plus
 * `actions-index.json` ({ etag, bytes, chunks }). Slices concat back to the
 * exact serialization — a memcpy, not a stringify. The index carries one ETag
 * for the whole body so conditional requests still 304.
 */
export async function serveActionsFromAssets(assets: AssetsBinding, request: Request): Promise<Response> {
  const indexResponse = await fetchAsset(assets, `/catalog/${actionsIndexFile}`);
  const indexContentType = indexResponse.headers.get("content-type") ?? "";
  if (!indexResponse.ok || !indexContentType.includes("json")) {
    return indexResponse;
  }
  const index = parseActionsAssetIndex(await indexResponse.json());
  const etag = index.etag;
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch && ifNoneMatch.includes(etag)) {
    return new Response(null, { status: 304, headers: { etag } });
  }
  const parts = await Promise.all(
    index.chunks.map(async (chunk) => {
      const part = await fetchAsset(assets, `/catalog/${chunk}`);
      if (!part.ok) {
        throw new Error(`Cloudflare actions asset ${chunk} returned ${part.status}`);
      }
      return part.arrayBuffer();
    }),
  );
  const body = new Uint8Array(index.bytes);
  let offset = 0;
  for (const part of parts) {
    body.set(new Uint8Array(part), offset);
    offset += part.byteLength;
  }
  return new Response(body, {
    headers: { "content-type": "application/json; charset=utf-8", etag },
  });
}

/**
 * `/api/providers` serves the ~9MB provider-summaries payload verbatim from a
 * single prebuilt asset (`provider-summaries.json`, well under the 25MiB
 * single-asset ceiling) plus `providers-index.json` carrying the ETag — same
 * cold-isolate CPU rationale as {@link serveActionsFromAssets}: emitting the
 * body at build time keeps the summary stringify out of every cold isolate.
 */
export async function serveProvidersFromAssets(assets: AssetsBinding, request: Request): Promise<Response> {
  const indexResponse = await fetchAsset(assets, `/catalog/${providersIndexFile}`);
  const indexContentType = indexResponse.headers.get("content-type") ?? "";
  if (!indexResponse.ok || !indexContentType.includes("json")) {
    return indexResponse;
  }
  const index = parseProvidersAssetIndex(await indexResponse.json());
  const etag = index.etag;
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch && ifNoneMatch.includes(etag)) {
    return new Response(null, { status: 304, headers: { etag } });
  }
  const body = await fetchAsset(assets, `/catalog/${index.file}`);
  if (!body.ok) {
    throw new Error(`Cloudflare providers asset ${index.file} returned ${body.status}`);
  }
  return new Response(await body.arrayBuffer(), {
    headers: { "content-type": "application/json; charset=utf-8", etag },
  });
}

const providersIndexFile = "providers-index.json";

interface ProvidersAssetIndex {
  version: 1;
  etag: string;
  bytes: number;
  file: string;
}

function parseProvidersAssetIndex(value: unknown): ProvidersAssetIndex {
  const record = isRecord(value) ? value : {};
  if (
    record.version !== 1 ||
    typeof record.etag !== "string" ||
    typeof record.bytes !== "number" ||
    typeof record.file !== "string"
  ) {
    throw new Error("Cloudflare providers asset index is malformed");
  }
  return { version: 1, etag: record.etag, bytes: record.bytes, file: record.file };
}

const actionsIndexFile = "actions-index.json";

interface ActionsAssetIndex {
  version: 1;
  etag: string;
  bytes: number;
  chunks: string[];
}

function parseActionsAssetIndex(value: unknown): ActionsAssetIndex {
  const record = isRecord(value) ? value : {};
  if (
    record.version !== 1 ||
    typeof record.etag !== "string" ||
    typeof record.bytes !== "number" ||
    !Array.isArray(record.chunks) ||
    !record.chunks.every((chunk): chunk is string => typeof chunk === "string")
  ) {
    throw new Error("Cloudflare actions asset index is malformed");
  }
  return { version: 1, etag: record.etag, bytes: record.bytes, chunks: record.chunks };
}
