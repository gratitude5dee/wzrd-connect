import type { ConsoleUserStore } from "../storage/console-user-store.ts";
import type { LocalAuthOptions } from "./auth.ts";

import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteRuntimeDatabase } from "../storage/sqlite/runtime-store.ts";
import { ThirdwebApiError, ThirdwebClient } from "../thirdweb/client.ts";
import {
  clearLocalAuthCookie,
  createLocalAuthMiddleware,
  createUserAuthCookieValue,
  readLocalAuthSession,
  readRuntimeCallerKind,
  revokeUserAuthSession,
} from "./auth.ts";
import { createThirdwebAuthRoutes } from "./thirdweb-auth.ts";

const signingKey = "test-console-user-session-key";
const adminToken = "test-admin-token";
const walletAddress = "0xabc123def456";

const databases: SqliteRuntimeDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

interface CapturedCall {
  url: string;
  headers: Headers;
  body: string;
}

/** A `fetch` seam for `ThirdwebClient`: queues canned responses and records each request. */
function mockTransport(): {
  fetcher: typeof fetch;
  calls: CapturedCall[];
  respond: (response: Response) => void;
  fail: (error: Error) => void;
} {
  const calls: CapturedCall[] = [];
  const queue: (Response | Error)[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    calls.push({ url: request.url, headers: request.headers, body: await request.text() });
    const next = queue.shift();
    if (next === undefined) {
      return new Response("unexpected thirdweb call", { status: 500 });
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  };
  return { fetcher, calls, respond: (response) => queue.push(response), fail: (error) => queue.push(error) };
}

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface TestAppOptions {
  secretKey?: string;
  allowlist?: string;
  transport?: ReturnType<typeof mockTransport>;
}

function createTestApp(options: TestAppOptions = {}) {
  const database = new SqliteRuntimeDatabase(":memory:");
  databases.push(database);
  const transport = options.transport ?? mockTransport();
  const userSession = { signingKey, store: database.consoleUserStore };
  const auth: LocalAuthOptions = { adminToken, userSession };
  const app = new Hono();
  app.use("*", createLocalAuthMiddleware(auth));
  app.get("/api/auth/session", async (context) => context.json(await readLocalAuthSession(context, auth)));
  app.post("/api/auth/logout", async (context) => {
    clearLocalAuthCookie(context);
    await revokeUserAuthSession(context, auth);
    return context.json({ ok: true });
  });
  app.route(
    "/api/auth/thirdweb",
    createThirdwebAuthRoutes({
      client:
        options.secretKey === undefined
          ? new ThirdwebClient({ secretKey: "test-secret", fetcher: transport.fetcher })
          : undefined,
      userSession,
      allowlist: options.allowlist,
    }),
  );
  app.get("/api/connections", (context) => context.json({ caller: readRuntimeCallerKind(context) }));
  return { app, database, transport };
}

function postJson(app: Hono, path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function withUserCookie(app: Hono, path: string, cookie: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), cookie: `oomol_connect_user_session=${cookie}` },
  });
}

function readCookie(response: Response, name: string): string | undefined {
  const header = response.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`${name}=([^;]*)`));
  return match ? match[1] : undefined;
}

/** Complete sign-in once via the transport queue; returns the issued cookie value. */
async function completeSignIn(
  app: Hono,
  transport: ReturnType<typeof mockTransport>,
  identity: { phone?: string; email?: string } = { phone: "+15104154787" },
): Promise<Response> {
  transport.respond(jsonResponse(200, { result: { walletAddress, isNewUser: true, token: "tw-session" } }));
  return await postJson(app, "/api/auth/thirdweb/complete", {
    channel: identity.email ? "email" : "sms",
    ...identity,
    code: "123456",
  });
}

/** Forge a user cookie value with control over issuedAt and the signing key. */
async function forgeCookie(sid: string, key: string, issuedAtMs: number): Promise<string> {
  const payload = `v1.${issuedAtMs}.${sid}.testnonce`;
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = Buffer.from(await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(payload))).toString(
    "base64url",
  );
  return `${payload}.${signature}`;
}

