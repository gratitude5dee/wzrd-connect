# PACT identity and Brand registrations

OpenConnector can act as the custody and policy layer for a personal agent that
delegates to Brand runtimes with [PACT](https://github.com/Cognition-AI/pact) 1.0.
The surface is opt-in: nothing changes for a deployment until
`OOMOL_CONNECT_PACT_ENABLED=true` is set.

When enabled, Connect holds an ES256 (P-256) signing key pair for the deployment,
publishes the public half at `/.well-known/jwks.json`, and signs short-lived
Personal Agent JWTs (PA-JWTs) that Brand verifiers can check against that JWKS.
Brand registrations record which provider origins Connect trusts and which
audience PA-JWTs are minted for.

## Setup

```bash
OOMOL_CONNECT_PACT_ENABLED=true \
OOMOL_CONNECT_ORIGIN=https://connect.example.com \
OOMOL_CONNECT_ENCRYPTION_KEY=<secret> \
npm run dev
```

- `OOMOL_CONNECT_PACT_ENABLED` (default `false`) gates every PACT route.
- `OOMOL_CONNECT_ORIGIN` is the PA-JWT `iss` value; creating an identity without
  it fails.
- `OOMOL_CONNECT_ENCRYPTION_KEY` is required: the private key is stored encrypted
  with the same secret codec as provider credentials. Creating an identity
  without it returns `400 encryption_required`.
- `OOMOL_CONNECT_PACT_KEY_GRACE_SECONDS` (default `86400`) controls how long a
  rotated key stays in the JWKS so in-flight PA-JWTs keep verifying.
- `OOMOL_CONNECT_PACT_ALLOW_INSECURE_LOOPBACK` (default `false`) lets PACT egress
  reach `http://` loopback targets so a development Provider on `localhost`
  answers agent-card and `message:send` calls. Production deployments must keep
  it off: Brand egress is HTTPS-only and SSRF-guarded.

## Identity lifecycle

The Console **PACT** page (or the admin API) drives the lifecycle:

| Route                                        | Purpose                                                                                                                                               |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/pact/identity`                    | Generate the signing key pair and a stable deployment subject.                                                                                        |
| `GET /api/pact/identity`                     | Read issuer, `kid`, JWKS URL, timestamps, and subject status — never the private key.                                                                 |
| `POST /api/pact/identity/rotate`             | Rotate the key pair; the previous key stays in the JWKS for the grace window. The deployment subject is stable across rotation.                       |
| `POST /api/pact/identity/registration-token` | Mint a one-shot registration token for a Brand endpoint (`aud` = the endpoint URL, `sub` = `iss`, exp ≤ 300 s). It is returned once and never stored. |

Public endpoints:

- `GET /.well-known/jwks.json` — `{keys: [JWK]}`, `Cache-Control: public, max-age=300`.
- `GET /.well-known/openid-configuration` — `{issuer, jwks_uri}`.

## Brand registrations

`GET/POST /api/pact/registrations` and `PUT/DELETE /api/pact/registrations/:id`
manage the trusted Brand origins. Each row stores `provider_origin` (unique,
normalized to `scheme://host[:port]`), `audience`, `enabled`, and `notes`.
Registering a Brand later lets Connect verify its callbacks and mint PA-JWTs for
its audience.

## Brand connections

`POST /v1/connections/pact/connect` creates an identity-only Brand connection
(`source: "pact"`, `authType: "oauth2"`, `identityOnly: true`). The body carries
`connectionName` (the alias actions select with `x-oo-connector-alias`),
`agentCardUrl`, and an optional `scopes` list.

The connect call:

1. Resolves the card URL — a bare origin expands to
   `<origin>/.well-known/agent-card.json`. The fetch is HTTPS-only through the
   SSRF-guarded fetch (≤3 re-validated redirects, 64 KiB cap, 10 s timeout);
   `http://` loopback requires `OOMOL_CONNECT_PACT_ALLOW_INSECURE_LOOPBACK`.
2. Validates the card: an `HTTP+JSON`/`1.0` interface is selected by binding and
   version (never by position), and the `httpAuthSecurityScheme` Bearer-JWT
   scheme must appear alone in one `securityRequirements` entry.
3. Refuses when the card's `providerOrigin` has no **enabled** Brand
   registration — `409 pact_registration_required`.
4. Stores only the card facts (name, version, skills, `interfaceUrl`,
   `providerOrigin`, `registrationId`, grant scope list) plus the OAuth
   endpoints the card advertises (`deviceAuthorizationUrl`, `tokenUrl`,
   `oauth2MetadataUrl`). No tokens are persisted before consent.
5. When the request asks for scopes the card advertises, Connect starts the
   RFC 8628 device flow (next section) and answers `202 pact_consent_required`
   instead of a connection summary. Scope ids the card does not advertise are
   rejected with `400 invalid_scope`.

`POST /api/pact/brands/preview` `{agentCardUrl}` returns the same card plus the
matching registration state so the Console **PACT → Brands** dialog can offer
scope checkboxes before connect.

## Delegated authority (device flow)

A Brand connection becomes useful once the person delegates scopes to it.
Connect runs the Provider's RFC 8628 device-authorization flow; the person
always approves on the Brand's own page — Connect never proxies, frames, or
observes the Brand login.

1. **Start.** `POST <deviceAuthorizationUrl>` carries a fresh PA-JWT
   (`client_id` = the Connect issuer) and form body `client_id=<issuer>&scope=<ids>`.
   The pending request is stored as a `kind: "pact"` `connection_requests` row
   whose encrypted value holds the device code, poll interval, token URL,
   requested scopes, connection name, and (for step-ups) the A2A `contextId`.
2. **Answer.** The caller gets `202 pact_consent_required` with
   `connectionRequestId`, `verificationUri`/`verificationUriComplete`,
   `userCode`, `expiresAt`, `pollUrl` (`/v1/connection-requests/<id>`), and for
   step-ups `missingScopes` + `contextId`.
3. **Poll.** `GET /v1/connection-requests/:id` drives token-endpoint polling —
   at most one Provider call per advertised interval, enforced by an atomic
   `next_poll_at` claim in the store. `authorization_pending` and `slow_down`
   (interval +5 s) keep the request pending → `202` + `Retry-After`;
   `access_denied` → `403 pact_consent_denied`; `expired_token` →
   `410 pact_consent_expired`. Every Provider call sends a freshly minted
   PA-JWT.
4. **Commit.** The `access_token` is verified as a JWT before it is stored:
   RFC 8414 metadata → `jwks_uri` (cached per origin: 5 min positive / 60 s
   negative / one `kid`-miss refetch; ES256 or RS256 only), `aud` must equal
   the card's `interfaceUrl`, `client_id` must equal the Connect issuer, `exp`
   must be in the future. The response `scope` string is the granted subset —
   it is stored verbatim as `grantedScopes`, and `profile.accountId` records
   the token `sub`.
5. **Send.** `message:send` attaches `X-A2A-User-Delegation: Bearer <token>` to
   the exact interface origin only.
6. **Refresh.** When `expiresAt` is within 60 s, Connect redeems the
   `refresh_token` with a PA-JWT (`grant_type=refresh_token`). Refreshes are
   serialized per connection through a keyed in-flight map. `invalid_grant`
   clears both tokens, marks the connection `needsReauthorization`, and
   surfaces `401 pact_unauthorized` with a step-up payload.
7. **Step-up.** When `message:send` answers `TASK_STATE_AUTH_REQUIRED`, the
   service reads `pact.missingScopes` + `pact.verificationUriComplete` from the
   task, requests the union of missing and already-granted scopes, and returns
   the consent payload with the task's `contextId`. Retrying the same message
   after consent re-sends in the same context.

Disconnects attempt RFC 7009 revocation best-effort: when the Provider metadata
advertises `revocation_endpoint`, Connect posts the refresh token there (or the
access token as a fallback) and the disconnect answer reports `revoked:`
`done` | `failed` | `unsupported` | `skipped`.

The `pact` catalog provider carries four actions:

| Action                | Operation | Behavior                                                                                       |
| --------------------- | --------- | ---------------------------------------------------------------------------------------------- |
| `pact.get_agent_card` | `read`    | Returns the stored card summary.                                                               |
| `pact.get_delegation` | `read`    | Returns `{identityOnly, grantedScopes, expiresAt, needsReauthorization}` — never token values. |
| `pact.send_message`   | `write`   | POSTs `${interfaceUrl}/message:send` per Appendix A.                                           |
| `pact.request_scopes` | `write`   | Starts a device flow for additional scopes (step-up).                                          |

`pact.send_message` takes `input.text` (required) and optional
`input.contextId` (opaque, ≤256 UTF-8 bytes). The request headers are
`Authorization: Bearer <PA-JWT>`, `A2A-Version: 1.0`, and
`X-A2A-User-Delegation: Bearer <token>` when a delegation grant exists — the
header only ever posts to the exact interface origin. `messageId` is the
execution ID.

Response and error mapping:

- `{message}` replies → `{messageId, text, contextId}` where `text` joins the
  `text/plain` parts.
- `{task}` with `TASK_STATE_AUTH_REQUIRED` → step-up: the service starts a
  device flow for the union of `pact.missingScopes` and already-granted scopes
  and answers `202 pact_consent_required` with the consent payload (including
  the task's `contextId` and `pact.verificationUriComplete` when sent).
- A2A error envelopes map on `error.details[0].reason`:
  `INVALID_PARAMS`/`CONTENT_TYPE_NOT_SUPPORTED` → `400 invalid_input`;
  `UNSUPPORTED_OPERATION` → `409 pact_context_closed` when a `contextId` was
  sent, else `502 pact_provider_unavailable`.
- `401` → the delegation is force-refreshed once and the request retried; a
  second `401` marks the connection `needsReauthorization` and surfaces
  `pact_unauthorized`.
- `404`/`405` → the card is refetched; when `interfaceUrl` moved the retry posts
  to the new URL (persisted best-effort), else `502 pact_provider_unavailable`.
- `429`/`503` keep their `Retry-After` seconds in the error details.
- Provider replies are capped at 1 MiB; the stored `contextId` appears only on
  the run summary, never PA-JWTs or delegation tokens.

Run logs for these executions carry `connectionSource: "pact"`, and
`list_connections` reports `source: "pact"` with `identityOnly` (true until a
delegation grant commits) and `pact.needsReauthorization` when the grant needs
fresh consent.

## Receipts

Every completed run mints a **custodian receipt** while a deployment PACT
identity exists — a compact JWS signed under the current identity key,
published for verification via `GET /.well-known/jwks.json`. Runs also capture
a **Provider receipt** when a Brand reply carries
`metadata["pact.receipt"] = {jws, claims}`. Neither is returned inline in the
action response beyond `meta.receiptId` (which equals the `executionId`).

Custodian receipt claims:

- `iss` = the Connect issuer; `sub` = the caller's token subject (or the
  deployment subject); `act` = the runtime token id or the caller kind
  (`bootstrap` | `jwt` | `admin` | `dev`); `aud` = the PACT interfaceUrl for
  Brand runs, else the action's service id; `jti` = the execution id; `iat`.
- `action` = `{id, operationType, connectionId, inputHash, outcome, errorCode?}`
  where `inputHash` is SHA-256 over the JCS-canonicalized input
  (`src/core/json-canonical.ts`, RFC 8785 subset).
- `approval` = `{approvalId, decidedBy, decidedAt, factor, grantId?}` when the
  run went through the §4.2 checkpoint.
- `provider_receipt` = `{grantId, scopesUsed, verified}` for pact runs.

A Brand receipt is checked, in order, for: a complete `{jws, claims}` object,
payload === claims (byte-identical JCS), a verifiable signature against the
connection's `jwksUri` (same JWKS cache as delegation: 5 min positive / 60 s
negative / one `kid`-miss refetch), `claims.grantId` equal to the connection's
grant, and `claims.pa` equal to the Connect issuer. The result is stored on the
run log as `providerReceipt = {jws, claims, verified, verifiedAt,
failureReason?}` with `failureReason` one of `pact_receipt_missing`,
`pact_receipt_malformed`, `pact_receipt_payload_mismatch`,
`pact_receipt_jwks_unavailable`, `pact_receipt_signature_invalid`,
`pact_receipt_grant_mismatch`, or `pact_receipt_issuer_mismatch`.

