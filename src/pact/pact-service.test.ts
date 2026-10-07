import type {
  IConnectionStore,
  StoredConnection,
  StoredLocalConnection,
  StoredPactConnection,
} from "../connection-service.ts";
import type { ResolvedCredential } from "../core/types.ts";
import type { PactConnectionCredential } from "./pact-connection.ts";

import { afterEach, describe, expect, it } from "vitest";
import { AesGcmSecretCodec } from "../server/secrets/secret-codec.ts";
import { SqliteRuntimeDatabase } from "../server/storage/sqlite/runtime-store.ts";
import { PactIdentityService } from "./pact-identity-service.ts";
import { PactService } from "./pact-service.ts";
import { createMockPactProvider } from "./test/mock-provider.ts";

const codec = new AesGcmSecretCodec("test-encryption-key");
const databases: SqliteRuntimeDatabase[] = [];

class MemoryConnectionStore implements IConnectionStore {
  private readonly rows = new Map<string, StoredConnection>();

  async get(service: string, connectionName: string): Promise<StoredConnection | undefined> {
    return this.rows.get(`${service}:${connectionName}`);
  }

  async set(service: string, connectionName: string, credential: ResolvedCredential): Promise<StoredLocalConnection> {
    const connection: StoredLocalConnection = {
      id: crypto.randomUUID(),
      revision: crypto.randomUUID(),
      service,
      connectionName,
      credential,
    };
    this.rows.set(`${service}:${connectionName}`, connection);
    return connection;
  }

  async setPactConnection(connectionName: string, credential: PactConnectionCredential): Promise<StoredPactConnection> {
    const connection: StoredPactConnection = {
      source: "pact",
      id: crypto.randomUUID(),
      revision: crypto.randomUUID(),
      service: "pact",
      connectionName,
      credential,
    };
    this.rows.set(`pact:${connectionName}`, connection);
    return connection;
  }

  async updateCredential(input: StoredLocalConnection | StoredPactConnection): Promise<boolean> {
    const key = `${input.service}:${input.connectionName}`;
    const current = this.rows.get(key);
    if (current?.id !== input.id || current.revision !== input.revision) {
      return false;
    }
    this.rows.set(key, { ...input, revision: crypto.randomUUID() });
    return true;
  }

  async delete(service: string, connectionName: string): Promise<void> {
    this.rows.delete(`${service}:${connectionName}`);
  }

  async list(): Promise<StoredConnection[]> {
    return [...this.rows.values()];
  }
}

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

interface TestContext {
  service: PactService;
  store: MemoryConnectionStore;
  provider: ReturnType<typeof createMockPactProvider>;
  database: SqliteRuntimeDatabase;
}

async function createContext(options: { jwks?: boolean } = {}): Promise<TestContext> {
  const database = new SqliteRuntimeDatabase(":memory:", { secretCodec: codec });
  databases.push(database);
  const identity = new PactIdentityService({
    store: database.pactIdentityStore,
    secretCodec: codec,
    issuer: "http://localhost:3000",
  });
  await identity.create();
  const provider = createMockPactProvider();
  if (options.jwks !== false) {
    provider.setVerifierJwks(await identity.getJwks());
  }
  const store = new MemoryConnectionStore();
  const service = new PactService({
    store,
    registrations: database.pactRegistrationStore,
    identity,
    fetcher: provider.fetcher,
  });
  return { service, store, provider, database };
}

async function register(
  database: SqliteRuntimeDatabase,
  options: { enabled?: boolean; origin?: string; audience?: string } = {},
): Promise<void> {
  await database.pactRegistrationStore.create({
    id: crypto.randomUUID(),
    providerOrigin: options.origin ?? "https://provider.example.com",
    audience: options.audience ?? "https://provider.example.com",
    enabled: options.enabled ?? true,
    now: new Date().toISOString(),
  });
}

async function connect(context: TestContext): Promise<StoredPactConnection> {
  const result = await context.service.connectBrand({
    connectionName: "acme",
    agentCardUrl: context.provider.cardUrl,
  });
  const stored = await context.store.get("pact", result.connectionName);
  if (!stored || stored.source !== "pact") {
    throw new Error("pact connection not stored");
  }
  return stored;
}

function send(
  context: TestContext,
  connection: StoredPactConnection,
  input: unknown,
): ReturnType<PactService["execute"]> {
  return context.service.execute({
    actionId: "pact.send_message",
    connection,
    input,
    executionId: "exec-test-1",
    subject: "user-subject-1",
  });
}

