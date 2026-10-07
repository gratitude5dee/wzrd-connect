import type { StoredPactConnection } from "../connection-service.ts";
import type { PactConsentPayload } from "./pact-delegation-service.ts";

import { afterEach, describe, expect, it, vi } from "vitest";
import { AesGcmSecretCodec } from "../server/secrets/secret-codec.ts";
import { SqliteRuntimeDatabase } from "../server/storage/sqlite/runtime-store.ts";
import { PactDelegationService, pactRequestOwner } from "./pact-delegation-service.ts";
import { PactIdentityService } from "./pact-identity-service.ts";
import { PactService } from "./pact-service.ts";
import { mockPactDelegationHeader } from "./test/mock-provider.ts";
import { createMockPactProvider } from "./test/mock-provider.ts";

const codec = new AesGcmSecretCodec("test-encryption-key");
const databases: SqliteRuntimeDatabase[] = [];
const issuer = "http://localhost:3000";

const brandScopes: Record<string, string> = {
  "orders:read": "Read orders",
  "orders:cancel": "Cancel orders",
};

function brandCard(origin: string, interfaceUrl: string): Record<string, unknown> {
  return {
    name: "Mock Brand",
    version: "1.0",
    supportedInterfaces: [{ url: interfaceUrl, protocolBinding: "HTTP+JSON", protocolVersion: "1.0" }],
    provider: { organization: "Mock Provider", url: origin },
    skills: [{ id: "orders", name: "Orders", description: "Order management", tags: ["orders"] }],
    securitySchemes: {
      paJwt: { httpAuthSecurityScheme: { scheme: "Bearer", bearerFormat: "JWT" } },
      userDelegation: {
        oauth2SecurityScheme: {
          flows: {
            deviceCode: {
              deviceAuthorizationUrl: `${origin}/oauth2/device_authorization`,
              tokenUrl: `${origin}/oauth2/token`,
              scopes: brandScopes,
            },
          },
          oauth2MetadataUrl: `${origin}/.well-known/oauth-authorization-server`,
        },
      },
    },
    securityRequirements: [
      { schemes: { paJwt: { list: [] } } },
      { schemes: { paJwt: { list: [] }, userDelegation: { list: [] } } },
    ],
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const database of databases.splice(0)) {
    database.close();
  }
});

interface TestContext {
  service: PactService;
  delegation: PactDelegationService;
  provider: ReturnType<typeof createMockPactProvider>;
  database: SqliteRuntimeDatabase;
}

async function createContext(): Promise<TestContext> {
  const database = new SqliteRuntimeDatabase(":memory:", { secretCodec: codec });
  databases.push(database);
  const identity = new PactIdentityService({
    store: database.pactIdentityStore,
    secretCodec: codec,
    issuer,
  });
  await identity.create();
  const provider = createMockPactProvider({
    card: brandCard("https://provider.example.com", "https://provider.example.com/a2a"),
  });
  provider.setVerifierJwks(await identity.getJwks());
  const delegation = new PactDelegationService({
    requests: database.connectionRequestStore,
    store: database.connectionStore,
    registrations: database.pactRegistrationStore,
    identity,
    allowInsecureLoopback: true,
    fetcher: provider.fetcher,
  });
  const service = new PactService({
    store: database.connectionStore,
    registrations: database.pactRegistrationStore,
    identity,
    delegation,
    fetcher: provider.fetcher,
  });
  return { service, delegation, provider, database };
}

async function register(database: SqliteRuntimeDatabase): Promise<void> {
  await database.pactRegistrationStore.create({
    id: crypto.randomUUID(),
    providerOrigin: "https://provider.example.com",
    audience: "https://provider.example.com",
    enabled: true,
    now: new Date().toISOString(),
  });
}

async function startConsent(context: TestContext, scopes: string[]): Promise<PactConsentPayload> {
  const result = await context.service.connectBrand({
    connectionName: "acme",
    agentCardUrl: context.provider.cardUrl,
    scopes,
  });
  if (result.status !== "consent_required") {
    throw new Error("expected consent_required");
  }
  return result.consent;
}

async function poll(context: TestContext, connectionRequestId: string) {
  return context.delegation.pollConnectionRequest(connectionRequestId, pactRequestOwner);
}

/** Reset next_poll_at so the next GET polls the token endpoint immediately. */
async function forcePollable(context: TestContext, connectionRequestId: string): Promise<void> {
  const row = await context.database.connectionRequestStore.readPactRequest(connectionRequestId, pactRequestOwner);
  if (!row) throw new Error("pending pact request not found");
  await context.database.connectionRequestStore.savePactPending(row.pending, 0);
}

