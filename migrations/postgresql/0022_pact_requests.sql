-- Allow connection_requests.kind = 'pact' for the PACT device-code flow.
-- managed_project_id keeps requiring a project only for 'saas' rows.
alter table connection_requests drop constraint connection_requests_kind_check;
alter table connection_requests add constraint connection_requests_kind_check check (kind in ('local', 'saas', 'pact'));
-- PGlite names the multi-column column-level check connection_requests_check;
-- real Postgres names it connection_requests_managed_project_id_check.
alter table connection_requests drop constraint if exists connection_requests_managed_project_id_check;
alter table connection_requests drop constraint if exists connection_requests_check;
alter table connection_requests add constraint connection_requests_managed_project_id_check check (kind in ('local', 'pact') or managed_project_id is not null);
