const { loadEnv } = require('../lib/utils');
const db = require('../lib/db');
const https = require('https');

loadEnv();

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[brief] Telegram not configured — printing to console');
    console.log(text);
    return;
  }

  // Telegram max message length is 4096 chars
  const trimmed = text.length > 4090 ? text.slice(0, 4087) + '...' : text;

  const body = JSON.stringify({
    chat_id: TELEGRAM_CHAT_ID,
    text: trimmed,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log('[brief] Telegram message sent');
          resolve(JSON.parse(data));
        } else {
          console.error('[brief] Telegram error:', data);
          reject(new Error(`Telegram ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function generateBrief() {
  console.log('[brief] Generating daily brief...');
  db.initDb();
  const d = db.getDb();

  const healthOverview = db.getHealthOverview();
  const now = new Date();
  const dayName = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

  // ── Health one-liner ──
  const hs = healthOverview.summary || {};
  let brief = `<b>${dayName}</b>  ·  🟢${hs.green || 0} 🟡${hs.yellow || 0} 🔴${hs.red || 0}\n\n`;

  // ── Fires (only red / deep yellow) ──
  const fires = (healthOverview.clients || [])
    .filter(h => h.health_status === 'red')
    .sort((a, b) => a.score - b.score);

  if (fires.length > 0) {
    for (const c of fires.slice(0, 3)) {
      brief += `🔴 <b>${c.client_name}</b> — ${c.days_since_contact}d silent\n`;
    }
    brief += '\n';
  }

  // ── Top 3 to-dos ──
  const todos = d.prepare(`
    SELECT a.description, c.name as client_name
    FROM actions a
    LEFT JOIN clients c ON a.client_id = c.id
    WHERE a.status = 'open' AND a.owner = 'us'
    ORDER BY a.created_at DESC
    LIMIT 3
  `).all();
  const totalTodos = d.prepare(`SELECT COUNT(*) as c FROM actions WHERE status = 'open' AND owner = 'us'`).get().c;

  if (todos.length > 0) {
    brief += `<b>To-do</b> <i>(${totalTodos} total)</i>\n`;
    for (const a of todos) {
      const who = a.client_name ? `${a.client_name}: ` : '';
      brief += `• ${who}${a.description}\n`;
    }
    brief += '\n';
  }

  // ── Top 3 waiting on ──
  const waiting = d.prepare(`
    SELECT a.description, c.name as client_name
    FROM actions a
    LEFT JOIN clients c ON a.client_id = c.id
    WHERE a.status = 'open' AND a.owner = 'client'
    ORDER BY a.created_at DESC
    LIMIT 3
  `).all();
  const totalWaiting = d.prepare(`SELECT COUNT(*) as c FROM actions WHERE status = 'open' AND owner = 'client'`).get().c;

  if (waiting.length > 0) {
    brief += `<b>Waiting on</b> <i>(${totalWaiting} total)</i>\n`;
    for (const a of waiting) {
      const who = a.client_name ? `${a.client_name}: ` : '';
      brief += `• ${who}${a.description}\n`;
    }
    brief += '\n';
  }

  // ── This week summary (count only, not a list) ──
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const weekCalls = d.prepare(`SELECT COUNT(*) as c FROM meetings WHERE date >= ? AND meeting_type != 'internal'`).all(weekAgo)[0].c;
  if (weekCalls > 0) {
    brief += `${weekCalls} calls this week\n\n`;
  }

  // ── Footer ──
  const url = process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : 'localhost:3099';
  brief += `<a href="${url}">Command Centre</a>`;

  return brief;
}

async function run() {
  try {
    const brief = await generateBrief();
    await sendTelegram(brief);
    console.log('[brief] Daily brief complete');
  } catch (err) {
    console.error('[brief] Error:', err.message);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  run();
}

module.exports = { generateBrief, sendTelegram };
