import { buildApp } from "./api/app.js";
import { env } from "./config/env.js";
import { closeDb } from "./db/client.js";
import { logger } from "./utils/logger.js";

async function main() {
  const app = buildApp();
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  logger.info({ port: env.PORT }, "SmartFlow Intelligence HTTP API listening");

  const shutdown = async () => {
    logger.info("Shutting down HTTP server...");
    await app.close();
    await closeDb();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, "Failed to start SmartFlow Intelligence server");
  process.exit(1);
});

