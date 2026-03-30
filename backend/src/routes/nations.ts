import { FastifyInstance } from "fastify";

import { pool } from "../lib/db.js";

export async function registerNationRoutes(app: FastifyInstance) {
  app.get("/nations", async () => {
    const result = await pool.query(
      `
        select
          n.slug,
          n.name,
          n.element,
          n.description,
          k.slug as "kingdomSlug",
          k.name as "kingdomName",
          gs.slug as "serverSlug",
          gs.name as "serverName",
          coalesce(
            json_agg(
              json_build_object(
                'code', na.code,
                'name', na.name,
                'description', na.description,
                'cooldownSeconds', na.cooldown_seconds,
                'resourceCost', na.resource_cost,
                'sortOrder', na.sort_order,
                'metadata', na.metadata
              )
              order by na.sort_order asc, na.name asc
            ) filter (where na.id is not null),
            '[]'::json
          ) as abilities
        from nations n
        inner join game_servers gs
          on gs.id = n.spawn_server_id
        left join kingdoms k
          on k.id = n.kingdom_id
        left join nation_abilities na
          on na.nation_id = n.id
        group by n.id, k.slug, k.name, gs.slug, gs.name
        order by n.sort_order asc, n.name asc
      `
    );

    return {
      items: result.rows
    };
  });
}
