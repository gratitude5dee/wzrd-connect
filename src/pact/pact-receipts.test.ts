import type { PactConnectionCredential } from "./pact-connection.ts";

import { afterEach, describe, expect, it } from "vitest";
import { PlainTextSecretCodec } from "../server/secrets/secret-codec-core.ts";
import { SqliteRuntimeDatabase } from "../server/storage/sqlite/runtime-store.ts";
import { PactIdentityService } from "./pact-identity-service.ts";
import { PactReceiptService } from "./pact-receipts.ts";

const issuer = "http://localhost:3000";
const jwksUri = "https://brand.example.com/.well-known/jwks.json";
const databases: SqliteRuntimeDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

async function createService(fetcher: typeof fetch): Promise<PactReceiptService> {
  const database = new SqliteRuntimeDatabase(":memory:");
  databases.push(database);
  const identity = new PactIdentityService({
    store: database.pactIdentityStore,
    secretCodec: new PlainTextSecretCodec(),
    issuer,
  });
  return new PactReceiptService({ identity, fetcher });
}

interface ReceiptKeyPair {
  sign: (claims: Record<string, unknown>) => Promise<string>;
  publicJwk: Record<string, unknown>;
}

async function createReceiptKey(kid: string): Promise<ReceiptKeyPair> {
  const { generateKeyPair, exportJWK, SignJWT } = await import("jose");
  const pair = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = { ...(await exportJWK(pair.publicKey)), kid, alg: "ES256" } as Record<string, unknown>;
  return {
    publicJwk,
    sign: async (claims) =>
      new SignJWT(claims).setProtectedHeader({ alg: "ES256", kid, typ: "JWT" }).sign(pair.privateKey),
  };
}

function brandCredential(options: { grantId?: string; jwksUri?: string } = {}): PactConnectionCredential {
  return {
    authType: "oauth2",
    source: "pact",
    cardUrl: "https://brand.example.com",
    interfaceUrl: "https://brand.example.com/a2a",
    providerOrigin: "https://brand.example.com",
    registrationId: "reg-1",
    card: { name: "Brand", skills: [], fetchedAt: new Date().toISOString() },
    profile: { accountId: "person-1", displayName: "Person One" },
    delegation: {
      deviceAuthorizationUrl: "https://brand.example.com/device",
      tokenUrl: "https://brand.example.com/token",
      scopes: {},
      grantId: options.grantId,
      jwksUri: options.jwksUri,
    },
  };
}

function jwksFetcher(jwks: { keys: Record<string, unknown>[] }): typeof fetch {
  return (async () => new Response(JSON.stringify(jwks), { status: 200 })) as typeof fetch;
}

