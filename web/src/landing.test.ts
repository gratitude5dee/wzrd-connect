import { I18nProvider } from "@embra/i18n/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppI18n } from "./i18n";
import { LandingPage } from "./landing-page";
import { App, loadRuntimeData } from "./ui";

function renderLanding(signedIn: boolean): string {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { i18n: createAppI18n("en") },
      createElement(
        MemoryRouter,
        { initialEntries: ["/"] },
        createElement(LandingPage, { signedIn, theme: "auto", onThemeChange: () => {} }),
      ),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LandingPage", () => {
  it("renders the public landing for a signed-out visitor with Connect now pointing at /auth", () => {
    const markup = renderLanding(false);

    expect(markup).toContain("landing-page");
    expect(markup).toContain("Connect your services");
    expect(markup).toContain("Powered by PACT custody");
    // Connect now (top bar + hero) and View docs all lead to sign-in: /docs
    // sits behind the console session, so docs start at /auth.
    expect(markup.match(/href="\/auth"/g)).toHaveLength(3);
    expect(markup).not.toContain("/api/");
  });

  it("sends a signed-in visitor to the console and exposes the real docs link", () => {
    const markup = renderLanding(true);

    expect(markup.match(/href="\/overview"/g)).toHaveLength(2);
    expect(markup).toContain('href="/docs"');
    expect(markup).not.toContain('href="/auth"');
  });

  it("renders the landing immediately on / without the console shell", () => {
    const markup = renderToStaticMarkup(
      createElement(
        I18nProvider,
        { i18n: createAppI18n("en") },
        createElement(MemoryRouter, { initialEntries: ["/"] }, createElement(App)),
      ),
    );

    expect(markup).toContain("landing-page");
    expect(markup).toContain('href="/auth"');
    expect(markup).not.toContain("app-shell");
    expect(markup).not.toContain("unlock-panel");
  });
});

describe("landing data surface", () => {
  it("fetches no console data when the session probe comes back unauthenticated", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: RequestInfo | URL) => {
        calls.push(String(path));
        return Response.json({ adminAuthConfigured: true, authenticated: false });
      }),
    );

    const result = await loadRuntimeData("");

    expect(result.authSession.authenticated).toBe(false);
    // The only request a signed-out visitor ever triggers — on `/` or
    // anywhere else — is the session probe; console data stays untouched.
    expect(calls).toEqual(["/api/auth/session"]);
    expect(calls).not.toContain("/api/connections");
  });
});
