alter table runtime_tokens add column require_approval_operations text not null default '[]';
alter table runtime_tokens add column approval_required_actions text not null default '[]';
