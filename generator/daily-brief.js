const { loadEnv } = require('../lib/utils');
const db = require('../lib/db');
const { callClaude, HAIKU } = require('../lib/claude');
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

  const body = JSON.stringify({
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'HTML'
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

  const stats = db.getStats();
  const actions = db.getActions({ status: 'open' });
  const clients = db.getClients({});
  const meetings = db.getMeetings({ limit: 10 });
  const patterns = db.getPatterns({ limit: 10 });

  // Find stale deals (no meeting in 5+ days)
  const now = new Date();
  const staleClients = clients.filter(c => {
    if (!c.last_seen) return false;
    const daysSince = Math.floor((now - new Date(c.last_seen)) / (1000 * 60 * 60 * 24));
    return daysSince >= 5 && c.status === 'prospect';
  }).map(c => {
    const daysSince = Math.floor((now - new Date(c.last_seen)) / (1000 * 60 * 60 * 24));
    return { ...c, daysSince };
  }).sort((a, b) => b.daysSince - a.daysSince);

  // Group actions by owner
  const actionsByOwner = {};
  for (const a of actions) {
    const owner = a.owner || 'unassigned';
    if (!actionsByOwner[owner]) actionsByOwner[owner] = [];
    actionsByOwner[owner].push(a);
  }

  // Recent meetings this week
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const thisWeekMeetings = meetings.filter(m => new Date(m.date) >= weekAgo);

  // Coaching insights (average scores)
  const coachingScores = meetings
    .filter(m => m.coaching_notes && m.coaching_notes.score != null)
    .map(m => m.coaching_notes.score);
  const avgScore = coachingScores.length > 0
    ? Math.round(coachingScores.reduce((a, b) => a + b, 0) / coachingScores.length)
    : null;

  // Top coaching improvements
  const recentImprovements = meetings
    .filter(m => m.coaching_notes && m.coaching_notes.improvements)
    .flatMap(m => m.coaching_notes.improvements)
    .slice(0, 3);

  // Build the brief
  const dayName = now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });

  let brief = `<b>MORTAR METRICS — DAILY BRIEF</b>\n${dayName}\n\n`;

  // Stale deals (URGENT)
  if (staleClients.length > 0) {
    brief += `<b>STALE DEALS</b>\n`;
    for (const c of staleClients.slice(0, 5)) {
      const urgency = c.daysSince >= 10 ? '🚨' : '⚠️';
      brief += `${urgency} <b>${c.name}</b>${c.firm_name ? ` (${c.firm_name})` : ''} — ${c.daysSince} days silent\n`;
    }
    brief += '\n';
  }

  // Actions by person
  const teamMap = { us: 'TEAM', client: 'CLIENT' };
  for (const [owner, ownerActions] of Object.entries(actionsByOwner)) {
    const label = teamMap[owner] || owner.toUpperCase();
    brief += `<b>${label}</b>\n`;
    for (const a of ownerActions.slice(0, 5)) {
      brief += `• ${a.description}\n`;
    }
    if (ownerActions.length > 5) {
      brief += `  <i>...and ${ownerActions.length - 5} more</i>\n`;
    }
    brief += '\n';
  }

  // Pipeline stats
  brief += `<b>PIPELINE</b>\n`;
  brief += `• ${stats.meetings.total} meetings | ${stats.clients.total} clients | ${stats.actions.open} open actions\n`;
  brief += `• This week: ${thisWeekMeetings.length} meetings\n`;
  if (avgScore !== null) {
    brief += `• Avg coaching score: ${avgScore}/100\n`;
  }
  brief += '\n';

  // Coaching tip
  if (recentImprovements.length > 0) {
    brief += `<b>COACHING TIP</b>\n`;
    brief += `• ${recentImprovements[0].slice(0, 200)}\n\n`;
  }

  // Patterns
  if (patterns.length > 0) {
    const topPatterns = patterns.filter(p => p.frequency >= 2).slice(0, 3);
    if (topPatterns.length > 0) {
      brief += `<b>RECURRING PATTERNS</b>\n`;
      for (const p of topPatterns) {
        brief += `• [${p.type}] ${p.description} (${p.frequency}x)\n`;
      }
      brief += '\n';
    }
  }

  brief += `<i>Command Centre: ${process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : 'localhost:3099'}</i>`;

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
