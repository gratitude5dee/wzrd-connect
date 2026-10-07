-- Rebuild connection_requests so kind accepts 'pact' alongside 'local' and
-- 'saas' for the PACT device-code flow (SQLite cannot drop a column CHECK
-- constraint). managed_project_id keeps requiring a project only for 'saas'.
create table connection_requests_next (
  id text primary key,
  owner text not null,
  service text not null,
  state text not null unique,
  phase text not null check (phase in ('pending', 'processing', 'completed')),
  status text not null check (status in ('initiated', 'connected', 'failed')),
  value text,
  app_id text,
  error_code text,
  error_message text,
  expires_at text not null,
  created_at bigint not null,
  updated_at bigint not null,
  kind text not null default 'local' check (kind in ('local', 'saas', 'pact')),
  managed_project_id text check (kind in ('local', 'pact') or managed_project_id is not null),
  provider_config_id text,
  external_user_id text,
  remote_request_id text,
  remote_account_id text,
  lease_id text,
  lease_until bigint,
  next_poll_at bigint not null default 0,
  saas_phase text check (saas_phase in ('creating', 'pending', 'candidate')),
  candidate_value text,
  return_uri text,
  poll_attempts integer not null default 0
);

insert into connection_requests_next (
  id,
  owner,
  service,
  state,
  phase,
  status,
  value,
  app_id,
  error_code,
  error_message,
  expires_at,
  created_at,
  updated_at,
  kind,
  managed_project_id,
  provider_config_id,
  external_user_id,
  remote_request_id,
  remote_account_id,
  lease_id,
  lease_until,
  next_poll_at,
  saas_phase,
  candidate_value,
  return_uri,
  poll_attempts
)
select
  id,
  owner,
  service,
  state,
  phase,
  status,
  value,
  app_id,
  error_code,
  error_message,
  expires_at,
  created_at,
  updated_at,
  kind,
  managed_project_id,
  provider_config_id,
  external_user_id,
  remote_request_id,
  remote_account_id,
  lease_id,
  lease_until,
  next_poll_at,
  saas_phase,
  candidate_value,
  return_uri,
  poll_attempts
from connection_requests;

drop table connection_requests;
alter table connection_requests_next rename to connection_requests;
create index connection_requests_expires on connection_requests (expires_at);
create index connection_requests_pending on connection_requests (owner, service) where phase = 'pending';
create index connection_requests_managed_project on connection_requests (managed_project_id);