describe("PactService connectBrand", () => {
  it("refuses a Brand origin with no registration", async () => {
    const context = await createContext();
    await expect(
      context.service.connectBrand({ connectionName: "acme", agentCardUrl: context.provider.cardUrl }),
    ).rejects.toMatchObject({ code: "pact_registration_required" });
  });

  it("refuses a Brand whose registration is disabled", async () => {
    const context = await createContext();
    await register(context.database, { enabled: false });
    await expect(
      context.service.connectBrand({ connectionName: "acme", agentCardUrl: context.provider.cardUrl }),
    ).rejects.toMatchObject({ code: "pact_registration_required" });
  });

  it("stores an identity-only Brand connection from a valid card + registration", async () => {
    const context = await createContext();
    await register(context.database);
    const result = await context.service.connectBrand({
      connectionName: "acme",
      agentCardUrl: context.provider.cardUrl,
    });
    expect(result).toMatchObject({
      status: "connected",
      connectionName: "acme",
      identityOnly: true,
      card: { name: "Mock Brand", interfaceUrl: context.provider.interfaceUrl },
    });
    const stored = await context.store.get("pact", "acme");
    expect(stored).toMatchObject({
      source: "pact",
      service: "pact",
      credential: {
        source: "pact",
        authType: "oauth2",
        cardUrl: context.provider.cardUrl,
        interfaceUrl: context.provider.interfaceUrl,
        providerOrigin: context.provider.origin,
      },
    });
  });

  it("rejects requested scopes the card does not advertise", async () => {
    const context = await createContext();
    await register(context.database);
    await expect(
      context.service.connectBrand({
        connectionName: "acme",
        agentCardUrl: context.provider.cardUrl,
        scopes: ["pact:admin"],
      }),
    ).rejects.toMatchObject({ code: "invalid_scope" });
  });
});

describe("PactService pact.send_message", () => {
  it("posts the wire contract: three headers, ROLE_USER part, executionId as messageId", async () => {
    const context = await createContext();
    await register(context.database);
    const connection = await connect(context);
    const result = await send(context, connection, { text: "where is my order?" });
    expect(result).toMatchObject({ ok: true });
    const request = context.provider.requests.at(-1)!;
    expect(request.headers["authorization"]).toMatch(/^Bearer /);
    expect(request.headers["a2a-version"]).toBe("1.0");
    expect(request.headers["content-type"]).toContain("application/json");
    expect(request.headers["x-a2a-user-delegation"]).toBeUndefined();
    expect(request.body).toMatchObject({
      message: {
        messageId: "exec-test-1",
        role: "ROLE_USER",
        parts: [{ text: "where is my order?", mediaType: "text/plain" }],
      },
    });
    // The mock verified the PA-JWT against Connect's JWKS with the origin as audience.
    expect(context.provider.verifiedTokens.at(-1)).toMatchObject({ sub: "user-subject-1" });
    const output = (result as { output: Record<string, unknown> }).output;
    expect(output.contextId).toEqual(expect.any(String));
    expect(output.text).toEqual(expect.any(String));
  });

  it("round-trips contextId back to the Brand", async () => {
    const context = await createContext();
    await register(context.database);
    const connection = await connect(context);
    await send(context, connection, { text: "hi", contextId: "ctx-42" });
    expect(context.provider.requests.at(-1)!.body).toMatchObject({
      message: { contextId: "ctx-42" },
    });
  });

  it("maps INVALID_PARAMS and CONTENT_TYPE_NOT_SUPPORTED to invalid_input", async () => {
    const context = await createContext();
    await register(context.database);
    const connection = await connect(context);
    for (const reason of ["INVALID_PARAMS", "CONTENT_TYPE_NOT_SUPPORTED"]) {
      context.provider.respondWith({ kind: "error", status: 400, reason });
      const result = await send(context, connection, { text: "hi" });
      expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    }
  });

  it("maps UNSUPPORTED_OPERATION by whether a contextId was sent", async () => {
    const context = await createContext();
    await register(context.database);
    const connection = await connect(context);
    context.provider.respondWith({ kind: "error", status: 400, reason: "UNSUPPORTED_OPERATION" });
    await expect(send(context, connection, { text: "hi" })).resolves.toMatchObject({
      ok: false,
      error: { code: "pact_provider_unavailable" },
    });
    context.provider.respondWith({ kind: "error", status: 400, reason: "UNSUPPORTED_OPERATION" });
    await expect(send(context, connection, { text: "hi", contextId: "ctx-stale" })).resolves.toMatchObject({
      ok: false,
      error: { code: "pact_context_closed" },
    });
  });

  it("refreshes the PA-JWT once on 401 then answers pact_unauthorized", async () => {
    const context = await createContext();
    await register(context.database);
    const connection = await connect(context);
    context.provider.respondWith({ kind: "error", status: 401 });
    context.provider.respondWith({ kind: "error", status: 401 });
    const result = await send(context, connection, { text: "hi" });
    expect(result).toMatchObject({ ok: false, error: { code: "pact_unauthorized" } });
    expect(context.provider.requests.length).toBe(2);
  });

  it("maps 404 to pact_provider_unavailable when the card interface is unchanged", async () => {
    const context = await createContext();
    await register(context.database);
    const connection = await connect(context);
    context.provider.respondWith({ kind: "error", status: 404, reason: "TASK_NOT_FOUND" });
    const result = await send(context, connection, { text: "hi" });
    expect(result).toMatchObject({ ok: false, error: { code: "pact_provider_unavailable" } });
  });

  it("re-fetches the card and retries on 404 when the interface moved", async () => {
    const context = await createContext();
    await register(context.database);
    const movedInterface = "https://provider.example.com/a2a-v2";
    context.provider.setCard({
      name: "Mock Brand",
      supportedInterfaces: [{ url: movedInterface, protocolBinding: "HTTP+JSON", protocolVersion: "1.0" }],
      provider: { url: context.provider.origin },
      securitySchemes: { paJwt: { httpAuthSecurityScheme: { scheme: "Bearer", bearerFormat: "JWT" } } },
      securityRequirements: [{ schemes: { paJwt: { list: [] } } }],
      skills: [],
    });
    // The connection stores the old interface; create it after the card swap is irrelevant —
    // reconnect the card back so connect stores the ORIGINAL interface first.
    const connection = await context.store.setPactConnection("acme-old", {
      authType: "oauth2",
      source: "pact",
      cardUrl: context.provider.cardUrl,
      interfaceUrl: context.provider.interfaceUrl,
      providerOrigin: context.provider.origin,
      registrationId: (await context.database.pactRegistrationStore.list())[0]!.id,
      card: { name: "Mock Brand", skills: [], fetchedAt: new Date().toISOString() },
      profile: { accountId: context.provider.origin, displayName: "Mock Brand" },
    });
    context.provider.respondWith({ kind: "error", status: 404 });
    const result = await send(context, connection, { text: "hi" });
    expect(result).toMatchObject({ ok: true });
    const stored = await context.store.get("pact", "acme-old");
    expect(stored?.source === "pact" && stored.credential.interfaceUrl).toBe(movedInterface);
  });

  it("preserves Retry-After on 429", async () => {
    const context = await createContext();
    await register(context.database);
    const connection = await connect(context);
    context.provider.respondWith({ kind: "error", status: 429, retryAfterSeconds: 17 });
    const result = await send(context, connection, { text: "hi" });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "rate_limited",
        details: { status: 429, details: { retryAfterSeconds: 17 } },
      },
    });
  });

  it("maps TASK_STATE_AUTH_REQUIRED to pact_consent_required with step-up details", async () => {
    const context = await createContext();
    await register(context.database);
    const connection = await connect(context);
    context.provider.respondWith({
      kind: "task",
      state: "TASK_STATE_AUTH_REQUIRED",
      missingScopes: ["pact:orders:write"],
      verificationUriComplete: "https://provider.example.com/consent?code=abc",
    });
    const result = await send(context, connection, { text: "refund order 9" });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "pact_consent_required",
        details: {
          status: 202,
          details: {
            missingScopes: ["pact:orders:write"],
            verificationUriComplete: expect.stringContaining("consent"),
          },
        },
      },
    });
  });

  it("rejects invalid input and oversized contextIds", async () => {
    const context = await createContext();
    await register(context.database);
    const connection = await connect(context);
    await expect(send(context, connection, { text: "" })).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    await expect(send(context, connection, { text: "hi", contextId: "x".repeat(300) })).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  });

  it("never leaks the PA-JWT into results", async () => {
    const context = await createContext();
    await register(context.database);
    const connection = await connect(context);
    const result = await send(context, connection, { text: "hi" });
    const paJwt = context.provider.requests.at(-1)!.headers["authorization"]!.slice(7);
    expect(JSON.stringify(result)).not.toContain(paJwt);
    expect(JSON.stringify(result)).not.toContain("authorization");
  });
});