Verification failure never fails the action by default — the Brand's action
already happened. `OOMOL_CONNECT_PACT_STRICT_RECEIPTS=true` turns it into
`502 pact_receipt_invalid`; the run still records the rejected receipt and a
custodian receipt with `outcome: "error"`.

Read a run's receipts via `GET /api/runs/:id` (console) or
`GET /v1/runs/:executionId/receipt` — the latter is scoped to the bearer that
ran it (a stored runtime token sees only its own runs; anything else answers
`404 run_not_found`). Receipts live and die with the run row: run-log
retention deletes them. The Console runs page shows the approval link, the
custodian receipt (decoded claims plus a client-side **verify** button that
checks the JWS against the published JWKS), and the Provider receipt's
verified state.

## Runtime token subjects

Every runtime token carries a stable `subject` claim so verifiers can
distinguish callers. Existing tokens are backfilled during migration 0020;
`POST /api/runtime-tokens/:id/rotate-subject` mints a new subject without
revoking the token. Callers without a token subject fall back to the deployment
subject.

## PA-JWT verification rules

A Brand verifies a PA-JWT exactly like a PACT platform JWT:

- `alg` is `ES256` (or `RS256`) and the `kid` header matches a key in the
  deployment's JWKS.
- `iss` equals the Connect origin exactly.
- `aud` equals the Brand audience exactly.
- `exp - iat ≤ 300 s` with 30 s of clock skew tolerance.
