import type { ConsoleUser, ConsoleUserStore } from "../storage/console-user-store.ts";
import type { RuntimeGrant } from "../storage/runtime-token-service.ts";
import type { RuntimeJwtVerifier } from "./runtime-jwt.ts";
import type { Context, MiddlewareHandler } from "hono";

import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { isConsoleShellRequest } from "./console-paths.ts";
import { jsonError } from "./http-utils.ts";
import { writeRuntimeFailure } from "./runtime-api.ts";

const bearerScheme = "bearer";
const authCookieName = "oomol_connect_admin_session";
const userAuthCookieName = "oomol_connect_user_session";
const authCookieVersion = "v1";
const authCookieMaxAgeSeconds = 2_592_000;
const authCookieMaxAgeMs = authCookieMaxAgeSeconds * 1000;

/**
 * Optional API authentication for HTTP, web console, and MCP callers.
 */
export interface LocalAuthOptions {
  adminToken?: string;
  runtimeToken?: string;
  hasRuntimeTokens?(): Promise<boolean>;
  resolveRuntimeToken?(token: string): Promise<RuntimeGrant | undefined>;
  verifyRuntimeJwt?: RuntimeJwtVerifier;
  /**
   * Sink for requests the middleware refused before routing, so they can join
   * the run log the activity feed renders — PAP's red "tried to" rows.
   */
  recordDeniedAttempt?(attempt: DeniedRequestAttempt): void | Promise<void>;
  /**
   * Console user sign-in (thirdweb OTP): verifies `oomol_connect_user_session`
   * cookies against live `console_sessions` rows. Missing pieces disable user auth.
   */
  userSession?: LocalUserSessionOptions;
}

/** Server-side console user session wiring: the cookie signing key plus the session store. */
export interface LocalUserSessionOptions {
  /** `OOMOL_CONNECT_ENCRYPTION_KEY` — the HMAC key behind `oomol_connect_user_session`. */
  signingKey?: string;
  store?: ConsoleUserStore;
}

/** One request the auth middleware refused before it could reach a handler. */
export interface DeniedRequestAttempt {
  method: string;
  path: string;
  status: number;
  errorCode: string;
  message: string;
  /** Resolvable stored-token id behind the presented bearer credential, if any. */
  runtimeTokenId?: string;
}

/** The console identity a user-session request authenticates as. */
export interface LocalAuthSessionUser {
  id: string;
  walletAddress: string;
  phone?: string;
  email?: string;
}

export interface LocalAuthSession {
  adminAuthConfigured: boolean;
  authenticated: boolean;
  /** Which credential authenticated this request; absent when none did. */
  kind?: "user" | "admin";
  /** Console user behind a live `oomol_connect_user_session` cookie, when present. */
  user?: LocalAuthSessionUser;
}

type AuthScope = "admin" | "runtime";

const adminBearerRequests = new WeakSet<Request>();

export function hasAdminBearer(context: Context): boolean {
  return adminBearerRequests.has(context.req.raw);
}

const runtimeGrants = new WeakMap<Request, RuntimeGrant>();

export function readRuntimeGrant(context: Context): RuntimeGrant | undefined {
  return runtimeGrants.get(context.req.raw);
}

/**
 * Bearer credential kind recorded by the auth middleware for the §4.6 receipt
 * `act` claim: `bootstrap` (configured runtime token), `jwt` (verified runtime
 * JWT), `admin` (admin token or admin session cookie), `user` (console user
 * session cookie), `dev` (no credential). Stored-token callers are read back
 * through {@link readRuntimeGrant} instead — their `act` is the token id.
 */
export type RuntimeCallerKind = "bootstrap" | "jwt" | "dev" | "admin" | "user";

const callerKinds = new WeakMap<Request, RuntimeCallerKind>();

const consoleUsers = new WeakMap<Request, ConsoleUser>();

/** Console user that authenticated this request through `oomol_connect_user_session`, when any. */
export function readConsoleUser(context: Context): ConsoleUser | undefined {
  return consoleUsers.get(context.req.raw);
}

/** Credential kind for the current request; `dev` when no bearer was presented. */
export function readRuntimeCallerKind(context: Context): RuntimeCallerKind {
  return callerKinds.get(context.req.raw) ?? "dev";
}