function tokenCalls(provider: ReturnType<typeof createMockPactProvider>): number {
  return provider.requests.filter(
    (request) =>
      typeof request.body === "object" &&
      request.body !== null &&
      (request.body as { form?: { grant_type?: string } }).form?.grant_type !== undefined,
  ).length;
}

async function storedBrand(context: TestContext): Promise<StoredPactConnection> {
  const stored = await context.database.connectionStore.get("pact", "acme");
  if (!stored || stored.source !== "pact") {
    throw new Error("pact connection not stored");
  }
  return stored;
}

function sendText(context: TestContext, connection: StoredPactConnection, contextId?: string) {
  return context.service.execute({
    actionId: "pact.send_message",
    connection,
    input: { text: "hello", contextId },
    executionId: `exec-${crypto.randomUUID()}`,
    subject: "user-subject-1",
  });
}

describe("PactDelegationService device flow", () => {
  it("runs the happy path: pending → approve → verified grant on the connection", async () => {
    const context = await createContext();
    await register(context.database);
    const consent = await startConsent(context, ["orders:read"]);
    expect(consent.connectionRequestId).toEqual(expect.any(String));
    expect(consent.verificationUriComplete).toContain("user_code=");
    expect(consent.userCode).toEqual(expect.any(String));
    expect(consent.pollUrl).toBe(`/v1/connection-requests/${consent.connectionRequestId}`);
    expect(context.provider.oauth.pendingDeviceCodes.size).toBe(1);
    // The device-authorization call carried client_id + scope as a form.
    const deviceCall = context.provider.requests.at(-1)!;
    expect((deviceCall.body as { form: Record<string, string> }).form.scope).toBe("orders:read");
    expect((deviceCall.body as { form: Record<string, string> }).form.client_id).toBe(issuer);
    expect(context.provider.verifiedTokens.at(-1)?.aud).toBe("https://provider.example.com");

    // Empty poll script → authorization_pending keeps the request pending.
    const first = await poll(context, consent.connectionRequestId);
    expect(first).toMatchObject({ kind: "pending", retryAfterSeconds: 1 });
    expect(tokenCalls(context.provider)).toBe(1);

    // The interval gate: an immediate second poll must not hit the endpoint again.
    const second = await poll(context, consent.connectionRequestId);
    expect(second?.kind).toBe("pending");
    expect(tokenCalls(context.provider)).toBe(1);

    // Approve with a subset: scope is read from the token response.
    context.provider.oauth.pollScript.push({ kind: "approve", grantedScopes: ["orders:read"] });
    await forcePollable(context, consent.connectionRequestId);
    const committed = await poll(context, consent.connectionRequestId);
    expect(committed?.kind).toBe("connected");

    const stored = await storedBrand(context);
    expect(stored.credential.delegation?.accessToken).toEqual(expect.any(String));
    expect(stored.credential.delegation?.refreshToken).toEqual(expect.any(String));
    expect(stored.credential.delegation?.grantedScopes).toEqual(["orders:read"]);
    expect(stored.credential.profile.accountId).toBe("person-1");
    expect(stored.credential.profile.grantedScopes).toEqual(["orders:read"]);

    // A send now attaches the delegation token to the interface origin.
    const send = await sendText(context, stored);
    expect(send).toMatchObject({ ok: true });
    const last = context.provider.requests.at(-1);
    expect(last?.headers[mockPactDelegationHeader]).toBe(`Bearer ${stored.credential.delegation?.accessToken}`);

    // get_delegation reports grant facts and never the token values.
    const delegation = await context.service.execute({
      actionId: "pact.get_delegation",
      connection: stored,
      input: {},
      executionId: "exec-get",
    });
    expect(delegation).toMatchObject({
      ok: true,
      output: { identityOnly: false, grantedScopes: ["orders:read"], needsReauthorization: false },
    });
    expect(JSON.stringify(delegation)).not.toContain(stored.credential.delegation!.accessToken!);
  });

  it("rejects scope ids the card does not advertise", async () => {
    const context = await createContext();
    await register(context.database);
    await expect(
      context.service.connectBrand({
        connectionName: "acme",
        agentCardUrl: context.provider.cardUrl,
        scopes: ["orders:read", "orders:delete"],
      }),
    ).rejects.toMatchObject({ code: "invalid_scope" });
    // Nothing was posted to the Brand.
    expect(context.provider.requests).toHaveLength(0);
    await expect(context.database.connectionStore.get("pact", "acme")).resolves.toBeUndefined();
  });

  it("slow_down raises the poll interval by five seconds", async () => {
    const context = await createContext();
    await register(context.database);
    const consent = await startConsent(context, ["orders:read"]);
    context.provider.oauth.pollScript.push({ kind: "slow_down" }, { kind: "approve" });
    const slowed = await poll(context, consent.connectionRequestId);
    expect(slowed).toMatchObject({ kind: "pending", retryAfterSeconds: 6 });
    const row = await context.database.connectionRequestStore.readPactRequest(
      consent.connectionRequestId,
      pactRequestOwner,
    );
    expect(row?.pending.pollIntervalSeconds).toBe(6);

    await forcePollable(context, consent.connectionRequestId);
    expect((await poll(context, consent.connectionRequestId))?.kind).toBe("connected");
  });

  it("access_denied lands terminal denied", async () => {
    const context = await createContext();
    await register(context.database);
    const consent = await startConsent(context, ["orders:read"]);
    context.provider.oauth.pollScript.push({ kind: "deny" });
    expect((await poll(context, consent.connectionRequestId))?.kind).toBe("denied");
    const request = await context.database.connectionRequestStore.get(consent.connectionRequestId, pactRequestOwner);
    expect(request).toMatchObject({ status: "failed", errorCode: "pact_consent_denied" });
    // Terminal outcomes repeat without hitting the endpoint.
    expect((await poll(context, consent.connectionRequestId))?.kind).toBe("denied");
  });

  it("expired_token lands terminal expired", async () => {
    const context = await createContext();
    await register(context.database);
    const consent = await startConsent(context, ["orders:read"]);
    context.provider.oauth.pollScript.push({ kind: "expired" });
    expect((await poll(context, consent.connectionRequestId))?.kind).toBe("expired");
    const request = await context.database.connectionRequestStore.get(consent.connectionRequestId, pactRequestOwner);
    expect(request?.errorCode).toBe("pact_consent_expired");
  });

  it("a request past expiresAt expires without hitting the token endpoint", async () => {
    const context = await createContext();
    await register(context.database);
    const consent = await startConsent(context, ["orders:read"]);
    const row = await context.database.connectionRequestStore.readPactRequest(
      consent.connectionRequestId,
      pactRequestOwner,
    );
    await context.database.connectionRequestStore.savePactPending(
      { ...row!.pending, expiresAt: new Date(Date.now() - 1000).toISOString() },
      0,
    );
    expect((await poll(context, consent.connectionRequestId))?.kind).toBe("expired");
    expect(tokenCalls(context.provider)).toBe(0);
  });

  it("rejects a token minted for a different client_id", async () => {
    const context = await createContext();
    await register(context.database);
    const consent = await startConsent(context, ["orders:read"]);
    context.provider.oauth.tokenClaimOverrides = { client_id: "https://evil.example.com" };
    context.provider.oauth.pollScript.push({ kind: "approve" });
    const outcome = await poll(context, consent.connectionRequestId);
    expect(outcome?.kind).toBe("failed");
    const request = await context.database.connectionRequestStore.get(consent.connectionRequestId, pactRequestOwner);
    expect(request?.errorCode).toBe("pact_consent_failed");
    expect((await storedBrand(context)).credential.delegation?.accessToken).toBeUndefined();
  });

  it("rejects a token minted for a different audience", async () => {
    const context = await createContext();
    await register(context.database);
    const consent = await startConsent(context, ["orders:read"]);
    context.provider.oauth.tokenAudience = "https://evil.example.com";
    context.provider.oauth.pollScript.push({ kind: "approve" });
    expect((await poll(context, consent.connectionRequestId))?.kind).toBe("failed");
    expect(
      (await context.database.connectionRequestStore.get(consent.connectionRequestId, pactRequestOwner))?.errorCode,
    ).toBe("pact_consent_failed");
  });
});

