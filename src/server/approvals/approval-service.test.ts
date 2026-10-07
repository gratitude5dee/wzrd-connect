import type { ApprovalRecord } from "../storage/approval-store.ts";

import { afterEach, describe, expect, it } from "vitest";
import { hashActionRequest } from "../actions/action-idempotency.ts";
import { SqliteRuntimeDatabase } from "../storage/sqlite/runtime-store.ts";
import { approvalPollViolationLimit, ApprovalRequestError, ApprovalService } from "./approval-service.ts";

const databases: SqliteRuntimeDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function createService(options: { ttlSeconds?: number } = {}): {
  service: ApprovalService;
  database: SqliteRuntimeDatabase;
} {
  const database = new SqliteRuntimeDatabase(":memory:");
  databases.push(database);
  return {
    database,
    service: new ApprovalService({
      store: database.approvalStore,
      ttlSeconds: options.ttlSeconds,
    }),
  };
}

async function createPending(
  service: ApprovalService,
  overrides: {
    ownerKey?: string;
    fingerprint?: string;
    runtimeTokenId?: string;
    operationType?: "read" | "write" | "destructive";
  } = {},
): Promise<ApprovalRecord> {
  const input = { message: "hello" };
  const result = await service.requireApproval({
    kind: "action",
    ownerKey: overrides.ownerKey ?? "owner-a",
    runtimeTokenId: overrides.runtimeTokenId,
    actionId: "example.echo",
    service: "example",
    connectionName: "default",
    operationType: overrides.operationType ?? "write",
    caller: "http",
    request: { input, connectionName: "default" },
    requestFingerprint:
      overrides.fingerprint ?? hashActionRequest({ actionId: "example.echo", connectionName: "default", input }),
    preview: { message: "hello" },
  });
  return result.approval;
}

