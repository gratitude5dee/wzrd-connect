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
- `OOMOL_CONNECT_PACT_ALLOW_INSECURE_LOOPBACK` (default `false`) is reserved for
  later phases that talk to loopback providers in development.

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
