import type { ApprovalGrant, ApprovalGrantLookup, ApprovalGrantQuery } from "../../core/action-policy.ts";
import type { RuntimeLogger } from "../../core/types.ts";
import type { ActionOperationType } from "../../core/types.ts";
import type {
  ApprovalCreateInput,
  ApprovalDecision,
  ApprovalKind,
  ApprovalListInput,
  ApprovalPage,
  ApprovalRecord,
  ApprovalStore,
  StoredApprovalRequest,
} from "../storage/approval-store.ts";
import type { ApprovalGrantRecord } from "../storage/approval-store.ts";
import type { RunLogCaller } from "../storage/runtime-store.ts";
import type { Context } from "hono";

import { createHash } from "node:crypto";
import { randomUUIDv7 } from "../../core/uuid-v7.ts";
import { readBearerCredential, readRuntimeGrant } from "../api/auth.ts";

/** Default approval TTL: one hour (OOMOL_CONNECT_APPROVAL_TTL_SECONDS). */
export const DEFAULT_APPROVAL_TTL_SECONDS = 3_600;
/** `Retry-After` interval the poll contract promises creators. */
export const approvalPollIntervalSeconds = 2;
/** Faster-than-contract polls tolerated per approval per rolling minute before `429`. */
export const approvalPollViolationLimit = 10;
/** Rolling window that throttles fast polls, in milliseconds. */
export const approvalPollWindowMs = 60_000;
/** Stuck `executing` rows older than this fall back to `approved` so a poll can retry. */
export const staleExecutingMs: number = 5 * 60 * 1000;
/** Maintenance drops stored request bodies 24 h after a terminal state. */
export const terminalCiphertextRetentionMs: number = 24 * 60 * 60 * 1000;
export const maintenanceBatchLimit: number = 100;
/** Grant TTL bounds and default (minutes), per spec §4.2.4. */
export const grantTtlMinutesMin: number = 1;
export const grantTtlMinutesMax: number = 1440;
export const grantTtlMinutesDefault: number = 30;

export type ApprovalDecisionOutcome =
  | { kind: "approved"; approval: ApprovalRecord; grant?: ApprovalGrantRecord }
  | { kind: "denied"; approval: ApprovalRecord }
  | { kind: "not_found" }
  | { kind: "conflict"; approval: ApprovalRecord };

/**
 * Poll contract: `pending` (still undecided) and `in_flight` (claimed by a
 * concurrent execution attempt) both map to a 202 + Retry-After; `approved`
 * means the caller should attempt the stored execution; `terminal` carries a
 * final state the caller maps onto its response (denied 403, expired 410,
 * executed/failed idempotent replay).
 */
export type PollOutcome =
  | { kind: "pending"; approval: ApprovalRecord }
  | { kind: "in_flight"; approval: ApprovalRecord }
  | { kind: "approved"; approval: ApprovalRecord }
  | { kind: "terminal"; approval: ApprovalRecord }
  | { kind: "rate_limited" }
  | { kind: "not_found" };

export interface RequireApprovalInput {
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
  preview: unknown;
}

export interface ApprovalResult {
  approval: ApprovalRecord;
  created: boolean;
}

export interface ApprovalListQuery {
  status?: string;
  cursor?: string;
  limit?: number;
}

export interface CreateGrantInput {
  ttlMinutes?: number;
  maxUses?: number;
  allowDestructive?: boolean;
}

export interface ApprovalDecisionInput {
  decidedBy: string;
  decisionFactor: string;
  decisionReason?: string;
}

export interface ApprovalServiceOptions {
  store: ApprovalStore;
  ttlSeconds?: number;
  logger?: RuntimeLogger;
}

/** Validation error the routes translate into `400 invalid_input`. */
export class ApprovalRequestError extends Error {}

/**
 * Serializes one approval's lifecycle on the SQL store: creating pending
 * records (with fingerprint dedupe), polling, admin decisions, grant minting
 * and consumption, and expiry/purge maintenance. Executing the stored request
 * stays in the caller (`connect-server`) so this service never depends on the
 * action/proxy runners.
 */
export class ApprovalService {
  private readonly store: ApprovalStore;
  private readonly ttlMs: number;
  private readonly logger?: RuntimeLogger;
  /** Ownership key for unauthenticated local calls: a per-process nonce. */
  private readonly localNonce: string;

  constructor(options: ApprovalServiceOptions) {
    this.store = options.store;
    this.ttlMs = Math.max(60, options.ttlSeconds ?? DEFAULT_APPROVAL_TTL_SECONDS) * 1000;
    this.logger = options.logger;
    this.localNonce = `local:${randomUUIDv7()}`;
  }

  /**
   * Ownership of approvals without a runtime token: the presented bearer
   * credential's SHA-256 (bootstrap token, JWT). Unauthenticated callers fall
   * back to a per-process nonce. Runtime tokens are keyed `token:<id>`.
   */
  readOwnerKey(context: Context): string {
    const grant = readRuntimeGrant(context);
    if (grant?.tokenId) {
      return `token:${grant.tokenId}`;
    }
    const credential = readBearerCredential(context);
    if (credential) {
      return `bearer:${createHash("sha256").update(credential).digest("base64url")}`;
    }
    return this.localNonce;
  }

