import type { Context } from "hono";
import type { SignJWT } from "jose";

import { Hono } from "hono";
import { pactDelegationHeader } from "../a2a-client.ts";

/**
 * Appendix B mock Provider: an in-process Hono app standing in for a PACT
 * Brand host. Tests inject `provider.fetcher` into PactService / fetchAgentCard
 * so no sockets are opened. Every behavior is configurable — error envelopes,
 * step-up tasks, 401s, 429s — so later phases reuse the same fixture for the
 * device-flow and receipt tests.
 */
export interface MockPactProvider {
  /** Pass as `fetcher` to PactService/fetchAgentCard/sendPactMessage. */
  fetcher: typeof fetch;
  /** Public origin the fixture answers for. */
  origin: string;
  cardUrl: string;
  interfaceUrl: string;
  /** Requests received by message:send (raw headers + parsed body), oldest first. */
  readonly requests: MockPactRequest[];
  /** PA-JWTs the fixture verified and the claims it saw. */
  readonly verifiedTokens: Record<string, unknown>[];
  /** Replace the agent card served at `/.well-known/agent-card.json`. */
  setCard(card: unknown): void;
  /** Queue the next `message:send` reply shape. */
  respondWith(behavior: MockPactBehavior): void;
  /** JWKS the fixture verifies PA-JWTs against (Connect's served key set). */
  setVerifierJwks(jwks: { keys: unknown[] }): void;
  /** Expected PA-JWT audience — defaults to the provider origin. */
  setExpectedAudience(audience: string): void;
  /** Device-flow state and scripting knobs (spec Appendix B). */
  readonly oauth: MockPactOAuth;
  /** The JWKS the fixture mints delegation tokens with (public half). */
  signerJwks(): Promise<{ keys: unknown[] }>;
  /** §5.6 receipt minting on `message:send` replies; mutate `recipe` per test. */
  readonly receipts: { recipe: MockPactReceiptRecipe };
}

/** Receipt minting recipe — `valid` is the compliant-Brand default. */
export type MockPactReceiptRecipe =
  | "valid"
  | "none"
  | "payload_mismatch"
  | "wrong_grant"
  | "wrong_issuer"
  | "bad_signature";

export interface MockPactRequest {
  headers: Record<string, string>;
  body: unknown;
}

/** One queued `message:send` behavior; `default` is a plain text reply. */
export type MockPactBehavior =
  | { kind: "reply"; text?: string; contextId?: string }
  | { kind: "error"; status: number; reason?: string; message?: string; retryAfterSeconds?: number }
  | { kind: "task"; state: string; missingScopes?: string[]; verificationUriComplete?: string; contextId?: string }
  | { kind: "redirect"; location: string };

/** One scripted answer a token-endpoint call pops; empty queue → authorization_pending. */
export type MockTokenPoll =
  | { kind: "approve"; grantedScopes?: string[]; refreshToken?: string; expiresIn?: number }
  | { kind: "deny" }
  | { kind: "slow_down" }
  | { kind: "expired" }
  | { kind: "error"; error: string; status?: number };

export interface MockPactProviderOptions {
  /** Origin the mock claims; default `https://provider.example.com`. */
  origin?: string;
  /** A2A interface path below the origin; default `/a2a`. */
  interfacePath?: string;
  /** Card body override served at the well-known card path. */
  card?: unknown;
  /** Static card served at a redirect source path (see `cardRedirect`). */
  cardRedirect?: { path: string; location: string };
  /** Starting §5.6 receipt recipe (default `valid`); mutable via `provider.receipts.recipe`. */
  receiptRecipe?: MockPactReceiptRecipe;
}

