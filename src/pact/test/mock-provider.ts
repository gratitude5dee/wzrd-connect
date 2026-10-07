import type { Context } from "hono";

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
}

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

export interface MockPactProviderOptions {
  /** Origin the mock claims; default `https://provider.example.com`. */
  origin?: string;
  /** A2A interface path below the origin; default `/a2a`. */
  interfacePath?: string;
  /** Card body override served at the well-known card path. */
  card?: unknown;
  /** Static card served at a redirect source path (see `cardRedirect`). */
  cardRedirect?: { path: string; location: string };
}

export function createMockPactProvider(options: MockPactProviderOptions = {}): MockPactProvider {
  const origin = options.origin ?? "https://provider.example.com";
  const interfacePath = options.interfacePath ?? "/a2a";
  const interfaceUrl = `${origin}${interfacePath}`;
  const requests: MockPactRequest[] = [];
  const verifiedTokens: Record<string, unknown>[] = [];
  let verifierJwks: { keys: unknown[] } | undefined;
  let expectedAudience = origin;
  let card: unknown = options.card ?? defaultCard(origin, interfaceUrl);
  const behaviors: MockPactBehavior[] = [];

  const app = new Hono();
  app.get("/.well-known/agent-card.json", (context) => context.json(card as object));
  if (options.cardRedirect) {
    app.get(options.cardRedirect.path, (context) => context.redirect(options.cardRedirect!.location));
  }
  // Device-authorization/token endpoints exist so the card can advertise them;
  // the full device-flow behavior lands with PR5. Registered before the
  // wildcard below so their exact paths win.
  app.post("/oauth2/device_authorization", (context) => context.json({ error: "not_implemented" }, 501));
  app.post("/oauth2/token", (context) => context.json({ error: "not_implemented" }, 501));
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
      return context.json({
        task: {
          id: `task-${crypto.randomUUID()}`,
          contextId: behavior.contextId ?? `ctx-${crypto.randomUUID()}`,
          status: { state: behavior.state },
          metadata: {
            "pact.missingScopes": behavior.missingScopes ?? [],
            "pact.verificationUriComplete": behavior.verificationUriComplete,
          },
        },
      });
    }
    const message = optionalMessageRecord(body);
    return context.json({
      message: {
        messageId: `reply-${crypto.randomUUID()}`,
        contextId:
          behavior?.kind === "reply" && behavior.contextId !== undefined
            ? behavior.contextId
            : (message?.contextId ?? `ctx-${crypto.randomUUID()}`),
        role: "ROLE_AGENT",
        parts: [{ text: behavior?.kind === "reply" ? (behavior.text ?? "ok") : "ok", mediaType: "text/plain" }],
      },
    });
  });
  app.get("/.well-known/oauth-authorization-server", (context) =>
    context.json({
      issuer: origin,
      device_authorization_endpoint: `${origin}/oauth2/device_authorization`,
      token_endpoint: `${origin}/oauth2/token`,
    }),
  );
  app.get("/.well-known/jwks.json", (context) => context.json({ keys: [] }));

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
  };
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
