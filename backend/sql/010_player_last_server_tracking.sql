begin;

alter table player_server_presence
  add column if not exists last_server_id uuid references game_servers(id);

alter table player_server_presence
  add column if not exists pending_transfer_server_id uuid references game_servers(id);

update player_server_presence psp
set last_server_id = coalesce(psp.last_server_id, psp.current_server_id, pi.updated_by_server_id)
from player_inventories pi
where pi.player_id = psp.player_id
  and psp.last_server_id is null;

commit;
