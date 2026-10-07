import type { IConnectionStore, StoredPactConnection } from "../connection-service.ts";
import type { RuntimeLogger } from "../core/types.ts";
import type { OAuthRevocationOutcome } from "../oauth/oauth-credential-refresh-service.ts";
import type {
  ConnectionRequest,
  ConnectionRequestStore,
  PendingPactConnectionRequest,
} from "../server/storage/connection-request-store.ts";
import type { PactRegistrationStore } from "../server/storage/pact-registration-store.ts";
import type { PactCardDelegation } from "./agent-card.ts";
import type { PactConnectionCredential, PactConnectionDelegation } from "./pact-connection.ts";
import type { PactIdentityService } from "./pact-identity-service.ts";

import { ConnectionError } from "../connection-service.ts";
import { optionalInteger, optionalRecord, optionalString } from "../core/cast.ts";
import { readBoundedResponseBytes } from "../core/request.ts";
import { createProviderTimeout, isAbortLikeError } from "../providers/provider-runtime.ts";
import { PactEgressError, pactEgressFetch, pactEgressMaxBytes, pactEgressRequestTimeoutMs } from "./pact-fetch.ts";
import { PactIdentityError } from "./pact-identity-service.ts";
import { PactJwksError, PactJwksResolver } from "./pact-jwks.ts";

/** Refresh a delegation token when `expiresAt` is inside this window (spec §4.5). */
export const pactDelegationRefreshWindowMs: number = 60_000;

/** PACT requests are owned by the single administrator principal, like OAuth requests. */
export const pactRequestOwner = "local-admin";

/**
 * Connect-side delegation failures (spec §4.5). `details` follows the runtime
 * `{status, details}` convention so HTTP mapping keeps working.
 */
export class PactDelegationError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "PactDelegationError";
    this.code = code;
    this.details = details;
  }
}

export interface PactDelegationServiceOptions {
  requests: ConnectionRequestStore;
  store: IConnectionStore;
  registrations: PactRegistrationStore;
  identity: PactIdentityService;
  /** `OOMOL_CONNECT_PACT_ALLOW_INSECURE_LOOPBACK`. */
  allowInsecureLoopback?: boolean;
  fetcher?: typeof fetch;
  logger?: RuntimeLogger;
}

/** The 202 payload the person-facing consent link travels in (spec §4.5). */
export interface PactConsentPayload {
  connectionRequestId: string;
  verificationUriComplete?: string;
  verificationUri?: string;
  userCode?: string;
  expiresAt: string;
  pollUrl: string;
  missingScopes?: string[];
  contextId?: string;
}

export interface PactDeviceStartInput {
  connectionName: string;
  /** Card `delegation` endpoints + advertised scope map. */
  endpoints: PactCardDelegation;
  /** Card `interfaceUrl`; the delegation token's `aud` must equal it. */
  interfaceUrl: string;
  /** Card provider origin; backs the metadata URL fallback. */
  providerOrigin: string;
  /** Registration audience the PA-JWT is minted for. */
  audience: string;
  requestedScopes: string[];
  /** Step-up only: subset the Brand reported missing (for the payload). */
  missingScopes?: string[];
  /** Step-up only: conversation the retried message should rejoin. */
  contextId?: string;
  /**
   * Step-up only: the link the task's `pact.verificationUriComplete` supplied.
   * Used only when the device response omits `verification_uri_complete` — the
   * reference Provider binds the task link to a Provider-owned device code the
   * agent cannot poll, so PACT §5.5 makes the agent's own §5.3 link win.
   */
  verificationUriComplete?: string;
  /** PA-JWT `sub`; defaults to the deployment subject. */
  subject?: string;
  signal?: AbortSignal;
}

export interface PactConsentView {
  verificationUri?: string;
  verificationUriComplete?: string;
  userCode?: string;
  missingScopes?: string[];
  contextId?: string;
}

export type PactRequestPollResult =
  | { kind: "pending"; request: ConnectionRequest; retryAfterSeconds: number; consent: PactConsentView }
  | { kind: "connected"; request: ConnectionRequest }
  | { kind: "denied" | "expired" | "failed"; request: ConnectionRequest };

interface PactOauthMetadata {
  issuer?: string;
  jwksUri?: string;
  revocationEndpoint?: string;
}

interface VerifiedGrant {
  accessToken: string;
  refreshToken?: string;
  grantId?: string;
  subject?: string;
  scopes: string[];
  expiresAt?: string;
  tokenIssuer: string;
  jwksUri: string;
}