function recordCallerKind(context: Context, kind: RuntimeCallerKind): void {
  callerKinds.set(context.req.raw, kind);
}

export function createLocalAuthMiddleware(options: LocalAuthOptions): MiddlewareHandler {
  const adminToken = normalizeToken(options.adminToken);
  const runtimeToken = normalizeToken(options.runtimeToken);
  if (
    !adminToken &&
    !runtimeToken &&
    !options.hasRuntimeTokens &&
    !options.resolveRuntimeToken &&
    !options.verifyRuntimeJwt
  ) {
    return async (_context, next) => {
      await next();
    };
  }

  return async (context, next) => {
    const scope = readAuthScope(context.req.path);
    if (isPublicPath(context.req.path, context.req.method)) {
      await next();
      return;
    }

    if (
      isConnectionManagementPath(context.req.path) &&
      !adminToken &&
      (runtimeToken ||
        options.verifyRuntimeJwt ||
        (options.hasRuntimeTokens ? await options.hasRuntimeTokens() : options.resolveRuntimeToken !== undefined))
    ) {
      await recordDeniedAttempt(context, options, scope, {
        status: 403,
        errorCode: "forbidden",
        message: "Configure an admin token to manage connections.",
      });
      return writeRuntimeFailure(context, {
        status: 403,
        errorCode: "forbidden",
        message: "Configure an admin token to manage connections.",
      });
    }
    if (adminToken && matchesConfiguredToken(context, adminToken)) adminBearerRequests.add(context.req.raw);
    if (await hasValidToken(context, options, scope)) {
      if (scope === "admin") {
        await installAdminCookieForBearer(context, options);
      }
      await next();
      return;
    }

    // Admin elevation for action runs is only available when an admin token is
    // configured. Without that, a missing admin token must not open POST
    // /v1/actions/* while runtime tokens/JWT are otherwise enforcing auth.
    if (
      canUseAdminAuth(context.req.path, context.req.method) &&
      normalizeToken(options.adminToken) &&
      (await hasValidToken(context, options, "admin"))
    ) {
      await installAdminCookieForBearer(context, options);
      await next();
      return;
    }

    if (isConnectionManagementPath(context.req.path)) {
      const message = "A valid administrator bearer token is required.";
      await recordDeniedAttempt(context, options, scope, { status: 401, errorCode: "unauthorized", message });
      return writeRuntimeFailure(context, { status: 401, errorCode: "unauthorized", message });
    }
    if (context.req.path.startsWith("/v1/")) {
      const message = "A valid local bearer token is required.";
      await recordDeniedAttempt(context, options, scope, { status: 401, errorCode: "unauthorized", message });
      return writeRuntimeFailure(context, { status: 401, errorCode: "unauthorized", message });
    }
    await recordDeniedAttempt(context, options, scope, {
      status: 401,
      errorCode: "unauthorized",
      message: "A valid local bearer token is required.",
    });
    return jsonError(context, 401, "unauthorized", "A valid local bearer token is required.");
  };
}

/**
 * Auth-layer rejections never reach the action runner, so without this they
 * leave no audit trail. When a sink is configured each denied request is
 * recorded, with the presented stored-token id resolved when the credential
 * was real but scoped wrong. Only credential-bearing attempts get logged on
 * admin paths (cookie-less browsers and probes stay silent); runtime paths
 * expect a bearer, so a missing one counts too.
 */
async function recordDeniedAttempt(
  context: Context,
  options: LocalAuthOptions,
  scope: AuthScope,
  attempt: { status: number; errorCode: string; message: string },
): Promise<void> {
  if (!options.recordDeniedAttempt) {
    return;
  }
  const bearer = readBearerToken(context);
  if (bearer === undefined && scope !== "runtime") {
    return;
  }
  const runtimeTokenId = bearer === undefined ? undefined : (await options.resolveRuntimeToken?.(bearer))?.tokenId;
  try {
    await options.recordDeniedAttempt({
      method: context.req.method,
      path: context.req.path,
      status: attempt.status,
      errorCode: attempt.errorCode,
      message: attempt.message,
      runtimeTokenId,
    });
  } catch {
    // Auditing must never change the auth decision.
  }
}

