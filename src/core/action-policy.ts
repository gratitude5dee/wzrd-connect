import type { ActionDefinition, ActionOperationType } from "./types.ts";

export type PolicySource = "deployment" | "runtime" | "token";

export type PolicyErrorCode =
  | "action_not_allowed"
  | "action_blocked"
  | "proxy_not_allowed"
  | "proxy_blocked"
  | "connection_not_allowed"
  | "trigger_not_allowed"
  | "trigger_blocked";

export interface PolicyCheck {
  source: PolicySource;
  outcome: "allow_match" | "block_match" | "allow_miss";
  rule?: string;
}

/** What the approval overlay decided for one request. */
export type ApprovalOutcome = "execute" | "approval_required" | "grant";

/** Where the approval overlay's decisive rule lived. "grant" marks a live approval grant and "default" unrestricted execution. */
export type ApprovalSource = PolicySource | "default" | "grant";

/** The approval overlay's decision for one request, recorded on the run log as `policy.approval`. */
export interface ApprovalCheck {
  source: ApprovalSource;
  outcome: ApprovalOutcome;
  /** The action pattern or operation type that decided the outcome. */
  rule?: string;
  /** Live grant that authorized execution when the outcome is "grant". */
  grantId?: string;
}

/** One request the approval overlay evaluates. An `ActionDefinition` is assignable to this contract. */
export interface ApprovalEvaluationTarget {
  /** Identifier matched by approval action patterns: the Action id, or the service name for proxy requests. */
  id: string;
  /** Risk class of the request. Proxies derive it from the HTTP method with `proxyOperationType`. */
  operationType: ActionOperationType;
  /** Selected connection identifier; live approval grants are bound to it. */
  connectionId?: string;
}

/** A time-boxed approval grant recorded by the approval checkpoint. */
export interface ApprovalGrant {
  id: string;
  runtimeTokenId: string;
  actionId: string;
  connectionId?: string;
  operationType: ActionOperationType;
  expiresAt: string;
  maxUses: number;
  uses: number;
}

/** The request facts a grant must cover. The lookup binds the caller's runtime token itself. */
export interface ApprovalGrantQuery {
  actionId: string;
  operationType: ActionOperationType;
  connectionId?: string;
}

/** Finds a live grant covering one request and consumes one use atomically. */
export interface ApprovalGrantLookup {
  claimGrant(query: ApprovalGrantQuery): ApprovalGrant | undefined | Promise<ApprovalGrant | undefined>;
}

/** Grant lookup shipped before the approval store lands: it never returns a grant. */
export const emptyApprovalGrantLookup: ApprovalGrantLookup = {
  claimGrant: () => undefined,
};

export type ActionPolicyDecision =
  | { allowed: true; checks: PolicyCheck[]; approval?: ApprovalCheck }
  | {
      allowed: false;
      code: PolicyErrorCode;
      message: string;
      checks: PolicyCheck[];
    };

export interface PolicyRules {
  allowedActions: string[];
  blockedActions: string[];
  allowedProxies: string[];
  blockedProxies: string[];
  allowedTriggers?: string[];
  blockedTriggers?: string[];
  /** Operation types that require a human approval before execution. */
  requireApprovalOperations?: ActionOperationType[];
  /** Action-id patterns that always require approval. */
  approvalRequiredActions?: string[];
  /** Action-id patterns that never require approval. */
  approvalExemptActions?: string[];
}

export interface TokenPolicy {
  allowedActions: string[];
  blockedActions: string[];
  allowedProxies: string[];
  allowedConnections?: string[];
  allowedTriggers?: string[];
  /** Operation types this token additionally sends to approval. A token can widen, never exempt. */
  requireApprovalOperations?: ActionOperationType[];
  /** Action-id patterns this token additionally sends to approval. */
  approvalRequiredActions?: string[];
}

export interface RuntimePolicyState {
  deployment: PolicyRules;
  runtime: PolicyRules;
  updatedAt?: string;
}

export interface ActionPolicyConfig {
  allowedActions?: string[];
  blockedActions?: string[];
  allowedProxies?: string[];
  blockedProxies?: string[];
  allowedTriggers?: string[];
  blockedTriggers?: string[];
  requireApprovalOperations?: ActionOperationType[];
  approvalRequiredActions?: string[];
  approvalExemptActions?: string[];
}

interface CompiledRule {
  pattern: string;
  matches(value: string): boolean;
}

interface CompiledLayer {
  source: PolicySource;
  allowedActions: CompiledRule[];
  blockedActions: CompiledRule[];
  allowedProxies: CompiledRule[];
  blockedProxies: CompiledRule[];
  allowedTriggers: CompiledRule[];
  blockedTriggers: CompiledRule[];
}