/**
 * The PACT 1.0 device-code delegation flow (spec §4.5): start, paced polling,
 * token commit with provider-key verification, refresh, step-up, and
 * best-effort RFC 7009 revocation. Connect never proxies, frames, or observes
 * the Brand login — it only hands the person the consent link.
 */
export class PactDelegationService {
  private readonly options: PactDelegationServiceOptions;
  /** Serializes refreshes per connection (cf. src/core/promise-cache.ts). */
  private readonly refreshes = new Map<string, Promise<StoredPactConnection>>();
  /** Per-jwks_uri JWKS cache shared with the receipt verifier. */
  private readonly jwksResolver: PactJwksResolver;

  constructor(options: PactDelegationServiceOptions) {
    this.options = options;
    this.jwksResolver = new PactJwksResolver(options);
  }

  /**
   * POST the card's `deviceAuthorizationUrl` (`client_id=<issuer>&scope=<ids>`)
   * with a fresh PA-JWT, store the pending request, and return the consent
   * payload. Every requested id must be one the card advertises.
   */
  async startDeviceRequest(input: PactDeviceStartInput): Promise<PactConsentPayload> {
    assertPactScopesAvailable(input.endpoints.scopes, input.requestedScopes);
    const issuer = this.requireIssuer();
    const subject = await this.resolveSubject(input.subject);
    const form = new URLSearchParams({ client_id: issuer });
    if (input.requestedScopes.length > 0) {
      form.set("scope", input.requestedScopes.join(" "));
    }
    const paJwt = await this.signPaJwt(input.audience, subject);
    const response = await this.oauthPost(
      input.endpoints.deviceAuthorizationUrl,
      paJwt,
      form,
      "device authorization",
      input.signal,
    );
    const body = await this.readOauthJson(response, "device authorization");
    if (!response.ok || optionalString(body.error) !== undefined) {
      throw this.oauthEndpointError(response.status, body, "device authorization");
    }
    const deviceCode = optionalString(body.device_code);
    if (!deviceCode) {
      throw new PactDelegationError(
        "pact_provider_unavailable",
        "The Brand device authorization response carried no device_code.",
      );
    }
    const expiresIn = optionalInteger(body.expires_in) ?? 600;
    const interval = Math.max(1, optionalInteger(body.interval) ?? 5);
    const now = new Date();
    const pending: PendingPactConnectionRequest = {
      connectionRequestId: crypto.randomUUID(),
      owner: pactRequestOwner,
      connectionName: input.connectionName,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString(),
      deviceCode,
      pollIntervalSeconds: interval,
      deviceAuthorizationUrl: input.endpoints.deviceAuthorizationUrl,
      tokenUrl: input.endpoints.tokenUrl,
      oauth2MetadataUrl: input.endpoints.oauth2MetadataUrl,
      advertisedScopes: input.endpoints.scopes,
      interfaceUrl: input.interfaceUrl,
      providerOrigin: input.providerOrigin,
      audience: input.audience,
      subject,
      requestedScopes: input.requestedScopes,
      missingScopes: input.missingScopes,
      contextId: input.contextId,
      verificationUri: optionalString(body.verification_uri),
      verificationUriComplete: optionalString(body.verification_uri_complete) ?? input.verificationUriComplete,
      userCode: optionalString(body.user_code),
    };
    await this.options.requests.createPact(pending);
    return this.consentPayload(pending);
  }

  /**
   * Step-up on `TASK_STATE_AUTH_REQUIRED` (spec §4.5): request the union of the
   * Brand-reported missing ids and the currently granted ids so the new grant
   * is a superset. The device response's own `verification_uri_complete` is
   * shown (PACT §5.5 repeats §5.3); the task's `pact.verificationUriComplete`
   * is only a fallback, since on the reference Provider it is bound to a
   * Provider-created device authorization the agent cannot poll. `contextId`
   * lets the agent retry the same message afterwards.
   */
  async startStepUp(
    connection: StoredPactConnection,
    input: {
      missingScopes: string[];
      verificationUriComplete?: string;
      contextId?: string;
      subject?: string;
      signal?: AbortSignal;
    },
  ): Promise<PactConsentPayload> {
    const credential = connection.credential;
    const endpoints = await this.resolveDelegationConfig(connection, input.signal);
    const granted = credential.delegation?.grantedScopes ?? [];
    const requested = [...new Set([...granted, ...input.missingScopes])];
    const registration = await this.requireRegistration(credential.registrationId);
    return this.startDeviceRequest({
      connectionName: connection.connectionName,
      endpoints,
      interfaceUrl: credential.interfaceUrl,
      providerOrigin: credential.providerOrigin,
      audience: registration.audience,
      requestedScopes: requested,
      missingScopes: input.missingScopes,
      contextId: input.contextId,
      verificationUriComplete: input.verificationUriComplete,
      subject: input.subject,
      signal: input.signal,
    });
  }

