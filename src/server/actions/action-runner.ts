import type { CatalogStore } from "../../catalog-store.ts";
import type { ConnectionService, ConnectionSummary, ExecutionConnection } from "../../connection-service.ts";
import type { ActionPolicyDecision, ActionPolicySnapshot, ApprovalCheck } from "../../core/action-policy.ts";
import type { ProviderHttpDispatchOptions } from "../../core/provider-http-dispatch.ts";
import type { RuntimeLogger, ExecutionContext, ExecutionResult, TransitFileWriter } from "../../core/types.ts";
import type { MarketplaceService } from "../../marketplace/marketplace-service.ts";
import type { PactService } from "../../pact/pact-service.ts";
import type { IProviderLoader } from "../../providers/provider-loader.ts";
import type { SaasExecutionService } from "../../saas/saas-execution-service.ts";
import type { ApprovalGate, ApprovalInterception } from "../approvals/approval-gate.ts";
import type { IRunLogStore, RunLog, RunLogCaller, RunLogListInput, RunLogPage } from "../storage/runtime-store.ts";

import { ConnectionError } from "../../connection-service.ts";
import { executeAction as executeProviderAction } from "../../core/execution.ts";
import { withProviderHttpDispatch } from "../../core/provider-http-dispatch.ts";
import {
  ProviderDispatchRequestError,
  toProviderExecutionError,
  withProviderHttpDispatchResult,
} from "../../providers/provider-runtime.ts";
import { SaasError } from "../../saas/saas-client.ts";
import { safeRunLogError, summarizeForRunLog } from "./run-log-summary.ts";

export interface ActionRunnerOptions {
  providerHttpDispatch?: ProviderHttpDispatchOptions;
  catalog: CatalogStore;
  providerLoader: IProviderLoader;
  connections: ConnectionService;
  runs: IRunLogStore;
  transitFiles?: TransitFileWriter;
  logger?: RuntimeLogger;
  marketplace?: MarketplaceService;
  saas?: SaasExecutionService;
  /** PACT Brand dispatch (spec §4.4); absent when OOMOL_CONNECT_PACT_ENABLED is off. */
  pact?: PactService;
}

export interface RunActionInput {
  actionId: string;
  input: unknown;
  caller: RunLogCaller;
  connectionName?: string;
  connectionId?: string;
  policy: ActionPolicySnapshot;
  runtimeTokenId?: string;
  /** Runtime token subject — used as the PA-JWT `sub` on PACT sends. */
  runtimeSubject?: string;
  signal?: AbortSignal;
  /** Per-request approval gate; absent means the approval overlay never runs. */
  approvalGate?: ApprovalGate;
  /** Set on execute-on-poll calls: the stored approval already answered the overlay. */
  bypassApproval?: boolean;
  /** Approval record this run executes on behalf of; lands on the run log. */
  approvalId?: string;
}

export interface ActionRunResult {
  executionId: string;
  auditPersisted: boolean;
  remoteExecutionId?: string;
  failureStatus?: SaasError["status"];
  retryAfter?: string;
  result: ExecutionResult;
  connection?: ConnectionSummary;
  /** Present when the approval overlay evaluated this run; `interception` marks a recorded pending approval. */
  approval?: {
    check: ApprovalCheck;
    interception?: ApprovalInterception;
  };
}

/**
 * Shared execution boundary for HTTP, MCP, and future local callers.
 */
export class ActionRunner {
  private readonly options: ActionRunnerOptions;

  constructor(options: ActionRunnerOptions) {
    this.options = options;
  }

  async run(input: RunActionInput): Promise<ActionRunResult | undefined> {
    const action = this.options.catalog.actionsById.get(input.actionId);
    return withProviderHttpDispatch(
      { operation: "action", service: action?.service, actionId: action?.id },
      () => this.runAction(input),
      this.options.providerHttpDispatch,
    );
  }

