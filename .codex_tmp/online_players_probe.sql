select p.xuid, p.gamertag, gs.slug
from public.player_server_presence psp
join public.players p on p.id = psp.player_id
left join public.game_servers gs on gs.id = psp.current_server_id
where psp.online = true
order by psp.updated_at desc
limit 5;