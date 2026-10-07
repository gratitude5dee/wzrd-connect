// PACT Brand chat: connect a Brand, send a message, ride through both HTTP 202
// pauses (admin approval and Brand consent), and print the run's receipts.
//
// Needs a local Connect started with OOMOL_CONNECT_PACT_ENABLED=true and a
// reachable PACT Brand — for example the OpenPACT reference Provider's Skyline
// demo (see docs/pact.md). Run it with:
//
//   PACT_AGENT_CARD_URL=http://localhost:3000/a2a/<brandId>/.well-known/agent-card.json \
//   OOMOL_CONNECT_ADMIN_TOKEN=<admin token> \
//   node examples/pact-brand-chat.ts
//
// Optional: OOMOL_CONNECT_BASE_URL (default http://localhost:3000),
// PACT_CONNECTION_NAME (default pact-brand-chat), PACT_MESSAGE, and PACT_SCOPES
// (comma-separated scope ids to request during connect, e.g.
// "flights:upcoming:read").

import { adminHeaders } from "./local-http/client.ts";

interface Envelope {
  success?: boolean;
  message?: string;
  data?: unknown;
  errorCode?: string | null;
  meta?: { executionId?: string };
}

const baseUrl = (process.env.OOMOL_CONNECT_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const cardUrl = process.env.PACT_AGENT_CARD_URL?.trim();
const connectionName = process.env.PACT_CONNECTION_NAME ?? "pact-brand-chat";
const message = process.env.PACT_MESSAGE ?? "Can you check my upcoming trips?";
const scopes = process.env.PACT_SCOPES?.split(",")
  .map((scope) => scope.trim())
  .filter(Boolean);

if (!cardUrl) {
  console.log(
    "Skipping: set PACT_AGENT_CARD_URL to a Brand agent card URL (and " +
      "OOMOL_CONNECT_ADMIN_TOKEN when the deployment requires it).",
  );
  process.exit(0);
}

interface CallResult {
  status: number;
  body: Envelope;
  retryAfterSeconds: number;
}

async function call(path: string, init: RequestInit = {}): Promise<CallResult> {
  const headers = new Headers(adminHeaders(init.headers as HeadersInit));
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as Envelope,
    retryAfterSeconds: Math.max(1, Number(response.headers.get("retry-after")) || 2),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ConsentView {
  connectionRequestId?: string;
  verificationUriComplete?: string;
  userCode?: string;
  missingScopes?: string[];
  contextId?: string;
  pollUrl?: string;
}

function describeConsent(consent: ConsentView): string {
  const scopes = consent.missingScopes?.length ? ` Missing scopes: ${consent.missingScopes.join(", ")}.` : "";
  const code = consent.userCode ? ` (code ${consent.userCode})` : "";
  return `Open this link so the person can consent on the Brand's page${code}:\n  ${consent.verificationUriComplete}${scopes}`;
}

async function pollConnectionRequest(id: string): Promise<void> {
  for (;;) {
    const { status, body, retryAfterSeconds } = await call(`/v1/connection-requests/${id}`);
    if (status === 200 && body.data && (body.data as { status?: string }).status === "connected") {
      return;
    }
    if (status === 202) {
      await sleep(retryAfterSeconds * 1000);
      continue;
    }
    throw new Error(`Connection request ${id} ended: ${body.errorCode} ${body.message}`);
  }
}

async function pollApproval(approvalId: string, pollUrl: string): Promise<Envelope> {
  for (;;) {
    const { status, body, retryAfterSeconds } = await call(pollUrl);
    if (status === 202 || status === 429) {
      console.log(`  approval ${approvalId} still pending…`);
      await sleep(retryAfterSeconds * 1000);
      continue;
    }
    return body;
  }
}

async function sendMessage(contextId?: string): Promise<Envelope> {
  const { body } = await call(`/v1/actions/pact.send_message`, {
    method: "POST",
    headers: { "x-oo-connector-alias": connectionName },
    body: JSON.stringify({ input: { text: message, ...(contextId ? { contextId } : {}) } }),
  });
  return body;
}

async function driveSend(contextId?: string): Promise<Envelope> {
  // One loop covers both pause encodings: retry the same message after a
  // committed consent, keep the same contextId on PACT step-ups.
  let currentContext = contextId;
  for (;;) {
    const result = await sendMessage(currentContext);
    if (result.errorCode === "approval_required") {
      const approval = result.data as { approvalId?: string; approvalUrl?: string; pollUrl?: string };
      console.log(`Action is waiting for an admin's approval:\n  ${approval.approvalUrl}`);
      const decided = await pollApproval(String(approval.approvalId), String(approval.pollUrl));
      if (decided.success) return decided;
      throw new Error(`Approval ${approval.approvalId} ended: ${decided.errorCode} ${decided.message}`);
    }
    if (result.errorCode === "pact_consent_required") {
      const consent = (result.data as { details?: ConsentView } | undefined)?.details ?? (result.data as ConsentView);
      console.log(describeConsent(consent));
      await pollConnectionRequest(String(consent.connectionRequestId));
      console.log("Consent granted — retrying the message.");
      currentContext = consent.contextId ?? currentContext;
      continue;
    }
    return result;
  }
}

// Preflight: is PACT enabled and does an identity exist?
const identity = await call("/api/pact/identity");
if (identity.status === 404) {
  console.log(
    "Skipping: this Connect has no PACT surface. Start it with " +
      "OOMOL_CONNECT_PACT_ENABLED=true and create the identity in the Console " +
      "PACT page (or POST /api/pact/identity) first.",
  );
  process.exit(0);
}
if (identity.status !== 200) {
  console.log(`Skipping: GET /api/pact/identity answered HTTP ${identity.status}.`);
  process.exit(0);
}

// 1. Connect the Brand (identity-only, or straight into the device flow when
// PACT_SCOPES is set).
const connected = await call("/v1/connections/pact/connect", {
  method: "POST",
  body: JSON.stringify({ connectionName, agentCardUrl: cardUrl, ...(scopes?.length ? { scopes } : {}) }),
});
if (connected.status === 202 && connected.body.errorCode === "pact_consent_required") {
  const consent = connected.body.data as ConsentView;
  console.log(describeConsent(consent));
  await pollConnectionRequest(String(consent.connectionRequestId));
  console.log(`Brand connected as "${connectionName}" with a delegation grant.`);
} else if (!connected.body.success) {
  throw new Error(`Connect failed: ${connected.body.errorCode} ${connected.body.message}`);
} else {
  console.log(`Brand connected as "${connectionName}" (identity only).`);
}

// 2. Send the message, riding through approval and consent pauses.
const reply = await driveSend();
if (!reply.success) {
  throw new Error(`send_message failed: ${reply.errorCode} ${reply.message}`);
}
const output = reply.data as { text?: string; contextId?: string };
console.log(`Brand reply: ${output.text}`);

// 3. Print the run's receipts.
const executionId = reply.meta?.executionId;
if (!executionId) {
  console.log("No executionId in the response meta; skipping receipt fetch.");
} else {
  const { body } = await call(`/v1/runs/${executionId}/receipt`);
  const receipt = body.data as {
    receipt?: string;
    providerReceipt?: { verified?: boolean; claims?: Record<string, unknown>; failureReason?: string };
  };
  const claims = receipt?.receipt
    ? (JSON.parse(
        new TextDecoder().decode(Uint8Array.from(atob(receipt.receipt.split(".")[1]), (c) => c.charCodeAt(0))),
      ) as Record<string, unknown>)
    : undefined;
  console.log("Custodian receipt claims:", JSON.stringify(claims, null, 2));
  const provider = receipt?.providerReceipt;
  console.log(
    provider?.verified === undefined
      ? "Provider receipt: none."
      : `Provider receipt verified: ${provider.verified}` +
          (provider.failureReason ? ` (${provider.failureReason})` : ""),
  );
}
