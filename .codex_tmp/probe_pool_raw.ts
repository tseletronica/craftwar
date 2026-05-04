import { pool } from "./src/lib/db.ts";

async function main() {
  const client = await pool.connect();

  try {
    const playerIdResult = await client.query(
      "select id from public.players where xuid = $1 limit 1",
      ["5A641DD328C5ABA1"]
    );
    const playerId = playerIdResult.rows[0]?.id;
    console.log("playerId", playerId);

    const presence = await client.query(
      `
        select
          psp.current_server_id as "currentServerId",
          current_server.slug as "currentServerSlug",
          psp.last_server_id as "lastServerId",
          last_server.slug as "lastServerSlug",
          last_server.name as "lastServerName",
          psp.pending_transfer_server_id as "pendingTransferServerId",
          pending_server.slug as "pendingTransferServerSlug",
          pending_server.name as "pendingTransferServerName"
        from public.player_server_presence psp
        left join public.game_servers current_server
          on current_server.id = psp.current_server_id
         and current_server.is_active = true
        left join public.game_servers last_server
          on last_server.id = psp.last_server_id
         and last_server.is_active = true
        left join public.game_servers pending_server
          on pending_server.id = psp.pending_transfer_server_id
         and pending_server.is_active = true
        where psp.player_id = $1
        limit 1
      `,
      [playerId]
    );
    console.log("presence ok", JSON.stringify(presence.rows));

    const serverResult = await client.query(
      "select id from public.game_servers where slug = $1 limit 1",
      ["air"]
    );
    const destinationResult = await client.query(
      "select id from public.game_servers where slug = $1 limit 1",
      ["fire"]
    );

    await client.query("begin");
    try {
      await client.query(
        `
          insert into public.player_server_presence (
            player_id,
            current_server_id,
            last_server_id,
            pending_transfer_server_id,
            online,
            last_inventory_version,
            updated_at
          )
          values ($1, $2, $2, $4, true, $3, now())
          on conflict (player_id) do update
            set current_server_id = excluded.current_server_id,
                last_server_id = excluded.last_server_id,
                pending_transfer_server_id = excluded.pending_transfer_server_id,
                online = true,
                last_inventory_version = excluded.last_inventory_version,
                updated_at = now()
        `,
        [playerId, serverResult.rows[0]?.id, 999999, destinationResult.rows[0]?.id]
      );
      console.log("insert ok");
    } finally {
      await client.query("rollback");
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
