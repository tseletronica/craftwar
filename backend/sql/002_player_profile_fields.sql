begin;

alter table players
  add column if not exists race text,
  add column if not exists class_name text,
  add column if not exists title text;

commit;
