import { afterEach, describe, expect, it } from "vitest";
import { setDefaultGuardedFetchDnsLookup } from "../core/guarded-fetch.ts";
import { PactCardError, fetchAgentCard, resolveAgentCardUrl, validatePactAgentCard } from "./agent-card.ts";

const interfaceUrl = "https://provider.example.com/a2a";

function validCard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Acme Support",
    version: "1.0",
    supportedInterfaces: [{ url: interfaceUrl, protocolBinding: "HTTP+JSON", protocolVersion: "1.0" }],
    provider: { organization: "Acme", url: "https://provider.example.com" },
    securitySchemes: {
      paJwt: { httpAuthSecurityScheme: { scheme: "Bearer", bearerFormat: "JWT" } },
    },
    securityRequirements: [{ schemes: { paJwt: { list: [] } } }],
    skills: [{ id: "support", name: "Support", description: "Customer support", tags: ["support"] }],
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

afterEach(() => {
  setDefaultGuardedFetchDnsLookup(null);
});

describe("resolveAgentCardUrl", () => {
  it("walks a bare origin to the well-known card path", () => {
    expect(resolveAgentCardUrl("https://brand.example.com")).toBe(
      "https://brand.example.com/.well-known/agent-card.json",
    );
    expect(resolveAgentCardUrl("https://brand.example.com/")).toBe(
      "https://brand.example.com/.well-known/agent-card.json",
    );
  });

  it("keeps an explicit card path verbatim", () => {
    expect(resolveAgentCardUrl("https://brand.example.com/cards/acme.json")).toBe(
      "https://brand.example.com/cards/acme.json",
    );
  });

  it("rejects a non-URL", () => {
    expect(() => resolveAgentCardUrl("not a url")).toThrowError(PactCardError);
  });
});