describe("POST /api/auth/thirdweb/initiate", () => {
  it("rejects a missing or unknown channel", async () => {
    const { app } = createTestApp();
    for (const body of [{}, { channel: "carrier_pigeon" }, { channel: "sms" }]) {
      const response = await postJson(app, "/api/auth/thirdweb/initiate", body);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("invalid_input");
    }
  });

  it("rejects invalid phone and email identities", async () => {
    const { app } = createTestApp();
    for (const body of [
      { channel: "sms", phone: "abc" },
      { channel: "sms", phone: "123" },
      { channel: "email", email: "not-an-email" },
      { channel: "email" },
    ]) {
      const response = await postJson(app, "/api/auth/thirdweb/initiate", body);
      expect(response.status).toBe(400);
    }
  });

  it("normalizes E.164 variants and posts to thirdweb with the secret key", async () => {
    const { app, transport } = createTestApp();
    transport.respond(jsonResponse(200, { sent: true }));
    const response = await postJson(app, "/api/auth/thirdweb/initiate", {
      channel: "sms",
      phone: "(510) 415-4787",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, sent: true });
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0].url).toBe("https://api.thirdweb.com/v1/auth/initiate");
    expect(transport.calls[0].headers.get("x-secret-key")).toBe("test-secret");
    expect(JSON.parse(transport.calls[0].body)).toEqual({ method: "sms", phone: "+15104154787", email: "" });
  });

  it("accepts an email channel and lowercases the address", async () => {
    const { app, transport } = createTestApp();
    transport.respond(jsonResponse(200, { sent: true }));
    const response = await postJson(app, "/api/auth/thirdweb/initiate", {
      channel: "email",
      email: "  User@Example.COM ",
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(transport.calls[0].body)).toEqual({ method: "email", phone: "", email: "user@example.com" });
  });

  it("maps thirdweb 429 to rate_limited and other failures to 502", async () => {
    const { app, transport } = createTestApp();
    transport.respond(jsonResponse(429, { error: "slow down" }));
    const throttled = await postJson(app, "/api/auth/thirdweb/initiate", { channel: "sms", phone: "+15104154787" });
    expect(throttled.status).toBe(429);
    expect((await throttled.json()).error.code).toBe("rate_limited");

    transport.respond(jsonResponse(503, { error: "down" }));
    const upstream = await postJson(app, "/api/auth/thirdweb/initiate", { channel: "sms", phone: "+15104154787" });
    expect(upstream.status).toBe(502);
    expect((await upstream.json()).error.code).toBe("thirdweb_unavailable");
  });

  it("returns 503 when the thirdweb client is not configured", async () => {
    const { app } = createTestApp({ secretKey: "" });
    const response = await postJson(app, "/api/auth/thirdweb/initiate", { channel: "sms", phone: "+15104154787" });
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("auth_unavailable");
  });
});

describe("POST /api/auth/thirdweb/complete", () => {
  it("rejects missing code and bad identity input", async () => {
    const { app } = createTestApp();
    for (const body of [
      { channel: "sms", phone: "+15104154787" },
      { channel: "sms", phone: "abc", code: "123456" },
      { channel: "email", email: "bad", code: "123456" },
      { channel: "sms", phone: "+15104154787", code: "  " },
    ]) {
      const response = await postJson(app, "/api/auth/thirdweb/complete", body);
      expect(response.status).toBe(400);
    }
  });

  it("maps a rejected code to 401 and a transport failure to 502", async () => {
    const { app, transport } = createTestApp();
    transport.respond(jsonResponse(400, { error: "bad code" }));
    const invalid = await postJson(app, "/api/auth/thirdweb/complete", {
      channel: "sms",
      phone: "+15104154787",
      code: "000000",
    });
    expect(invalid.status).toBe(401);
    expect((await invalid.json()).error.code).toBe("invalid_code");

    const { app: downApp, transport: downTransport } = createTestApp();
    downTransport.fail(new TypeError("fetch failed"));
    const upstream = await postJson(downApp, "/api/auth/thirdweb/complete", {
      channel: "sms",
      phone: "+15104154787",
      code: "123456",
    });
    expect(upstream.status).toBe(502);
    expect((await upstream.json()).error.code).toBe("thirdweb_unavailable");
  });

  it("issues a user cookie and stores user + session rows on success", async () => {
    const { app, database, transport } = createTestApp();
    const response = await completeSignIn(app, transport);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      isNewUser: true,
      access: "member",
      user: { walletAddress, phone: "+15104154787" },
    });
    const cookie = readCookie(response, "oomol_connect_user_session");
    expect(cookie).toBeDefined();
    expect(readCookie(response, "oomol_connect_admin_session")).toBeUndefined();

    const store = database.consoleUserStore;
    const user = await store.findByWalletAddress(walletAddress);
    expect(user).toMatchObject({ phone: "+15104154787" });
    const session = await store.getLiveSession(cookie!.split(".")[2]);
    expect(session?.userId).toBe(user!.id);
  });

  it("backfills email on a later sign-in without losing the phone identity", async () => {
    const { app, database, transport } = createTestApp();
    await completeSignIn(app, transport, { phone: "+15104154787" });
    transport.respond(jsonResponse(200, { result: { walletAddress, isNewUser: false, token: "tw-2" } }));
    const again = await postJson(app, "/api/auth/thirdweb/complete", {
      channel: "email",
      email: "user@example.com",
      code: "123456",
    });
    expect(again.status).toBe(200);
    const user = await database.consoleUserStore.findByWalletAddress(walletAddress);
    expect(user).toMatchObject({ phone: "+15104154787", email: "user@example.com" });
  });

  it("rejects a disabled user with 403", async () => {
    const { app, database, transport } = createTestApp();
    await completeSignIn(app, transport);
    const user = await database.consoleUserStore.findByWalletAddress(walletAddress);
    expect(await database.consoleUserStore.setDisabled(user!.id, new Date().toISOString())).toBe(true);
    const response = await completeSignIn(app, transport);
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("account_disabled");
  });
});