  /**
   * `pact.request_scopes` (spec §4.5): nothing to do when the grant already
   * covers the ask; otherwise start a device request for the union of the
   * requested and already-granted ids.
   */
  async startScopeRequest(
    connection: StoredPactConnection,
    scopes: string[],
    input: { subject?: string; signal?: AbortSignal } = {},
  ): Promise<{ kind: "granted"; grantedScopes: string[] } | { kind: "consent"; consent: PactConsentPayload }> {
    const credential = connection.credential;
    const granted = credential.delegation?.grantedScopes ?? [];
    const covered = new Set(granted);
    const missing = scopes.filter((scope) => !covered.has(scope));
    if (missing.length === 0) {
      return { kind: "granted", grantedScopes: [...covered] };
    }
    const endpoints = await this.resolveDelegationConfig(connection, input.signal);
    const requested = [...new Set([...granted, ...scopes])];
    const registration = await this.requireRegistration(credential.registrationId);
    const consent = await this.startDeviceRequest({
      connectionName: connection.connectionName,
      endpoints,
      interfaceUrl: credential.interfaceUrl,
      providerOrigin: credential.providerOrigin,
      audience: registration.audience,
      requestedScopes: requested,
      missingScopes: missing,
      subject: input.subject,
      signal: input.signal,
    });
    return { kind: "consent", consent };
  }

  /**
   * Drive a pending PACT request: at most one token-endpoint call per
   * provider-minted interval (the `next_poll_at` claim serializes races).
   * Terminal provider errors land on the request and shape the outcome.
   */
  async pollConnectionRequest(
    id: string,
    owner: string,
    signal?: AbortSignal,
  ): Promise<PactRequestPollResult | undefined> {
    const row = await this.options.requests.readPactRequest(id, owner);
    if (!row) {
      const request = await this.options.requests.get(id, owner);
      if (!request || request.service !== "pact") {
        return undefined;
      }
      return this.terminalOutcome(request);
    }
    const { pending } = row;
    const now = Date.now();
    if (Date.parse(pending.expiresAt) <= now) {
      await this.options.requests.failPact(id, "pact_consent_expired", "The Brand consent request expired.");
      return { kind: "expired", request: (await this.options.requests.get(id, owner))! };
    }
    const claimed = await this.options.requests.claimPactPoll(id, now + pending.pollIntervalSeconds * 1000, now);
    if (!claimed) {
      return {
        kind: "pending",
        request: (await this.options.requests.get(id, owner))!,
        retryAfterSeconds: Math.max(1, Math.ceil((row.nextPollAt - now) / 1000)),
        consent: this.consentView(pending),
      };
    }
    try {
      const { response, body } = await this.pollTokenEndpoint(pending, signal);
      const error = optionalString(body.error);
      if (error === "authorization_pending" || error === "slow_down") {
        if (error === "slow_down") {
          // RFC 8628 §3.5: +5 s to the interval, applied immediately.
          pending.pollIntervalSeconds += 5;
          await this.options.requests.savePactPending(pending, Date.now() + pending.pollIntervalSeconds * 1000);
        }
        return this.pendingOutcome(id, owner, pending);
      }
      if (error === "access_denied") {
        await this.options.requests.failPact(id, "pact_consent_denied", "The Brand consent was denied.");
        return { kind: "denied", request: (await this.options.requests.get(id, owner))! };
      }
      if (error === "expired_token") {
        await this.options.requests.failPact(id, "pact_consent_expired", "The Brand consent request expired.");
        return { kind: "expired", request: (await this.options.requests.get(id, owner))! };
      }
      if (error !== undefined || !response.ok) {
        await this.options.requests.failPact(
          id,
          "pact_consent_failed",
          `The Brand token endpoint answered ${error ?? `HTTP ${response.status}`}.`,
        );
        return { kind: "failed", request: (await this.options.requests.get(id, owner))! };
      }
      return await this.commitGrant(id, owner, pending, body, signal);
    } catch (error) {
      if (isAbortLikeError(error)) {
        throw error;
      }
      // Transport/egress failures keep the request pending — the claim already
      // moved next_poll_at, so the next read resumes after the interval.
      this.options.logger?.warn(
        { connectionName: pending.connectionName, error: error instanceof Error ? error.message : String(error) },
        "pact token endpoint poll failed",
      );
      return this.pendingOutcome(id, owner, pending);
    }
  }

