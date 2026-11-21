process.env.MCP_STDIO = "true";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closeDb } from "./db/client.js";
import { createMcpServer } from "./mcp/server.js";
import { logger } from "./utils/logger.js";

async function main() {
  const server = createMcpServer("mcp-stdio");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("SmartFlow Intelligence MCP STDIO server connected");

  const shutdown = async () => {
    await closeDb();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, "MCP STDIO server failed to start");
  process.exit(1);
});

