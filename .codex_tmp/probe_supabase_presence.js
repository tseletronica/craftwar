import pg from "pg";

const { Client } = pg;

async function run() {
  const client = new Client({
    connectionString: process.env.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();
  console.log("connected");

  const path = await client.query("show search_path");
  console.log("search_path", JSON.stringify(path.rows));

  const cols = await client.query(`
    select column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'player_server_presence'
    order by ordinal_position
  `);
  console.log(
    "public columns",
    JSON.stringify(cols.rows.map((row) => row.column_name))
  );

  const zero = await client.query("select * from player_server_presence limit 0");
  console.log(
    "unqualified fields",
    JSON.stringify(zero.fields.map((field) => field.name))
  );

  const zeroPublic = await client.query(
    "select * from public.player_server_presence limit 0"
  );
  console.log(
    "qualified fields",
    JSON.stringify(zeroPublic.fields.map((field) => field.name))
  );

  try {
    await client.query(`
      begin;
      with sample as (
        select p.id as player_id, gs.id as server_id
        from public.players p
        cross join lateral (
          select id from public.game_servers order by slug limit 1
        ) gs
        order by p.updated_at desc nulls last, p.created_at desc nulls last
        limit 1
      )
      insert into player_server_presence (
        player_id,
        current_server_id,
        last_server_id,
        pending_transfer_server_id,
        online,
        last_inventory_version,
        updated_at
      )
      select player_id, server_id, server_id, null, true, 1, now()
      from sample
      on conflict (player_id) do update
        set current_server_id = excluded.current_server_id,
            last_server_id = excluded.last_server_id,
            pending_transfer_server_id = excluded.pending_transfer_server_id,
            online = true,
            last_inventory_version = excluded.last_inventory_version,
            updated_at = now();
      rollback;
    `);
    console.log("unqualified insert ok");
  } catch (error) {
    console.log("unqualified insert failed", error.message);
  }

  try {
    await client.query(`
      begin;
      with sample as (
        select p.id as player_id, gs.id as server_id
        from public.players p
        cross join lateral (
          select id from public.game_servers order by slug limit 1
        ) gs
        order by p.updated_at desc nulls last, p.created_at desc nulls last
        limit 1
      )
      insert into public.player_server_presence (
        player_id,
        current_server_id,
        last_server_id,
        pending_transfer_server_id,
        online,
        last_inventory_version,
        updated_at
      )
      select player_id, server_id, server_id, null, true, 1, now()
      from sample
      on conflict (player_id) do update
        set current_server_id = excluded.current_server_id,
            last_server_id = excluded.last_server_id,
            pending_transfer_server_id = excluded.pending_transfer_server_id,
            online = true,
            last_inventory_version = excluded.last_inventory_version,
            updated_at = now();
      rollback;
    `);
    console.log("qualified insert ok");
  } catch (error) {
    console.log("qualified insert failed", error.message);
  }

  await client.end();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
