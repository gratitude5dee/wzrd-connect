import type { ISecretCodec } from "../secrets/secret-codec-core.ts";
import type { RequestTransaction } from "./connection-request-store.ts";
import type { RuntimeRow } from "./runtime-sql.ts";
import type { JWK } from "jose";

import { parseJson, readString } from "./runtime-sql.ts";

/**
 * The deployment's PACT signing identity, kept as the single `pact_identity`
 * row (`id = 1`). `privateJwk` leaves the store only via `get()` — the secret
 * codec owns its ciphertext.
 */
export interface PactIdentityRecord {
  kid: string;
  privateJwk: JWK;
  publicJwk: JWK;
  previousKid?: string;
  previousPublicJwk?: JWK;
  previousExpiresAt?: string;
  /** Deployment-level `sub` for PA-JWTs not bound to a runtime token. */
  subject: string;
  createdAt: string;
  rotatedAt?: string;
}

export interface PactIdentityCreateInput {
  kid: string;
  privateJwk: JWK;
  publicJwk: JWK;
  subject: string;
  now: string;
}

export interface PactIdentityRotateInput extends PactIdentityCreateInput {
  previousKid: string;
  previousPublicJwk: JWK;
  previousExpiresAt: string;
}

const pactIdentityColumns =
  "kid, private_jwk_ciphertext, public_jwk, previous_kid, previous_public_jwk, previous_expires_at, subject, created_at, rotated_at";

/**
 * Shared SQL lifecycle for the single `pact_identity` row across SQLite,
 * PostgreSQL and D1. Every transition is one statement with `returning`
 * inside one `RequestTransaction`.
 */
export class PactIdentityStore {
  private readonly transaction: RequestTransaction;
  private readonly secretCodec: ISecretCodec;

  constructor(transaction: RequestTransaction, secretCodec: ISecretCodec) {
    this.transaction = transaction;
    this.secretCodec = secretCodec;
  }

  async get(): Promise<PactIdentityRecord | undefined> {
    const [[row]] = await this.transaction([
      { sql: `select ${pactIdentityColumns} from pact_identity where id = 1`, values: [] },
    ]);
    return row ? this.readRow(row) : undefined;
  }

  async create(input: PactIdentityCreateInput): Promise<{ record: PactIdentityRecord; created: boolean }> {
    const ciphertext = await this.secretCodec.encode(JSON.stringify(input.privateJwk));
    const [inserted, existing] = await this.transaction([
      {
        sql: `insert into pact_identity (
            id, kid, private_jwk_ciphertext, public_jwk, subject, created_at
          ) values (1, ?, ?, ?, ?, ?)
          on conflict do nothing
          returning ${pactIdentityColumns}`,
        values: [input.kid, ciphertext, JSON.stringify(input.publicJwk), input.subject, input.now],
      },
      {
        sql: `select ${pactIdentityColumns} from pact_identity where id = 1`,
        values: [],
      },
    ]);
    const row = inserted[0] ?? existing[0];
    if (!row) {
      throw new Error("PACT identity could not be created or read back.");
    }
    return { record: await this.readRow(row), created: Boolean(inserted[0]) };
  }

  /**
   * Swap the signing key, keeping the outgoing public key visible in the JWKS
   * until `previousExpiresAt`. The deployment `subject` survives rotation.
   */
  async rotate(input: PactIdentityRotateInput): Promise<PactIdentityRecord | undefined> {
    const ciphertext = await this.secretCodec.encode(JSON.stringify(input.privateJwk));
    const [rows] = await this.transaction([
      {
        sql: `update pact_identity set
            kid = ?,
            private_jwk_ciphertext = ?,
            public_jwk = ?,
            previous_kid = ?,
            previous_public_jwk = ?,
            previous_expires_at = ?,
            rotated_at = ?
          where id = 1
          returning ${pactIdentityColumns}`,
        values: [
          input.kid,
          ciphertext,
          JSON.stringify(input.publicJwk),
          input.previousKid,
          JSON.stringify(input.previousPublicJwk),
          input.previousExpiresAt,
          input.now,
        ],
      },
    ]);
    return rows[0] ? this.readRow(rows[0]) : undefined;
  }

  private async readRow(row: RuntimeRow): Promise<PactIdentityRecord> {
    const previousPublicJwk = optionalText(row, "previous_public_jwk");
    return {
      kid: readString(row, "kid"),
      privateJwk: parseJson<JWK>(await this.secretCodec.decode(readString(row, "private_jwk_ciphertext"))),
      publicJwk: parseJson<JWK>(readString(row, "public_jwk")),
      previousKid: optionalText(row, "previous_kid"),
      previousPublicJwk: previousPublicJwk ? parseJson<JWK>(previousPublicJwk) : undefined,
      previousExpiresAt: optionalText(row, "previous_expires_at"),
      subject: readString(row, "subject"),
      createdAt: readString(row, "created_at"),
      rotatedAt: optionalText(row, "rotated_at"),
    };
  }
}

function optionalText(row: RuntimeRow, column: string): string | undefined {
  const value = row[column];
  return typeof value === "string" && value !== "" ? value : undefined;
}
