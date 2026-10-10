import type {
  ActionDefinition,
  ConnectionRecord,
  PolicyRules,
  ProviderDefinition,
  RuntimePolicyState,
  RuntimeTokenSummary,
} from "./model";

import { connectionGrantOptions } from "./access-editors";
import { evaluatePolicy, matchesActionRule, policyLayers } from "./policy";

export interface AgentAccessRow {
  action: ActionDefinition;
  /** Allowed by the deployment + runtime default layers alone. */
  defaultAllowed: boolean;
  /** Allowed once the agent's token rules are applied. */
  effectiveAllowed: boolean;
  /** Effective state differs from the default — the visible "Changed" marker. */
  overridden: boolean;
  /** Covered by an approval-required rule in any policy layer. */
  highRisk: boolean;
}

export interface AgentAccessFold {
  connectionId: string;
  connectionName: string;
  service: string;
  provider?: ProviderDefinition;
  connectionAllowed: boolean;
  rows: AgentAccessRow[];
  changed: number;
}

export interface AgentAccessModel {
  folds: AgentAccessFold[];
  changed: number;
}

/** The token layer expressed as the PolicyRules shape the editors and PUT body share. */
export function tokenPolicyRules(token: RuntimeTokenSummary): PolicyRules {
  return {
    allowedActions: [...token.allowedActions],
    blockedActions: [...token.blockedActions],
    allowedProxies: [...token.allowedProxies],
    blockedProxies: [],
    allowedTriggers: [...(token.allowedTriggers ?? [])],
    blockedTriggers: [],
    requireApprovalOperations: [...(token.requireApprovalOperations ?? [])],
    approvalRequiredActions: [...(token.approvalRequiredActions ?? [])],
    approvalExemptActions: [],
  };
}

export interface AgentAccessSource {
  token: RuntimeTokenSummary;
  /** Working copy of the token's rules; equals `tokenPolicyRules(token)` when clean. */
  rules: PolicyRules;
  allowedConnections: string[];
  policy: RuntimePolicyState;
  providers: ProviderDefinition[];
  connections: ConnectionRecord[];
}

/**
 * Groups the catalog actions of every usable connection into the folded rows the
 * editor renders. The deployment + runtime layers form the "default"; the token
 * layer may only narrow it, so an override is always a default-on action the
 * token turns off (or a connection the token may not use).
 */
export function buildAgentAccess(source: AgentAccessSource): AgentAccessModel {
  const defaultLayers = policyLayers(source.policy);
  const tokenLayers = policyLayers(source.policy, {
    ...source.token,
    allowedActions: source.rules.allowedActions,
    blockedActions: source.rules.blockedActions,
    requireApprovalOperations: source.rules.requireApprovalOperations,
    approvalRequiredActions: source.rules.approvalRequiredActions,
  });
  const approvalRules = tokenLayers.flatMap((layer) => layer.rules.approvalRequiredActions ?? []);
  const providers = new Map(source.providers.map((provider) => [provider.service, provider]));
  const connections = new Map(source.connections.map((connection) => [connection.id, connection]));
  const folds: AgentAccessFold[] = [];

  for (const option of connectionGrantOptions(source.connections, source.providers)) {
    const connection = connections.get(option.id);
    const provider = connection ? providers.get(connection.service) : undefined;
    if (!connection || !connection.id || !provider) {
      continue;
    }
    const connectionAllowed =
      source.allowedConnections.length === 0 || source.allowedConnections.includes(connection.id);
    const rows = provider.actions.map((action) => {
      const defaultAllowed = evaluatePolicy(action.id, "action", defaultLayers).allowed;
      const effectiveAllowed = connectionAllowed && evaluatePolicy(action.id, "action", tokenLayers).allowed;
      return {
        action,
        defaultAllowed,
        effectiveAllowed,
        overridden: defaultAllowed && !effectiveAllowed,
        highRisk: approvalRules.some((rule) => matchesActionRule(rule, action.id)),
      };
    });
    folds.push({
      connectionId: connection.id,
      connectionName: connection.connectionName ?? option.name,
      service: provider.service,
      provider,
      connectionAllowed,
      rows,
      changed: rows.filter((row) => row.overridden).length,
    });
  }

  return { folds, changed: folds.reduce((count, fold) => count + fold.changed, 0) };
}