interface CompiledApprovalLayer {
  source: PolicySource;
  requiredActions: CompiledRule[];
  exemptActions: CompiledRule[];
  requiredOperations: ReadonlySet<ActionOperationType>;
}

/**
 * Immutable policy view shared by every policy consumer in one request.
 */
export class ActionPolicySnapshot {
  readonly state: RuntimePolicyState;
  private readonly layers: CompiledLayer[];
  private readonly proxyLayers: CompiledLayer[];
  private readonly approvalLayers: CompiledApprovalLayer[];
  private readonly tokenProxyRules?: CompiledRule[];
  private readonly tokenTriggerRules?: CompiledRule[];
  private readonly allowedConnections: readonly string[];

  constructor(deployment: PolicyRules, runtime: PolicyRules, token?: TokenPolicy, updatedAt?: string) {
    const deploymentRules = immutablePolicyRules(deployment);
    const runtimeRules = immutablePolicyRules(runtime);
    this.state = Object.freeze({ deployment: deploymentRules, runtime: runtimeRules, updatedAt });
    this.proxyLayers = [compileLayer("deployment", deploymentRules), compileLayer("runtime", runtimeRules)];
    this.layers = [...this.proxyLayers];
    this.approvalLayers = [
      compileApprovalLayer("deployment", deploymentRules),
      compileApprovalLayer("runtime", runtimeRules),
    ];
    this.allowedConnections = Object.freeze([...(token?.allowedConnections ?? [])]);
    if (token) {
      const tokenRules = immutablePolicyRules({
        allowedActions: token.allowedActions,
        blockedActions: token.blockedActions,
        allowedProxies: token.allowedProxies,
        blockedProxies: [],
      });
      const tokenLayer = compileLayer("token", tokenRules);
      this.layers.push(tokenLayer);
      this.tokenProxyRules = tokenLayer.allowedProxies;
      this.tokenTriggerRules = (token.allowedTriggers ?? []).map(compileActionRule);
      this.approvalLayers.push(compileTokenApprovalLayer(token));
    }
  }

  evaluate(action: ActionDefinition): ActionPolicyDecision {
    for (const layer of this.layers) {
      const blocked = layer.blockedActions.find((rule) => rule.matches(action.id));
      if (blocked) {
        return {
          allowed: false,
          code: "action_blocked",
          message: `${action.id} is blocked by the local action policy.`,
          checks: [{ source: layer.source, outcome: "block_match", rule: blocked.pattern }],
        };
      }
    }

    const checks: PolicyCheck[] = [];
    for (const layer of this.layers) {
      if (layer.allowedActions.length === 0) {
        continue;
      }
      const allowed = layer.allowedActions.find((rule) => rule.matches(action.id));
      if (!allowed) {
        return {
          allowed: false,
          code: "action_not_allowed",
          message: `${action.id} is not included in the local action allowlist.`,
          checks: [...checks, { source: layer.source, outcome: "allow_miss" }],
        };
      }
      checks.push({ source: layer.source, outcome: "allow_match", rule: allowed.pattern });
    }

    return { allowed: true, checks };
  }

  evaluateProxy(service: string): ActionPolicyDecision {
    for (const layer of this.proxyLayers) {
      const blocked = layer.blockedProxies.find((rule) => rule.matches(service));
      if (blocked) {
        return {
          allowed: false,
          code: "proxy_blocked",
          message: `${service} proxy is blocked by the local proxy policy.`,
          checks: [{ source: layer.source, outcome: "block_match", rule: blocked.pattern }],
        };
      }
    }

    const checks: PolicyCheck[] = [];
    for (const layer of this.proxyLayers) {
      if (layer.allowedProxies.length === 0) {
        continue;
      }
      const allowed = layer.allowedProxies.find((rule) => rule.matches(service));
      if (!allowed) {
        return {
          allowed: false,
          code: "proxy_not_allowed",
          message: `${service} proxy is not included in the local proxy allowlist.`,
          checks: [...checks, { source: layer.source, outcome: "allow_miss" }],
        };
      }
      checks.push({ source: layer.source, outcome: "allow_match", rule: allowed.pattern });
    }

    if (this.tokenProxyRules) {
      const allowed = this.tokenProxyRules.find((rule) => rule.matches(service));
      if (!allowed) {
        return {
          allowed: false,
          code: "proxy_not_allowed",
          message: `${service} proxy is not granted to this runtime token.`,
          checks: [...checks, { source: "token", outcome: "allow_miss" }],
        };
      }
      checks.push({ source: "token", outcome: "allow_match", rule: allowed.pattern });
    }

    return { allowed: true, checks };
  }

