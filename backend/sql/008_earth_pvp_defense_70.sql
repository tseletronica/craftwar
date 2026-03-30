begin;

update nation_abilities
set description = 'Redução passiva de 70% do dano recebido em PvP.'
where code = 'terrain_tank'
  and nation_id = (
    select id
    from nations
    where slug = 'earth'
    limit 1
  );

commit;
