begin;

alter table nation_abilities
  add column if not exists sort_order integer not null default 0;

update nations
set description = case slug
  when 'water' then 'Controle do mar, mobilidade e sobrevivÃªncia aquÃ¡tica.'
  when 'fire' then 'ForÃ§a bruta e agressividade. Dominam pelo poder e pela destruiÃ§Ã£o.'
  when 'earth' then 'Defesa inabalÃ¡vel, mineraÃ§Ã£o e controle de terreno.'
  when 'air' then 'Velocidade, mobilidade extrema e impacto tÃ¡tico.'
  else description
end
where slug in ('water', 'fire', 'earth', 'air');

with catalog(nation_slug, code, name, description, cooldown_seconds, resource_cost, sort_order, metadata) as (
  values
    ('water', 'drowning_immunity', 'Imunidade ao Afogamento', 'Imunidade total a afogamento.', 0, 0, 10, '{"group":"native","role":"all_members","effectType":"immunity"}'),
    ('water', 'abyssal_breath', 'RespiraÃ§Ã£o Abissal', 'RespiraÃ§Ã£o infinita, VisÃ£o Noturna e Conduit Power na Ã¡gua.', 0, 0, 20, '{"group":"native","role":"all_members","effectType":"aura","condition":"in_water"}'),
    ('water', 'tidal_swim', 'Nado das MarÃ©s', 'Nado ultra-veloz com Dolphin''s Grace III.', 0, 0, 30, '{"group":"native","role":"all_members","effectType":"mobility","condition":"in_water"}'),
    ('water', 'ocean_guard', 'Guarda OceÃ¢nica', '100% de resistÃªncia a GuardiÃµes, Afogados e Baiacus oceÃ¢nicos.', 0, 0, 40, '{"group":"native","role":"all_members","effectType":"mob_resistance","mobFamily":["guardian","drowned","pufferfish"]}'),
    ('water', 'combat_triton', 'TritÃ£o de Combate', 'Velocidade VI e Conduit Power II na Ã¡gua.', 0, 0, 210, '{"group":"warrior","role":"warrior","weapon":"Tridente","effectType":"combat_aura","condition":"in_water"}'),
    ('water', 'water_forge', 'DomÃ­nio AquÃ¡tico', 'ForÃ§a II constante dentro d''Ã¡gua.', 0, 0, 220, '{"group":"warrior","role":"warrior","weapon":"Tridente","effectType":"damage_aura","condition":"in_water"}'),
    ('water', 'harpoon_pull', 'ArpÃ£o', '25% de chance de puxar inimigos para perto.', 0, 0, 230, '{"group":"warrior","role":"warrior","weapon":"Tridente","effectType":"proc","chancePercent":25}'),
    ('water', 'water_haste', 'Haste AquÃ¡tica', 'Haste IV permanente ao minerar na Ã¡gua.', 0, 0, 310, '{"group":"builder","role":"builder","tool":"Picareta","effectType":"mining","condition":"in_water"}'),
    ('water', 'tide_collector', 'Coletor das MarÃ©s', 'Itens minerados vÃ£o direto para o inventÃ¡rio.', 0, 0, 320, '{"group":"builder","role":"builder","tool":"Picareta","effectType":"loot"}'),
    ('water', 'atlantis_blessing', 'BÃªnÃ§Ã£o de AtlÃ¢ntida', 'Pode colocar blocos na Ã¡gua sem restriÃ§Ãµes.', 0, 0, 330, '{"group":"builder","role":"builder","tool":"Picareta","effectType":"building"}'),
    ('fire', 'fire_immunity', 'CoraÃ§Ã£o Ãgneo', 'Imunidade total a fogo, lava e magma.', 0, 0, 10, '{"group":"native","role":"all_members","effectType":"immunity"}'),
    ('fire', 'nether_dominion', 'DomÃ­nio do Nether', '100% de resistÃªncia a Ghasts e Blazes.', 0, 0, 20, '{"group":"native","role":"all_members","effectType":"mob_resistance","mobFamily":["ghast","blaze"]}'),
    ('fire', 'nether_fervor', 'Fervor do Nether', 'Velocidade II e ForÃ§a I no Nether.', 0, 0, 30, '{"group":"native","role":"all_members","effectType":"aura","condition":"in_nether"}'),
    ('fire', 'combat_forge', 'ForÃ§a de Combate', '+40% de dano em PvP permanente.', 0, 0, 210, '{"group":"warrior","role":"warrior","weapon":"Espada","effectType":"pvp_damage"}'),
    ('fire', 'scorching_edge', 'Incendiar', '30% de chance de queimar inimigos ao atacar.', 0, 0, 220, '{"group":"warrior","role":"warrior","weapon":"Espada","effectType":"proc","chancePercent":30}'),
    ('fire', 'berserker_fury', 'FÃºria Berserker', '+10% de dano por coraÃ§Ã£o perdido.', 0, 0, 230, '{"group":"warrior","role":"warrior","weapon":"Espada","effectType":"scaling_damage"}'),
    ('fire', 'last_breath', 'Ãšltimo Suspiro', '15% de chance de explosÃ£o crÃ­tica ao chegar no Ãºltimo meio coraÃ§Ã£o.', 0, 0, 240, '{"group":"warrior","role":"warrior","weapon":"Espada","effectType":"proc","chancePercent":15,"condition":"last_half_heart"}'),
    ('fire', 'forge_haste', 'Haste da Fornalha', 'Haste II permanente para mineraÃ§Ã£o acelerada.', 0, 0, 310, '{"group":"builder","role":"builder","tool":"Picareta","effectType":"mining"}'),
    ('fire', 'instant_smelting', 'Fornalha Viva', 'Funde minÃ©rios instantaneamente ao minerar.', 0, 0, 320, '{"group":"builder","role":"builder","tool":"Picareta","effectType":"smelting"}'),
    ('fire', 'thermal_mastery', 'Forno Acelerado', 'EficiÃªncia tÃ©rmica superior ao fundir recursos.', 0, 0, 330, '{"group":"builder","role":"builder","tool":"Picareta","effectType":"smelt_speed"}'),
    ('earth', 'negative_effect_immunity', 'Pureza da Terra', 'Imunidade a efeitos negativos pela conexÃ£o com a terra.', 0, 0, 10, '{"group":"native","role":"all_members","effectType":"negative_effect_immunity"}'),
    ('earth', 'earth_vision', 'VisÃ£o da Terra', 'VisÃ£o Noturna permanente pela conexÃ£o com a terra.', 0, 0, 20, '{"group":"native","role":"all_members","effectType":"vision"}'),
    ('earth', 'terrain_tank', 'Tanque Terreno', 'ReduÃ§Ã£o passiva de 70% do dano recebido em PvP.', 0, 0, 210, '{"group":"warrior","role":"warrior","weapon":"Martelo","effectType":"pvp_defense"}'),
    ('earth', 'rooted_strike', 'RaÃ­zes da Terra', '25% de chance de prender inimigos no solo com LentidÃ£o IV.', 0, 0, 220, '{"group":"warrior","role":"warrior","weapon":"Martelo","effectType":"proc","chancePercent":25,"statusEffect":"slowness_iv"}'),
    ('earth', 'grounded_meditation', 'MeditaÃ§Ã£o', 'Recupera 1 coraÃ§Ã£o por segundo ao ficar completamente parado.', 0, 0, 230, '{"group":"warrior","role":"warrior","weapon":"Martelo","effectType":"regeneration","condition":"standing_still"}'),
    ('earth', 'profundity_mastery', 'Mestre das Profundezas', 'Haste III abaixo da camada 60.', 0, 0, 310, '{"group":"builder","role":"builder","tool":"Picareta","effectType":"mining","condition":"below_layer_60"}'),
    ('earth', 'stone_harvest', 'Colheita Farta', 'Chance de duplicar recursos naturais ao colher.', 0, 0, 320, '{"group":"builder","role":"builder","tool":"Picareta","effectType":"double_drop"}'),
    ('earth', 'geologist', 'GeÃ³logo', 'Chance de descobrir minÃ©rios raros em pedras comuns.', 0, 0, 330, '{"group":"builder","role":"builder","tool":"Picareta","effectType":"ore_discovery"}'),
    ('air', 'fall_immunity', 'Asas InvisÃ­veis', 'Imunidade total a dano de queda.', 0, 0, 10, '{"group":"native","role":"all_members","effectType":"immunity"}'),
    ('air', 'air_lightness', 'Leveza do Ar', 'Velocidade I permanente.', 0, 0, 20, '{"group":"native","role":"all_members","effectType":"mobility"}'),
    ('air', 'elite_mobility', 'Mobilidade de Elite', 'Velocidade II e Salto II em combate.', 0, 0, 210, '{"group":"warrior","role":"warrior","weapon":"LanÃ§a","effectType":"combat_mobility"}'),
    ('air', 'wind_gust', 'Rajada de Vento', '35% de chance de empurrar inimigos com forÃ§a extrema.', 0, 0, 220, '{"group":"warrior","role":"warrior","weapon":"LanÃ§a","effectType":"proc","chancePercent":35,"statusEffect":"extreme_knockback"}'),
    ('air', 'phantom_dodge', 'Esquiva Fantasma', '30% de chance de anular completamente o dano recebido.', 0, 0, 230, '{"group":"warrior","role":"warrior","weapon":"LanÃ§a","effectType":"proc","chancePercent":30}'),
    ('air', 'sky_haste', 'Haste Celeste', 'Haste III para mineraÃ§Ã£o ultra-veloz permanente.', 0, 0, 310, '{"group":"builder","role":"builder","tool":"Picareta","effectType":"mining"}'),
    ('air', 'wind_reach', 'Alcance do Vento', 'Maior alcance para quebrar e colocar blocos.', 0, 0, 320, '{"group":"builder","role":"builder","tool":"Picareta","effectType":"reach"}'),
    ('air', 'cloud_engineer', 'Engenheiro de Nuvens', 'Voo temporÃ¡rio de 5 segundos ao construir.', 0, 0, 330, '{"group":"builder","role":"builder","tool":"Picareta","effectType":"temporary_flight","durationSeconds":5}')
),
upserted as (
  insert into nation_abilities (nation_id, code, name, description, cooldown_seconds, resource_cost, sort_order, metadata)
  select
    n.id,
    c.code,
    c.name,
    c.description,
    c.cooldown_seconds,
    c.resource_cost,
    c.sort_order,
    c.metadata::jsonb
  from catalog c
  inner join nations n
    on n.slug = c.nation_slug
  on conflict (nation_id, code) do update
  set name = excluded.name,
      description = excluded.description,
      cooldown_seconds = excluded.cooldown_seconds,
      resource_cost = excluded.resource_cost,
      sort_order = excluded.sort_order,
      metadata = excluded.metadata
  returning 1
)
select count(*) from upserted;

