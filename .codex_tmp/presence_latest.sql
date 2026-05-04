select p.gamertag, p.xuid, gs.slug as current_slug, last_gs.slug as last_slug, pending_gs.slug as pending_slug, psp.online,
       to_char(psp.updated_at at time zone 'America/Sao_Paulo', 'YYYY-MM-DD HH24:MI:SS') as updated_brt
from public.player_server_presence psp
join public.players p on p.id = psp.player_id
left join public.game_servers gs on gs.id = psp.current_server_id
left join public.game_servers last_gs on last_gs.id = psp.last_server_id
left join public.game_servers pending_gs on pending_gs.id = psp.pending_transfer_server_id
order by psp.updated_at desc
limit 12;