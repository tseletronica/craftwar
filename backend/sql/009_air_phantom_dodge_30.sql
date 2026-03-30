begin;

update nation_abilities
set description = '30% de chance de anular completamente o dano recebido.',
    metadata = jsonb_set(
      coalesce(metadata, '{}'::jsonb),
      '{chancePercent}',
      '30'::jsonb,
      true
    )
where code = 'phantom_dodge'
  and nation_id = (
    select id
    from nations
    where slug = 'air'
    limit 1
  );

commit;