  /**
   * Grant lookup passed to `ActionPolicySnapshot.evaluateApproval`. Binds the
   * caller's runtime token so a grant can never be consumed across tokens;
   * tokenless callers get an empty lookup.
   */
  createGrantLookup(runtimeTokenId: string | undefined): ApprovalGrantLookup {
    if (!runtimeTokenId) {
      return { claimGrant: () => undefined };
    }
    const store = this.store;
    return {
      claimGrant: async (query: ApprovalGrantQuery): Promise<ApprovalGrant | undefined> =>
        await store.claimGrant(runtimeTokenId, query, new Date().toISOString()),
    };
  }

  /**
   * Records a new pending approval, or returns the still-pending record an
   * identical earlier request created (same owner + request fingerprint).
   */
  async requireApproval(input: RequireApprovalInput): Promise<ApprovalResult> {
    const now = new Date();
    const create: ApprovalCreateInput = {
      id: randomUUIDv7(now.getTime()),
      kind: input.kind,
      ownerKey: input.ownerKey,
      runtimeTokenId: input.runtimeTokenId,
      actionId: input.actionId,
      service: input.service,
      connectionId: input.connectionId,
      connectionName: input.connectionName,
      connectionRequestId: input.connectionRequestId,
      operationType: input.operationType,
      caller: input.caller,
      request: input.request,
      requestFingerprint: input.requestFingerprint,
      preview: input.preview,
      now: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
    };
    const { approval, created } = await this.store.create(create);
    return { approval: await this.refreshExpiry(approval), created };
  }

  async get(id: string): Promise<ApprovalRecord | undefined> {
    const record = await this.store.get(id);
    return record ? await this.refreshExpiry(record) : undefined;
  }

  async getForOwner(id: string, ownerKey: string): Promise<ApprovalRecord | undefined> {
    const record = await this.store.getForOwner(id, ownerKey);
    return record ? await this.refreshExpiry(record) : undefined;
  }

  /** MCP `get_approval` connectionRequestId lookup; reserved for approvals created by later phases. */
  async getForConnectionRequest(connectionRequestId: string, ownerKey: string): Promise<ApprovalRecord | undefined> {
    const record = await this.store.getForConnectionRequest(connectionRequestId, ownerKey);
    return record ? await this.refreshExpiry(record) : undefined;
  }

  async list(query: ApprovalListQuery): Promise<ApprovalPage> {
    const input: ApprovalListInput = {
      status: query.status === "pending" ? "pending" : undefined,
      cursor: query.cursor,
      limit: query.limit,
    };
    return await this.store.list(input);
  }

  /**
   * Creator-side poll. Applies opportunistic expiry and the poll rate limit.
   * Executing an approved request is the caller's job — it claims the record
   * via `beginExecution` and settles it with `finishExecution`.
   */
  async poll(id: string, ownerKey: string): Promise<PollOutcome> {
    const now = new Date();
    const record = await this.getForOwner(id, ownerKey);
    if (!record) {
      return { kind: "not_found" };
    }
    if (record.status === "pending") {
      const windowStartedAt = record.pollWindowStartedAt;
      const inSameWindow =
        windowStartedAt !== undefined && now.getTime() - Date.parse(windowStartedAt) <= approvalPollWindowMs;
      const tooFast =
        record.lastPollAt !== undefined &&
        now.getTime() - Date.parse(record.lastPollAt) < approvalPollIntervalSeconds * 1000;
      const nextViolations = tooFast
        ? (inSameWindow ? record.pollViolations : 0) + 1
        : inSameWindow
          ? record.pollViolations
          : 0;
      await this.store.markPoll(id, {
        lastPollAt: now.toISOString(),
        pollWindowStartedAt: inSameWindow ? windowStartedAt : now.toISOString(),
        pollViolations: nextViolations,
      });
      if (nextViolations > approvalPollViolationLimit) {
        return { kind: "rate_limited" };
      }
      return { kind: "pending", approval: { ...record, pollViolations: nextViolations } };
    }
    if (record.status === "approved") {
      return { kind: "approved", approval: record };
    }
    if (record.status === "executing") {
      return { kind: "in_flight", approval: record };
    }
    return { kind: "terminal", approval: record };
  }

  /**
   * Claims an approved record for execution. Returns undefined when a
   * concurrent poll already claimed it or the record moved on — the caller
   * then re-reads and answers from the current state.
   */
  async beginExecution(id: string): Promise<ApprovalRecord | undefined> {
    return await this.store.beginExecution(id, new Date().toISOString());
  }

  async finishExecution(id: string, status: "executed" | "failed", executionId?: string): Promise<void> {
    await this.store.finishExecution(id, status, executionId, new Date().toISOString());
  }

  /** Puts an `executing` record back to `approved` (the execution could not start). */
  async releaseExecution(id: string): Promise<void> {
    await this.store.releaseExecution(id, new Date().toISOString());
  }

