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
   `providerOrigin`, `registrationId`, grant scope list). No tokens or keys are
   persisted for an identity-only Brand.

`POST /api/pact/brands/preview` `{agentCardUrl}` returns the same card plus the
matching registration state so the Console **PACT → Brands** dialog can offer
scope checkboxes before connect.

The `pact` catalog provider carries four actions:

| Action                | Operation | Behavior                                             |
| --------------------- | --------- | ---------------------------------------------------- |
| `pact.get_agent_card` | `read`    | Returns the stored card summary.                     |
| `pact.get_delegation` | `read`    | Returns `{identityOnly: true}` in this phase.        |
| `pact.send_message`   | `write`   | POSTs `${interfaceUrl}/message:send` per Appendix A. |
| `pact.request_scopes` | `write`   | Step-up plumbing only; full device flow lands later. |

`pact.send_message` takes `input.text` (required) and optional
`input.contextId` (opaque, ≤256 UTF-8 bytes). The request headers are
`Authorization: Bearer <PA-JWT>`, `A2A-Version: 1.0`, and
`X-A2A-User-Delegation: Bearer <token>` only when a delegation exists whose
issuer matches the interface origin — delegation lands in a later phase, so the
header is absent for identity-only connections. `messageId` is the execution ID.

Response and error mapping:

- `{message}` replies → `{messageId, text, contextId}` where `text` joins the
  `text/plain` parts.
- `{task}` with `TASK_STATE_AUTH_REQUIRED` → `202 pact_consent_required` with
  `missingScopes`/`verificationUriComplete` in `data.details`.
- A2A error envelopes map on `error.details[0].reason`:
  `INVALID_PARAMS`/`CONTENT_TYPE_NOT_SUPPORTED` → `400 invalid_input`;
  `UNSUPPORTED_OPERATION` → `409 pact_context_closed` when a `contextId` was
  sent, else `502 pact_provider_unavailable`.
- `401` → one PA-JWT re-mint and retry, then `pact_unauthorized`.
- `404`/`405` → the card is refetched; when `interfaceUrl` moved the retry posts
  to the new URL (persisted best-effort), else `502 pact_provider_unavailable`.
- `429`/`503` keep their `Retry-After` seconds in the error details.
- Provider replies are capped at 1 MiB; the stored `contextId` appears only on
  the run summary, never PA-JWTs or delegation tokens.

Run logs for these executions carry `connectionSource: "pact"`, and
`list_connections` reports `source: "pact"` with `identityOnly`.

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