  private async runAction(input: RunActionInput): Promise<ActionRunResult | undefined> {
    const action = this.options.catalog.actionsById.get(input.actionId);
    if (!action) {
      this.options.logger?.warn(
        {
          actionId: input.actionId,
          caller: input.caller,
          errorCode: "unknown_action",
        },
        "action run rejected",
      );
      return undefined;
    }

    const executionId = crypto.randomUUID();
    const logContext = {
      actionId: action.id,
      service: action.service,
      caller: input.caller,
      executionId,
    };
    this.options.logger?.info(logContext, "action run started");
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    let policy: ActionPolicyDecision = input.policy.evaluate(action);
    let connection: ExecutionConnection | undefined;
    let result: ExecutionResult;
    let remoteExecutionId: string | undefined;
    let failureStatus: SaasError["status"] | undefined;
    let retryAfter: string | undefined;
    let approvalId: string | undefined = input.approvalId;
    let approval: ActionRunResult["approval"];
    if (!policy.allowed) {
      result = { ok: false, error: { code: policy.code, message: policy.message } };
    } else if (input.signal?.aborted) {
      result = cancelledExecutionResult();
    } else {
      try {
        const summary = await this.options.connections.getConnectionSummary(
          action.service,
          input.connectionName,
          input.connectionId,
        );
        input.signal?.throwIfAborted();
        const connectionPolicy =
          summary?.authType === "no_auth" ? undefined : input.policy.evaluateConnection(summary?.id);
        if (connectionPolicy && !connectionPolicy.allowed) {
          policy = connectionPolicy;
          result = { ok: false, error: { code: policy.code, message: policy.message } };
        } else if (summary?.authType === "marketplace" && !this.options.marketplace?.supportsAction(action.id)) {
          result = {
            ok: false,
            error: {
              code: "connection_not_found",
              message: "The selected Marketplace connection does not support this action.",
            },
          };
        } else {
          // Approval checkpoint: after the allow/block policy (and connection policy) passed,
          // before credential lookup. `bypassApproval` skips the overlay on execute-on-poll calls —
          // re-evaluating it there would gate an already-approved request behind a second approval.
          // Virtual summaries (no_auth / marketplace) have synthetic ids that are not in the
          // connection store; persisting one as connectionId would make the approved replay fail
          // with connection_not_found. Only real stored ids (or a caller-supplied id) are kept.
          const approvalConnectionId = summary?.virtual ? undefined : (summary?.id ?? input.connectionId);
          const approvalCheck =
            input.bypassApproval || !input.approvalGate
              ? undefined
              : await input.policy.evaluateApproval(
                  { id: action.id, operationType: action.operationType, connectionId: approvalConnectionId },
                  input.approvalGate.lookup,
                );
          if (approvalCheck && policy.allowed) {
            policy = { allowed: true, checks: policy.checks, approval: approvalCheck };
          }
          if (approvalCheck?.outcome === "approval_required" && input.approvalGate) {
            const interception = await input.approvalGate.requireApproval({
              kind: "action",
              actionId: action.id,
              service: action.service,
              operationType: action.operationType,
              caller: input.caller,
              request: {
                input: input.input,
                connectionName: summary?.connectionName ?? input.connectionName,
                connectionId: approvalConnectionId,
              },
            });
            approvalId = interception.approval.id;
            approval = { check: approvalCheck, interception };
            result = {
              ok: false,
              error: { code: "approval_required", message: "Action requires approval before execution." },
            };
          } else {
            connection = await this.options.connections.resolveForExecution(
              action.service,
              input.connectionName,
              input.connectionId,
            );
            input.signal?.throwIfAborted();
            const targetPolicy =
              connection.summary?.authType === "no_auth"
                ? undefined
                : input.policy.evaluateConnection(connection.summary?.id);
            if (targetPolicy && !targetPolicy.allowed) {
              policy = targetPolicy;
              throw new ConnectionError(targetPolicy.code, targetPolicy.message);
            }
            const executor =
              action.execution.locallyExecutable && connection.kind === "local"
                ? await this.options.providerLoader.loadActionExecutor(
                    action.service,
                    action.id,
                    this.options.catalog.providers.find((provider) => provider.service === action.service)?.displayName,
                  )
                : undefined;
            input.signal?.throwIfAborted();
            const saasReference = connection.kind === "saas" ? connection.reference : undefined;
            const resolvedConnection = connection;
            result = await withProviderHttpDispatchResult(
              {
                operation: "action",
                service: action.service,
                actionId: action.id,
                executionId,
                connectionId: connection.summary?.id,
                connectionName: connection.summary?.connectionName,
              },
              () =>
                executeProviderAction(
                  action,
                  saasReference
                    ? async (actionInput) => {
                        if (!this.options.saas)
                          throw new SaasError("oauth_source_unavailable", "SaaS execution is unavailable.", 503);
                        const remote = await this.options.saas.executeAction(
                          saasReference,
                          action.service,
                          action.id,
                          actionInput,
                          input.signal,
                        );
                        remoteExecutionId = remote.executionId;
                        return { ok: true, output: remote.output };
                      }
                    : resolvedConnection.kind === "marketplace"
                      ? (actionInput) => this.options.marketplace!.execute(action.id, actionInput, input.signal)
                      : resolvedConnection.kind === "pact"
                        ? (actionInput): Promise<ExecutionResult> =>
                            this.options.pact
                              ? this.options.pact.execute({
                                  actionId: action.id,
                                  connection: resolvedConnection.connection,
                                  input: actionInput,
                                  executionId,
                                  subject: input.runtimeSubject,
                                  signal: input.signal,
                                })
                              : Promise.resolve({
                                  ok: false,
                                  error: {
                                    code: "provider_unavailable",
                                    message: "PACT execution is disabled on this deployment.",
                                  },
                                })
                        : executor,
                  input.input,
                  this.createExecutionContext(
                    resolvedConnection.kind === "local" ? resolvedConnection.getCredential : async () => undefined,
                    input.signal,
                  ),
                ),
              this.options.providerHttpDispatch,
            );
            if (input.signal?.aborted) {
              result = cancelledExecutionResult();
            }
          }
        }
      } catch (error) {
        const missingConnectionPolicy =
          error instanceof ConnectionError && error.code === "connection_not_found"
            ? input.policy.evaluateConnection()
            : undefined;
        if (input.signal?.aborted) {
          result = cancelledExecutionResult();
        } else if (missingConnectionPolicy && !missingConnectionPolicy.allowed) {
          policy = missingConnectionPolicy;
          result = { ok: false, error: { code: policy.code, message: policy.message } };
        } else if (error instanceof SaasError) {
          remoteExecutionId = error.remoteExecutionId;
          failureStatus = error.status;
          retryAfter = error.retryAfter;
          result = { ok: false, error: { code: error.code, message: error.message } };
        } else if (error instanceof ProviderDispatchRequestError) {
          result = toProviderExecutionError(error, error.message);
        } else {
          result =
            error instanceof ConnectionError
              ? { ok: false, error: { code: error.code, message: error.message } }
              : {
                  ok: false,
                  error: { code: "internal_error", message: "Action execution failed unexpectedly." },
                };
        }
      }
    }
    const completedAtMs = Date.now();
    const durationMs = completedAtMs - startedAtMs;
    const auditError = safeRunLogError(result.error);
    const runLog: RunLog = {
      id: executionId,
      remoteExecutionId,
      service: action.service,
      actionId: input.actionId,
      caller: input.caller,
      startedAt,
      completedAt: new Date(completedAtMs).toISOString(),
      durationMs,
      ok: result.ok,
      connectionId: connection?.summary?.id,
      connectionProfile: connection?.summary?.profile,
      connectionSource: connection?.kind === "pact" ? "pact" : undefined,
      runtimeTokenId: input.runtimeTokenId,
      approvalId,
      policy,
      inputSummary: summarizeForRunLog(input.input),
      outputSummary: result.ok ? summarizeForRunLog(result.output) : undefined,
      ...auditError,
    };

    let auditPersisted = false;
    try {
      const write = await this.options.runs.add(runLog);
      auditPersisted = true;
      if (!write.retentionApplied) {
        this.options.logger?.warn({ ...logContext, auditPersisted }, "run audit retention failed");
      }
    } catch {
      this.options.logger?.warn({ ...logContext, auditPersisted }, "run audit persistence failed");
    }

    const completedLogContext = {
      ...logContext,
      remoteExecutionId,
      connectionId: connection?.summary?.id,
      durationMs,
      ok: result.ok,
      errorCode: result.error?.code,
      auditPersisted,
    };
    if (result.ok) {
      this.options.logger?.info(completedLogContext, "action run completed");
    } else if (result.error?.code === "execution_cancelled") {
      this.options.logger?.info(completedLogContext, "action run cancelled");
    } else {
      this.options.logger?.warn(completedLogContext, "action run failed");
    }

    return {
      executionId,
      remoteExecutionId,
      failureStatus,
      retryAfter,
      auditPersisted,
      result,
      connection: connection?.summary,
      approval,
    };
  }

  listRuns(input?: RunLogListInput): Promise<RunLogPage> {
    return this.options.runs.list(input);
  }

  getRun(id: string): Promise<RunLog | undefined> {
    return this.options.runs.get(id);
  }

  private createExecutionContext(
    getCredential: ExecutionContext["getCredential"],
    signal: AbortSignal | undefined,
  ): ExecutionContext {
    const context: ExecutionContext = {
      getCredential,
      signal,
      logger: this.options.logger,
    };
    if (this.options.transitFiles) {
      context.transitFiles = this.options.transitFiles;
    }
    return context;
  }
}

function cancelledExecutionResult(): ExecutionResult {
  return {
    ok: false,
    error: {
      code: "execution_cancelled",
      message: "Action execution was cancelled.",
    },
  };
}
