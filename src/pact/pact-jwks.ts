import { looseArray, optionalRecord } from "../core/cast.ts";
import { readBoundedResponseBytes } from "../core/request.ts";
import { createProviderTimeout, isAbortLikeError } from "../providers/provider-runtime.ts";
import { pactEgressFetch, pactEgressMaxBytes, pactEgressRequestTimeoutMs } from "./pact-fetch.ts";

const jwksPositiveTtlMs = 5 * 60_000;
const jwksNegativeTtlMs = 60_000;

/** A Brand JWKS could not be fetched or carried no usable keys. */
export class PactJwksError extends Error {
  readonly code = "pact_provider_unavailable";
}

export interface PactJwksResolverOptions {
  /** Raw transport; tests inject a mock so no socket opens. */
  fetcher?: typeof fetch;
  /** `OOMOL_CONNECT_PACT_ALLOW_INSECURE_LOOPBACK`. */
  allowInsecureLoopback?: boolean;
}

type JwksCacheEntry = { jwks: { keys: unknown[] }; expiresAt: number } | { failedUntil: number };

/**
 * Per-jwks_uri JWKS cache shared by the delegation verifier and the receipt
 * verifier, with spec §4.5 semantics — jose's createRemoteJWKSet cannot take
 * the SSRF-guarded fetcher, so the equivalent cache sits on pactEgressFetch +
 * createLocalJWKSet: 5 min positive, 60 s negative, one refetch on a kid miss.
 */
export class PactJwksResolver {
  private readonly options: PactJwksResolverOptions;
  private readonly jwksCache = new Map<string, JwksCacheEntry>();

  constructor(options: PactJwksResolverOptions) {
    this.options = options;
  }

  async resolve(
    jwksUri: string,
    kid: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ keys: unknown[] }> {
    const now = Date.now();
    const cached = this.jwksCache.get(jwksUri);
    if (cached) {
      if ("jwks" in cached && cached.expiresAt > now) {
        const hit = kid === undefined || cached.jwks.keys.some((key) => optionalRecord(key)?.kid === kid);
        if (hit) {
          return cached.jwks;
        }
      } else if ("failedUntil" in cached && cached.failedUntil > now) {
        throw new PactJwksError("The Brand JWKS is unavailable.");
      }
    }
    const timeout = createProviderTimeout(signal, pactEgressRequestTimeoutMs);
    try {
      const response = await pactEgressFetch(
        jwksUri,
        { method: "GET", headers: { accept: "application/json" }, signal: timeout.signal },
        { fetcher: this.options.fetcher, allowInsecureLoopback: this.options.allowInsecureLoopback },
      );
      const body = response.ok ? await readJwksJson(response) : {};
      const keys = looseArray(body.keys).filter((key) => optionalRecord(key) !== undefined);
      if (!response.ok || keys.length === 0) {
        throw new PactJwksError("The Brand JWKS is unavailable.");
      }
      const jwks = { keys };
      this.jwksCache.set(jwksUri, { jwks, expiresAt: Date.now() + jwksPositiveTtlMs });
      return jwks;
    } catch (error) {
      this.jwksCache.set(jwksUri, { failedUntil: Date.now() + jwksNegativeTtlMs });
      if (error instanceof PactJwksError) {
        throw error;
      }
      if (isAbortLikeError(error) || timeout.didTimeout()) {
        throw new PactJwksError("The Brand JWKS request timed out.");
      }
      throw new PactJwksError("The Brand JWKS request failed.");
    } finally {
      timeout.cleanup();
    }
  }

  /** Drop both cache slots for one `jwks_uri` — the kid-miss refetch path. */
  invalidate(jwksUri: string): void {
    this.jwksCache.delete(jwksUri);
  }
}

async function readJwksJson(response: Response): Promise<Record<string, unknown>> {
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: pactEgressMaxBytes,
    fieldName: "pact JWKS",
    createError: (message) => new PactJwksError(message),
  });
  try {
    return optionalRecord(JSON.parse(new TextDecoder().decode(bytes))) ?? {};
  } catch {
    throw new PactJwksError("The Brand JWKS response is not valid JSON.");
  }
}
