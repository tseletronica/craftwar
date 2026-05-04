update public.player_server_presence psp
set pending_transfer_server_id = null,
    updated_at = now()
where psp.online = false
  and psp.current_server_id is null
  and psp.pending_transfer_server_id is not null;

select p.gamertag, gs.slug as last_slug, psp.pending_transfer_server_id is null as pending_cleared
from public.player_server_presence psp
join public.players p on p.id = psp.player_id
left join public.game_servers gs on gs.id = psp.last_server_id
where p.gamertag in ('SerafimM2025','SophiaBlocks271','TravisMaddox745');