import type { ProviderDefinition } from "../../core/types.ts";

import { pactActions } from "./actions.ts";

/**
 * PACT 1.0 Brand connections (spec §4.4). Catalog-only provider: connections
 * are created through `POST /v1/connections/pact/connect` (identity connect),
 * never the OAuth authorization flow — the oauth2 declaration marks the
 * connection's auth type and its clientSetup documents the real flow.
 */
export const provider: ProviderDefinition = {
  service: "pact",
  displayName: "PACT",
  categories: ["Identity", "Security"],
  authTypes: ["oauth2"],
  auth: [
    {
      type: "oauth2",
      authorizationUrl: "https://pact.invalid/oauth2/authorize",
      tokenUrl: "https://pact.invalid/oauth2/token",
      tokenEndpointAuthMethod: "none",
      scopes: [],
      clientSetup: {
        docsUrl: "https://github.com/openpactprotocol/openpactprotocol",
        steps: [
          "PACT Brand connections do not use the OAuth authorization flow.",
          "POST /v1/connections/pact/connect with {connectionName, agentCardUrl, scopes?} after registering the Brand's provider origin under /api/pact/registrations.",
          "The connect call fetches the agent card, validates the HTTP+JSON/1.0 interface and the Bearer JWT requirement, and stores an identity-only connection.",
        ],
      },
    },
  ],
  homepageUrl: "https://github.com/openpactprotocol/openpactprotocol",
  actions: pactActions,
};
