import Fastify from "fastify";
import { buildApp } from "./api/app.js";
import { env } from "./config/env.js";
import { closeDb } from "./db/client.js";
import { logger } from "./utils/logger.js";

// Keep explicit Fastify import in entrypoint for Vercel native framework detection.
void Fastify;

const app = buildApp();

if (!process.env.VERCEL) {
  app
    .listen({ port: env.PORT, host: "0.0.0.0" })
    .then(() => {
      logger.info({ port: env.PORT }, "SmartFlow Intelligence HTTP API listening");
    })
    .catch((err) => {
      logger.fatal({ err }, "Failed to start SmartFlow Intelligence server");
      process.exit(1);
    });

  const shutdown = async () => {
    logger.info("Shutting down HTTP server...");
    await app.close();
    await closeDb();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export default app;