/** Device-flow knobs the fixture exposes (spec Appendix B). */
export interface MockPactOAuth {
  /** Answers the token endpoint pops per call; empty → `authorization_pending`. */
  pollScript: MockTokenPoll[];
  /** `interval` the device-authorization response advertises (default 1 s). */
  interval: number;
  /** `expires_in` the device-authorization response advertises (default 600 s). */
  expiresIn: number;
  /** Advertise `revocation_endpoint` in metadata and accept /oauth2/revoke. */
  revocationAdvertised: boolean;
  /** Extra claims merged into every minted delegation token (e.g. client_id). */
  tokenClaimOverrides: Record<string, unknown>;
  /** Token `aud` override (defaults to the interface URL) — for claim-mismatch tests. */
  tokenAudience?: string;
  /** Token `iss` override (defaults to the provider origin). */
  tokenIssuer?: string;
  /** Outstanding device_code values the fixture issued. */
  pendingDeviceCodes: Set<string>;
  /** Token values the revoke endpoint accepted (revocation reporting tests). */
  revokedTokens: string[];
  /** When set, the device-authorization endpoint answers `{error}` with 400. */
  deviceAuthorizationError?: string;
  /** The next `user_code` (default `user-<n>`). */
  nextUserCode?: string;
  /** The next `verification_uri_complete` (default `<origin>/device?user_code=…`). */
  verificationUriComplete?: string;
  /** Whether token responses carry `refresh_token` (default true). */
  issueRefreshToken: boolean;
}

