import type { RequestTransaction } from "./connection-request-store.ts";
import type { RuntimeRow } from "./runtime-sql.ts";

import { readOptionalString, readString } from "./runtime-sql.ts";

/**
 * A console user provisioned by thirdweb sign-in. The wallet thirdweb returns is
 * the canonical identity; phone/email record the OTP identity the sign-in came in on.
 */
export interface ConsoleUser {
  id: string;
  walletAddress: string;
  phone?: string;
  email?: string;
  createdAt: string;
  lastSignInAt: string;
  disabledAt?: string;
}

/** A revocable server-side session behind the `oomol_connect_user_session` cookie. */
export interface ConsoleSession {
  id: string;
  userId: string;
  createdAt: string;
  lastSeenAt: string;
  revokedAt?: string;
}

export interface ConsoleUserUpsertInput {
  id: string;
  walletAddress: string;
  phone?: string;
  email?: string;
  now: string;
}

export interface ConsoleSessionInsertInput {
  id: string;
  userId: string;
  now: string;
}

const consoleUserColumns = "id, wallet_address, phone, email, created_at, last_sign_in_at, disabled_at";
const consoleSessionColumns = "id, user_id, created_at, last_seen_at, revoked_at";

function readConsoleUserRow(row: RuntimeRow): ConsoleUser {
  return {
    id: readString(row, "id"),
    walletAddress: readString(row, "wallet_address"),
    phone: readOptionalString(row, "phone"),
    email: readOptionalString(row, "email"),
    createdAt: readString(row, "created_at"),
    lastSignInAt: readString(row, "last_sign_in_at"),
    disabledAt: readOptionalString(row, "disabled_at"),
  };
}

function readConsoleSessionRow(row: RuntimeRow): ConsoleSession {
  return {
    id: readString(row, "id"),
    userId: readString(row, "user_id"),
    createdAt: readString(row, "created_at"),
    lastSeenAt: readString(row, "last_seen_at"),
    revokedAt: readOptionalString(row, "revoked_at"),
  };
}

/**
 * Console user/session persistence shared by every SQL backend through
 * `RequestTransaction` (sqlite, postgres and D1). Re-signing in on a new channel
 * only ever backfills phone/email; it never clears an identity recorded earlier.
 */
export class ConsoleUserStore {
  private readonly transaction: RequestTransaction;

  constructor(transaction: RequestTransaction) {
    this.transaction = transaction;
  }

  async upsertByWallet(input: ConsoleUserUpsertInput): Promise<ConsoleUser> {
    const [rows] = await this.transaction([
      {
        sql: `insert into console_users (id, wallet_address, phone, email, created_at, last_sign_in_at)
          values (?, ?, ?, ?, ?, ?)
          on conflict (wallet_address) do update set
            last_sign_in_at = excluded.last_sign_in_at,
            phone = coalesce(excluded.phone, console_users.phone),
            email = coalesce(excluded.email, console_users.email)
          returning ${consoleUserColumns}`,
        values: [input.id, input.walletAddress, input.phone ?? null, input.email ?? null, input.now, input.now],
      },
    ]);
    const row = rows[0];
    if (!row) {
      throw new Error("Console user could not be saved.");
    }
    return readConsoleUserRow(row);
  }

  async get(id: string): Promise<ConsoleUser | undefined> {
    const [[row]] = await this.transaction([
      { sql: `select ${consoleUserColumns} from console_users where id = ?`, values: [id] },
    ]);
    return row ? readConsoleUserRow(row) : undefined;
  }

  async findByWalletAddress(walletAddress: string): Promise<ConsoleUser | undefined> {
    const [[row]] = await this.transaction([
      { sql: `select ${consoleUserColumns} from console_users where wallet_address = ?`, values: [walletAddress] },
    ]);
    return row ? readConsoleUserRow(row) : undefined;
  }

  async findByPhone(phone: string): Promise<ConsoleUser | undefined> {
    const [[row]] = await this.transaction([
      { sql: `select ${consoleUserColumns} from console_users where phone = ?`, values: [phone] },
    ]);
    return row ? readConsoleUserRow(row) : undefined;
  }

  async findByEmail(email: string): Promise<ConsoleUser | undefined> {
    const [[row]] = await this.transaction([
      { sql: `select ${consoleUserColumns} from console_users where email = ?`, values: [email] },
    ]);
    return row ? readConsoleUserRow(row) : undefined;
  }

  async setDisabled(id: string, disabledAt: string | null): Promise<boolean> {
    const [rows] = await this.transaction([
      { sql: "update console_users set disabled_at = ? where id = ? returning id", values: [disabledAt, id] },
    ]);
    return rows.length > 0;
  }

  async insertSession(input: ConsoleSessionInsertInput): Promise<ConsoleSession> {
    const [rows] = await this.transaction([
      {
        sql: `insert into console_sessions (id, user_id, created_at, last_seen_at)
          values (?, ?, ?, ?)
          returning ${consoleSessionColumns}`,
        values: [input.id, input.userId, input.now, input.now],
      },
    ]);
    const row = rows[0];
    if (!row) {
      throw new Error("Console session could not be created.");
    }
    return readConsoleSessionRow(row);
  }

  /** Read a session only while it is unrevoked; revoked sessions are indistinguishable from missing ones. */
  async getLiveSession(id: string): Promise<ConsoleSession | undefined> {
    const [[row]] = await this.transaction([
      {
        sql: `select ${consoleSessionColumns} from console_sessions where id = ? and revoked_at is null`,
        values: [id],
      },
    ]);
    return row ? readConsoleSessionRow(row) : undefined;
  }

  async revokeSession(id: string, now: string): Promise<boolean> {
    const [rows] = await this.transaction([
      {
        sql: "update console_sessions set revoked_at = ? where id = ? and revoked_at is null returning id",
        values: [now, id],
      },
    ]);
    return rows.length > 0;
  }

  async touchSession(id: string, now: string): Promise<void> {
    await this.transaction([
      { sql: "update console_sessions set last_seen_at = ? where id = ? and revoked_at is null", values: [now, id] },
    ]);
  }
}
