begin;

alter table game_servers
  drop constraint if exists game_servers_server_type_check;

alter table game_servers
  add constraint game_servers_server_type_check
  check (server_type in ('capital', 'arena', 'nation', 'exploration'));

insert into game_servers (slug, name, server_type, nation_element, docker_service_name, public_port)
values
  ('exploration', 'Mapa de Exploração', 'exploration', null, 'exploration', 19138)
on conflict (slug) do update
set name = excluded.name,
    server_type = excluded.server_type,
    nation_element = excluded.nation_element,
    docker_service_name = excluded.docker_service_name,
    public_port = excluded.public_port,
    is_active = true;

insert into accounts (currency_code, server_id, balance)
select 'DRACO', gs.id, 0
from game_servers gs
where gs.slug = 'exploration'
on conflict (currency_code, server_id) do nothing;

commit;