describe("PactDelegationService refresh", () => {
  async function granted(context: TestContext, expiresIn: number): Promise<StoredPactConnection> {
    const consent = await startConsent(context, ["orders:read"]);
    context.provider.oauth.pollScript.push({ kind: "approve", grantedScopes: ["orders:read"], expiresIn });
    await poll(context, consent.connectionRequestId);
    return storedBrand(context);
  }

  it("refreshes inside the 60 s window and rotates the refresh token", async () => {
    const context = await createContext();
    await register(context.database);
    const stored = await granted(context, 30);
    const firstRefresh = stored.credential.delegation!.refreshToken!;

    context.provider.oauth.pollScript.push({
      kind: "approve",
      grantedScopes: ["orders:read"],
      refreshToken: "refresh-rotated",
      expiresIn: 900,
    });
    const send = await sendText(context, stored);
    expect(send).toMatchObject({ ok: true });

    const updated = await storedBrand(context);
    expect(updated.credential.delegation?.refreshToken).toBe("refresh-rotated");
    expect(updated.credential.delegation?.refreshToken).not.toBe(firstRefresh);
    expect(updated.credential.delegation?.accessToken).not.toBe(stored.credential.delegation?.accessToken);
    // device_code grant + refresh_token grant hit the token endpoint.
    const refresh = context.provider.requests.find(
      (request) => (request.body as { form?: { grant_type?: string } }).form?.grant_type === "refresh_token",
    );
    expect((refresh!.body as { form: { refresh_token?: string } }).form.refresh_token).toBe("<present>");
  });

  it("does not refresh when expiresAt is outside the window", async () => {
    const context = await createContext();
    await register(context.database);
    const stored = await granted(context, 900);
    const send = await sendText(context, stored);
    expect(send).toMatchObject({ ok: true });
    const updated = await storedBrand(context);
    expect(updated.credential.delegation?.accessToken).toBe(stored.credential.delegation?.accessToken);
  });

  it("invalid_grant clears the grant and flags needsReauthorization", async () => {
    const context = await createContext();
    await register(context.database);
    const stored = await granted(context, 30);
    context.provider.oauth.pollScript.push({ kind: "error", error: "invalid_grant" });
    const send = await sendText(context, stored);
    expect(send).toMatchObject({
      ok: false,
      error: { code: "pact_unauthorized" },
    });
    expect((send.error?.details as { details?: { missingScopes?: string[] } })?.details?.missingScopes).toEqual([
      "orders:read",
    ]);
    const updated = await storedBrand(context);
    expect(updated.credential.delegation?.accessToken).toBeUndefined();
    expect(updated.credential.delegation?.needsReauthorization).toBe(true);
    expect(updated.credential.profile.grantedScopes).toBeUndefined();
  });

  it("serializes concurrent refreshes per connection", async () => {
    const context = await createContext();
    await register(context.database);
    const stored = await granted(context, 30);
    context.provider.oauth.pollScript.push({ kind: "approve", grantedScopes: ["orders:read"], expiresIn: 900 });
    const [a, b] = await Promise.all([
      context.delegation.refreshGrant(stored),
      context.delegation.refreshGrant(stored),
    ]);
    expect(a.credential.delegation?.accessToken).toBe(b.credential.delegation?.accessToken);
    const refreshCalls = context.provider.requests.filter(
      (request) => (request.body as { form?: { grant_type?: string } }).form?.grant_type === "refresh_token",
    );
    expect(refreshCalls).toHaveLength(1);
  });
});