async function installLocalAuthCookie(context: Context, options: LocalAuthOptions): Promise<void> {
  const token = normalizeToken(options.adminToken);
  if (!token) {
    return;
  }

  setCookie(context, authCookieName, await createAuthCookieValue(token), {
    httpOnly: true,
    maxAge: authCookieMaxAgeSeconds,
    sameSite: "Strict",
    secure: context.req.url.startsWith("https://"),
    path: "/",
  });
}

function isPublicPath(path: string, method: string): boolean {
  return (
    path === "/health" ||
    (method === "GET" && path === "/oauth/saas/complete") ||
    path === "/oauth/callback" ||
    path.startsWith("/oauth/callback/") ||
    (method === "GET" && (path === "/.well-known/jwks.json" || path === "/.well-known/openid-configuration")) ||
    (method === "GET" && path === "/api/auth/session") ||
    (method === "POST" && path === "/api/auth/logout") ||
    (method === "POST" && (path === "/api/auth/thirdweb/initiate" || path === "/api/auth/thirdweb/complete")) ||
    (method === "GET" && path.startsWith("/api/files/")) ||
    isConsoleShellRequest(path, method)
  );
}

export async function readLocalAuthSession(context: Context, options: LocalAuthOptions): Promise<LocalAuthSession> {
  const adminToken = normalizeToken(options.adminToken);
  const user = await readUserSession(context, options);
  const sessionUser: LocalAuthSessionUser | undefined = user
    ? { id: user.id, walletAddress: user.walletAddress, phone: user.phone, email: user.email }
    : undefined;
  if (!adminToken) {
    return { adminAuthConfigured: false, authenticated: true, kind: user ? "user" : undefined, user: sessionUser };
  }

  const authenticated = await hasRequestToken(context, adminToken);
  if (authenticated) {
    await installAdminCookieForBearer(context, options);
  }

  return {
    adminAuthConfigured: true,
    authenticated: authenticated || user !== undefined,
    kind: authenticated ? "admin" : user ? "user" : undefined,
    user: sessionUser,
  };
}

export function clearLocalAuthCookie(context: Context): void {
  deleteCookie(context, authCookieName, {
    httpOnly: true,
    sameSite: "Strict",
    secure: context.req.url.startsWith("https://"),
    path: "/",
  });
}

/** Set `oomol_connect_user_session` for a freshly inserted `console_sessions` row (§3.2). */
export async function installUserAuthCookie(context: Context, signingKey: string, sessionId: string): Promise<void> {
  setCookie(context, userAuthCookieName, await createUserAuthCookieValue(signingKey, sessionId), {
    httpOnly: true,
    maxAge: authCookieMaxAgeSeconds,
    sameSite: "Strict",
    secure: context.req.url.startsWith("https://"),
    path: "/",
  });
}

export function clearUserAuthCookie(context: Context): void {
  deleteCookie(context, userAuthCookieName, {
    httpOnly: true,
    sameSite: "Strict",
    secure: context.req.url.startsWith("https://"),
    path: "/",
  });
}

/** Revoke the live session behind the user cookie and clear it; the admin cookie is untouched. */
export async function revokeUserAuthSession(context: Context, options: LocalAuthOptions): Promise<void> {
  const signingKey = normalizeToken(options.userSession?.signingKey);
  const store = options.userSession?.store;
  if (signingKey && store) {
    const sid = await readUserCookieSid(context, signingKey);
    if (sid) {
      await store.revokeSession(sid, new Date().toISOString());
    }
  }
  clearUserAuthCookie(context);
}

/**
 * Signed user-cookie payload `v1.<issuedAt>.<sid>.<nonce>.<sig>` — the same HMAC-SHA256
 * scheme as the admin cookie, keyed on `OOMOL_CONNECT_ENCRYPTION_KEY` instead of the admin token.
 */
export async function createUserAuthCookieValue(signingKey: string, sessionId: string): Promise<string> {
  const payload = `${authCookieVersion}.${Date.now()}.${sessionId}.${base64Url(crypto.getRandomValues(new Uint8Array(16)))}`;
  return `${payload}.${await signAuthCookiePayload(payload, signingKey)}`;
}