  /**
   * Admin decision. Concurrent decide calls race the same
   * `update ... where status = 'pending'` transition, so whoever loses the row
   * read returns `conflict` carrying the winning state — a deny beats an
   * approve either way.
   */
  async decide(
    id: string,
    decision: "approve" | "deny",
    input: ApprovalDecisionInput,
    grantInput?: CreateGrantInput,
  ): Promise<ApprovalDecisionOutcome> {
    const existing = await this.get(id);
    if (!existing) {
      return { kind: "not_found" };
    }
    const reason = input.decisionReason?.trim() || undefined;
    const decided: ApprovalDecision = {
      decidedBy: input.decidedBy,
      decidedAt: new Date().toISOString(),
      decisionFactor: input.decisionFactor,
      decisionReason: reason,
    };
    if (decision === "deny") {
      const approval = await this.store.deny(id, decided);
      if (!approval) {
        const current = await this.get(id);
        return current ? { kind: "conflict", approval: current } : { kind: "not_found" };
      }
      return { kind: "denied", approval };
    }

    let grant: Omit<ApprovalGrantRecord, "uses"> | undefined;
    if (grantInput) {
      const validation = validateGrantInput(existing, grantInput);
      if (validation) {
        throw new ApprovalRequestError(validation);
      }
      const now = new Date();
      const ttlMinutes = grantInput.ttlMinutes ?? grantTtlMinutesDefault;
      grant = {
        id: randomUUIDv7(now.getTime()),
        approvalId: existing.id,
        runtimeTokenId: existing.runtimeTokenId ?? "",
        actionId: existing.actionId,
        connectionId: existing.connectionId,
        operationType: existing.operationType,
        expiresAt: new Date(now.getTime() + ttlMinutes * 60_000).toISOString(),
        maxUses: grantInput.maxUses ?? 1,
        createdBy: input.decidedBy,
        createdAt: now.toISOString(),
      };
    }
    const approval = await this.store.approve(id, decided, grant);
    if (!approval) {
      const current = await this.get(id);
      return current ? { kind: "conflict", approval: current } : { kind: "not_found" };
    }
    return { kind: "approved", approval, grant: grant ? { ...grant, uses: 0 } : undefined };
  }

  async listGrants(): Promise<ApprovalGrantRecord[]> {
    return await this.store.listGrants();
  }

  async deleteGrant(id: string): Promise<boolean> {
    return await this.store.deleteGrant(id);
  }

  /**
   * Stored-request ciphertext decrypts only on the execution path, never on
   * list/get/poll responses — previews go through `summarizeForRunLog` at
   * create time so nothing secret-shaped leaves the approval endpoints.
   */
  async readStoredRequest(id: string): Promise<StoredApprovalRequest | undefined> {
    return await this.store.decodeRequest(id);
  }

  /** One maintenance pass: expire lapsed pendings, release stale executions, purge terminal ciphertext, drop dead grants. */
  async runMaintenance(now: Date = new Date()): Promise<void> {
    const nowIso = now.toISOString();
    const steps: [string, () => Promise<void>][] = [
      ["expire pending approvals", async () => await this.store.expirePending(nowIso)],
      [
        "reset stale executing approvals",
        async () =>
          await this.store.resetStaleExecuting(new Date(now.getTime() - staleExecutingMs).toISOString(), nowIso),
      ],
      [
        "purge terminal approval ciphertext",
        async () =>
          await this.store.clearTerminalCiphertext(
            new Date(now.getTime() - terminalCiphertextRetentionMs).toISOString(),
            maintenanceBatchLimit,
          ),
      ],
      ["delete expired approval grants", async () => await this.store.deleteExpiredGrants(nowIso)],
    ];
    for (const [step, run] of steps) {
      try {
        await run();
      } catch (error) {
        this.logger?.error({ err: error }, `approval maintenance: failed to ${step}`);
      }
    }
  }

  private async refreshExpiry(record: ApprovalRecord): Promise<ApprovalRecord> {
    if (record.status !== "pending" || Date.parse(record.expiresAt) > Date.now()) {
      return record;
    }
    const expired = await this.store.expireIfDue(record.id, new Date().toISOString());
    return expired ?? record;
  }
}

function validateGrantInput(approval: ApprovalRecord, input: CreateGrantInput): string | undefined {
  if (!approval.runtimeTokenId) {
    return "Grants require a persisted runtime token on the approval; bootstrap and JWT callers cannot mint grants.";
  }
  if (approval.operationType === "destructive" && input.allowDestructive !== true) {
    return "Grants for destructive operations require allowDestructive: true.";
  }
  if (input.maxUses !== undefined && (!Number.isInteger(input.maxUses) || input.maxUses < 1)) {
    return "grant.maxUses must be a positive integer.";
  }
  if (
    input.ttlMinutes !== undefined &&
    (!Number.isInteger(input.ttlMinutes) ||
      input.ttlMinutes < grantTtlMinutesMin ||
      input.ttlMinutes > grantTtlMinutesMax)
  ) {
    return `grant.ttlMinutes must be between ${grantTtlMinutesMin} and ${grantTtlMinutesMax}.`;
  }
  return undefined;
}