export interface AgentAccessPatch {
  rules: PolicyRules;
  allowedConnections: string[];
}

/**
 * Applies one checkbox toggle to the token's rules. Token rules only narrow the
 * default: turning an action off blocks it (blocks win over allows inside the
 * same layer), turning it back on removes the block and re-covers it when the
 * token runs an allow list.
 */
export function setAgentActionAllowed(options: {
  patch: AgentAccessPatch;
  action: ActionDefinition;
  connectionId: string;
  allowed: boolean;
  providers: ProviderDefinition[];
}): AgentAccessPatch {
  const rules = {
    ...options.patch.rules,
    allowedActions: [...options.patch.rules.allowedActions],
    blockedActions: [...options.patch.rules.blockedActions],
  };
  let allowedConnections = options.patch.allowedConnections;
  if (options.allowed) {
    rules.blockedActions = removeActionCoverage(rules.blockedActions, options.action.id, options.providers);
    const covered = rules.allowedActions.some((rule) => matchesActionRule(rule, options.action.id));
    if (rules.allowedActions.length > 0 && !covered) {
      rules.allowedActions = compactActionRules([...rules.allowedActions, options.action.id], options.providers);
    }
    if (options.connectionId && allowedConnections.length > 0 && !allowedConnections.includes(options.connectionId)) {
      allowedConnections = [...allowedConnections, options.connectionId];
    }
  } else if (!rules.blockedActions.some((rule) => matchesActionRule(rule, options.action.id))) {
    rules.blockedActions = [...rules.blockedActions, options.action.id];
  }
  return { rules, allowedConnections };
}

/** Clears every token rule that touches the action so it follows the default again. */
export function resetAgentAction(options: {
  patch: AgentAccessPatch;
  action: ActionDefinition;
  providers: ProviderDefinition[];
}): AgentAccessPatch {
  return setAgentActionAllowed({
    patch: options.patch,
    action: options.action,
    connectionId: "",
    allowed: true,
    providers: options.providers,
  });
}

/**
 * Returns the runtime layer updated so the action is denied by default: its
 * coverage is stripped from the allow list and it is added to the block list.
 */
export function runtimeRulesBlockingAction(
  runtime: PolicyRules,
  actionId: string,
  providers: ProviderDefinition[],
): PolicyRules {
  return {
    ...runtime,
    allowedActions: removeActionCoverage(runtime.allowedActions, actionId, providers),
    blockedActions: runtime.blockedActions.some((rule) => matchesActionRule(rule, actionId))
      ? runtime.blockedActions
      : [...runtime.blockedActions, actionId],
  };
}

/**
 * Returns the runtime layer updated so the action is allowed by default again:
 * its coverage is stripped from the block list and it is re-covered when the
 * runtime layer runs an allow list.
 */
export function runtimeRulesAllowingAction(
  runtime: PolicyRules,
  actionId: string,
  providers: ProviderDefinition[],
): PolicyRules {
  const covered = runtime.allowedActions.some((rule) => matchesActionRule(rule, actionId));
  return {
    ...runtime,
    allowedActions:
      runtime.allowedActions.length > 0 && !covered
        ? compactActionRules([...runtime.allowedActions, actionId], providers)
        : runtime.allowedActions,
    blockedActions: removeActionCoverage(runtime.blockedActions, actionId, providers),
  };
}

/** Tokens whose connection grant lets them reach this connection. */
export function tokensCoveringConnection(
  connection: ConnectionRecord,
  tokens: RuntimeTokenSummary[],
): RuntimeTokenSummary[] {
  return tokens.filter(
    (token) =>
      connection.id != null &&
      (token.allowedConnections.length === 0 || token.allowedConnections.includes(connection.id)),
  );
}

export interface ConnectionAccessRow {
  action: ActionDefinition;
  /** Allowed by the deployment + runtime default layers alone. */
  defaultAllowed: boolean;
  /** The deployment layer denies the action — the runtime toggle cannot re-allow it. */
  deploymentBlocked: boolean;
  /** Covered by an approval-required rule in a default layer. */
  highRisk: boolean;
  /** Agents whose effective access differs from the default. */
  changedAgents: number;
}

/**
 * Per-action default state for one connection's service, plus how many agents
 * diverge from it — the rows the connection detail's Permissions section renders.
 */
