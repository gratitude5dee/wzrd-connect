import type { ISecretCodec } from "../server/secrets/secret-codec-core.ts";
import type { PactIdentityRecord, PactIdentityStore } from "../server/storage/pact-identity-store.ts";
import type { JWK } from "jose";

// jose stays behind dynamic imports so a deployment without PACT enabled never loads it; runtime-jwt.ts does the same.

export const pactJwksPath = "/.well-known/jwks.json";
export const pactOpenIdConfigurationPath = "/.well-known/openid-configuration";
/** How long verifiers may cache the JWKS; also set on the well-known responses. */
export const pactJwksCacheControl = "public, max-age=300";
/** PA-JWT lifetime: spec §4.3 mints `exp = iat + 120s` (always under the 300 s wire limit). */
export const pactPaJwtLifetimeSeconds = 120;
export const pactKeyGraceSecondsDefault = 86_400;

export type PactIdentityErrorCode =
  | "encryption_required"
  | "pact_origin_required"
  | "pact_identity_exists"
  | "pact_identity_not_found";

export class PactIdentityError extends Error {
  readonly code: PactIdentityErrorCode;

  constructor(code: PactIdentityErrorCode, message: string) {
    super(message);
    this.name = "PactIdentityError";
    this.code = code;
  }
}

export interface PactIdentityServiceOptions {
  store: PactIdentityStore;
  secretCodec: ISecretCodec;
  /** `OOMOL_CONNECT_ORIGIN`; the `iss` of every PA-JWT and the issuer metadata document. */
  issuer?: string;
  /** Seconds the outgoing public key stays in the JWKS after rotation (default 86400). */
  keyGraceSeconds?: number;
}

/** Admin read model for `GET /api/pact/identity` — never carries private material. */
export interface PactIdentitySummary {
  issuer?: string;
  kid: string;
  jwksUrl?: string;
  createdAt: string;
  rotatedAt?: string;
  previousKid?: string;
  subject: "configured";
}

export interface PactJwks {
  keys: JWK[];
}

export interface PactOpenIdConfiguration {
  issuer: string;
  jwks_uri: string;
}

export interface SignPersonalAgentJwtInput {
  /** `sub` — the runtime token subject, or the deployment subject for unauthenticated callers. */
  subject: string;
  /** `aud` — the registered Brand audience (or endpoint URL for registration tokens). */
  audience: string;
}

/**
 * Deployment-level PACT identity (spec §4.3): one ES256/P-256 keypair per
 * deployment, generated with Web Crypto, the private JWK stored through the
 * secret codec, `kid` the RFC 7638 base64url SHA-256 JWK thumbprint.
 * Rotation keeps the outgoing public key in the JWKS for the grace window so
 * in-flight PA-JWTs still verify.
 */
export class PactIdentityService {
  private readonly store: PactIdentityStore;
  private readonly secretCodec: ISecretCodec;
  private readonly issuer?: string;
  private readonly keyGraceSeconds: number;

  constructor(options: PactIdentityServiceOptions) {
    this.store = options.store;
    this.secretCodec = options.secretCodec;
    this.issuer = normalizeOrigin(options.issuer);
    this.keyGraceSeconds = options.keyGraceSeconds ?? pactKeyGraceSecondsDefault;
  }

  async get(): Promise<PactIdentitySummary | undefined> {
    const record = await this.store.get();
    return record ? this.summarize(record) : undefined;
  }

  /**
   * Mint the deployment identity. Refused without
   * OOMOL_CONNECT_ENCRYPTION_KEY (`encryption_required`) and without
   * OOMOL_CONNECT_ORIGIN (`pact_origin_required`).
   */
  async create(): Promise<PactIdentitySummary> {
    this.requireEncryption();
    this.requireIssuer();
    const { kid, privateJwk, publicJwk } = await generatePactKeyPair();
    const { record, created } = await this.store.create({
      kid,
      privateJwk,
      publicJwk,
      subject: crypto.randomUUID(),
      now: new Date().toISOString(),
    });
    if (!created) {
      throw new PactIdentityError("pact_identity_exists", "A PACT identity already exists; rotate it instead.");
    }
    return this.summarize(record);
  }

  /**
   * Swap the signing key immediately; the outgoing public key stays in the
   * JWKS until `now + keyGraceSeconds` so verifiers with a cached set still
   * resolve the old `kid`.
   */
  async rotate(): Promise<PactIdentitySummary> {
    this.requireEncryption();
    this.requireIssuer();
    const existing = await this.requireIdentity();
    const { kid, privateJwk, publicJwk } = await generatePactKeyPair();
    const now = new Date();
    const record = await this.store.rotate({
      kid,
      privateJwk,
      publicJwk,
      previousKid: existing.kid,
      previousPublicJwk: existing.publicJwk,
      previousExpiresAt: new Date(now.getTime() + this.keyGraceSeconds * 1000).toISOString(),
      subject: existing.subject,
      now: now.toISOString(),
    });
    if (!record) {
      throw new PactIdentityError("pact_identity_not_found", "No PACT identity exists yet.");
    }
    return this.summarize(record);
  }

  /** Public JWKS: current key plus the previous key while it is inside the grace window. */
  async getJwks(now: Date = new Date()): Promise<PactJwks> {
    const record = await this.store.get();
    if (!record) {
      return { keys: [] };
    }
    const keys = [record.publicJwk];
    if (
      record.previousPublicJwk &&
      record.previousExpiresAt &&
      new Date(record.previousExpiresAt).getTime() > now.getTime()
    ) {
      keys.push(record.previousPublicJwk);
    }
    return { keys };
  }

