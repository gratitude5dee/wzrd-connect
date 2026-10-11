import type { ConsoleUser } from "../storage/console-user-store.ts";
import type { ThirdwebAuthChannel, ThirdwebAuthClient } from "../thirdweb/client.ts";
import type { LocalUserSessionOptions } from "./auth.ts";
import type { JsonRequestBody } from "./http-utils.ts";
import type { Context } from "hono";

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { optionalString } from "../../core/cast.ts";
import { ThirdwebApiError } from "../thirdweb/client.ts";
import { installUserAuthCookie } from "./auth.ts";
import { HttpRequestError, jsonError, readJsonBody } from "./http-utils.ts";

/**
 * thirdweb sign-in routes (§3.3): `POST /api/auth/thirdweb/initiate` sends the OTP,
 * `POST /api/auth/thirdweb/complete` verifies it, upserts the console user by wallet,
 * applies the optional allowlist, and issues `oomol_connect_user_session`.
 */
export interface ThirdwebAuthRouteOptions {
  /** thirdweb server client; absent when `THIRDWEB_SECRET_KEY` is unset and the routes 503. */
  client?: ThirdwebAuthClient;
  /** Cookie signing key + session store; user auth is unavailable without both. */
  userSession?: LocalUserSessionOptions;
  /** `OOMOL_CONNECT_AUTH_ALLOWLIST`: comma-separated E.164 phones/emails/wallets; unset opens sign-up. */
  allowlist?: string;
}

const e164PhonePattern = /^\+\d{7,15}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createThirdwebAuthRoutes(options: ThirdwebAuthRouteOptions): Hono {
  const allowlist = parseAuthAllowlist(options.allowlist);
  const app = new Hono();
  app.onError((error, context) => {
    if (error instanceof HttpRequestError) {
      return jsonError(context, error.status, error.code, error.message);
    }
    throw error;
  });

  app.post("/initiate", async (context) => {
    if (!options.client) {
      return jsonError(context, 503, "auth_unavailable", "User sign-in is not configured on this deployment.");
    }
    const body = await readJsonBody(context);
    const channel = readAuthChannel(body);
    if (!channel) {
      return jsonError(context, 400, "invalid_input", 'channel must be "sms" or "email".');
    }
    const identity = readAuthIdentity(body, channel);
    if (!identity) {
      return invalidIdentity(context, channel);
    }

    try {
      await options.client.initiateAuth({ channel, ...identity });
    } catch (error) {
      if (error instanceof ThirdwebApiError && error.status === 429) {
        return jsonError(context, 429, "rate_limited", "Too many sign-in attempts; try again later.");
      }
      return jsonError(context, 502, "thirdweb_unavailable", "Could not reach the sign-in provider.");
    }
    return context.json({ ok: true, sent: true });
  });

  app.post("/complete", async (context) => {
    const { client, userSession } = options;
    const signingKey = userSession?.signingKey?.trim();
    const store = userSession?.store;
    if (!client || !signingKey || !store) {
      return jsonError(context, 503, "auth_unavailable", "User sign-in is not configured on this deployment.");
    }
    const body = await readJsonBody(context);
    const channel = readAuthChannel(body);
    if (!channel) {
      return jsonError(context, 400, "invalid_input", 'channel must be "sms" or "email".');
    }
    const identity = readAuthIdentity(body, channel);
    if (!identity) {
      return invalidIdentity(context, channel);
    }
    const code = optionalString(body.code)?.trim();
    if (!code) {
      return jsonError(context, 400, "invalid_input", "code is required.");
    }

    let result;
    try {
      result = await client.completeAuth({ channel, ...identity, code });
    } catch (error) {
      if (error instanceof ThirdwebApiError && error.status > 0) {
        return jsonError(context, 401, "invalid_code", "The verification code is invalid or expired.");
      }
      return jsonError(context, 502, "thirdweb_unavailable", "Could not reach the sign-in provider.");
    }

    const user = await store.upsertByWallet({
      id: randomUUID(),
      walletAddress: result.walletAddress,
      phone: identity.phone,
      email: identity.email,
      now: new Date().toISOString(),
    });
    if (user.disabledAt) {
      return jsonError(context, 403, "account_disabled", "This account is disabled.");
    }
    if (allowlist && !isAllowlisted(user, allowlist)) {
      // The user row still exists so an operator can approve them later.
      return context.json({ ok: false, access: "pending" }, 403);
    }

    const session = await store.insertSession({ id: randomUUID(), userId: user.id, now: new Date().toISOString() });
    await installUserAuthCookie(context, signingKey, session.id);
    return context.json({
      ok: true,
      isNewUser: result.isNewUser,
      user: { id: user.id, walletAddress: user.walletAddress, phone: user.phone, email: user.email },
      access: "member",
    });
  });

  return app;
}

/** E.164 normalization (airv2 rules): keep leading `+`, US-assume bare 10/11-digit numbers, else prefix `+`. */
function normalizePhone(value: string): string {
  const digits = value.replace(/[^+\d]/g, "");
  if (digits.startsWith("+")) return digits;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  return digits ? `+${digits}` : "";
}

function readAuthChannel(body: JsonRequestBody): ThirdwebAuthChannel | undefined {
  const channel = optionalString(body.channel);
  return channel === "sms" || channel === "email" ? channel : undefined;
}

function readAuthIdentity(
  body: JsonRequestBody,
  channel: ThirdwebAuthChannel,
): { phone?: string; email?: string } | undefined {
  if (channel === "sms") {
    const phone = normalizePhone(optionalString(body.phone) ?? "");
    return e164PhonePattern.test(phone) ? { phone } : undefined;
  }
  const email = optionalString(body.email)?.trim().toLowerCase();
  return email && emailPattern.test(email) ? { email } : undefined;
}

function invalidIdentity(context: Context, channel: ThirdwebAuthChannel): Response {
  return jsonError(
    context,
    400,
    "invalid_input",
    channel === "sms" ? "phone must be an E.164 number like +14155552671." : "email must be a valid address.",
  );
}

/**
 * Parse `OOMOL_CONNECT_AUTH_ALLOWLIST`. Phones are normalized to E.164 like sign-in
 * input so either "510-415-4787" or "+15104154787" matches; emails and wallets
 * compare case-insensitively. An unset/empty list means open sign-up (undefined).
 */
function parseAuthAllowlist(raw: string | undefined): Set<string> | undefined {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    return undefined;
  }
  const listed = new Set<string>();
  for (const entry of entries) {
    listed.add(entry.toLowerCase());
    if (!entry.includes("@")) {
      const phone = normalizePhone(entry);
      if (e164PhonePattern.test(phone)) {
        listed.add(phone);
      }
    }
  }
  return listed;
}

function isAllowlisted(user: ConsoleUser, allowlist: Set<string>): boolean {
  return (
    allowlist.has(user.walletAddress.toLowerCase()) ||
    (user.phone !== undefined && allowlist.has(user.phone)) ||
    (user.email !== undefined && allowlist.has(user.email))
  );
}
