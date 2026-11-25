# SmartFlow Intelligence MCP

Multi-account call-center intelligence system connecting **Tata Tele Business Services Smartflo** accounts (call records & recordings) to transcription, structured AI conversation analysis, deterministic SQL analytics, and a read-only **Remote HTTP MCP server** for Claude.

## Quick Start

1. **Configure `.env`** (never commit `.env`):
   - `DATABASE_URL`: Postgres connection string
   - `ENCRYPTION_KEY`: 64-char hex key for AES-256-GCM encryption of Smartflo credentials & PII
   - `MCP_API_KEY`: Bootstrap admin API key for managing accounts and issuing client keys
   - `GROQ_API_KEY` (or OpenAI/Gemini): Transcription & call analysis provider key
   - Optional default account credentials: `SMARTFLOW_API_KEY` (or `SMARTFLOW_EMAIL` + `SMARTFLOW_PASSWORD`)

2. **Database & Migrations**:
   ```bash
   npm run db:migrate
   ```

3. **Run HTTP + MCP Server & Background Workers**:
   ```bash
   npm run dev      # Fastify HTTP API + /mcp endpoint on :8080
   npm run worker   # BullMQ multi-account sync & analysis workers
   ```

## Multi-Account Setup (Smartflo)

1. **Add a Smartflo account** (using your admin key):
   ```bash
   curl -X POST https://your-server.example.com/api/v1/accounts \
     -H "Authorization: Bearer $MCP_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{
       "name": "Acme Sales",
       "slug": "acme-sales",
       "timezone": "Asia/Kolkata",
       "smartfloApiKey": "YOUR_SMARTFLO_PORTAL_TOKEN",
       "smartfloWebhookSecret": "optional-webhook-secret"
     }'
   ```

2. **Issue a client-scoped API key** (strictly isolated to that Smartflo account):
   ```bash
   curl -X POST https://your-server.example.com/api/v1/accounts/acme-sales/api-keys \
     -H "Authorization: Bearer $MCP_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{ "name": "Acme Claude Key" }'
   ```
   Or issue an **admin API key** (can access and switch across all accounts):
   ```bash
   curl -X POST https://your-server.example.com/api/v1/admin/api-keys \
     -H "Authorization: Bearer $MCP_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{ "name": "Ops Admin Claude Key" }'
   ```

3. **Per-account Smartflo Webhook URL**:
   - Point each Smartflo account's webhook to: `POST https://your-server.example.com/api/v1/webhooks/smartflow/<account-slug>`
   - Pass header `x-webhook-secret` if configured on the account.

## Connecting Claude (MCP Config)

Use the remote Streamable HTTP endpoint (`POST /mcp`) in your Claude MCP configuration:

### Admin (can list and query any Smartflo account via `list_accounts` + `account` param)
```json
{
  "mcpServers": {
    "smartflow": {
      "type": "http",
      "url": "https://your-server.example.com/mcp",
      "headers": {
        "Authorization": "Bearer sf_adm_YOUR_ADMIN_KEY"
      }
    }
  }
}
```

### Single Client (strictly isolated to their own Smartflo account)
```json
{
  "mcpServers": {
    "smartflow": {
      "type": "http",
      "url": "https://your-server.example.com/mcp",
      "headers": {
        "Authorization": "Bearer sf_acc_CLIENT_KEY"
      }
    }
  }
}
```

## Tests & Build

```bash
npm run typecheck
npm run build
npm test
```
