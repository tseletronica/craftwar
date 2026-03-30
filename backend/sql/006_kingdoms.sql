begin;

create table if not exists kingdoms (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null unique,
  description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table nations
  add column if not exists kingdom_id uuid references kingdoms(id);

alter table accounts
  add column if not exists kingdom_id uuid references kingdoms(id) on delete cascade;

alter table accounts
  drop constraint if exists accounts_check;

alter table accounts
  add constraint accounts_check
  check (num_nonnulls(player_id, clan_id, nation_id, kingdom_id, server_id, system_key) = 1);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'accounts_currency_code_kingdom_id_key'
  ) then
    alter table accounts
      add constraint accounts_currency_code_kingdom_id_key
      unique (currency_code, kingdom_id);
  end if;
end
$$;

drop trigger if exists trg_kingdoms_updated_at on kingdoms;
create trigger trg_kingdoms_updated_at
before update on kingdoms
for each row
execute function set_row_updated_at();

insert into kingdoms (slug, name, description)
values
  ('reino-elemental', 'Reino Elemental', 'Autoridade central que governa as quatro nações elementais.')
on conflict (slug) do update
set name = excluded.name,
    description = excluded.description;

with default_kingdom as (
  select id
  from kingdoms
  where slug = 'reino-elemental'
)
update nations
set kingdom_id = (select id from default_kingdom)
where slug in ('fire', 'water', 'earth', 'air')
  and kingdom_id is null;

insert into accounts (currency_code, kingdom_id, balance)
select 'DRACO', k.id, 0
from kingdoms k
on conflict (currency_code, kingdom_id) do nothing;

commit;
