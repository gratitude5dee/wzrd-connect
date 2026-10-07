import type { PactCardSkillSnapshot } from "./pact-connection.ts";

import { optionalRecord, optionalString, recordOrEmpty } from "../core/cast.ts";
import { readBoundedResponseBytes } from "../core/request.ts";
import { createProviderTimeout, isAbortLikeError } from "../providers/provider-runtime.ts";
import { PactEgressError, assertPactEgressUrl, pactEgressFetch } from "./pact-fetch.ts";

/** Card fetch budget (spec §4.4): ≤3 re-validated redirects, 64 KiB, 10 s. */
export const pactCardMaxBytes: number = 64 * 1024;
export const pactCardFetchTimeoutMs: number = 10_000;
export const pactCardMaxRedirects: number = 3;

/** Card facts consumed by Connect, normalized out of the provider's card. */
export interface PactAgentCard {
  name: string;
  version?: string;
  interfaceUrl: string;
  providerOrigin: string;
  skills: PactCardSkillSnapshot[];
  delegation?: PactCardDelegation;
  fetchedAt: string;
}

export interface PactCardDelegation {
  deviceAuthorizationUrl: string;
  tokenUrl: string;
  refreshUrl?: string;
  oauth2MetadataUrl?: string;
  scopes: Record<string, string>;
}

export type PactCardErrorCode = "pact_card_invalid" | "pact_provider_unavailable";

export class PactCardError extends Error {
  readonly code: PactCardErrorCode;
  readonly reason: string;

  constructor(code: PactCardErrorCode, reason: string, message: string) {
    super(message);
    this.name = "PactCardError";
    this.code = code;
    this.reason = reason;
  }
}

export interface FetchAgentCardOptions {
  fetcher?: typeof fetch;
  allowInsecureLoopback?: boolean;
  signal?: AbortSignal;
}

function invalid(reason: string, message: string): PactCardError {
  return new PactCardError("pact_card_invalid", reason, message);
}

function unavailable(reason: string, message: string): PactCardError {
  return new PactCardError("pact_provider_unavailable", reason, message);
}

function mapEgressError(error: PactEgressError): PactCardError {
  if (error.reason === "invalid_url" || error.reason === "blocked") {
    return invalid(`url_rejected`, error.message);
  }
  return unavailable(error.reason, error.message);
}

/**
 * Resolve the card URL to fetch (spec §4.4): a bare origin walks to
 * `/.well-known/agent-card.json`; a URL with a path is taken verbatim.
 */
export function resolveAgentCardUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalid("invalid_url", "agentCardUrl must be an absolute URL");
  }
  if (parsed.pathname === "/" || parsed.pathname === "") {
    parsed = new URL("/.well-known/agent-card.json", parsed.origin);
  }
  return parsed.href;
}

/**
 * Fetch and validate a Brand agent card under the §4.4 policy. Throws
 * {@link PactCardError} (`pact_card_invalid` for URL/shape failures,
 * `pact_provider_unavailable` for transport, DNS, timeout, or size failures).
 */
export async function fetchAgentCard(value: string, options: FetchAgentCardOptions): Promise<PactAgentCard> {
  const cardUrl = resolveAgentCardUrl(value);
  const timeout = createProviderTimeout(options.signal, pactCardFetchTimeoutMs);
  try {
    const response = await pactEgressFetch(
      cardUrl,
      { method: "GET", headers: { accept: "application/json" }, signal: timeout.signal },
      {
        fetcher: options.fetcher,
        allowInsecureLoopback: options.allowInsecureLoopback,
        maxRedirects: pactCardMaxRedirects,
      },
    );
    if (!response.ok) {
      const reason = `http_${response.status}`;
      if (response.status < 500) {
        throw invalid(reason, `Agent card request failed with status ${response.status}`);
      }
      throw unavailable(reason, `Agent card request failed with status ${response.status}`);
    }
    const bytes = await readBoundedResponseBytes(response, {
      maxBytes: pactCardMaxBytes,
      fieldName: "agent card",
      createError: (message) => unavailable("oversized", message),
      signal: timeout.signal,
    });
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw invalid("invalid_json", "Agent card response is not valid JSON");
    }
    return await validatePactAgentCard(body, options);
  } catch (error) {
    if (error instanceof PactCardError) {
      throw error;
    }
    if (error instanceof PactEgressError) {
      throw mapEgressError(error);
    }
    if (isAbortLikeError(error) || timeout.didTimeout()) {
      throw unavailable("timeout", "Agent card request timed out");
    }
    throw unavailable("network", "Agent card request failed");
  } finally {
    timeout.cleanup();
  }
}

export interface ValidateAgentCardOptions {
  allowInsecureLoopback?: boolean;
}

/**
 * Validate a decoded agent card and normalize the facts Connect stores
 * (spec §4.4): the HTTP+JSON/1.0 interface is selected by binding+version,
 * not position; one `securityRequirements` entry must name a lone Bearer JWT
 * httpAuthSecurityScheme; an `oauth2SecurityScheme` deviceCode flow becomes
 * the delegation section.
 */