  evaluateTrigger(id: string): ActionPolicyDecision {
    const checks: PolicyCheck[] = [];
    for (const layer of this.proxyLayers) {
      const blocked = layer.blockedTriggers.find((rule) => rule.matches(id));
      if (blocked)
        return {
          allowed: false,
          code: "trigger_blocked",
          message: `${id} is blocked by the Trigger policy.`,
          checks: [{ source: layer.source, outcome: "block_match", rule: blocked.pattern }],
        };
    }
    for (const layer of this.proxyLayers) {
      const allowed = layer.allowedTriggers;
      if (allowed.length === 0) continue;
      const match = allowed.find((rule) => rule.matches(id));
      if (!match)
        return {
          allowed: false,
          code: "trigger_not_allowed",
          message: `${id} is not included in the Trigger allowlist.`,
          checks: [...checks, { source: layer.source, outcome: "allow_miss" }],
        };
      checks.push({ source: layer.source, outcome: "allow_match", rule: match.pattern });
    }
    if (this.tokenTriggerRules) {
      const match = this.tokenTriggerRules.find((rule) => rule.matches(id));
      if (!match)
        return {
          allowed: false,
          code: "trigger_not_allowed",
          message: `${id} is not granted to this runtime token.`,
          checks: [...checks, { source: "token", outcome: "allow_miss" }],
        };
      checks.push({ source: "token", outcome: "allow_match", rule: match.pattern });
    }
    return { allowed: true, checks };
  }

  evaluateConnection(connectionId?: string): ActionPolicyDecision {
    if (this.allowedConnections.length === 0) {
      return { allowed: true, checks: [] };
    }

    if (connectionId && this.allowedConnections.includes(connectionId)) {
      return {
        allowed: true,
        checks: [{ source: "token", outcome: "allow_match", rule: connectionId }],
      };
    }

    return {
      allowed: false,
      code: "connection_not_allowed",
      message: connectionId
        ? `${connectionId} connection is not granted to this runtime token.`
        : "The selected connection is not granted to this runtime token.",
      checks: [{ source: "token", outcome: "allow_miss" }],
    };
  }

  /**
   * Evaluates the approval overlay for one request after the allow/block policy and connection
   * grants pass, and before credential lookup. Mirrors the layered order: `approvalRequiredActions`,
   * a live grant claim, `approvalExemptActions`, `requireApprovalOperations`, then unrestricted
   * execution. The result attaches to the allowed decision as `policy.approval` on the run log.
   */
  async evaluateApproval(
    action: ApprovalEvaluationTarget,
    grantLookup: ApprovalGrantLookup = emptyApprovalGrantLookup,
  ): Promise<ApprovalCheck> {
    for (const layer of this.approvalLayers) {
      const required = layer.requiredActions.find((rule) => rule.matches(action.id));
      if (required) {
        return { outcome: "approval_required", source: layer.source, rule: required.pattern };
      }
    }
    const grant = await grantLookup.claimGrant({
      actionId: action.id,
      operationType: action.operationType,
      connectionId: action.connectionId,
    });
    if (grant) {
      return { outcome: "grant", source: "grant", grantId: grant.id };
    }
    for (const layer of this.approvalLayers) {
      const exempt = layer.exemptActions.find((rule) => rule.matches(action.id));
      if (exempt) {
        return { outcome: "execute", source: layer.source, rule: exempt.pattern };
      }
    }
    for (const layer of this.approvalLayers) {
      if (layer.requiredOperations.has(action.operationType)) {
        return { outcome: "approval_required", source: layer.source, rule: action.operationType };
      }
    }
    return { outcome: "execute", source: "default" };
  }
}

/**
 * Deployment execution policy used to construct request-scoped policy snapshots.
 */
export class ActionPolicyService {
  readonly rules: PolicyRules;

  constructor(config: ActionPolicyConfig = {}) {
    this.rules = policyRules(config);
  }

  createSnapshot(
    runtime: PolicyRules = emptyPolicyRules(),
    token?: TokenPolicy,
    updatedAt?: string,
  ): ActionPolicySnapshot {
    return new ActionPolicySnapshot(this.rules, runtime, token, updatedAt);
  }
}

export function emptyPolicyRules(): PolicyRules {
  return {
    allowedActions: [],
    blockedActions: [],
    allowedProxies: [],
    blockedProxies: [],
    allowedTriggers: [],
    blockedTriggers: [],
    requireApprovalOperations: [],
    approvalRequiredActions: [],
    approvalExemptActions: [],
  };
}

