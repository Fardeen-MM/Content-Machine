const { loadEnv } = require('../lib/utils');
const db = require('../lib/db');
const { callClaude, SONNET } = require('../lib/claude');
const { getKnowledgeBase } = require('../lib/knowledge');
const { buildIntelligenceContext } = require('../lib/intelligence');
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

function gatherBriefData() {
  db.initDb();
  const d = db.getDb();
  const now = new Date();
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

  const healthOverview = db.getHealthOverview();
  const stats = db.getStats();

  // Open actions grouped by owner with client names
  const teamActions = d.prepare(`
    SELECT a.description, a.due_date, a.owner, c.name as client_name, c.firm_name
    FROM actions a LEFT JOIN clients c ON a.client_id = c.id
    WHERE a.status = 'open' ORDER BY a.owner, a.created_at DESC
  `).all();

  // Recent meetings
  const recentMeetings = d.prepare(`
    SELECT title, date, meeting_type, client_name, sentiment, summary
    FROM meetings WHERE date >= ? AND meeting_type != 'internal'
    ORDER BY date DESC LIMIT 10
  `).all(weekAgo);

  // Pending proposals
  const pendingProposals = d.prepare(`
    SELECT p.title, p.monthly_value, p.status, p.created_at, c.name as client_name
    FROM proposals p LEFT JOIN clients c ON p.client_id = c.id
    WHERE p.status IN ('draft', 'sent') ORDER BY p.created_at DESC
  `).all();

  // Top patterns
  const patterns = db.getPatterns({ limit: 5 }).filter(p => p.frequency >= 2);

  // Stale deals
  const staleClients = (healthOverview.clients || [])
    .filter(h => h.days_since_contact >= 5)
    .sort((a, b) => b.days_since_contact - a.days_since_contact);

  // Pestering due today
  const duePestering = db.getPesterEntries({ status: 'pending', due_before: now.toISOString(), limit: 10 });

  // Pending content for Monty (review status = needs approval)
  const { readJSON } = require('../lib/utils');
  const allContent = readJSON('content.json');
  const pendingContent = allContent.filter(c => c.status === 'review').slice(0, 10);

  // Deal outcomes from past 7 days
  let recentDeals = [];
  try {
    recentDeals = d.prepare(`
      SELECT d.*, c.name as client_name, c.firm_name
      FROM deal_outcomes d LEFT JOIN clients c ON d.client_id = c.id
      WHERE d.recorded_at >= ? ORDER BY d.recorded_at DESC LIMIT 10
    `).all(weekAgo);
  } catch (err) { console.error('[brief] Failed to load recent deals:', err.message); }

  // Performance metrics from performance.json (7-day window)
  let perfSummary = null;
  try {
    const perfData = readJSON('performance.json', []);
    const recentPerf = perfData.filter(p => p.recorded_at >= weekAgo || p.published_at >= weekAgo);
    if (recentPerf.length > 0) {
      const totalEng = recentPerf.reduce((s, p) => s + (p.engagement || 0), 0);
      const totalImp = recentPerf.reduce((s, p) => s + (p.impressions || 0), 0);
      const totalLeads = recentPerf.reduce((s, p) => s + (p.leads || 0), 0);
      perfSummary = {
        posts: recentPerf.length,
        engagement: totalEng,
        impressions: totalImp,
        leads: totalLeads,
        avg_engagement: recentPerf.length > 0 ? Math.round(totalEng / recentPerf.length) : 0
      };
    }
  } catch (err) { console.error('[brief] Failed to load performance data:', err.message); }

  // Rejection trends from memory.json (recent)
  let rejectionTrend = null;
  try {
    const memory = readJSON('memory.json', {});
    const rejections = memory.rejection_patterns || [];
    const recentRejections = rejections.filter(r => r.rejected_at >= weekAgo);
    if (recentRejections.length > 0) {
      const reasons = {};
      for (const r of recentRejections) {
        const key = r.reason || 'other';
        reasons[key] = (reasons[key] || 0) + 1;
      }
      rejectionTrend = {
        count: recentRejections.length,
        topReasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 3)
      };
    }
  } catch (err) { console.error('[brief] Failed to load rejection trends:', err.message); }

  // New/updated patterns from past 7 days
  let newPatterns = [];
  try {
    newPatterns = d.prepare(`
      SELECT * FROM patterns WHERE last_seen >= ? ORDER BY frequency DESC LIMIT 5
    `).all(weekAgo);
  } catch (err) { console.error('[brief] Failed to load patterns:', err.message); }

  return {
    date: now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }),
    health: healthOverview.summary || {},
    stats,
    teamActions,
    recentMeetings,
    pendingProposals,
    patterns,
    staleClients,
    duePestering,
    pendingContent,
    recentDeals,
    perfSummary,
    rejectionTrend,
    newPatterns
  };
}

