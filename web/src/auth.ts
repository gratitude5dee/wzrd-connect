import { ApiError, apiPost } from "./api";

/** Console user returned by `GET /api/auth/session` and `POST /api/auth/thirdweb/complete`. */
export interface AuthSessionUser {
  id: string;
  walletAddress: string;
  phone?: string;
  email?: string;
}

/** `GET /api/auth/session` payload (spec §3.3): `kind`/`user` are additive for older runtimes. */
export interface AuthSession {
  adminAuthConfigured: boolean;
  authenticated: boolean;
  /** Which credential authenticated the session; absent when none did. */
  kind?: "user" | "admin";
  /** Console user behind a live `oomol_connect_user_session` cookie, when present. */
  user?: AuthSessionUser;
}

export type SignInChannel = "sms" | "email";

const defaultNextPath = "/overview";

/**
 * `?next=` may only name a local console path: protocol-relative `//host`,
 * anything with a scheme or backslash, and the auth pages themselves (a
 * redirect loop) all fall back to `/overview`.
 */
export function sanitizeNextPath(raw: string | null | undefined): string {
  const value = raw?.trim() ?? "";
  if (!value.startsWith("/") || value.startsWith("//")) {
    return defaultNextPath;
  }
  const path = value.split(/[?#]/, 1)[0] ?? value;
  if (path.includes(":") || path.includes("\\") || path === "/auth" || path.startsWith("/auth/")) {
    return defaultNextPath;
  }
  return value;
}

/** `GET` paths served without a session: the landing stub and the auth pages. */
export function isPublicAuthPath(pathname: string): boolean {
  return pathname === "/" || pathname === "/auth" || pathname.startsWith("/auth/");
}

/**
 * Client-side console gate (spec §3.5): an unauthenticated console path
 * redirects to `/auth?next=`; public paths and authenticated sessions pass.
 */
export function authGateTarget(pathname: string, search: string, authenticated: boolean): string | null {
  if (authenticated || isPublicAuthPath(pathname)) {
    return null;
  }
  return `/auth?next=${encodeURIComponent(`${pathname}${search}`)}`;
}

/** Short wallet form for the header identity chip: `0x1234…abcd`. */
export function truncateWalletAddress(address: string): string {
  return address.length > 10 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

export type AuthIdentity = { kind: "operator" } | { kind: "user"; label: string };

/**
 * Identity the header shows for a session: `Operator` for admin credentials,
 * the truncated wallet (or phone/email) for a console user, nothing for a
 * no-auth local runtime.
 */
export function authDisplayIdentity(session: AuthSession): AuthIdentity | null {
  if (!session.authenticated) {
    return null;
  }
  if (session.kind === "admin") {
    return { kind: "operator" };
  }
  if (session.kind !== "user") {
    return null;
  }
  const user = session.user;
  const label = user?.walletAddress ? truncateWalletAddress(user.walletAddress) : (user?.phone ?? user?.email ?? "");
  return { kind: "user", label };
}

const e164PhonePattern = /^\+\d{7,15}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** E.164 normalization matching the server (`/api/auth/thirdweb/*`) rules. */
export function normalizePhoneInput(value: string): string {
  const digits = value.replace(/[^+\d]/g, "");
  if (digits.startsWith("+")) return digits;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  return digits ? `+${digits}` : "";
}

/** Normalized identity for the channel, or `undefined` when it cannot be sent. */
export function validSignInIdentity(channel: SignInChannel, value: string): string | undefined {
  if (channel === "sms") {
    const phone = normalizePhoneInput(value);
    return e164PhonePattern.test(phone) ? phone : undefined;
  }
  const email = value.trim().toLowerCase();
  return emailPattern.test(email) ? email : undefined;
}

/** Resend cooldown between `initiate` calls (spec §3.5: 30 s). */
export const otpResendCooldownMs = 30_000;

/** Verify-step form state: the code typed so far plus the resend gate. */
export interface OtpStepState {
  code: string;
  resendAvailableAt: number;
}

export function startOtpStep(now: number): OtpStepState {
  return { code: "", resendAvailableAt: now + otpResendCooldownMs };
}

/** OTP entry accepts digits only and caps at the 6 thirdweb sends. */
export function editOtpCode(state: OtpStepState, raw: string): OtpStepState {
  return { ...state, code: raw.replace(/\D/g, "").slice(0, 6) };
}

export function isOtpComplete(code: string): boolean {
  return /^\d{6}$/.test(code);
}

export function otpResendRemainingSeconds(state: OtpStepState, now: number): number {
  return Math.max(0, Math.ceil((state.resendAvailableAt - now) / 1000));
}

/** Inline-error key under `auth.errors.*` for a failed sign-in call. */
export type SignInErrorKey = "invalidIdentity" | "invalidCode" | "rateLimited" | "unavailable" | "disabled" | "failed";

export type SendCodeResult = { outcome: "sent" } | { outcome: "error"; error: SignInErrorKey };

export async function sendSignInCode(channel: SignInChannel, identity: string): Promise<SendCodeResult> {
  try {
    await apiPost("/api/auth/thirdweb/initiate", identityBody(channel, identity));
    return { outcome: "sent" };
  } catch (error) {
    return { outcome: "error", error: signInErrorKey(error, "failed") };
  }
}

export type VerifyCodeResult =
  | { outcome: "signedIn"; isNewUser: boolean; user: AuthSessionUser }
  | { outcome: "pending" }
  | { outcome: "error"; error: SignInErrorKey };

interface CompletePayload {
  ok?: boolean;
  isNewUser?: boolean;
  user?: AuthSessionUser;
  access?: string;
}

export async function verifySignInCode(
  channel: SignInChannel,
  identity: string,
  code: string,
): Promise<VerifyCodeResult> {
  try {
    const result = await apiPost<CompletePayload>("/api/auth/thirdweb/complete", {
      ...identityBody(channel, identity),
      code,
    });
    return result.user
      ? { outcome: "signedIn", isNewUser: result.isNewUser === true, user: result.user }
      : { outcome: "error", error: "failed" };
  } catch (error) {
    // The allowlist gate answers 403 `{ok:false, access:"pending"}` — a plain
    // body, not the error envelope, so it surfaces as a code-less ApiError.
    if (error instanceof ApiError && error.status === 403 && error.code === undefined) {
      return { outcome: "pending" };
    }
    return { outcome: "error", error: signInErrorKey(error, "failed") };
  }
}

function identityBody(channel: SignInChannel, identity: string): { channel: string; phone?: string; email?: string } {
  return channel === "sms" ? { channel, phone: identity } : { channel, email: identity };
}

function signInErrorKey(error: unknown, fallback: SignInErrorKey): SignInErrorKey {
  if (!(error instanceof ApiError)) {
    return "failed";
  }
  if (error.status === 429 || error.code === "rate_limited") {
    return "rateLimited";
  }
  if (error.code === "invalid_code") {
    return "invalidCode";
  }
  if (error.code === "account_disabled") {
    return "disabled";
  }
  if (error.code === "invalid_input") {
    return "invalidIdentity";
  }
  if (error.status === 503 || error.code === "auth_unavailable") {
    return "unavailable";
  }
  return fallback;
}
