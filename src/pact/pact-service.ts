import type { IConnectionStore, StoredPactConnection } from "../connection-service.ts";
import type { ExecutionResult, RuntimeLogger } from "../core/types.ts";
import type { PactRegistrationStore } from "../server/storage/pact-registration-store.ts";
import type { PactAgentCard } from "./agent-card.ts";
import type { PactConnectionCredential } from "./pact-connection.ts";

import { ConnectionError } from "../connection-service.ts";
import { looseArray, optionalRecord, optionalString } from "../core/cast.ts";
import { PactA2AError, sendPactMessage } from "./a2a-client.ts";
import { PactCardError, fetchAgentCard } from "./agent-card.ts";
import { PactEgressError } from "./pact-fetch.ts";
import { PactIdentityError, PactIdentityService } from "./pact-identity-service.ts";

/** Provider-minted conversation state is opaque and capped (spec §4.4). */
export const pactContextIdMaxBytes = 256;

export interface PactServiceOptions {
  store: IConnectionStore;
  registrations: PactRegistrationStore;
  identity: PactIdentityService;
  /** `OOMOL_CONNECT_PACT_ALLOW_INSECURE_LOOPBACK`. */
  allowInsecureLoopback?: boolean;
  fetcher?: typeof fetch;
  logger?: RuntimeLogger;
}

export interface PactConnectBrandInput {
  connectionName: string;
  agentCardUrl: string;
  scopes?: string[];
  signal?: AbortSignal;
}

export interface PactConnectBrandResult {
  status: "connected";
  connectionId: string;
  connectionName: string;
  identityOnly: boolean;
  card: {
    name: string;
    version?: string;
    interfaceUrl: string;
    providerOrigin: string;
  };
}

/** Card preview for the console's Connect-a-Brand dialog — never stores anything. */
export interface PactCardPreview {
  cardUrl: string;
  name: string;
  version?: string;
  interfaceUrl: string;
  providerOrigin: string;
  skills: { id: string; name: string; description: string; tags?: string[] }[];
  scopes: { id: string; description: string }[];
  registration?: { id: string; audience: string; enabled: boolean };
}

export interface PactActionExecutionInput {
  actionId: string;
  /** The stored Brand connection row (carries id/revision so card refreshes can persist). */
  connection: StoredPactConnection;
  input: unknown;
  executionId: string;
  /** PA-JWT `sub` — the runtime token subject, or undefined for local/console callers. */
  subject?: string;
  signal?: AbortSignal;
}

/**
 * Brand-connection lifecycle and PACT action dispatch (spec §4.4, identity-only;
 * the delegation device flow is PR5).
 */
export class PactService {
  private readonly options: PactServiceOptions;

  constructor(options: PactServiceOptions) {
    this.options = options;
  }

  /**
   * Preview a Brand card for the console: fetch + validate, then report which
   * registration (if any) covers the card's provider origin and which
   * delegation scopes the card advertises.
   */
  async previewAgentCard(input: { agentCardUrl: string; signal?: AbortSignal }): Promise<PactCardPreview> {
    const card = await this.fetchCard(input.agentCardUrl, input.signal);
    const registration = await this.options.registrations.findByOrigin(card.providerOrigin);
    return {
      cardUrl: input.agentCardUrl,
      name: card.name,
      version: card.version,
      interfaceUrl: card.interfaceUrl,
      providerOrigin: card.providerOrigin,
      skills: card.skills,
      scopes: Object.entries(card.delegation?.scopes ?? {}).map(([id, description]) => ({ id, description })),
      registration: registration
        ? { id: registration.id, audience: registration.audience, enabled: registration.enabled }
        : undefined,
    };
  }

  /** Identity-only connect (spec §4.4): card validation + enabled registration, then store. */
  async connectBrand(input: PactConnectBrandInput): Promise<PactConnectBrandResult> {
    const card = await this.fetchCard(input.agentCardUrl, input.signal);
    const registration = await this.options.registrations.findByOrigin(card.providerOrigin);
    if (!registration || !registration.enabled) {
      throw new ConnectionError(
        "pact_registration_required",
        `No enabled PACT registration covers ${card.providerOrigin}.`,
      );
    }
    const scopes = input.scopes ?? [];
    if (scopes.length > 0) {
      this.assertScopesAvailable(card.delegation?.scopes, scopes);
    }
    const credential = this.createCredential(input, card, registration.id);
    const stored = await this.options.store.setPactConnection(input.connectionName, credential);
    return this.connectResult(stored.id, stored.connectionName, credential);
  }

