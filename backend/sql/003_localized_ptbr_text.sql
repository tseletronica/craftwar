begin;

update game_servers
set name = case slug
  when 'fire' then 'Nação do Fogo'
  when 'water' then 'Nação da Água'
  when 'earth' then 'Nação da Terra'
  when 'air' then 'Nação do Vento'
  else name
end
where slug in ('fire', 'water', 'earth', 'air');

update nations
set
  name = case slug
    when 'fire' then 'Nação do Fogo'
    when 'water' then 'Nação da Água'
    when 'earth' then 'Nação da Terra'
    when 'air' then 'Nação do Vento'
    else name
  end,
  description = case slug
    when 'earth' then 'Especializada em resistência, controle de terreno e impacto.'
    else description
  end
where slug in ('fire', 'water', 'earth', 'air');

commit;
