import type { ApprovalGrantLookup } from "../../core/action-policy.ts";
import type { ActionOperationType } from "../../core/types.ts";
import type { ApprovalKind, ApprovalRecord, StoredApprovalRequest } from "../storage/approval-store.ts";
import type { RunLogCaller } from "../storage/runtime-store.ts";

/**
 * Per-request approval gate handed to the runners. The request handler binds
 * the caller's owner key and grant lookup; the runner calls `requireApproval`
 * only when the policy overlay says `approval_required`, so the gate never
 * fires for callers or actions the policy lets run.
 */
export interface ApprovalGate {
  /** Live-grant lookup for `ActionPolicySnapshot.evaluateApproval`; already bound to the caller's token. */
  lookup: ApprovalGrantLookup;
  /** Records (or dedupes) a pending approval for the gated request and returns it. */
  requireApproval(input: ApprovalGateRequest): Promise<ApprovalGateResult>;
}

export interface ApprovalGateRequest {
  kind: ApprovalKind;
  /** Action id for `kind: "action"`, provider service id for `kind: "proxy"`. */
  actionId: string;
  service: string;
  operationType: ActionOperationType;
  caller: RunLogCaller;
  request: StoredApprovalRequest;
}

export interface ApprovalGateResult {
  approval: ApprovalRecord;
  created: boolean;
}

/** Interception outcome the runners surface to their caller. */
export interface ApprovalInterception {
  approval: ApprovalRecord;
  created: boolean;
}