  /**
   * Reconnect an existing Brand connection by id: re-fetch and re-validate the
   * stored card URL (registration must still be enabled), keeping id and
   * connectionName stable.
   */
  async reconnectBrand(stored: StoredPactConnection): Promise<PactConnectBrandResult> {
    const credential = stored.credential;
    const card = await this.fetchCard(credential.cardUrl, undefined);
    const registration = await this.options.registrations.findByOrigin(card.providerOrigin);
    if (!registration || !registration.enabled) {
      throw new ConnectionError(
        "pact_registration_required",
        `No enabled PACT registration covers ${card.providerOrigin}.`,
      );
    }
    const next: PactConnectionCredential = {
      ...credential,
      cardUrl: credential.cardUrl,
      interfaceUrl: card.interfaceUrl,
      providerOrigin: card.providerOrigin,
      registrationId: registration.id,
      card: { name: card.name, version: card.version, skills: card.skills, fetchedAt: card.fetchedAt },
    };
    const updated = await this.options.store.updateCredential({ ...stored, credential: next });
    if (!updated) {
      throw new ConnectionError("connection_changed", "The connection changed during reconnect.");
    }
    return this.connectResult(stored.id, stored.connectionName, next);
  }

  private async fetchCard(agentCardUrl: string, signal: AbortSignal | undefined): Promise<PactAgentCard> {
    return fetchAgentCard(agentCardUrl, {
      fetcher: this.options.fetcher,
      allowInsecureLoopback: this.options.allowInsecureLoopback,
      signal,
    });
  }

  private assertScopesAvailable(cardScopes: Record<string, string> | undefined, requested: string[]): void {
    const advertised = new Set(Object.keys(cardScopes ?? {}));
    const unknown = requested.filter((scope) => !advertised.has(scope));
    if (unknown.length > 0) {
      throw new ConnectionError("invalid_scope", `The Brand card does not advertise scopes: ${unknown.join(", ")}.`);
    }
  }

  private createCredential(
    input: PactConnectBrandInput,
    card: PactAgentCard,
    registrationId: string,
  ): PactConnectionCredential {
    let brandDomain: string | undefined;
    try {
      brandDomain = new URL(input.agentCardUrl).hostname;
    } catch {
      brandDomain = undefined;
    }
    return {
      authType: "oauth2",
      source: "pact",
      cardUrl: input.agentCardUrl,
      brandDomain,
      interfaceUrl: card.interfaceUrl,
      providerOrigin: card.providerOrigin,
      registrationId,
      card: { name: card.name, version: card.version, skills: card.skills, fetchedAt: card.fetchedAt },
      profile: {
        accountId: card.providerOrigin,
        displayName: card.name,
        grantedScopes: input.scopes && input.scopes.length > 0 ? input.scopes : undefined,
      },
    };
  }

  private connectResult(
    id: string,
    connectionName: string,
    credential: PactConnectionCredential,
  ): PactConnectBrandResult {
    return {
      status: "connected",
      connectionId: id,
      connectionName,
      identityOnly: credential.delegation === undefined,
      card: {
        name: credential.card.name,
        version: credential.card.version,
        interfaceUrl: credential.interfaceUrl,
        providerOrigin: credential.providerOrigin,
      },
    };
  }

  /** Dispatch a catalog pact action (validated input) for a stored Brand connection. */
  async execute(input: PactActionExecutionInput): Promise<ExecutionResult> {
    try {
      switch (input.actionId) {
        case "pact.get_agent_card":
          return { ok: true, output: await this.refreshCard(input.connection.credential, input.signal) };
        case "pact.get_delegation":
          return { ok: true, output: this.readDelegation(input.connection.credential) };
        case "pact.send_message":
          return await this.runSendMessage(input);
        case "pact.request_scopes":
          return this.runRequestScopes(input);
        default:
          return { ok: false, error: { code: "unknown_action", message: `Unknown action: ${input.actionId}.` } };
      }
    } catch (error) {
      return this.mapError(error);
    }
  }

  /** Re-validate the stored card and keep the credential snapshot fresh. */
  private async refreshCard(credential: PactConnectionCredential, signal: AbortSignal | undefined) {
    const card = await this.fetchCard(credential.cardUrl, signal);
    return {
      name: card.name,
      version: card.version,
      interfaceUrl: card.interfaceUrl,
      providerOrigin: card.providerOrigin,
      skills: card.skills,
      delegation: card.delegation ? { scopes: card.delegation.scopes } : undefined,
    };
  }

