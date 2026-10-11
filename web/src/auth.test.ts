import { I18nProvider } from "@embra/i18n/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authDisplayIdentity,
  authGateTarget,
  editOtpCode,
  isOtpComplete,
  isPublicAuthPath,
  normalizePhoneInput,
  otpResendCooldownMs,
  otpResendRemainingSeconds,
  sanitizeNextPath,
  sendSignInCode,
  startOtpStep,
  truncateWalletAddress,
  validSignInIdentity,
  verifySignInCode,
} from "./auth";
import { AuthPage, AuthPendingPage, LandingStub } from "./auth-page";
import { createAppI18n } from "./i18n";

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderEnglish(node: ReturnType<typeof createElement>, route = "/auth"): string {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { i18n: createAppI18n("en") },
      createElement(MemoryRouter, { initialEntries: [route] }, node),
    ),
  );
}

describe("sanitizeNextPath", () => {
  it("keeps local console paths, including their query string", () => {
    expect(sanitizeNextPath("/agents")).toBe("/agents");
    expect(sanitizeNextPath("/providers?onekey=1")).toBe("/providers?onekey=1");
    expect(sanitizeNextPath("/welcome")).toBe("/welcome");
  });

  it("falls back to /overview for empty or non-path values", () => {
    expect(sanitizeNextPath(null)).toBe("/overview");
    expect(sanitizeNextPath("")).toBe("/overview");
    expect(sanitizeNextPath("agents")).toBe("/overview");
  });

  it("rejects external URLs, protocol-relative URLs, and backslashes", () => {
    expect(sanitizeNextPath("//evil.com")).toBe("/overview");
    expect(sanitizeNextPath("https://evil.com")).toBe("/overview");
    expect(sanitizeNextPath("/\\evil.com")).toBe("/overview");
    expect(sanitizeNextPath("/agents\\@evil.com")).toBe("/overview");
  });

  it("rejects auth pages so a redirect can never loop", () => {
    expect(sanitizeNextPath("/auth")).toBe("/overview");
    expect(sanitizeNextPath("/auth/pending")).toBe("/overview");
  });
});

describe("authGateTarget", () => {
  it("never gates public paths", () => {
    expect(authGateTarget("/", "", false)).toBeNull();
    expect(authGateTarget("/auth", "", false)).toBeNull();
    expect(authGateTarget("/auth/pending", "", false)).toBeNull();
    expect(isPublicAuthPath("/")).toBe(true);
    expect(isPublicAuthPath("/auth")).toBe(true);
    expect(isPublicAuthPath("/auth/pending")).toBe(true);
  });

  it("bounces unauthenticated console routes to /auth with next", () => {
    expect(authGateTarget("/agents", "", false)).toBe("/auth?next=%2Fagents");
    expect(authGateTarget("/overview", "?tab=a", false)).toBe("/auth?next=%2Foverview%3Ftab%3Da");
  });

  it("lets authenticated sessions through", () => {
    expect(authGateTarget("/agents", "", true)).toBeNull();
  });
});

describe("authDisplayIdentity", () => {
  it("shows nothing for anonymous or credential-less sessions", () => {
    expect(authDisplayIdentity({ adminAuthConfigured: false, authenticated: false })).toBeNull();
    expect(authDisplayIdentity({ adminAuthConfigured: false, authenticated: true })).toBeNull();
  });

  it("labels admin-credential sessions as the operator", () => {
    expect(authDisplayIdentity({ adminAuthConfigured: true, authenticated: true, kind: "admin" })).toEqual({
      kind: "operator",
    });
  });

  it("truncates the wallet for console users", () => {
    expect(
      authDisplayIdentity({
        adminAuthConfigured: true,
        authenticated: true,
        kind: "user",
        user: { id: "u1", walletAddress: "0x1234abcd5678efgh" },
      }),
    ).toEqual({ kind: "user", label: "0x1234…efgh" });
    expect(truncateWalletAddress("0x1234abcd5678efgh")).toBe("0x1234…efgh");
    expect(truncateWalletAddress("0x1234")).toBe("0x1234");
  });

  it("falls back to phone then email when the user has no wallet", () => {
    expect(
      authDisplayIdentity({
        adminAuthConfigured: true,
        authenticated: true,
        kind: "user",
        user: { id: "u1", walletAddress: "", phone: "+14155552671" },
      }),
    ).toEqual({ kind: "user", label: "+14155552671" });
    expect(
      authDisplayIdentity({
        adminAuthConfigured: true,
        authenticated: true,
        kind: "user",
        user: { id: "u1", walletAddress: "", email: "a@b.co" },
      }),
    ).toEqual({ kind: "user", label: "a@b.co" });
  });
});

describe("validSignInIdentity", () => {
  it("normalizes phone input to E.164", () => {
    expect(normalizePhoneInput("+1 415 555 2671")).toBe("+14155552671");
    expect(normalizePhoneInput("4155552671")).toBe("+14155552671");
    expect(validSignInIdentity("sms", "+14155552671")).toBe("+14155552671");
    expect(validSignInIdentity("sms", "not a phone")).toBeUndefined();
    expect(validSignInIdentity("sms", "+12")).toBeUndefined();
  });

  it("trims and lowercases email", () => {
    expect(validSignInIdentity("email", "  A@B.CO ")).toBe("a@b.co");
    expect(validSignInIdentity("email", "not-an-email")).toBeUndefined();
  });
});