async function installAdminCookieForBearer(context: Context, options: LocalAuthOptions): Promise<void> {
  const token = normalizeToken(options.adminToken);
  if (token && matchesConfiguredToken(context, token)) {
    await installLocalAuthCookie(context, options);
  }
}

async function hasValidToken(context: Context, options: LocalAuthOptions, scope: AuthScope): Promise<boolean> {
  const token = tokenForScope(options, scope);
  if (!token) {
    if (scope === "admin") {
      recordCallerKind(context, "dev");
      return true;
    }
    const hasRuntimeTokens = options.hasRuntimeTokens
      ? await options.hasRuntimeTokens()
      : options.resolveRuntimeToken !== undefined;
    if (!hasRuntimeTokens && !options.verifyRuntimeJwt) {
      recordCallerKind(context, "dev");
      return true;
    }
    return hasValidRuntimeToken(context, options);
  }

  if (await hasRequestToken(context, token)) {
    recordCallerKind(context, scope === "admin" ? "admin" : "bootstrap");
    return true;
  }

  return scope === "runtime"
    ? await hasValidRuntimeToken(context, options)
    : await hasValidUserSession(context, options);
}

/** Admin-scope fallback: a live console user session cookie authenticates as `kind: "user"`. */
async function hasValidUserSession(context: Context, options: LocalAuthOptions): Promise<boolean> {
  if (!(await readUserSession(context, options))) {
    return false;
  }
  recordCallerKind(context, "user");
  return true;
}

/**
 * Resolve the console user behind `oomol_connect_user_session`: signature valid,
 * unexpired (30d), live `console_sessions` row, and the user not disabled. Records
 * the user for `created_by` attribution and touches `last_seen_at` on success.
 */
async function readUserSession(context: Context, options: LocalAuthOptions): Promise<ConsoleUser | undefined> {
  const signingKey = normalizeToken(options.userSession?.signingKey);
  const store = options.userSession?.store;
  if (!signingKey || !store) {
    return undefined;
  }

  const sessionId = await readUserCookieSid(context, signingKey);
  if (!sessionId) {
    return undefined;
  }
  const session = await store.getLiveSession(sessionId);
  if (!session) {
    return undefined;
  }
  const user = await store.get(session.userId);
  if (!user || user.disabledAt) {
    return undefined;
  }

  consoleUsers.set(context.req.raw, user);
  try {
    await store.touchSession(session.id, new Date().toISOString());
  } catch {
    // Activity bookkeeping must never change the auth decision.
  }
  return user;
}

/** Verify the signed user cookie and return the embedded session id, or undefined when invalid. */
async function readUserCookieSid(context: Context, signingKey: string): Promise<string | undefined> {
  const cookie = getCookie(context, userAuthCookieName);
  if (!cookie) {
    return undefined;
  }

  const [version, issuedAt, sessionId, nonce, signature, ...extra] = cookie.split(".");
  if (version !== authCookieVersion || !issuedAt || !sessionId || !nonce || !signature || extra.length > 0) {
    return undefined;
  }

  const issuedAtMs = Number(issuedAt);
  if (!Number.isFinite(issuedAtMs) || issuedAtMs > Date.now() || Date.now() - issuedAtMs > authCookieMaxAgeMs) {
    return undefined;
  }

  const payload = `${version}.${issuedAt}.${sessionId}.${nonce}`;
  return constantTimeEqual(signature, await signAuthCookiePayload(payload, signingKey)) ? sessionId : undefined;
}

async function hasRequestToken(context: Context, token: string): Promise<boolean> {
  if (context.req.header("authorization") !== undefined) return matchesConfiguredToken(context, token);
  return await hasValidAuthCookie(context, token);
}

