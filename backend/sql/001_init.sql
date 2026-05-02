begin;

create extension if not exists pgcrypto;

create or replace function set_row_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists game_servers (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  server_type text not null check (server_type in ('capital', 'arena', 'nation', 'exploration')),
  nation_element text check (nation_element in ('fire', 'water', 'earth', 'air') or nation_element is null),
  docker_service_name text not null unique,
  public_host text,
  public_port integer not null default 19132,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists kingdoms (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null unique,
  description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists nations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null unique,
  element text not null check (element in ('fire', 'water', 'earth', 'air')),
  description text not null default '',
  kingdom_id uuid references kingdoms(id),
  spawn_server_id uuid not null references game_servers(id),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists nation_abilities (
  id uuid primary key default gen_random_uuid(),
  nation_id uuid not null references nations(id) on delete cascade,
  code text not null,
  name text not null,
  description text not null default '',
  cooldown_seconds integer not null default 0 check (cooldown_seconds >= 0),
  resource_cost integer not null default 0 check (resource_cost >= 0),
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (nation_id, code)
);

create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  xuid text not null unique,
  gamertag text not null,
  race text,
  class_name text,
  title text,
  primary_nation_id uuid references nations(id),
  is_banned boolean not null default false,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists clans (
  id uuid primary key default gen_random_uuid(),
  nation_id uuid references nations(id),
  name text not null unique,
  tag text not null unique,
  description text not null default '',
  leader_player_id uuid not null references players(id),
  max_members integer not null default 25 check (max_members > 0),
  is_public boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists nation_memberships (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references players(id) on delete cascade,
  nation_id uuid not null references nations(id) on delete cascade,
  role text not null default 'citizen' check (role in ('citizen', 'guard', 'leader')),
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  unique (player_id, nation_id, joined_at)
);

create unique index if not exists nation_memberships_one_active_per_player
  on nation_memberships (player_id)
  where left_at is null;

create table if not exists clan_memberships (
  id uuid primary key default gen_random_uuid(),
  clan_id uuid not null references clans(id) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  role text not null default 'member' check (role in ('leader', 'officer', 'member')),
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  unique (clan_id, player_id, joined_at)
);

create unique index if not exists clan_memberships_one_active_per_player
  on clan_memberships (player_id)
  where left_at is null;

create table if not exists accounts (
  id uuid primary key default gen_random_uuid(),
  currency_code text not null default 'DRACO',
  player_id uuid references players(id) on delete cascade,
  clan_id uuid references clans(id) on delete cascade,
  nation_id uuid references nations(id) on delete cascade,
  kingdom_id uuid references kingdoms(id) on delete cascade,
  server_id uuid references game_servers(id) on delete cascade,
  system_key text,
  balance bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (num_nonnulls(player_id, clan_id, nation_id, kingdom_id, server_id, system_key) = 1),
  unique (currency_code, player_id),
  unique (currency_code, clan_id),
  unique (currency_code, nation_id),
  unique (currency_code, kingdom_id),
  unique (currency_code, server_id),
  unique (currency_code, system_key)
);

create table if not exists draco_transactions (
  id uuid primary key default gen_random_uuid(),
  from_account_id uuid references accounts(id),
  to_account_id uuid references accounts(id),
  amount bigint not null check (amount > 0),
  transaction_type text not null check (
    transaction_type in ('deposit', 'withdraw', 'transfer', 'reward', 'tax', 'purchase', 'penalty')
  ),
  status text not null default 'confirmed' check (status in ('pending', 'confirmed', 'cancelled', 'reversed')),
  reason text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_by_player_id uuid references players(id),
  server_id uuid references game_servers(id),
  created_at timestamptz not null default now(),
  check (from_account_id is not null or to_account_id is not null),
  check (from_account_id is distinct from to_account_id)
);

create table if not exists player_inventories (
  player_id uuid primary key references players(id) on delete cascade,
  inventory_json jsonb not null default '[]'::jsonb,
  armor_json jsonb not null default '[]'::jsonb,
  ender_chest_json jsonb not null default '[]'::jsonb,
  offhand_json jsonb not null default '{}'::jsonb,
  hotbar_slot integer not null default 0 check (hotbar_slot between 0 and 8),
  experience_level integer not null default 0,
  total_experience integer not null default 0,
  health numeric(5, 2) not null default 20,
  hunger integer not null default 20 check (hunger between 0 and 20),
  saturation numeric(5, 2) not null default 5,
  metadata jsonb not null default '{}'::jsonb,
  inventory_version bigint not null default 1,
  updated_by_server_id uuid references game_servers(id),
  updated_at timestamptz not null default now()
);

create table if not exists inventory_sync_events (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references players(id) on delete cascade,
  server_id uuid references game_servers(id) on delete set null,
  event_type text not null check (event_type in ('load', 'save', 'transfer')),
  snapshot_version bigint not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists player_server_presence (
  player_id uuid primary key references players(id) on delete cascade,
  current_server_id uuid references game_servers(id),
  last_server_id uuid references game_servers(id),
  pending_transfer_server_id uuid references game_servers(id),
  online boolean not null default false,
  last_inventory_version bigint not null default 0,
  last_joined_at timestamptz,
  last_left_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists player_sessions (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references players(id) on delete cascade,
  server_id uuid not null references game_servers(id),
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  disconnect_reason text
);

drop trigger if exists trg_game_servers_updated_at on game_servers;
create trigger trg_game_servers_updated_at
before update on game_servers
for each row
execute function set_row_updated_at();

drop trigger if exists trg_nations_updated_at on nations;
create trigger trg_nations_updated_at
before update on nations
for each row
execute function set_row_updated_at();

drop trigger if exists trg_kingdoms_updated_at on kingdoms;
create trigger trg_kingdoms_updated_at
before update on kingdoms
for each row
execute function set_row_updated_at();

drop trigger if exists trg_players_updated_at on players;
create trigger trg_players_updated_at
before update on players
for each row
execute function set_row_updated_at();

drop trigger if exists trg_clans_updated_at on clans;
create trigger trg_clans_updated_at
before update on clans
for each row
execute function set_row_updated_at();

drop trigger if exists trg_accounts_updated_at on accounts;
create trigger trg_accounts_updated_at
before update on accounts
for each row
execute function set_row_updated_at();

drop trigger if exists trg_player_inventories_updated_at on player_inventories;
create trigger trg_player_inventories_updated_at
before update on player_inventories
for each row
execute function set_row_updated_at();

drop trigger if exists trg_player_server_presence_updated_at on player_server_presence;
create trigger trg_player_server_presence_updated_at
before update on player_server_presence
for each row
execute function set_row_updated_at();

insert into game_servers (slug, name, server_type, nation_element, docker_service_name, public_port)
values
  ('capital', 'Capital', 'capital', null, 'capital', 19132),
  ('arenas', 'Arenas', 'arena', null, 'arenas', 19133),
  ('fire', 'Nação do Fogo', 'nation', 'fire', 'fire', 19134),
  ('water', 'Nação da Água', 'nation', 'water', 'water', 19135),
  ('earth', 'Nação da Terra', 'nation', 'earth', 'earth', 19136),
  ('air', 'Nação do Vento', 'nation', 'air', 'air', 19137),
  ('exploration', 'Mapa de Exploração', 'exploration', null, 'exploration', 19138)
on conflict (slug) do update
set name = excluded.name,
    server_type = excluded.server_type,
    nation_element = excluded.nation_element,
    docker_service_name = excluded.docker_service_name,
    public_port = excluded.public_port,
    is_active = true;

insert into kingdoms (slug, name, description)
values
  ('reino-elemental', 'Reino Elemental', 'Autoridade central que governa as quatro nações elementais.')
on conflict (slug) do update
set name = excluded.name,
    description = excluded.description;

with nation_server_map as (
  select
    gs.id as server_id,
    gs.slug
  from game_servers gs
  where gs.slug in ('fire', 'water', 'earth', 'air')
),
default_kingdom as (
  select id
  from kingdoms
  where slug = 'reino-elemental'
)
insert into nations (slug, name, element, description, kingdom_id, spawn_server_id, sort_order)
select
  n.slug,
  n.name,
  n.element,
  n.description,
  (select id from default_kingdom),
  m.server_id,
  n.sort_order
from (
  values
    ('fire', 'Nação do Fogo', 'fire', 'Força bruta e agressividade. Dominam pelo poder e pela destruição.', 1),
    ('water', 'Nação da Água', 'water', 'Controle do mar, mobilidade e sobrevivência aquática.', 2),
    ('earth', 'Nação da Terra', 'earth', 'Defesa inabalável, mineração e controle de terreno.', 3),
    ('air', 'Nação do Vento', 'air', 'Velocidade, mobilidade extrema e impacto tático.', 4)
) as n(slug, name, element, description, sort_order)
inner join nation_server_map m
  on m.slug = n.slug
on conflict (slug) do update
set name = excluded.name,
    element = excluded.element,
    description = excluded.description,
    kingdom_id = excluded.kingdom_id,
    spawn_server_id = excluded.spawn_server_id,
    sort_order = excluded.sort_order;

insert into accounts (currency_code, kingdom_id, balance)
select 'DRACO', k.id, 0
from kingdoms k
on conflict (currency_code, kingdom_id) do nothing;

insert into nation_abilities (nation_id, code, name, description, cooldown_seconds, resource_cost, sort_order, metadata)
select n.id, a.code, a.name, a.description, a.cooldown_seconds, a.resource_cost, a.sort_order, a.metadata::jsonb
from nations n
inner join (
  values
    ('water', 'abyssal_breath', 'Respiração Abissal', 'Respiração infinita, Visão Noturna e Conduit Power na água.', 0, 0, 20, '{"group":"native","role":"all_members","effectType":"aura","condition":"in_water"}'),
    ('water', 'atlantis_blessing', 'Bênção de Atlântida', 'Pode colocar blocos na água sem restrições.', 0, 0, 330, '{"group":"builder","role":"builder","tool":"Picareta","effectType":"building"}'),
    ('water', 'combat_triton', 'Tritão de Combate', 'Velocidade VI e Conduit Power II na água.', 0, 0, 210, '{"group":"warrior","role":"warrior","weapon":"Tridente","effectType":"combat_aura","condition":"in_water"}'),
    ('water', 'drowning_immunity', 'Imunidade ao Afogamento', 'Imunidade total a afogamento.', 0, 0, 10, '{"group":"native","role":"all_members","effectType":"immunity"}'),
    ('water', 'harpoon_pull', 'Arpão', '25% de chance de puxar inimigos para perto.', 0, 0, 230, '{"group":"warrior","role":"warrior","weapon":"Tridente","effectType":"proc","chancePercent":25}'),
    ('water', 'ocean_guard', 'Guarda Oceânica', '100% de resistência a Guardiões, Afogados e Baiacus oceânicos.', 0, 0, 40, '{"group":"native","role":"all_members","effectType":"mob_resistance","mobFamily":["guardian","drowned","pufferfish"]}'),
    ('water', 'tidal_swim', 'Nado das Marés', 'Nado ultra-veloz com Dolphin''s Grace III.', 0, 0, 30, '{"group":"native","role":"all_members","effectType":"mobility","condition":"in_water"}'),
    ('water', 'tide_collector', 'Coletor das Marés', 'Itens minerados vão direto para o inventário.', 0, 0, 320, '{"group":"builder","role":"builder","tool":"Picareta","effectType":"loot"}'),
    ('water', 'water_forge', 'Domínio Aquático', 'Força II constante dentro d''água.', 0, 0, 220, '{"group":"warrior","role":"warrior","weapon":"Tridente","effectType":"damage_aura","condition":"in_water"}'),
    ('water', 'water_haste', 'Haste Aquática', 'Haste IV permanente ao minerar na água.', 0, 0, 310, '{"group":"builder","role":"builder","tool":"Picareta","effectType":"mining","condition":"in_water"}'),
    ('fire', 'berserker_fury', 'Fúria Berserker', '+10% de dano por coração perdido.', 0, 0, 230, '{"group":"warrior","role":"warrior","weapon":"Espada","effectType":"scaling_damage"}'),
    ('fire', 'combat_forge', 'Força de Combate', '+40% de dano em PvP permanente.', 0, 0, 210, '{"group":"warrior","role":"warrior","weapon":"Espada","effectType":"pvp_damage"}'),
    ('fire', 'fire_immunity', 'Coração Ígneo', 'Imunidade total a fogo, lava e magma.', 0, 0, 10, '{"group":"native","role":"all_members","effectType":"immunity"}'),
    ('fire', 'forge_haste', 'Haste da Fornalha', 'Haste II permanente para mineração acelerada.', 0, 0, 310, '{"group":"builder","role":"builder","tool":"Picareta","effectType":"mining"}'),
    ('fire', 'instant_smelting', 'Fornalha Viva', 'Funde minérios instantaneamente ao minerar.', 0, 0, 320, '{"group":"builder","role":"builder","tool":"Picareta","effectType":"smelting"}'),
    ('fire', 'last_breath', 'Último Suspiro', '15% de chance de explosão crítica ao chegar no último meio coração.', 0, 0, 240, '{"group":"warrior","role":"warrior","weapon":"Espada","effectType":"proc","chancePercent":15,"condition":"last_half_heart"}'),
    ('fire', 'nether_dominion', 'Domínio do Nether', '100% de resistência a Ghasts e Blazes.', 0, 0, 20, '{"group":"native","role":"all_members","effectType":"mob_resistance","mobFamily":["ghast","blaze"]}'),
    ('fire', 'nether_fervor', 'Fervor do Nether', 'Velocidade II e Força I no Nether.', 0, 0, 30, '{"group":"native","role":"all_members","effectType":"aura","condition":"in_nether"}'),
    ('fire', 'scorching_edge', 'Incendiar', '30% de chance de queimar inimigos ao atacar.', 0, 0, 220, '{"group":"warrior","role":"warrior","weapon":"Espada","effectType":"proc","chancePercent":30}'),
    ('fire', 'thermal_mastery', 'Forno Acelerado', 'Eficiência térmica superior ao fundir recursos.', 0, 0, 330, '{"group":"builder","role":"builder","tool":"Picareta","effectType":"smelt_speed"}'),
    ('earth', 'earth_vision', 'Visão da Terra', 'Visão Noturna permanente pela conexão com a terra.', 0, 0, 20, '{"group":"native","role":"all_members","effectType":"vision"}'),
    ('earth', 'geologist', 'Geólogo', 'Chance de descobrir minérios raros em pedras comuns.', 0, 0, 330, '{"group":"builder","role":"builder","tool":"Picareta","effectType":"ore_discovery"}'),
    ('earth', 'grounded_meditation', 'Meditação', 'Recupera 1 coração por segundo ao ficar completamente parado.', 0, 0, 230, '{"group":"warrior","role":"warrior","weapon":"Martelo","effectType":"regeneration","condition":"standing_still"}'),
    ('earth', 'mobs_truce', 'Trégua Selvagem', 'Imunidade total a mobs neutros e hostis comuns, exceto chefes.', 0, 0, 10, '{"group":"native","role":"all_members","effectType":"mob_immunity","exceptions":["bosses"]}'),
    ('earth', 'profundity_mastery', 'Mestre das Profundezas', 'Haste III abaixo da camada 60.', 0, 0, 310, '{"group":"builder","role":"builder","tool":"Picareta","effectType":"mining","condition":"below_layer_60"}'),
    ('earth', 'rooted_strike', 'Raízes da Terra', '25% de chance de prender inimigos no solo com Lentidão IV.', 0, 0, 220, '{"group":"warrior","role":"warrior","weapon":"Martelo","effectType":"proc","chancePercent":25,"statusEffect":"slowness_iv"}'),
    ('earth', 'stone_harvest', 'Colheita Farta', 'Chance de duplicar recursos naturais ao colher.', 0, 0, 320, '{"group":"builder","role":"builder","tool":"Picareta","effectType":"double_drop"}'),
    ('earth', 'terrain_tank', 'Tanque Terreno', 'Redução passiva de 50% do dano recebido em PvP.', 0, 0, 210, '{"group":"warrior","role":"warrior","weapon":"Martelo","effectType":"pvp_defense"}'),
    ('air', 'air_lightness', 'Leveza do Ar', 'Velocidade I permanente.', 0, 0, 20, '{"group":"native","role":"all_members","effectType":"mobility"}'),
    ('air', 'cloud_engineer', 'Engenheiro de Nuvens', 'Voo temporário de 5 segundos ao construir.', 0, 0, 330, '{"group":"builder","role":"builder","tool":"Picareta","effectType":"temporary_flight","durationSeconds":5}'),
    ('air', 'elite_mobility', 'Mobilidade de Elite', 'Velocidade II e Salto II em combate.', 0, 0, 210, '{"group":"warrior","role":"warrior","weapon":"Lança","effectType":"combat_mobility"}'),
    ('air', 'fall_immunity', 'Asas Invisíveis', 'Imunidade total a dano de queda.', 0, 0, 10, '{"group":"native","role":"all_members","effectType":"immunity"}'),
    ('air', 'phantom_dodge', 'Esquiva Fantasma', '15% de chance de anular completamente o dano recebido.', 0, 0, 230, '{"group":"warrior","role":"warrior","weapon":"Lança","effectType":"proc","chancePercent":15}'),
    ('air', 'sky_haste', 'Haste Celeste', 'Haste III para mineração ultra-veloz permanente.', 0, 0, 310, '{"group":"builder","role":"builder","tool":"Picareta","effectType":"mining"}'),
    ('air', 'wind_gust', 'Rajada de Vento', '35% de chance de empurrar inimigos com força extrema.', 0, 0, 220, '{"group":"warrior","role":"warrior","weapon":"Lança","effectType":"proc","chancePercent":35,"statusEffect":"extreme_knockback"}'),
    ('air', 'wind_reach', 'Alcance do Vento', 'Maior alcance para quebrar e colocar blocos.', 0, 0, 320, '{"group":"builder","role":"builder","tool":"Picareta","effectType":"reach"}')
) as a(element, code, name, description, cooldown_seconds, resource_cost, sort_order, metadata)
  on a.element = n.element
on conflict (nation_id, code) do update
set name = excluded.name,
    description = excluded.description,
    cooldown_seconds = excluded.cooldown_seconds,
    resource_cost = excluded.resource_cost,
    sort_order = excluded.sort_order,
    metadata = excluded.metadata;

insert into accounts (currency_code, nation_id, balance)
select 'DRACO', id, 0
from nations
on conflict (currency_code, nation_id) do nothing;

insert into accounts (currency_code, server_id, balance)
select 'DRACO', id, 0
from game_servers
on conflict (currency_code, server_id) do nothing;

insert into accounts (currency_code, system_key, balance)
values ('DRACO', 'global-bank', 0)
on conflict (currency_code, system_key) do nothing;

commit;
