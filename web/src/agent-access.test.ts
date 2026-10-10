import type { ConnectionRecord, ProviderDefinition, RuntimePolicyState, RuntimeTokenSummary } from "./model";

import { describe, expect, it } from "vitest";
import {
  buildAgentAccess,
  compactActionRules,
  resetAgentAction,
  runtimeRulesBlockingAction,
  setAgentActionAllowed,
  tokenPolicyRules,
} from "./agent-access";

const githubId = "11111111-1111-4111-8111-111111111111";
const slackId = "22222222-2222-4222-8222-222222222222";

const providers: ProviderDefinition[] = [
  {
    service: "github",
    displayName: "GitHub",
    categories: [],
    authTypes: [],
    auth: [],
    actions: [
      {
        id: "github.create_issue",
        service: "github",
        name: "create_issue",
        description: "Create an issue",
        requiredScopes: [],
        execution: {
          locallyExecutable: true,
          catalogOnly: false,
          requiredAuthTypes: [],
          noAuthRunnable: true,
          needsCredential: false,
        },
      },
      {
        id: "github.delete_repository",
        service: "github",
        name: "delete_repository",
        description: "Delete a repository",
        requiredScopes: [],
        execution: {
          locallyExecutable: true,
          catalogOnly: false,
          requiredAuthTypes: [],
          noAuthRunnable: true,
          needsCredential: false,
        },
      },
    ],
  },
  {
    service: "slack",
    displayName: "Slack",
    categories: [],
    authTypes: [],
    auth: [],
    actions: [
      {
        id: "slack.send_message",
        service: "slack",
        name: "send_message",
        description: "Send a message",
        requiredScopes: [],
        execution: {
          locallyExecutable: true,
          catalogOnly: false,
          requiredAuthTypes: [],
          noAuthRunnable: true,
          needsCredential: false,
        },
      },
    ],
  },
];

const connections: ConnectionRecord[] = [
  { id: githubId, service: "github", connectionName: "work", authType: "oauth2", metadata: {} },
  { id: slackId, service: "slack", connectionName: "default", authType: "oauth2", metadata: {} },
];

const policy: RuntimePolicyState = {
  deployment: {
    allowedActions: [],
    blockedActions: ["github.delete_repository"],
    allowedProxies: [],
    blockedProxies: [],
  },
  runtime: { allowedActions: [], blockedActions: [], allowedProxies: [], blockedProxies: [] },
};

function token(overrides: Partial<RuntimeTokenSummary> = {}): RuntimeTokenSummary {
  return {
    id: "token-1",
    name: "bot",
    allowedActions: [],
    blockedActions: [],
    allowedProxies: [],
    allowedConnections: [],
    createdAt: "2026-07-20T00:00:00.000Z",
    ...overrides,
  };
}

function patchFor(value: RuntimeTokenSummary) {
  return { rules: tokenPolicyRules(value), allowedConnections: [...value.allowedConnections] };
}

describe("buildAgentAccess", () => {
  it("marks default-on, policy-blocked, and token-overridden rows", () => {
    const model = buildAgentAccess({
      token: token({ blockedActions: ["github.create_issue"] }),
      rules: tokenPolicyRules(token({ blockedActions: ["github.create_issue"] })),
      allowedConnections: [],
      policy,
      providers,
      connections,
    });
    const github = model.folds.find((fold) => fold.service === "github");
    expect(github?.changed).toBe(1);
    const create = github?.rows.find((row) => row.action.id === "github.create_issue");
    const remove = github?.rows.find((row) => row.action.id === "github.delete_repository");
    expect(create).toMatchObject({ defaultAllowed: true, effectiveAllowed: false, overridden: true });
    expect(remove).toMatchObject({ defaultAllowed: false, effectiveAllowed: false, overridden: false });
    expect(model.changed).toBe(1);
  });

  it("counts connection gating as changed rows", () => {
    const value = token({ allowedConnections: [slackId] });
    const model = buildAgentAccess({
      token: value,
      rules: tokenPolicyRules(value),
      allowedConnections: [...value.allowedConnections],
      policy,
      providers,
      connections,
    });
    const github = model.folds.find((fold) => fold.service === "github");
    expect(github?.connectionAllowed).toBe(false);
    expect(github?.changed).toBe(1);
  });
});

describe("setAgentActionAllowed", () => {
  it("blocks an allowed action with an exact rule", () => {
    const next = setAgentActionAllowed({
      patch: patchFor(token()),
      action: providers[0].actions[0],
      connectionId: githubId,
      allowed: false,
      providers,
    });
    expect(next.rules.blockedActions).toEqual(["github.create_issue"]);
  });

  it("expands a covering glob when unblocking a single action", () => {
    const value = token({ blockedActions: ["github.*"] });
    const next = setAgentActionAllowed({
      patch: patchFor(value),
      action: providers[0].actions[0],
      connectionId: githubId,
      allowed: true,
      providers,
    });
    expect(next.rules.blockedActions).toEqual(["github.delete_repository"]);
  });

  it("re-covers an action when the token uses an allow list", () => {
    const value = token({ allowedActions: ["slack.*"], blockedActions: ["github.create_issue"] });
    const next = setAgentActionAllowed({
      patch: patchFor(value),
      action: providers[0].actions[0],
      connectionId: githubId,
      allowed: true,
      providers,
    });
    expect(next.rules.blockedActions).toEqual([]);
    expect(next.rules.allowedActions).toEqual(["slack.*", "github.create_issue"]);
  });

  it("grants a gated connection when enabling its action", () => {
    const value = token({ allowedConnections: [slackId], blockedActions: ["slack.send_message"] });
    const next = setAgentActionAllowed({
      patch: patchFor(value),
      action: providers[1].actions[0],
      connectionId: slackId,
      allowed: true,
      providers,
    });
    expect(next.rules.blockedActions).toEqual([]);
    expect(next.allowedConnections).toEqual([slackId]);
  });
});

describe("resetAgentAction", () => {
  it("clears token coverage so the action follows the default", () => {
    const value = token({ blockedActions: ["github.*"] });
    const next = resetAgentAction({ patch: patchFor(value), action: providers[0].actions[1], providers });
    expect(next.rules.blockedActions).toEqual(["github.create_issue"]);
  });

  it("keeps a restricted connection grant list unchanged", () => {
    const value = token({ allowedConnections: [slackId], blockedActions: ["github.create_issue"] });
    const next = resetAgentAction({ patch: patchFor(value), action: providers[0].actions[0], providers });
    expect(next.allowedConnections).toEqual([slackId]);
    expect(next.allowedConnections).not.toContain("");
  });
});

describe("runtimeRulesBlockingAction", () => {
  it("strips allow-list coverage and adds the block", () => {
    const runtime = { allowedActions: ["github.*"], blockedActions: [], allowedProxies: [], blockedProxies: [] };
    const next = runtimeRulesBlockingAction(runtime, "github.delete_repository", providers);
    expect(next.allowedActions).toEqual(["github.create_issue"]);
    expect(next.blockedActions).toEqual(["github.delete_repository"]);
  });
});

describe("compactActionRules", () => {
  it("folds full-service coverage into a glob", () => {
    expect(
      compactActionRules(["github.create_issue", "github.delete_repository", "slack.send_message"], providers),
    ).toEqual(["github.*", "slack.*"]);
  });
});
