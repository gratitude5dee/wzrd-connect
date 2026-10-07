import type { ApprovalGrant, ApprovalGrantQuery } from "../../core/action-policy.ts";
import type { ActionOperationType } from "../../core/types.ts";
import type { ISecretCodec } from "../secrets/secret-codec-core.ts";
import type { RequestTransaction } from "./connection-request-store.ts";
import type { RuntimeRow } from "./runtime-sql.ts";
import type { RunLogCaller } from "./runtime-store.ts";

import { parseJson, readString } from "./runtime-sql.ts";

export type ApprovalKind = "action" | "proxy";

/**
 * `executing` is internal to the store: an approved request claimed by a poll
 * while the provider call runs. Wire serializers fold it into `approved`.
 */
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "executing" | "executed" | "failed";

export interface ApprovalRecord {
  id: string;
  kind: ApprovalKind;
  /** Creator identity: `token:<id>` for runtime tokens, `bearer:<sha256>` otherwise, `dev:<nonce>` unauthenticated. */
  ownerKey: string;
  runtimeTokenId?: string;
  /** Action id for `kind: "action"`, provider service id for `kind: "proxy"`. */
  actionId: string;
  service: string;
  connectionId?: string;
  connectionName?: string;
  /** Set when the approval gates an OAuth connection request; currently always unset. */
  connectionRequestId?: string;
  operationType: ActionOperationType;
  caller: RunLogCaller;
  requestFingerprint: string;
  preview: unknown;
  status: ApprovalStatus;
  decidedBy?: string;
  decidedAt?: string;
  decisionFactor?: string;
  decisionReason?: string;
  grantId?: string;
  executionId?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  lastPollAt?: string;
  pollWindowStartedAt?: string;
  pollViolations: number;
}

/** Decrypted stored request — the input payload replayed once the approval executes. */
export interface StoredApprovalRequest {
  input: unknown;
  connectionName?: string;
  connectionId?: string;
}

export interface ApprovalCreateInput {
  id: string;
  kind: ApprovalKind;
  ownerKey: string;
  runtimeTokenId?: string;
  actionId: string;
  service: string;
  connectionId?: string;
  connectionName?: string;
  connectionRequestId?: string;
  operationType: ActionOperationType;
  caller: RunLogCaller;
  request: StoredApprovalRequest;
  requestFingerprint: string;
  /** Already run-log-summarized preview; persisted as JSON. */
  preview: unknown;
  now: string;
  expiresAt: string;
}

export interface ApprovalDecision {
  decidedBy: string;
  decidedAt: string;
  decisionFactor: string;
  decisionReason?: string;
}

export interface ApprovalPollMark {
  lastPollAt: string;
  pollWindowStartedAt: string;
  pollViolations: number;
}

export interface ApprovalListInput {
  /** `pending` filters to pending only; omitted lists every record. */
  status?: "pending";
  cursor?: string;
  limit?: number;
}

export interface ApprovalPage {
  items: ApprovalRecord[];
  nextCursor?: string;
}

export interface ApprovalGrantRecord extends ApprovalGrant {
  approvalId?: string;
  createdBy: string;
  createdAt: string;
}

interface ApprovalCursor {
  createdAt: string;
  id: string;
}

const approvalColumns =
  "id, kind, owner_key, runtime_token_id, action_id, service, connection_id, connection_name, connection_request_id, operation_type, caller, request_fingerprint, preview, status, decided_by, decided_at, decision_factor, decision_reason, grant_id, execution_id, created_at, updated_at, expires_at, last_poll_at, poll_window_started_at, poll_violations";

const grantColumns =
  "id, approval_id, runtime_token_id, action_id, connection_id, operation_type, expires_at, max_uses, uses, created_by, created_at";

/**
 * Shared SQL lifecycle for approval records and approval grants across SQLite,
 * PostgreSQL and D1. Atomicity follows `ConnectionRequestStore`: every
 * transition is a single `update ... where status = 'pending'` (or the
 * appropriate predecessor state) with `returning`, executed inside one
 * `RequestTransaction`. Pending dedupe rides the partial unique index
 * `approvals_pending_owner_fingerprint`.
 */
export class ApprovalStore {
  private readonly transaction: RequestTransaction;
  private readonly secretCodec: ISecretCodec;

  constructor(transaction: RequestTransaction, secretCodec: ISecretCodec) {
    this.transaction = transaction;
    this.secretCodec = secretCodec;
  }