  private readDelegation(credential: PactConnectionCredential): Record<string, unknown> {
    const delegation = credential.delegation;
    if (!delegation) {
      return { identityOnly: true };
    }
    return {
      identityOnly: false,
      grantId: delegation.grantId,
      grantedScopes: delegation.grantedScopes ?? [],
      expiresAt: delegation.expiresAt,
    };
  }

  private async runSendMessage(input: PactActionExecutionInput): Promise<ExecutionResult> {
    const body = optionalRecord(input.input) ?? {};
    const text = optionalString(body.text);
    if (text === undefined || text.length === 0) {
      return { ok: false, error: { code: "invalid_input", message: "text is required." } };
    }
    const contextId = optionalString(body.contextId);
    if (contextId !== undefined && new TextEncoder().encode(contextId).byteLength > pactContextIdMaxBytes) {
      return { ok: false, error: { code: "invalid_input", message: "contextId exceeds 256 bytes." } };
    }
    let reply;
    try {
      reply = await this.sendToBrand(input.connection, input.executionId, text, contextId, input.subject, input.signal);
    } catch (error) {
      // UNSUPPORTED_OPERATION is pact_context_closed only when a contextId was sent; without
      // one the provider rejected message:send outright, which is a provider failure (§4.4).
      if (error instanceof PactA2AError && error.reason === "UNSUPPORTED_OPERATION" && contextId === undefined) {
        return {
          ok: false,
          error: {
            code: "pact_provider_unavailable",
            message: error.message,
            details: { status: error.httpStatus, details: { reason: error.reason } },
          },
        };
      }
      throw error;
    }
    if (reply.kind === "message") {
      const message = reply.message;
      return {
        ok: true,
        output: {
          messageId: message.messageId ?? input.executionId,
          text: message.parts.map((part) => part.text ?? "").join(""),
          contextId: message.contextId,
        },
      };
    }
    const task = reply.task;
    if (task.state === "TASK_STATE_AUTH_REQUIRED") {
      const metadata = task.metadata;
      return {
        ok: false,
        error: {
          code: "pact_consent_required",
          message: "The Brand requires user consent for additional scopes.",
          details: {
            status: 202,
            details: {
              taskId: task.id,
              contextId: task.contextId,
              missingScopes: looseArray(metadata["pact.missingScopes"]).filter(
                (scope): scope is string => typeof scope === "string",
              ),
              verificationUriComplete: optionalString(metadata["pact.verificationUriComplete"]),
            },
          },
        },
      };
    }
    return {
      ok: true,
      output: { taskId: task.id, state: task.state, contextId: task.contextId },
    };
  }

  /** §4.5 plumbing stub: full device-flow initiation lands in PR5. */
  private runRequestScopes(input: PactActionExecutionInput): ExecutionResult {
    const body = optionalRecord(input.input) ?? {};
    const requested = looseArray(body.scopes).filter((scope): scope is string => typeof scope === "string");
    const granted = new Set(input.connection.credential.delegation?.grantedScopes ?? []);
    const missing = requested.filter((scope) => !granted.has(scope));
    if (missing.length === 0) {
      return { ok: true, output: { grantedScopes: [...granted] } };
    }
    return {
      ok: false,
      error: {
        code: "pact_consent_required",
        message: "The requested scopes need a delegation grant (device flow lands in a later phase).",
        details: { status: 202, details: { missingScopes: missing } },
      },
    };
  }

  /**
   * POST message:send with the §4.4 retry rules: one PA-JWT re-mint on 401,
   * one card refresh + retry on 404/405.
   */
  private async sendToBrand(
    connection: StoredPactConnection,
    executionId: string,
    text: string,
    contextId: string | undefined,
    subject: string | undefined,
    signal: AbortSignal | undefined,
  ) {
    const registration = await this.options.registrations.get(connection.credential.registrationId);
    if (!registration?.enabled) {
      throw new PactServiceError(
        "pact_registration_required",
        "The PACT registration this connection was authorized under is gone or disabled.",
      );
    }
    let active = connection;
    const paJwt = await this.signPaJwt(registration.audience, subject);
    try {
      return await this.postMessage(active.credential, paJwt, executionId, text, contextId, signal);
    } catch (error) {
      if (error instanceof PactA2AError && error.httpStatus === 401) {
        // One refresh: re-mint the PA-JWT (delegation-token refresh is PR5).
        return this.postMessage(
          active.credential,
          await this.signPaJwt(registration.audience, subject),
          executionId,
          text,
          contextId,
          signal,
        );
      }
      if (error instanceof PactA2AError && (error.httpStatus === 404 || error.httpStatus === 405)) {
        // The interface moved: re-validate the card once and retry on the new URL.
        const card = await this.fetchCard(active.credential.cardUrl, signal);
        if (card.interfaceUrl !== active.credential.interfaceUrl) {
          const next: StoredPactConnection = {
            ...active,
            credential: {
              ...active.credential,
              interfaceUrl: card.interfaceUrl,
              providerOrigin: card.providerOrigin,
              card: { name: card.name, version: card.version, skills: card.skills, fetchedAt: card.fetchedAt },
            },
          };
          // Best effort: a lost update only means the next call refreshes again.
          await this.options.store.updateCredential(next).catch(() => false);
          active = next;
          return this.postMessage(
            active.credential,
            await this.signPaJwt(registration.audience, subject),
            executionId,
            text,
            contextId,
            signal,
          );
        }
      }
      throw error;
    }
  }