describe("validatePactAgentCard", () => {
  it("accepts a valid card and normalizes its facts", async () => {
    const card = await validatePactAgentCard(validCard());
    expect(card).toMatchObject({
      name: "Acme Support",
      version: "1.0",
      interfaceUrl,
      providerOrigin: "https://provider.example.com",
      skills: [{ id: "support", name: "Support", description: "Customer support", tags: ["support"] }],
    });
    expect(card.delegation).toBeUndefined();
    expect(card.fetchedAt).toEqual(expect.any(String));
  });

  it("rejects a card with no name", async () => {
    await expect(validatePactAgentCard(validCard({ name: "" }))).rejects.toMatchObject({
      code: "pact_card_invalid",
      reason: "missing_name",
    });
  });

  it("rejects a card without supportedInterfaces", async () => {
    await expect(validatePactAgentCard(validCard({ supportedInterfaces: [] }))).rejects.toMatchObject({
      code: "pact_card_invalid",
      reason: "missing_interface",
    });
  });

  it("rejects a card whose only interface has the wrong binding", async () => {
    await expect(
      validatePactAgentCard(
        validCard({
          supportedInterfaces: [{ url: interfaceUrl, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
        }),
      ),
    ).rejects.toMatchObject({ code: "pact_card_invalid", reason: "unsupported_binding" });
  });

  it("selects the HTTP+JSON/1.0 interface by binding+version, not position", async () => {
    const card = await validatePactAgentCard(
      validCard({
        supportedInterfaces: [
          { url: "https://provider.example.com/jsonrpc", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
          { url: interfaceUrl, protocolBinding: "HTTP+JSON", protocolVersion: "1.0" },
        ],
      }),
    );
    expect(card.interfaceUrl).toBe(interfaceUrl);
  });

  it("rejects a card missing the lone Bearer JWT security requirement", async () => {
    await expect(validatePactAgentCard(validCard({ securityRequirements: [] }))).rejects.toMatchObject({
      code: "pact_card_invalid",
      reason: "pa_jwt_scheme_missing",
    });
    // A combined requirement (paJwt + userDelegation in one entry) is not the required lone entry.
    await expect(
      validatePactAgentCard(
        validCard({
          securityRequirements: [{ schemes: { paJwt: { list: [] }, userDelegation: { list: [] } } }],
        }),
      ),
    ).rejects.toMatchObject({ code: "pact_card_invalid", reason: "pa_jwt_scheme_missing" });
  });

  it("tolerates extra schemes and extra requirement entries", async () => {
    const card = await validatePactAgentCard(
      validCard({
        securitySchemes: {
          apiKey: { apiKeySecurityScheme: { name: "x-api-key", location: "header" } },
          paJwt: { httpAuthSecurityScheme: { scheme: "Bearer", bearerFormat: "JWT" } },
        },
        securityRequirements: [{ schemes: { apiKey: { list: [] } } }, { schemes: { paJwt: { list: [] } } }],
      }),
    );
    expect(card.interfaceUrl).toBe(interfaceUrl);
  });

  it("rejects an http interface URL that is not loopback", async () => {
    await expect(
      validatePactAgentCard(
        validCard({
          supportedInterfaces: [
            { url: "http://provider.example.com/a2a", protocolBinding: "HTTP+JSON", protocolVersion: "1.0" },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "pact_card_invalid", reason: "url_rejected" });
  });

  it("parses the deviceCode delegation flow when advertised", async () => {
    const card = await validatePactAgentCard(
      validCard({
        securitySchemes: {
          paJwt: { httpAuthSecurityScheme: { scheme: "Bearer", bearerFormat: "JWT" } },
          userDelegation: {
            oauth2SecurityScheme: {
              flows: {
                deviceCode: {
                  deviceAuthorizationUrl: "https://provider.example.com/oauth2/device_authorization",
                  tokenUrl: "https://provider.example.com/oauth2/token",
                  scopes: { "pact:messages": "Send the Brand messages" },
                },
              },
              oauth2MetadataUrl: "https://provider.example.com/.well-known/oauth-authorization-server",
            },
          },
        },
      }),
    );
    expect(card.delegation).toMatchObject({
      deviceAuthorizationUrl: "https://provider.example.com/oauth2/device_authorization",
      tokenUrl: "https://provider.example.com/oauth2/token",
      scopes: { "pact:messages": "Send the Brand messages" },
    });
  });

  it("rejects a deviceCode flow missing required URLs", async () => {
    await expect(
      validatePactAgentCard(
        validCard({
          securitySchemes: {
            paJwt: { httpAuthSecurityScheme: { scheme: "Bearer", bearerFormat: "JWT" } },
            userDelegation: { oauth2SecurityScheme: { flows: { deviceCode: { tokenUrl: "https://x/token" } } } },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "pact_card_invalid", reason: "invalid_delegation_flow" });
  });
});

describe("fetchAgentCard", () => {
  it("fetches and validates a card through the injected fetcher", async () => {
    const seen: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      seen.push(String(input));
      return jsonResponse(validCard());
    };
    const card = await fetchAgentCard("https://provider.example.com", { fetcher });
    expect(card.interfaceUrl).toBe(interfaceUrl);
    expect(seen).toEqual(["https://provider.example.com/.well-known/agent-card.json"]);
  });

  it("follows a re-validated redirect", async () => {
    const seen: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith("/.well-known/agent-card.json")) {
        return new Response(null, { status: 302, headers: { location: "/cards/agent.json" } });
      }
      return jsonResponse(validCard());
    };
    const card = await fetchAgentCard("https://provider.example.com", { fetcher });
    expect(card.interfaceUrl).toBe(interfaceUrl);
    expect(seen).toEqual([
      "https://provider.example.com/.well-known/agent-card.json",
      "https://provider.example.com/cards/agent.json",
    ]);
  });

  it("rejects a redirect to a private address", async () => {
    const fetcher: typeof fetch = async () =>
      new Response(null, { status: 302, headers: { location: "https://169.254.169.254/agent.json" } });
    await expect(fetchAgentCard("https://provider.example.com", { fetcher })).rejects.toMatchObject({
      code: "pact_card_invalid",
      reason: "url_rejected",
    });
  });

  it("rejects a private-IP target", async () => {
    await expect(
      fetchAgentCard("https://169.254.169.254", {
        fetcher: async () => jsonResponse(validCard()),
      }),
    ).rejects.toMatchObject({ code: "pact_card_invalid", reason: "url_rejected" });
  });

  it("rejects a hostname that resolves to a private address", async () => {
    setDefaultGuardedFetchDnsLookup(async () => [{ address: "10.0.0.8", family: 4 }]);
    await expect(
      fetchAgentCard("https://provider.example.com", {
        fetcher: async () => jsonResponse(validCard()),
      }),
    ).rejects.toMatchObject({ code: "pact_card_invalid", reason: "url_rejected" });
  });

  it("rejects an oversized card body", async () => {
    const big = "x".repeat(65 * 1024);
    const fetcher: typeof fetch = async () => new Response(big, { status: 200 });
    await expect(fetchAgentCard("https://provider.example.com", { fetcher })).rejects.toMatchObject({
      code: "pact_provider_unavailable",
      reason: "oversized",
    });
  });

  it("rejects a non-JSON body", async () => {
    const fetcher: typeof fetch = async () => new Response("not json", { status: 200 });
    await expect(fetchAgentCard("https://provider.example.com", { fetcher })).rejects.toMatchObject({
      code: "pact_card_invalid",
      reason: "invalid_json",
    });
  });

  it("rejects http loopback unless the insecure-loopback flag is set", async () => {
    const fetcher: typeof fetch = async () => jsonResponse(validCard());
    await expect(fetchAgentCard("http://localhost:8787", { fetcher })).rejects.toMatchObject({
      code: "pact_card_invalid",
      reason: "url_rejected",
    });
    await expect(
      fetchAgentCard("http://localhost:8787", { fetcher, allowInsecureLoopback: true }),
    ).resolves.toMatchObject({ interfaceUrl });
  });

  it("maps a transport failure to pact_provider_unavailable", async () => {
    const fetcher: typeof fetch = async () => {
      throw new Error("socket hangup");
    };
    await expect(fetchAgentCard("https://provider.example.com", { fetcher })).rejects.toMatchObject({
      code: "pact_provider_unavailable",
    });
  });
});