  async create(input: ApprovalCreateInput): Promise<{ approval: ApprovalRecord; created: boolean }> {
    const ciphertext = await this.secretCodec.encode(JSON.stringify(input.request));
    const [inserted, existing] = await this.transaction([
      {
        sql: `insert into approvals (
            id, kind, owner_key, runtime_token_id, action_id, service, connection_id, connection_name,
            connection_request_id, operation_type, caller, request_ciphertext, request_fingerprint, preview, status,
            created_at, updated_at, expires_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
          on conflict do nothing
          returning ${approvalColumns}`,
        values: [
          input.id,
          input.kind,
          input.ownerKey,
          input.runtimeTokenId ?? null,
          input.actionId,
          input.service,
          input.connectionId ?? null,
          input.connectionName ?? null,
          input.connectionRequestId ?? null,
          input.operationType,
          input.caller,
          ciphertext,
          input.requestFingerprint,
          JSON.stringify(input.preview ?? null),
          input.now,
          input.now,
          input.expiresAt,
        ],
      },
      {
        sql: `select ${approvalColumns} from approvals
          where owner_key = ? and request_fingerprint = ? and status = 'pending'
          order by created_at desc, id desc`,
        values: [input.ownerKey, input.requestFingerprint],
      },
    ]);
    const row = inserted[0] ?? existing[0];
    if (!row) {
      throw new Error("Approval record could not be created or read back.");
    }
    return { approval: readApprovalRow(row), created: Boolean(inserted[0]) };
  }

  async get(id: string): Promise<ApprovalRecord | undefined> {
    const [[row]] = await this.transaction([
      { sql: `select ${approvalColumns} from approvals where id = ?`, values: [id] },
    ]);
    return row ? readApprovalRow(row) : undefined;
  }

  async getForOwner(id: string, ownerKey: string): Promise<ApprovalRecord | undefined> {
    const [[row]] = await this.transaction([
      {
        sql: `select ${approvalColumns} from approvals where id = ? and owner_key = ?`,
        values: [id, ownerKey],
      },
    ]);
    return row ? readApprovalRow(row) : undefined;
  }

  /** Lookup for the MCP `get_approval` tool's connection-request key; returns nothing until PR3+ writes it. */
  async getForConnectionRequest(connectionRequestId: string, ownerKey: string): Promise<ApprovalRecord | undefined> {
    const [[row]] = await this.transaction([
      {
        sql: `select ${approvalColumns} from approvals where connection_request_id = ? and owner_key = ?`,
        values: [connectionRequestId, ownerKey],
      },
    ]);
    return row ? readApprovalRow(row) : undefined;
  }