with catalog(nation_slug, code) as (
  values
    ('water', 'drowning_immunity'),
    ('water', 'abyssal_breath'),
    ('water', 'tidal_swim'),
    ('water', 'ocean_guard'),
    ('water', 'combat_triton'),
    ('water', 'water_forge'),
    ('water', 'harpoon_pull'),
    ('water', 'water_haste'),
    ('water', 'tide_collector'),
    ('water', 'atlantis_blessing'),
    ('fire', 'fire_immunity'),
    ('fire', 'nether_dominion'),
    ('fire', 'nether_fervor'),
    ('fire', 'combat_forge'),
    ('fire', 'scorching_edge'),
    ('fire', 'berserker_fury'),
    ('fire', 'last_breath'),
    ('fire', 'forge_haste'),
    ('fire', 'instant_smelting'),
    ('fire', 'thermal_mastery'),
    ('earth', 'negative_effect_immunity'),
    ('earth', 'earth_vision'),
    ('earth', 'terrain_tank'),
    ('earth', 'rooted_strike'),
    ('earth', 'grounded_meditation'),
    ('earth', 'profundity_mastery'),
    ('earth', 'stone_harvest'),
    ('earth', 'geologist'),
    ('air', 'fall_immunity'),
    ('air', 'air_lightness'),
    ('air', 'elite_mobility'),
    ('air', 'wind_gust'),
    ('air', 'phantom_dodge'),
    ('air', 'sky_haste'),
    ('air', 'wind_reach'),
    ('air', 'cloud_engineer')
)
delete from nation_abilities na
using nations n
where na.nation_id = n.id
  and n.slug in ('water', 'fire', 'earth', 'air')
  and not exists (
    select 1
    from catalog c
    where c.nation_slug = n.slug
      and c.code = na.code
  );

commit;
