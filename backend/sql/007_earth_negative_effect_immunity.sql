begin;

with earth_nation as (
  select id
  from nations
  where slug = 'earth'
  limit 1
),
upserted as (
  insert into nation_abilities (
    nation_id,
    code,
    name,
    description,
    cooldown_seconds,
    resource_cost,
    sort_order,
    metadata
  )
  select
    earth_nation.id,
    'negative_effect_immunity',
    'Pureza da Terra',
    'Imunidade a efeitos negativos pela conexao com a terra.',
    0,
    0,
    10,
    '{"group":"native","role":"all_members","effectType":"negative_effect_immunity"}'::jsonb
  from earth_nation
  on conflict (nation_id, code) do update
  set name = excluded.name,
      description = excluded.description,
      cooldown_seconds = excluded.cooldown_seconds,
      resource_cost = excluded.resource_cost,
      sort_order = excluded.sort_order,
      metadata = excluded.metadata
  returning nation_id
)
delete from nation_abilities
where nation_id in (select nation_id from upserted)
  and code = 'mobs_truce';

commit;
