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

  const stats = db.getStats();
  const healthOverview = db.getHealthOverview();
  const now = new Date();
  const dayName = now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

  let brief = `<b>Daily Brief</b>  —  ${dayName}\n`;

  // ── 1. Health snapshot (one line) ──
  const hs = healthOverview.summary || {};
  if (hs.total > 0) {
    brief += `${hs.total} prospects  ·  🟢 ${hs.green || 0}  🟡 ${hs.yellow || 0}  🔴 ${hs.red || 0}\n`;
  }
  brief += '\n';

  // ── 2. Deals needing attention ──
  const atRisk = (healthOverview.clients || [])
    .filter(h => h.health_status === 'red' || (h.health_status === 'yellow' && h.days_since_contact >= 5))
    .sort((a, b) => a.score - b.score);

  if (atRisk.length > 0) {
    brief += `<b>Needs Attention</b>\n`;
    for (const c of atRisk.slice(0, 4)) {
      const icon = c.health_status === 'red' ? '🔴' : '🟡';
      const firm = c.firm_name ? ` — ${c.firm_name}` : '';
      brief += `${icon} <b>${c.client_name}</b>${firm}\n`;
      brief += `    ${c.days_since_contact}d since last contact · score ${c.score}/100\n`;
    }
    brief += '\n';
  }

  // ── 3. Your to-dos (team actions, grouped by client) ──
  const teamActions = d.prepare(`
    SELECT a.description, a.due_date, c.name as client_name
    FROM actions a
    LEFT JOIN clients c ON a.client_id = c.id
    WHERE a.status = 'open' AND a.owner = 'us'
    ORDER BY a.due_date ASC NULLS LAST, a.created_at DESC
    LIMIT 8
  `).all();

  if (teamActions.length > 0) {
    brief += `<b>Your To-Dos</b>\n`;
    for (const a of teamActions) {
      const who = a.client_name ? `[${a.client_name}] ` : '';
      const due = a.due_date ? ` <i>(due ${a.due_date})</i>` : '';
      brief += `• ${who}${a.description}${due}\n`;
    }
    const totalTeam = d.prepare(`SELECT COUNT(*) as c FROM actions WHERE status = 'open' AND owner = 'us'`).get().c;
    if (totalTeam > teamActions.length) {
      brief += `<i>+${totalTeam - teamActions.length} more in Command Centre</i>\n`;
    }
    brief += '\n';
  }

  // ── 4. Waiting on clients ──
  const clientActions = d.prepare(`
    SELECT a.description, c.name as client_name
    FROM actions a
    LEFT JOIN clients c ON a.client_id = c.id
    WHERE a.status = 'open' AND a.owner = 'client'
    ORDER BY a.created_at DESC
    LIMIT 5
  `).all();

  if (clientActions.length > 0) {
    brief += `<b>Waiting On</b>\n`;
    for (const a of clientActions) {
      const who = a.client_name ? `[${a.client_name}] ` : '';
      brief += `• ${who}${a.description}\n`;
    }
    const totalClient = d.prepare(`SELECT COUNT(*) as c FROM actions WHERE status = 'open' AND owner = 'client'`).get().c;
    if (totalClient > clientActions.length) {
      brief += `<i>+${totalClient - clientActions.length} more</i>\n`;
    }
    brief += '\n';
  }

  // ── 5. Recent meetings (last 7 days) ──
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const recentMeetings = d.prepare(`
    SELECT title, date, meeting_type, client_name, sentiment
    FROM meetings
    WHERE date >= ? AND meeting_type != 'internal'
    ORDER BY date DESC
    LIMIT 5
  `).all(weekAgo);

  // Filter out meetings with junk titles (Google Meet codes like "abc-defg-hij")
  const isMeetCode = (s) => /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(s);
  const cleanMeetings = recentMeetings.filter(m => m.client_name || !isMeetCode(m.title));

  if (cleanMeetings.length > 0) {
    brief += `<b>This Week's Calls</b>\n`;
    for (const m of cleanMeetings) {
      const day = new Date(m.date).toLocaleDateString('en-US', { weekday: 'short' });
      const type = m.meeting_type ? ` · ${m.meeting_type}` : '';
      const name = m.client_name || m.title;
      const mood = m.sentiment === 'positive' ? ' ✓' : m.sentiment === 'negative' ? ' ✗' : '';
      brief += `• ${day}: <b>${name}</b>${type}${mood}\n`;
    }
    brief += '\n';
  }

  // ── 6. Top patterns (what prospects keep saying) ──
  const patterns = db.getPatterns({ limit: 10 });
  const topPatterns = patterns.filter(p => p.frequency >= 3).slice(0, 2);
  if (topPatterns.length > 0) {
    brief += `<b>What Prospects Keep Saying</b>\n`;
    for (const p of topPatterns) {
      brief += `• ${p.description} <i>(${p.frequency}x)</i>\n`;
    }
    brief += '\n';
  }

  // ── 7. Coaching focus (pick the single most common improvement) ──
  const meetings = db.getMeetings({ limit: 10 });
  const improvements = meetings
    .filter(m => m.coaching_notes && m.coaching_notes.improvements)
    .flatMap(m => m.coaching_notes.improvements);
  if (improvements.length > 0) {
    // Pick the shortest, most actionable one
    const tip = improvements.sort((a, b) => a.length - b.length)[0];
    brief += `<b>Coaching Focus</b>\n• ${tip}\n\n`;
  }

  // ── Footer ──
  const url = process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : 'localhost:3099';
  brief += `<a href="${url}">Open Command Centre</a>`;

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