describe("PACT step-up", () => {
  it("TASK_STATE_AUTH_REQUIRED starts a device flow for missing ∪ granted and retries in context", async () => {
    const context = await createContext();
    await register(context.database);
    const consent = await startConsent(context, ["orders:read"]);
    context.provider.oauth.pollScript.push({ kind: "approve", grantedScopes: ["orders:read"] });
    await poll(context, consent.connectionRequestId);
    const stored = await storedBrand(context);

    // The Brand asks for orders:cancel mid-conversation (contextId ctx-step).
    context.provider.respondWith({
      kind: "task",
      state: "TASK_STATE_AUTH_REQUIRED",
      missingScopes: ["orders:cancel"],
      verificationUriComplete: "https://provider.example.com/device?user_code=step-1",
      contextId: "ctx-step",
    });
    const stepUp = await sendText(context, stored);
    expect(stepUp).toMatchObject({ ok: false, error: { code: "pact_consent_required" } });
    const details = (stepUp.error?.details as { details?: Record<string, unknown> })?.details ?? {};
    expect(details.status).toBeUndefined();
    expect(details.contextId).toBe("ctx-step");
    expect(details.missingScopes).toEqual(["orders:cancel"]);
    // PACT §5.5: the agent's own device-flow link wins over the task's
    // pact.verificationUriComplete — on the reference Provider that link binds
    // to a Provider-created device code Connect cannot poll.
    expect(details.verificationUriComplete).toBe(`https://provider.example.com/device?user_code=${details.userCode}`);
    const stepUpRequestId = details.connectionRequestId as string;

    // The new device request asked for the union of granted + missing scopes.
    const deviceCall = context.provider.requests.at(-1)!;
    expect((deviceCall.body as { form: { scope: string } }).form.scope.split(" ").sort()).toEqual([
      "orders:cancel",
      "orders:read",
    ]);

    // Consent adds the scope; the stored grant is the union.
    context.provider.oauth.pollScript.push({ kind: "approve" });
    await poll(context, stepUpRequestId);
    const updated = await storedBrand(context);
    expect(updated.credential.delegation?.grantedScopes?.sort()).toEqual(["orders:cancel", "orders:read"]);

    // The retried message succeeds.
    const retry = await sendText(context, updated, "ctx-step");
    expect(retry).toMatchObject({ ok: true });
    const last = context.provider.requests.at(-1);
    expect(last?.headers[mockPactDelegationHeader]).toBe(`Bearer ${updated.credential.delegation?.accessToken}`);
  });

  it("pact.request_scopes short-circuits granted ids and starts a flow for the rest", async () => {
    const context = await createContext();
    await register(context.database);
    const consent = await startConsent(context, ["orders:read"]);
    context.provider.oauth.pollScript.push({ kind: "approve", grantedScopes: ["orders:read"] });
    await poll(context, consent.connectionRequestId);
    const stored = await storedBrand(context);

    const covered = await context.service.execute({
      actionId: "pact.request_scopes",
      connection: stored,
      input: { scopes: ["orders:read"] },
      executionId: "exec-scopes-1",
    });
    expect(covered).toMatchObject({ ok: true, output: { grantedScopes: ["orders:read"] } });
    expect(tokenCalls(context.provider)).toBe(1); // only the original commit

    const ask = await context.service.execute({
      actionId: "pact.request_scopes",
      connection: stored,
      input: { scopes: ["orders:cancel"] },
      executionId: "exec-scopes-2",
    });
    expect(ask).toMatchObject({ ok: false, error: { code: "pact_consent_required" } });
    const details = (ask.error?.details as { details?: Record<string, unknown> })?.details ?? {};
    expect(details.missingScopes).toEqual(["orders:cancel"]);
    expect(details.connectionRequestId).toEqual(expect.any(String));
  });

  it("connectBrand answers connected without a new consent when scopes are already granted", async () => {
    const context = await createContext();
    await register(context.database);
    const consent = await startConsent(context, ["orders:read"]);
    context.provider.oauth.pollScript.push({ kind: "approve", grantedScopes: ["orders:read", "orders:cancel"] });
    await poll(context, consent.connectionRequestId);
    const deviceCalls = () =>
      context.provider.requests.filter(
        (request) => (request.body as { form?: { scope?: string } }).form?.scope !== undefined,
      ).length;
    expect(deviceCalls()).toBe(1);

    const reconnect = await context.service.connectBrand({
      connectionName: "acme",
      agentCardUrl: context.provider.cardUrl,
      scopes: ["orders:read"],
    });
    expect(reconnect.status).toBe("connected");
    expect(deviceCalls()).toBe(1);
    const stored = await storedBrand(context);
    expect(stored.credential.delegation?.grantedScopes).toEqual(["orders:read", "orders:cancel"]);
  });
});