describe("ApprovalService", () => {
  it("deduplicates pending approvals by owner and request fingerprint", async () => {
    const { service } = createService();
    const input = { message: "hello" };
    const fingerprint = hashActionRequest({ actionId: "example.echo", connectionName: "default", input });
    const args = {
      kind: "action" as const,
      ownerKey: "owner-a",
      actionId: "example.echo",
      service: "example",
      connectionName: "default",
      operationType: "write" as const,
      caller: "http" as const,
      request: { input, connectionName: "default" },
      requestFingerprint: fingerprint,
      preview: { message: "hello" },
    };

    const first = await service.requireApproval(args);
    const second = await service.requireApproval(args);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.approval.id).toBe(first.approval.id);

    const otherOwner = await service.requireApproval({ ...args, ownerKey: "owner-b" });
    expect(otherOwner.created).toBe(true);
    expect(otherOwner.approval.id).not.toBe(first.approval.id);
  });

  it("polls pending approvals only for their owner", async () => {
    const { service } = createService();
    const pending = await createPending(service);

    await expect(service.poll(pending.id, "other-owner")).resolves.toEqual({ kind: "not_found" });
    const outcome = await service.poll(pending.id, "owner-a");
    expect(outcome.kind).toBe("pending");
    if (outcome.kind === "pending") {
      expect(outcome.approval.id).toBe(pending.id);
    }
    await expect(service.get(pending.id)).resolves.toMatchObject({ status: "pending" });
  });

  it("rate limits fast polls after the violation limit", async () => {
    const { service } = createService();
    const pending = await createPending(service);

    let outcome = await service.poll(pending.id, "owner-a");
    expect(outcome.kind).toBe("pending");
    for (let i = 0; i < approvalPollViolationLimit + 1; i += 1) {
      outcome = await service.poll(pending.id, "owner-a");
    }
    expect(outcome.kind).toBe("rate_limited");
  });

  it("decides atomically: the second decision on a decided record conflicts", async () => {
    const { service } = createService();
    const pending = await createPending(service);
    const decision = { decidedBy: "admin", decisionFactor: "admin" };

    const first = await service.decide(pending.id, "deny", decision);
    expect(first.kind).toBe("denied");

    const second = await service.decide(pending.id, "approve", decision);
    expect(second.kind).toBe("conflict");
    if (second.kind === "conflict") {
      expect(second.approval.status).toBe("denied");
    }

    const outcome = await service.poll(pending.id, "owner-a");
    expect(outcome.kind).toBe("terminal");
    if (outcome.kind === "terminal") {
      expect(outcome.approval.status).toBe("denied");
    }
  });

  it("expires pending approvals past their TTL on read and via maintenance", async () => {
    const { service } = createService({ ttlSeconds: 60 });
    const pending = await createPending(service);

    const future = new Date(Date.now() + 120_000);
    await service.runMaintenance(future);
    await expect(service.get(pending.id)).resolves.toMatchObject({ status: "expired" });

    const outcome = await service.poll(pending.id, "owner-a");
    expect(outcome.kind).toBe("terminal");
    if (outcome.kind === "terminal") {
      expect(outcome.approval.status).toBe("expired");
    }
  });

  it("mints grants on approve and consumes them atomically per runtime token", async () => {
    const { service } = createService();
    const pending = await createPending(service, { runtimeTokenId: "token-1" });

    const outcome = await service.decide(
      pending.id,
      "approve",
      { decidedBy: "admin", decisionFactor: "admin" },
      { ttlMinutes: 30, maxUses: 1 },
    );
    expect(outcome.kind).toBe("approved");
    if (outcome.kind !== "approved") throw new Error("expected approve");
    expect(outcome.grant).toMatchObject({ runtimeTokenId: "token-1", actionId: "example.echo", maxUses: 1, uses: 0 });
    expect(outcome.approval.grantId).toBe(outcome.grant?.id);

    const lookup = service.createGrantLookup("token-1");
    const claimed = await lookup.claimGrant({ actionId: "example.echo", operationType: "write" });
    expect(claimed).toMatchObject({ id: outcome.grant!.id, uses: 1 });
    // maxUses spent: a second claim finds nothing.
    await expect(lookup.claimGrant({ actionId: "example.echo", operationType: "write" })).resolves.toBeUndefined();
    // Grants never cross tokens.
    const otherLookup = service.createGrantLookup("token-2");
    await expect(otherLookup.claimGrant({ actionId: "example.echo", operationType: "write" })).resolves.toBeUndefined();
  });

  it("ignores expired grants and refuses destructive grants without allowDestructive", async () => {
    const { service } = createService();
    const pending = await createPending(service, { runtimeTokenId: "token-1" });
    const expired = await service.decide(
      pending.id,
      "approve",
      { decidedBy: "admin", decisionFactor: "admin" },
      { ttlMinutes: 1 },
    );
    expect(expired.kind).toBe("approved");
    await service.runMaintenance(new Date(Date.now() + 5 * 60 * 1000));
    const lookup = service.createGrantLookup("token-1");
    await expect(lookup.claimGrant({ actionId: "example.echo", operationType: "write" })).resolves.toBeUndefined();

    const destructive = await createPending(service, {
      runtimeTokenId: "token-1",
      operationType: "destructive",
      fingerprint: "fp-destructive",
    });
    await expect(
      service.decide(
        destructive.id,
        "approve",
        { decidedBy: "admin", decisionFactor: "admin" },
        { allowDestructive: false },
      ),
    ).rejects.toBeInstanceOf(ApprovalRequestError);
  });

  it("refuses grants on approvals without a persistent runtime token", async () => {
    const { service } = createService();
    const pending = await createPending(service);
    await expect(
      service.decide(pending.id, "approve", { decidedBy: "admin", decisionFactor: "admin" }, { ttlMinutes: 30 }),
    ).rejects.toBeInstanceOf(ApprovalRequestError);
  });

  it("keeps stored requests ciphertext-only until the execution path decodes them", async () => {
    const { service } = createService();
    const pending = await createPending(service);
    await expect(service.readStoredRequest(pending.id)).resolves.toEqual({
      input: { message: "hello" },
      connectionName: "default",
    });
    // Serialization surfaces never expose ciphertext or the owner key material.
    const listed = await service.list({ status: "pending" });
    expect(listed.items[0]).not.toHaveProperty("requestCiphertext");
    expect(listed.items[0]).not.toHaveProperty("request");
  });
});