describe("PactReceiptService.verifyProviderReceipt", () => {
  it("verifies a receipt whose claims match payload, grant, and issuer", async () => {
    const key = await createReceiptKey("brand-key-1");
    const service = await createService(jwksFetcher({ keys: [key.publicJwk] }));
    const claims = { pa: issuer, grantId: "grant-1", scopes: ["pact:messages"], iat: 1700000000 };
    const jws = await key.sign(claims);
    const result = await service.verifyProviderReceipt({
      credential: brandCredential({ grantId: "grant-1", jwksUri }),
      metadata: { "pact.receipt": { jws, claims } },
    });
    expect(result).toMatchObject({ verified: true, jws, claims });
    expect(result.failureReason).toBeUndefined();
  });

  it("reports pact_receipt_missing when the reply carries no receipt", async () => {
    const service = await createService(jwksFetcher({ keys: [] }));
    const result = await service.verifyProviderReceipt({
      credential: brandCredential({ jwksUri }),
      metadata: {},
    });
    expect(result).toMatchObject({ verified: false, failureReason: "pact_receipt_missing" });
    expect(result.jws).toBeUndefined();
  });

  it("reports pact_receipt_malformed for incomplete receipt objects", async () => {
    const service = await createService(jwksFetcher({ keys: [] }));
    const noClaims = await service.verifyProviderReceipt({
      credential: brandCredential({ jwksUri }),
      metadata: { "pact.receipt": { jws: "a.b.c" } },
    });
    expect(noClaims).toMatchObject({ verified: false, failureReason: "pact_receipt_malformed" });

    const badJws = await service.verifyProviderReceipt({
      credential: brandCredential({ jwksUri }),
      metadata: { "pact.receipt": { jws: "not-a-jws", claims: { pa: issuer } } },
    });
    expect(badJws).toMatchObject({ verified: false, failureReason: "pact_receipt_malformed" });
  });

  it("reports pact_receipt_payload_mismatch when claims differ from the JWS payload", async () => {
    const key = await createReceiptKey("brand-key-1");
    const service = await createService(jwksFetcher({ keys: [key.publicJwk] }));
    const jws = await key.sign({ pa: issuer, grantId: "grant-1" });
    const claims = { pa: issuer, grantId: "grant-1", tampered: true };
    const result = await service.verifyProviderReceipt({
      credential: brandCredential({ grantId: "grant-1", jwksUri }),
      metadata: { "pact.receipt": { jws, claims } },
    });
    expect(result).toMatchObject({ verified: false, failureReason: "pact_receipt_payload_mismatch" });
  });

  it("reports pact_receipt_signature_invalid for wrong-key signatures and unknown kids", async () => {
    const key = await createReceiptKey("brand-key-1");
    const other = await createReceiptKey("brand-key-other");
    const service = await createService(jwksFetcher({ keys: [key.publicJwk] }));
    const claims = { pa: issuer, grantId: "grant-1" };

    const wrongKey = await service.verifyProviderReceipt({
      credential: brandCredential({ grantId: "grant-1", jwksUri }),
      metadata: { "pact.receipt": { jws: await other.sign(claims), claims } },
    });
    expect(wrongKey).toMatchObject({ verified: false, failureReason: "pact_receipt_signature_invalid" });

    const unknownKid = await key.sign(claims);
    const keyOtherKid = await createReceiptKey("brand-key-missing");
    const unknownKidJws = await keyOtherKid.sign(claims);
    const result = await service.verifyProviderReceipt({
      credential: brandCredential({ grantId: "grant-1", jwksUri }),
      metadata: { "pact.receipt": { jws: unknownKidJws, claims } },
    });
    expect(result).toMatchObject({ verified: false, failureReason: "pact_receipt_signature_invalid" });
    expect(unknownKid.split(".")).toHaveLength(3);
  });

  it("reports pact_receipt_jwks_unavailable when the JWKS fetch fails or is absent", async () => {
    const key = await createReceiptKey("brand-key-1");
    const claims = { pa: issuer, grantId: "grant-1" };
    const jws = await key.sign(claims);

    const down = await createService((async () => new Response("down", { status: 503 })) as typeof fetch);
    const downResult = await down.verifyProviderReceipt({
      credential: brandCredential({ grantId: "grant-1", jwksUri }),
      metadata: { "pact.receipt": { jws, claims } },
    });
    expect(downResult).toMatchObject({ verified: false, failureReason: "pact_receipt_jwks_unavailable" });

    const up = await createService(jwksFetcher({ keys: [key.publicJwk] }));
    const noUri = await up.verifyProviderReceipt({
      credential: brandCredential({ grantId: "grant-1" }),
      metadata: { "pact.receipt": { jws, claims } },
    });
    expect(noUri).toMatchObject({ verified: false, failureReason: "pact_receipt_jwks_unavailable" });
  });

  it("reports pact_receipt_grant_mismatch when claims.grantId differs from the connection grant", async () => {
    const key = await createReceiptKey("brand-key-1");
    const service = await createService(jwksFetcher({ keys: [key.publicJwk] }));
    const claims = { pa: issuer, grantId: "grant-other" };
    const jws = await key.sign(claims);
    const result = await service.verifyProviderReceipt({
      credential: brandCredential({ grantId: "grant-1", jwksUri }),
      metadata: { "pact.receipt": { jws, claims } },
    });
    expect(result).toMatchObject({ verified: false, failureReason: "pact_receipt_grant_mismatch" });
  });

  it("reports pact_receipt_issuer_mismatch when claims.pa is not the Connect issuer", async () => {
    const key = await createReceiptKey("brand-key-1");
    const service = await createService(jwksFetcher({ keys: [key.publicJwk] }));
    const claims = { pa: "https://evil.example.com", grantId: "grant-1" };
    const jws = await key.sign(claims);
    const result = await service.verifyProviderReceipt({
      credential: brandCredential({ grantId: "grant-1", jwksUri }),
      metadata: { "pact.receipt": { jws, claims } },
    });
    expect(result).toMatchObject({ verified: false, failureReason: "pact_receipt_issuer_mismatch" });
  });
});