export function parseActionPolicyList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Maps a provider proxy request's HTTP method onto its approval operation type. */
export function proxyOperationType(method: string): ActionOperationType {
  const normalized = method.trim().toUpperCase();
  if (normalized === "GET" || normalized === "HEAD") {
    return "read";
  }
  return normalized === "DELETE" ? "destructive" : "write";
}

/** Parses a comma-separated deployment list of approval operation types; unrecognized entries are ignored. */
export function parseApprovalOperationList(value: string | undefined): ActionOperationType[] {
  const operations: ActionOperationType[] = [];
  for (const entry of parseActionPolicyList(value)) {
    if (entry === "read" || entry === "write" || entry === "destructive") {
      if (!operations.includes(entry)) {
        operations.push(entry);
      }
    }
  }
  return operations;
}

function policyRules(config: ActionPolicyConfig): PolicyRules {
  return immutablePolicyRules({
    allowedActions: config.allowedActions ?? [],
    blockedActions: config.blockedActions ?? [],
    allowedProxies: config.allowedProxies ?? [],
    blockedProxies: config.blockedProxies ?? [],
    allowedTriggers: config.allowedTriggers ?? [],
    blockedTriggers: config.blockedTriggers ?? [],
    requireApprovalOperations: config.requireApprovalOperations ?? [],
    approvalRequiredActions: config.approvalRequiredActions ?? [],
    approvalExemptActions: config.approvalExemptActions ?? [],
  });
}

function immutablePolicyRules(rules: PolicyRules): PolicyRules {
  const immutable = {
    allowedActions: [...rules.allowedActions],
    blockedActions: [...rules.blockedActions],
    allowedProxies: [...rules.allowedProxies],
    blockedProxies: [...rules.blockedProxies],
    allowedTriggers: [...(rules.allowedTriggers ?? [])],
    blockedTriggers: [...(rules.blockedTriggers ?? [])],
    requireApprovalOperations: [...(rules.requireApprovalOperations ?? [])],
    approvalRequiredActions: [...(rules.approvalRequiredActions ?? [])],
    approvalExemptActions: [...(rules.approvalExemptActions ?? [])],
  };
  Object.freeze(immutable.allowedActions);
  Object.freeze(immutable.blockedActions);
  Object.freeze(immutable.allowedProxies);
  Object.freeze(immutable.blockedProxies);
  Object.freeze(immutable.allowedTriggers);
  Object.freeze(immutable.blockedTriggers);
  Object.freeze(immutable.requireApprovalOperations);
  Object.freeze(immutable.approvalRequiredActions);
  Object.freeze(immutable.approvalExemptActions);
  return Object.freeze(immutable);
}

function compileLayer(source: PolicySource, rules: PolicyRules): CompiledLayer {
  return {
    source,
    allowedActions: rules.allowedActions.map(compileActionRule),
    blockedActions: rules.blockedActions.map(compileActionRule),
    allowedProxies: rules.allowedProxies.map(compileProxyRule),
    blockedProxies: rules.blockedProxies.map(compileProxyRule),
    allowedTriggers: (rules.allowedTriggers ?? []).map(compileActionRule),
    blockedTriggers: (rules.blockedTriggers ?? []).map(compileActionRule),
  };
}

function compileApprovalLayer(source: PolicySource, rules: PolicyRules): CompiledApprovalLayer {
  return {
    source,
    requiredActions: (rules.approvalRequiredActions ?? []).map(compileActionRule),
    exemptActions: (rules.approvalExemptActions ?? []).map(compileActionRule),
    requiredOperations: new Set(rules.requireApprovalOperations ?? []),
  };
}

/** Token policy can widen approval requirements but never exempt, so it carries no exempt list. */
function compileTokenApprovalLayer(token: TokenPolicy): CompiledApprovalLayer {
  return {
    source: "token",
    requiredActions: (token.approvalRequiredActions ?? []).map(compileActionRule),
    exemptActions: [],
    requiredOperations: new Set(token.requireApprovalOperations ?? []),
  };
}

function compileActionRule(pattern: string): CompiledRule {
  if (pattern === "*") {
    return { pattern, matches: () => true };
  }
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -1);
    return { pattern, matches: (actionId) => actionId.startsWith(prefix) };
  }
  return { pattern, matches: (actionId) => actionId === pattern };
}

function compileProxyRule(pattern: string): CompiledRule {
  return { pattern, matches: pattern === "*" ? () => true : (service) => service === pattern };
}
