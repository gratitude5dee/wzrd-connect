-- Rebuild connections so source accepts 'pact' alongside 'local' and 'saas'
-- (SQLite cannot drop a column CHECK constraint).
create table connections_next (
  id text not null unique,
  service text not null,
  connection_name text not null,
  value text not null,
  updated_at text not null,
  revision text not null default '',
  source text not null default 'local' check (source in ('local', 'saas', 'pact')),
  managed_project_id text,
  provider_config_id text,
  external_user_id text,
  remote_account_id text,
  local_request_id text,
  provider_account_id text,
  primary key (service, connection_name)
);

insert into connections_next (
  id,
  service,
  connection_name,
  value,
  updated_at,
  revision,
  source,
  managed_project_id,
  provider_config_id,
  external_user_id,
  remote_account_id,
  local_request_id,
  provider_account_id
)
select
  id,
  service,
  connection_name,
  value,
  updated_at,
  revision,
  source,
  managed_project_id,
  provider_config_id,
  external_user_id,
  remote_account_id,
  local_request_id,
  provider_account_id
from connections;

drop table connections;
alter table connections_next rename to connections;
create index connections_managed_project on connections (managed_project_id);
