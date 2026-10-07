import type { TokenPolicy } from "../../core/action-policy.ts";
import type { ActionOperationType, RuntimeLogger } from "../../core/types.ts";

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export interface RuntimeTokenRecord {
  id: string;
  name: string;
  tokenHash: string;
  allowedActions: string[];
  blockedActions: string[];
  allowedProxies: string[];
  allowedConnections: string[];
  allowedTriggers?: string[];
  requireApprovalOperations?: ActionOperationType[];
  approvalRequiredActions?: string[];
  createdAt: string;
  lastUsedAt?: string;
  /** Opaque PACT `sub` for PA-JWTs minted for this token's calls. */
  subject: string;
}

export interface RuntimeTokenSummary {
  id: string;
  name: string;
  allowedActions: string[];
  blockedActions: string[];
  allowedProxies: string[];
  allowedConnections: string[];
  allowedTriggers?: string[];
  requireApprovalOperations?: ActionOperationType[];
  approvalRequiredActions?: string[];
  createdAt: string;
  lastUsedAt?: string;
  /** Opaque PACT `sub` identifying the agent behind this token. */
  subject: string;
}

export interface RuntimeTokenCreation {
  token: string;
  record: RuntimeTokenRecord;
}

export interface IRuntimeTokenStore {
  add(record: RuntimeTokenRecord): Promise<void>;
  list(): Promise<RuntimeTokenRecord[]>;
  findByHash(tokenHash: string): Promise<RuntimeTokenRecord | undefined>;
  updatePolicy(id: string, policy: TokenPolicy): Promise<RuntimeTokenRecord | undefined>;
  updateSubject(id: string, subject: string): Promise<RuntimeTokenRecord | undefined>;
  revoke(id: string): Promise<boolean>;
  markUsed(id: string, usedAt: string): Promise<void>;
}

const tokenPrefix = "oct_";

export interface RuntimeGrant extends TokenPolicy {
  tokenId: string;
  /** PACT `sub` identifying the agent behind this token. */
  subject: string;
}

export class RuntimeTokenService {
  private readonly store: IRuntimeTokenStore;
  private readonly logger?: RuntimeLogger;

  constructor(store: IRuntimeTokenStore, logger?: RuntimeLogger) {
    this.store = store;
    this.logger = logger;
  }

  async createToken(
    name: string,
    policy: TokenPolicy = {
      allowedActions: [],
      blockedActions: [],
      allowedProxies: [],
      allowedConnections: [],
    },
  ): Promise<RuntimeTokenCreation> {
    const token = `${tokenPrefix}${randomBytes(32).toString("base64url")}`;
    const now = new Date().toISOString();
    const record: RuntimeTokenRecord = {
      id: randomUUID(),
      name: name.trim(),
      tokenHash: hashRuntimeToken(token),
      allowedActions: policy.allowedActions,
      blockedActions: policy.blockedActions,
      allowedProxies: policy.allowedProxies,
      allowedConnections: policy.allowedConnections ?? [],
      allowedTriggers: policy.allowedTriggers ?? [],
      requireApprovalOperations: policy.requireApprovalOperations,
      approvalRequiredActions: policy.approvalRequiredActions,
      createdAt: now,
      subject: randomRuntimeTokenSubject(),
    };
    await this.store.add(record);
    return { token, record };
  }

  async listTokens(): Promise<RuntimeTokenSummary[]> {
    return (await this.store.list()).map(summarizeRuntimeToken);
  }

  async revokeToken(id: string): Promise<boolean> {
    return this.store.revoke(id);
  }

  async rotateTokenSubject(id: string): Promise<RuntimeTokenSummary | undefined> {
    const record = await this.store.updateSubject(id, randomRuntimeTokenSubject());
    return record ? summarizeRuntimeToken(record) : undefined;
  }

  async updateTokenPolicy(id: string, policy: TokenPolicy): Promise<RuntimeTokenSummary | undefined> {
    const record = await this.store.updatePolicy(id, policy);
    return record ? summarizeRuntimeToken(record) : undefined;
  }

  async resolveToken(token: string): Promise<RuntimeGrant | undefined> {
    if (!token.startsWith(tokenPrefix)) {
      return undefined;
    }
    const tokenHash = hashRuntimeToken(token);
    const matched = await this.store.findByHash(tokenHash);
    if (!matched || !equalHashes(matched.tokenHash, tokenHash)) {
      return undefined;
    }

    await this.recordLastUsed(matched.id);
    return {
      tokenId: matched.id,
      allowedActions: matched.allowedActions,
      blockedActions: matched.blockedActions,
      allowedProxies: matched.allowedProxies,
      allowedConnections: matched.allowedConnections ?? [],
      allowedTriggers: matched.allowedTriggers ?? [],
      requireApprovalOperations: matched.requireApprovalOperations,
      approvalRequiredActions: matched.approvalRequiredActions,
      subject: matched.subject,
    };
  }

  async verifyToken(token: string): Promise<boolean> {
    return Boolean(await this.resolveToken(token));
  }

  /**
   * `last_used_at` is best-effort audit metadata, so a failed write is logged
   * instead of turning an authenticated caller into a failed request.
   */
  private async recordLastUsed(tokenId: string): Promise<void> {
    try {
      await this.store.markUsed(tokenId, new Date().toISOString());
    } catch (error) {
      this.logger?.warn({ tokenId, err: error }, "runtime token last use update failed");
    }
  }
}

export function hashRuntimeToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

/** Opaque 128-bit base64url `sub` shared by PA-JWTs minted for one runtime token. */
export function randomRuntimeTokenSubject(): string {
  return randomBytes(16).toString("base64url");
}

export function summarizeRuntimeToken(record: RuntimeTokenRecord): RuntimeTokenSummary {
  return {
    id: record.id,
    name: record.name,
    allowedActions: record.allowedActions,
    blockedActions: record.blockedActions,
    allowedProxies: record.allowedProxies,
    allowedConnections: record.allowedConnections,
    allowedTriggers: record.allowedTriggers ?? [],
    requireApprovalOperations: record.requireApprovalOperations,
    approvalRequiredActions: record.approvalRequiredActions,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    subject: record.subject,
  };
}

function equalHashes(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