export function createMockPactProvider(options: MockPactProviderOptions = {}): MockPactProvider {
  const origin = options.origin ?? "https://provider.example.com";
  const interfacePath = options.interfacePath ?? "/a2a";
  const interfaceUrl = `${origin}${interfacePath}`;
  const receipts = { recipe: options.receiptRecipe ?? ("valid" as const) };
  const requests: MockPactRequest[] = [];
  const verifiedTokens: Record<string, unknown>[] = [];
  let verifierJwks: { keys: unknown[] } | undefined;
  let expectedAudience = origin;
  let card: unknown = options.card ?? defaultCard(origin, interfaceUrl);
  const behaviors: MockPactBehavior[] = [];

  const oauth: MockPactOAuth = {
    pollScript: [],
    interval: 1,
    expiresIn: 600,
    revocationAdvertised: false,
    tokenClaimOverrides: {},
    pendingDeviceCodes: new Set<string>(),
    revokedTokens: [],
    issueRefreshToken: true,
  };
  // Delegation tokens are minted with a fixture-owned ES256 key, lazily so
  // card-only tests never pay for keygen. Public half is served at jwks.json.
  const pendingScopes = new Map<string, string>();
  const pendingClients = new Map<string, string>();
  let signerKey: { publicJwk: Record<string, unknown>; privateKey: Parameters<SignJWT["sign"]>[0] } | undefined;
  const ensureSignerKey = async () => {
    if (!signerKey) {
      const { generateKeyPair, exportJWK } = await import("jose");
      const pair = await generateKeyPair("ES256", { extractable: true });
      const publicJwk = (await exportJWK(pair.publicKey)) as Record<string, unknown>;
      publicJwk.alg = "ES256";
      publicJwk.kid = "mock-brand-1";
      signerKey = { publicJwk, privateKey: pair.privateKey };
    }
    return signerKey;
  };
  /** Decode the payload of an inbound JWT header value; undefined when absent. */
  const readJwtPayload = (value: string | undefined): Record<string, unknown> | undefined => {
    const token = value?.startsWith("Bearer ") ? value.slice(7) : value;
    const parts = token?.split(".");
    if (!parts || parts.length !== 3) {
      return undefined;
    }
    try {
      const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
      return typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * §5.6: mint `metadata["pact.receipt"]` for a completed reply. Claims carry
   * `pa` (the Connect issuer, read off the inbound PA-JWT `iss`), the
   * delegation `grantId` + scopes (off the inbound `X-A2A-User-Delegation`),
   * and `iat`; the JWS payload is the same object. `bad_signature` corrupts
   * the signature segment so verification against the served JWKS fails.
   */
  const mintReceipt = async (
    headers: Record<string, string>,
  ): Promise<{ jws: string; claims: Record<string, unknown> } | undefined> => {
    if (receipts.recipe === "none") {
      return undefined;
    }
    const paJwt = readJwtPayload(headers["authorization"]);
    const delegation = readJwtPayload(headers[pactDelegationHeader.toLowerCase()]);
    const claims: Record<string, unknown> = {
      pa: receipts.recipe === "wrong_issuer" ? `${String(paJwt?.iss ?? "")}.evil` : paJwt?.iss,
      grantId: receipts.recipe === "wrong_grant" ? `grant-other-${crypto.randomUUID()}` : delegation?.grant_id,
      scopes: typeof delegation?.scope === "string" ? delegation.scope.split(" ").filter(Boolean) : [],
      iat: Math.floor(Date.now() / 1000),
    };
    const key = await ensureSignerKey();
    const { SignJWT } = await import("jose");
    let jws = await new SignJWT(claims).setProtectedHeader({ alg: "ES256", kid: "mock-brand-1" }).sign(key.privateKey);
    if (receipts.recipe === "bad_signature") {
      jws = `${jws.slice(0, -4)}AAAA`;
    }
    return {
      jws,
      claims: receipts.recipe === "payload_mismatch" ? { ...claims, tampered: true } : claims,
    };
  };

  const mintToken = async (input: { clientId: string; scope: string; expiresIn: number }): Promise<string> => {
    const key = await ensureSignerKey();
    const { SignJWT } = await import("jose");
    return new SignJWT({
      client_id: input.clientId,
      scope: input.scope,
      grant_id: `grant-${crypto.randomUUID()}`,
      ...oauth.tokenClaimOverrides,
    })
      .setProtectedHeader({ alg: "ES256", kid: "mock-brand-1" })
      .setSubject("person-1")
      .setAudience(oauth.tokenAudience ?? interfaceUrl)
      .setIssuer(oauth.tokenIssuer ?? origin)
      .setIssuedAt()
      .setJti(crypto.randomUUID())
      .setExpirationTime(Math.floor(Date.now() / 1000) + input.expiresIn)
      .sign(key.privateKey);
  };

  const app = new Hono();
  app.get("/.well-known/agent-card.json", (context) => context.json(card as object));
  if (options.cardRedirect) {
    app.get(options.cardRedirect.path, (context) => context.redirect(options.cardRedirect!.location));
  }
  // RFC 8628 device authorization: verifies the PA-JWT, issues a device_code.
  app.post("/oauth2/device_authorization", async (context) => {
    const headers = bearerHeaders(context);
    const auth = await verifyPaJwt(context, headers, verifierJwks, expectedAudience, verifiedTokens);
    if (auth !== undefined) {
      return auth;
    }
    if (oauth.deviceAuthorizationError) {
      return context.json({ error: oauth.deviceAuthorizationError }, 400);
    }
    const form = await context.req.parseBody();
    const clientId = typeof form.client_id === "string" ? form.client_id : undefined;
    if (!clientId) {
      return context.json({ error: "invalid_client" }, 400);
    }
    const scope = typeof form.scope === "string" ? form.scope : "";
    const deviceCode = `device-${crypto.randomUUID()}`;
    const userCode = oauth.nextUserCode ?? `user-${crypto.randomUUID().slice(0, 8)}`;
    oauth.pendingDeviceCodes.add(deviceCode);
    pendingScopes.set(deviceCode, scope);
    pendingClients.set(deviceCode, clientId);
    requests.push({ headers, body: { form: { client_id: clientId, scope } } });
    return context.json({
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `${origin}/device`,
      verification_uri_complete: oauth.verificationUriComplete ?? `${origin}/device?user_code=${userCode}`,
      expires_in: oauth.expiresIn,
      interval: oauth.interval,
    });
  });
  // Token endpoint: device_code grant pops the poll script; refresh_token the same.
  app.post("/oauth2/token", async (context) => {
    const headers = bearerHeaders(context);
    const auth = await verifyPaJwt(context, headers, verifierJwks, expectedAudience, verifiedTokens);
    if (auth !== undefined) {
      return auth;
    }
    const form = await context.req.parseBody();
    const grantType = typeof form.grant_type === "string" ? form.grant_type : "";
    requests.push({
      headers,
      body: {
        form: {
          grant_type: grantType,
          device_code: form.device_code,
          refresh_token: form.refresh_token ? "<present>" : undefined,
          client_id: form.client_id,
        },
      },
    });
    const poll = oauth.pollScript.length > 0 ? oauth.pollScript.shift() : undefined;
    if (poll?.kind === "deny") {
      return context.json({ error: "access_denied" }, 400);
    }
    if (poll?.kind === "slow_down") {
      return context.json({ error: "slow_down" }, 400);
    }
    if (poll?.kind === "expired") {
      return context.json({ error: "expired_token" }, 400);
    }
    if (poll?.kind === "error") {
      return context.json({ error: poll.error }, (poll.status ?? 400) as never);
    }
    if (!poll || poll.kind !== "approve") {
      return context.json({ error: "authorization_pending" }, 400);
    }
    const clientId =
      grantType === "urn:ietf:params:oauth:grant-type:device_code"
        ? (pendingClients.get(String(form.device_code)) ?? "")
        : typeof form.client_id === "string"
          ? form.client_id
          : "";
    const requested =
      grantType === "urn:ietf:params:oauth:grant-type:device_code"
        ? (pendingScopes.get(String(form.device_code)) ?? "")
        : "";
    const scope = poll.grantedScopes?.join(" ") ?? requested;
    const expiresIn = poll.expiresIn ?? 900;
    const accessToken = await mintToken({ clientId, scope, expiresIn });
    oauth.pendingDeviceCodes.delete(String(form.device_code));
    return context.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      refresh_token:
        oauth.issueRefreshToken || poll.refreshToken
          ? (poll.refreshToken ?? `refresh-${crypto.randomUUID()}`)
          : undefined,
      scope,
    });
  });
  app.post("/oauth2/revoke", async (context) => {
    if (!oauth.revocationAdvertised) {
      return context.notFound();
    }
    const headers = bearerHeaders(context);
    const auth = await verifyPaJwt(context, headers, verifierJwks, expectedAudience, verifiedTokens);
    if (auth !== undefined) {
      return auth;
    }
    const form = await context.req.parseBody();
    if (typeof form.token === "string") {
      oauth.revokedTokens.push(form.token);
    }
    return context.body(null, 200);
  });
  // Any path ending in /message:send answers: a card refresh can move the
  // interface (404 tests), and each declared interface must keep working.
  app.post("/*", async (context) => {
    if (!context.req.path.endsWith("/message:send")) {
      return context.notFound();
    }
    const headers: Record<string, string> = {};
    context.req.raw.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      body = undefined;
    }
    requests.push({ headers, body });
    const behavior = behaviors.length > 0 ? behaviors.shift() : { kind: "reply" as const };
    if (behavior?.kind === "redirect") {
      return context.redirect(behavior.location);
    }
    const auth = await verifyPaJwt(context, headers, verifierJwks, expectedAudience, verifiedTokens);
    if (auth !== undefined) {
      return auth;
    }
    if (behavior?.kind === "error") {
      if (behavior.retryAfterSeconds !== undefined) {
        context.header("Retry-After", String(behavior.retryAfterSeconds));
      }
      return a2aError(context, behavior.status, behavior.reason ?? "INTERNAL_ERROR", behavior.message);
    }
    if (behavior?.kind === "task") {
      const receipt = behavior.state !== "TASK_STATE_AUTH_REQUIRED" ? await mintReceipt(headers) : undefined;
      return context.json({
        task: {
          id: `task-${crypto.randomUUID()}`,
          contextId: behavior.contextId ?? `ctx-${crypto.randomUUID()}`,
          status: { state: behavior.state },
          metadata: {
            "pact.missingScopes": behavior.missingScopes ?? [],
            "pact.verificationUriComplete": behavior.verificationUriComplete,
            ...(receipt ? { "pact.receipt": receipt } : {}),
          },
        },
      });
    }
    const message = optionalMessageRecord(body);
    const receipt = await mintReceipt(headers);
    return context.json({
      message: {
        messageId: `reply-${crypto.randomUUID()}`,
        contextId:
          behavior?.kind === "reply" && behavior.contextId !== undefined
            ? behavior.contextId
            : (message?.contextId ?? `ctx-${crypto.randomUUID()}`),
        role: "ROLE_AGENT",
        parts: [{ text: behavior?.kind === "reply" ? (behavior.text ?? "ok") : "ok", mediaType: "text/plain" }],
        ...(receipt ? { metadata: { "pact.receipt": receipt } } : {}),
      },
    });
  });
  app.get("/.well-known/oauth-authorization-server", (context) =>
    context.json({
      issuer: origin,
      jwks_uri: `${origin}/.well-known/jwks.json`,
      device_authorization_endpoint: `${origin}/oauth2/device_authorization`,
      token_endpoint: `${origin}/oauth2/token`,
      revocation_endpoint: oauth.revocationAdvertised ? `${origin}/oauth2/revoke` : undefined,
    }),
  );
  app.get("/.well-known/jwks.json", async (context) => {
    const key = await ensureSignerKey();
    return context.json({ keys: [key.publicJwk] });
  });

  const fetcher: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return app.request(url, init);
  };

  return {
    fetcher,
    origin,
    cardUrl: `${origin}/.well-known/agent-card.json`,
    interfaceUrl,
    requests,
    verifiedTokens,
    setCard(next: unknown): void {
      card = next;
    },
    respondWith(behavior: MockPactBehavior): void {
      behaviors.push(behavior);
    },
    setVerifierJwks(jwks: { keys: unknown[] }): void {
      verifierJwks = jwks;
    },
    setExpectedAudience(audience: string): void {
      expectedAudience = audience;
    },
    oauth,
    receipts,
    async signerJwks(): Promise<{ keys: unknown[] }> {
      const key = await ensureSignerKey();
      return { keys: [key.publicJwk] };
    },
  };
}