describe("PactService read actions", () => {
  it("get_agent_card re-validates the stored card", async () => {
    const context = await createContext();
    await register(context.database);
    const connection = await connect(context);
    const result = await context.service.execute({
      actionId: "pact.get_agent_card",
      connection,
      input: {},
      executionId: "exec-1",
    });
    expect(result).toMatchObject({
      ok: true,
      output: { name: "Mock Brand", interfaceUrl: context.provider.interfaceUrl },
    });
  });

  it("get_delegation answers identityOnly on a fresh connection", async () => {
    const context = await createContext();
    await register(context.database);
    const connection = await connect(context);
    const result = await context.service.execute({
      actionId: "pact.get_delegation",
      connection,
      input: {},
      executionId: "exec-1",
    });
    expect(result).toMatchObject({ ok: true, output: { identityOnly: true } });
  });

  it("request_scopes answers pact_consent_required for missing scopes", async () => {
    const context = await createContext();
    await register(context.database);
    const connection = await connect(context);
    const result = await context.service.execute({
      actionId: "pact.request_scopes",
      connection,
      input: { scopes: ["pact:messages"] },
      executionId: "exec-1",
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "pact_consent_required",
        details: { status: 202, details: { missingScopes: ["pact:messages"] } },
      },
    });
  });

  it("fails sends when the registration is gone or disabled", async () => {
    const context = await createContext();
    await register(context.database);
    const connection = await connect(context);
    const registration = (await context.database.pactRegistrationStore.list())[0]!;
    await context.database.pactRegistrationStore.update(registration.id, {
      enabled: false,
      now: new Date().toISOString(),
    });
    const result = await send(context, connection, { text: "hi" });
    expect(result).toMatchObject({ ok: false, error: { code: "pact_registration_required" } });
  });
});