async function hasValidAuthCookie(context: Context, token: string): Promise<boolean> {
  const cookie = getCookie(context, authCookieName);
  if (!cookie) {
    return false;
  }

  const [version, issuedAt, nonce, signature, ...extra] = cookie.split(".");
  if (version !== authCookieVersion || !issuedAt || !nonce || !signature || extra.length > 0) {
    return false;
  }

  const issuedAtMs = Number(issuedAt);
  if (!Number.isFinite(issuedAtMs) || issuedAtMs > Date.now() || Date.now() - issuedAtMs > authCookieMaxAgeMs) {
    return false;
  }

  const payload = `${version}.${issuedAt}.${nonce}`;
  return constantTimeEqual(signature, await signAuthCookiePayload(payload, token));
}

async function createAuthCookieValue(token: string): Promise<string> {
  const payload = `${authCookieVersion}.${Date.now()}.${base64Url(crypto.getRandomValues(new Uint8Array(16)))}`;
  return `${payload}.${await signAuthCookiePayload(payload, token)}`;
}

async function signAuthCookiePayload(payload: string, token: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", utf8(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64Url(await crypto.subtle.sign("HMAC", key, utf8(payload)));
}

function utf8(value: string): ArrayBuffer {
  return new TextEncoder().encode(value).buffer as ArrayBuffer;
}

function base64Url(value: ArrayBuffer | ArrayBufferView): string {
  const bytes =
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.from(bytes).toString("base64url");
}

// Deployment secrets (`OOMOL_CONNECT_ADMIN_TOKEN` / `OOMOL_CONNECT_RUNTIME_TOKEN`) are long-lived,
// so the credential is compared in constant time instead of with `===`, which short-circuits on the
// first differing character and leaks how much of the token an attacker already guessed. Stored
// runtime tokens already get the same treatment through `timingSafeEqual` on their hashes.
function matchesConfiguredToken(context: Context, token: string): boolean {
  return constantTimeEqual(readBearerCredential(context), token);
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function normalizeToken(token: string | undefined): string | undefined {
  const value = token?.trim();
  return value ? value : undefined;
}

function readAuthScope(path: string): AuthScope {
  if (isConnectionManagementPath(path)) return "admin";
  return path === "/mcp" || path.startsWith("/mcp/") || path === "/v1" || path.startsWith("/v1/") ? "runtime" : "admin";
}

function canUseAdminAuth(path: string, method: string): boolean {
  return method === "POST" && /^\/v1\/actions\/[^/]+$/.test(path);
}

function tokenForScope(options: LocalAuthOptions, scope: AuthScope): string | undefined {
  const adminToken = normalizeToken(options.adminToken);
  const runtimeToken = normalizeToken(options.runtimeToken);
  return scope === "runtime" ? runtimeToken : adminToken;
}

async function hasValidRuntimeToken(context: Context, options: LocalAuthOptions): Promise<boolean> {
  const token = readBearerToken(context);
  if (!token) {
    return false;
  }
  const grant = await options.resolveRuntimeToken?.(token);
  if (grant) {
    runtimeGrants.set(context.req.raw, grant);
    return true;
  }
  if (await (options.verifyRuntimeJwt?.(token) ?? false)) {
    recordCallerKind(context, "jwt");
    return true;
  }
  return false;
}

function readBearerToken(context: Context): string | undefined {
  return normalizeToken(readBearerCredential(context));
}

/**
 * Bearer credential exactly as sent, so configured tokens still require a byte-for-byte match.
 *
 * Authentication schemes are case-insensitive (RFC 9110), so `bearer` and `BEARER` are accepted;
 * only the credentials stay case-sensitive. Exported for approval ownership hashing: callers
 * without a runtime token are identified by SHA-256 of this credential, never the credential.
 */
export function readBearerCredential(context: Context): string {
  const authorization = context.req.header("authorization") ?? "";
  const separator = authorization.indexOf(" ");
  if (separator < 0 || authorization.slice(0, separator).toLowerCase() !== bearerScheme) {
    return "";
  }

  return authorization.slice(separator + 1);
}

function isConnectionManagementPath(path: string): boolean {
  return (
    /^\/v1\/providers\/[^/]+\/setup$/.test(path) ||
    path === "/v1/connections" ||
    path.startsWith("/v1/connections/") ||
    path.startsWith("/v1/connection-requests/") ||
    path === "/api/oauth/connection-requests" ||
    path.startsWith("/api/oauth/connection-requests/")
  );
}
