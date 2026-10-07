create table pact_identity (
  id integer primary key check (id = 1),
  kid text not null,
  private_jwk_ciphertext text not null,
  public_jwk text not null,
  previous_kid text,
  previous_public_jwk text,
  previous_expires_at text,
  subject text not null,
  created_at text not null,
  rotated_at text
);

create table pact_registrations (
  id text primary key,
  provider_origin text not null,
  audience text not null,
  enabled integer not null default 1,
  notes text,
  created_at text not null,
  updated_at text not null
);
create unique index pact_registrations_origin on pact_registrations (provider_origin);

alter table runtime_tokens add column subject text not null default '';
update runtime_tokens set subject = replace(gen_random_uuid()::text, '-', '') where subject = '';