  private async postMessage(
    credential: PactConnectionCredential,
    paJwt: string,
    executionId: string,
    text: string,
    contextId: string | undefined,
    signal: AbortSignal | undefined,
  ) {
    return sendPactMessage({
      interfaceUrl: credential.interfaceUrl,
      paJwt,
      delegationToken: this.readDelegationToken(credential),
      messageId: executionId,
      contextId,
      text,
      signal,
      fetcher: this.options.fetcher,
      allowInsecureLoopback: this.options.allowInsecureLoopback,
    });
  }

  /** Delegation tokens are injected only on the exact interfaceUrl origin (aud check at use time). */
  private readDelegationToken(credential: PactConnectionCredential): string | undefined {
    const delegation = credential.delegation;
    if (!delegation?.accessToken) {
      return undefined;
    }
    try {
      const issuer = new URL(delegation.tokenIssuer ?? credential.providerOrigin).origin;
      if (issuer !== new URL(credential.interfaceUrl).origin) {
        return undefined;
      }
    } catch {
      return undefined;
    }
    return delegation.accessToken;
  }

  private async signPaJwt(audience: string, subject: string | undefined): Promise<string> {
    const resolvedSubject = subject ?? (await this.options.identity.readDeploymentSubject());
    if (resolvedSubject === undefined) {
      throw new PactIdentityError("pact_identity_not_found", "No PACT identity exists yet.");
    }
    return this.options.identity.signPersonalAgentJwt({ subject: resolvedSubject, audience });
  }

  private mapError(error: unknown): ExecutionResult {
    if (error instanceof PactServiceError) {
      return { ok: false, error: { code: error.code, message: error.message, details: error.details } };
    }
    if (error instanceof PactA2AError) {
      if (error.httpStatus === 429 || error.httpStatus === 503) {
        return {
          ok: false,
          error: {
            code: error.httpStatus === 429 ? "rate_limited" : "pact_provider_unavailable",
            message: error.message,
            details: { status: error.httpStatus, details: { retryAfterSeconds: error.retryAfterSeconds } },
          },
        };
      }
      const code =
        error.reason === "INVALID_PARAMS" || error.reason === "CONTENT_TYPE_NOT_SUPPORTED"
          ? "invalid_input"
          : error.reason === "UNAUTHORIZED" || error.httpStatus === 401
            ? "pact_unauthorized"
            : error.reason === "UNSUPPORTED_OPERATION"
              ? "pact_context_closed"
              : "pact_provider_unavailable";
      return {
        ok: false,
        error: {
          code,
          message: error.message,
          details: { status: error.httpStatus, details: { reason: error.reason } },
        },
      };
    }
    if (error instanceof PactCardError) {
      return { ok: false, error: { code: error.code, message: error.message } };
    }
    if (error instanceof PactEgressError) {
      return { ok: false, error: { code: "pact_provider_unavailable", message: "PACT egress was rejected." } };
    }
    if (error instanceof PactIdentityError) {
      return {
        ok: false,
        error: { code: "pact_unauthorized", message: "The deployment cannot mint a PA-JWT right now." },
      };
    }
    if (error instanceof ConnectionError) {
      return { ok: false, error: { code: error.code, message: error.message } };
    }
    this.options.logger?.warn({ error: String(error) }, "pact action failed unexpectedly");
    return { ok: false, error: { code: "internal_error", message: "PACT action failed unexpectedly." } };
  }
}

/** Connect-side failures (route layer maps codes via mapConnectionErrorStatus). */
export class PactServiceError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "PactServiceError";
    this.code = code;
    this.details = details;
  }
}
