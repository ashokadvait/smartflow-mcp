# SmartFlow Intelligence MCP

Private call-center intelligence system connecting **Tata Tele Business Services Smartflo** call records and recordings to transcription, structured AI conversation analysis, deterministic SQL analytics, and a read-only MCP server.

## Quick Start

1. **Configure credentials in `.env`** (never commit `.env`):
   - `SMARTFLOW_API_KEY`: Your Smartflo Portal API Token (`API Connect → API Tokens`)
   - `GROQ_API_KEY`: Your Groq API key (used by default for `whisper-large-v3-turbo` transcription and `llama-3.3-70b-versatile` analysis)

2. **Database & Redis**:
   - Local containers (`smartflow-postgres` on `5432`, `smartflow-redis` on `6379`) are configured in `docker-compose.yml`.
   - Apply migrations: `npm run db:migrate`

3. **Sync calls from Smartflo**:
   ```bash
   npm run sync:calls -- --from 2026-11-20 --to 2026-11-20
   ```

4. **Process (download → transcribe → analyze) a single call**:
   ```bash
   npm run process:call -- <call-uuid>
   ```

5. **Run HTTP API or Background Workers**:
   ```bash
   npm run dev      # Fastify HTTP API on :8080
   npm run worker   # BullMQ background workers
   ```

6. **Connect as a Local MCP STDIO Server**:
   ```json
   {
     "mcpServers": {
       "smartflow-intelligence": {
         "command": "node",
         "args": ["/home/ashok/Desktop/smartflow-mcp/dist/mcp-stdio.js"],
         "env": { "NODE_ENV": "production", "MCP_STDIO": "true" }
       }
     }
   }
   ```

## Tests & Build

```bash
npm run build
npm test
```