describe("access allowlist", () => {
  it("admits a listed phone, email, or wallet case-insensitively", async () => {
    for (const [allowlist, identity] of [
      ["+15104154787", { phone: "+15104154787" }],
      ["510-415-4787", { phone: "+15104154787" }],
      ["user@example.com", { email: "user@example.com" }],
      ["0XABC123DEF456", { phone: "+15104154787" }],
    ] as const) {
      const { app, transport } = createTestApp({ allowlist });
      const response = await completeSignIn(app, transport, identity);
      expect(response.status).toBe(200);
      expect((await response.json()).access).toBe("member");
      expect(readCookie(response, "oomol_connect_user_session")).toBeDefined();
    }
  });

  it("returns pending 403 without a cookie for unlisted identities but keeps the user row", async () => {
    const { app, database, transport } = createTestApp({ allowlist: "+19999999999" });
    const response = await completeSignIn(app, transport);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, access: "pending" });
    expect(readCookie(response, "oomol_connect_user_session")).toBeUndefined();
    expect(await database.consoleUserStore.findByWalletAddress(walletAddress)).toBeDefined();
  });
});

describe("user session cookie", () => {
  it("authenticates admin-scope requests as caller kind 'user'", async () => {
    const { app, transport } = createTestApp();
    const response = await completeSignIn(app, transport);
    const cookie = readCookie(response, "oomol_connect_user_session")!;
    const authed = await withUserCookie(app, "/api/connections", cookie);
    expect(authed.status).toBe(200);
    expect(await authed.json()).toEqual({ caller: "user" });
    const unauthenticated = await app.request("/api/connections");
    expect(unauthenticated.status).toBe(401);
  });

  it("rejects the cookie once its console_sessions row is revoked", async () => {
    const { app, database, transport } = createTestApp();
    const response = await completeSignIn(app, transport);
    const cookie = readCookie(response, "oomol_connect_user_session")!;
    expect((await withUserCookie(app, "/api/connections", cookie)).status).toBe(200);
    expect(await database.consoleUserStore.revokeSession(cookie.split(".")[2], new Date().toISOString())).toBe(true);
    expect((await withUserCookie(app, "/api/connections", cookie)).status).toBe(401);
  });

  it("rejects foreign signatures, tampering, and expired cookies", async () => {
    const { app, database, transport } = createTestApp();
    const response = await completeSignIn(app, transport);
    const cookie = readCookie(response, "oomol_connect_user_session")!;
    const sid = cookie.split(".")[2];
    const store: ConsoleUserStore = database.consoleUserStore;
    expect(await store.getLiveSession(sid)).toBeDefined();

    for (const forged of [
      await forgeCookie(sid, "different-key", Date.now()),
      cookie.replace(/.$/, cookie.endsWith("A") ? "B" : "A"),
      await forgeCookie(sid, signingKey, Date.now() - 31 * 24 * 60 * 60 * 1000),
      await forgeCookie("no-such-session", signingKey, Date.now()),
    ]) {
      expect((await withUserCookie(app, "/api/connections", forged)).status).toBe(401);
    }

    // And the issued value itself is a valid round trip.
    const recreated = await createUserAuthCookieValue(signingKey, sid);
    expect((await withUserCookie(app, "/api/connections", recreated)).status).toBe(200);
  });

  it("rejects a disabled user's cookie", async () => {
    const { app, database, transport } = createTestApp();
    const response = await completeSignIn(app, transport);
    const cookie = readCookie(response, "oomol_connect_user_session")!;
    const user = await database.consoleUserStore.findByWalletAddress(walletAddress);
    await database.consoleUserStore.setDisabled(user!.id, new Date().toISOString());
    expect((await withUserCookie(app, "/api/connections", cookie)).status).toBe(401);
  });
});

