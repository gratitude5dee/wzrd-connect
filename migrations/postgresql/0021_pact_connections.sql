alter table connections drop constraint connections_source_check;
alter table connections add constraint connections_source_check check (source in ('local', 'saas', 'pact'));
