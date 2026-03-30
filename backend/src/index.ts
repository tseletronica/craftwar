import { config } from "./config.js";
import { buildServer } from "./server.js";

async function start() {
  const app = await buildServer();

  await app.listen({
    host: "0.0.0.0",
    port: config.API_PORT
  });
}

start().catch((error) => {
  console.error("Failed to start backend", error);
  process.exit(1);
});