describe("GET /api/auth/session", () => {
  it("keeps the additive shape and reports kind + user for a live session", async () => {
    const { app, transport } = createTestApp();
    const anonymous = await app.request("/api/auth/session");
    expect(await anonymous.json()).toEqual({ adminAuthConfigured: true, authenticated: false });

    const response = await completeSignIn(app, transport);
    const cookie = readCookie(response, "oomol_connect_user_session")!;
    const authed = await withUserCookie(app, "/api/auth/session", cookie);
    const body = await authed.json();
    expect(body).toMatchObject({
      adminAuthConfigured: true,
      authenticated: true,
      kind: "user",
      user: { walletAddress, phone: "+15104154787" },
    });
    expect(typeof body.user.id).toBe("string");
  });

  it("prefers the admin credential when both cookies arrive", async () => {
    const { app, transport } = createTestApp();
    const response = await completeSignIn(app, transport);
    const cookie = readCookie(response, "oomol_connect_user_session")!;
    const authed = await app.request("/api/auth/session", {
      headers: { authorization: `Bearer ${adminToken}`, cookie: `oomol_connect_user_session=${cookie}` },
    });
    expect(await authed.json()).toMatchObject({ authenticated: true, kind: "admin", user: { walletAddress } });
  });
});

describe("POST /api/auth/logout", () => {
  it("revokes the console session and clears the user cookie", async () => {
    const { app, transport } = createTestApp();
    const response = await completeSignIn(app, transport);
    const cookie = readCookie(response, "oomol_connect_user_session")!;
    const logout = await withUserCookie(app, "/api/auth/logout", cookie, { method: "POST" });
    expect(logout.status).toBe(200);
    expect(readCookie(logout, "oomol_connect_user_session")).toBe("");
    expect((await withUserCookie(app, "/api/connections", cookie)).status).toBe(401);
    const session = await app.request("/api/auth/session", {
      headers: { cookie: `oomol_connect_user_session=${cookie}` },
    });
    expect(await session.json()).toEqual({ adminAuthConfigured: true, authenticated: false });
  });
});

describe("ThirdwebClient", () => {
  it("unwraps the { result } envelope and accepts the flat shape", async () => {
    const wrapped = mockTransport();
    wrapped.respond(jsonResponse(200, { result: { walletAddress: "0x1", isNewUser: true, token: "t" } }));
    const wrappedClient = new ThirdwebClient({ secretKey: "k", fetcher: wrapped.fetcher });
    await expect(wrappedClient.completeAuth({ channel: "sms", phone: "+15551234567", code: "1" })).resolves.toEqual({
      walletAddress: "0x1",
      isNewUser: true,
      token: "t",
    });

    const flat = mockTransport();
    flat.respond(jsonResponse(200, { walletAddress: "0x2", token: "t2" }));
    const flatClient = new ThirdwebClient({ secretKey: "k", fetcher: flat.fetcher });
    await expect(flatClient.completeAuth({ channel: "email", email: "a@b.co", code: "1" })).resolves.toMatchObject({
      walletAddress: "0x2",
      isNewUser: false,
    });
  });

  it("throws ThirdwebApiError with the upstream status", async () => {
    const transport = mockTransport();
    transport.respond(jsonResponse(429, { error: "slow" }));
    const client = new ThirdwebClient({ secretKey: "k", fetcher: transport.fetcher });
    await expect(client.initiateAuth({ channel: "sms", phone: "+15551234567" })).rejects.toMatchObject({
      name: "ThirdwebApiError",
      status: 429,
    });
  });

  it("sends x-client-id when no secret key is configured", async () => {
    const transport = mockTransport();
    transport.respond(jsonResponse(200, { method: "email", success: true }));
    const client = new ThirdwebClient({ clientId: "client-1", fetcher: transport.fetcher });
    await client.initiateAuth({ channel: "email", email: "a@b.co" });
    expect(transport.calls[0].headers.get("x-client-id")).toBe("client-1");
    expect(transport.calls[0].headers.get("x-secret-key")).toBeNull();
  });
});
