import { crossOriginSafeHeaders, resolveGuardedEgressTarget } from "../core/guarded-fetch.ts";

/**
 * PACT outbound policy (spec §4.4): Brand URLs must be absolute HTTPS with
 * public targets; the SSRF guard's DNS check stays on because the host always
 * comes from operator/card input. `http://` is accepted only for loopback
 * addresses and only when OOMOL_CONNECT_PACT_ALLOW_INSECURE_LOOPBACK opted in.
 */
export type PactEgressFailure = "invalid_url" | "blocked" | "resolution" | "redirect";

export class PactEgressError extends Error {
  readonly reason: PactEgressFailure;

  constructor(reason: PactEgressFailure, message: string) {
    super(message);
    this.name = "PactEgressError";
    this.reason = reason;
  }
}

export interface PactEgressOptions {
  /** Raw transport; tests inject a mock so no socket opens. */
  fetcher?: typeof fetch;
  /** `OOMOL_CONNECT_PACT_ALLOW_INSECURE_LOOPBACK` — permits `http://` loopback only. */
  allowInsecureLoopback?: boolean;
  /** Redirect hops to follow, each re-validated; default follows none. */
  maxRedirects?: number;
}

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "[::1]" || hostname.startsWith("127.")
  );
}

/**
 * Validate one PACT egress hop: parse, apply the loopback exception, then run
 * the shared literal + DNS guard. Public URLs must use `https:`.
 */
export async function assertPactEgressUrl(
  value: string,
  options: { fieldName: string; allowInsecureLoopback?: boolean },
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new PactEgressError("invalid_url", `${options.fieldName} must be an absolute URL`);
  }
  if (isLoopbackHostname(parsed.hostname)) {
    if (options.allowInsecureLoopback === true && parsed.protocol === "http:") {
      return parsed;
    }
    // Fall through to the shared guard for the standard loopback rejection.
  }
  const target = await resolveGuardedEgressTarget(value, {
    fieldName: options.fieldName,
    createError: (message) => new PactEgressError("blocked", message),
    createResolutionError: (message) => new PactEgressError("resolution", message),
  });
  if (target.url.protocol !== "https:") {
    throw new PactEgressError("blocked", `${options.fieldName} must use https`);
  }
  return target.url;
}

/**
 * Fetch one PACT URL under the PACT egress policy. Redirects are followed
 * manually up to `maxRedirects`, re-validating each `Location` the way the
 * shared guarded fetch does; a redirect hop that fails the guard stops the
 * chase with `reason: "blocked"`. Cross-origin hops keep only safe headers.
 */
export async function pactEgressFetch(url: string, init: RequestInit, options: PactEgressOptions): Promise<Response> {
  const transport = options.fetcher ?? fetch;
  const maxRedirects = options.maxRedirects ?? 0;
  let current = (
    await assertPactEgressUrl(url, {
      fieldName: "request URL",
      allowInsecureLoopback: options.allowInsecureLoopback,
    })
  ).href;
  let headers = Object.fromEntries(new Headers(init.headers).entries());

  for (let hop = 0; ; hop += 1) {
    const response = await transport(current, { ...init, headers, redirect: "manual" });
    const status = response.status;
    const location = response.headers.get("location");
    if (!redirectStatuses.has(status) || !location) {
      return response;
    }
    if (hop >= maxRedirects) {
      return response;
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new PactEgressError("redirect", "Brand redirect Location is not a valid URL");
    }
    const checked = await assertPactEgressUrl(next.href, {
      fieldName: "redirect URL",
      allowInsecureLoopback: options.allowInsecureLoopback,
    });
    if (checked.origin !== new URL(current).origin) {
      headers = Object.fromEntries(
        Object.entries(headers).filter(([name]) => crossOriginSafeHeaders.has(name.toLowerCase())),
      );
    }
    current = checked.href;
  }
}
