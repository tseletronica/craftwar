import { FastifyInstance } from "fastify";

import { pool } from "../lib/db.js";

export async function registerKingdomRoutes(app: FastifyInstance) {
  app.get("/kingdoms", async () => {
    const result = await pool.query(
      `
        select
          k.slug,
          k.name,
          k.description,
          coalesce(ka.balance, 0) as "dracoBalance",
          coalesce(
            json_agg(
              distinct jsonb_build_object(
                'slug', n.slug,
                'name', n.name,
                'element', n.element,
                'description', n.description,
                'serverSlug', gs.slug,
                'serverName', gs.name
              )
            ) filter (where n.id is not null),
            '[]'::json
          ) as nations
        from kingdoms k
        left join accounts ka
          on ka.kingdom_id = k.id
         and ka.currency_code = 'DRACO'
        left join nations n
          on n.kingdom_id = k.id
        left join game_servers gs
          on gs.id = n.spawn_server_id
        group by k.id, ka.balance
        order by k.name asc
      `
    );

    return {
      items: result.rows
    };
  });
}
