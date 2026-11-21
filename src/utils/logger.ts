import pino from "pino";

const isStdio = process.env.MCP_STDIO === "true";

// In MCP STDIO mode, stdout is reserved strictly for JSON-RPC frames.
// Always route logs to stderr (fd 2) when running as an MCP STDIO server.
const destination = isStdio ? pino.destination(2) : pino.destination(1);

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? "info",
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers['x-api-key']",
        "*.apiKey",
        "*.api_key",
        "*.password",
        "*.token",
        "*.access_token",
        "*.recordingUrl",
        "*.recording_url",
        "*.sourceUrl",
        "*.phone",
      ],
      censor: "[REDACTED]",
    },
  },
  destination
);