describe("OTP step state", () => {
  it("gates resend for the cooldown window", () => {
    const state = startOtpStep(10_000);
    expect(state.resendAvailableAt).toBe(10_000 + otpResendCooldownMs);
    expect(otpResendRemainingSeconds(state, 10_000)).toBe(30);
    expect(otpResendRemainingSeconds(state, 39_500)).toBe(1);
    expect(otpResendRemainingSeconds(state, 40_000)).toBe(0);
  });

  it("keeps digits only and caps the code at 6", () => {
    const state = startOtpStep(0);
    expect(editOtpCode(state, "12ab34 56").code).toBe("123456");
    expect(editOtpCode(state, "12345678").code).toBe("123456");
    expect(isOtpComplete("123456")).toBe(true);
    expect(isOtpComplete("12345")).toBe(false);
  });
});

function stubFetchJson(handler: (path: string, body: unknown) => { status: number; payload: unknown }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      const { status, payload } = handler(String(path), JSON.parse(String(init?.body ?? "{}")));
      return Response.json(payload, { status });
    }),
  );
}

describe("sendSignInCode", () => {
  it("posts the channel-shaped body to initiate", async () => {
    const bodies: unknown[] = [];
    stubFetchJson((path, body) => {
      bodies.push(body);
      return path === "/api/auth/thirdweb/initiate"
        ? { status: 200, payload: { ok: true } }
        : { status: 404, payload: {} };
    });

    expect(await sendSignInCode("sms", "+14155552671")).toEqual({ outcome: "sent" });
    expect(await sendSignInCode("email", "a@b.co")).toEqual({ outcome: "sent" });
    expect(bodies).toEqual([
      { channel: "sms", phone: "+14155552671" },
      { channel: "email", email: "a@b.co" },
    ]);
  });

  it("maps a 429 to the rate-limit copy", async () => {
    stubFetchJson(() => ({ status: 429, payload: { error: { code: "rate_limited", message: "slow down" } } }));
    expect(await sendSignInCode("sms", "+14155552671")).toEqual({ outcome: "error", error: "rateLimited" });
  });
});

describe("verifySignInCode", () => {
  it("returns the signed-in user on success", async () => {
    stubFetchJson(() => ({
      status: 200,
      payload: { ok: true, isNewUser: true, access: "member", user: { id: "u1", walletAddress: "0x1234" } },
    }));
    expect(await verifySignInCode("sms", "+14155552671", "123456")).toEqual({
      outcome: "signedIn",
      isNewUser: true,
      user: { id: "u1", walletAddress: "0x1234" },
    });
  });

  it("treats the code-less 403 pending body as the allowlist gate", async () => {
    stubFetchJson(() => ({ status: 403, payload: { ok: false, access: "pending" } }));
    expect(await verifySignInCode("sms", "+14155552671", "123456")).toEqual({ outcome: "pending" });
  });

  it("maps an invalid code to the inline error", async () => {
    stubFetchJson(() => ({ status: 401, payload: { error: { code: "invalid_code", message: "bad code" } } }));
    expect(await verifySignInCode("sms", "+14155552671", "123456")).toEqual({
      outcome: "error",
      error: "invalidCode",
    });
  });

  it("maps a disabled account (403 with an envelope code) to its own error", async () => {
    stubFetchJson(() => ({ status: 403, payload: { error: { code: "account_disabled", message: "disabled" } } }));
    expect(await verifySignInCode("sms", "+14155552671", "123456")).toEqual({
      outcome: "error",
      error: "disabled",
    });
  });
});

describe("AuthPage", () => {
  it("renders the identify step with both channel tabs and the operator section", () => {
    const markup = renderEnglish(
      createElement(AuthPage, {
        loading: false,
        authenticated: false,
        operatorMessage: null,
        theme: "light",
        onThemeChange: () => {},
        onUnlock: () => {},
        onSignedIn: () => {},
      }),
    );

    expect(markup).toContain("Phone");
    expect(markup).toContain("Email");
    expect(markup).toContain("Send code");
    expect(markup).toContain("Operator sign-in");
    expect(markup).toContain("WZRD Connect");
  });
});

describe("AuthPendingPage", () => {
  it("shows the pending identity and a sign-out action", () => {
    const markup = renderToStaticMarkup(
      createElement(
        I18nProvider,
        { i18n: createAppI18n("en") },
        createElement(
          MemoryRouter,
          { initialEntries: [{ pathname: "/auth/pending", state: { identity: "+14155552671" } }] },
          createElement(AuthPendingPage, { theme: "light", onThemeChange: () => {} }),
        ),
      ),
    );

    expect(markup).toContain("Access pending");
    expect(markup).toContain("+14155552671");
    expect(markup).toContain("Sign out");
  });
});

describe("LandingStub", () => {
  it("renders the placeholder seam with a link to /auth", () => {
    const markup = renderEnglish(createElement(LandingStub, { theme: "light", onThemeChange: () => {} }), "/");
    expect(markup).toContain("WZRD Connect");
    expect(markup).toContain("/auth");
  });
});
