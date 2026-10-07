import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "pact";

const contextIdInput = s.string({
  maxLength: 256,
  description:
    "Opaque provider-minted conversation state (≤256 bytes) from a previous reply; omit to start a new conversation.",
});
const contextIdOutput = s.string({
  description: "Opaque provider-minted conversation state to pass back on the next pact.send_message call.",
});
const skillsSchema = s.array(
  s.object(
    {
      id: s.string({ description: "Skill identifier." }),
      name: s.string({ description: "Skill display name." }),
      description: s.string({ description: "What the skill does." }),
      tags: s.array(s.string(), { description: "Skill tags." }),
    },
    { additionalProperties: true, description: "Advertised Brand skill." },
  ),
  { description: "Skills the Brand card advertises." },
);

export const pactActions: ActionDefinition[] = [
  defineProviderAction(service, {
    name: "get_agent_card",
    operationType: "read",
    description:
      "Re-fetch and re-validate the Brand's PACT agent card: name, interface URL, skills, and the delegation scopes it advertises.",
    requiredScopes: [],
    inputSchema: s.actionInput({}, []),
    outputSchema: s.object(
      {
        name: s.string({ description: "Brand display name." }),
        version: s.string({ description: "Card version." }),
        interfaceUrl: s.string({ description: "A2A interface URL selected by protocolBinding+version." }),
        providerOrigin: s.string({ description: "Provider origin this Brand registers under." }),
        skills: skillsSchema,
        delegation: s.object(
          {
            scopes: s.record(s.string(), { description: "Delegation scope ids to descriptions the card advertises." }),
          },
          { additionalProperties: true, description: "Device-flow delegation section, when the card offers one." },
        ),
      },
      { additionalProperties: true, description: "Validated agent card facts." },
    ),
  }),
  defineProviderAction(service, {
    name: "get_delegation",
    operationType: "read",
    description:
      "Read the connection's delegation grant state: identityOnly when no grant exists, or the grant id, scopes, and expiry.",
    requiredScopes: [],
    inputSchema: s.actionInput({}, []),
    outputSchema: s.object(
      {
        identityOnly: s.boolean({ description: "Whether the connection carries no delegation grant." }),
        grantId: s.string({ description: "Grant identifier minted by the delegation flow." }),
        grantedScopes: s.array(s.string(), { description: "Scopes the grant covers." }),
        expiresAt: s.string({ description: "Grant expiry (ISO 8601)." }),
      },
      { additionalProperties: true, description: "Delegation grant state." },
    ),
  }),
  defineProviderAction(service, {
    name: "send_message",
    operationType: "write",
    description:
      "Send a text message to the Brand's PACT agent (A2A message:send) and return its reply text plus conversation state.",
    requiredScopes: [],
    inputSchema: s.actionInput(
      { text: s.string({ minLength: 1, description: "Message text." }), contextId: contextIdInput },
      ["text"],
    ),
    outputSchema: s.object(
      {
        messageId: s.string({ description: "Reply message id (falls back to the execution id)." }),
        text: s.string({ description: "Reply text joined from the reply's text parts." }),
        contextId: contextIdOutput,
        taskId: s.string({ description: "Task id when the Brand answered with a task object." }),
        state: s.string({ description: "Task state when the Brand answered with a task object." }),
      },
      { additionalProperties: true, description: "PACT message:send reply." },
    ),
  }),
  defineProviderAction(service, {
    name: "request_scopes",
    operationType: "write",
    description:
      "Request delegation scopes on the connection. When the scopes are not yet granted the answer is pact_consent_required, which carries the missing scope ids for the step-up flow.",
    requiredScopes: [],
    inputSchema: s.actionInput(
      {
        scopes: s.array(s.string({ minLength: 1 }), {
          minItems: 1,
          description: "Delegation scope ids to request, as advertised by the agent card.",
        }),
      },
      ["scopes"],
    ),
    outputSchema: s.object(
      {
        grantedScopes: s.array(s.string(), { description: "Scopes the connection's grant already covers." }),
      },
      { additionalProperties: true, description: "Granted delegation scopes." },
    ),
  }),
];
