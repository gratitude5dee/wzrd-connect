import type { RequestTransaction } from "./connection-request-store.ts";
import type { RuntimeRow } from "./runtime-sql.ts";

import { readString } from "./runtime-sql.ts";

/**
 * A Brand (Provider) registered with this deployment: the trusted origin that
 * delegations resolve to, plus the audience PA-JWTs are minted for.
 */
export interface PactRegistration {
  id: string;
  providerOrigin: string;
  audience: string;
  enabled: boolean;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PactRegistrationCreateInput {
  id: string;
  providerOrigin: string;
  audience: string;
  enabled: boolean;
  notes?: string;
  now: string;
}

export interface PactRegistrationUpdateInput {
  providerOrigin?: string;
  audience?: string;
  enabled?: boolean;
  /** Present with a value to set, `null` to clear; absent leaves the column alone. */
  notes?: string | null;
  now: string;
}

/** `provider_origin` collided with an existing registration. */
export class PactRegistrationConflictError extends Error {
  constructor(providerOrigin: string) {
    super(`PACT registration already exists for provider origin: ${providerOrigin}.`);
    this.name = "PactRegistrationConflictError";
  }
}

const registrationColumns = "id, provider_origin, audience, enabled, notes, created_at, updated_at";

/**
 * Shared SQL lifecycle for `pact_registrations` across SQLite, PostgreSQL and
 * D1. Origin uniqueness rides the `pact_registrations_origin` unique index;
 * statements run inside one `RequestTransaction`.
 */
export class PactRegistrationStore {
  private readonly transaction: RequestTransaction;

  constructor(transaction: RequestTransaction) {
    this.transaction = transaction;
  }

  async list(): Promise<PactRegistration[]> {
    const [rows] = await this.transaction([
      { sql: `select ${registrationColumns} from pact_registrations order by created_at asc, id asc`, values: [] },
    ]);
    return rows.map(readRegistrationRow);
  }

  async get(id: string): Promise<PactRegistration | undefined> {
    const [[row]] = await this.transaction([
      { sql: `select ${registrationColumns} from pact_registrations where id = ?`, values: [id] },
    ]);
    return row ? readRegistrationRow(row) : undefined;
  }

  async findByOrigin(providerOrigin: string): Promise<PactRegistration | undefined> {
    const [[row]] = await this.transaction([
      {
        sql: `select ${registrationColumns} from pact_registrations where provider_origin = ?`,
        values: [providerOrigin],
      },
    ]);
    return row ? readRegistrationRow(row) : undefined;
  }

  async create(input: PactRegistrationCreateInput): Promise<PactRegistration> {
    try {
      const [rows] = await this.transaction([
        {
          sql: `insert into pact_registrations (id, provider_origin, audience, enabled, notes, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?, ?)
            returning ${registrationColumns}`,
          values: [
            input.id,
            input.providerOrigin,
            input.audience,
            input.enabled ? 1 : 0,
            input.notes ?? null,
            input.now,
            input.now,
          ],
        },
      ]);
      const row = rows[0];
      if (!row) {
        throw new Error("PACT registration could not be created.");
      }
      return readRegistrationRow(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new PactRegistrationConflictError(input.providerOrigin);
      }
      throw error;
    }
  }

  async update(id: string, input: PactRegistrationUpdateInput): Promise<PactRegistration | undefined> {
    const updates: string[] = [];
    const values: (string | number | null)[] = [];
    if (input.providerOrigin !== undefined) {
      updates.push("provider_origin = ?");
      values.push(input.providerOrigin);
    }
    if (input.audience !== undefined) {
      updates.push("audience = ?");
      values.push(input.audience);
    }
    if (input.enabled !== undefined) {
      updates.push("enabled = ?");
      values.push(input.enabled ? 1 : 0);
    }
    if (input.notes !== undefined) {
      updates.push("notes = ?");
      values.push(input.notes);
    }
    updates.push("updated_at = ?");
    values.push(input.now, id);

    try {
      const [rows] = await this.transaction([
        {
          sql: `update pact_registrations set ${updates.join(", ")} where id = ? returning ${registrationColumns}`,
          values,
        },
      ]);
      return rows[0] ? readRegistrationRow(rows[0]) : undefined;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new PactRegistrationConflictError(input.providerOrigin ?? "<unchanged>");
      }
      throw error;
    }
  }

  async delete(id: string): Promise<boolean> {
    const [rows] = await this.transaction([
      { sql: "delete from pact_registrations where id = ? returning id", values: [id] },
    ]);
    return rows.length > 0;
  }
}

/** SQLite/D1 report `UNIQUE constraint failed`, PostgreSQL `23505`/`unique_violation`. */
function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const text = `${error.name} ${error.message}`;
  return /unique|23505/i.test(text);
}

function readRegistrationRow(row: RuntimeRow): PactRegistration {
  return {
    id: readString(row, "id"),
    providerOrigin: readString(row, "provider_origin"),
    audience: readString(row, "audience"),
    enabled: Number(row.enabled ?? 0) !== 0,
    notes: optionalText(row, "notes"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

function optionalText(row: RuntimeRow, column: string): string | undefined {
  const value = row[column];
  return typeof value === "string" && value !== "" ? value : undefined;
}