export async function validatePactAgentCard(
  body: unknown,
  options: ValidateAgentCardOptions = {},
): Promise<PactAgentCard> {
  const card = recordOrEmpty(body);
  const name = optionalString(card.name)?.trim();
  if (!name) {
    throw invalid("missing_name", "Agent card has no name");
  }

  const interfaces = Array.isArray(card.supportedInterfaces) ? card.supportedInterfaces : [];
  let interfaceUrl: string | undefined;
  let sawUnsupported = false;
  for (const entry of interfaces) {
    const record = optionalRecord(entry);
    if (!record) {
      continue;
    }
    if (record.protocolBinding === "HTTP+JSON" && record.protocolVersion === "1.0") {
      const url = optionalString(record.url);
      if (url) {
        interfaceUrl = url;
        break;
      }
    } else {
      sawUnsupported = true;
    }
  }
  if (!interfaceUrl) {
    throw invalid(
      sawUnsupported ? "unsupported_binding" : "missing_interface",
      "Agent card has no HTTP+JSON/1.0 interface",
    );
  }
  try {
    await assertPactEgressUrl(interfaceUrl, {
      fieldName: "interface URL",
      allowInsecureLoopback: options.allowInsecureLoopback,
    });
  } catch (error) {
    if (error instanceof PactEgressError) {
      throw mapEgressError(error);
    }
    throw error;
  }
  const interfaceOrigin = new URL(interfaceUrl).origin;

  const schemes = recordOrEmpty(card.securitySchemes);
  const requirements = Array.isArray(card.securityRequirements) ? card.securityRequirements : [];
  let hasPaJwtRequirement = false;
  for (const entry of requirements) {
    const named = recordOrEmpty(optionalRecord(entry)?.schemes);
    if (!named) {
      continue;
    }
    const names = Object.keys(named);
    if (names.length !== 1) {
      continue;
    }
    const scheme = optionalRecord(optionalRecord(schemes[names[0]])?.httpAuthSecurityScheme);
    if (!scheme || scheme.scheme !== "Bearer") {
      continue;
    }
    const bearerFormat = optionalString(scheme.bearerFormat);
    if (bearerFormat !== undefined && bearerFormat !== "JWT") {
      continue;
    }
    hasPaJwtRequirement = true;
    break;
  }
  if (!hasPaJwtRequirement) {
    throw invalid(
      "pa_jwt_scheme_missing",
      "Agent card must require a Bearer JWT httpAuthSecurityScheme alone in one securityRequirements entry",
    );
  }

  const delegation = readDelegation(schemes);
  const providerUrl = optionalString(optionalRecord(card.provider)?.url);
  let providerOrigin = interfaceOrigin;
  if (providerUrl) {
    try {
      providerOrigin = new URL(providerUrl).origin;
    } catch {
      throw invalid("invalid_provider_url", "Agent card provider.url is not a URL");
    }
  }

  const skills: PactCardSkillSnapshot[] = [];
  for (const entry of Array.isArray(card.skills) ? card.skills : []) {
    const skill = optionalRecord(entry);
    const id = optionalString(skill?.id);
    const skillName = optionalString(skill?.name);
    const description = optionalString(skill?.description);
    if (!id || !skillName || !description) {
      continue;
    }
    const tags = Array.isArray(skill?.tags)
      ? skill.tags.filter((tag): tag is string => typeof tag === "string")
      : undefined;
    skills.push({ id, name: skillName, description, tags });
  }

  return {
    name,
    version: optionalString(card.version),
    interfaceUrl,
    providerOrigin,
    skills,
    delegation,
    fetchedAt: new Date().toISOString(),
  };
}

function readDelegation(schemes: Record<string, unknown>): PactCardDelegation | undefined {
  for (const entry of Object.values(schemes)) {
    const oauth2 = optionalRecord(optionalRecord(entry)?.oauth2SecurityScheme);
    if (!oauth2) {
      continue;
    }
    const deviceCode = optionalRecord(optionalRecord(oauth2.flows)?.deviceCode);
    if (!deviceCode) {
      continue;
    }
    const deviceAuthorizationUrl = optionalString(deviceCode.deviceAuthorizationUrl);
    const tokenUrl = optionalString(deviceCode.tokenUrl);
    if (!deviceAuthorizationUrl || !tokenUrl) {
      throw invalid(
        "invalid_delegation_flow",
        "Agent card oauth2 deviceCode flow requires deviceAuthorizationUrl and tokenUrl",
      );
    }
    const scopes = recordOrEmpty(deviceCode.scopes);
    return {
      deviceAuthorizationUrl,
      tokenUrl,
      refreshUrl: optionalString(deviceCode.refreshUrl),
      oauth2MetadataUrl: optionalString(oauth2.oauth2MetadataUrl),
      scopes: Object.fromEntries(
        Object.entries(scopes).filter(([, description]) => typeof description === "string"),
      ) as Record<string, string>,
    };
  }
  return undefined;
}