function bearerHeaders(context: Context): Record<string, string> {
  const headers: Record<string, string> = {};
  context.req.raw.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  return headers;
}

function defaultCard(origin: string, interfaceUrl: string): Record<string, unknown> {
  return {
    name: "Mock Brand",
    version: "1.0",
    supportedInterfaces: [{ url: interfaceUrl, protocolBinding: "HTTP+JSON", protocolVersion: "1.0" }],
    provider: { organization: "Mock Provider", url: origin },
    skills: [{ id: "support", name: "Support", description: "Customer support answers", tags: ["support"] }],
    securitySchemes: {
      paJwt: { httpAuthSecurityScheme: { scheme: "Bearer", bearerFormat: "JWT" } },
      userDelegation: {
        oauth2SecurityScheme: {
          flows: {
            deviceCode: {
              deviceAuthorizationUrl: `${origin}/oauth2/device_authorization`,
              tokenUrl: `${origin}/oauth2/token`,
              scopes: { "pact:messages": "Send the Brand messages" },
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

async function verifyPaJwt(
  context: Context,
  headers: Record<string, string>,
  jwks: { keys: unknown[] } | undefined,
  audience: string,
  verified: Record<string, unknown>[],
): Promise<Response | undefined> {
  const authorization = headers["authorization"] ?? "";
  if (!authorization.startsWith("Bearer ")) {
    context.header("WWW-Authenticate", 'Bearer realm="a2a"');
    return context.body(null, 401);
  }
  if (!jwks) {
    // No verifier configured: accept any bearer so card-only tests stay light.
    verified.push({ sub: "unverified" });
    return undefined;
  }
  try {
    const { createLocalJWKSet, jwtVerify } = await import("jose");
    const { payload } = await jwtVerify(authorization.slice(7), createLocalJWKSet(jwks as never), {
      audience,
    });
    verified.push(payload as Record<string, unknown>);
    return undefined;
  } catch {
    context.header("WWW-Authenticate", 'Bearer realm="a2a"');
    return context.body(null, 401);
  }
}

function a2aError(context: Context, status: number, reason: string, message?: string): Response {
  return context.json(
    {
      error: {
        code: reason,
        status,
        message: message ?? reason,
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason,
            domain: "provider.example.com",
          },
        ],
      },
    },
    status as never,
  );
}

function optionalMessageRecord(body: unknown): { contextId?: string } | undefined {
  if (!body || typeof body !== "object") return undefined;
  const message = (body as Record<string, unknown>).message;
  if (!message || typeof message !== "object") return undefined;
  const contextId = (message as Record<string, unknown>).contextId;
  return typeof contextId === "string" ? { contextId } : undefined;
}

/** Header name the mock asserts on (kept in one place for tests). */
export const mockPactDelegationHeader: string = pactDelegationHeader.toLowerCase();