describe("PACT revocation", () => {
  it("posts the refresh token when the provider advertises revocation_endpoint", async () => {
    const context = await createContext();
    context.provider.oauth.revocationAdvertised = true;
    await register(context.database);
    const consent = await startConsent(context, ["orders:read"]);
    context.provider.oauth.pollScript.push({
      kind: "approve",
      grantedScopes: ["orders:read"],
      refreshToken: "refresh-revoke-me",
    });
    await poll(context, consent.connectionRequestId);
    const stored = await storedBrand(context);
    expect(await context.delegation.revokeGrant(stored)).toBe("done");
    expect(context.provider.oauth.revokedTokens).toEqual(["refresh-revoke-me"]);
  });

  it("reports unsupported when the metadata advertises no revocation_endpoint", async () => {
    const context = await createContext();
    await register(context.database);
    const consent = await startConsent(context, ["orders:read"]);
    context.provider.oauth.pollScript.push({ kind: "approve", grantedScopes: ["orders:read"] });
    await poll(context, consent.connectionRequestId);
    const stored = await storedBrand(context);
    expect(await context.delegation.revokeGrant(stored)).toBe("unsupported");
  });

  it("reports skipped when no refresh token exists", async () => {
    const context = await createContext();
    context.provider.oauth.issueRefreshToken = false;
    context.provider.oauth.revocationAdvertised = true;
    await register(context.database);
    const consent = await startConsent(context, ["orders:read"]);
    context.provider.oauth.pollScript.push({ kind: "approve", grantedScopes: ["orders:read"] });
    await poll(context, consent.connectionRequestId);
    const stored = await storedBrand(context);
    expect(await context.delegation.revokeGrant(stored)).toBe("skipped");
  });
});
