import type { ActionPolicyDecision } from "../../core/action-policy.ts";
import type { CredentialProfile } from "../../core/types.ts";
import type { PactProviderReceipt } from "../../pact/pact-receipts.ts";

export const DEFAULT_RUN_LIMIT = 5_000;

export type RunLogCaller = "http" | "mcp" | "web";

/**
 * One recent action run shown by the local runtime.
 */
export interface RunLog {
  id: string;
  remoteExecutionId?: string;
  service: string;
  actionId: string;
  caller: RunLogCaller;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  ok: boolean;
  connectionId?: string;
  connectionProfile?: CredentialProfile;
  /** Set to "pact" when the run executed against a PACT Brand connection. */
  connectionSource?: "pact";
  runtimeTokenId?: string;
  /** Approval record this run executed under (or was gated by), when the approval checkpoint ran. */
  approvalId?: string;
  /** Compact JWS custodian receipt (spec §4.6), minted when a PACT identity exists. */
  receipt?: string;
  /** Brand `metadata["pact.receipt"]` verification record stored for `pact` runs (spec §4.6). */
  providerReceipt?: PactProviderReceipt;
  policy?: ActionPolicyDecision;
  inputSummary?: unknown;
  outputSummary?: unknown;
  errorCode?: string;
  errorMessage?: string;
}

export interface RunLogListInput {
  limit?: number;
  cursor?: string;
  service?: string;
  actionId?: string;
  caller?: RunLogCaller;
  ok?: boolean;
}

export interface RunLogPage {
  items: RunLog[];
  nextCursor?: string;
}

export interface RunLogWriteResult {
  retentionApplied: boolean;
}

export interface RunLogCursor {
  startedAt: string;
  id: string;
}

export function encodeRunLogCursor(run: RunLog): string {
  return encodeURIComponent(JSON.stringify({ startedAt: run.startedAt, id: run.id } satisfies RunLogCursor));
}

export function decodeRunLogCursor(cursor: string | undefined): RunLogCursor | undefined {
  if (cursor === undefined || cursor === "") {
    return undefined;
  }

  const value = JSON.parse(decodeURIComponent(cursor)) as Partial<RunLogCursor>;
  if (typeof value.startedAt !== "string" || typeof value.id !== "string") {
    throw new Error("Invalid run log cursor.");
  }

  return {
    startedAt: value.startedAt,
    id: value.id,
  };
}

/**
 * Storage contract for recent action run logs.
 */
export interface IRunLogStore {
  add(run: RunLog): Promise<RunLogWriteResult>;
  get(id: string): Promise<RunLog | undefined>;
  list(input?: RunLogListInput): Promise<RunLogPage>;
}
