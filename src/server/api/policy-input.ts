import type { PolicyRules, TokenPolicy } from "../../core/action-policy.ts";
import type { ActionOperationType } from "../../core/types.ts";
import type { JsonRequestBody } from "./http-utils.ts";

import { Buffer } from "node:buffer";
import { requiredStringArray } from "../../core/cast.ts";
import { HttpRequestError } from "./http-utils.ts";

export const policyRequestMaxBytes: number = 256 * 1024;
export const policyRuleMaxBytes: number = 256;
export const policyRuleListMaxItems: number = 128;

export function readRuntimePolicyRules(body: JsonRequestBody): PolicyRules {
  return {
    allowedActions: readRules(body.allowedActions, "allowedActions", "action"),
    blockedActions: readRules(body.blockedActions, "blockedActions", "action"),
    allowedProxies: readRules(body.allowedProxies, "allowedProxies", "proxy"),
    blockedProxies: readRules(body.blockedProxies, "blockedProxies", "proxy"),
    allowedTriggers: readRules(body.allowedTriggers, "allowedTriggers", "action", true),
    blockedTriggers: readRules(body.blockedTriggers, "blockedTriggers", "action", true),
    requireApprovalOperations: readApprovalOperations(body.requireApprovalOperations, "requireApprovalOperations"),
    approvalRequiredActions: readOptionalRules(body.approvalRequiredActions, "approvalRequiredActions"),
    approvalExemptActions: readOptionalRules(body.approvalExemptActions, "approvalExemptActions"),
  };
}

export function readTokenPolicy(body: JsonRequestBody, allowOmitted = false): TokenPolicy {
  if (body.blockedTriggers !== undefined) {
    throw invalidInput("Token policy does not support Trigger block rules.");
  }
  if (body.blockedProxies !== undefined) {
    throw invalidInput("Token policy does not support proxy block rules.");
  }
  if (body.approvalExemptActions !== undefined) {
    throw invalidInput("Token policy does not support approval exemption rules.");
  }
  return {
    allowedActions: readRules(body.allowedActions, "allowedActions", "action", allowOmitted),
    blockedActions: readRules(body.blockedActions, "blockedActions", "action", allowOmitted),
    allowedProxies: readRules(body.allowedProxies, "allowedProxies", "proxy", allowOmitted),
    allowedTriggers: readRules(body.allowedTriggers, "allowedTriggers", "action", true),
    allowedConnections: readConnectionIds(body.allowedConnections, "allowedConnections", allowOmitted),
    requireApprovalOperations: readApprovalOperations(body.requireApprovalOperations, "requireApprovalOperations"),
    approvalRequiredActions: readOptionalRules(body.approvalRequiredActions, "approvalRequiredActions"),
  };
}

function readOptionalRules(value: unknown, fieldName: string): string[] | undefined {
  return value === undefined ? undefined : readRules(value, fieldName, "action");
}

function readApprovalOperations(value: unknown, fieldName: string): ActionOperationType[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const values = requiredStringArray(value, fieldName, invalidInput);
  const operations: ActionOperationType[] = [];
  for (const item of values) {
    const operation = item.trim();
    if (!isApprovalOperation(operation)) {
      throw invalidInput(`${fieldName} only accepts read, write, and destructive.`);
    }
    if (!operations.includes(operation)) {
      operations.push(operation);
    }
  }
  return operations;
}

function isApprovalOperation(value: string): value is ActionOperationType {
  return value === "read" || value === "write" || value === "destructive";
}

function readRules(value: unknown, fieldName: string, kind: "action" | "proxy", allowOmitted = false): string[] {
  if (value === undefined && allowOmitted) {
    return [];
  }
  const values = requiredStringArray(value, fieldName, invalidInput);
  const rules: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const rule = value.trim();
    if (!rule) {
      throw invalidInput(`${fieldName} must not contain empty rules.`);
    }
    if (Buffer.byteLength(rule, "utf8") > policyRuleMaxBytes) {
      throw invalidInput(`${fieldName} rules must not exceed ${policyRuleMaxBytes} UTF-8 bytes.`);
    }
    assertRuleSyntax(rule, fieldName, kind);
    if (!seen.has(rule)) {
      seen.add(rule);
      rules.push(rule);
    }
  }
  if (rules.length > policyRuleListMaxItems) {
    throw invalidInput(`${fieldName} must not contain more than ${policyRuleListMaxItems} rules.`);
  }
  return rules;
}

function readConnectionIds(value: unknown, fieldName: string, allowOmitted = false): string[] {
  if (value === undefined && allowOmitted) {
    return [];
  }
  const values = requiredStringArray(value, fieldName, invalidInput);
  const connectionIds: string[] = [];
  const seen = new Set<string>();
  for (const item of values) {
    const connectionId = item.trim();
    if (!connectionId) {
      throw invalidInput(`${fieldName} must not contain empty connection IDs.`);
    }
    if (Buffer.byteLength(connectionId, "utf8") > policyRuleMaxBytes) {
      throw invalidInput(`${fieldName} IDs must not exceed ${policyRuleMaxBytes} UTF-8 bytes.`);
    }
    if (!seen.has(connectionId)) {
      seen.add(connectionId);
      connectionIds.push(connectionId);
    }
  }
  if (connectionIds.length > policyRuleListMaxItems) {
    throw invalidInput(`${fieldName} must not contain more than ${policyRuleListMaxItems} rules.`);
  }
  return connectionIds;
}

function assertRuleSyntax(rule: string, fieldName: string, kind: "action" | "proxy"): void {
  if (rule === "*") {
    return;
  }
  if (kind === "proxy") {
    if (rule.includes("*") || /\s/.test(rule)) {
      throw invalidInput(`${fieldName} contains an invalid proxy rule: ${rule}.`);
    }
    return;
  }
  if (/^[^\s.*]+\.\*$/.test(rule)) {
    return;
  }
  const separator = rule.indexOf(".");
  if (rule.includes("*") || /\s/.test(rule) || separator <= 0 || separator === rule.length - 1) {
    throw invalidInput(`${fieldName} contains an invalid action rule: ${rule}.`);
  }
}

function invalidInput(message: string): HttpRequestError {
  return new HttpRequestError("invalid_input", message);
}
