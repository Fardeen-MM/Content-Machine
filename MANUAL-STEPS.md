# Manual Setup Steps

Everything the Command Centre can't wire up by itself. Do these once.

---

## 1. Fireflies Webhook

Sends `transcription_complete` events when a call finishes recording.

1. Go to [app.fireflies.ai](https://app.fireflies.ai) > Settings > Developer > Webhooks
2. Add webhook:
   - **URL**: `https://<RAILWAY_DOMAIN>/api/webhooks/fireflies`
   - **Events**: `transcription_complete`
3. Copy the webhook secret shown after creation
4. Set in Railway env vars:
   - `FIREFLIES_API_KEY` = your API key (from Integrations > Fireflies API)
   - `FIREFLIES_WEBHOOK_SECRET` = the secret from step 3

**Verification**: After your next recorded call, check Railway logs for `[webhook] Fireflies: transcription_complete`. The meeting should appear in the Meetings tab within 2-3 minutes.

---

## 2. Instantly Webhook

Sends lead events (replies, meeting booked, interested, etc.) from cold email campaigns.

1. Go to Instantly dashboard > Settings > Integrations > Webhooks (or use their API V2)
2. Create webhook:
   - **URL**: `https://<RAILWAY_DOMAIN>/api/webhooks/instantly`
   - **Events**: `reply_received`, `lead_meeting_booked`, `lead_interested`
   - **Headers**: Add custom header `x-webhook-secret` with a random 32-char string
3. Set in Railway env vars:
   - `INSTANTLY_WEBHOOK_SECRET` = same string from step 2

**Note**: Instantly uses custom header auth, not HMAC. The header name must be exactly `x-webhook-secret`.

**Verification**: Send a test reply from a warm account. Check Railway logs for `[webhook] Instantly:`.

---

## 3. Mortar Reports Webhook

Sends `report_approved` events when a Revenue Rescue Report is approved and emailed.

This is our own system (Cloudflare Worker). The webhook needs to be added to the worker code:

1. In the mortar-reports worker, add a POST to the Command Centre after report approval:
   ```javascript
   // After report is approved and emailed:
   await fetch('https://<RAILWAY_DOMAIN>/api/webhooks/reports', {
     method: 'POST',
     headers: {
       'Content-Type': 'application/json',
       'x-webhook-secret': '<MORTAR_REPORTS_WEBHOOK_SECRET>'
     },
     body: JSON.stringify({
       event: 'report_approved',
       report: { firm_name, practice_label, location, report_url },
       lead: { email, name, title },
       opportunity: { total_range, gaps }
     })
   });
   ```
2. Set in Railway env vars:
   - `MORTAR_REPORTS_WEBHOOK_SECRET` = a random 32-char string matching the worker

**Verification**: Approve a report, check Railway logs for `[webhook] Reports:`.

---

## 4. GoHighLevel Webhook (Future)

GHL pipeline events (opportunity stage changes, calls logged). Endpoint exists at `/api/webhooks/ghl` but is stubbed.

1. In GHL > Settings > Webhooks, add:
   - **URL**: `https://<RAILWAY_DOMAIN>/api/webhooks/ghl`
   - **Events**: `OpportunityStageUpdate`, `ContactCreate`
   - **Custom header**: `x-webhook-secret` with a random string
2. Set `GHL_WEBHOOK_SECRET` in Railway env vars

---

## 5. Telegram Bot

Sends daily brief (8AM EST) and 2-hour alerts (stale deals, overdue proposals, pestering due).

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. `/newbot` > name it "Mortar Command Centre" > get the token
3. Create a group chat or use your DM with the bot
4. Get chat ID: send a message to the bot, then visit:
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
   Find `chat.id` in the response (negative number for groups).
5. Set in Railway env vars:
   - `TELEGRAM_BOT_TOKEN` = the token from BotFather
   - `TELEGRAM_CHAT_ID` = the chat ID

**Verification**: Redeploy. Check logs for `Cron: daily brief 8AM EST, alerts every 2h`. Or hit `POST /api/generate-brief` to force-send one.

---

## 6. Claude Desktop + MCP Servers

Connect Claude Desktop to the Command Centre via MCP (Model Context Protocol).

### 6a. Pipeline Server (20 tools)

Gives Claude access to: pipeline, prospects, actions, pestering, deals, ROI, brief, content, meetings, proposals.

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "mortar-pipeline": {
      "command": "node",
      "args": ["/path/to/content-machine/mcp/pipeline-server.js"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-...",
        "NODE_ENV": "production"
      }
    }
  }
}
```

### 6b. Fireflies Server (5 tools)

Gives Claude access to: recent calls, call detail, search, calls by prospect, Fireflies sync.

Add to the same config file:
```json
{
  "mcpServers": {
    "mortar-pipeline": { "..." : "..." },
    "mortar-fireflies": {
      "command": "node",
      "args": ["/path/to/content-machine/mcp/fireflies-server.js"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-...",
        "FIREFLIES_API_KEY": "...",
        "NODE_ENV": "production"
      }
    }
  }
}
```

### 6c. Claude Project Setup

1. Create a Claude Project named "Mortar Command Centre"
2. Add the knowledge base as a project file: upload `data/knowledge-base.md`
3. Set custom instructions:
   ```
   You are the Mortar Metrics Command Centre — the operating brain that replaced
   the daily whiteboard session. You have MCP tools connected to the live system.

   Your job: identify the #1 bottleneck, assign specific tasks to specific people
   (Yaseer for sales, Monty for content, Fardeen for systems), track every deal,
   and pester until things get done.

   Always name names. Give deadlines. Reference real data. Think in revenue.
   "$4K deal dies Friday if nobody calls" — not "consider following up."
   ```

**Verification**: Open Claude Desktop, start a new chat in the project. Type "What's the pipeline looking like?" — Claude should call `get_pipeline` and return live data.

---

## 7. Railway Deployment

```bash
npx @railway/cli up --service "content machine"
```

Set all env vars in Railway dashboard > service > Variables:
- `ANTHROPIC_API_KEY` (required)
- `PORT=3099`
- `FIREFLIES_API_KEY`, `FIREFLIES_WEBHOOK_SECRET`
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
- `INSTANTLY_WEBHOOK_SECRET`
- `MORTAR_REPORTS_WEBHOOK_SECRET`
- `GHL_WEBHOOK_SECRET`
- `RAILWAY_PUBLIC_DOMAIN` (auto-set by Railway, or set manually)

---

## 8. Fireflies History Sync

Pull in past call transcripts and reprocess with the upgraded knowledge base.

1. Open the Command Centre dashboard
2. Go to Meetings tab
3. Click "Sync from Fireflies" — fetches last 50 transcripts
4. Or via API: `POST /api/meetings/sync`
5. To reprocess already-synced meetings with upgraded AI:
   `POST /api/meetings/reprocess` (reprocesses all meetings)

This is useful after updating `data/knowledge-base.md` — reprocess will re-extract pain points, coaching scores, and content atoms using the new context.