async function generateBrief() {
  console.log('[brief] Generating daily brief...');

  const data = gatherBriefData();
  const kb = getKnowledgeBase();
  const intel = buildIntelligenceContext();

  // Build data context
  const ctx = [];
  ctx.push(`DATE: ${data.date}`);
  ctx.push(`HEALTH: ${data.health.total || 0} prospects — ${data.health.green || 0} green, ${data.health.yellow || 0} yellow, ${data.health.red || 0} red`);
  ctx.push(`PIPELINE: ${data.stats.meetings?.total || 0} meetings, ${data.stats.clients?.total || 0} clients, ${data.stats.actions?.open || 0} open actions`);

  if (data.staleClients.length > 0) {
    ctx.push('\nSTALE DEALS:');
    for (const c of data.staleClients.slice(0, 8)) {
      ctx.push(`- ${c.client_name}${c.firm_name ? ' (' + c.firm_name + ')' : ''}: ${c.days_since_contact}d silent, score ${c.score}/100`);
    }
  }

  if (data.teamActions.length > 0) {
    const byOwner = {};
    for (const a of data.teamActions) { (byOwner[a.owner || 'unassigned'] = byOwner[a.owner || 'unassigned'] || []).push(a); }
    for (const [owner, actions] of Object.entries(byOwner)) {
      ctx.push(`\n${owner.toUpperCase()} ACTIONS (${actions.length}):`);
      for (const a of actions.slice(0, 5)) {
        ctx.push(`- ${a.client_name ? '[' + a.client_name + '] ' : ''}${a.description}${a.due_date ? ' (due: ' + a.due_date + ')' : ''}`);
      }
    }
  }

  if (data.pendingProposals.length > 0) {
    ctx.push('\nPENDING PROPOSALS:');
    for (const p of data.pendingProposals) {
      ctx.push(`- ${p.client_name || 'Unknown'}: ${p.title} ($${p.monthly_value || 0}/mo) [${p.status}]`);
    }
  }

  if (data.recentMeetings.length > 0) {
    ctx.push(`\nTHIS WEEK'S CALLS (${data.recentMeetings.length}):`);
    for (const m of data.recentMeetings.slice(0, 5)) {
      ctx.push(`- ${m.client_name || m.title} (${m.meeting_type}) — ${m.sentiment || 'unknown'}`);
    }
  }

  if (data.patterns.length > 0) {
    ctx.push('\nTOP PATTERNS:');
    for (const p of data.patterns) {
      ctx.push(`- ${p.description} (${p.frequency}x)`);
    }
  }

  if (data.duePestering.length > 0) {
    ctx.push('\nPESTERING DUE TODAY:');
    for (const p of data.duePestering) {
      ctx.push(`- ${p.client_name || '?'}: ${p.channel} — ${p.message_type}`);
    }
  }

  if (data.pendingContent.length > 0) {
    ctx.push(`\nPENDING CONTENT FOR MONTY (${data.pendingContent.length} posts awaiting review):`);
    for (const c of data.pendingContent.slice(0, 5)) {
      const preview = (c.formats?.linkedin?.content || c.trigger_title || '').slice(0, 100);
      ctx.push(`- [${c.id}] ${preview}${preview.length >= 100 ? '...' : ''}`);
    }
    ctx.push('Approve in dashboard or reply "approve [id]"');
  }

  if (data.recentDeals.length > 0) {
    const won = data.recentDeals.filter(d => d.outcome === 'won');
    const lost = data.recentDeals.filter(d => d.outcome === 'lost' || d.outcome === 'ghosted');
    ctx.push(`\nDEAL OUTCOMES THIS WEEK (${data.recentDeals.length} total — ${won.length} won, ${lost.length} lost):`);
    for (const d of data.recentDeals.slice(0, 5)) {
      const icon = d.outcome === 'won' ? '✅' : '❌';
      ctx.push(`${icon} ${d.client_name || 'Unknown'}${d.monthly_value ? ' $' + d.monthly_value + '/mo' : ''} — ${d.outcome}${d.loss_reason ? ': ' + d.loss_reason : ''}${d.what_worked ? ' | Worked: ' + d.what_worked : ''}`);
    }
  }

  if (data.perfSummary) {
    ctx.push(`\nCONTENT PERFORMANCE (7-day): ${data.perfSummary.posts} posts, ${data.perfSummary.engagement} engagements, ${data.perfSummary.impressions} impressions, ${data.perfSummary.leads} leads. Avg engagement: ${data.perfSummary.avg_engagement}/post`);
  }

  if (data.rejectionTrend) {
    ctx.push(`\nREJECTION TREND: ${data.rejectionTrend.count} rejected this week. Top reasons: ${data.rejectionTrend.topReasons.map(([r, c]) => r + ' (' + c + 'x)').join(', ')}`);
  }

  if (data.newPatterns.length > 0) {
    ctx.push('\nNEW/UPDATED PATTERNS THIS WEEK:');
    for (const p of data.newPatterns) {
      ctx.push(`- [${p.type}] ${p.description} (${p.frequency}x)`);
    }
  }

  const liveData = ctx.join('\n');

  const prompt = `Generate the morning brief for ${data.date}. This replaces the daily whiteboard session.

${liveData}

MAX 3500 chars. Use HTML tags (<b>, <i>, bullet •). NO markdown.

Structure:
1. THE BOTTLENECK — one line. The #1 constraint right now. A number.
2. DEAL OUTCOMES — if any: wins/losses this week, revenue impact, key learnings from losses.
3. YASEER — 3-5 SPECIFIC actions. Handhold completely. Names, what to say, links. He needs to be told exactly what to do.
4. MONTY — content/outreach tasks. If pending content exists, tell him exactly how many posts to review and approve. If content performance data exists, mention what's working.
5. FARDEEN — the strategic fix or system to build today.
6. STALE DEALS — if any: name, days silent, suggested action.
7. CONTENT PERFORMANCE — if data exists: what formats/topics are getting engagement, what to double down on, what to stop.

Be DIRECTIVE. "$4K deal dies Friday if nobody calls." Not "consider following up."
Keep it scannable on a phone screen. No fluff.`;

  if (!process.env.ANTHROPIC_API_KEY) {
    // Fallback: simple template brief if no API key
    return buildFallbackBrief(data);
  }

  try {
    const text = await callClaude({
      model: SONNET,
      system: `${kb}\n\n${intel}\n\nYou generate the daily morning brief for Mortar Metrics. Be a senior agency consultant. Direct. Numbers. Name names. Give deadlines. Think in revenue. Output HTML for Telegram (use <b>, <i>, •). No markdown.`,
      prompt,
      maxTokens: 1500
    });
    return text;
  } catch (err) {
    console.error('[brief] AI generation failed, using fallback:', err.message);
    return buildFallbackBrief(data);
  }
}

function buildFallbackBrief(data) {
  let brief = `<b>Daily Brief</b> — ${data.date}\n`;
  brief += `${data.health.total || 0} prospects · 🟢${data.health.green || 0} 🟡${data.health.yellow || 0} 🔴${data.health.red || 0}\n\n`;

  if (data.staleClients.length > 0) {
    for (const c of data.staleClients.slice(0, 3)) {
      brief += `🔴 <b>${c.client_name}</b> — ${c.days_since_contact}d silent\n`;
    }
    brief += '\n';
  }

  const teamTodos = data.teamActions.filter(a => a.owner === 'us').slice(0, 3);
  if (teamTodos.length > 0) {
    brief += `<b>To-do</b>\n`;
    for (const a of teamTodos) {
      brief += `• ${a.client_name ? a.client_name + ': ' : ''}${a.description}\n`;
    }
    brief += '\n';
  }

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

if (require.main === module) {
  run();
}

module.exports = { generateBrief, sendTelegram };