  /**
   * Refresh the stored delegation token before sends when `expiresAt` is inside
   * the 60 s window (or `force`d after a 401). Concurrent calls on one
   * connection share the in-flight promise.
   */
  async refreshGrant(
    connection: StoredPactConnection,
    input: { subject?: string; force?: boolean; signal?: AbortSignal } = {},
  ): Promise<StoredPactConnection> {
    const delegation = connection.credential.delegation;
    if (!delegation?.accessToken) {
      return connection;
    }
    const expiresAt = Date.parse(delegation.expiresAt ?? "");
    const expiring = Number.isFinite(expiresAt) && expiresAt - pactDelegationRefreshWindowMs <= Date.now();
    if (!input.force && !expiring) {
      return connection;
    }
    if (!delegation.refreshToken) {
      return connection;
    }
    const inFlight = this.refreshes.get(connection.id);
    if (inFlight) {
      return inFlight;
    }
    const promise = this.doRefreshGrant(connection, input).finally(() => {
      if (this.refreshes.get(connection.id) === promise) {
        this.refreshes.delete(connection.id);
      }
    });
    this.refreshes.set(connection.id, promise);
    return promise;
  }

  private async doRefreshGrant(
    connection: StoredPactConnection,
    input: { subject?: string; signal?: AbortSignal },
  ): Promise<StoredPactConnection> {
    const credential = connection.credential;
    const delegation = credential.delegation!;
    const registration = await this.requireRegistration(credential.registrationId);
    const issuer = this.requireIssuer();
    const subject = await this.resolveSubject(input.subject);
    const paJwt = await this.signPaJwt(registration.audience, subject);
    const response = await this.oauthPost(
      delegation.tokenUrl,
      paJwt,
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: delegation.refreshToken!,
        client_id: issuer,
      }),
      "token refresh",
      input.signal,
    );
    const body = await this.readOauthJson(response, "token refresh");
    if (optionalString(body.error) === "invalid_grant") {
      // The Brand revoked the grant: clear the tokens, flag the connection, and
      // fail the caller with the step-up payload for the lost scopes (§4.5).
      await this.markNeedsReauthorization(connection);
      throw new PactDelegationError("pact_unauthorized", "The Brand revoked the delegation grant.", {
        status: 401,
        details: {
          missingScopes: delegation.grantedScopes ?? [],
          needsReauthorization: true,
        },
      });
    }
    if (!response.ok || optionalString(body.error) !== undefined) {
      throw new PactDelegationError(
        "pact_provider_unavailable",
        `The Brand token endpoint answered ${optionalString(body.error) ?? `HTTP ${response.status}`}.`,
      );
    }
    const grant = await this.verifyGrant(
      {
        oauth2MetadataUrl: delegation.oauth2MetadataUrl,
        interfaceUrl: credential.interfaceUrl,
        providerOrigin: credential.providerOrigin,
      },
      body,
      delegation.grantedScopes ?? [],
      input.signal,
    );
    const next = this.applyGrant(credential, delegation, grant);
    const updated = await this.updateConnectionCredential(connection, next, true);
    if (!updated) {
      throw new PactDelegationError(
        "pact_provider_unavailable",
        "The connection changed while the delegation token refreshed.",
      );
    }
    return updated;
  }

  /**
   * Clear the stored grant and flag the connection `needsReauthorization` —
   * the Brand's revocation (`invalid_grant`) or a terminal 401 lands here.
   */
  async markNeedsReauthorization(connection: StoredPactConnection): Promise<StoredPactConnection> {
    const delegation = connection.credential.delegation;
    if (!delegation) {
      return connection;
    }
    const cleared: PactConnectionDelegation = {
      deviceAuthorizationUrl: delegation.deviceAuthorizationUrl,
      tokenUrl: delegation.tokenUrl,
      oauth2MetadataUrl: delegation.oauth2MetadataUrl,
      scopes: delegation.scopes,
      needsReauthorization: true,
    };
    const next: PactConnectionCredential = {
      ...connection.credential,
      delegation: cleared,
      profile: { ...connection.credential.profile, grantedScopes: undefined },
    };
    return (await this.updateConnectionCredential(connection, next, true)) ?? connection;
  }

  /**
   * Best-effort RFC 7009 revocation on disconnect (spec §4.5): post the
   * refresh token to the provider's `revocation_endpoint` when its RFC 8414
   * metadata advertises one; report done/failed/unsupported/skipped.
   */
  async revokeGrant(connection: StoredPactConnection, signal?: AbortSignal): Promise<OAuthRevocationOutcome> {
    const delegation = connection.credential.delegation;
    if (!delegation?.refreshToken) {
      return "skipped";
    }
    try {
      const metadata = await this.readOauthMetadata(
        this.metadataUrl(delegation.oauth2MetadataUrl, connection.credential.providerOrigin),
        signal,
      );
      const endpoint = metadata.revocationEndpoint;
      if (!endpoint) {
        return "unsupported";
      }
      const registration = await this.options.registrations.get(connection.credential.registrationId);
      const paJwt = await this.signPaJwt(
        registration?.audience ?? connection.credential.providerOrigin,
        await this.resolveSubject(undefined),
      );
      const response = await this.oauthPost(
        endpoint,
        paJwt,
        new URLSearchParams({ token: delegation.refreshToken, token_type_hint: "refresh_token" }),
        "token revocation",
        signal,
      );
      return response.ok ? "done" : "failed";
    } catch (error) {
      this.options.logger?.warn(
        { connectionName: connection.connectionName, error: error instanceof Error ? error.message : String(error) },
        "pact token revocation failed",
      );
      return "failed";
    }
  }

  /** The `pact.get_delegation` output: never secrets, only grant facts. */
  readGrant(credential: PactConnectionCredential): Record<string, unknown> {
    const delegation = credential.delegation;
    if (!delegation?.accessToken) {
      return { identityOnly: true, needsReauthorization: delegation?.needsReauthorization === true };
    }
    return {
      identityOnly: false,
      grantId: delegation.grantId,
      grantedScopes: delegation.grantedScopes ?? [],
      expiresAt: delegation.expiresAt,
      needsReauthorization: delegation.needsReauthorization === true,
    };
  }

  private consentPayload(pending: PendingPactConnectionRequest): PactConsentPayload {
    return {
      connectionRequestId: pending.connectionRequestId,
      verificationUriComplete: pending.verificationUriComplete,
      verificationUri: pending.verificationUri,
      userCode: pending.userCode,
      expiresAt: pending.expiresAt,
      pollUrl: `/v1/connection-requests/${pending.connectionRequestId}`,
      missingScopes: pending.missingScopes,
      contextId: pending.contextId,
    };
  }

  private consentView(pending: PendingPactConnectionRequest): PactConsentView {
    return {
      verificationUri: pending.verificationUri,
      verificationUriComplete: pending.verificationUriComplete,
      userCode: pending.userCode,
      missingScopes: pending.missingScopes,
      contextId: pending.contextId,
    };
  }

  /** A pending outcome that yields to the terminal one when the row raced to completion. */
  private async pendingOutcome(
    id: string,
    owner: string,
    pending: PendingPactConnectionRequest,
  ): Promise<PactRequestPollResult> {
    const request = (await this.options.requests.get(id, owner))!;
    if (request.status !== "initiated") {
      return this.terminalOutcome(request);
    }
    return {
      kind: "pending",
      request,
      retryAfterSeconds: pending.pollIntervalSeconds,
      consent: this.consentView(pending),
    };
  }

  private terminalOutcome(request: ConnectionRequest): PactRequestPollResult {
    if (request.status === "connected") {
      return { kind: "connected", request };
    }
    if (request.errorCode === "pact_consent_denied") {
      return { kind: "denied", request };
    }
    if (request.errorCode === "pact_consent_expired") {
      return { kind: "expired", request };
    }
    return { kind: "failed", request };
  }

  /** Stored delegation config, or a fresh card read for PR4-era credentials without one. */
  private async resolveDelegationConfig(
    connection: StoredPactConnection,
    signal: AbortSignal | undefined,
  ): Promise<PactCardDelegation> {
    const delegation = connection.credential.delegation;
    if (delegation) {
      return {
        deviceAuthorizationUrl: delegation.deviceAuthorizationUrl,
        tokenUrl: delegation.tokenUrl,
        oauth2MetadataUrl: delegation.oauth2MetadataUrl,
        scopes: delegation.scopes,
      };
    }
    const { fetchAgentCard } = await import("./agent-card.ts");
    const card = await fetchAgentCard(connection.credential.cardUrl, {
      fetcher: this.options.fetcher,
      allowInsecureLoopback: this.options.allowInsecureLoopback,
      signal,
    });
    if (!card.delegation) {
      throw new ConnectionError("invalid_scope", "The Brand card advertises no delegation scopes.");
    }
    return card.delegation;
  }

  private async requireRegistration(registrationId: string) {
    const registration = await this.options.registrations.get(registrationId);
    if (!registration?.enabled) {
      throw new PactDelegationError(
        "pact_registration_required",
        "The PACT registration this connection was authorized under is gone or disabled.",
      );
    }
    return registration;
  }

  private requireIssuer(): string {
    const issuer = this.options.identity.getOpenIdConfiguration()?.issuer;
    if (!issuer) {
      throw new PactIdentityError("pact_origin_required", "PACT identity requires OOMOL_CONNECT_ORIGIN (the issuer).");
    }
    return issuer;
  }

  private async resolveSubject(subject: string | undefined): Promise<string> {
    const resolved = subject ?? (await this.options.identity.readDeploymentSubject());
    if (resolved === undefined) {
      throw new PactIdentityError("pact_identity_not_found", "No PACT identity exists yet.");
    }
    return resolved;
  }

  private async signPaJwt(audience: string, subject: string): Promise<string> {
    return this.options.identity.signPersonalAgentJwt({ subject, audience });
  }

  /** POST an OAuth endpoint under the PACT egress policy and the 10 s budget. */
  private async oauthPost(
    url: string,
    paJwt: string,
    form: URLSearchParams,
    label: string,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const timeout = createProviderTimeout(signal, pactEgressRequestTimeoutMs);
    try {
      return await pactEgressFetch(
        url,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${paJwt}`,
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
          },
          body: form,
          signal: timeout.signal,
        },
        { fetcher: this.options.fetcher, allowInsecureLoopback: this.options.allowInsecureLoopback },
      );
    } catch (error) {
      if (isAbortLikeError(error) || timeout.didTimeout()) {
        throw new PactDelegationError("pact_provider_unavailable", `The Brand ${label} request timed out.`);
      }
      if (error instanceof PactEgressError) {
        throw new PactDelegationError("pact_provider_unavailable", `The Brand ${label} URL failed the egress policy.`);
      }
      throw new PactDelegationError("pact_provider_unavailable", `The Brand ${label} request failed.`);
    } finally {
      timeout.cleanup();
    }
  }

  private async readOauthJson(response: Response, label: string): Promise<Record<string, unknown>> {
    const bytes = await readBoundedResponseBytes(response, {
      maxBytes: pactEgressMaxBytes,
      fieldName: `pact ${label}`,
      createError: (message) => new PactDelegationError("pact_provider_unavailable", message),
    });
    try {
      return optionalRecord(JSON.parse(new TextDecoder().decode(bytes))) ?? {};
    } catch {
      throw new PactDelegationError("pact_provider_unavailable", `The Brand ${label} response is not valid JSON.`);
    }
  }

  private oauthEndpointError(status: number, body: Record<string, unknown>, label: string): PactDelegationError {
    const error = optionalString(body.error);
    if (error === "invalid_scope") {
      return new PactDelegationError("invalid_scope", "The Brand rejected the requested scopes.");
    }
    return new PactDelegationError(
      "pact_provider_unavailable",
      `The Brand ${label} endpoint answered ${error ?? `HTTP ${status}`}.`,
    );
  }

  /** One token-endpoint call for a claimed poll: device_code grant + fresh PA-JWT. */
  private async pollTokenEndpoint(
    pending: PendingPactConnectionRequest,
    signal: AbortSignal | undefined,
  ): Promise<{ response: Response; body: Record<string, unknown> }> {
    const paJwt = await this.signPaJwt(pending.audience, pending.subject);
    const response = await this.oauthPost(
      pending.tokenUrl,
      paJwt,
      new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: pending.deviceCode,
        client_id: this.requireIssuer(),
      }),
      "token",
      signal,
    );
    return { response, body: await this.readOauthJson(response, "token") };
  }

  /**
   * Commit (spec §4.5): verify the access_token JWT against provider keys from
   * RFC 8414 metadata, read `scope` as the granted subset, store the grant on
   * the existing connection row, then mark the request connected.
   */
  private async commitGrant(
    id: string,
    owner: string,
    pending: PendingPactConnectionRequest,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<PactRequestPollResult> {
    const fail = async (message: string): Promise<PactRequestPollResult> => {
      await this.options.requests.failPact(id, "pact_consent_failed", message);
      return { kind: "failed", request: (await this.options.requests.get(id, owner))! };
    };
    let grant: VerifiedGrant;
    try {
      grant = await this.verifyGrant(
        {
          oauth2MetadataUrl: pending.oauth2MetadataUrl,
          interfaceUrl: pending.interfaceUrl,
          providerOrigin: pending.providerOrigin,
        },
        body,
        pending.requestedScopes,
        signal,
      );
    } catch (error) {
      if (isAbortLikeError(error)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger?.warn(
        { connectionName: pending.connectionName },
        `pact delegation token rejected: ${message}`,
      );
      return fail(`The Brand delegation token failed verification: ${message}`);
    }
    const stored = await this.options.store.get("pact", pending.connectionName);
    if (!stored || stored.source !== "pact") {
      return fail("The connection was removed before consent completed.");
    }
    const delegation: PactConnectionDelegation = {
      deviceAuthorizationUrl: pending.deviceAuthorizationUrl,
      tokenUrl: pending.tokenUrl,
      oauth2MetadataUrl: pending.oauth2MetadataUrl,
      scopes: pending.advertisedScopes,
    };
    const next = this.applyGrant(stored.credential, delegation, grant);
    const updated = await this.updateConnectionCredential(stored, next, false);
    if (!updated) {
      return fail("The connection changed while consent completed.");
    }
    await this.options.requests.completePact(id, updated.id);
    return { kind: "connected", request: (await this.options.requests.get(id, owner))! };
  }

  /** Merge a verified grant into a credential: tokens + `sub` profile + grantedScopes. */
  private applyGrant(
    credential: PactConnectionCredential,
    delegation: PactConnectionDelegation,
    grant: VerifiedGrant,
  ): PactConnectionCredential {
    return {
      ...credential,
      delegation: {
        ...delegation,
        accessToken: grant.accessToken,
        refreshToken: grant.refreshToken ?? delegation.refreshToken,
        grantId: grant.grantId,
        grantedScopes: grant.scopes,
        expiresAt: grant.expiresAt,
        tokenIssuer: grant.tokenIssuer,
        jwksUri: grant.jwksUri,
        needsReauthorization: undefined,
      },
      profile: {
        ...credential.profile,
        accountId: grant.subject ?? credential.profile.accountId,
        grantedScopes: grant.scopes,
      },
    };
  }

  /**
   * Write a credential under revision rules, re-reading the latest row once on
   * conflict. `refresh` carries the same-account renewal semantics into the
   * trigger-subscription guard (spec: connections_next revision semantics).
   */
  private async updateConnectionCredential(
    connection: StoredPactConnection,
    credential: PactConnectionCredential,
    refresh: boolean,
  ): Promise<StoredPactConnection | undefined> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const latest = attempt === 0 ? connection : await this.options.store.get("pact", connection.connectionName);
      if (!latest || latest.source !== "pact") {
        return undefined;
      }
      if (await this.options.store.updateCredential({ ...latest, credential }, refresh)) {
        return { ...latest, credential };
      }
    }
    return undefined;
  }

  private metadataUrl(configured: string | undefined, providerOrigin: string): string {
    if (configured) {
      return configured;
    }
    return new URL("/.well-known/oauth-authorization-server", providerOrigin).href;
  }

  /** RFC 8414 metadata: `issuer`, `jwks_uri`, optional `revocation_endpoint`. */
  private async readOauthMetadata(url: string, signal: AbortSignal | undefined): Promise<PactOauthMetadata> {
    const timeout = createProviderTimeout(signal, pactEgressRequestTimeoutMs);
    try {
      const response = await pactEgressFetch(
        url,
        { method: "GET", headers: { accept: "application/json" }, signal: timeout.signal },
        { fetcher: this.options.fetcher, allowInsecureLoopback: this.options.allowInsecureLoopback },
      );
      if (!response.ok) {
        throw new PactDelegationError(
          "pact_provider_unavailable",
          `The Brand OAuth metadata answered HTTP ${response.status}.`,
        );
      }
      const body = await this.readOauthJson(response, "OAuth metadata");
      return {
        issuer: optionalString(body.issuer),
        jwksUri: optionalString(body.jwks_uri),
        revocationEndpoint: optionalString(body.revocation_endpoint),
      };
    } catch (error) {
      if (error instanceof PactDelegationError) {
        throw error;
      }
      if (isAbortLikeError(error) || timeout.didTimeout()) {
        throw new PactDelegationError("pact_provider_unavailable", "The Brand OAuth metadata request timed out.");
      }
      throw new PactDelegationError("pact_provider_unavailable", "The Brand OAuth metadata request failed.");
    } finally {
      timeout.cleanup();
    }
  }

  /**
   * Fetch the Brand JWKS through the shared resolver (5 min positive / 60 s
   * negative cache, one kid-miss refetch) and map its single failure onto the
   * delegation error shape callers already unwrap.
   */
  private async resolveJwks(
    jwksUri: string,
    kid: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ keys: unknown[] }> {
    try {
      return await this.jwksResolver.resolve(jwksUri, kid, signal);
    } catch (error) {
      if (error instanceof PactJwksError) {
        throw new PactDelegationError(error.code, error.message);
      }
      throw error;
    }
  }

  /**
   * Verify a delegation token exactly like the first one (spec §4.5): decode
   * without trusting, fetch RFC 8414 metadata → `jwks_uri`, verify the
   * signature (ES256/RS256 only), then check `iss`, `aud` = `interfaceUrl`,
   * `client_id` = Connect's issuer, and `exp` in the future.
   */
  private async verifyGrant(
    source: { oauth2MetadataUrl?: string; interfaceUrl: string; providerOrigin: string },
    body: Record<string, unknown>,
    requestedScopes: string[],
    signal: AbortSignal | undefined,
  ): Promise<VerifiedGrant> {
    const accessToken = optionalString(body.access_token);
    if (!accessToken) {
      throw new PactDelegationError("pact_provider_unavailable", "The Brand token response carried no access_token.");
    }
    const { decodeProtectedHeader, createLocalJWKSet, jwtVerify } = await import("jose");
    let kid: string | undefined;
    try {
      kid = optionalString(decodeProtectedHeader(accessToken).kid);
    } catch {
      throw new PactDelegationError("pact_provider_unavailable", "The Brand delegation token is not a JWT.");
    }
    const metadata = await this.readOauthMetadata(
      this.metadataUrl(source.oauth2MetadataUrl, source.providerOrigin),
      signal,
    );
    if (!metadata.issuer || !metadata.jwksUri) {
      throw new PactDelegationError("pact_provider_unavailable", "The Brand OAuth metadata lacks issuer or jwks_uri.");
    }
    const issuer = this.requireIssuer();
    const jwks = await this.resolveJwks(metadata.jwksUri, kid, signal);
    const verify = (keys: { keys: unknown[] }) =>
      jwtVerify(accessToken, createLocalJWKSet(keys as never), {
        issuer: metadata.issuer,
        audience: source.interfaceUrl,
        algorithms: ["ES256", "RS256"],
      });
    let payload;
    try {
      payload = (await verify(jwks)).payload;
    } catch (error) {
      if ((error as { code?: string }).code === "ERR_JWKS_NO_MATCHING_KEY") {
        // One kid-miss refetch: the Provider rotated keys after our cache filled.
        this.jwksResolver.invalidate(metadata.jwksUri);
        const fresh = await this.resolveJwks(metadata.jwksUri, undefined, signal);
        payload = (await verify(fresh)).payload;
      } else {
        throw error;
      }
    }
    if (payload.client_id !== issuer) {
      throw new PactDelegationError(
        "pact_provider_unavailable",
        "The Brand delegation token was minted for a different client.",
      );
    }
    const responseScopes = optionalString(body.scope) ?? optionalString(payload.scope);
    const scopes = responseScopes ? responseScopes.split(/\s+/u).filter(Boolean) : requestedScopes;
    const expiresIn = optionalInteger(body.expires_in);
    const tokenExp = optionalInteger(payload.exp);
    const expiresAt =
      expiresIn !== undefined
        ? new Date(Date.now() + expiresIn * 1000).toISOString()
        : tokenExp !== undefined
          ? new Date(tokenExp * 1000).toISOString()
          : undefined;
    return {
      accessToken,
      refreshToken: optionalString(body.refresh_token),
      grantId: optionalString(payload.grant_id),
      subject: optionalString(payload.sub),
      scopes,
      expiresAt,
      tokenIssuer: metadata.issuer,
      jwksUri: metadata.jwksUri,
    };
  }
}

/** `invalid_scope` when any requested id is not one the card advertises (PACT §5.2). */
export function assertPactScopesAvailable(cardScopes: Record<string, string> | undefined, requested: string[]): void {
  const advertised = new Set(Object.keys(cardScopes ?? {}));
  const unknown = requested.filter((scope) => !advertised.has(scope));
  if (unknown.length > 0) {
    throw new ConnectionError("invalid_scope", `The Brand card does not advertise scopes: ${unknown.join(", ")}.`);
  }
}
