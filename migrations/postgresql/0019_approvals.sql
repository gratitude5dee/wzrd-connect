create table approvals (
  id text primary key,
  kind text not null,
  owner_key text not null,
  runtime_token_id text,
  action_id text not null,
  service text not null,
  connection_id text,
  connection_name text,
  connection_request_id text,
  operation_type text not null,
  caller text not null,
  request_ciphertext text,
  request_fingerprint text not null,
  preview text,
  status text not null,
  decided_by text,
  decided_at text,
  decision_factor text,
  decision_reason text,
  grant_id text,
  execution_id text,
  created_at text not null,
  updated_at text not null,
  expires_at text not null,
  last_poll_at text,
  poll_window_started_at text,
  poll_violations integer not null default 0
);
-- At most one pending approval per (owner, request fingerprint); freed once the record decides.
create unique index approvals_pending_owner_fingerprint
  on approvals (owner_key, request_fingerprint)
  where status = 'pending';
create index approvals_status_created on approvals (status, created_at);

create table approval_grants (
  id text primary key,
  approval_id text,
  runtime_token_id text not null,
  action_id text not null,
  connection_id text,
  operation_type text not null,
  expires_at text not null,
  max_uses integer not null,
  uses integer not null default 0,
  created_by text not null,
  created_at text not null
);
create index approval_grants_consume
  on approval_grants (runtime_token_id, action_id, operation_type, expires_at);
