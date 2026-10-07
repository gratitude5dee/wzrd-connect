import type { JWK } from "jose";

import { calculateJwkThumbprint, createLocalJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { PlainTextSecretCodec } from "../server/secrets/secret-codec-core.ts";
import { AesGcmSecretCodec } from "../server/secrets/secret-codec.ts";
import { SqliteRuntimeDatabase } from "../server/storage/sqlite/runtime-store.ts";
import { PactIdentityService } from "./pact-identity-service.ts";

const issuer = "https://connect.example.com";

function createService(options: { encrypted?: boolean; issuer?: string; keyGraceSeconds?: number } = {}) {
  const secretCodec =
    options.encrypted === false ? new PlainTextSecretCodec() : new AesGcmSecretCodec("test-encryption-key");
  const database = new SqliteRuntimeDatabase(":memory:", { secretCodec });
  const service = new PactIdentityService({
    store: database.pactIdentityStore,
    secretCodec,
    issuer: options.issuer === undefined ? issuer : options.issuer,
    keyGraceSeconds: options.keyGraceSeconds,
  });
  return { database, service };
}

describe("PactIdentityService", () => {
  it("refuses identity creation without an encryption codec", async () => {
    const { database, service } = createService({ encrypted: false });
    await expect(service.create()).rejects.toMatchObject({ name: "PactIdentityError", code: "encryption_required" });
    database.close();
  });

  it("refuses identity creation without an issuer", async () => {
    const { database, service } = createService({ issuer: "" });
    await expect(service.create()).rejects.toMatchObject({ name: "PactIdentityError", code: "pact_origin_required" });
    database.close();
  });

  it("creates an ES256/P-256 identity whose kid is the RFC 7638 thumbprint", async () => {
    const { database, service } = createService();
    const summary = await service.create();

    expect(summary.kid).toEqual(expect.any(String));
    expect(summary.issuer).toBe(issuer);
    expect(summary.jwksUrl).toBe(`${issuer}/.well-known/jwks.json`);
    expect(summary.subject).toBe("configured");

    const jwks = await service.getJwks();
    expect(jwks.keys).toHaveLength(1);
    const [key] = jwks.keys;
    expect(key).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256", use: "sig", kid: summary.kid });
    expect(key.d).toBeUndefined();
    await expect(calculateJwkThumbprint(key as JWK, "sha256")).resolves.toBe(summary.kid);

    await expect(service.create()).rejects.toMatchObject({ code: "pact_identity_exists" });
    database.close();
  });

  it("serves the current and previous keys inside the grace window, then drops the previous", async () => {
    const { database, service } = createService({ keyGraceSeconds: 3600 });
    const first = await service.create();
    const rotated = await service.rotate();

    expect(rotated.kid).not.toBe(first.kid);
    expect(rotated.previousKid).toBe(first.kid);
    expect(rotated.rotatedAt).toEqual(expect.any(String));

    const insideGrace = await service.getJwks(new Date(Date.now() + 1000));
    expect(insideGrace.keys.map((key) => key.kid)).toEqual([rotated.kid, first.kid]);

    const pastGrace = await service.getJwks(new Date(Date.now() + 3601 * 1000));
    expect(pastGrace.keys.map((key) => key.kid)).toEqual([rotated.kid]);
    database.close();
  });

  it("keeps the deployment subject stable across rotation", async () => {
    const { database, service } = createService();
    await service.create();
    const subject = await service.readDeploymentSubject();
    expect(subject).toEqual(expect.any(String));

    await service.rotate();
    await expect(service.readDeploymentSubject()).resolves.toBe(subject);
    database.close();
  });

  it("signs a PA-JWT that verifies against the served JWKS under the wire rules", async () => {
    const { database, service } = createService();
    const summary = await service.create();
    const token = await service.signPersonalAgentJwt({ subject: "token-subject-1", audience: "brand.example" });

    // Wire shape: ES256 header, matching kid, typ JWT.
    const header = decodeProtectedHeader(token);
    expect(header).toMatchObject({ alg: "ES256", kid: summary.kid, typ: "JWT" });

    // Replicated OpenPACT verifyPlatformJwt rules: iss exact, aud exact,
    // exp - iat <= 300 s, signature verified against the served JWKS.
    const claims = decodeJwt(token);
    expect(claims.iss).toBe(issuer);
    expect(claims.sub).toBe("token-subject-1");
    expect(claims.aud).toBe("brand.example");
    expect(claims.exp! - claims.iat!).toBeLessThanOrEqual(300);
    expect(claims.exp! - claims.iat!).toBe(120);
    expect(claims.jti).toEqual(expect.any(String));

    const jwks = createLocalJWKSet(await service.getJwks());
    const verified = await jwtVerify(token, jwks, {
      issuer,
      audience: "brand.example",
      algorithms: ["ES256", "RS256"],
      clockTolerance: 30,
    });
    expect(verified.payload.sub).toBe("token-subject-1");
    database.close();
  });

  it("mints a registration token with sub = iss and aud = endpoint URL", async () => {
    const { database, service } = createService();
    await service.create();
    const endpoint = "https://provider.example.com/pact/register";
    const token = await service.signRegistrationToken(endpoint);

    const claims = decodeJwt(token);
    expect(claims.iss).toBe(issuer);
    expect(claims.sub).toBe(issuer);
    expect(claims.aud).toBe(endpoint);
    expect(claims.exp! - claims.iat!).toBeLessThanOrEqual(300);

    const jwks = createLocalJWKSet(await service.getJwks());
    await expect(jwtVerify(token, jwks, { issuer, audience: endpoint, algorithms: ["ES256"] })).resolves.toBeDefined();
    database.close();
  });

  it("refuses to rotate or sign without an identity", async () => {
    const { database, service } = createService();
    await expect(service.rotate()).rejects.toMatchObject({ code: "pact_identity_not_found" });
    await expect(service.signPersonalAgentJwt({ subject: "s", audience: "a" })).rejects.toMatchObject({
      code: "pact_identity_not_found",
    });
    await expect(service.getJwks()).resolves.toEqual({ keys: [] });
    await expect(service.get()).resolves.toBeUndefined();
    database.close();
  });

  it("returns issuer metadata only when the origin is configured", async () => {
    const { database, service } = createService();
    expect(service.getOpenIdConfiguration()).toEqual({
      issuer,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
    });
    const withoutIssuer = createService({ issuer: "" });
    expect(withoutIssuer.service.getOpenIdConfiguration()).toBeUndefined();
    database.close();
    withoutIssuer.database.close();
  });

  it("round-trips the private key through the secret codec", async () => {
    const { database, service } = createService();
    await service.create();
    const record = await database.pactIdentityStore.get();
    expect(record?.privateJwk).toMatchObject({ kty: "EC", crv: "P-256", d: expect.any(String) });
    database.close();
  });
});
