create table console_users (
  id text primary key,
  wallet_address text not null unique,
  phone text,
  email text,
  created_at text not null,
  last_sign_in_at text not null,
  disabled_at text
);

create table console_sessions (
  id text primary key,
  user_id text not null references console_users (id),
  created_at text not null,
  last_seen_at text not null,
  revoked_at text
);

create index console_sessions_user_id on console_sessions (user_id);

alter table connections add column created_by_user_id text;
alter table runtime_tokens add column created_by_user_id text;