  /** Issuer metadata; undefined when OOMOL_CONNECT_ORIGIN is not configured. */
  getOpenIdConfiguration(): PactOpenIdConfiguration | undefined {
    if (!this.issuer) {
      return undefined;
    }
    return { issuer: this.issuer, jwks_uri: `${this.issuer}${pactJwksPath}` };
  }

  /** Deployment-level `sub` for PA-JWTs minted without a runtime token (bootstrap/JWT/local). */
  async readDeploymentSubject(): Promise<string | undefined> {
    return (await this.store.get())?.subject;
  }

  /** The configured Connect issuer (`OOMOL_CONNECT_ORIGIN`) receipts compare `pa` against. */
  readIssuer(): string | undefined {
    return this.issuer;
  }

  /**
   * Mint a §4.6 custodian receipt as a compact JWS under the active identity
   * key. Claims arrive caller-assembled (`iss/sub/act/aud/jti/iat/action`,
   * optional `approval`, `provider_receipt`); the identity only signs.
   */
  async signCustodianReceipt(claims: Record<string, unknown>): Promise<string> {
    const record = await this.requireIdentity();
    const { importJWK, SignJWT } = await import("jose");
    const key = await importJWK(record.privateJwk, "ES256");
    return new SignJWT(claims).setProtectedHeader({ alg: "ES256", kid: record.kid, typ: "JWT" }).sign(key);
  }

  /**
   * Mint a PA-JWT (spec §4.3): `alg=ES256`, `kid`, `iss` the configured
   * origin, `sub` the caller's agent identity, `aud` the registered Brand
   * audience, `exp = iat + 120s`, random `jti`. One JWT per outbound request.
   */
  async signPersonalAgentJwt(input: SignPersonalAgentJwtInput): Promise<string> {
    const record = await this.requireIdentity();
    const issuer = this.requireIssuer();
    const { importJWK, SignJWT } = await import("jose");
    const key = await importJWK(record.privateJwk, "ES256");
    const nowSeconds = Math.floor(Date.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: record.kid, typ: "JWT" })
      .setIssuer(issuer)
      .setSubject(input.subject)
      .setAudience(input.audience)
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + pactPaJwtLifetimeSeconds)
      .setJti(crypto.randomUUID())
      .sign(key);
  }

  /**
   * Mint the registration proof for `POST /api/pact/identity/registration-token`:
   * `iss` the deployment, `sub = iss`, `aud` the Brand endpoint URL, `exp ≤ 300 s`.
   * Returned once to the admin — never stored readable.
   */
  async signRegistrationToken(endpointUrl: string): Promise<string> {
    const issuer = this.requireIssuer();
    const record = await this.requireIdentity();
    const { importJWK, SignJWT } = await import("jose");
    const key = await importJWK(record.privateJwk, "ES256");
    const nowSeconds = Math.floor(Date.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: record.kid, typ: "JWT" })
      .setIssuer(issuer)
      .setSubject(issuer)
      .setAudience(endpointUrl)
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + pactPaJwtLifetimeSeconds)
      .setJti(crypto.randomUUID())
      .sign(key);
  }

  private summarize(record: PactIdentityRecord): PactIdentitySummary {
    return {
      issuer: this.issuer,
      kid: record.kid,
      jwksUrl: this.issuer ? `${this.issuer}${pactJwksPath}` : undefined,
      createdAt: record.createdAt,
      rotatedAt: record.rotatedAt,
      previousKid: record.previousKid,
      subject: "configured",
    };
  }

  private requireEncryption(): void {
    if (!this.secretCodec.encrypted) {
      throw new PactIdentityError(
        "encryption_required",
        "PACT identity requires OOMOL_CONNECT_ENCRYPTION_KEY; private key material is stored encrypted.",
      );
    }
  }

  private requireIssuer(): string {
    if (!this.issuer) {
      throw new PactIdentityError("pact_origin_required", "PACT identity requires OOMOL_CONNECT_ORIGIN (the issuer).");
    }
    return this.issuer;
  }

  private async requireIdentity(): Promise<PactIdentityRecord> {
    const record = await this.store.get();
    if (!record) {
      throw new PactIdentityError("pact_identity_not_found", "No PACT identity exists yet.");
    }
    return record;
  }
}

/** ES256 keypair; `kid` is the RFC 7638 base64url SHA-256 thumbprint of the public JWK. */
async function generatePactKeyPair(): Promise<{ kid: string; privateJwk: JWK; publicJwk: JWK }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const exportedPrivate = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const exportedPublic = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const { calculateJwkThumbprint } = await import("jose");
  const kid = await calculateJwkThumbprint(exportedPublic, "sha256");
  const publicJwk: JWK = {
    kty: "EC",
    crv: "P-256",
    x: exportedPublic.x,
    y: exportedPublic.y,
    alg: "ES256",
    use: "sig",
    kid,
  };
  const privateJwk: JWK = { ...publicJwk, d: exportedPrivate.d };
  return { kid, privateJwk, publicJwk };
}

function normalizeOrigin(origin: string | undefined): string | undefined {
  const trimmed = origin?.trim().replace(/\/+$/u, "");
  return trimmed ? trimmed : undefined;
}