  async list(input: ApprovalListInput = {}): Promise<ApprovalPage> {
    const limit = Math.min(Math.max(1, input.limit ?? 50), 100);
    const cursor = input.cursor ? decodeApprovalCursor(input.cursor) : undefined;
    const filters: string[] = [];
    const values: (string | number | null)[] = [];
    if (input.status === "pending") {
      filters.push("status = 'pending'");
    }
    if (cursor) {
      filters.push("(created_at < ? or (created_at = ? and id < ?))");
      values.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const where = filters.length ? ` where ${filters.join(" and ")}` : "";
    const [rows] = await this.transaction([
      {
        sql: `select ${approvalColumns} from approvals${where}
          order by created_at desc, id desc limit ?`,
        values: [...values, limit + 1],
      },
    ]);
    const items = rows.slice(0, limit).map(readApprovalRow);
    const last = items.length === limit && rows.length > limit ? items[items.length - 1] : undefined;
    return {
      items,
      nextCursor: last ? encodeApprovalCursor({ createdAt: last.createdAt, id: last.id }) : undefined,
    };
  }

  /** Opportunistic expiry: `pending` with a lapsed `expires_at` becomes `expired`. */
  async expireIfDue(id: string, now: string): Promise<ApprovalRecord | undefined> {
    const [rows] = await this.transaction([
      {
        sql: `update approvals set status = 'expired', updated_at = ?
          where id = ? and status = 'pending' and expires_at <= ?
          returning ${approvalColumns}`,
        values: [now, id, now],
      },
    ]);
    return rows[0] ? readApprovalRow(rows[0]) : undefined;
  }

  /** Poll bookkeeping fields; the service decides whether the count is over the limit. */
  async markPoll(id: string, mark: ApprovalPollMark): Promise<void> {
    await this.transaction([
      {
        sql: `update approvals set last_poll_at = ?, poll_window_started_at = ?, poll_violations = ? where id = ?`,
        values: [mark.lastPollAt, mark.pollWindowStartedAt, mark.pollViolations, id],
      },
    ]);
  }

  async approve(
    id: string,
    decision: ApprovalDecision,
    grant?: Omit<ApprovalGrantRecord, "uses">,
  ): Promise<ApprovalRecord | undefined> {
    const [rows] = await this.transaction([
      {
        sql: `update approvals
          set status = 'approved', decided_by = ?, decided_at = ?, decision_factor = ?, decision_reason = ?, updated_at = ?
          where id = ? and status = 'pending'
          returning ${approvalColumns}`,
        values: [
          decision.decidedBy,
          decision.decidedAt,
          decision.decisionFactor,
          decision.decisionReason ?? null,
          decision.decidedAt,
          id,
        ],
      },
    ]);
    const approved = rows[0];
    if (!approved) {
      return undefined;
    }
    if (grant) {
      await this.transaction([
        {
          sql: `insert into approval_grants (
              id, approval_id, runtime_token_id, action_id, connection_id, operation_type,
              expires_at, max_uses, uses, created_by, created_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          values: [
            grant.id,
            grant.approvalId ?? null,
            grant.runtimeTokenId,
            grant.actionId,
            grant.connectionId ?? null,
            grant.operationType,
            grant.expiresAt,
            grant.maxUses,
            grant.createdBy,
            grant.createdAt,
          ],
        },
        {
          sql: "update approvals set grant_id = ?, updated_at = ? where id = ?",
          values: [grant.id, grant.createdAt, id],
        },
      ]);
      return readApprovalRow({
        ...approved,
        grant_id: grant.id,
        updated_at: grant.createdAt,
      });
    }
    return readApprovalRow(approved);
  }

  async deny(id: string, decision: ApprovalDecision): Promise<ApprovalRecord | undefined> {
    const [rows] = await this.transaction([
      {
        sql: `update approvals
          set status = 'denied', decided_by = ?, decided_at = ?, decision_factor = ?, decision_reason = ?, updated_at = ?
          where id = ? and status = 'pending'
          returning ${approvalColumns}`,
        values: [
          decision.decidedBy,
          decision.decidedAt,
          decision.decisionFactor,
          decision.decisionReason ?? null,
          decision.decidedAt,
          id,
        ],
      },
    ]);
    return rows[0] ? readApprovalRow(rows[0]) : undefined;
  }

  /** Claims an approved record for execution; exactly one concurrent caller wins. */
  async beginExecution(id: string, now: string): Promise<ApprovalRecord | undefined> {
    const [rows] = await this.transaction([
      {
        sql: `update approvals set status = 'executing', updated_at = ?
          where id = ? and status = 'approved'
          returning ${approvalColumns}`,
        values: [now, id],
      },
    ]);
    return rows[0] ? readApprovalRow(rows[0]) : undefined;
  }

  async finishExecution(
    id: string,
    status: "executed" | "failed",
    executionId: string | undefined,
    now: string,
  ): Promise<void> {
    await this.transaction([
      {
        sql: "update approvals set status = ?, execution_id = ?, updated_at = ? where id = ? and status = 'executing'",
        values: [status, executionId ?? null, now, id],
      },
    ]);
  }

  /** Releases an `executing` claim back to `approved` (e.g. the idempotency claim was already in-flight). */
  async releaseExecution(id: string, now: string): Promise<void> {
    await this.transaction([
      {
        sql: "update approvals set status = 'approved', updated_at = ? where id = ? and status = 'executing'",
        values: [now, id],
      },
    ]);
  }

  async decodeRequest(id: string): Promise<StoredApprovalRequest | undefined> {
    const [[row]] = await this.transaction([
      { sql: "select request_ciphertext from approvals where id = ?", values: [id] },
    ]);
    const ciphertext = row ? optionalText(row, "request_ciphertext") : undefined;
    if (!ciphertext) {
      return undefined;
    }
    return parseJson<StoredApprovalRequest>(await this.secretCodec.decode(ciphertext));
  }

  /** Maintenance: sweep pending records past their TTL. */
  async expirePending(now: string): Promise<void> {
    await this.transaction([
      {
        sql: "update approvals set status = 'expired', updated_at = ? where status = 'pending' and expires_at <= ?",
        values: [now, now],
      },
    ]);
  }

  /** Maintenance: release executions whose claimant died mid-run so a poll can retry. */
  async resetStaleExecuting(cutoff: string, now: string): Promise<void> {
    await this.transaction([
      {
        sql: "update approvals set status = 'approved', updated_at = ? where status = 'executing' and updated_at <= ?",
        values: [now, cutoff],
      },
    ]);
  }

  /** Maintenance: drop stored request ciphertext from terminal records older than `cutoff`, bounded to `limit` rows. */
  async clearTerminalCiphertext(cutoff: string, limit: number): Promise<void> {
    await this.transaction([
      {
        sql: `update approvals set request_ciphertext = null
          where id in (
            select id from approvals
            where status in ('denied', 'expired', 'executed', 'failed')
              and request_ciphertext is not null
              and updated_at <= ?
            order by updated_at asc
            limit ?
          )`,
        values: [cutoff, limit],
      },
    ]);
  }

  /** Maintenance: forget grants whose window closed before `cutoff`. */
  async deleteExpiredGrants(cutoff: string): Promise<void> {
    await this.transaction([{ sql: "delete from approval_grants where expires_at <= ?", values: [cutoff] }]);
  }

  /**
   * Atomically consume one use of a live grant covering the query: the single
   * `update ... returning` increments `uses` only when a grant still has room,
   * so two concurrent evaluations cannot spend the same use.
   */
  async claimGrant(runtimeTokenId: string, query: ApprovalGrantQuery, now: string): Promise<ApprovalGrant | undefined> {
    const [rows] = await this.transaction([
      {
        sql: `update approval_grants set uses = uses + 1
          where id = (
            select id from approval_grants
            where runtime_token_id = ?
              and action_id = ?
              and operation_type = ?
              and (connection_id is null or connection_id = ?)
              and expires_at > ?
              and uses < max_uses
            order by expires_at asc, id asc
            limit 1
          )
          returning ${grantColumns}`,
        values: [runtimeTokenId, query.actionId, query.operationType, query.connectionId ?? null, now],
      },
    ]);
    return rows[0] ? readGrantRow(rows[0]) : undefined;
  }

  async listGrants(): Promise<ApprovalGrantRecord[]> {
    const [rows] = await this.transaction([
      {
        sql: `select ${grantColumns} from approval_grants order by created_at desc, id desc`,
        values: [],
      },
    ]);
    return rows.map(readGrantRow);
  }

  async deleteGrant(id: string): Promise<boolean> {
    const [rows] = await this.transaction([
      { sql: "delete from approval_grants where id = ? returning id", values: [id] },
    ]);
    return rows.length > 0;
  }
}

export function encodeApprovalCursor(cursor: ApprovalCursor): string {
  return encodeURIComponent(JSON.stringify(cursor));
}

export function decodeApprovalCursor(cursor: string): ApprovalCursor {
  const value = parseJson<Partial<ApprovalCursor>>(decodeURIComponent(cursor));
  if (typeof value.createdAt !== "string" || typeof value.id !== "string") {
    throw new Error("Invalid approval cursor.");
  }
  return { createdAt: value.createdAt, id: value.id };
}

function readApprovalRow(row: RuntimeRow): ApprovalRecord {
  return {
    id: readString(row, "id"),
    kind: readString(row, "kind") as ApprovalKind,
    ownerKey: readString(row, "owner_key"),
    runtimeTokenId: optionalText(row, "runtime_token_id"),
    actionId: readString(row, "action_id"),
    service: readString(row, "service"),
    connectionId: optionalText(row, "connection_id"),
    connectionName: optionalText(row, "connection_name"),
    connectionRequestId: optionalText(row, "connection_request_id"),
    operationType: readString(row, "operation_type") as ActionOperationType,
    caller: readString(row, "caller") as RunLogCaller,
    requestFingerprint: readString(row, "request_fingerprint"),
    preview: parseJson(optionalText(row, "preview") ?? "null"),
    status: readString(row, "status") as ApprovalStatus,
    decidedBy: optionalText(row, "decided_by"),
    decidedAt: optionalText(row, "decided_at"),
    decisionFactor: optionalText(row, "decision_factor"),
    decisionReason: optionalText(row, "decision_reason"),
    grantId: optionalText(row, "grant_id"),
    executionId: optionalText(row, "execution_id"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    expiresAt: readString(row, "expires_at"),
    lastPollAt: optionalText(row, "last_poll_at"),
    pollWindowStartedAt: optionalText(row, "poll_window_started_at"),
    pollViolations: Number(row.poll_violations ?? 0),
  };
}

function readGrantRow(row: RuntimeRow): ApprovalGrantRecord {
  return {
    id: readString(row, "id"),
    approvalId: optionalText(row, "approval_id"),
    runtimeTokenId: readString(row, "runtime_token_id"),
    actionId: readString(row, "action_id"),
    connectionId: optionalText(row, "connection_id"),
    operationType: readString(row, "operation_type") as ActionOperationType,
    expiresAt: readString(row, "expires_at"),
    maxUses: Number(row.max_uses ?? 0),
    uses: Number(row.uses ?? 0),
    createdBy: readString(row, "created_by"),
    createdAt: readString(row, "created_at"),
  };
}

function optionalText(row: RuntimeRow, column: string): string | undefined {
  const value = row[column];
  return typeof value === "string" && value !== "" ? value : undefined;
}
