import type { PactConnectionCredential } from "./pact-connection.ts";
import type { PactIdentityService } from "./pact-identity-service.ts";

import { optionalRecord, optionalString } from "../core/cast.ts";
import { canonicalJson } from "../core/json-canonical.ts";
import { PactJwksError, PactJwksResolver } from "./pact-jwks.ts";

/**
 * A Brand's `message:send` reply can carry `metadata["pact.receipt"]` shaped
 * `{ jws, claims }` (PACT §5.6): a compact JWS whose payload is the claims
 * object, signed by a key in the connection's `jwksUri`. `verified` records
 * the outcome of the §4.6 checks; `failureReason` explains a negative one.
 * `jws`/`claims` stay absent when the reply carried no receipt at all.
 */
export interface PactProviderReceipt {
  jws?: string;
  claims?: Record<string, unknown>;
  verified: boolean;
  verifiedAt: string;
  failureReason?: string;
}

/** Options for {@link PactReceiptService}. */
export interface PactReceiptServiceOptions {
  /** Deployment identity — the Connect issuer and the custodian signing key. */
  identity: PactIdentityService;
  /** Raw transport for Brand JWKS egress; tests inject a mock. */
  fetcher?: typeof fetch;
  /** `OOMOL_CONNECT_PACT_ALLOW_INSECURE_LOOPBACK`. */
  allowInsecureLoopback?: boolean;
}

/**
 * §4.6 receipts. `verifyProviderReceipt` checks a Brand receipt's signature
 * against the JWKS `jwksUri` recorded on the connection (the shared
 * {@link PactJwksResolver} cache), requires payload === claims, and checks
 * `claims.grantId` against the connection's grant and `claims.pa` against
 * Connect's issuer. `signCustodianReceipt` delegates the JWS mint to the
 * identity service, which owns the signing key.
 */
export class PactReceiptService {
  private readonly options: PactReceiptServiceOptions;
  private readonly jwksResolver: PactJwksResolver;

  constructor(options: PactReceiptServiceOptions) {
    this.options = options;
    this.jwksResolver = new PactJwksResolver(options);
  }

  async verifyProviderReceipt(input: {
    credential: PactConnectionCredential;
    metadata: Record<string, unknown> | undefined;
    signal?: AbortSignal;
  }): Promise<PactProviderReceipt> {
    const verifiedAt = new Date().toISOString();
    const raw = input.metadata ? optionalRecord(input.metadata["pact.receipt"]) : undefined;
    if (!raw) {
      return { verified: false, verifiedAt, failureReason: "pact_receipt_missing" };
    }
    const jws = optionalString(raw.jws);
    const claims = optionalRecord(raw.claims);
    const fail = (reason: string): PactProviderReceipt => ({
      jws,
      claims,
      verified: false,
      verifiedAt,
      failureReason: reason,
    });
    if (!jws || !claims) {
      return fail("pact_receipt_malformed");
    }

    const parts = jws.split(".");
    if (parts.length !== 3) {
      return fail("pact_receipt_malformed");
    }
    let payload: Record<string, unknown> | undefined;
    try {
      payload = optionalRecord(JSON.parse(new TextDecoder().decode(Buffer.from(parts[1], "base64url"))));
    } catch {
      payload = undefined;
    }
    if (!payload) {
      return fail("pact_receipt_malformed");
    }
    // payload === claims: identical JCS serializations is the wire-level check.
    if (canonicalJson(payload) !== canonicalJson(claims)) {
      return fail("pact_receipt_payload_mismatch");
    }

    const jwksUri = optionalString(input.credential.delegation?.jwksUri);
    if (!jwksUri) {
      return fail("pact_receipt_jwks_unavailable");
    }
    try {
      await this.verifyJws(jws, jwksUri, input.signal);
    } catch (error) {
      if (error instanceof PactJwksError) {
        return fail("pact_receipt_jwks_unavailable");
      }
      return fail("pact_receipt_signature_invalid");
    }

    if (optionalString(claims.grantId) !== optionalString(input.credential.delegation?.grantId)) {
      return fail("pact_receipt_grant_mismatch");
    }
    const issuer = this.options.identity.readIssuer();
    if (!issuer || optionalString(claims.pa) !== issuer) {
      return fail("pact_receipt_issuer_mismatch");
    }
    return { jws, claims, verified: true, verifiedAt };
  }

  /** The Connect issuer receipt checks and custodian claims compare against. */
  readIssuer(): string | undefined {
    return this.options.identity.readIssuer();
  }

  /** Deployment-level `sub` for custodian receipts minted without a runtime token. */
  async readDeploymentSubject(): Promise<string | undefined> {
    return this.options.identity.readDeploymentSubject();
  }

  /** Mint the custodian receipt; the identity service owns the signing key. */
  async signCustodianReceipt(claims: Record<string, unknown>): Promise<string> {
    return this.options.identity.signCustodianReceipt(claims);
  }

  private async verifyJws(jws: string, jwksUri: string, signal: AbortSignal | undefined): Promise<void> {
    const { decodeProtectedHeader, createLocalJWKSet, jwtVerify } = await import("jose");
    const kid = optionalString(decodeProtectedHeader(jws).kid);
    const verify = (keys: { keys: unknown[] }) =>
      jwtVerify(jws, createLocalJWKSet(keys as never), { algorithms: ["ES256", "RS256"] });
    const jwks = await this.jwksResolver.resolve(jwksUri, kid, signal);
    try {
      await verify(jwks);
    } catch (error) {
      if ((error as { code?: string }).code === "ERR_JWKS_NO_MATCHING_KEY") {
        // One kid-miss refetch: the Brand rotated keys after our cache filled.
        this.jwksResolver.invalidate(jwksUri);
        await verify(await this.jwksResolver.resolve(jwksUri, undefined, signal));
        return;
      }
      throw error;
    }
  }
}