export function buildConnectionAccess(options: {
  connection: ConnectionRecord;
  provider: ProviderDefinition;
  policy: RuntimePolicyState;
  tokens: RuntimeTokenSummary[];
}): ConnectionAccessRow[] {
  const defaultLayers = policyLayers(options.policy);
  const deploymentLayers = defaultLayers.filter((layer) => layer.source === "deployment");
  const approvalRules = defaultLayers.flatMap((layer) => layer.rules.approvalRequiredActions ?? []);
  const tokenEntries = options.tokens.map((token) => ({
    layers: policyLayers(options.policy, token),
    connectionAllowed:
      options.connection.id != null &&
      (token.allowedConnections.length === 0 || token.allowedConnections.includes(options.connection.id)),
  }));
  return options.provider.actions.map((action) => {
    const defaultAllowed = evaluatePolicy(action.id, "action", defaultLayers).allowed;
    const changedAgents = tokenEntries.filter(
      (entry) =>
        defaultAllowed && !(entry.connectionAllowed && evaluatePolicy(action.id, "action", entry.layers).allowed),
    ).length;
    return {
      action,
      defaultAllowed,
      deploymentBlocked: !evaluatePolicy(action.id, "action", deploymentLayers).allowed,
      highRisk: approvalRules.some((rule) => matchesActionRule(rule, action.id)),
      changedAgents,
    };
  });
}

/** Names of the provider's actions the token can still run through its policy layers. */
export function agentConnectionActionNames(
  token: RuntimeTokenSummary,
  provider: ProviderDefinition,
  policy: RuntimePolicyState,
): string[] {
  const layers = policyLayers(policy, token);
  return provider.actions
    .filter((action) => evaluatePolicy(action.id, "action", layers).allowed)
    .map((action) => action.name);
}

/**
 * Removes whatever covers `actionId` from a rule list: exact entries drop out,
 * globs expand to the catalog ids they cover minus the freed one.
 */
function removeActionCoverage(rules: string[], actionId: string, providers: ProviderDefinition[]): string[] {
  const next: string[] = [];
  let touched = false;
  for (const rule of rules) {
    if (!matchesActionRule(rule, actionId)) {
      next.push(rule);
      continue;
    }
    touched = true;
    if (rule.includes("*")) {
      for (const provider of providers) {
        for (const action of provider.actions) {
          if (matchesActionRule(rule, action.id) && action.id !== actionId) {
            next.push(action.id);
          }
        }
      }
    }
  }
  return touched ? compactActionRules(next, providers) : rules;
}

/**
 * Re-folds a rule list into `service.*` globs where every catalog action of the
 * service is covered. Semantics-preserving; keeps the 128-rule cap reachable.
 */
export function compactActionRules(rules: string[], providers: ProviderDefinition[]): string[] {
  const exact = new Set(rules.filter((rule) => !rule.includes("*")));
  const globs = rules.filter((rule) => rule.includes("*") && rule !== "*");
  const compacted: string[] = rules.includes("*") ? ["*"] : [];
  for (const provider of providers) {
    const ids = provider.actions.map((action) => action.id);
    if (ids.length > 0 && ids.every((id) => exact.has(id))) {
      compacted.push(`${provider.service}.*`);
      for (const id of ids) {
        exact.delete(id);
      }
    }
  }
  return [...compacted, ...globs, ...[...exact].sort()];
}

/** How many of a token's usable connections it may reach, for the list page. */
export function agentConnectionCount(
  token: RuntimeTokenSummary,
  connections: ConnectionRecord[],
  providers: ProviderDefinition[],
): { allowed: number; total: number } {
  const usable = connectionGrantOptions(connections, providers);
  const allowed =
    token.allowedConnections.length === 0
      ? usable.length
      : usable.filter((option) => token.allowedConnections.includes(option.id)).length;
  return { allowed, total: usable.length };
}

/** Actions the token can actually reach: rows on its usable connections. */
export function agentActionCount(source: AgentAccessSource): { allowed: number; total: number } {
  const model = buildAgentAccess(source);
  let allowed = 0;
  let total = 0;
  for (const fold of model.folds) {
    if (!fold.connectionAllowed) {
      continue;
    }
    for (const row of fold.rows) {
      total += 1;
      if (row.effectiveAllowed) {
        allowed += 1;
      }
    }
  }
  return { allowed, total };
}
