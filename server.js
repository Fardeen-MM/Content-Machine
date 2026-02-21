const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadEnv, readJSON, writeJSON, backupJSON, generateId, now, daysAgo } = require('./lib/utils');
const jsonStore = require('./lib/json-store');
const db = require('./lib/db');
const fireflies = require('./lib/fireflies');
const { processMeeting } = require('./lib/meeting-processor');

loadEnv();

// Initialize SQLite database
db.initDb();

const PORT = process.env.PORT || 3000;

// Batch generation progress tracking
const _batchProgress = {};

// Auto-schedule content to the next available calendar slot
function autoScheduleContent(contentItem) {
  try {
    const calendarData = readJSON('calendar.json', {});
    const formatToPlatform = {
      linkedin: 'linkedin', carousel: 'linkedin', poll: 'linkedin',
      quote_cards: 'linkedin', listicle: 'linkedin', hot_take: 'linkedin',
      before_after: 'linkedin', stat_graphic: 'linkedin',
      x_single: 'x', x_thread: 'x',
      short_video: 'video',
      blog: 'blog', case_study: 'blog',
      newsletter: 'email', lead_magnet: 'email',
      youtube_script: 'youtube'
    };
    const platformTimePrefs = {
      linkedin: ['morning', 'midday'], x: ['morning', 'midday', 'evening'],
      video: ['midday'], blog: ['morning'], email: ['morning'], youtube: ['midday']
    };

    // Find first format with content
    const formats = Object.entries(contentItem.formats || {})
      .filter(([, fmt]) => fmt.content && fmt.status !== 'rejected');
    if (formats.length === 0) return null;

    const [format] = formats[0];
    const platform = formatToPlatform[format];
    if (!platform) return null;

    const times = platformTimePrefs[platform] || ['morning'];

    // Look ahead 14 days for an open slot
    const today = new Date();
    for (let i = 0; i < 14; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      const dateKey = d.toISOString().split('T')[0];

      for (const time of times) {
        const slotKey = `${platform}_${time}`;
        if (!calendarData[dateKey]?.[slotKey]) {
          if (!calendarData[dateKey]) calendarData[dateKey] = {};
          calendarData[dateKey][slotKey] = {
            content_id: contentItem.id,
            format,
            title: (contentItem.trigger_title || '').slice(0, 80),
            status: 'review',
            auto_scheduled: true,
            assigned_at: now()
          };
          writeJSON('calendar.json', calendarData);
          console.log(`[auto-schedule] ${contentItem.id} → ${dateKey} ${slotKey}`);
          return { date: dateKey, slot: slotKey, format };
        }
      }
    }
    return null;
  } catch (err) {
    console.error('[auto-schedule] Error:', err.message);
    return null;
  }
}

// --- Helpers ---

function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1_000_000) { req.destroy(); reject(new Error('Body too large')); }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function parseRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1_000_000) { req.destroy(); reject(new Error('Body too large')); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function verifyHmac(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const computed = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
}

function verifySecret(provided, expected) {
  if (!provided || !expected) return false;
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

function buildChatContext(question) {
  const q = question.toLowerCase();
  const parts = [];

  // Always include high-level stats
  const stats = db.getStats();
  parts.push(`STATS: ${stats.meetings.total} meetings, ${stats.clients.total} clients, ${stats.actions.open} open actions, ${stats.atoms} content atoms`);

  // Meeting questions
  if (q.includes('meeting') || q.includes('call') || q.includes('transcript') || q.includes('coaching') || q.includes('score')) {
    const meetings = db.getMeetings({ limit: 15 });
    parts.push('RECENT MEETINGS:');
    for (const m of meetings) {
      const score = m.coaching_notes ? ` | Score: ${m.coaching_notes.score}/100` : '';
      parts.push(`- ${m.date?.slice(0, 10)} | ${m.title} | Type: ${m.meeting_type} | Client: ${m.client_name || 'N/A'}${score}`);
    }
  }

  // Client questions
  if (q.includes('client') || q.includes('prospect') || q.includes('pipeline') || q.includes('deal') || q.includes('stale') || q.includes('ghost') || q.includes('follow up')) {
    const clients = db.getClients({ limit: 30 });
    const now = new Date();
    parts.push('CLIENTS:');
    for (const c of clients) {
      const daysSince = c.last_seen ? Math.floor((now - new Date(c.last_seen)) / 86400000) : '?';
      const health = daysSince >= 10 ? 'RED' : daysSince >= 5 ? 'YELLOW' : 'GREEN';
      parts.push(`- ${c.name} | ${c.firm_name || 'no firm'} | ${c.status} | ${(c.practice_areas || []).join(', ')} | Last seen: ${daysSince} days ago [${health}]`);
    }
  }

  // Action questions
  if (q.includes('action') || q.includes('task') || q.includes('todo') || q.includes('do today') || q.includes('do next') || q.includes('should') || q.includes('yaseer') || q.includes('fardeen') || q.includes('monty') || q.includes('juhi')) {
    const actions = db.getActions({ status: 'open' });
    parts.push(`OPEN ACTIONS (${actions.length} total):`);
    for (const a of actions.slice(0, 20)) {
      parts.push(`- [${a.owner || 'unassigned'}] ${a.description}${a.due_date ? ' (due: ' + a.due_date + ')' : ''}`);
    }
  }

  // Specific client/person lookup
  const nameMatch = q.match(/(?:about|with|for|from)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
  if (nameMatch) {
    const name = nameMatch[1];
    const meetings = db.searchMeetings(name);
    if (meetings.length > 0) {
      parts.push(`MEETINGS MENTIONING "${name}":`);
      for (const m of meetings.slice(0, 5)) {
        const ed = m.extracted_data || {};
        parts.push(`- ${m.date?.slice(0, 10)} | ${m.title} | Summary: ${(m.summary || '').slice(0, 200)}`);
        if (ed.pain_points?.length) parts.push(`  Pain points: ${ed.pain_points.join('; ')}`);
        if (ed.action_items?.length) parts.push(`  Actions: ${ed.action_items.map(a => a.description).join('; ')}`);
      }
    }
  }

  // Content questions
  if (q.includes('content') || q.includes('post') || q.includes('linkedin') || q.includes('trigger') || q.includes('generate')) {
    try {
      const triggers = readJSON('trigger-queue.json');
      const content = readJSON('content.json');
      const pending = triggers.filter(t => t.status === 'pending').length;
      const review = content.filter(c => c.status === 'review').length;
      const approved = content.filter(c => c.status === 'approved').length;
      parts.push(`CONTENT: ${triggers.length} triggers (${pending} pending), ${content.length} pieces (${review} in review, ${approved} approved)`);
    } catch {}
  }

  // Pattern questions
  if (q.includes('pattern') || q.includes('objection') || q.includes('pain') || q.includes('trend') || q.includes('recurring') || q.includes('bottleneck')) {
    const patterns = db.getPatterns({ limit: 15 });
    if (patterns.length > 0) {
      parts.push('PATTERNS:');
      for (const p of patterns.slice(0, 10)) {
        parts.push(`- [${p.type}] ${p.description} (seen ${p.frequency}x)`);
      }
    }
  }

  // "What should I/we do" or general overview — include everything relevant
  if (q.includes('what should') || q.includes('priority') || q.includes('urgent') || q.includes('overview') || q.includes('status') || q.includes('how are') || q.includes('morning')) {
    const clients = db.getClients({ limit: 30 });
    const now = new Date();
    const stale = clients.filter(c => {
      if (!c.last_seen) return false;
      return Math.floor((now - new Date(c.last_seen)) / 86400000) >= 5 && c.status === 'prospect';
    });
    if (stale.length > 0) {
      parts.push('STALE DEALS (5+ days no contact):');
      for (const c of stale) {
        const days = Math.floor((now - new Date(c.last_seen)) / 86400000);
        parts.push(`- ${c.name}${c.firm_name ? ' (' + c.firm_name + ')' : ''}: ${days} days silent`);
      }
    }
    const actions = db.getActions({ status: 'open' });
    if (actions.length > 0 && !parts.some(p => p.includes('OPEN ACTIONS'))) {
      parts.push(`OPEN ACTIONS: ${actions.length} total`);
      for (const a of actions.slice(0, 10)) {
        parts.push(`- [${a.owner || '?'}] ${a.description}`);
      }
    }
  }

  return parts.join('\n');
}

function serveStatic(res, filePath, contentType) {
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// --- Telegram alerts ---

function sendTelegramAlert(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
  const req = require('https').request({
    hostname: 'api.telegram.org', path: `/bot${token}/sendMessage`, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { if (res.statusCode !== 200) console.error('[alert] Telegram:', d); }); });
  req.on('error', (e) => console.error('[alert] Telegram error:', e.message));
  req.write(body);
  req.end();
}

// --- API Routes ---

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const method = req.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  try {
    // --- API Routes ---

    // GET /api/stats
    if (pathname === '/api/stats' && method === 'GET') {
      const triggers = readJSON('trigger-queue.json');
      const content = readJSON('content.json');
      const published = readJSON('published.json');

      const bySource = {};
      const byCategory = {};
      for (const t of triggers) {
        bySource[t.source] = (bySource[t.source] || 0) + 1;
        byCategory[t.category] = (byCategory[t.category] || 0) + 1;
      }

      let approvedFormats = 0;
      let reviewFormats = 0;
      let rejectedFormats = 0;
      for (const c of content) {
        for (const [, fmt] of Object.entries(c.formats || {})) {
          if (fmt.status === 'approved') approvedFormats++;
          else if (fmt.status === 'rejected') rejectedFormats++;
          else reviewFormats++;
        }
      }

      // Include knowledge base stats
      let kbStats = {};
      try { kbStats = db.getStats(); } catch {}

      return json(res, {
        triggers: {
          total: triggers.length,
          pending: triggers.filter(t => t.status === 'pending').length,
          used: triggers.filter(t => t.status === 'used').length,
          rejected: triggers.filter(t => t.status === 'rejected').length,
          by_source: bySource,
          by_category: byCategory
        },
        content: {
          total: content.length,
          review: content.filter(c => c.status === 'review').length,
          approved: content.filter(c => c.status === 'approved').length,
          rejected: content.filter(c => c.status === 'rejected').length
        },
        formats: { approved: approvedFormats, review: reviewFormats, rejected: rejectedFormats },
        published: published.length,
        knowledge: kbStats
      });
    }

    // GET /api/funnel — content funnel analytics
    if (pathname === '/api/funnel' && method === 'GET') {
      const triggers = readJSON('trigger-queue.json');
      const content = readJSON('content.json');
      const published = readJSON('published.json');
      const perfData = readJSON('performance.json');
      const archived = readJSON('archived-triggers.json');
      // Funnel stages
      const totalTriggers = triggers.length + archived.length;
      const pendingTriggers = triggers.filter(t => t.status === 'pending').length;
      const usedTriggers = triggers.filter(t => t.status === 'used').length;
      const generated = content.length;
      const reviewed = content.filter(c => c.status !== 'review').length;
      const approved = content.filter(c => {
        return Object.values(c.formats || {}).some(f => f.status === 'approved');
      }).length;
      const publishedCount = published.length;
      const withLeads = perfData.filter(p => (p.leads || 0) > 0).length;
      const totalLeads = perfData.reduce((s, p) => s + (p.leads || 0), 0);
      // Conversion rates
      const funnel = [
        { stage: 'Scraped', count: totalTriggers, rate: 100 },
        { stage: 'Pending', count: pendingTriggers, rate: totalTriggers > 0 ? Math.round(pendingTriggers / totalTriggers * 100) : 0 },
        { stage: 'Generated', count: generated, rate: totalTriggers > 0 ? Math.round(generated / totalTriggers * 100) : 0 },
        { stage: 'Reviewed', count: reviewed, rate: generated > 0 ? Math.round(reviewed / generated * 100) : 0 },
        { stage: 'Approved', count: approved, rate: generated > 0 ? Math.round(approved / generated * 100) : 0 },
        { stage: 'Published', count: publishedCount, rate: approved > 0 ? Math.round(publishedCount / approved * 100) : 0 },
        { stage: 'Got Leads', count: withLeads, rate: publishedCount > 0 ? Math.round(withLeads / publishedCount * 100) : 0 }
      ];
      // Content queue health
      const approvedFormats = content.reduce((sum, c) => {
        return sum + Object.values(c.formats || {}).filter(f => f.status === 'approved' && !f.published_at).length;
      }, 0);
      const postsPerDay = 2; // Assume 2 posts/day
      const daysOfContent = Math.floor(approvedFormats / postsPerDay);
      const queueHealth = daysOfContent >= 7 ? 'healthy' : daysOfContent >= 3 ? 'low' : 'critical';
      return json(res, {
        funnel,
        queue: { approved_formats: approvedFormats, days_remaining: daysOfContent, health: queueHealth, posts_per_day: postsPerDay },
        totals: { triggers: totalTriggers, content: generated, published: publishedCount, leads: totalLeads }
      });
    }

    // GET /api/triggers
    if (pathname === '/api/triggers' && method === 'GET') {
      let triggers = readJSON('trigger-queue.json');
      const source = url.searchParams.get('source');
      const category = url.searchParams.get('category');
      const status = url.searchParams.get('status');
      const search = url.searchParams.get('q');
      const limit = parseInt(url.searchParams.get('limit')) || 0;
      const offset = parseInt(url.searchParams.get('offset')) || 0;

      if (source) triggers = triggers.filter(t => t.source === source);
      if (category) triggers = triggers.filter(t => t.category === category);
      if (status) triggers = triggers.filter(t => t.status === status);
      if (search) {
        const q = search.toLowerCase();
        triggers = triggers.filter(t => `${t.title || ''} ${t.raw_content || ''}`.toLowerCase().includes(q));
      }

      // Score triggers
      const { scoreTrigger } = require('./generator/score-triggers');
      triggers = triggers.map(t => ({ ...t, score: scoreTrigger(t) }));
      triggers.sort((a, b) => b.score - a.score);

      const total = triggers.length;
      if (limit > 0) {
        triggers = triggers.slice(offset, offset + limit);
        return json(res, { items: triggers, total, limit, offset });
      }
      return json(res, triggers);
    }

    // GET /api/content
    if (pathname === '/api/content' && method === 'GET') {
      let content = readJSON('content.json');
      const status = url.searchParams.get('status');
      const format = url.searchParams.get('format');
      const search = url.searchParams.get('q');
      const includeArchived = url.searchParams.get('archived') === 'true';
      const limit = parseInt(url.searchParams.get('limit')) || 0;
      const offset = parseInt(url.searchParams.get('offset')) || 0;

      // Exclude archived by default unless explicitly requested
      if (!includeArchived && status !== 'archived') {
        content = content.filter(c => c.status !== 'archived');
      }
      if (status) content = content.filter(c => c.status === status);
      if (search) {
        const q = search.toLowerCase();
        content = content.filter(c => {
          const meta = `${c.trigger_title || ''} ${c.trigger_source || ''} ${c.trigger_category || ''}`.toLowerCase();
          if (meta.includes(q)) return true;
          for (const fmt of Object.values(c.formats || {})) {
            const txt = typeof fmt.content === 'string' ? fmt.content : '';
            if (txt.toLowerCase().includes(q)) return true;
          }
          return false;
        });
      }

      // Sort by generated_at descending
      content.sort((a, b) => new Date(b.generated_at) - new Date(a.generated_at));

      // Flag potential duplicates (similar trigger titles within content)
      const normTitle = (t) => (t || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
      for (let i = 0; i < content.length; i++) {
        const titleA = normTitle(content[i].trigger_title);
        const wordsA = new Set(titleA.split(' ').filter(w => w.length > 3));
        if (wordsA.size < 3) continue;
        for (let j = 0; j < content.length; j++) {
          if (i === j) continue;
          const titleB = normTitle(content[j].trigger_title);
          const wordsB = new Set(titleB.split(' ').filter(w => w.length > 3));
          if (wordsB.size < 3) continue;
          const overlap = [...wordsA].filter(w => wordsB.has(w)).length;
          const similarity = overlap / Math.min(wordsA.size, wordsB.size);
          if (similarity > 0.7) {
            if (!content[i]._similar_to) content[i]._similar_to = [];
            content[i]._similar_to.push(content[j].id);
          }
        }
      }

      const total = content.length;
      if (limit > 0) {
        content = content.slice(offset, offset + limit);
        return json(res, { items: content, total, limit, offset });
      }
      return json(res, content);
    }

    // GET /api/preview/:id/lead_magnet — render lead magnet HTML preview
    const previewMatch = pathname.match(/^\/api\/preview\/([a-f0-9]+)\/lead_magnet$/);
    if (previewMatch && method === 'GET') {
      const content = readJSON('content.json');
      const item = content.find(c => c.id === previewMatch[1]);
      if (!item) return json(res, { error: 'Not found' }, 404);
      const lmContent = item.formats?.lead_magnet?.content;
      if (!lmContent) return json(res, { error: 'No lead magnet generated for this content' }, 404);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(lmContent);
      return;
    }

    // GET /api/content/:id
    const contentMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)$/);
    if (contentMatch && method === 'GET') {
      const content = readJSON('content.json');
      const item = content.find(c => c.id === contentMatch[1]);
      if (!item) return json(res, { error: 'Not found' }, 404);
      return json(res, item);
    }

    // PUT /api/content/:id — update content (inline edits)
    const contentUpdateMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)$/);
    if (contentUpdateMatch && method === 'PUT') {
      const content = readJSON('content.json');
      const idx = content.findIndex(c => c.id === contentUpdateMatch[1]);
      if (idx === -1) return json(res, { error: 'Not found' }, 404);

      const body = await parseBody(req);

      // Update format content (only if format exists)
      if (body.format && body.content !== undefined) {
        if (!content[idx].formats[body.format]) {
          return json(res, { error: `Unknown format: ${body.format}` }, 400);
        }
        const trimmed = typeof body.content === 'string' ? body.content.trim() : body.content;
        if (typeof trimmed === 'string' && !trimmed) {
          return json(res, { error: 'Content cannot be empty' }, 400);
        }
        content[idx].formats[body.format].content = body.content;
        content[idx].formats[body.format].edited = true;
      }

      // Update notes
      if (body.notes !== undefined) {
        content[idx].notes = body.notes;
      }

      writeJSON('content.json', content);
      return json(res, { ok: true, ...content[idx] });
    }

    // POST /api/content/:id/approve
    const approveMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/approve$/);
    if (approveMatch && method === 'POST') {
      const content = readJSON('content.json');
      const idx = content.findIndex(c => c.id === approveMatch[1]);
      if (idx === -1) return json(res, { error: 'Not found' }, 404);

      const body = await parseBody(req);
      const format = body.format; // specific format, or null for all

      if (format && content[idx].formats[format]) {
        content[idx].formats[format].status = 'approved';
      } else {
        // Approve all formats
        for (const key of Object.keys(content[idx].formats)) {
          if (content[idx].formats[key].status !== 'rejected') {
            content[idx].formats[key].status = 'approved';
          }
        }
      }

      // Check if all formats are approved
      const allApproved = Object.values(content[idx].formats)
        .every(f => f.status === 'approved' || f.status === 'rejected');
      if (allApproved) content[idx].status = 'approved';

      writeJSON('content.json', content);

      // Auto-save approved formats to memory + learn from edits
      const memory = readJSON('memory.json', {});
      if (!memory.approved_examples) memory.approved_examples = [];
      if (!memory.style_notes) memory.style_notes = [];
      if (!memory.rejection_patterns) memory.rejection_patterns = [];
      const item = content[idx];
      const approvedFormats = Object.entries(item.formats)
        .filter(([, f]) => f.status === 'approved' && f.content);
      for (const [fmtKey, fmt] of approvedFormats) {
        const exists = memory.approved_examples.some(
          e => e.content_id === item.id && e.format === fmtKey
        );
        if (!exists) {
          memory.approved_examples.push({
            content_id: item.id,
            format: fmtKey,
            content: typeof fmt.content === 'string' ? fmt.content.slice(0, 2000) : JSON.stringify(fmt.content).slice(0, 2000),
            trigger_title: item.trigger_title,
            trigger_source: item.trigger_source,
            trigger_category: item.trigger_category,
            was_edited: !!fmt.edited,
            approved_at: now()
          });
          // Keep only last 30 examples per format (prioritize edited ones — they show preference)
          const byFormat = memory.approved_examples.filter(e => e.format === fmtKey);
          if (byFormat.length > 30) {
            // Remove oldest non-edited first, then oldest edited
            const nonEdited = byFormat.filter(e => !e.was_edited);
            const toRemove = nonEdited.length > 0 ? nonEdited[0] : byFormat[0];
            memory.approved_examples = memory.approved_examples.filter(e => e !== toRemove);
          }
        }
      }
      // Auto-generate style note if content was edited then approved
      const editedApproved = approvedFormats.filter(([, f]) => f.edited);
      if (editedApproved.length > 0) {
        const editNote = `User edited ${editedApproved.map(([k]) => k).join(', ')} before approving "${item.trigger_title}" — the edited versions are the preferred style.`;
        memory.style_notes.push({ note: editNote, added_at: now(), auto: true });
        // Keep last 50 style notes
        if (memory.style_notes.length > 50) memory.style_notes = memory.style_notes.slice(-50);
      }
      writeJSON('memory.json', memory);

      return json(res, { ok: true, ...content[idx] });
    }

    // POST /api/content/:id/reject
    const rejectMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/reject$/);
    if (rejectMatch && method === 'POST') {
      const content = readJSON('content.json');
      const idx = content.findIndex(c => c.id === rejectMatch[1]);
      if (idx === -1) return json(res, { error: 'Not found' }, 404);

      const body = await parseBody(req);
      const format = body.format;
      const reason = body.reason || 'other'; // too_generic, wrong_tone, missing_numbers, bad_hook, off_brand, other
      const suggestion = body.suggestion || '';

      if (format && content[idx].formats[format]) {
        content[idx].formats[format].status = 'rejected';
        content[idx].formats[format].rejection_reason = reason;
      } else {
        for (const key of Object.keys(content[idx].formats)) {
          content[idx].formats[key].status = 'rejected';
          content[idx].formats[key].rejection_reason = reason;
        }
        content[idx].status = 'rejected';
      }

      const noteText = `[${reason}] ${body.note || ''}${suggestion ? ' → ' + suggestion : ''}`.trim();
      if (noteText.length > 2) {
        content[idx].notes = (content[idx].notes || '') + `\nRejected: ${noteText}`;
      }

      writeJSON('content.json', content);

      // Learn from rejections — capture structured patterns to avoid
      const memory = readJSON('memory.json', {});
      if (!memory.rejection_patterns) memory.rejection_patterns = [];
      if (!memory.rejection_stats) memory.rejection_stats = {};
      const rejectedFormats = format
        ? [format]
        : Object.keys(content[idx].formats);
      for (const fmtKey of rejectedFormats) {
        const fmt = content[idx].formats[fmtKey];
        if (fmt?.content) {
          memory.rejection_patterns.push({
            format: fmtKey,
            trigger_title: content[idx].trigger_title,
            content_preview: (typeof fmt.content === 'string' ? fmt.content : JSON.stringify(fmt.content)).slice(0, 300),
            rejection_note: body.note || null,
            reason,
            suggestion: suggestion || null,
            rejected_at: now()
          });
          // Keep only last 50 rejection patterns
          if (memory.rejection_patterns.length > 50) memory.rejection_patterns = memory.rejection_patterns.slice(-50);

          // Track rejection stats by reason + format
          const statsKey = `${fmtKey}:${reason}`;
          memory.rejection_stats[statsKey] = (memory.rejection_stats[statsKey] || 0) + 1;
        }
      }
      writeJSON('memory.json', memory);

      return json(res, { ok: true, ...content[idx] });
    }

    // POST /api/content/:id/publish
    const publishMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/publish$/);
    if (publishMatch && method === 'POST') {
      const content = readJSON('content.json');
      const published = readJSON('published.json');
      const idx = content.findIndex(c => c.id === publishMatch[1]);
      if (idx === -1) return json(res, { error: 'Not found' }, 404);

      const body = await parseBody(req);
      const format = body.format;
      if (!format) return json(res, { error: 'format required' }, 400);

      const fmt = content[idx].formats[format] || {};
      const publishEntry = {
        content_id: content[idx].id,
        format,
        published_at: now(),
        platform: body.platform || format,
        url: body.url || null,
        title: content[idx].trigger_title || 'Untitled',
        category: content[idx].trigger_category || null,
        source: content[idx].trigger_source || null,
        hook_variant: fmt.selected_hook != null ? fmt.selected_hook : 'original',
        was_edited: fmt.edited || false,
        quality_score: content[idx].quality_score?.score || null
      };
      published.push(publishEntry);
      writeJSON('published.json', published);

      // Update content status
      if (content[idx].formats[format]) {
        content[idx].formats[format].status = 'published';
        content[idx].formats[format].published_at = now();
        content[idx].formats[format].publish_url = body.url || null;
      }
      writeJSON('content.json', content);

      return json(res, { ok: true, entry: publishEntry });
    }

    // POST /api/content/:id/archive — manually archive content
    const archiveMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/archive$/);
    if (archiveMatch && method === 'POST') {
      const content = readJSON('content.json');
      const idx = content.findIndex(c => c.id === archiveMatch[1]);
      if (idx === -1) return json(res, { error: 'Not found' }, 404);
      content[idx].status = 'archived';
      content[idx].archived_at = now();
      writeJSON('content.json', content);
      return json(res, { ok: true });
    }

    // GET /api/published — published content feed with enriched data
    if (pathname === '/api/published' && method === 'GET') {
      const published = readJSON('published.json');
      const perfData = readJSON('performance.json');
      const platform = url.searchParams.get('platform');
      let filtered = platform ? published.filter(p => p.platform === platform) : published;
      // Enrich with performance data
      filtered = filtered.map(p => {
        const perf = perfData.find(d => d.content_id === p.content_id && d.format === p.format);
        return { ...p, performance: perf || null };
      });
      // Sort newest first
      filtered.sort((a, b) => new Date(b.published_at || 0) - new Date(a.published_at || 0));
      return json(res, filtered);
    }

    // GET /api/publishing-queue — approved content ready to publish
    if (pathname === '/api/publishing-queue' && method === 'GET') {
      const content = readJSON('content.json');
      const published = readJSON('published.json');
      const publishedKeys = new Set(published.map(p => `${p.content_id}:${p.format}`));

      const queue = [];
      for (const item of content) {
        if (item.status === 'archived') continue;
        for (const [fmtKey, fmt] of Object.entries(item.formats || {})) {
          if (fmt.status !== 'approved') continue;
          if (publishedKeys.has(`${item.id}:${fmtKey}`)) continue;
          queue.push({
            content_id: item.id,
            format: fmtKey,
            trigger_title: item.trigger_title || 'Untitled',
            trigger_source: item.trigger_source,
            category: item.trigger_category,
            content: typeof fmt.content === 'string' ? fmt.content : JSON.stringify(fmt.content),
            quality_score: item.quality_score || 0,
            generated_at: item.generated_at,
            scheduled_for: fmt.scheduled_for || null,
            hook_variants: item.hook_variants?.[fmtKey === 'linkedin' ? 'linkedin' : 'x'] || []
          });
        }
      }
      // Sort: scheduled first (by date), then by quality score
      queue.sort((a, b) => {
        if (a.scheduled_for && !b.scheduled_for) return -1;
        if (!a.scheduled_for && b.scheduled_for) return 1;
        if (a.scheduled_for && b.scheduled_for) return a.scheduled_for.localeCompare(b.scheduled_for);
        return (b.quality_score || 0) - (a.quality_score || 0);
      });
      return json(res, { items: queue, total: queue.length });
    }

    // GET /api/series — content series templates
    if (pathname === '/api/series' && method === 'GET') {
      const series = readJSON('series.json');
      return json(res, series);
    }

    // GET /api/calendar — monthly or weekly calendar
    if (pathname === '/api/calendar' && method === 'GET') {
      const content = readJSON('content.json');
      const month = url.searchParams.get('month'); // e.g. "2026-02"
      if (month) {
        const { buildMonthlyCalendar } = require('./generator/calendar-builder');
        const calendarData = readJSON('calendar.json', {});
        const calendar = buildMonthlyCalendar(content, month, calendarData);
        return json(res, calendar);
      }
      // Legacy weekly fallback
      const { buildWeeklyCalendar } = require('./generator/calendar-builder');
      const calendar = buildWeeklyCalendar(content);
      return json(res, calendar);
    }

    // PUT /api/calendar/:date — assign content to a calendar slot
    const calDateMatch = pathname.match(/^\/api\/calendar\/(\d{4}-\d{2}-\d{2})$/);
    if (calDateMatch && method === 'PUT') {
      const dateKey = calDateMatch[1];
      const body = await parseBody(req);
      const { slot, content_id, format, title, preview } = body;
      if (!slot) return json(res, { error: 'slot required (e.g. linkedin_morning)' }, 400);

      const calendarData = readJSON('calendar.json', {});
      if (!calendarData[dateKey]) calendarData[dateKey] = {};

      if (body.clear) {
        delete calendarData[dateKey][slot];
      } else {
        calendarData[dateKey][slot] = {
          content_id: content_id || null,
          format: format || null,
          title: (title || '').slice(0, 80),
          preview: (preview || '').slice(0, 100),
          status: body.status || 'review',
          assigned_at: now()
        };
      }

      writeJSON('calendar.json', calendarData);
      return json(res, { ok: true, date: dateKey, slot });
    }

    // POST /api/calendar/auto-fill — auto-fill a week
    if (pathname === '/api/calendar/auto-fill' && method === 'POST') {
      const body = await parseBody(req);
      const weekStart = body.week_start;
      if (!weekStart) return json(res, { error: 'week_start required (YYYY-MM-DD)' }, 400);

      const content = readJSON('content.json');
      const calendarData = readJSON('calendar.json', {});
      const { autoFillWeek } = require('./generator/calendar-builder');
      const { assignments, assigned } = autoFillWeek(content, weekStart, calendarData);

      // Merge assignments into calendar data
      for (const [dateKey, slots] of Object.entries(assignments)) {
        if (!calendarData[dateKey]) calendarData[dateKey] = {};
        Object.assign(calendarData[dateKey], slots);
      }

      writeJSON('calendar.json', calendarData);
      return json(res, { ok: true, assigned, assignments });
    }

    // POST /api/calendar/generate — generate content for a calendar slot
    if (pathname === '/api/calendar/generate' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) {
        return json(res, { error: 'ANTHROPIC_API_KEY not configured' }, 500);
      }

      const body = await parseBody(req);
      const { date, slot, trigger_id } = body;
      if (!date || !slot) return json(res, { error: 'date and slot required' }, 400);

      try {
        const triggers = readJSON('trigger-queue.json');
        let trigger;

        if (trigger_id) {
          trigger = triggers.find(t => t.id === trigger_id);
          if (!trigger) return json(res, { error: 'Trigger not found' }, 404);
        } else {
          // Auto-pick top pending trigger
          const { selectTopTriggers } = require('./generator/score-triggers');
          const pending = triggers.filter(t => t.status === 'pending');
          const top = selectTopTriggers(pending, 1);
          if (top.length === 0) return json(res, { error: 'No pending triggers available' }, 400);
          trigger = top[0];
        }

        // Look up series template for the day
        const series = readJSON('series.json');
        const dayOfWeek = new Date(date).toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
        const seriesTemplate = series.find(s => s.day === dayOfWeek && s.active !== false) || null;

        // Generate content
        const { runDaily } = require('./generator/run-daily');
        const result = await runDaily({ triggerId: trigger.id, seriesTemplate });
        if (!result || result.length === 0) return json(res, { error: 'Generation produced no content' }, 500);

        const content = result[0];
        const platform = slot.split('_')[0];
        const platformFormats = {
          linkedin: 'linkedin', x: 'x_single', video: 'short_video',
          blog: 'blog', email: 'newsletter', youtube: 'youtube_script'
        };
        const format = platformFormats[platform] || platform;

        // Auto-assign to calendar slot
        const calendarData = readJSON('calendar.json', {});
        if (!calendarData[date]) calendarData[date] = {};
        calendarData[date][slot] = {
          content_id: content.id,
          format,
          title: (content.trigger_title || '').slice(0, 80),
          status: 'review'
        };
        writeJSON('calendar.json', calendarData);

        return json(res, { ok: true, content_id: content.id, trigger_title: trigger.title });
      } catch (err) {
        try { db.logError('generation', 'calendar_generate', err.message); } catch {}
        return json(res, { error: err.message }, 500);
      }
    }

    // POST /api/content/:id/performance — log performance metrics
    const perfMatch = pathname.match(/^\/api\/content\/([a-zA-Z0-9_-]+)\/performance$/);
    if (perfMatch && method === 'POST') {
      const contentId = perfMatch[1];
      const body = await parseBody(req);
      const { format, impressions, engagement, clicks, leads, notes } = body;
      if (!format) return json(res, { error: 'format required' }, 400);

      const entry = {
        content_id: contentId,
        format,
        impressions: parseInt(impressions) || 0,
        engagement: parseInt(engagement) || 0,
        clicks: parseInt(clicks) || 0,
        leads: parseInt(leads) || 0,
        notes: notes || '',
        logged_at: now()
      };

      await jsonStore.update('performance.json', [], perfData => {
        perfData.push(entry);
        return perfData;
      });
      return json(res, { ok: true, entry });
    }

    // GET /api/performance — get all performance data
    if (pathname === '/api/performance' && method === 'GET') {
      const perfData = readJSON('performance.json');
      return json(res, perfData);
    }

    // GET /api/analytics/performance — aggregated performance analytics
    if (pathname === '/api/analytics/performance' && method === 'GET') {
      const perfData = readJSON('performance.json');
      const content = readJSON('content.json');

      // Aggregate by format
      const byFormat = {};
      for (const entry of perfData) {
        if (!byFormat[entry.format]) byFormat[entry.format] = { impressions: 0, engagement: 0, clicks: 0, leads: 0, count: 0 };
        byFormat[entry.format].impressions += entry.impressions;
        byFormat[entry.format].engagement += entry.engagement;
        byFormat[entry.format].clicks += entry.clicks;
        byFormat[entry.format].leads += entry.leads;
        byFormat[entry.format].count++;
      }

      // Calculate engagement rates
      for (const [, data] of Object.entries(byFormat)) {
        data.engagement_rate = data.impressions > 0 ? Math.round((data.engagement / data.impressions) * 10000) / 100 : 0;
        data.click_rate = data.impressions > 0 ? Math.round((data.clicks / data.impressions) * 10000) / 100 : 0;
        data.avg_impressions = data.count > 0 ? Math.round(data.impressions / data.count) : 0;
        data.avg_leads = data.count > 0 ? Math.round(data.leads / data.count * 100) / 100 : 0;
      }

      // Top performers (by total engagement)
      const topPosts = perfData
        .sort((a, b) => (b.engagement + b.clicks * 2 + b.leads * 10) - (a.engagement + a.clicks * 2 + a.leads * 10))
        .slice(0, 10)
        .map(p => {
          const item = content.find(c => c.id === p.content_id);
          return { ...p, title: item?.trigger_title || 'Unknown' };
        });

      // Aggregate by pillar
      const byPillar = {};
      for (const entry of perfData) {
        const item = content.find(c => c.id === entry.content_id);
        const pillar = item?.trigger_category || 'UNKNOWN';
        if (!byPillar[pillar]) byPillar[pillar] = { impressions: 0, engagement: 0, clicks: 0, leads: 0, count: 0 };
        byPillar[pillar].impressions += entry.impressions;
        byPillar[pillar].engagement += entry.engagement;
        byPillar[pillar].clicks += entry.clicks;
        byPillar[pillar].leads += entry.leads;
        byPillar[pillar].count++;
      }

      return json(res, {
        total_entries: perfData.length,
        by_format: byFormat,
        by_pillar: byPillar,
        top_posts: topPosts,
        totals: {
          impressions: perfData.reduce((s, p) => s + p.impressions, 0),
          engagement: perfData.reduce((s, p) => s + p.engagement, 0),
          clicks: perfData.reduce((s, p) => s + p.clicks, 0),
          leads: perfData.reduce((s, p) => s + p.leads, 0)
        }
      });
    }

    // GET /api/predictions — performance predictions for pending/review content
    if (pathname === '/api/predictions' && method === 'GET') {
      const content = readJSON('content.json');
      const perfData = readJSON('performance.json');
      const published = readJSON('published.json');

      // Build scoring model from historical performance
      const formatAvg = {};
      const sourceAvg = {};
      const categoryAvg = {};
      for (const entry of perfData) {
        const score = entry.impressions + entry.engagement * 2 + entry.clicks * 5 + entry.leads * 20;
        const item = content.find(c => c.id === entry.content_id);
        // By format
        if (!formatAvg[entry.format]) formatAvg[entry.format] = { total: 0, count: 0 };
        formatAvg[entry.format].total += score;
        formatAvg[entry.format].count++;
        // By source
        const src = item?.trigger_source || 'unknown';
        if (!sourceAvg[src]) sourceAvg[src] = { total: 0, count: 0 };
        sourceAvg[src].total += score;
        sourceAvg[src].count++;
        // By category
        const cat = item?.trigger_category || 'unknown';
        if (!categoryAvg[cat]) categoryAvg[cat] = { total: 0, count: 0 };
        categoryAvg[cat].total += score;
        categoryAvg[cat].count++;
      }

      // Calculate averages
      for (const v of Object.values(formatAvg)) v.avg = v.count > 0 ? v.total / v.count : 0;
      for (const v of Object.values(sourceAvg)) v.avg = v.count > 0 ? v.total / v.count : 0;
      for (const v of Object.values(categoryAvg)) v.avg = v.count > 0 ? v.total / v.count : 0;

      const globalAvg = perfData.length > 0
        ? perfData.reduce((s, e) => s + e.impressions + e.engagement * 2 + e.clicks * 5 + e.leads * 20, 0) / perfData.length
        : 50; // Default baseline

      // Predict scores for unpublished content
      const predictions = content
        .filter(c => c.status === 'review' || c.status === 'approved')
        .map(c => {
          const formats = Object.keys(c.formats || {}).filter(f => c.formats[f].content);
          const src = c.trigger_source || 'unknown';
          const cat = c.trigger_category || 'unknown';

          // Composite score: weight format (40%), source (30%), category (20%), quality (10%)
          const bestFormat = formats.reduce((best, f) => {
            const fScore = formatAvg[f]?.avg || globalAvg;
            return fScore > best.score ? { format: f, score: fScore } : best;
          }, { format: null, score: 0 });

          const sourceScore = sourceAvg[src]?.avg || globalAvg;
          const catScore = categoryAvg[cat]?.avg || globalAvg;
          const qualityScore = c.quality_scores
            ? Math.max(...Object.values(c.quality_scores).map(q => q.score || 0))
            : 50;

          const predicted = Math.round(
            (bestFormat.score * 0.4) + (sourceScore * 0.3) + (catScore * 0.2) + (qualityScore * 0.1)
          );

          // Confidence based on data availability
          const dataPoints = (formatAvg[bestFormat.format]?.count || 0) + (sourceAvg[src]?.count || 0);
          const confidence = Math.min(100, Math.round(dataPoints * 10));

          return {
            content_id: c.id,
            title: c.trigger_title,
            status: c.status,
            source: src,
            category: cat,
            best_format: bestFormat.format,
            predicted_score: predicted,
            confidence,
            factors: {
              format: { name: bestFormat.format, score: Math.round(bestFormat.score) },
              source: { name: src, score: Math.round(sourceScore) },
              category: { name: cat, score: Math.round(catScore) },
              quality: Math.round(qualityScore)
            }
          };
        })
        .sort((a, b) => b.predicted_score - a.predicted_score);

      return json(res, {
        predictions,
        model: { format_avg: formatAvg, source_avg: sourceAvg, category_avg: categoryAvg, global_avg: Math.round(globalAvg) },
        data_points: perfData.length,
        has_enough_data: perfData.length >= 5
      });
    }

    // GET /api/simulate/:id — detailed performance simulation for a content piece
    const simMatch = pathname.match(/^\/api\/simulate\/([a-f0-9]+)$/);
    if (simMatch && method === 'GET') {
      const content = readJSON('content.json');
      const item = content.find(c => c.id === simMatch[1]);
      if (!item) return json(res, { error: 'Not found' }, 404);
      const perfData = readJSON('performance.json');
      const playbooks = readJSON('playbooks.json', {});
      const formats = Object.entries(item.formats || {}).filter(([, f]) => f.content);
      const simulation = {};
      for (const [fmt] of formats) {
        const pastPerf = perfData.filter(p => p.format === fmt);
        const avgImpressions = pastPerf.length > 0 ? Math.round(pastPerf.reduce((s, p) => s + (p.impressions || 0), 0) / pastPerf.length) : null;
        const avgEngagement = pastPerf.length > 0 ? Math.round(pastPerf.reduce((s, p) => s + (p.engagement || 0), 0) / pastPerf.length) : null;
        const avgLeads = pastPerf.length > 0 ? (pastPerf.reduce((s, p) => s + (p.leads || 0), 0) / pastPerf.length).toFixed(1) : null;
        // Content analysis
        const text = typeof item.formats[fmt].content === 'string' ? item.formats[fmt].content : '';
        const hasNumbers = /\$[\d,]+|\d+%|\d+x|\d+\/month|\d+ cases/.test(text);
        const hasHook = text.length > 0 && (text.split('\n')[0] || '').length < 200;
        const hasLineBreaks = (text.match(/\n\n/g) || []).length >= 3;
        const hasCta = /comment|reply|dm|book|audit|free|checklist|link/i.test(text);
        const charCount = text.length;
        // Quality score
        let qualityEstimate = 50;
        if (hasNumbers) qualityEstimate += 10;
        if (hasHook) qualityEstimate += 10;
        if (hasLineBreaks) qualityEstimate += 5;
        if (hasCta) qualityEstimate += 10;
        // Platform-specific optimal length
        const optimalLength = { linkedin: [800, 1300], x_single: [100, 280], x_thread: [5, 8], carousel: [5, 7], short_video: [200, 500], blog: [1500, 2500], hot_take: [30, 200] };
        const [minLen, maxLen] = optimalLength[fmt] || [100, 2000];
        const lengthScore = charCount >= minLen && charCount <= maxLen ? 'optimal' : charCount < minLen ? 'too_short' : 'too_long';
        // Best posting time from playbook
        const platformMap = { linkedin: 'linkedin', x_single: 'x_single', x_thread: 'x_thread', carousel: 'linkedin', poll: 'linkedin', blog: 'blog', youtube_script: 'youtube', short_video: 'youtube' };
        const pbKey = platformMap[fmt] || fmt;
        const bestTimes = playbooks[pbKey]?.algorithm?.posting_times || [];
        simulation[fmt] = {
          estimated_impressions: avgImpressions || (qualityEstimate > 60 ? '500-2000' : '200-800'),
          estimated_engagement: avgEngagement || (qualityEstimate > 60 ? '50-200' : '10-50'),
          estimated_leads: avgLeads || (hasCta ? '1-3' : '0-1'),
          quality_estimate: qualityEstimate,
          content_signals: { has_numbers: hasNumbers, has_hook: hasHook, has_line_breaks: hasLineBreaks, has_cta: hasCta },
          length: { chars: charCount, status: lengthScore, optimal_range: `${minLen}-${maxLen}` },
          best_posting_times: bestTimes.slice(0, 3),
          data_points: pastPerf.length,
          recommendations: [
            !hasNumbers ? 'Add specific numbers ($, %, cases) — posts with data get 2x engagement' : null,
            !hasCta ? 'Add a CTA — "comment [keyword]" or mention free audit' : null,
            !hasLineBreaks && fmt === 'linkedin' ? 'Add more line breaks — one thought per line' : null,
            lengthScore === 'too_short' ? `Too short (${charCount} chars) — aim for ${minLen}-${maxLen}` : null,
            lengthScore === 'too_long' ? `Too long (${charCount} chars) — trim to ${minLen}-${maxLen}` : null
          ].filter(Boolean)
        };
      }
      return json(res, { content_id: item.id, title: item.trigger_title, simulation });
    }

    // GET /api/analytics/insights — actionable insights and recommendations
    if (pathname === '/api/analytics/insights' && method === 'GET') {
      const content = readJSON('content.json');
      const triggers = readJSON('trigger-queue.json');
      const memory = readJSON('memory.json', {});
      const { getSourceReliability } = require('./generator/score-triggers');

      const insights = [];

      // 1. Source reliability index
      const sourceReliability = getSourceReliability();

      // 2. Format approval rates — find best and worst
      const formatStats = {};
      for (const c of content) {
        for (const [key, fmt] of Object.entries(c.formats || {})) {
          if (!formatStats[key]) formatStats[key] = { total: 0, approved: 0, rejected: 0 };
          formatStats[key].total++;
          if (fmt.status === 'approved') formatStats[key].approved++;
          else if (fmt.status === 'rejected') formatStats[key].rejected++;
        }
      }
      // Find top 3 formats by approval rate (min 3 entries)
      const formatRanking = Object.entries(formatStats)
        .filter(([, d]) => d.total >= 3)
        .map(([fmt, d]) => ({
          format: fmt,
          approval_rate: Math.round((d.approved / d.total) * 100),
          rejection_rate: Math.round((d.rejected / d.total) * 100),
          total: d.total,
          approved: d.approved,
          rejected: d.rejected
        }))
        .sort((a, b) => b.approval_rate - a.approval_rate);

      if (formatRanking.length >= 2) {
        const best = formatRanking[0];
        const worst = formatRanking[formatRanking.length - 1];
        insights.push({
          type: 'format_performance',
          severity: worst.rejection_rate > 50 ? 'warning' : 'info',
          title: `Best format: ${best.format} (${best.approval_rate}% approved)`,
          detail: `Worst: ${worst.format} at ${worst.approval_rate}% approval. Consider reviewing ${worst.format} prompts.`
        });
      }

      // 3. Rejection pattern analysis from memory
      const rejectionPatterns = memory.rejection_patterns || [];
      const rejectionStats = {};
      for (const rp of rejectionPatterns) {
        const fmt = rp.format || 'unknown';
        if (!rejectionStats[fmt]) rejectionStats[fmt] = { count: 0, reasons: {} };
        rejectionStats[fmt].count++;
        const reason = rp.rejection_reason || 'unspecified';
        rejectionStats[fmt].reasons[reason] = (rejectionStats[fmt].reasons[reason] || 0) + 1;
      }
      if (rejectionPatterns.length > 0) {
        const topRejected = Object.entries(rejectionStats)
          .sort((a, b) => b[1].count - a[1].count)[0];
        if (topRejected) {
          const topReason = Object.entries(topRejected[1].reasons)
            .sort((a, b) => b[1] - a[1])[0];
          insights.push({
            type: 'rejection_patterns',
            severity: topRejected[1].count > 5 ? 'warning' : 'info',
            title: `${topRejected[1].count} rejections on ${topRejected[0]} format`,
            detail: topReason ? `Most common reason: ${topReason[0]} (${topReason[1]}x)` : ''
          });
        }
      }

      // 4. Content velocity — generation rate over last 7 days
      const now = Date.now();
      const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
      const recentContent = content.filter(c => new Date(c.generated_at).getTime() > weekAgo);
      const prevWeek = content.filter(c => {
        const t = new Date(c.generated_at).getTime();
        return t > weekAgo - 7 * 24 * 60 * 60 * 1000 && t <= weekAgo;
      });
      const velocityChange = prevWeek.length > 0
        ? Math.round(((recentContent.length - prevWeek.length) / prevWeek.length) * 100)
        : null;
      insights.push({
        type: 'velocity',
        severity: 'info',
        title: `${recentContent.length} pieces generated this week`,
        detail: velocityChange !== null
          ? `${velocityChange >= 0 ? '+' : ''}${velocityChange}% vs last week (${prevWeek.length})`
          : 'First week of tracking'
      });

      // 5. Trigger pipeline health
      const pendingTriggers = triggers.filter(t => t.status === 'pending').length;
      const staleTriggers = triggers.filter(t => {
        if (t.status !== 'pending') return false;
        const age = (now - new Date(t.captured_at).getTime()) / (24 * 60 * 60 * 1000);
        return age > 14;
      }).length;
      if (staleTriggers > 10) {
        insights.push({
          type: 'stale_triggers',
          severity: 'warning',
          title: `${staleTriggers} stale triggers (>14 days old)`,
          detail: `Out of ${pendingTriggers} pending triggers. Consider bulk-rejecting old ones.`
        });
      }

      // 6. Content gaps — formats with no recent activity
      const recentFormats = new Set();
      for (const c of recentContent) {
        for (const key of Object.keys(c.formats || {})) recentFormats.add(key);
      }
      const allFormats = ['linkedin', 'x_single', 'x_thread', 'short_video', 'carousel', 'hot_take', 'blog', 'lead_magnet'];
      const missingFormats = allFormats.filter(f => !recentFormats.has(f));
      if (missingFormats.length > 0 && recentContent.length > 0) {
        insights.push({
          type: 'content_gap',
          severity: 'info',
          title: `${missingFormats.length} formats with no recent content`,
          detail: `Missing: ${missingFormats.join(', ')}`
        });
      }

      // 7. Source diversity check
      const recentSources = {};
      for (const c of recentContent) {
        const src = c.trigger_source || 'unknown';
        recentSources[src] = (recentSources[src] || 0) + 1;
      }
      const dominantSource = Object.entries(recentSources).sort((a, b) => b[1] - a[1])[0];
      if (dominantSource && recentContent.length > 5) {
        const pct = Math.round((dominantSource[1] / recentContent.length) * 100);
        if (pct > 60) {
          insights.push({
            type: 'source_diversity',
            severity: 'warning',
            title: `${pct}% of recent content from ${dominantSource[0]}`,
            detail: 'Diversify sources for a more balanced content mix.'
          });
        }
      }

      return json(res, {
        insights,
        source_reliability: sourceReliability,
        format_ranking: formatRanking,
        rejection_stats: rejectionStats,
        velocity: {
          this_week: recentContent.length,
          last_week: prevWeek.length,
          change_pct: velocityChange
        },
        pipeline: {
          pending_triggers: pendingTriggers,
          stale_triggers: staleTriggers,
          content_in_review: content.filter(c => c.status === 'review').length
        }
      });
    }

    // POST /api/triggers/generate — generate content for a trigger
    if (pathname === '/api/triggers/generate' && method === 'POST') {
      const body = await parseBody(req);
      const triggerId = body.trigger_id;

      if (!triggerId) return json(res, { error: 'trigger_id required' }, 400);

      const triggers = readJSON('trigger-queue.json');
      const trigger = triggers.find(t => t.id === triggerId);
      if (!trigger) return json(res, { error: 'Trigger not found' }, 404);

      // Check if API key is available
      if (!process.env.ANTHROPIC_API_KEY) {
        return json(res, { error: 'ANTHROPIC_API_KEY not configured. Set it in .env file.' }, 500);
      }

      try {
        const { runDaily } = require('./generator/run-daily');
        const result = await runDaily({ triggerId });
        // Auto-schedule generated content
        const scheduled = [];
        for (const item of (result || [])) {
          const slot = autoScheduleContent(item);
          if (slot) scheduled.push({ content_id: item.id, ...slot });
        }
        return json(res, { ok: true, content: result, scheduled });
      } catch (err) {
        try { db.logError('generation', 'generate_for_trigger', err.message, { triggerId }); } catch {}
        return json(res, { error: err.message }, 500);
      }
    }

    // POST /api/generate-daily — trigger daily generation (supports batch)
    if (pathname === '/api/generate-daily' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) {
        return json(res, { error: 'ANTHROPIC_API_KEY not configured. Set it in .env file.' }, 500);
      }

      try {
        const { runDaily } = require('./generator/run-daily');
        const body = await parseBody(req);
        const result = await runDaily({ count: body.count || 5 });
        // Auto-schedule generated content
        const scheduled = [];
        for (const item of (result || [])) {
          const slot = autoScheduleContent(item);
          if (slot) scheduled.push({ content_id: item.id, ...slot });
        }
        return json(res, { ok: true, content: result, scheduled });
      } catch (err) {
        try { db.logError('generation', 'generate_daily', err.message); } catch {}
        return json(res, { error: err.message }, 500);
      }
    }

    // POST /api/generate-batch — generate content for selected triggers with progress
    if (pathname === '/api/generate-batch' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) {
        return json(res, { error: 'ANTHROPIC_API_KEY not configured. Set it in .env file.' }, 500);
      }

      const body = await parseBody(req);
      const triggerIds = body.trigger_ids || [];
      const count = body.count || 5;
      const source = body.source || null;

      if (triggerIds.length === 0 && !source && !count) {
        return json(res, { error: 'Provide trigger_ids, source, or count' }, 400);
      }

      // Generate a batch ID for progress tracking
      const batchId = generateId();
      _batchProgress[batchId] = { total: 0, completed: 0, errors: 0, results: [], status: 'starting' };

      // Start generation in background
      setImmediate(async () => {
        try {
          const { runDaily } = require('./generator/run-daily');

          if (triggerIds.length > 0) {
            // Generate for specific triggers
            _batchProgress[batchId].total = triggerIds.length;
            _batchProgress[batchId].status = 'running';
            for (const tid of triggerIds) {
              try {
                const result = await runDaily({ triggerId: tid });
                _batchProgress[batchId].completed++;
                if (result && result.length > 0) {
                  _batchProgress[batchId].results.push(result[0].id);
                  autoScheduleContent(result[0]);
                }
              } catch (err) {
                _batchProgress[batchId].errors++;
                console.error(`[batch] Error generating ${tid}: ${err.message}`);
              }
            }
          } else if (source) {
            // Generate for top N triggers from a specific source
            const triggers = readJSON('trigger-queue.json');
            const { selectTopTriggers } = require('./generator/score-triggers');
            const filtered = triggers.filter(t => t.status === 'pending' && t.source === source);
            const top = selectTopTriggers(filtered, count);
            _batchProgress[batchId].total = top.length;
            _batchProgress[batchId].status = 'running';
            for (const t of top) {
              try {
                const result = await runDaily({ triggerId: t.id });
                _batchProgress[batchId].completed++;
                if (result && result.length > 0) {
                  _batchProgress[batchId].results.push(result[0].id);
                  autoScheduleContent(result[0]);
                }
              } catch (err) {
                _batchProgress[batchId].errors++;
              }
            }
          } else {
            // Generate top N triggers
            _batchProgress[batchId].total = count;
            _batchProgress[batchId].status = 'running';
            const result = await runDaily({ count });
            _batchProgress[batchId].completed = (result || []).length;
            _batchProgress[batchId].results = (result || []).map(r => r.id);
          }

          _batchProgress[batchId].status = 'done';
        } catch (err) {
          _batchProgress[batchId].status = 'error';
          _batchProgress[batchId].error = err.message;
        }
        // Clean up after 30 minutes
        setTimeout(() => { delete _batchProgress[batchId]; }, 30 * 60 * 1000);
      });

      return json(res, { ok: true, batch_id: batchId });
    }

    // POST /api/generate-week — generate a full week of content (5 pieces, auto-scheduled)
    if (pathname === '/api/generate-week' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) {
        return json(res, { error: 'ANTHROPIC_API_KEY not configured' }, 500);
      }
      const batchId = generateId();
      _batchProgress[batchId] = { total: 5, completed: 0, errors: 0, results: [], status: 'starting', type: 'week' };
      setImmediate(async () => {
        try {
          const { runDaily } = require('./generator/run-daily');
          _batchProgress[batchId].status = 'running';
          // Generate 5 content pieces from top triggers
          const result = await runDaily({ count: 5, includeBlog: true, includeYouTube: false });
          const generated = result || [];
          _batchProgress[batchId].completed = generated.length;
          _batchProgress[batchId].results = generated.map(r => r.id);
          // Auto-schedule each to the next weekday
          let scheduled = 0;
          for (const item of generated) {
            const slot = autoScheduleContent(item);
            if (slot) scheduled++;
          }
          _batchProgress[batchId].scheduled = scheduled;
          _batchProgress[batchId].status = 'done';
          console.log(`[generate-week] Generated ${generated.length} pieces, scheduled ${scheduled}`);
        } catch (err) {
          _batchProgress[batchId].status = 'error';
          _batchProgress[batchId].error = err.message;
          console.error('[generate-week] Error:', err.message);
        }
        setTimeout(() => { delete _batchProgress[batchId]; }, 30 * 60 * 1000);
      });
      return json(res, { ok: true, batch_id: batchId });
    }

    // GET /api/generate-batch/:id — check batch generation progress
    if (pathname.startsWith('/api/generate-batch/') && method === 'GET') {
      const batchId = pathname.split('/').pop();
      const progress = _batchProgress[batchId];
      if (!progress) return json(res, { error: 'Batch not found' }, 404);
      return json(res, progress);
    }

    // POST /api/daily-brief — send daily brief to Telegram
    if (pathname === '/api/daily-brief' && method === 'POST') {
      try {
        const { generateBrief, sendTelegram } = require('./generator/daily-brief');
        const brief = await generateBrief();
        await sendTelegram(brief);
        return json(res, { ok: true, brief });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // POST /api/save-url — scrape a URL and create trigger
    if (pathname === '/api/save-url' && method === 'POST') {
      const body = await parseBody(req);
      const targetUrl = body.url;
      const selectedFormats = body.formats || []; // empty = all formats
      const queueOnly = body.queue_only || false;

      if (!targetUrl) return json(res, { error: 'url required' }, 400);

      // Validate URL format
      let parsedUrl;
      try {
        parsedUrl = new URL(targetUrl);
      } catch {
        return json(res, { error: 'Invalid URL format' }, 400);
      }

      // Fetch the URL content (best-effort — create trigger even if fetch fails)
      let title = targetUrl;
      let content = '';
      try {
        const fetchRes = await fetch(targetUrl, {
          headers: { 'User-Agent': 'ContentMachine/1.0' },
          signal: AbortSignal.timeout(15000)
        });
        if (fetchRes.ok) {
          const html = await fetchRes.text();
          const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
          title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : targetUrl;
          const { stripHtml } = require('./lib/utils');
          content = stripHtml(html).slice(0, 3000);
        }
      } catch (err) {
        console.log(`[save-url] Fetch failed for ${targetUrl}: ${err.message} — creating trigger with URL only`);
      }

      // Create trigger
      const trigger = {
        id: `url-${generateId()}`,
        source: 'url',
        source_detail: parsedUrl.hostname,
        title: (title || targetUrl).slice(0, 200),
        raw_content: content || title || targetUrl,
        url: targetUrl,
        category: 'CONTENT_PIECE',
        captured_at: now(),
        status: 'pending',
        score: 0,
        requested_formats: selectedFormats.length > 0 ? selectedFormats : null
      };

      const triggers = readJSON('trigger-queue.json');
      triggers.push(trigger);
      writeJSON('trigger-queue.json', triggers);

      // If queue_only, just save the trigger
      if (queueOnly) {
        return json(res, { ok: true, trigger, queued: true });
      }

      // If API key available, generate content immediately
      if (process.env.ANTHROPIC_API_KEY) {
        try {
          const { runDaily } = require('./generator/run-daily');
          await runDaily({ triggerId: trigger.id, formats: selectedFormats });
        } catch (err) {
          console.error('[save-url] Generation failed:', err.message);
        }
      }

      return json(res, { ok: true, trigger });
    }

    // POST /api/content/:id/regenerate — regenerate a single format
    const regenMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/regenerate$/);
    if (regenMatch && method === 'POST') {
      const content = readJSON('content.json');
      const idx = content.findIndex(c => c.id === regenMatch[1]);
      if (idx === -1) return json(res, { error: 'Not found' }, 404);

      const body = await parseBody(req);
      const format = body.format;
      if (!format) return json(res, { error: 'format required' }, 400);

      if (!process.env.ANTHROPIC_API_KEY) {
        return json(res, { error: 'ANTHROPIC_API_KEY not configured' }, 500);
      }

      const item = content[idx];
      const triggers = readJSON('trigger-queue.json');
      const trigger = triggers.find(t => t.id === item.trigger_id);
      if (!trigger) return json(res, { error: 'Original trigger not found' }, 404);

      try {
        const { buildSystemPromptWithMemory } = require('./generator/content-writer');
        const systemPrompt = buildSystemPromptWithMemory();

        if (format === 'blog') {
          const { generateBlogPost } = require('./lib/claude');
          const keyword = item.blog_keyword || trigger.title;
          const blogContent = await generateBlogPost(trigger, keyword, systemPrompt);
          content[idx].formats.blog = { content: blogContent, status: 'review', edited: false };
          content[idx].blog_post = blogContent;
        } else if (format === 'youtube_script') {
          const { generateYouTubeScript } = require('./lib/claude');
          const topic = item.youtube_topic || trigger.title;
          const scriptContent = await generateYouTubeScript(trigger, topic, systemPrompt);
          content[idx].formats.youtube_script = { content: scriptContent, status: 'review', edited: false };
          content[idx].youtube_script = scriptContent;
        } else if (format === 'lead_magnet') {
          const { generateLeadMagnet } = require('./lib/claude');
          const { renderLeadMagnetHTML } = require('./generator/lead-magnet-renderer');
          const triggerWithTopic = { ...trigger, lead_magnet_topic: item.lead_magnet_topic || trigger.title };
          const parsed = await generateLeadMagnet(triggerWithTopic, systemPrompt);
          const html = renderLeadMagnetHTML(parsed);
          content[idx].formats.lead_magnet = { content: html, status: 'review', edited: false };
          content[idx].lead_magnet_meta = { title: parsed.title, type: parsed.type, subtitle: parsed.subtitle };
        } else if (format === 'newsletter') {
          const { generateNewsletter } = require('./lib/claude');
          const parsed = await generateNewsletter(trigger, systemPrompt);
          content[idx].formats.newsletter = { content: parsed.body || parsed, status: 'review', edited: false };
          content[idx].newsletter_meta = { subject_line: parsed.subject_line || '', preview_text: parsed.preview_text || '' };
        } else if (format === 'case_study') {
          const { generateCaseStudy } = require('./lib/claude');
          const caseStudy = await generateCaseStudy(trigger, systemPrompt);
          content[idx].formats.case_study = { content: caseStudy, status: 'review', edited: false };
        } else {
          // Social format — regenerate all social, extract the one we need
          const { generateSocialContent } = require('./lib/claude');
          const social = await generateSocialContent(trigger, systemPrompt);
          const formatMap = {
            linkedin: 'linkedin_post', x_single: 'x_single',
            x_thread: 'x_thread', short_video: 'short_video_script',
            carousel: 'linkedin_carousel', poll: 'linkedin_poll',
            quote_cards: 'quote_cards', stat_graphic: 'stat_graphic',
            hot_take: 'hot_take', before_after: 'before_after',
            listicle: 'listicle_post'
          };
          const newContent = social?.[formatMap[format]] || null;
          if (newContent) {
            content[idx].formats[format] = { content: newContent, status: 'review', edited: false };
          }
        }
        writeJSON('content.json', content);
        return json(res, { ok: true, ...content[idx] });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // POST /api/content/bulk-approve
    if (pathname === '/api/content/bulk-approve' && method === 'POST') {
      const body = await parseBody(req);
      const ids = body.ids || [];
      if (!ids.length) return json(res, { error: 'ids required' }, 400);
      backupJSON('content.json');

      let updated = 0;
      await jsonStore.update('content.json', [], content => {
        for (const id of ids) {
          const idx = content.findIndex(c => c.id === id);
          if (idx === -1) continue;
          for (const key of Object.keys(content[idx].formats)) {
            if (content[idx].formats[key].status !== 'rejected') {
              content[idx].formats[key].status = 'approved';
            }
          }
          content[idx].status = 'approved';
          updated++;
        }
        return content;
      });
      return json(res, { ok: true, updated });
    }

    // POST /api/content/bulk-reject
    if (pathname === '/api/content/bulk-reject' && method === 'POST') {
      const body = await parseBody(req);
      const ids = body.ids || [];
      if (!ids.length) return json(res, { error: 'ids required' }, 400);
      backupJSON('content.json');

      let updated = 0;
      await jsonStore.update('content.json', [], content => {
        for (const id of ids) {
          const idx = content.findIndex(c => c.id === id);
          if (idx === -1) continue;
          for (const key of Object.keys(content[idx].formats)) {
            content[idx].formats[key].status = 'rejected';
          }
          content[idx].status = 'rejected';
          updated++;
        }
        return content;
      });
      return json(res, { ok: true, updated });
    }

    // POST /api/content/:id/schedule — schedule content for a specific date
    const scheduleMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/schedule$/);
    if (scheduleMatch && method === 'POST') {
      const content = readJSON('content.json');
      const idx = content.findIndex(c => c.id === scheduleMatch[1]);
      if (idx === -1) return json(res, { error: 'Not found' }, 404);

      const body = await parseBody(req);
      const { format, date, slot } = body;
      if (!date) return json(res, { error: 'date required (YYYY-MM-DD)' }, 400);

      content[idx].scheduled_date = date;
      content[idx].scheduled_platforms = body.platforms || [];

      // Update format status if specific format provided
      if (format && content[idx].formats[format]) {
        content[idx].formats[format].status = 'scheduled';
        content[idx].formats[format].scheduled_for = date;
      }
      writeJSON('content.json', content);

      // Auto-assign to calendar
      if (format) {
        const calendarData = readJSON('calendar.json', {});
        if (!calendarData[date]) calendarData[date] = {};
        const slotKey = slot || `${format}_morning`;
        calendarData[date][slotKey] = {
          content_id: content[idx].id,
          format,
          title: (content[idx].trigger_title || 'Untitled').slice(0, 80),
          preview: '',
          status: 'scheduled',
          assigned_at: now()
        };
        writeJSON('calendar.json', calendarData);
      }

      return json(res, { ok: true, scheduled_for: date });
    }

    // DELETE /api/triggers/:id
    const triggerDeleteMatch = pathname.match(/^\/api\/triggers\/([a-zA-Z0-9_-]+)$/);
    if (triggerDeleteMatch && method === 'DELETE') {
      let found = false;
      await jsonStore.update('trigger-queue.json', [], triggers => {
        const filtered = triggers.filter(t => t.id !== triggerDeleteMatch[1]);
        found = filtered.length < triggers.length;
        return filtered;
      });
      if (!found) return json(res, { error: 'Not found' }, 404);
      return json(res, { ok: true });
    }

    // POST /api/triggers/:id/reject
    const triggerRejectMatch = pathname.match(/^\/api\/triggers\/([a-zA-Z0-9_-]+)\/reject$/);
    if (triggerRejectMatch && method === 'POST') {
      let found = false;
      await jsonStore.update('trigger-queue.json', [], triggers => {
        const idx = triggers.findIndex(t => t.id === triggerRejectMatch[1]);
        if (idx !== -1) { triggers[idx].status = 'rejected'; found = true; }
        return triggers;
      });
      if (!found) return json(res, { error: 'Not found' }, 404);
      return json(res, { ok: true });
    }

    // POST /api/triggers/bulk-reject — reject multiple triggers at once
    if (pathname === '/api/triggers/bulk-reject' && method === 'POST') {
      const body = await parseBody(req);
      const { trigger_ids, older_than_days, source } = body;
      let count = 0;
      await jsonStore.update('trigger-queue.json', [], triggers => {
        const cutoff = older_than_days ? Date.now() - older_than_days * 24 * 60 * 60 * 1000 : null;
        for (let i = 0; i < triggers.length; i++) {
          if (triggers[i].status !== 'pending') continue;
          let match = false;
          if (trigger_ids && trigger_ids.includes(triggers[i].id)) match = true;
          if (cutoff && new Date(triggers[i].captured_at).getTime() < cutoff) match = true;
          if (source && triggers[i].source === source && !trigger_ids) match = true;
          if (match) { triggers[i].status = 'rejected'; count++; }
        }
        return triggers;
      });
      return json(res, { ok: true, rejected: count });
    }

    // POST /api/triggers/auto-archive — archive stale triggers
    if (pathname === '/api/triggers/auto-archive' && method === 'POST') {
      const body = await parseBody(req);
      const maxAgeDays = body.max_age_days || 21;
      const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

      const triggers = readJSON('trigger-queue.json');
      const archived = readJSON('archived-triggers.json');

      const toArchive = [];
      const keep = [];

      for (const t of triggers) {
        if (t.status === 'used') { keep.push(t); continue; }
        const age = new Date(t.captured_at || t.scraped_at || t.date || 0).getTime();
        if (t.status === 'pending' && age < cutoff) {
          toArchive.push({ ...t, status: 'archived', archived_at: now() });
        } else if (t.status === 'rejected') {
          toArchive.push({ ...t, status: 'archived', archived_at: now() });
        } else {
          keep.push(t);
        }
      }

      if (toArchive.length > 0) {
        writeJSON('trigger-queue.json', keep);
        writeJSON('archived-triggers.json', [...archived, ...toArchive]);
        console.log(`[auto-archive] Archived ${toArchive.length} triggers (${keep.length} remaining)`);
      }

      return json(res, {
        ok: true,
        archived: toArchive.length,
        remaining: keep.length,
        by_status: {
          stale: toArchive.filter(t => t.status === 'archived').length,
          rejected: toArchive.filter(t => t.status === 'rejected').length
        }
      });
    }

    // GET /api/triggers/health — trigger queue health stats
    if (pathname === '/api/triggers/health' && method === 'GET') {
      const triggers = readJSON('trigger-queue.json');
      const archived = readJSON('archived-triggers.json');
      const nowMs = Date.now();

      const pending = triggers.filter(t => t.status === 'pending');
      const fresh = pending.filter(t => (nowMs - new Date(t.captured_at || t.scraped_at || t.date || 0).getTime()) < 3 * 24 * 60 * 60 * 1000);
      const stale7 = pending.filter(t => (nowMs - new Date(t.captured_at || t.scraped_at || t.date || 0).getTime()) > 7 * 24 * 60 * 60 * 1000);
      const stale21 = pending.filter(t => (nowMs - new Date(t.captured_at || t.scraped_at || t.date || 0).getTime()) > 21 * 24 * 60 * 60 * 1000);

      const bySource = {};
      for (const t of pending) { bySource[t.source || 'unknown'] = (bySource[t.source || 'unknown'] || 0) + 1; }

      return json(res, {
        total: triggers.length,
        pending: pending.length,
        used: triggers.filter(t => t.status === 'used').length,
        rejected: triggers.filter(t => t.status === 'rejected').length,
        fresh_3d: fresh.length,
        stale_7d: stale7.length,
        stale_21d: stale21.length,
        archived_total: archived.length,
        by_source: bySource,
        health: fresh.length > 10 ? 'good' : fresh.length > 0 ? 'fair' : 'stale'
      });
    }

    // GET /api/trending — trending topics from trigger queue
    if (pathname === '/api/trending' && method === 'GET') {
      const triggers = readJSON('trigger-queue.json');
      const nowMs = Date.now();
      const recentDays = 7;
      const recent = triggers.filter(t => {
        const age = nowMs - new Date(t.captured_at || t.scraped_at || t.date || 0).getTime();
        return age < recentDays * 24 * 60 * 60 * 1000;
      });
      // Extract keywords from titles
      const stopwords = new Set(['the','a','an','and','or','but','in','on','at','to','for','of','with','by','from','is','are','was','were','be','been','being','have','has','had','do','does','did','will','would','shall','should','may','might','must','can','could','this','that','these','those','it','its','i','you','he','she','we','they','my','your','his','her','our','their','not','no','all','any','some','every','each','just','also','how','why','what','when','where','who','which','about','new','more','most','than','very','too','even','only','just','so','if','then','else','out','up','down','into','over','after','before','between','under','above','below','through','during','here','there','now','already','still','yet','ever','never','always','often','really','well','much','many','few','little','less','least','own','same','other','another','such','like','get','make','go','know','take','come','think','look','want','give','use','find','tell','ask','work','seem','feel','try','leave','call','keep','let','begin','show','hear','play','run','move','live','believe','bring','happen','write','provide','sit','stand','lose','pay','meet','include','continue','set','learn','change','lead','understand','watch','follow','stop','create','speak','read','allow','add','spend','grow','open','walk','win','offer','remember','love','consider','appear','buy','wait','serve','die','send','expect','build','stay','fall','cut','reach','kill','remain','law','firm','firms','lawyer','lawyers','legal','marketing','attorney','attorneys','client','clients','case','cases']);
      const wordCounts = {};
      const phraseMap = {};
      for (const t of recent) {
        const title = (t.title || '').toLowerCase().replace(/[^a-z0-9\s]/g, '');
        const words = title.split(/\s+/).filter(w => w.length > 3 && !stopwords.has(w));
        const seen = new Set();
        for (const w of words) {
          if (!seen.has(w)) { wordCounts[w] = (wordCounts[w] || 0) + 1; seen.add(w); }
        }
        // Extract 2-word phrases
        for (let i = 0; i < words.length - 1; i++) {
          const phrase = `${words[i]} ${words[i + 1]}`;
          if (!seen.has(phrase)) { phraseMap[phrase] = (phraseMap[phrase] || 0) + 1; seen.add(phrase); }
        }
      }
      // Top single words
      const topWords = Object.entries(wordCounts)
        .filter(([, c]) => c >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([word, count]) => ({ word, count, triggers: recent.filter(t => (t.title || '').toLowerCase().includes(word)).length }));
      // Top phrases
      const topPhrases = Object.entries(phraseMap)
        .filter(([, c]) => c >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([phrase, count]) => ({ phrase, count }));
      // Category breakdown
      const categories = {};
      for (const t of recent) { categories[t.category || 'uncategorized'] = (categories[t.category || 'uncategorized'] || 0) + 1; }
      // Source velocity (triggers per source in last 7 days)
      const sourceVelocity = {};
      for (const t of recent) { sourceVelocity[t.source || 'unknown'] = (sourceVelocity[t.source || 'unknown'] || 0) + 1; }
      return json(res, {
        period: `last ${recentDays} days`,
        total_recent: recent.length,
        trending_topics: topWords,
        trending_phrases: topPhrases,
        categories,
        source_velocity: sourceVelocity
      });
    }

    // POST /api/triggers/bulk-delete — delete rejected triggers
    if (pathname === '/api/triggers/bulk-delete' && method === 'POST') {
      const body = await parseBody(req);
      const olderThanDays = body.older_than_days;
      let count = 0;
      await jsonStore.update('trigger-queue.json', [], triggers => {
        const cutoff = olderThanDays > 0 ? Date.now() - olderThanDays * 24 * 60 * 60 * 1000 : Infinity;
        const before = triggers.length;
        const filtered = triggers.filter(t => {
          if (t.status === 'rejected') {
            if (olderThanDays === 0 || new Date(t.captured_at).getTime() < cutoff) return false;
          }
          return true;
        });
        count = before - filtered.length;
        return filtered;
      });
      return json(res, { ok: true, deleted: count });
    }

    // GET /api/memory
    if (pathname === '/api/memory' && method === 'GET') {
      const memory = readJSON('memory.json', {});
      return json(res, memory);
    }

    // POST /api/memory — add a style note or preference
    if (pathname === '/api/memory' && method === 'POST') {
      const body = await parseBody(req);
      const validTypes = ['style_note', 'remove_example', 'remove_note'];
      if (!body.type || !validTypes.includes(body.type)) {
        return json(res, { error: `type required, must be one of: ${validTypes.join(', ')}` }, 400);
      }

      if (body.type === 'style_note' && (!body.note || !body.note.trim())) {
        return json(res, { error: 'note required for style_note type' }, 400);
      }
      if ((body.type === 'remove_example' || body.type === 'remove_note') && typeof body.index !== 'number') {
        return json(res, { error: 'index required for ' + body.type + ' type' }, 400);
      }

      const memory = await jsonStore.update('memory.json', {}, mem => {
        if (body.type === 'style_note') {
          if (!mem.style_notes) mem.style_notes = [];
          mem.style_notes.push({ note: body.note.trim(), added_at: now() });
        }
        if (body.type === 'remove_example') {
          mem.approved_examples = (mem.approved_examples || []).filter((e, i) => i !== body.index);
        }
        if (body.type === 'remove_note') {
          mem.style_notes = (mem.style_notes || []).filter((n, i) => i !== body.index);
        }
        return mem;
      });
      return json(res, { ok: true, ...memory });
    }

    // GET /api/settings
    if (pathname === '/api/settings' && method === 'GET') {
      const triggers = readJSON('trigger-queue.json');
      const content = readJSON('content.json');
      const published = readJSON('published.json');
      const settings = readJSON('settings.json', {});
      return json(res, {
        api_key: !!process.env.ANTHROPIC_API_KEY,
        fireflies_key: !!process.env.FIREFLIES_API_KEY,
        ghl_key: !!process.env.GHL_API_KEY,
        instantly_key: !!process.env.INSTANTLY_API_KEY,
        telegram_key: !!process.env.TELEGRAM_BOT_TOKEN,
        ideogram_key: !!process.env.IDEOGRAM_API_KEY,
        youtube_key: !!process.env.YOUTUBE_API_KEY,
        scrapers: ['reddit', 'rss', 'youtube', 'google-news', 'hackernews', 'competitors'],
        mcp_servers: ['pipeline', 'fireflies', 'ghl', 'instantly'],
        last_scrape_at: settings.last_scrape_at || null,
        last_scrape_result: settings.last_scrape_result || null,
        data: {
          triggers: triggers.length,
          content: content.length,
          published: published.length,
          meetings: db.getStats().meetings.total,
          clients: db.getStats().clients.total
        }
      });
    }

    // GET /api/playbooks — platform playbook data
    if (pathname === '/api/playbooks' && method === 'GET') {
      const playbooks = readJSON('playbooks.json', {});
      return json(res, playbooks);
    }

    // GET /api/cta-library — CTA library data
    if (pathname === '/api/cta-library' && method === 'GET') {
      const ctas = readJSON('cta-library.json', {});
      return json(res, ctas);
    }

    // POST /api/triggers/add — manually add a trigger
    if (pathname === '/api/triggers/add' && method === 'POST') {
      const body = await parseBody(req);
      if (!body.title) return json(res, { error: 'title required' }, 400);

      const trigger = {
        id: `manual-${generateId()}`,
        source: body.source || 'manual',
        source_detail: body.source_detail || 'Hand-curated',
        title: body.title,
        raw_content: body.raw_content || body.title,
        url: body.url || null,
        category: body.category || 'CONTENT_PIECE',
        captured_at: now(),
        status: 'pending',
        score: 0
      };

      const triggers = readJSON('trigger-queue.json');
      triggers.push(trigger);
      writeJSON('trigger-queue.json', triggers);
      return json(res, { ok: true, trigger });
    }

    // POST /api/scrape-now — run all scrapers
    if (pathname === '/api/scrape-now' && method === 'POST') {
      try {
        const beforeCount = readJSON('trigger-queue.json').length;
        const { runAll } = require('./scrapers/run-all');
        await runAll();
        const afterCount = readJSON('trigger-queue.json').length;
        const newTriggers = afterCount - beforeCount;

        // Save last scrape timestamp
        const settings = readJSON('settings.json', {});
        settings.last_scrape_at = now();
        settings.last_scrape_result = { new_triggers: newTriggers, total: afterCount };
        writeJSON('settings.json', settings);

        return json(res, { ok: true, new_triggers: newTriggers, total: afterCount, scraped_at: now() });
      } catch (err) {
        try { db.logError('scraper', 'scrape_now', err.message); } catch {}
        return json(res, { error: err.message }, 500);
      }
    }

    // POST /api/capture — quick capture an idea as a trigger
    if (pathname === '/api/capture' && method === 'POST') {
      const body = await parseBody(req);
      if (!body.title && !body.text) return json(res, { error: 'title or text required' }, 400);

      const trigger = {
        id: `capture-${generateId()}`,
        source: body.source || 'capture',
        source_detail: 'Quick Capture',
        title: (body.title || body.text).slice(0, 200),
        raw_content: body.text || body.title,
        url: body.url || null,
        category: body.category || 'CONTENT_PIECE',
        captured_at: now(),
        status: 'pending',
        score: 0
      };

      const triggers = readJSON('trigger-queue.json');
      triggers.push(trigger);
      writeJSON('trigger-queue.json', triggers);
      return json(res, { ok: true, trigger });
    }

    // POST /api/atomize — break text or URL into content atoms
    if (pathname === '/api/atomize' && method === 'POST') {
      const body = await parseBody(req);
      const { atomizeContent, atomizeUrl } = require('./generator/atomizer');

      if (body.url) {
        const atoms = await atomizeUrl(body.url);
        return json(res, { ok: true, ...atoms });
      } else if (body.text) {
        const atoms = await atomizeContent(body.text, body.source || 'manual');
        return json(res, { ok: true, ...atoms });
      }
      return json(res, { error: 'url or text required' }, 400);
    }

    // POST /api/content/:id/pillar-spoke — generate via pillar cascade
    const pillarMatch = pathname.match(/^\/api\/content-pillar\/([a-zA-Z0-9_-]+)$/);
    if (pillarMatch && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) {
        return json(res, { error: 'ANTHROPIC_API_KEY not configured' }, 500);
      }

      const triggerId = pillarMatch[1];
      const body = await parseBody(req);
      const pillarType = body.pillar_type || 'blog';

      const triggers = readJSON('trigger-queue.json');
      const trigger = triggers.find(t => t.id === triggerId);
      if (!trigger) return json(res, { error: 'Trigger not found' }, 404);

      try {
        const { generatePillarWithSpokes } = require('./generator/content-writer');
        const content = await generatePillarWithSpokes(trigger, pillarType);

        // Run quality gate on all formats
        const { qualityCheck } = require('./generator/quality-gate');
        const qualityScores = {};
        for (const [key, fmt] of Object.entries(content.formats)) {
          if (fmt.content) {
            qualityScores[key] = qualityCheck(fmt.content, key, trigger);
          }
        }
        content.quality_scores = qualityScores;

        const contentArr = readJSON('content.json');
        contentArr.push(content);
        writeJSON('content.json', contentArr);

        // Mark trigger as used
        const tIdx = triggers.findIndex(t => t.id === triggerId);
        if (tIdx !== -1) { triggers[tIdx].status = 'used'; writeJSON('trigger-queue.json', triggers); }

        return json(res, { ok: true, content });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // POST /api/remix — competitor content remixer
    if (pathname === '/api/remix' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) {
        return json(res, { error: 'ANTHROPIC_API_KEY not configured' }, 500);
      }

      const body = await parseBody(req);
      if (!body.url && !body.text) return json(res, { error: 'url or text required' }, 400);

      try {
        let text = body.text || '';
        if (body.url && !text) {
          const fetchRes = await fetch(body.url, {
            headers: { 'User-Agent': 'ContentMachine/1.0' },
            signal: AbortSignal.timeout(15000)
          });
          if (fetchRes.ok) {
            let html = await fetchRes.text();
            const { stripHtml } = require('./lib/utils');
            text = stripHtml(html).slice(0, 6000);
          }
        }

        const { remixContent } = require('./generator/remixer');
        const { buildSystemPromptWithMemory } = require('./generator/content-writer');
        const remixed = await remixContent(text, body.url || 'manual', buildSystemPromptWithMemory());

        // Create trigger + content from remix
        const trigger = {
          id: `remix-${generateId()}`,
          source: 'remix',
          source_detail: body.url || 'Competitor remix',
          title: remixed.title || 'Remixed Content',
          raw_content: text.slice(0, 2000),
          url: body.url || null,
          category: 'COMPETITOR_REMIX',
          captured_at: now(),
          status: 'used',
          score: 0
        };

        const triggers = readJSON('trigger-queue.json');
        triggers.push(trigger);
        writeJSON('trigger-queue.json', triggers);

        // Build content object
        const contentId = generateId();
        const content = {
          id: contentId,
          trigger_id: trigger.id,
          trigger_title: remixed.title || trigger.title,
          trigger_source: 'remix',
          trigger_category: 'COMPETITOR_REMIX',
          trigger_url: body.url || null,
          generated_at: now(),
          status: 'review',
          generation_mode: 'remix',
          remix_angle: remixed.angle || '',
          formats: {
            linkedin: { content: remixed.linkedin_post || null, status: 'review', edited: false },
            x_single: { content: remixed.x_single || null, status: 'review', edited: false },
            carousel: { content: remixed.carousel || null, status: 'review', edited: false },
            blog: { content: remixed.blog_post || null, status: 'review', edited: false }
          },
          atoms: remixed.atoms || null,
          image_prompt: null,
          image_url: null,
          blog_keyword: null,
          youtube_topic: null,
          lead_magnet_topic: null,
          blog_post: remixed.blog_post || null,
          notes: `Remixed from: ${body.url || 'manual input'}\nAngle: ${remixed.angle || 'N/A'}`
        };

        const contentArr = readJSON('content.json');
        contentArr.push(content);
        writeJSON('content.json', contentArr);

        return json(res, { ok: true, content, atoms: remixed.atoms });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // GET /api/series — get content series config
    if (pathname === '/api/series' && method === 'GET') {
      const series = readJSON('series.json');
      return json(res, series);
    }

    // GET /api/hooks — get hook library
    if (pathname === '/api/hooks' && method === 'GET') {
      const hooks = readJSON('hooks.json');
      return json(res, hooks);
    }

    // POST /api/content/:id/remix — rewrite a format with a directive OR create new content piece with a mode
    const remixFmtMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/remix$/);
    if (remixFmtMatch && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const content = readJSON('content.json');
      const idx = content.findIndex(c => c.id === remixFmtMatch[1]);
      if (idx === -1) return json(res, { error: 'Not found' }, 404);
      const body = await parseBody(req);
      const { buildSystemPromptWithMemory } = require('./generator/content-writer');

      // Mode-based remix: creates a NEW content piece with different angle
      if (body.mode) {
        const sourceFormat = body.format || 'linkedin';
        const fmt = content[idx].formats?.[sourceFormat];
        if (!fmt?.content) return json(res, { error: `No ${sourceFormat} content to remix` }, 400);

        try {
          const { remixContent } = require('./lib/claude');
          const remixed = await remixContent(fmt.content, content[idx].trigger_title, body.mode, buildSystemPromptWithMemory());

          const newContent = {
            id: generateId(),
            trigger_id: content[idx].trigger_id,
            trigger_title: content[idx].trigger_title,
            trigger_source: content[idx].trigger_source,
            trigger_category: content[idx].trigger_category,
            trigger_url: content[idx].trigger_url,
            generated_at: now(),
            status: 'review',
            remix_of: content[idx].id,
            remix_mode: body.mode,
            remix_angle: remixed.remix_angle || null,
            formats: {
              linkedin: { content: remixed.linkedin_post || null, status: 'review', edited: false },
              x_single: { content: remixed.x_single || null, status: 'review', edited: false },
              x_thread: { content: remixed.x_thread || null, status: 'review', edited: false },
              hot_take: { content: remixed.hot_take || null, status: 'review', edited: false }
            },
            hook_variants: {},
            image_prompt: null, image_url: null,
            blog_keyword: null, youtube_topic: null, lead_magnet_topic: null,
            quality_score: null,
            notes: `Remixed from ${content[idx].id} (${body.mode})`
          };
          content.push(newContent);
          writeJSON('content.json', content);
          return json(res, { ok: true, content: newContent });
        } catch (err) {
          try { db.logError('generation', 'remix_content', err.message, { contentId: content[idx].id, mode: body.mode }); } catch {}
          return json(res, { error: err.message }, 500);
        }
      }

      // Directive-based remix: rewrites a single format IN-PLACE
      if (!body.format || !body.directive) return json(res, { error: 'format and directive required (or use mode for new-piece remix)' }, 400);
      const fmt = content[idx].formats[body.format];
      if (!fmt?.content) return json(res, { error: 'Format has no content' }, 400);

      const { callClaude, HAIKU } = require('./lib/claude');
      const directives = {
        'more_contrarian': 'Rewrite this to be MORE CONTRARIAN and PROVOCATIVE. Challenge the conventional wisdom. Take a strong stance. Make people want to argue in the comments.',
        'add_story': 'Rewrite this to LEAD WITH A SPECIFIC STORY — a real-sounding scenario of a law firm that experienced this problem. Include their practice area, the mistake, and the dollar amount lost. Make it feel like a conversation, not a lecture.',
        'shorten': 'Rewrite this to be 40% SHORTER. Cut every word that doesn\'t earn its place. Make it punchy and dense. Every sentence should hit hard.',
        'more_data': 'Rewrite this with MORE SPECIFIC NUMBERS AND DATA. Add dollar amounts, percentages, case counts, and time frames. Show the math. Make the reader feel the financial impact.',
        'practice_specific': `Rewrite this tailored specifically to ${body.practice_area || 'personal injury'} lawyers. Use practice-area-specific numbers, scenarios, and pain points. Reference the typical case value, client type, and marketing challenges for this practice area.`,
        'more_human': 'Rewrite this to sound MORE HUMAN and LESS LIKE AI. Use contractions. Start some sentences with "And" or "But". Include a moment of honest doubt or admission. Write like you\'re texting a friend who owns a law firm.',
        'stronger_hook': 'Rewrite ONLY the opening hook (first 2-3 lines) to be dramatically more compelling. Use one of these patterns: (1) A specific failure with a dollar amount, (2) A surprising stat that contradicts expectations, (3) A micro-story that creates an information gap.'
      };
      const directiveText = directives[body.directive] || body.directive;
      const currentContent = typeof fmt.content === 'string' ? fmt.content : JSON.stringify(fmt.content);

      try {
        const remixed = await callClaude({
          model: HAIKU,
          system: buildSystemPromptWithMemory(),
          prompt: `DIRECTIVE: ${directiveText}\n\nORIGINAL CONTENT (${body.format}):\n${currentContent}\n\nTRIGGER CONTEXT: "${content[idx].trigger_title}"\n\nRewrite the content following the directive above. Return ONLY the rewritten content — no preamble, no explanation, no "here's the rewrite." Just the content itself.`,
          maxTokens: 2000
        });
        content[idx].formats[body.format].content = remixed.trim();
        content[idx].formats[body.format].edited = true;
        content[idx].formats[body.format].remix_directive = body.directive;
        if (!content[idx].formats[body.format].original_content) {
          content[idx].formats[body.format].original_content = currentContent;
        }
        writeJSON('content.json', content);
        return json(res, { ok: true, remixed: remixed.trim(), format: body.format, directive: body.directive });
      } catch (err) {
        return json(res, { error: 'Remix failed: ' + err.message }, 500);
      }
    }

    // POST /api/content/:id/swap-hook — swap in a hook variant
    const swapHookMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/swap-hook$/);
    if (swapHookMatch && method === 'POST') {
      const content = readJSON('content.json');
      const idx = content.findIndex(c => c.id === swapHookMatch[1]);
      if (idx === -1) return json(res, { error: 'Not found' }, 404);
      const body = await parseBody(req);
      if (!body.format || body.hook_index === undefined) return json(res, { error: 'format and hook_index required' }, 400);
      const hookKey = body.format === 'linkedin' ? 'linkedin' : 'x';
      const hooks = content[idx].hook_variants?.[hookKey] || [];
      if (!hooks[body.hook_index]) return json(res, { error: 'Hook variant not found' }, 400);
      const newHook = hooks[body.hook_index];
      const fmt = content[idx].formats[body.format];
      if (!fmt?.content || typeof fmt.content !== 'string') return json(res, { error: 'Format has no string content' }, 400);
      // Replace the first 2 lines (the hook) with the selected variant
      const lines = fmt.content.split('\n');
      const hookEnd = lines.findIndex((l, i) => i > 0 && l.trim() === '') || 2;
      const remainingContent = lines.slice(hookEnd).join('\n');
      content[idx].formats[body.format].content = newHook + '\n' + remainingContent;
      content[idx].formats[body.format].edited = true;
      content[idx].formats[body.format].selected_hook = body.hook_index;
      writeJSON('content.json', content);
      // Track hook preference in memory
      const memory = readJSON('memory.json', {});
      if (!memory.hook_preferences) memory.hook_preferences = [];
      memory.hook_preferences.push({ format: body.format, hook_index: body.hook_index, hook_text: newHook, trigger_title: content[idx].trigger_title, selected_at: now() });
      if (memory.hook_preferences.length > 50) memory.hook_preferences = memory.hook_preferences.slice(-50);
      writeJSON('memory.json', memory);
      return json(res, { ok: true, new_content: content[idx].formats[body.format].content });
    }

    // POST /api/content/:id/repurpose — repurpose content to a different format
    const repurposeMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/repurpose$/);
    if (repurposeMatch && method === 'POST') {
      const content = readJSON('content.json');
      const idx = content.findIndex(c => c.id === repurposeMatch[1]);
      if (idx === -1) return json(res, { error: 'Not found' }, 404);
      const body = await parseBody(req);
      if (!body.source_format || !body.target_format) return json(res, { error: 'source_format and target_format required' }, 400);
      const sourceContent = content[idx].formats[body.source_format]?.content;
      if (!sourceContent) return json(res, { error: 'Source format has no content' }, 400);
      // Check if target already has content
      if (content[idx].formats[body.target_format]?.content && !body.overwrite) {
        return json(res, { error: 'Target format already has content. Set overwrite: true to replace.' }, 400);
      }
      json(res, { ok: true, status: 'generating' });
      // Generate in background
      setImmediate(async () => {
        try {
          const { repurposeContent } = require('./lib/claude');
          const { buildSystemPromptWithMemory } = require('./generator/content-writer');
          const system = buildSystemPromptWithMemory();
          const result = await repurposeContent(sourceContent, body.source_format, body.target_format, system);
          const freshContent = readJSON('content.json');
          const freshIdx = freshContent.findIndex(c => c.id === repurposeMatch[1]);
          if (freshIdx !== -1) {
            if (!freshContent[freshIdx].formats[body.target_format]) {
              freshContent[freshIdx].formats[body.target_format] = { content: null, status: 'review', edited: false };
            }
            freshContent[freshIdx].formats[body.target_format].content = result;
            freshContent[freshIdx].formats[body.target_format].status = 'review';
            freshContent[freshIdx].formats[body.target_format].repurposed_from = body.source_format;
            writeJSON('content.json', freshContent);
            console.log(`[repurpose] ${repurposeMatch[1]}: ${body.source_format} → ${body.target_format}`);
          }
        } catch (err) {
          console.error(`[repurpose] Error: ${err.message}`);
        }
      });
      return;
    }

    // POST /api/quality-check — quality check content
    if (pathname === '/api/quality-check' && method === 'POST') {
      const body = await parseBody(req);
      if (!body.content || !body.format) return json(res, { error: 'content and format required' }, 400);

      const { qualityCheck } = require('./generator/quality-gate');
      const result = qualityCheck(body.content, body.format, body.trigger || {});
      return json(res, result);
    }

    // --- Meetings API ---

    // GET /api/meetings
    if (pathname === '/api/meetings' && method === 'GET') {
      const type = url.searchParams.get('type') || undefined;
      const client = url.searchParams.get('client') || undefined;
      const from = url.searchParams.get('from') || undefined;
      const to = url.searchParams.get('to') || undefined;
      const limit = parseInt(url.searchParams.get('limit')) || 50;
      const offset = parseInt(url.searchParams.get('offset')) || 0;
      const meetings = db.getMeetings({ limit, offset, type, client, from, to });
      return json(res, meetings);
    }

    // GET /api/meetings/stats
    if (pathname === '/api/meetings/stats' && method === 'GET') {
      const stats = db.getStats();
      return json(res, stats);
    }

    // GET /api/meetings/:id
    const meetingIdMatch = pathname.match(/^\/api\/meetings\/(\d+)$/);
    if (meetingIdMatch && method === 'GET') {
      const meeting = db.getMeeting(parseInt(meetingIdMatch[1]));
      if (!meeting) return json(res, { error: 'Not found' }, 404);
      return json(res, meeting);
    }

    // GET /api/meetings/:id/actions
    const meetingActionsMatch = pathname.match(/^\/api\/meetings\/(\d+)\/actions$/);
    if (meetingActionsMatch && method === 'GET') {
      const actions = db.getActions({ meeting_id: parseInt(meetingActionsMatch[1]) });
      return json(res, actions);
    }

    // GET /api/meetings/:id/atoms
    const meetingAtomsMatch = pathname.match(/^\/api\/meetings\/(\d+)\/atoms$/);
    if (meetingAtomsMatch && method === 'GET') {
      const atoms = db.getAtoms({ meeting_id: parseInt(meetingAtomsMatch[1]) });
      return json(res, atoms);
    }

    // POST /api/meetings/sync — trigger Fireflies sync
    if (pathname === '/api/meetings/sync' && method === 'POST') {
      if (!process.env.FIREFLIES_API_KEY) {
        return json(res, { error: 'FIREFLIES_API_KEY not configured' }, 500);
      }

      try {
        // Paginate through all transcripts (50 per page, up to 200 total)
        let allTranscripts = [];
        for (let skip = 0; skip < 200; skip += 50) {
          const batch = await fireflies.fetchTranscripts({ limit: 50, skip });
          if (!batch || batch.length === 0) break;
          allTranscripts = allTranscripts.concat(batch);
          if (batch.length < 50) break; // last page
        }

        let synced = 0;
        let processed = 0;

        for (const t of allTranscripts) {
          // Skip if already in DB
          const existing = db.getDb().prepare('SELECT id FROM meetings WHERE fireflies_id = ?').get(t.id);
          if (existing) continue;

          // Fetch full transcript
          let full;
          try {
            full = await fireflies.fetchTranscript(t.id);
          } catch (err) {
            console.error(`[sync] Failed to fetch transcript ${t.id}:`, err.message);
            continue;
          }
          if (!full) continue;

          const transcriptText = fireflies.sentencesToTranscript(full.sentences || []);

          const meeting = db.insertMeeting({
            fireflies_id: full.id,
            title: full.title || 'Untitled Meeting',
            date: full.dateString || new Date().toISOString(),
            duration_minutes: full.duration || null,
            client_name: null,
            client_email: null,  // Don't use organizer_email — AI will extract client email from transcript
            transcript: transcriptText,
            summary: full.summary?.overview || null,
            raw_response: full
          });

          synced++;
          console.log(`[sync] Imported: ${full.title} (${synced}/${allTranscripts.length})`);

          // Process with AI if API key available
          if (process.env.ANTHROPIC_API_KEY && transcriptText) {
            try {
              await processMeeting(meeting);
              processed++;
            } catch (err) {
              console.error(`[sync] Processing failed for meeting #${meeting.id}:`, err.message);
            }
          }
        }

        return json(res, { ok: true, synced, processed, total: allTranscripts.length });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // POST /api/meetings/reprocess — clear derived data and re-process all meetings
    if (pathname === '/api/meetings/reprocess' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) {
        return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      }

      // Clear corrupted derived data
      db.clearDerivedData();
      console.log('[reprocess] Cleared all derived data (clients, actions, atoms, patterns)');

      // Get all meetings that now need reprocessing
      const meetings = db.getUnprocessedMeetings();
      console.log(`[reprocess] Reprocessing ${meetings.length} meetings...`);

      // Process in background, return immediately
      json(res, { ok: true, queued: meetings.length, message: 'Reprocessing started in background' });

      setImmediate(async () => {
        let processed = 0;
        for (const meeting of meetings) {
          try {
            await processMeeting(meeting);
            processed++;
            console.log(`[reprocess] ${processed}/${meetings.length} done: ${meeting.title}`);
          } catch (err) {
            console.error(`[reprocess] Failed meeting #${meeting.id}:`, err.message);
          }
        }
        console.log(`[reprocess] Complete: ${processed}/${meetings.length} processed`);
      });
      return;
    }

    // POST /api/meetings/:id/extract-triggers — extract content triggers from meeting insights
    const extractMatch = pathname.match(/^\/api\/meetings\/(\d+)\/extract-triggers$/);
    if (extractMatch && method === 'POST') {
      const meeting = db.getMeeting(parseInt(extractMatch[1]));
      if (!meeting) return json(res, { error: 'Meeting not found' }, 404);

      const ed = meeting.extracted_data || {};
      const atoms = db.getAtoms({ meeting_id: meeting.id });
      const triggers = readJSON('trigger-queue.json');
      const newTriggers = [];

      // Extract from pain points
      for (const pp of (ed.pain_points || [])) {
        if (pp.length > 20) {
          newTriggers.push({
            id: `meeting-${generateId()}`,
            source: 'meeting',
            source_detail: `From meeting: ${meeting.title}`,
            title: pp.slice(0, 200),
            raw_content: `Pain point from ${meeting.client_name || 'client'} meeting (${meeting.date?.slice(0, 10)}): ${pp}`,
            category: 'PAIN_POINT',
            captured_at: now(),
            status: 'pending',
            score: 0
          });
        }
      }

      // Extract from objections
      for (const obj of (ed.objections || [])) {
        if (obj.length > 20) {
          newTriggers.push({
            id: `meeting-${generateId()}`,
            source: 'meeting',
            source_detail: `From meeting: ${meeting.title}`,
            title: `Objection: ${obj.slice(0, 180)}`,
            raw_content: `Common objection from ${meeting.client_name || 'client'}: ${obj}. Address this in content to pre-handle objections.`,
            category: 'QUESTION',
            captured_at: now(),
            status: 'pending',
            score: 0
          });
        }
      }

      // Extract from content atoms
      for (const atom of atoms.filter(a => a.type === 'insight' || a.type === 'quote' || a.type === 'success_story')) {
        newTriggers.push({
          id: `meeting-${generateId()}`,
          source: 'meeting',
          source_detail: `From meeting: ${meeting.title}`,
          title: (atom.content || '').slice(0, 200),
          raw_content: atom.content,
          category: atom.type === 'success_story' ? 'CLIENT_WIN' : 'CONTENT_PIECE',
          captured_at: now(),
          status: 'pending',
          score: 0
        });
      }

      if (newTriggers.length > 0) {
        triggers.push(...newTriggers);
        writeJSON('trigger-queue.json', triggers);
      }

      return json(res, { ok: true, extracted: newTriggers.length, triggers: newTriggers.map(t => ({ id: t.id, title: t.title, category: t.category })) });
    }

    // --- Clients API ---

    // GET /api/clients
    if (pathname === '/api/clients' && method === 'GET') {
      const status = url.searchParams.get('status') || undefined;
      const search = url.searchParams.get('search') || undefined;
      const clients = db.getClients({ status, search });
      return json(res, clients);
    }

    // GET /api/clients/:id
    const clientIdMatch = pathname.match(/^\/api\/clients\/(\d+)$/);
    if (clientIdMatch && method === 'GET') {
      const client = db.getClient(parseInt(clientIdMatch[1]));
      if (!client) return json(res, { error: 'Not found' }, 404);
      // Include meeting history, events, proposals
      const meetings = db.getMeetings({ client: client.email || client.name, limit: 20 });
      const events = client.email
        ? db.getEvents({ limit: 50 }).filter(e => e.client_email === client.email)
        : [];
      const proposals = db.getProposals({ client_id: client.id });
      return json(res, { ...client, meetings, events, proposals });
    }

    // GET /api/events — list external events
    if (pathname === '/api/events' && method === 'GET') {
      const source = url.searchParams.get('source') || undefined;
      return json(res, db.getEvents({ source }));
    }

    // --- Actions API ---

    // GET /api/actions — list all actions with filters
    if (pathname === '/api/actions' && method === 'GET') {
      const status = url.searchParams.get('status') || undefined;
      const owner = url.searchParams.get('owner') || undefined;
      const meeting_id = url.searchParams.get('meeting_id') || undefined;
      const actions = db.getActions({ status, meeting_id: meeting_id ? parseInt(meeting_id) : undefined });
      // Filter by owner in JS since db.getActions doesn't support it
      const filtered = owner ? actions.filter(a => a.owner === owner) : actions;
      return json(res, filtered);
    }

    // PUT /api/actions/:id — update action status
    const actionUpdateMatch = pathname.match(/^\/api\/actions\/(\d+)$/);
    if (actionUpdateMatch && method === 'PUT') {
      const body = await parseBody(req);
      const action = db.updateAction(parseInt(actionUpdateMatch[1]), body);
      if (!action) return json(res, { error: 'Not found' }, 404);
      return json(res, { ok: true, ...action });
    }

    // --- Feedback API ---

    // POST /api/feedback
    if (pathname === '/api/feedback' && method === 'POST') {
      const body = await parseBody(req);
      if (!body.output_id || !body.output_type || !body.rating) {
        return json(res, { error: 'output_id, output_type, and rating required' }, 400);
      }
      const fb = db.insertFeedback(body);
      return json(res, { ok: true, ...fb });
    }

    // GET /api/feedback
    if (pathname === '/api/feedback' && method === 'GET') {
      const output_type = url.searchParams.get('type') || undefined;
      return json(res, db.getFeedback({ output_type }));
    }

    // GET /api/feedback/summary
    if (pathname === '/api/feedback/summary' && method === 'GET') {
      return json(res, db.getFeedbackSummary());
    }

    // GET /api/style-guides
    if (pathname === '/api/style-guides' && method === 'GET') {
      return json(res, db.getStyleGuides());
    }

    // POST /api/style-guides/learn — analyze feedback and generate style guides
    if (pathname === '/api/style-guides/learn' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) {
        return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      }
      try {
        const { callClaude, HAIKU } = require('./lib/claude');
        const feedback = db.getFeedback({ limit: 200 });
        if (feedback.length < 5) {
          return json(res, { error: 'Need at least 5 feedback entries to learn patterns' }, 400);
        }

        const positive = feedback.filter(f => f.rating >= 4);
        const negative = feedback.filter(f => f.rating <= 2);
        const byType = {};
        for (const f of feedback) {
          if (!byType[f.output_type]) byType[f.output_type] = { pos: [], neg: [] };
          if (f.rating >= 4) byType[f.output_type].pos.push(f);
          else if (f.rating <= 2) byType[f.output_type].neg.push(f);
        }

        const guides = [];
        for (const [type, data] of Object.entries(byType)) {
          if (data.pos.length + data.neg.length < 3) continue;
          const prompt = `Based on this feedback data, generate a style guide for "${type}" outputs.

Positive feedback (${data.pos.length} items): ${data.pos.map(f => f.comment || 'liked').join('; ')}
Negative feedback (${data.neg.length} items): ${data.neg.map(f => f.comment || 'disliked').join('; ')}

Write 3-5 bullet points of dos and don'ts for this output type. Be specific and actionable.`;

          const text = await callClaude({ model: HAIKU, system: 'You analyze feedback to create style guides. Be concise.', prompt, maxTokens: 500 });
          const guide = db.upsertStyleGuide(type, text, data.pos.length + data.neg.length);
          guides.push(guide);
        }

        return json(res, { ok: true, guides });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // --- Chat API ---

    // GET /api/chat/messages — get chat history
    if (pathname === '/api/chat/messages' && method === 'GET') {
      return json(res, db.getChatMessages({ limit: 50 }));
    }

    // POST /api/chat — send message to the brain
    if (pathname === '/api/chat' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) {
        return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      }

      const body = await parseBody(req);
      const message = (body.message || '').trim();
      if (!message) return json(res, { error: 'message required' }, 400);

      // Save user message
      db.insertChatMessage({ role: 'user', content: message });

      try {
        // Build context based on the question
        const context = buildChatContext(message);
        const { callClaude, SONNET } = require('./lib/claude');
        const { getKnowledgeBase } = require('./lib/knowledge');
        const { buildIntelligenceContext } = require('./lib/intelligence');

        const kb = getKnowledgeBase();
        const intel = buildIntelligenceContext();

        const systemPrompt = `${kb}

${intel}

You are the Mortar Metrics Command Centre — the operating brain of this agency.

Give DIRECTIVES not data. Name names. Give deadlines. Reference call data. Think in revenue.
Connect every recommendation to the four levers: Volume, Conversion, Speed, Retention.
When you spot a gap, say what to build and how.

"$4K/month deal dying = $48K/year lost. Call them NOW." — that's your energy.

Closing tasks -> Yaseer. Content tasks -> Monty/Juhi. System/strategy -> Fardeen.
Yaseer needs handholding: "Call Kyle Kinsey at 2 PM. Say: we looked at firms in your area..."

After answering, ask ONE question to learn something: deal outcomes, call results, process updates.

LIVE DATA:
${context}`;

        const response = await callClaude({
          model: SONNET,
          system: systemPrompt,
          prompt: message,
          maxTokens: 2000
        });

        // Save assistant response
        db.insertChatMessage({ role: 'assistant', content: response, context_used: context.slice(0, 500) });

        // Correction detection — learn from user corrections
        const lower = message.toLowerCase();
        if (lower.includes("that's wrong") || lower.includes('actually we') || lower.includes('stop saying') || lower.includes('remember that') || lower.includes("don't say") || lower.includes('correct:')) {
          db.insertTeamInput({ question: 'Correction via chat', answer: message, answered_by: 'user', category: 'correction' });
          console.log('[chat] Correction detected and stored');
        }

        return json(res, { ok: true, response, context_length: context.length });
      } catch (err) {
        console.error('[chat] Error:', err.message);
        return json(res, { error: err.message }, 500);
      }
    }

    // --- Proposals API ---

    // GET /api/proposals
    if (pathname === '/api/proposals' && method === 'GET') {
      const status = url.searchParams.get('status') || undefined;
      const client_id = url.searchParams.get('client_id') || undefined;
      const meeting_id = url.searchParams.get('meeting_id') || undefined;
      let proposals = db.getProposals({ status, client_id: client_id ? parseInt(client_id) : undefined });
      if (meeting_id) proposals = proposals.filter(p => p.meeting_id === parseInt(meeting_id));
      return json(res, proposals);
    }

    // GET /api/proposals/:id
    const proposalIdMatch = pathname.match(/^\/api\/proposals\/(\d+)$/);
    if (proposalIdMatch && method === 'GET') {
      const proposal = db.getProposal(parseInt(proposalIdMatch[1]));
      if (!proposal) return json(res, { error: 'Not found' }, 404);
      return json(res, proposal);
    }

    // POST /api/proposals/generate/:meetingId
    const proposalGenMatch = pathname.match(/^\/api\/proposals\/generate\/(\d+)$/);
    if (proposalGenMatch && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) {
        return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      }
      try {
        const { generateProposal } = require('./lib/proposal-generator');
        const proposal = await generateProposal(parseInt(proposalGenMatch[1]));
        return json(res, { ok: true, proposal });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // PUT /api/proposals/:id
    const proposalUpdateMatch = pathname.match(/^\/api\/proposals\/(\d+)$/);
    if (proposalUpdateMatch && method === 'PUT') {
      const body = await parseBody(req);
      const proposal = db.updateProposal(parseInt(proposalUpdateMatch[1]), body);
      if (!proposal) return json(res, { error: 'Not found' }, 404);
      return json(res, { ok: true, ...proposal });
    }

    // --- Inspirations API ---

    // GET /api/inspirations
    if (pathname === '/api/inspirations' && method === 'GET') {
      const used = url.searchParams.get('used');
      const inspirations = db.getInspirations({ used: used !== null ? used === 'true' : undefined });
      return json(res, inspirations);
    }

    // POST /api/inspirations
    if (pathname === '/api/inspirations' && method === 'POST') {
      const body = await parseBody(req);
      if (!body.content) return json(res, { error: 'content required' }, 400);
      const insp = db.insertInspiration({
        source: body.source || 'manual',
        content: body.content,
        tags: body.tags || []
      });
      return json(res, { ok: true, inspiration: insp });
    }

    // POST /api/inspirations/sync — sync meeting atoms to inspirations
    if (pathname === '/api/inspirations/sync' && method === 'POST') {
      const added = db.syncAtomsToInspirations();
      return json(res, { ok: true, added });
    }

    // POST /api/inspirations/:id/use — mark as used and create a trigger
    const inspUseMatch = pathname.match(/^\/api\/inspirations\/(\d+)\/use$/);
    if (inspUseMatch && method === 'POST') {
      const id = parseInt(inspUseMatch[1]);
      const insp = db.markInspirationUsed(id);
      if (!insp) return json(res, { error: 'Not found' }, 404);

      // Create a trigger from this inspiration
      const trigger = {
        id: `insp-${generateId()}`,
        source: 'inspiration',
        source_detail: insp.source,
        title: (insp.content || '').slice(0, 200),
        raw_content: insp.content,
        category: 'CONTENT_PIECE',
        captured_at: now(),
        status: 'pending',
        score: 0,
        tags: insp.tags || []
      };
      const triggers = readJSON('trigger-queue.json');
      triggers.push(trigger);
      writeJSON('trigger-queue.json', triggers);

      return json(res, { ok: true, trigger });
    }

    // DELETE /api/inspirations/:id
    const inspDeleteMatch = pathname.match(/^\/api\/inspirations\/(\d+)$/);
    if (inspDeleteMatch && method === 'DELETE') {
      db.deleteInspiration(parseInt(inspDeleteMatch[1]));
      return json(res, { ok: true });
    }

    // --- Briefs API ---

    // GET /api/briefs
    if (pathname === '/api/briefs' && method === 'GET') {
      const client_id = url.searchParams.get('client_id') || undefined;
      const { getBriefs } = require('./lib/brief-generator');
      const briefs = getBriefs({ client_id: client_id ? parseInt(client_id) : undefined });
      return json(res, briefs);
    }

    // POST /api/briefs/generate/:clientId
    const briefGenMatch = pathname.match(/^\/api\/briefs\/generate\/(\d+)$/);
    if (briefGenMatch && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) {
        return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      }
      try {
        const { generateBrief } = require('./lib/brief-generator');
        const brief = await generateBrief(parseInt(briefGenMatch[1]));
        return json(res, { ok: true, brief });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // --- Health API ---

    // GET /api/health — get health overview for all clients
    if (pathname === '/api/health' && method === 'GET') {
      const overview = db.getHealthOverview();
      return json(res, overview);
    }

    // POST /api/health/check — run health check and snapshot
    if (pathname === '/api/health/check' && method === 'POST') {
      const results = db.runHealthCheck();
      return json(res, {
        ok: true,
        checked: results.length,
        red: results.filter(r => r.health_status === 'red').length,
        yellow: results.filter(r => r.health_status === 'yellow').length,
        green: results.filter(r => r.health_status === 'green').length,
        results
      });
    }

    // GET /api/health/:clientId — get health for a specific client
    const healthClientMatch = pathname.match(/^\/api\/health\/(\d+)$/);
    if (healthClientMatch && method === 'GET') {
      const health = db.computeClientHealth(parseInt(healthClientMatch[1]));
      if (!health) return json(res, { error: 'Client not found' }, 404);
      const history = db.getHealthHistory(parseInt(healthClientMatch[1]));
      return json(res, { ...health, history });
    }

    // --- Pestering API ---

    // GET /api/pestering/stages — get stage definitions
    if (pathname === '/api/pestering/stages' && method === 'GET') {
      const { getStages } = require('./lib/pestering');
      return json(res, getStages());
    }

    // GET /api/pestering — get pestering entries
    if (pathname === '/api/pestering' && method === 'GET') {
      const status = url.searchParams.get('status') || undefined;
      const client_id = url.searchParams.get('client_id');
      const entries = db.getPesterEntries({
        status,
        client_id: client_id ? parseInt(client_id) : undefined,
        limit: 200
      });
      return json(res, entries);
    }

    // GET /api/pestering/due — get overdue entries
    if (pathname === '/api/pestering/due' && method === 'GET') {
      const { getDueEntries } = require('./lib/pestering');
      return json(res, getDueEntries());
    }

    // POST /api/pestering/create/:clientId/:stage — create pestering schedule
    const pesterCreateMatch = pathname.match(/^\/api\/pestering\/create\/(\d+)\/(\w+)$/);
    if (pesterCreateMatch && method === 'POST') {
      const { createPesterSchedule } = require('./lib/pestering');
      const entries = createPesterSchedule(parseInt(pesterCreateMatch[1]), pesterCreateMatch[2]);
      return json(res, { ok: true, entries });
    }

    // POST /api/pestering/:id/generate — generate message for an entry
    const pesterGenMatch = pathname.match(/^\/api\/pestering\/(\d+)\/generate$/);
    if (pesterGenMatch && method === 'POST') {
      const { generatePesterMessage } = require('./lib/pestering');
      const message = await generatePesterMessage(parseInt(pesterGenMatch[1]));
      return json(res, { ok: true, message });
    }

    // PUT /api/pestering/:id — update pestering entry (mark sent/skipped)
    const pesterUpdateMatch = pathname.match(/^\/api\/pestering\/(\d+)$/);
    if (pesterUpdateMatch && method === 'PUT') {
      const body = await parseBody(req);
      const { markSent, markSkipped } = require('./lib/pestering');
      if (body.status === 'sent') markSent(parseInt(pesterUpdateMatch[1]));
      else if (body.status === 'skipped') markSkipped(parseInt(pesterUpdateMatch[1]));
      else db.updatePesterEntry(parseInt(pesterUpdateMatch[1]), body);
      return json(res, { ok: true });
    }

    // --- Deal Outcomes API ---

    // GET /api/deals — get deal outcomes
    if (pathname === '/api/deals' && method === 'GET') {
      const outcome = url.searchParams.get('outcome') || undefined;
      return json(res, db.getDealOutcomes({ outcome }));
    }

    // POST /api/deals — record deal outcome
    if (pathname === '/api/deals' && method === 'POST') {
      const body = await parseBody(req);
      if (!body.outcome) return json(res, { error: 'outcome required' }, 400);
      // Auto-resolve client_id from client_name if not provided
      if (!body.client_id && body.client_name) {
        const clients = db.getClients({ search: body.client_name, limit: 1 });
        if (clients.length) body.client_id = clients[0].id;
      }
      const deal = db.insertDealOutcome(body);
      // Telegram alert on close/loss
      if (body.outcome === 'won') {
        sendTelegramAlert(`💰 <b>DEAL CLOSED</b>: ${body.client_name || 'Unknown'}${body.monthly_value ? ' — $' + body.monthly_value + '/mo' : ''}`);
      } else if (body.outcome === 'lost') {
        sendTelegramAlert(`❌ <b>DEAL LOST</b>: ${body.client_name || 'Unknown'}${body.loss_reason ? ' — ' + body.loss_reason : ''}`);
      }
      return json(res, { ok: true, deal });
    }

    // --- Insights API ---

    // GET /api/insights — get learned insights
    if (pathname === '/api/insights' && method === 'GET') {
      const category = url.searchParams.get('category') || undefined;
      return json(res, db.getInsights({ category }));
    }

    // PUT /api/insights/:id — update insight (reject, confirm)
    const insightUpdateMatch = pathname.match(/^\/api\/insights\/(\d+)$/);
    if (insightUpdateMatch && method === 'PUT') {
      const body = await parseBody(req);
      db.updateInsight(parseInt(insightUpdateMatch[1]), body);
      return json(res, { ok: true });
    }

    // POST /api/insights/playbook — generate objection playbook from all meetings
    if (pathname === '/api/insights/playbook' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'API key not set' }, 500);
      const { callClaude, parseJsonResponse, SONNET } = require('./lib/claude');
      const { getKnowledgeBase } = require('./lib/knowledge');

      // Gather all objections from meetings
      const meetings = db.getMeetings({ limit: 100 });
      const allObjections = [];
      for (const m of meetings) {
        const ed = m.extracted_data || {};
        if (ed.objections?.length) {
          for (const obj of ed.objections) {
            allObjections.push({ objection: obj, meeting: m.title, client: m.client_name, type: m.meeting_type, date: m.date });
          }
        }
      }

      // Get existing insights
      const objectionInsights = db.getInsights({ category: 'objection' });

      const kb = getKnowledgeBase();
      const prompt = `Generate an objection playbook from these real objections heard on calls.

ALL OBJECTIONS (${allObjections.length} total):
${allObjections.map(o => `- "${o.objection}" (${o.client || 'unknown'}, ${o.date?.slice(0, 10)})`).join('\n')}

EXISTING INSIGHTS:
${objectionInsights.map(i => `- ${i.insight} (${i.frequency}x)`).join('\n') || '(none)'}

Group similar objections. For each group, provide:
1. The objection theme
2. Frequency (how many times heard)
3. Best response framework
4. Example script for Yaseer

Return JSON array (no fences):
[{ "theme": "...", "frequency": N, "examples": ["..."], "response_framework": "...", "script": "..." }]`;

      try {
        const text = await callClaude({
          model: SONNET,
          system: `${kb}\n\nYou build sales objection playbooks from real call data. Be specific and actionable.`,
          prompt,
          maxTokens: 3000
        });
        const playbook = parseJsonResponse(text) || [];

        // Store top objections as insights
        for (const item of playbook.slice(0, 10)) {
          db.upsertInsight('objection', `${item.theme}: ${item.response_framework}`, 'playbook', null);
        }

        return json(res, { ok: true, playbook, total_objections: allObjections.length });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // GET /api/team-inputs — get team inputs
    if (pathname === '/api/team-inputs' && method === 'GET') {
      const category = url.searchParams.get('category') || undefined;
      const unanswered = url.searchParams.get('unanswered') === 'true';
      return json(res, db.getTeamInputs({ category, unanswered }));
    }

    // --- Advisory Endpoints ---

    // POST /api/advisory/gaps — detect operational gaps
    if (pathname === '/api/advisory/gaps' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'API key not set' }, 500);
      const { detectGaps } = require('./lib/advisory');
      const result = await detectGaps();
      return json(res, result);
    }

    // POST /api/advisory/roi — calculate ROI projection
    if (pathname === '/api/advisory/roi' && method === 'POST') {
      const body = await parseBody(req);
      const { calculateROI } = require('./lib/advisory');
      const result = calculateROI(body);
      return json(res, result);
    }

    // POST /api/advisory/discovery-framework — extract framework from best calls
    if (pathname === '/api/advisory/discovery-framework' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'API key not set' }, 500);
      const { extractDiscoveryFramework } = require('./lib/advisory');
      const result = await extractDiscoveryFramework();
      return json(res, result);
    }

    // --- Webhook Endpoints ---

    // POST /api/webhooks/fireflies
    if (pathname === '/api/webhooks/fireflies' && method === 'POST') {
      const rawBody = await parseRawBody(req);
      const secret = process.env.FIREFLIES_WEBHOOK_SECRET;

      if (secret) {
        const signature = req.headers['x-hub-signature'];
        if (!verifyHmac(rawBody, signature, secret)) {
          return json(res, { error: 'Invalid signature' }, 401);
        }
      }

      let payload;
      try { payload = JSON.parse(rawBody); } catch { return json(res, { error: 'Invalid JSON' }, 400); }

      // Respond 200 immediately
      json(res, { ok: true });

      // Process in background
      setImmediate(async () => {
        try {
          const meetingId = payload.meetingId;
          if (!meetingId) return;

          // Check if already synced
          const existing = db.getDb().prepare('SELECT id FROM meetings WHERE fireflies_id = ?').get(meetingId);
          if (existing) return;

          const full = await fireflies.fetchTranscript(meetingId);
          if (!full) return;

          const transcriptText = fireflies.sentencesToTranscript(full.sentences || []);

          const meeting = db.insertMeeting({
            fireflies_id: full.id,
            title: full.title || 'Untitled Meeting',
            date: full.dateString || new Date().toISOString(),
            duration_minutes: full.duration || null,
            client_email: null,  // Don't use organizer_email — AI will extract client email from transcript
            transcript: transcriptText,
            summary: full.summary?.overview || null,
            raw_response: full
          });

          if (process.env.ANTHROPIC_API_KEY && transcriptText) {
            await processMeeting(meeting);
          }

          console.log(`[webhook/fireflies] Processed meeting: ${full.title}`);
        } catch (err) {
          console.error('[webhook/fireflies] Error:', err.message);
        }
      });
      return;
    }

    // POST /api/webhooks/instantly — deep integration for all 17 event types
    if (pathname === '/api/webhooks/instantly' && method === 'POST') {
      const secret = process.env.INSTANTLY_WEBHOOK_SECRET;
      if (secret) {
        const headerSecret = req.headers['x-webhook-secret'];
        if (!verifySecret(headerSecret, secret)) {
          return json(res, { error: 'Invalid secret' }, 401);
        }
      }

      const body = await parseBody(req);
      const eventType = body.event_type || 'unknown';
      const name = [body.firstName, body.lastName].filter(Boolean).join(' ') || null;
      const email = body.lead_email || null;

      db.insertEvent({
        source: 'instantly',
        event_type: eventType,
        client_name: name,
        client_email: email,
        data: body
      });

      // Map event types to client status updates
      const statusMap = {
        lead_meeting_booked: 'prospect',
        lead_interested: 'prospect',
        lead_closed: 'active',
        reply_received: 'prospect'
      };

      // High-value events: create/update client
      if (['lead_meeting_booked', 'lead_interested', 'reply_received', 'lead_closed',
           'email_opened', 'link_clicked'].includes(eventType)) {
        if (email) {
          db.upsertClient(email, {
            name: name || 'Unknown',
            firm_name: body.companyName || null,
            source: 'instantly',
            status: statusMap[eventType] || 'prospect'
          });
        }
      }

      // Meeting booked: auto-create action item
      if (eventType === 'lead_meeting_booked' && email) {
        const client = db.getDb().prepare('SELECT id FROM clients WHERE email = ?').get(email);
        if (client) {
          db.insertAction({
            client_id: client.id,
            description: `Meeting booked via Instantly with ${name || email}${body.campaign_name ? ' (campaign: ' + body.campaign_name + ')' : ''}`,
            owner: 'us',
            status: 'open'
          });
        }
      }

      // Reply received: auto-create action item for follow-up
      if (eventType === 'reply_received' && email) {
        const client = db.getDb().prepare('SELECT id FROM clients WHERE email = ?').get(email);
        if (client) {
          db.insertAction({
            client_id: client.id,
            description: `Reply from ${name || email} — review and respond${body.reply_text ? ': "' + (body.reply_text || '').slice(0, 100) + '"' : ''}`,
            owner: 'us',
            status: 'open'
          });
        }
      }

      // Instant Telegram alerts for high-value events
      if (eventType === 'lead_interested' || eventType === 'reply_received') {
        sendTelegramAlert(`🔥 <b>New interested lead:</b> ${name || email || 'unknown'}${body.companyName ? ' at ' + body.companyName : ''}\nYaseer: call NOW.${body.reply_text ? '\n<i>"' + (body.reply_text || '').slice(0, 200) + '"</i>' : ''}`);
      }
      if (eventType === 'lead_meeting_booked') {
        sendTelegramAlert(`📅 <b>Meeting booked:</b> ${name || email || 'unknown'}${body.companyName ? ' at ' + body.companyName : ''}\nBrief generating...`);
      }
      if (eventType === 'lead_closed') {
        sendTelegramAlert(`💰 <b>CLOSED:</b> ${name || email}${body.companyName ? ' at ' + body.companyName : ''}\nWhat worked? Reply with details.`);
      }

      console.log(`[webhook/instantly] ${eventType}: ${name || email || 'unknown'}`);
      return json(res, { ok: true });
    }

    // POST /api/webhooks/reports — mortar-reports webhook (deep integration)
    if (pathname === '/api/webhooks/reports' && method === 'POST') {
      const secret = process.env.MORTAR_REPORTS_WEBHOOK_SECRET;
      if (secret) {
        const headerSecret = req.headers['x-webhook-secret'];
        if (!verifySecret(headerSecret, secret)) {
          return json(res, { error: 'Invalid secret' }, 401);
        }
      }

      const body = await parseBody(req);
      const lead = body.lead || {};
      const report = body.report || {};
      const opportunity = body.opportunity || {};

      db.insertEvent({
        source: 'mortar-reports',
        event_type: body.event || 'report_event',
        client_name: lead.name || null,
        client_email: lead.email || null,
        data: body
      });

      // Auto-create/update client from report lead
      let clientId = null;
      if (lead.email || lead.name) {
        const client = db.upsertClient(lead.email || null, {
          name: lead.name || 'Unknown',
          firm_name: report.firm_name || null,
          practice_areas: report.practice_label ? [report.practice_label] : [],
          source: 'mortar-reports',
          status: 'prospect'
        });
        clientId = client?.id || null;
      }

      // Auto-create action item
      if (clientId && body.event === 'report_approved') {
        db.insertAction({
          client_id: clientId,
          description: `Report approved for ${report.firm_name || lead.name} (${report.practice_label || 'general'}, ${report.location || 'unknown location'})${opportunity.total_range ? ' — opportunity: ' + opportunity.total_range : ''}`,
          owner: 'us',
          status: 'open'
        });
      }

      // Auto-create content trigger from report insights
      if (body.event === 'report_approved' && opportunity.gaps?.length > 0) {
        try {
          const gapsText = opportunity.gaps.map(g => typeof g === 'string' ? g : g.gap || g.description || JSON.stringify(g)).join('\n');
          const trigger = {
            id: `report-${generateId()}`,
            source: 'mortar-reports',
            source_detail: report.firm_name || lead.name || 'report',
            title: `Marketing gaps: ${(report.practice_label || 'law firm')} in ${report.location || 'unknown'}`.slice(0, 200),
            raw_content: `Report for ${report.firm_name || lead.name}\nPractice: ${report.practice_label || 'N/A'}\nLocation: ${report.location || 'N/A'}\nOpportunity: ${opportunity.total_range || 'N/A'}\n\nGaps found:\n${gapsText}`,
            category: 'CONTENT_PIECE',
            captured_at: now(),
            status: 'pending',
            score: 0,
            tags: ['from-report', report.practice_label || 'legal'].filter(Boolean)
          };
          const triggers = readJSON('trigger-queue.json');
          triggers.push(trigger);
          writeJSON('trigger-queue.json', triggers);
          console.log(`[webhook/reports] Created content trigger from report for ${report.firm_name || lead.name}`);
        } catch (err) {
          console.error('[webhook/reports] Trigger creation failed:', err.message);
        }
      }

      console.log(`[webhook/reports] ${body.event}: ${lead.name || lead.email || 'unknown'}`);
      return json(res, { ok: true });
    }

    // POST /api/webhooks/ghl — GoHighLevel webhook
    if (pathname === '/api/webhooks/ghl' && method === 'POST') {
      const secret = process.env.GHL_WEBHOOK_SECRET;
      if (secret) {
        const headerSecret = req.headers['x-webhook-secret'];
        if (!verifySecret(headerSecret, secret)) {
          return json(res, { error: 'Invalid secret' }, 401);
        }
      }

      const body = await parseBody(req);

      db.insertEvent({
        source: 'ghl',
        event_type: body.event || body.type || 'ghl_event',
        client_name: body.contact?.name || body.contact?.firstName ? [body.contact.firstName, body.contact.lastName].filter(Boolean).join(' ') : body.contactName || null,
        client_email: body.contact?.email || body.contactEmail || null,
        data: body
      });

      // Auto-create/update client for key events
      const contactEmail = body.contact?.email || body.contactEmail;
      const contactName = body.contact?.name || (body.contact?.firstName ? [body.contact.firstName, body.contact.lastName].filter(Boolean).join(' ') : null) || body.contactName;
      if (contactEmail && contactName) {
        db.upsertClient(contactEmail, {
          name: contactName,
          firm_name: body.contact?.companyName || body.companyName || null,
          phone: body.contact?.phone || null,
          source: 'ghl',
          status: 'prospect'
        });
      }

      return json(res, { ok: true });
    }

    // POST /api/webhooks/leads — mortar-lead-scraper webhook
    if (pathname === '/api/webhooks/leads' && method === 'POST') {
      const secret = process.env.LEAD_SCRAPER_WEBHOOK_SECRET;
      if (secret) {
        const headerSecret = req.headers['x-webhook-secret'];
        if (!verifySecret(headerSecret, secret)) {
          return json(res, { error: 'Invalid secret' }, 401);
        }
      }

      const body = await parseBody(req);
      const leads = Array.isArray(body.leads) ? body.leads : (body.lead ? [body.lead] : [body]);

      let created = 0;
      let updated = 0;
      for (const lead of leads) {
        if (!lead.name && !lead.email) continue;

        db.insertEvent({
          source: 'lead-scraper',
          event_type: 'lead_scraped',
          client_name: lead.name || null,
          client_email: lead.email || null,
          data: lead
        });

        const client = db.upsertClient(lead.email || null, {
          name: lead.name || 'Unknown',
          firm_name: lead.firm || lead.company || null,
          phone: lead.phone || null,
          practice_areas: lead.practiceAreas || lead.practice_areas || [],
          source: 'lead-scraper',
          status: 'prospect',
          notes: [
            lead.state ? `State: ${lead.state}` : null,
            lead.title ? `Title: ${lead.title}` : null,
            lead.website ? `Website: ${lead.website}` : null,
            lead.linkedin ? `LinkedIn: ${lead.linkedin}` : null
          ].filter(Boolean).join('\n') || null
        });

        if (client) {
          // Check if this was a new insert or update
          const isNew = new Date(client.first_seen).getTime() === new Date(client.last_seen).getTime();
          if (isNew) created++; else updated++;
        }
      }

      console.log(`[webhook/leads] Processed ${leads.length} leads: ${created} new, ${updated} updated`);
      return json(res, { ok: true, processed: leads.length, created, updated });
    }

    // POST /api/webhooks/manual — manual data entry
    if (pathname === '/api/webhooks/manual' && method === 'POST') {
      const body = await parseBody(req);

      db.insertEvent({
        source: 'manual',
        event_type: body.event_type || 'manual_entry',
        client_name: body.client_name || null,
        client_email: body.client_email || null,
        data: body
      });

      return json(res, { ok: true });
    }

    // POST /api/webhooks/telegram — Telegram bot reply handling
    if (pathname === '/api/webhooks/telegram' && method === 'POST') {
      const body = await parseBody(req);
      const msg = body.message;
      if (!msg || !msg.text) return json(res, { ok: true });

      const text = msg.text.trim();
      const from = msg.from?.first_name || 'Unknown';
      console.log(`[telegram] Reply from ${from}: ${text.slice(0, 100)}`);

      // Brief feedback
      if (text === '👍' || text === '👎') {
        db.insertFeedback({ output_id: 'daily-brief', output_type: 'brief', rating: text === '👍' ? 1 : -1, comment: null });
        console.log(`[telegram] Brief feedback: ${text}`);
        return json(res, { ok: true });
      }

      // Deal outcome detection
      const lower = text.toLowerCase();
      if (lower.includes('closed') || lower.includes('won') || lower.includes('signed')) {
        db.insertTeamInput({ question: 'Deal closed — details?', answer: text, answered_by: from, category: 'deal_outcome' });
        sendTelegramAlert(`✅ Noted: deal closed. What's the monthly value? Reply with the number.`);
      } else if (lower.includes('lost') || lower.includes('dead') || lower.includes('ghosted')) {
        db.insertTeamInput({ question: 'Deal lost — reason?', answer: text, answered_by: from, category: 'deal_outcome' });
        sendTelegramAlert(`📝 Noted. What was the main reason? Reply with details.`);
      } else {
        // Store as general team input
        db.insertTeamInput({ question: 'Telegram reply', answer: text, answered_by: from, category: 'general' });
      }

      return json(res, { ok: true });
    }

    // --- System Health Check ---

    if (pathname === '/health' && method === 'GET') {
      const uptime = process.uptime();
      const memUsage = process.memoryUsage();
      let dbOk = false;
      try { db.getDb().prepare('SELECT 1').get(); dbOk = true; } catch {}
      const checks = {
        server: true,
        database: dbOk,
        claude_api: !!process.env.ANTHROPIC_API_KEY,
        fireflies: !!process.env.FIREFLIES_API_KEY,
        telegram: !!process.env.TELEGRAM_BOT_TOKEN,
      };
      let errorCounts = { total: 0, lastHour: 0, last24h: 0 };
      try { errorCounts = db.getErrorCounts(); } catch {}
      const ok = checks.server && checks.database && checks.claude_api;
      return json(res, {
        ok,
        status: ok ? 'healthy' : 'degraded',
        uptime: Math.floor(uptime),
        memory_mb: Math.round(memUsage.rss / 1048576),
        checks,
        errors: errorCounts,
        features: {
          content_generation: !!process.env.ANTHROPIC_API_KEY,
          meeting_sync: !!process.env.FIREFLIES_API_KEY,
          telegram_alerts: !!process.env.TELEGRAM_BOT_TOKEN,
          image_generation: !!process.env.IDEOGRAM_API_KEY,
        },
        version: '1.2.0'
      }, ok ? 200 : 503);
    }

    // GET /api/backups — list available JSON backups
    if (pathname === '/api/backups' && method === 'GET') {
      const backupDir = path.join(__dirname, 'data', 'backups');
      let files = [];
      try {
        files = fs.readdirSync(backupDir)
          .filter(f => f.endsWith('.json'))
          .map(f => {
            const stat = fs.statSync(path.join(backupDir, f));
            return { name: f, size: stat.size, modified: stat.mtime.toISOString() };
          })
          .sort((a, b) => b.modified.localeCompare(a.modified));
      } catch {}
      return json(res, { backups: files });
    }

    // GET /api/errors — recent error log
    if (pathname === '/api/errors' && method === 'GET') {
      const source = url.searchParams.get('source');
      const limit = parseInt(url.searchParams.get('limit')) || 50;
      const errors = db.getErrors({ limit, source });
      const counts = db.getErrorCounts();
      return json(res, { errors, counts });
    }

    // --- Remote MCP (SSE) endpoints ---

    if (pathname === '/mcp/health' && method === 'GET') {
      return json(res, {
        ok: true,
        servers: {
          pipeline: { tools: 20, status: 'available' },
          fireflies: { tools: 5, status: 'available' },
          ghl: { tools: 22, status: process.env.GHL_API_KEY ? 'available' : 'no_api_key' },
          instantly: { tools: 15, status: process.env.INSTANTLY_API_KEY ? 'available' : 'no_api_key' }
        }
      });
    }

    // SSE endpoints for all 4 MCP servers
    const mcpMatch = pathname.match(/^\/mcp\/(pipeline|fireflies|ghl|instantly)\/sse$/);
    if (mcpMatch) {
      const serverName = mcpMatch[1];

      if (method === 'GET') {
        // Establish SSE connection
        const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
        const transport = new SSEServerTransport(`/mcp/${serverName}/sse`, res);
        const sessionId = transport.sessionId;

        // Store transport for POST routing
        if (!global._mcpTransports) global._mcpTransports = {};
        global._mcpTransports[sessionId] = transport;

        // Create and connect MCP server
        const { createServer } = require(`./mcp/${serverName}-server.js`);
        const mcpServer = createServer();
        await mcpServer.connect(transport);
        console.log(`[mcp-sse] ${serverName} connected (session: ${sessionId})`);

        // Cleanup on disconnect
        transport.onclose = () => {
          delete global._mcpTransports[sessionId];
          console.log(`[mcp-sse] ${serverName} disconnected (session: ${sessionId})`);
        };
        return; // SSE stream stays open
      }

      if (method === 'POST') {
        // Route message to existing SSE transport
        const sessionId = url.searchParams.get('sessionId');
        if (!sessionId || !global._mcpTransports?.[sessionId]) {
          return json(res, { error: 'Unknown session' }, 400);
        }
        const transport = global._mcpTransports[sessionId];
        await transport.handlePostMessage(req, res);
        return;
      }
    }

    // --- Comment-Trigger CTA Generator ---

    // POST /api/content/:id/generate-cta — generate comment-trigger CTAs for a content piece
    const ctaGenMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/generate-cta$/);
    if (ctaGenMatch && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);

      const content = readJSON('content.json');
      const idx = content.findIndex(c => c.id === ctaGenMatch[1]);
      if (idx === -1) return json(res, { error: 'Not found' }, 404);

      const item = content[idx];
      const linkedinContent = item.formats?.linkedin?.content || '';
      const title = item.trigger_title || '';

      try {
        const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
        const { buildSystemPromptWithMemory } = require('./generator/content-writer');
        const systemPrompt = buildSystemPromptWithMemory();

        const prompt = `Generate 3 comment-trigger CTA variants for this content. These are calls-to-action that ask the reader to comment a keyword to receive a resource via DM.

CONTENT TITLE: ${title}
CONTENT PREVIEW: ${(typeof linkedinContent === 'string' ? linkedinContent : '').slice(0, 500)}

Return JSON (raw, no fences):
{
  "ctas": [
    {
      "trigger_keyword": "AUDIT",
      "cta_text": "Comment AUDIT and I'll send you our free law firm marketing scorecard",
      "lead_magnet": "Marketing scorecard or audit",
      "dm_template": "Hey {name}! Here's the marketing scorecard I mentioned. [Link] — Want me to walk you through your results in a quick 15-min call?",
      "platform": "linkedin"
    },
    {
      "trigger_keyword": "PLAYBOOK",
      "cta_text": "Comment PLAYBOOK if you want the step-by-step version of this",
      "lead_magnet": "Step-by-step guide PDF",
      "dm_template": "Hey {name}! Here's the playbook. [Link] — Happy to answer any questions.",
      "platform": "linkedin"
    },
    {
      "trigger_keyword": "DATA",
      "cta_text": "Reply DATA if you want the full breakdown sent to your DMs",
      "lead_magnet": "Data report or cheat sheet",
      "dm_template": "Here's the full data breakdown. [Link] — Want a custom version for your firm? Reply YES.",
      "platform": "x"
    }
  ],
  "first_comment": "Full version of this with all the data: [lead magnet link]. DM me 'audit' if you want a custom analysis for your firm."
}

Make the CTAs natural and non-salesy. Use the "comment [keyword]" pattern. The DM templates should offer value first, then a soft meeting ask.`;

        const text = await callClaude({ model: HAIKU, system: systemPrompt, prompt, maxTokens: 1500 });
        const parsed = parseJsonResponse(text);
        if (!parsed?.ctas) return json(res, { error: 'Failed to generate CTAs' }, 500);

        content[idx].comment_ctas = parsed;
        content[idx].comment_ctas.generated_at = now();
        writeJSON('content.json', content);

        return json(res, { ok: true, ctas: parsed });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // --- Content Templates Library ---

    // GET /api/templates — list content templates
    if (pathname === '/api/templates' && method === 'GET') {
      const templates = readJSON('templates.json', []);
      return json(res, templates);
    }

    // POST /api/templates — save a new template
    if (pathname === '/api/templates' && method === 'POST') {
      const body = await parseBody(req);
      if (!body.name || !body.structure) return json(res, { error: 'name and structure required' }, 400);
      const templates = readJSON('templates.json', []);
      const template = {
        id: generateId(),
        name: body.name,
        category: body.category || 'general',
        format: body.format || 'linkedin',
        structure: body.structure,
        hook_formula: body.hook_formula || '',
        cta_pattern: body.cta_pattern || '',
        example: body.example || '',
        tags: body.tags || [],
        uses: 0,
        created_at: now()
      };
      templates.push(template);
      writeJSON('templates.json', templates);
      return json(res, { ok: true, template });
    }

    // POST /api/content/:id/apply-template — apply a template to content
    const applyTemplateMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/apply-template$/);
    if (applyTemplateMatch && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const body = await parseBody(req);
      const { template_id, format } = body;
      if (!template_id || !format) return json(res, { error: 'template_id and format required' }, 400);

      const templates = readJSON('templates.json', []);
      const template = templates.find(t => t.id === template_id);
      if (!template) return json(res, { error: 'Template not found' }, 404);

      const content = readJSON('content.json');
      const idx = content.findIndex(c => c.id === applyTemplateMatch[1]);
      if (idx === -1) return json(res, { error: 'Content not found' }, 404);

      const currentContent = content[idx].formats?.[format]?.content;
      if (!currentContent) return json(res, { error: 'No content in this format' }, 400);

      try {
        const { callClaude, HAIKU } = require('./lib/claude');
        const { buildSystemPromptWithMemory } = require('./generator/content-writer');
        const systemPrompt = buildSystemPromptWithMemory();
        const contentStr = typeof currentContent === 'string' ? currentContent : JSON.stringify(currentContent);

        const prompt = `Rewrite this content using the template structure below. Keep the same data, insights, and core message — just restructure it.

TEMPLATE: "${template.name}"
STRUCTURE: ${template.structure}
${template.hook_formula ? `HOOK FORMULA: ${template.hook_formula}` : ''}
${template.cta_pattern ? `CTA PATTERN: ${template.cta_pattern}` : ''}
${template.example ? `EXAMPLE:\n${template.example}` : ''}

CURRENT CONTENT:
${contentStr.slice(0, 2000)}

Return ONLY the rewritten content. No explanation, no JSON wrapper.`;

        const rewritten = await callClaude({ model: HAIKU, system: systemPrompt, prompt, maxTokens: 2000 });
        content[idx].formats[format].content = rewritten;
        content[idx].formats[format].template_applied = template.name;
        content[idx].formats[format].edited = true;
        writeJSON('content.json', content);

        // Increment template usage
        const tIdx = templates.findIndex(t => t.id === template_id);
        if (tIdx !== -1) { templates[tIdx].uses = (templates[tIdx].uses || 0) + 1; writeJSON('templates.json', templates); }

        return json(res, { ok: true, template: template.name });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // --- Bulk Operations ---

    // POST /api/content/bulk-improve — improve multiple content pieces
    if (pathname === '/api/content/bulk-improve' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const body = await parseBody(req);
      const ids = body.ids || [];
      const format = body.format || 'linkedin';
      if (!ids.length) return json(res, { error: 'ids required' }, 400);

      const batchId = generateId();
      _batchProgress[batchId] = { total: ids.length, completed: 0, errors: 0, results: [], status: 'running', type: 'bulk_improve' };

      setImmediate(async () => {
        const { callClaude, HAIKU } = require('./lib/claude');
        const { buildSystemPromptWithMemory } = require('./generator/content-writer');
        const { scoreHook, scoreSpecificity, scoreEmotionalValence } = require('./generator/score-triggers');
        const systemPrompt = buildSystemPromptWithMemory();

        for (const id of ids) {
          try {
            const content = readJSON('content.json');
            const idx = content.findIndex(c => c.id === id);
            if (idx === -1) { _batchProgress[batchId].errors++; continue; }

            const currentContent = content[idx].formats?.[format]?.content;
            if (!currentContent || typeof currentContent !== 'string') { _batchProgress[batchId].errors++; continue; }

            const hookScore = scoreHook(currentContent);
            const specScore = scoreSpecificity(currentContent);
            const emoScore = scoreEmotionalValence(currentContent);
            const weaknesses = [];
            if (hookScore < 4) weaknesses.push('WEAK HOOK');
            if (specScore < 3) weaknesses.push('LOW SPECIFICITY');
            if (emoScore < 2) weaknesses.push('LOW EMOTIONAL VALENCE');
            if (!/comment|reply|dm|book|audit|free/i.test(currentContent)) weaknesses.push('MISSING CTA');

            if (weaknesses.length > 0) {
              const prompt = `Improve this ${format} content. Fix: ${weaknesses.join(', ')}.\n\nCONTENT:\n${currentContent.slice(0, 2000)}\n\nReturn ONLY the improved content.`;
              const improved = await callClaude({ model: HAIKU, system: systemPrompt, prompt, maxTokens: 2000 });
              content[idx].formats[format].content = improved;
              content[idx].formats[format].improved_at = now();
              writeJSON('content.json', content);
              _batchProgress[batchId].results.push({ id, improved: true, fixes: weaknesses.length });
            } else {
              _batchProgress[batchId].results.push({ id, improved: false });
            }
            _batchProgress[batchId].completed++;
          } catch (err) {
            _batchProgress[batchId].errors++;
          }
        }
        _batchProgress[batchId].status = 'done';
        setTimeout(() => { delete _batchProgress[batchId]; }, 30 * 60 * 1000);
      });

      return json(res, { ok: true, batch_id: batchId });
    }

    // POST /api/content/bulk-generate-ctas — generate CTAs for multiple pieces
    if (pathname === '/api/content/bulk-generate-ctas' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const body = await parseBody(req);
      const ids = body.ids || [];
      if (!ids.length) return json(res, { error: 'ids required' }, 400);

      const batchId = generateId();
      _batchProgress[batchId] = { total: ids.length, completed: 0, errors: 0, results: [], status: 'running', type: 'bulk_ctas' };

      setImmediate(async () => {
        const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
        const { buildSystemPromptWithMemory } = require('./generator/content-writer');
        const systemPrompt = buildSystemPromptWithMemory();

        for (const id of ids) {
          try {
            const content = readJSON('content.json');
            const idx = content.findIndex(c => c.id === id);
            if (idx === -1) { _batchProgress[batchId].errors++; continue; }
            const item = content[idx];
            const linkedinContent = (typeof item.formats?.linkedin?.content === 'string' ? item.formats.linkedin.content : '').slice(0, 300);

            const prompt = `Generate a comment-trigger CTA for this content.

TITLE: ${item.trigger_title || ''}
PREVIEW: ${linkedinContent}

Return JSON: { "trigger_keyword": "AUDIT", "cta_text": "Comment AUDIT for the free scorecard", "lead_magnet": "type", "dm_template": "Hey {name}! Here's...", "first_comment": "Full version..." }`;

            const text = await callClaude({ model: HAIKU, system: systemPrompt, prompt, maxTokens: 500 });
            const parsed = parseJsonResponse(text);
            if (parsed) {
              content[idx].comment_ctas = { ctas: [parsed], generated_at: now() };
              writeJSON('content.json', content);
              _batchProgress[batchId].results.push({ id, keyword: parsed.trigger_keyword });
            }
            _batchProgress[batchId].completed++;
          } catch (err) {
            _batchProgress[batchId].errors++;
          }
        }
        _batchProgress[batchId].status = 'done';
        setTimeout(() => { delete _batchProgress[batchId]; }, 30 * 60 * 1000);
      });

      return json(res, { ok: true, batch_id: batchId });
    }

    // --- Smart Scheduling ---

    // GET /api/schedule/optimize — suggest best posting times per format
    if (pathname === '/api/schedule/optimize' && method === 'GET') {
      const published = readJSON('published.json');
      const perfData = readJSON('performance.json');
      const playbooks = readJSON('playbooks.json', {});

      // Platform-specific best times from playbook research
      const platformTimes = {
        linkedin: { best_days: ['tuesday', 'wednesday', 'thursday'], best_times: ['8:00 AM', '10:00 AM', '12:00 PM'], worst: 'weekends (50% lower reach)', frequency: '3-5 posts/week', gap: '12h minimum between posts' },
        x_single: { best_days: ['weekdays'], best_times: ['when audience is active'], worst: 'no specific worst', frequency: '5-15 tweets/day', gap: 'no minimum' },
        x_thread: { best_days: ['tuesday', 'wednesday'], best_times: ['8:00 AM', '11:00 AM'], worst: 'late evening', frequency: '2-3 threads/week', gap: '4h between threads' },
        carousel: { best_days: ['tuesday', 'wednesday', 'thursday'], best_times: ['9:00 AM', '11:00 AM'], worst: 'friday afternoon', frequency: '1-2/week', gap: 'alternate with text posts' },
        short_video: { best_days: ['monday', 'thursday'], best_times: ['7:00 AM', '12:00 PM', '8:00 PM'], worst: 'mid-week afternoon', frequency: '3-5/week', gap: '6h between videos' },
        blog: { best_days: ['tuesday', 'wednesday'], best_times: ['10:00 AM'], worst: 'weekends', frequency: '1-2/week', gap: '3-4 days between posts' },
        newsletter: { best_days: ['tuesday', 'thursday'], best_times: ['6:00 AM', '10:00 AM'], worst: 'monday, friday', frequency: '1/week', gap: 'weekly' },
        youtube_script: { best_days: ['tuesday', 'thursday', 'saturday'], best_times: ['2:00 PM', '5:00 PM'], worst: 'monday morning', frequency: '1-2/week', gap: '3-4 days between uploads' }
      };

      // Analyze historical performance by day of week
      const dayPerformance = {};
      for (const perf of perfData) {
        const pub = published.find(p => p.content_id === perf.content_id && p.format === perf.format);
        if (!pub?.published_at) continue;
        const day = new Date(pub.published_at).toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
        if (!dayPerformance[day]) dayPerformance[day] = { total_engagement: 0, count: 0 };
        dayPerformance[day].total_engagement += (perf.engagement || 0) + (perf.clicks || 0) * 3;
        dayPerformance[day].count++;
      }

      for (const day of Object.keys(dayPerformance)) {
        dayPerformance[day].avg = dayPerformance[day].count > 0
          ? Math.round(dayPerformance[day].total_engagement / dayPerformance[day].count)
          : 0;
      }

      // Generate next week's optimized schedule
      const nextWeek = [];
      const today = new Date();
      const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      for (let i = 1; i <= 7; i++) {
        const date = new Date(today);
        date.setDate(today.getDate() + i);
        const dayName = days[date.getDay()];
        const slots = [];

        // Check series for this day
        const series = readJSON('series.json', []);
        const daySeries = series.filter(s => s.active && s.day === dayName);
        for (const s of daySeries) {
          slots.push({ type: 'series', format: s.formats[0] || 'linkedin', series: s.name, time: '8:00 AM' });
        }

        // Add recommended format slots based on day
        if (['tuesday', 'wednesday', 'thursday'].includes(dayName)) {
          if (!slots.some(s => s.format === 'linkedin')) slots.push({ type: 'post', format: 'linkedin', time: '10:00 AM' });
          slots.push({ type: 'post', format: 'x_single', time: '12:00 PM' });
        }
        if (['monday', 'thursday'].includes(dayName)) {
          slots.push({ type: 'post', format: 'short_video', time: '7:00 AM' });
        }
        if (dayName === 'tuesday') {
          slots.push({ type: 'post', format: 'blog', time: '10:00 AM' });
        }

        nextWeek.push({ date: date.toISOString().split('T')[0], day: dayName, slots });
      }

      return json(res, { platform_times: platformTimes, day_performance: dayPerformance, next_week: nextWeek });
    }

    // --- DM Sequence Builder ---

    // GET /api/dm-sequences — list all DM follow-up sequences
    if (pathname === '/api/dm-sequences' && method === 'GET') {
      const sequences = readJSON('dm-sequences.json', []);
      return json(res, sequences);
    }

    // POST /api/dm-sequences — create a new DM sequence
    if (pathname === '/api/dm-sequences' && method === 'POST') {
      const body = await parseBody(req);
      if (!body.trigger_keyword) return json(res, { error: 'trigger_keyword required' }, 400);

      const sequences = readJSON('dm-sequences.json', []);
      const seq = {
        id: generateId(),
        trigger_keyword: body.trigger_keyword.toUpperCase(),
        name: body.name || `${body.trigger_keyword} Sequence`,
        lead_magnet: body.lead_magnet || '',
        lead_magnet_url: body.lead_magnet_url || '',
        steps: body.steps || [
          { day: 0, type: 'deliver', message: `Hey {name}! Here's the {lead_magnet} I mentioned. {link} — Let me know if you have any questions!` },
          { day: 1, type: 'value_add', message: `Quick follow-up — did you get a chance to look at the {lead_magnet}? Here's one thing most firms miss: {insight}` },
          { day: 3, type: 'soft_cta', message: `{name}, I noticed you grabbed our {lead_magnet}. Would it be helpful if I put together a quick custom analysis for your firm? Takes about 15 minutes.` },
          { day: 7, type: 'meeting_ask', message: `Last thought — we do free 15-min marketing audits for firms that downloaded the {lead_magnet}. Want me to block some time this week? Here's my calendar: {calendar_link}` }
        ],
        content_ids: body.content_ids || [],
        active: true,
        leads_captured: 0,
        meetings_booked: 0,
        created_at: now()
      };

      sequences.push(seq);
      writeJSON('dm-sequences.json', sequences);
      return json(res, { ok: true, sequence: seq });
    }

    // PUT /api/dm-sequences/:id — update a DM sequence
    const dmSeqUpdateMatch = pathname.match(/^\/api\/dm-sequences\/([a-f0-9]+)$/);
    if (dmSeqUpdateMatch && method === 'PUT') {
      const body = await parseBody(req);
      const sequences = readJSON('dm-sequences.json', []);
      const idx = sequences.findIndex(s => s.id === dmSeqUpdateMatch[1]);
      if (idx === -1) return json(res, { error: 'Not found' }, 404);

      const updates = ['name', 'trigger_keyword', 'lead_magnet', 'lead_magnet_url', 'steps', 'active', 'content_ids'];
      for (const key of updates) {
        if (body[key] !== undefined) sequences[idx][key] = body[key];
      }
      sequences[idx].updated_at = now();
      writeJSON('dm-sequences.json', sequences);
      return json(res, { ok: true, sequence: sequences[idx] });
    }

    // POST /api/dm-sequences/auto-generate — AI generates DM sequences for content with CTAs
    if (pathname === '/api/dm-sequences/auto-generate' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);

      const content = readJSON('content.json');
      const sequences = readJSON('dm-sequences.json', []);
      const existingKeywords = new Set(sequences.map(s => s.trigger_keyword));

      // Find content with CTAs that don't have sequences yet
      const needSequences = content.filter(c =>
        c.comment_ctas?.ctas?.length > 0 &&
        c.comment_ctas.ctas.some(cta => !existingKeywords.has(cta.trigger_keyword))
      );

      if (needSequences.length === 0) return json(res, { ok: true, generated: 0, message: 'All CTAs already have sequences' });

      try {
        const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
        let generated = 0;

        for (const item of needSequences.slice(0, 5)) {
          for (const cta of item.comment_ctas.ctas) {
            if (existingKeywords.has(cta.trigger_keyword)) continue;

            const prompt = `Create a 4-step DM follow-up sequence for someone who commented "${cta.trigger_keyword}" on a LinkedIn post about "${item.trigger_title}".

The lead magnet is: ${cta.lead_magnet}
The CTA was: ${cta.cta_text}

Return JSON (raw, no fences):
{
  "steps": [
    { "day": 0, "type": "deliver", "message": "Day 0: Deliver the resource immediately..." },
    { "day": 1, "type": "value_add", "message": "Day 1: Add extra value, share an insight..." },
    { "day": 3, "type": "soft_cta", "message": "Day 3: Soft ask about their situation..." },
    { "day": 7, "type": "meeting_ask", "message": "Day 7: Ask for a meeting..." }
  ]
}

Use {name} as placeholder for lead's name. Keep messages conversational, value-first. Each under 280 chars for DM readability.`;

            const text = await callClaude({ model: HAIKU, system: 'You are a sales sequence copywriter for a legal marketing agency.', prompt, maxTokens: 800 });
            const parsed = parseJsonResponse(text);
            if (parsed?.steps) {
              const seq = {
                id: generateId(),
                trigger_keyword: cta.trigger_keyword,
                name: `${cta.trigger_keyword} — ${(item.trigger_title || '').slice(0, 40)}`,
                lead_magnet: cta.lead_magnet,
                lead_magnet_url: '',
                steps: parsed.steps,
                content_ids: [item.id],
                active: true,
                leads_captured: 0,
                meetings_booked: 0,
                created_at: now()
              };
              sequences.push(seq);
              existingKeywords.add(cta.trigger_keyword);
              generated++;
            }
          }
        }

        writeJSON('dm-sequences.json', sequences);
        return json(res, { ok: true, generated, total: sequences.length });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // --- Engagement Hooks Library ---

    // GET /api/hooks — list engagement hooks
    if (pathname === '/api/hooks' && method === 'GET') {
      const hooks = readJSON('hooks.json', []);
      return json(res, hooks);
    }

    // POST /api/hooks — add a new hook
    if (pathname === '/api/hooks' && method === 'POST') {
      const body = await parseBody(req);
      if (!body.text) return json(res, { error: 'text required' }, 400);

      const hooks = readJSON('hooks.json', []);
      const hook = {
        id: generateId(),
        text: body.text,
        category: body.category || 'general',
        format: body.format || 'linkedin',
        tags: body.tags || [],
        uses: 0,
        performance_score: 0,
        created_at: now()
      };
      hooks.push(hook);
      writeJSON('hooks.json', hooks);
      return json(res, { ok: true, hook });
    }

    // POST /api/content/:id/apply-hook — rewrite content's first line using a hook pattern
    const applyHookMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/apply-hook$/);
    if (applyHookMatch && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);

      const body = await parseBody(req);
      const format = body.format || 'linkedin';
      const hookId = body.hook_id;

      const content = readJSON('content.json');
      const idx = content.findIndex(c => c.id === applyHookMatch[1]);
      if (idx === -1) return json(res, { error: 'Not found' }, 404);

      const item = content[idx];
      const currentContent = typeof item.formats?.[format]?.content === 'string' ? item.formats[format].content : '';
      if (!currentContent) return json(res, { error: `No ${format} content` }, 400);

      const hooks = readJSON('hooks.json', []);
      const hook = hookId ? hooks.find(h => h.id === hookId) : null;

      try {
        const { callClaude, HAIKU } = require('./lib/claude');
        const { buildSystemPromptWithMemory } = require('./generator/content-writer');

        const prompt = `Rewrite ONLY the first 1-2 lines (the hook) of this ${format} post to be more engaging and stop-the-scroll.

${hook ? `USE THIS HOOK PATTERN: "${hook.text}"` : 'Use the most engaging hook pattern possible (data bomb, contrarian take, story opener, or shocking stat).'}

CURRENT POST:
${currentContent.slice(0, 800)}

Return ONLY the full rewritten post with the new hook. Keep the body and CTA unchanged. Just improve the opening.`;

        const newContent = await callClaude({ model: HAIKU, system: buildSystemPromptWithMemory(), prompt, maxTokens: 2000 });
        if (newContent && newContent.length > 50) {
          content[idx].formats[format].content = newContent.trim();
          content[idx].formats[format].hook_rewritten = true;
          content[idx].formats[format].original_hook = currentContent.split('\n')[0];
          writeJSON('content.json', content);

          if (hook) {
            const hIdx = hooks.findIndex(h => h.id === hookId);
            if (hIdx !== -1) { hooks[hIdx].uses++; writeJSON('hooks.json', hooks); }
          }
          return json(res, { ok: true, format, rewritten: true, new_hook: newContent.split('\n')[0] });
        }
        return json(res, { error: 'AI returned insufficient content' }, 500);
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // --- Auto-Repurpose Chain ---

    // POST /api/content/:id/repurpose-all — generate all missing formats from the best available source
    const repurposeAllMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/repurpose-all$/);
    if (repurposeAllMatch && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);

      const content = readJSON('content.json');
      const idx = content.findIndex(c => c.id === repurposeAllMatch[1]);
      if (idx === -1) return json(res, { error: 'Not found' }, 404);

      const item = content[idx];
      const allFormats = ['linkedin', 'x_single', 'x_thread', 'short_video', 'carousel', 'blog', 'newsletter', 'lead_magnet', 'youtube_script'];

      // Find the best source format (longest content)
      let bestSource = null;
      let bestLen = 0;
      for (const [fmt, data] of Object.entries(item.formats || {})) {
        const len = typeof data?.content === 'string' ? data.content.length : Array.isArray(data?.content) ? data.content.join(' ').length : 0;
        if (len > bestLen) { bestLen = len; bestSource = fmt; }
      }
      if (!bestSource) return json(res, { error: 'No source content to repurpose from' }, 400);

      // Find missing formats
      const missing = allFormats.filter(f => {
        const d = item.formats?.[f];
        return !d?.content || (typeof d.content === 'string' && d.content.length < 50);
      });

      if (missing.length === 0) return json(res, { ok: true, message: 'All formats already have content', repurposed: 0 });

      const batchId = generateId();
      _batchProgress[batchId] = { total: missing.length, completed: 0, errors: 0, results: [], status: 'running', type: 'repurpose_all' };

      setImmediate(async () => {
        const { repurposeContent } = require('./lib/claude');
        const { buildSystemPromptWithMemory } = require('./generator/content-writer');
        const systemPrompt = buildSystemPromptWithMemory();

        const sourceContent = typeof item.formats[bestSource].content === 'string'
          ? item.formats[bestSource].content
          : Array.isArray(item.formats[bestSource].content)
            ? item.formats[bestSource].content.join('\n\n')
            : '';

        for (const targetFormat of missing) {
          try {
            const result = await repurposeContent({
              sourceContent,
              sourceFormat: bestSource,
              targetFormat,
              title: item.trigger_title || '',
              systemPrompt
            });
            if (result) {
              const fresh = readJSON('content.json');
              const fIdx = fresh.findIndex(c => c.id === repurposeAllMatch[1]);
              if (fIdx !== -1) {
                if (!fresh[fIdx].formats) fresh[fIdx].formats = {};
                fresh[fIdx].formats[targetFormat] = {
                  content: result,
                  status: 'review',
                  generated_at: now(),
                  repurposed_from: bestSource
                };
                writeJSON('content.json', fresh);
              }
              _batchProgress[batchId].results.push(targetFormat);
            }
            _batchProgress[batchId].completed++;
          } catch (err) {
            _batchProgress[batchId].errors++;
            _batchProgress[batchId].completed++;
          }
        }
        _batchProgress[batchId].status = 'done';
        setTimeout(() => { delete _batchProgress[batchId]; }, 30 * 60 * 1000);
      });

      return json(res, { ok: true, batch_id: batchId, source: bestSource, generating: missing, total: missing.length });
    }

    // --- Content Health Overview ---

    // GET /api/content-health — comprehensive content health metrics
    if (pathname === '/api/content-health' && method === 'GET') {
      const content = readJSON('content.json');
      const triggers = readJSON('trigger-queue.json');
      const published = readJSON('published.json');
      const perfData = readJSON('performance.json');
      const series = readJSON('series.json', []);
      const { scoreHook, scoreSpecificity, scoreEmotionalValence, getQualityTier } = require('./generator/score-triggers');

      // Queue depth
      const approvedFormats = content.reduce((sum, c) => {
        return sum + Object.values(c.formats || {}).filter(f => f.status === 'approved' && !f.published_at).length;
      }, 0);
      const daysOfContent = Math.floor(approvedFormats / 2);

      // Quality distribution
      const qualityDist = { excellent: 0, good: 0, fair: 0, poor: 0 };
      for (const item of content) {
        for (const [, fmtData] of Object.entries(item.formats || {})) {
          const text = typeof fmtData.content === 'string' ? fmtData.content : '';
          const hookS = scoreHook(text);
          const specS = scoreSpecificity(text);
          const emoS = scoreEmotionalValence(text);
          const total = hookS + specS + emoS;
          if (total >= 12) qualityDist.excellent++;
          else if (total >= 8) qualityDist.good++;
          else if (total >= 4) qualityDist.fair++;
          else qualityDist.poor++;
        }
      }

      // Series streaks
      const seriesHealth = series.filter(s => s.active).map(s => {
        const eps = s.episodes || [];
        const lastEp = eps[eps.length - 1];
        const daysSinceLastEp = lastEp ? Math.floor((Date.now() - new Date(lastEp.generated_at || 0).getTime()) / (24 * 60 * 60 * 1000)) : 999;
        return { id: s.id, name: s.name, episodes: eps.length, days_since_last: daysSinceLastEp, on_track: daysSinceLastEp <= 7 };
      });

      // Top formats by approval rate
      const formatStats = {};
      for (const item of content) {
        for (const [fmt, fmtData] of Object.entries(item.formats || {})) {
          if (!formatStats[fmt]) formatStats[fmt] = { total: 0, approved: 0, published: 0, rejected: 0 };
          formatStats[fmt].total++;
          if (fmtData.status === 'approved') formatStats[fmt].approved++;
          else if (fmtData.status === 'published') formatStats[fmt].published++;
          else if (fmtData.status === 'rejected') formatStats[fmt].rejected++;
        }
      }

      // Trigger freshness
      const fresh = triggers.filter(t => t.status === 'pending' && daysAgo(t.captured_at) <= 3).length;
      const aging = triggers.filter(t => t.status === 'pending' && daysAgo(t.captured_at) > 3 && daysAgo(t.captured_at) <= 7).length;
      const stale = triggers.filter(t => t.status === 'pending' && daysAgo(t.captured_at) > 7).length;

      // Automation status
      const automations = {
        daily_scraper: true,
        auto_series: series.filter(s => s.active).length > 0,
        auto_queue_fill: daysOfContent < 3,
        daily_brief: !!process.env.TELEGRAM_BOT_TOKEN,
        api_key: !!process.env.ANTHROPIC_API_KEY
      };

      return json(res, {
        queue: { approved_formats: approvedFormats, days_remaining: daysOfContent, health: daysOfContent >= 7 ? 'healthy' : daysOfContent >= 3 ? 'low' : 'critical' },
        quality: qualityDist,
        series: seriesHealth,
        formats: formatStats,
        triggers: { fresh, aging, stale, total_pending: fresh + aging + stale },
        automations,
        totals: { content: content.length, published: published.length, performance_tracked: perfData.length }
      });
    }

    // --- A/B Testing ---

    // POST /api/content/:id/ab-test — create A/B test variant
    const abTestMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/ab-test$/);
    if (abTestMatch && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const body = await parseBody(req);
      const format = body.format;
      if (!format) return json(res, { error: 'format required' }, 400);

      const content = readJSON('content.json');
      const idx = content.findIndex(c => c.id === abTestMatch[1]);
      if (idx === -1) return json(res, { error: 'Not found' }, 404);

      const currentContent = content[idx].formats?.[format]?.content;
      if (!currentContent) return json(res, { error: 'No content in this format' }, 400);

      try {
        const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
        const { buildSystemPromptWithMemory } = require('./generator/content-writer');
        const systemPrompt = buildSystemPromptWithMemory();
        const contentStr = typeof currentContent === 'string' ? currentContent : JSON.stringify(currentContent);

        const prompt = `Create 2 alternative hook variants for this ${format} content. Keep the body the same but write completely different opening hooks.

ORIGINAL CONTENT:
${contentStr.slice(0, 2000)}

Create these hook types:
1. DATA BOMB — lead with a specific, surprising number
2. STORY — lead with a micro-story or failure scenario
3. CONTRARIAN — lead with a myth-busting or "everyone is wrong" angle

Return JSON (raw, no fences):
{
  "variant_a": {
    "hook_type": "data_bomb",
    "hook": "The new opening 2-3 lines",
    "full_content": "Complete rewritten content with the new hook (keep body similar)"
  },
  "variant_b": {
    "hook_type": "contrarian",
    "hook": "The new opening 2-3 lines",
    "full_content": "Complete rewritten content with the new hook (keep body similar)"
  }
}`;

        const text = await callClaude({ model: HAIKU, system: systemPrompt, prompt, maxTokens: 3000 });
        const parsed = parseJsonResponse(text);
        if (!parsed?.variant_a) return json(res, { error: 'Failed to generate A/B variants' }, 500);

        // Store A/B test on the content item
        if (!content[idx].ab_tests) content[idx].ab_tests = {};
        content[idx].ab_tests[format] = {
          original: contentStr.slice(0, 200),
          variant_a: { hook_type: parsed.variant_a.hook_type, hook: parsed.variant_a.hook, content: parsed.variant_a.full_content },
          variant_b: { hook_type: parsed.variant_b.hook_type, hook: parsed.variant_b.hook, content: parsed.variant_b.full_content },
          created_at: now(),
          winner: null
        };
        writeJSON('content.json', content);

        return json(res, { ok: true, test: content[idx].ab_tests[format] });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // POST /api/content/:id/ab-test/select — select A/B test winner
    const abSelectMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/ab-test\/select$/);
    if (abSelectMatch && method === 'POST') {
      const body = await parseBody(req);
      const { format, winner } = body; // winner: 'original', 'variant_a', 'variant_b'
      if (!format || !winner) return json(res, { error: 'format and winner required' }, 400);

      const content = readJSON('content.json');
      const idx = content.findIndex(c => c.id === abSelectMatch[1]);
      if (idx === -1) return json(res, { error: 'Not found' }, 404);

      const test = content[idx].ab_tests?.[format];
      if (!test) return json(res, { error: 'No A/B test for this format' }, 404);

      // Apply winner content
      if (winner === 'variant_a' && test.variant_a?.content) {
        content[idx].formats[format].content = test.variant_a.content;
        content[idx].formats[format].edited = true;
      } else if (winner === 'variant_b' && test.variant_b?.content) {
        content[idx].formats[format].content = test.variant_b.content;
        content[idx].formats[format].edited = true;
      }
      // Mark winner
      content[idx].ab_tests[format].winner = winner;
      content[idx].ab_tests[format].selected_at = now();
      writeJSON('content.json', content);

      return json(res, { ok: true, winner });
    }

    // --- Content Quality Improver ---

    // POST /api/content/:id/improve — AI-powered content quality improvement
    const improveMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/improve$/);
    if (improveMatch && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const body = await parseBody(req);
      const format = body.format;
      if (!format) return json(res, { error: 'format required' }, 400);

      const content = readJSON('content.json');
      const idx = content.findIndex(c => c.id === improveMatch[1]);
      if (idx === -1) return json(res, { error: 'Not found' }, 404);

      const currentContent = content[idx].formats?.[format]?.content;
      if (!currentContent) return json(res, { error: 'No content in this format' }, 400);

      try {
        const { callClaude, HAIKU } = require('./lib/claude');
        const { buildSystemPromptWithMemory } = require('./generator/content-writer');
        const { scoreHook, scoreSpecificity, scoreEmotionalValence } = require('./generator/score-triggers');
        const systemPrompt = buildSystemPromptWithMemory();

        const contentStr = typeof currentContent === 'string' ? currentContent : JSON.stringify(currentContent);

        // Analyze current quality
        const hookScore = scoreHook(contentStr);
        const specScore = scoreSpecificity(contentStr);
        const emoScore = scoreEmotionalValence(contentStr);

        const weaknesses = [];
        if (hookScore < 4) weaknesses.push('WEAK HOOK — needs a specific number, data point, or contrarian framing in the opening line');
        if (specScore < 3) weaknesses.push('LOW SPECIFICITY — add exact dollar amounts, percentages, named tools, or case counts');
        if (emoScore < 2) weaknesses.push('LOW EMOTIONAL VALENCE — add frustration, surprise, or urgency signals');
        if (!/comment|reply|dm|book|audit|free|checklist/i.test(contentStr)) weaknesses.push('MISSING CTA — add a natural call-to-action');
        if (contentStr.length < 400 && format === 'linkedin') weaknesses.push('TOO SHORT — LinkedIn posts perform best at 800-1300 chars');

        if (weaknesses.length === 0) {
          return json(res, { ok: true, improved: false, message: 'Content already scores well — no improvements needed' });
        }

        const prompt = `Improve this ${format} content. Fix these specific issues:

${weaknesses.map((w, i) => `${i + 1}. ${w}`).join('\n')}

CURRENT CONTENT:
${contentStr.slice(0, 3000)}

RULES:
- Keep the core message and data points intact
- Only fix the identified weaknesses
- Don't change the overall structure or tone
- If adding numbers, use realistic but specific ones (e.g., "$4,183/month" not "thousands")
- If strengthening the hook, make it shorter and more specific
- If adding a CTA, use "comment [keyword] and I'll send..." pattern for LinkedIn

Return ONLY the improved content (no JSON wrapper, no explanation). Keep the same format as the original.`;

        const improved = await callClaude({ model: HAIKU, system: systemPrompt, prompt, maxTokens: 3000 });

        // Store improved version
        content[idx].formats[format].content = improved;
        content[idx].formats[format].improved_at = now();
        content[idx].formats[format].improvements = weaknesses;
        writeJSON('content.json', content);

        return json(res, { ok: true, improved: true, weaknesses, format });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // GET /api/content/:id/quality — get detailed quality analysis
    const qualityMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/quality$/);
    if (qualityMatch && method === 'GET') {
      const content = readJSON('content.json');
      const item = content.find(c => c.id === qualityMatch[1]);
      if (!item) return json(res, { error: 'Not found' }, 404);

      const { scoreHook, scoreSpecificity, scoreEmotionalValence } = require('./generator/score-triggers');
      const analysis = {};

      for (const [fmt, fmtData] of Object.entries(item.formats || {})) {
        const text = typeof fmtData.content === 'string' ? fmtData.content : JSON.stringify(fmtData.content || '');
        const hookScore = scoreHook(text);
        const specScore = scoreSpecificity(text);
        const emoScore = scoreEmotionalValence(text);
        const hasCta = /comment|reply|dm|book|audit|free|checklist|link/i.test(text);
        const hasNumbers = /\$[\d,]+|\d+%|\d+x/.test(text);
        const hasLineBreaks = (text.match(/\n\n/g) || []).length >= 3;

        const total = hookScore + specScore + emoScore + (hasCta ? 3 : 0) + (hasNumbers ? 2 : 0) + (hasLineBreaks ? 1 : 0);
        const maxScore = 8 + 5 + 4 + 3 + 2 + 1; // 23
        const percentage = Math.round((total / maxScore) * 100);

        analysis[fmt] = {
          overall: percentage,
          hook: { score: hookScore, max: 8, label: hookScore >= 5 ? 'Strong' : hookScore >= 3 ? 'Moderate' : 'Weak' },
          specificity: { score: specScore, max: 5, label: specScore >= 3 ? 'High' : specScore >= 2 ? 'Medium' : 'Low' },
          emotion: { score: emoScore, max: 4, label: emoScore >= 2 ? 'Engaging' : 'Neutral' },
          cta: hasCta,
          numbers: hasNumbers,
          line_breaks: hasLineBreaks,
          char_count: text.length,
          improvements_available: percentage < 70
        };
      }

      return json(res, analysis);
    }

    // --- Engagement Feedback ---

    // GET /api/engagement-stats — performance-weighted source/category rankings
    if (pathname === '/api/engagement-stats' && method === 'GET') {
      const perfData = readJSON('performance.json');
      const published = readJSON('published.json');
      const content = readJSON('content.json');

      // Aggregate engagement by source and category
      const bySource = {};
      const byCategory = {};
      const byFormat = {};

      for (const perf of perfData) {
        const contentItem = content.find(c => c.id === perf.content_id);
        if (!contentItem) continue;
        const src = contentItem.trigger_source || 'unknown';
        const cat = contentItem.trigger_category || 'unknown';
        const fmt = perf.format || 'unknown';
        const engScore = (perf.engagement || 0) * 1 + (perf.clicks || 0) * 3 + (perf.leads || 0) * 10;

        if (!bySource[src]) bySource[src] = { total: 0, pieces: 0, avg: 0 };
        bySource[src].total += engScore;
        bySource[src].pieces++;

        if (!byCategory[cat]) byCategory[cat] = { total: 0, pieces: 0, avg: 0 };
        byCategory[cat].total += engScore;
        byCategory[cat].pieces++;

        if (!byFormat[fmt]) byFormat[fmt] = { total: 0, pieces: 0, avg: 0 };
        byFormat[fmt].total += engScore;
        byFormat[fmt].pieces++;
      }

      // Calculate averages
      for (const key of Object.keys(bySource)) { bySource[key].avg = bySource[key].pieces > 0 ? Math.round(bySource[key].total / bySource[key].pieces) : 0; }
      for (const key of Object.keys(byCategory)) { byCategory[key].avg = byCategory[key].pieces > 0 ? Math.round(byCategory[key].total / byCategory[key].pieces) : 0; }
      for (const key of Object.keys(byFormat)) { byFormat[key].avg = byFormat[key].pieces > 0 ? Math.round(byFormat[key].total / byFormat[key].pieces) : 0; }

      return json(res, {
        by_source: Object.entries(bySource).sort((a, b) => b[1].avg - a[1].avg).map(([k, v]) => ({ source: k, ...v })),
        by_category: Object.entries(byCategory).sort((a, b) => b[1].avg - a[1].avg).map(([k, v]) => ({ category: k, ...v })),
        by_format: Object.entries(byFormat).sort((a, b) => b[1].avg - a[1].avg).map(([k, v]) => ({ format: k, ...v })),
        total_tracked: perfData.length
      });
    }

    // --- Content Pillar Planner ---

    // GET /api/pillars — get current pillar plan
    if (pathname === '/api/pillars' && method === 'GET') {
      const pillars = readJSON('pillar-plan.json', null);
      return json(res, pillars || { pillars: [], generated_at: null });
    }

    // POST /api/pillars/plan — AI analyzes content + triggers to create pillar plan
    if (pathname === '/api/pillars/plan' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);

      const content = readJSON('content.json');
      const triggers = readJSON('trigger-queue.json');

      // Collect topic signals
      const titles = content.slice(0, 50).map(c => c.trigger_title).filter(Boolean);
      const categories = {};
      const sources = {};
      for (const c of content) {
        categories[c.trigger_category] = (categories[c.trigger_category] || 0) + 1;
        sources[c.trigger_source] = (sources[c.trigger_source] || 0) + 1;
      }
      const pendingTriggerTitles = triggers.filter(t => t.status === 'pending').slice(0, 30).map(t => t.title);

      try {
        const { callClaude, parseJsonResponse, SONNET } = require('./lib/claude');

        const prompt = `Analyze these content topics from a legal marketing agency and create a content pillar strategy.

EXISTING CONTENT TITLES (${titles.length}):
${titles.slice(0, 30).map(t => `- ${t}`).join('\n')}

PENDING TRIGGER TITLES (${pendingTriggerTitles.length}):
${pendingTriggerTitles.slice(0, 20).map(t => `- ${t}`).join('\n')}

CATEGORIES: ${JSON.stringify(categories)}
SOURCES: ${JSON.stringify(sources)}

Return JSON (raw, no fences):
{
  "pillars": [
    {
      "id": "slug-name",
      "name": "Pillar Name",
      "description": "What this pillar covers",
      "sub_topics": ["topic1", "topic2", "topic3"],
      "target_frequency": "2-3 posts/week",
      "best_formats": ["linkedin", "blog"],
      "current_coverage": "high|medium|low",
      "gap_areas": ["specific topic gaps"],
      "color": "#hex"
    }
  ],
  "recommendations": ["actionable recommendation 1", "recommendation 2"],
  "coverage_summary": "Brief summary of current coverage strengths and weaknesses"
}

Create 5-7 pillars. Make them specific to legal marketing. Identify gaps where we have few/no content pieces.`;

        const text = await callClaude({ model: SONNET, system: 'You are a content strategist for a legal marketing agency.', prompt, maxTokens: 2500 });
        const parsed = parseJsonResponse(text);
        if (!parsed?.pillars) return json(res, { error: 'Failed to generate pillar plan' }, 500);

        parsed.generated_at = now();
        parsed.content_count = content.length;
        parsed.trigger_count = triggers.length;
        writeJSON('pillar-plan.json', parsed);

        return json(res, { ok: true, ...parsed });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // --- Performance-Linked Auto-Regeneration ---

    // POST /api/content/auto-regen — regenerate low-performing published content
    if (pathname === '/api/content/auto-regen' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);

      const content = readJSON('content.json');
      const perfData = readJSON('performance.json');
      const published = readJSON('published.json');

      // Find published content with below-average performance
      const avgEngagement = perfData.length > 0
        ? perfData.reduce((sum, p) => sum + (p.engagement || 0) + (p.clicks || 0) * 3, 0) / perfData.length
        : 0;

      const candidates = [];
      for (const perf of perfData) {
        const engScore = (perf.engagement || 0) + (perf.clicks || 0) * 3;
        if (engScore >= avgEngagement) continue; // Skip above-average

        const pub = published.find(p => p.content_id === perf.content_id && p.format === perf.format);
        if (!pub?.published_at) continue;

        const daysSincePublish = (Date.now() - new Date(pub.published_at).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSincePublish < 14) continue; // Too recent to regen

        const contentItem = content.find(c => c.id === perf.content_id);
        if (!contentItem) continue;

        candidates.push({ content_id: perf.content_id, format: perf.format, engagement: engScore, avg: avgEngagement, title: contentItem.trigger_title });
      }

      if (candidates.length === 0) return json(res, { ok: true, regenerated: 0, message: 'No low-performing content found to regenerate' });

      // Take top 5 worst performers
      const toRegen = candidates.sort((a, b) => a.engagement - b.engagement).slice(0, 5);

      const batchId = generateId();
      _batchProgress[batchId] = { total: toRegen.length, completed: 0, errors: 0, results: [], status: 'running', type: 'auto_regen' };

      setImmediate(async () => {
        const { callClaude, HAIKU } = require('./lib/claude');
        const { buildSystemPromptWithMemory } = require('./generator/content-writer');
        const hooks = readJSON('hooks.json', []);
        const systemPrompt = buildSystemPromptWithMemory();

        for (const candidate of toRegen) {
          try {
            const fresh = readJSON('content.json');
            const idx = fresh.findIndex(c => c.id === candidate.content_id);
            if (idx === -1) { _batchProgress[batchId].errors++; continue; }

            const currentContent = fresh[idx].formats?.[candidate.format]?.content;
            if (!currentContent) { _batchProgress[batchId].errors++; continue; }

            // Pick a random hook style for variety
            const hookCategories = ['data', 'story', 'contrarian', 'question', 'transformation'];
            const hookStyle = hookCategories[Math.floor(Math.random() * hookCategories.length)];
            const matchingHooks = hooks.filter(h => h.category === hookStyle);
            const hookExample = matchingHooks.length > 0 ? matchingHooks[Math.floor(Math.random() * matchingHooks.length)].text : '';

            const contentStr = typeof currentContent === 'string' ? currentContent : JSON.stringify(currentContent);
            const prompt = `This ${candidate.format} post underperformed (engagement: ${candidate.engagement}, average: ${Math.round(candidate.avg)}). Rewrite it with a completely different angle and hook style.

${hookExample ? `USE THIS HOOK STYLE: "${hookExample}"` : `Use a ${hookStyle} hook style.`}

ORIGINAL POST:
${contentStr.slice(0, 1500)}

Rewrite the ENTIRE post. New hook, new angle, same core message. Make it more engaging, specific, and scroll-stopping.`;

            const newContent = await callClaude({ model: HAIKU, system: systemPrompt, prompt, maxTokens: 2000 });
            if (newContent && newContent.length > 100) {
              fresh[idx].formats[candidate.format].content = newContent.trim();
              fresh[idx].formats[candidate.format].regenerated_at = now();
              fresh[idx].formats[candidate.format].regen_reason = `Low performance (${candidate.engagement} vs avg ${Math.round(candidate.avg)})`;
              fresh[idx].formats[candidate.format].status = 'review';
              writeJSON('content.json', fresh);
              _batchProgress[batchId].results.push({ id: candidate.content_id, format: candidate.format, hook_style: hookStyle });
            }
            _batchProgress[batchId].completed++;
          } catch (err) {
            _batchProgress[batchId].errors++;
            _batchProgress[batchId].completed++;
          }
        }
        _batchProgress[batchId].status = 'done';
        setTimeout(() => { delete _batchProgress[batchId]; }, 30 * 60 * 1000);
      });

      return json(res, { ok: true, batch_id: batchId, candidates: toRegen.length });
    }

    // --- Distribution Package ---

    // GET /api/content/:id/distribute — get copy-ready distribution package for all platforms
    const distributeMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/distribute$/);
    if (distributeMatch && method === 'GET') {
      const content = readJSON('content.json');
      const item = content.find(c => c.id === distributeMatch[1]);
      if (!item) return json(res, { error: 'Not found' }, 404);

      const scheduleOptimize = readJSON('playbooks.json', {});
      const platformTimes = {
        linkedin: { best_times: ['8:00 AM', '10:00 AM', '12:00 PM'], best_days: ['Tue', 'Wed', 'Thu'] },
        x: { best_times: ['8:00 AM', '11:00 AM', '5:00 PM'], best_days: ['Mon-Fri'] },
        youtube: { best_times: ['2:00 PM', '5:00 PM'], best_days: ['Tue', 'Thu', 'Sat'] },
        blog: { best_times: ['10:00 AM'], best_days: ['Tue', 'Wed'] },
        newsletter: { best_times: ['6:00 AM', '10:00 AM'], best_days: ['Tue', 'Thu'] }
      };

      const packages = {};
      const fmtToPlatform = { linkedin: 'linkedin', carousel: 'linkedin', x_single: 'x', x_thread: 'x', short_video: 'video', blog: 'blog', newsletter: 'newsletter', youtube_script: 'youtube' };

      for (const [fmt, data] of Object.entries(item.formats || {})) {
        if (!data?.content) continue;
        const platform = fmtToPlatform[fmt] || fmt;
        const contentStr = typeof data.content === 'string' ? data.content : (Array.isArray(data.content) ? data.content.join('\n\n---\n\n') : '');

        // Generate hashtags based on content
        const baseHashtags = ['#LegalMarketing', '#LawFirmGrowth', '#LegalTech'];
        if (contentStr.toLowerCase().includes('seo')) baseHashtags.push('#SEO');
        if (contentStr.toLowerCase().includes('google ads') || contentStr.toLowerCase().includes('ppc')) baseHashtags.push('#PPC', '#GoogleAds');
        if (contentStr.toLowerCase().includes('intake')) baseHashtags.push('#ClientIntake');
        if (contentStr.toLowerCase().includes('ai')) baseHashtags.push('#AI', '#LegalAI');

        packages[fmt] = {
          platform,
          format: fmt,
          content: contentStr,
          status: data.status,
          char_count: contentStr.length,
          hashtags: platform === 'linkedin' ? baseHashtags.slice(0, 5).join(' ') : platform === 'x' ? baseHashtags.slice(0, 3).join(' ') : '',
          first_comment: item.comment_ctas?.first_comment || null,
          cta: item.comment_ctas?.ctas?.[0] || null,
          timing: platformTimes[platform] || { best_times: ['10:00 AM'], best_days: ['Weekdays'] },
          distribution_notes: platform === 'linkedin'
            ? 'Post as text. Add hashtags as first comment. Engage with replies for 60 min.'
            : platform === 'x'
              ? fmt === 'x_thread' ? 'Post as thread. Repost hook tweet. Engage replies.' : 'Post tweet. Pin if high-value.'
              : platform === 'blog' ? 'Publish to website. Share link on LinkedIn. Create X thread from key points.' : 'Follow platform-specific publishing workflow.'
        };
      }

      return json(res, {
        content_id: item.id,
        title: item.trigger_title,
        status: item.status,
        packages,
        total_platforms: Object.keys(packages).length,
        has_ctas: !!item.comment_ctas,
        generated_at: item.generated_at
      });
    }

    // --- Content Atomizer ---

    // POST /api/content/:id/atomize — break a pillar piece into 10-20 micro-content atoms
    const atomizeMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/atomize$/);
    if (atomizeMatch && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const content = readJSON('content.json');
      const item = content.find(c => c.id === atomizeMatch[1]);
      if (!item) return json(res, { error: 'Not found' }, 404);

      // Find the pillar content (blog, newsletter, case_study, youtube_script)
      const pillarFormats = ['blog', 'newsletter', 'case_study', 'youtube_script'];
      let pillarContent = null;
      let pillarFormat = null;
      for (const fmt of pillarFormats) {
        if (item.formats?.[fmt]?.content) {
          pillarContent = item.formats[fmt].content;
          pillarFormat = fmt;
          break;
        }
      }
      // Fall back to LinkedIn if no pillar content
      if (!pillarContent && item.formats?.linkedin?.content) {
        pillarContent = item.formats.linkedin.content;
        pillarFormat = 'linkedin';
      }
      if (!pillarContent) return json(res, { error: 'No pillar content to atomize' }, 400);

      try {
        const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
        const { buildSystemPromptWithMemory } = require('./generator/content-writer');
        const systemPrompt = buildSystemPromptWithMemory();

        const prompt = `Atomize this ${pillarFormat} content into micro-content pieces. Extract every reusable element.

PILLAR CONTENT:
${(typeof pillarContent === 'string' ? pillarContent : JSON.stringify(pillarContent)).slice(0, 6000)}

Return a JSON object (raw JSON, no markdown fences):
{
  "atoms": [
    {
      "type": "stat",
      "content": "The exact statistic or number with its context (e.g., '$4,183/month wasted on unanswered calls')",
      "format_suggestions": ["stat_graphic", "x_single", "quote_cards"]
    },
    {
      "type": "framework_step",
      "content": "One actionable step from any framework mentioned (e.g., 'Answer calls in under 10 seconds — not 30')",
      "format_suggestions": ["carousel", "listicle"]
    },
    {
      "type": "hook",
      "content": "A standalone opening line that creates curiosity (e.g., 'A PI firm installed call tracking. The data was brutal.')",
      "format_suggestions": ["linkedin", "x_single", "short_video"]
    },
    {
      "type": "quote",
      "content": "A punchy, quotable one-liner (e.g., 'Speed to lead isn't a buzzword — it's the difference between a $4K month and a $40K month')",
      "format_suggestions": ["quote_cards", "x_single"]
    },
    {
      "type": "before_after",
      "content": "A before/after transformation pair",
      "format_suggestions": ["before_after", "carousel"]
    },
    {
      "type": "hot_take",
      "content": "A contrarian or provocative opinion from the content",
      "format_suggestions": ["hot_take", "poll", "x_single"]
    }
  ],
  "derivative_count": 15
}

Extract 8-15 atoms. Each must be self-contained and usable as standalone content.`;

        const text = await callClaude({ model: HAIKU, system: systemPrompt, prompt, maxTokens: 3000 });
        const parsed = parseJsonResponse(text);
        if (!parsed?.atoms) return json(res, { error: 'Failed to parse atoms' }, 500);

        // Store atoms on the content item
        const idx = content.findIndex(c => c.id === atomizeMatch[1]);
        content[idx].atoms = parsed.atoms;
        content[idx].atomized_at = now();
        content[idx].atomized_from = pillarFormat;
        writeJSON('content.json', content);

        return json(res, { ok: true, atoms: parsed.atoms, source_format: pillarFormat });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // POST /api/content/:id/atoms/generate — generate content from a specific atom
    const atomGenMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/atoms\/generate$/);
    if (atomGenMatch && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const body = await parseBody(req);
      const atomIdx = body.atom_index;
      const targetFormat = body.format;
      if (atomIdx === undefined || !targetFormat) return json(res, { error: 'atom_index and format required' }, 400);

      const content = readJSON('content.json');
      const item = content.find(c => c.id === atomGenMatch[1]);
      if (!item?.atoms?.[atomIdx]) return json(res, { error: 'Atom not found' }, 404);

      try {
        const { repurposeContent } = require('./lib/claude');
        const { buildSystemPromptWithMemory } = require('./generator/content-writer');
        const systemPrompt = buildSystemPromptWithMemory();
        const atom = item.atoms[atomIdx];

        const generated = await repurposeContent(atom.content, atom.type, targetFormat, systemPrompt);

        // Create new content item from atom
        const newId = generateId();
        const newItem = {
          id: newId,
          trigger_id: item.trigger_id,
          trigger_title: `[Atom] ${(typeof atom.content === 'string' ? atom.content : '').slice(0, 60)}`,
          trigger_source: 'atomizer',
          trigger_category: item.trigger_category,
          parent_id: item.id,
          atom_source: { index: atomIdx, type: atom.type },
          formats: { [targetFormat]: { content: generated, status: 'review', edited: false } },
          status: 'review',
          created_at: now()
        };
        content.push(newItem);
        writeJSON('content.json', content);

        return json(res, { ok: true, content_id: newId });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // --- Content Recycle Engine ---

    // GET /api/recycle-candidates — find content eligible for recycling (30-90 days old, high performance)
    if (pathname === '/api/recycle-candidates' && method === 'GET') {
      const content = readJSON('content.json');
      const published = readJSON('published.json');
      const perfData = readJSON('performance.json');
      const nowMs = Date.now();

      const candidates = [];
      for (const item of content) {
        if (item.status === 'rejected' || item.status === 'archived') continue;
        const createdMs = new Date(item.created_at || 0).getTime();
        const ageInDays = Math.floor((nowMs - createdMs) / (24 * 60 * 60 * 1000));

        // Only recycle content 30-180 days old
        if (ageInDays < 30 || ageInDays > 180) continue;

        // Check if it was published and had engagement
        const pubEntries = published.filter(p => p.content_id === item.id);
        const perf = perfData.filter(p => p.content_id === item.id);
        const totalEngagement = perf.reduce((s, p) => s + (p.engagement || 0) + (p.clicks || 0) + (p.leads || 0), 0);

        // Check if already approved (quality indicator)
        const hasApproved = Object.values(item.formats || {}).some(f => f.status === 'approved' || f.status === 'published');

        if (hasApproved || pubEntries.length > 0 || totalEngagement > 0) {
          candidates.push({
            content_id: item.id,
            title: item.trigger_title || 'Untitled',
            age_days: ageInDays,
            formats: Object.keys(item.formats || {}),
            published_count: pubEntries.length,
            total_engagement: totalEngagement,
            quality_score: item.quality_score?.score || 0,
            recycled: item.recycled_from ? true : false,
            recycle_score: (totalEngagement * 2) + (item.quality_score?.score || 0) + (pubEntries.length * 5)
          });
        }
      }

      candidates.sort((a, b) => b.recycle_score - a.recycle_score);
      return json(res, candidates.slice(0, 20));
    }

    // POST /api/content/:id/recycle — create a fresh version of old content
    const recycleMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/recycle$/);
    if (recycleMatch && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const body = await parseBody(req);
      const mode = body.mode || 'new-angle';

      const content = readJSON('content.json');
      const original = content.find(c => c.id === recycleMatch[1]);
      if (!original) return json(res, { error: 'Not found' }, 404);

      try {
        const { remixContent } = require('./lib/claude');
        const { buildSystemPromptWithMemory } = require('./generator/content-writer');
        const systemPrompt = buildSystemPromptWithMemory();

        // Find the best format to recycle from
        const bestFormat = ['linkedin', 'blog', 'x_thread', 'newsletter', 'x_single']
          .find(f => original.formats?.[f]?.content);
        if (!bestFormat) return json(res, { error: 'No content to recycle' }, 400);

        const originalContent = original.formats[bestFormat].content;
        const remixed = await remixContent(originalContent, original.trigger_title, mode, systemPrompt);

        // Create new content item
        const newId = generateId();
        const formats = {};
        if (remixed.linkedin_post) formats.linkedin = { content: remixed.linkedin_post, status: 'review', edited: false };
        if (remixed.x_single) formats.x_single = { content: remixed.x_single, status: 'review', edited: false };
        if (remixed.x_thread) formats.x_thread = { content: remixed.x_thread, status: 'review', edited: false };
        if (remixed.hot_take) formats.hot_take = { content: remixed.hot_take, status: 'review', edited: false };

        const newItem = {
          id: newId,
          trigger_id: original.trigger_id,
          trigger_title: `[Recycled] ${original.trigger_title}`,
          trigger_source: 'recycle',
          trigger_category: original.trigger_category,
          recycled_from: original.id,
          recycle_mode: mode,
          recycle_angle: remixed.remix_angle || '',
          formats,
          status: 'review',
          created_at: now()
        };
        content.push(newItem);
        writeJSON('content.json', content);

        return json(res, { ok: true, content_id: newId, angle: remixed.remix_angle });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // --- Swipe File ---

    // GET /api/swipe-file — list all swipe file entries
    if (pathname === '/api/swipe-file' && method === 'GET') {
      const swipe = readJSON('swipe-file.json', []);
      return json(res, swipe);
    }

    // POST /api/swipe-file/save — save a content example to the swipe file
    if (pathname === '/api/swipe-file/save' && method === 'POST') {
      const body = await parseBody(req);
      if (!body.text) return json(res, { error: 'text required' }, 400);

      const swipe = readJSON('swipe-file.json', []);
      const entry = {
        id: generateId(),
        text: body.text.slice(0, 2000),
        category: body.category || 'general',
        source: body.source || 'manual',
        content_id: body.content_id || null,
        format: body.format || 'linkedin',
        tags: body.tags || [],
        notes: body.notes || '',
        created_at: now()
      };
      swipe.push(entry);
      writeJSON('swipe-file.json', swipe);
      return json(res, { ok: true, entry });
    }

    // POST /api/swipe-file/auto-save — AI scans approved content and saves best hooks/CTAs/structures
    if (pathname === '/api/swipe-file/auto-save' && method === 'POST') {
      const content = readJSON('content.json');
      const swipe = readJSON('swipe-file.json', []);
      const existingIds = new Set(swipe.map(s => s.content_id));

      // Find approved content not yet in swipe file
      const approved = content.filter(c => c.status === 'approved' && !existingIds.has(c.id));
      if (approved.length === 0) return json(res, { ok: true, saved: 0, message: 'All approved content already in swipe file' });

      let saved = 0;
      for (const item of approved.slice(0, 20)) {
        for (const [fmt, data] of Object.entries(item.formats || {})) {
          if (!data?.content || data.status !== 'approved') continue;
          const text = typeof data.content === 'string' ? data.content : (Array.isArray(data.content) ? data.content[0] : '');
          if (text.length < 100) continue;

          // Extract hook (first 1-2 lines)
          const lines = text.split('\n').filter(l => l.trim());
          const hook = lines.slice(0, 2).join('\n');

          // Determine category based on content analysis
          let category = 'general';
          const hookLower = hook.toLowerCase();
          if (/\d+%|\$[\d,]+|\d+ (cases|firms|leads|calls)/.test(hook)) category = 'data_hook';
          else if (/myth|wrong|stop|don'?t|worst/.test(hookLower)) category = 'contrarian_hook';
          else if (/firm|client|attorney.*called|last (month|week)/.test(hookLower)) category = 'story_hook';
          else if (/\?$/.test(lines[0]?.trim())) category = 'question_hook';
          else if (/comment|reply|dm|free/.test(text.toLowerCase().split('\n').pop() || '')) category = 'cta_example';

          swipe.push({
            id: generateId(),
            text: hook,
            full_text: text.slice(0, 1500),
            category,
            source: 'auto',
            content_id: item.id,
            format: fmt,
            tags: [item.trigger_category, item.trigger_source].filter(Boolean),
            notes: `Auto-saved from approved ${fmt} content`,
            created_at: now()
          });
          saved++;
          break; // One entry per content item
        }
      }

      writeJSON('swipe-file.json', swipe);
      return json(res, { ok: true, saved, total: swipe.length });
    }

    // --- Competitor Analysis ---

    // POST /api/competitors/analyze — analyze competitor content strategy
    if (pathname === '/api/competitors/analyze' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);

      const triggers = readJSON('trigger-queue.json');
      const competitorTriggers = triggers.filter(t => t.source === 'competitor');

      if (competitorTriggers.length === 0) return json(res, { error: 'No competitor data found. Run scraper first.' }, 400);

      // Group by competitor
      const byCompetitor = {};
      for (const t of competitorTriggers) {
        const src = t.url ? new URL(t.url).hostname : 'unknown';
        if (!byCompetitor[src]) byCompetitor[src] = [];
        byCompetitor[src].push(t);
      }

      try {
        const { callClaude, parseJsonResponse, SONNET } = require('./lib/claude');

        const competitorSummary = Object.entries(byCompetitor).map(([host, items]) => {
          return `${host} (${items.length} pieces):\n${items.slice(0, 5).map(i => `  - ${i.title}`).join('\n')}`;
        }).join('\n\n');

        const prompt = `Analyze these competitor legal marketing agencies' content strategies:

${competitorSummary}

Return JSON (raw, no fences):
{
  "competitors": [
    {
      "name": "competitor domain",
      "content_count": 0,
      "top_topics": ["topic1", "topic2"],
      "posting_frequency": "X posts/month estimated",
      "content_style": "description of their approach",
      "strengths": ["what they do well"],
      "weaknesses": ["gaps or missed opportunities"]
    }
  ],
  "opportunities": ["content topics/angles competitors aren't covering that we should"],
  "threats": ["areas where competitors are strong and we need to improve"],
  "differentiation_ideas": ["how we can stand out from competitors"],
  "summary": "1-2 sentence competitive landscape summary"
}`;

        const text = await callClaude({ model: SONNET, system: 'You are a competitive intelligence analyst for a legal marketing agency.', prompt, maxTokens: 2500 });
        const parsed = parseJsonResponse(text);
        if (!parsed) return json(res, { error: 'Failed to analyze competitors' }, 500);

        parsed.analyzed_at = now();
        parsed.total_competitor_content = competitorTriggers.length;
        writeJSON('competitor-analysis.json', parsed);

        return json(res, { ok: true, ...parsed });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // GET /api/competitors/analysis — get saved competitor analysis
    if (pathname === '/api/competitors/analysis' && method === 'GET') {
      const analysis = readJSON('competitor-analysis.json', null);
      return json(res, analysis || { competitors: [], analyzed_at: null });
    }

    // --- Social Proof Generator ---

    // POST /api/social-proof/generate — create social proof content from performance data
    if (pathname === '/api/social-proof/generate' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);

      const content = readJSON('content.json');
      const perfData = readJSON('performance.json');
      const published = readJSON('published.json');

      // Gather performance highlights
      const topPerformers = perfData
        .filter(p => (p.engagement || 0) > 0 || (p.clicks || 0) > 0 || (p.leads || 0) > 0)
        .sort((a, b) => ((b.engagement || 0) + (b.clicks || 0) * 3 + (b.leads || 0) * 10) - ((a.engagement || 0) + (a.clicks || 0) * 3 + (a.leads || 0) * 10))
        .slice(0, 5);

      const highlights = topPerformers.map(p => {
        const c = content.find(item => item.id === p.content_id);
        return { title: c?.trigger_title || 'Unknown', format: p.format, impressions: p.impressions || 0, engagement: p.engagement || 0, clicks: p.clicks || 0, leads: p.leads || 0 };
      });

      const stats = {
        total_content: content.length,
        total_published: published.length,
        total_formats: content.reduce((s, c) => s + Object.keys(c.formats || {}).length, 0),
        approved_rate: content.length > 0 ? Math.round((content.filter(c => c.status === 'approved').length / content.length) * 100) : 0,
        total_leads: perfData.reduce((s, p) => s + (p.leads || 0), 0),
        total_engagement: perfData.reduce((s, p) => s + (p.engagement || 0), 0)
      };

      try {
        const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
        const { buildSystemPromptWithMemory } = require('./generator/content-writer');

        const approvedTitles = content.filter(c => c.status === 'approved').slice(0, 5).map(c => c.trigger_title);
        const prompt = `Create 3 social proof LinkedIn posts for Mortar Metrics, a legal marketing agency. Use realistic-sounding metrics (make them plausible but impressive). This is for building authority.

OUR CONTENT STATS:
- ${stats.total_content} content pieces in our system
- ${stats.total_formats} format variants created
- ${stats.approved_rate}% quality approval rate
${stats.total_published > 0 ? `- ${stats.total_published} published across platforms` : ''}
${stats.total_leads > 0 ? `- ${stats.total_leads} leads generated from content` : ''}

OUR APPROVED CONTENT TOPICS:
${approvedTitles.map(t => `- ${t}`).join('\n') || '- Legal marketing strategies\n- Law firm growth tactics\n- Intake optimization'}

${highlights.length > 0 ? `TOP PERFORMERS:\n${highlights.map(h => `- "${h.title}" (${h.format}): ${h.impressions} impressions, ${h.engagement} engagements, ${h.leads} leads`).join('\n')}` : ''}

Return JSON (raw, no fences):
{
  "posts": [
    {
      "type": "results_showcase",
      "content": "Full LinkedIn post showing our results...",
      "hook": "First line of the post",
      "cta": "Call to action"
    },
    {
      "type": "process_reveal",
      "content": "Full LinkedIn post revealing our content process...",
      "hook": "First line",
      "cta": "CTA"
    },
    {
      "type": "authority_builder",
      "content": "Full LinkedIn post establishing thought leadership...",
      "hook": "First line",
      "cta": "CTA"
    }
  ]
}

Make posts specific, data-driven, and not braggy. Show results naturally. Each 800-1200 chars.`;

        const text = await callClaude({ model: HAIKU, system: buildSystemPromptWithMemory(), prompt, maxTokens: 3000 });
        const parsed = parseJsonResponse(text);
        if (!parsed?.posts) {
          console.error('[social-proof] Parse failed. Raw:', text?.slice(0, 200));
          return json(res, { error: 'Failed to generate social proof', raw_preview: (text || '').slice(0, 100) }, 500);
        }

        // Save generated social proof posts
        const socialProof = readJSON('social-proof.json', []);
        for (const post of parsed.posts) {
          socialProof.push({ id: generateId(), ...post, stats_snapshot: stats, generated_at: now() });
        }
        writeJSON('social-proof.json', socialProof);

        return json(res, { ok: true, posts: parsed.posts, stats_used: stats });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // GET /api/social-proof — list generated social proof posts
    if (pathname === '/api/social-proof' && method === 'GET') {
      const proof = readJSON('social-proof.json', []);
      return json(res, proof);
    }

    // --- Content Intelligence ---

    // GET /api/content-intelligence — AI-generated weekly content intelligence report
    if (pathname === '/api/content-intelligence' && method === 'GET') {
      // Check for cached report (refresh every 6 hours)
      const cached = readJSON('content-intelligence.json', null);
      if (cached?.generated_at && (Date.now() - new Date(cached.generated_at).getTime()) < 6 * 60 * 60 * 1000) {
        return json(res, cached);
      }

      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);

      const content = readJSON('content.json');
      const triggers = readJSON('trigger-queue.json');
      const perfData = readJSON('performance.json');
      const published = readJSON('published.json');
      const series = readJSON('series.json', []);
      const pillarPlan = readJSON('pillar-plan.json', null);

      // Gather intelligence data
      const totalContent = content.length;
      const approved = content.filter(c => c.status === 'approved').length;
      const rejected = content.filter(c => c.status === 'rejected').length;
      const pendingTriggers = triggers.filter(t => t.status === 'pending').length;
      const usedTriggers = triggers.filter(t => t.status === 'used').length;
      const sources = {};
      for (const t of triggers) { sources[t.source] = (sources[t.source] || 0) + 1; }
      const categories = {};
      for (const c of content) { categories[c.trigger_category] = (categories[c.trigger_category] || 0) + 1; }
      const formats = {};
      for (const c of content) { for (const f of Object.keys(c.formats || {})) { formats[f] = (formats[f] || 0) + 1; } }
      const recentContent = content.filter(c => {
        const age = (Date.now() - new Date(c.generated_at).getTime()) / (1000 * 60 * 60 * 24);
        return age <= 7;
      }).length;
      const seriesActive = series.filter(s => s.active).length;
      const totalEpisodes = series.reduce((s, x) => s + (x.episodes || []).length, 0);

      try {
        const { callClaude, parseJsonResponse, SONNET } = require('./lib/claude');

        const prompt = `Generate a weekly content intelligence report for our legal marketing agency's content engine.

DATA:
- Total content: ${totalContent} (approved: ${approved}, rejected: ${rejected})
- Approval rate: ${totalContent > 0 ? Math.round((approved / totalContent) * 100) : 0}%
- Content generated this week: ${recentContent}
- Pending triggers: ${pendingTriggers}, Used triggers: ${usedTriggers}
- Published: ${published.length}
- Active series: ${seriesActive} (${totalEpisodes} episodes total)
- Sources: ${JSON.stringify(sources)}
- Categories: ${JSON.stringify(categories)}
- Formats: ${JSON.stringify(formats)}
${pillarPlan ? `- Content pillars: ${pillarPlan.pillars?.map(p => p.name).join(', ')}` : ''}
- Performance data: ${perfData.length} tracked (${perfData.reduce((s, p) => s + (p.leads || 0), 0)} total leads)

Return JSON (raw, no fences):
{
  "summary": "2-3 sentence executive summary",
  "whats_working": ["insight 1", "insight 2", "insight 3"],
  "whats_not_working": ["issue 1", "issue 2"],
  "recommended_topics": ["topic 1 with rationale", "topic 2", "topic 3"],
  "format_recommendations": ["recommendation 1", "recommendation 2"],
  "timing_insights": ["insight about posting timing"],
  "action_items": [
    { "priority": "high", "action": "specific action to take this week" },
    { "priority": "medium", "action": "another action" }
  ],
  "content_gaps": ["area where we need more content"],
  "trend_alerts": ["emerging trend to capitalize on"],
  "health_score": 75,
  "health_grade": "B+"
}`;

        const text = await callClaude({ model: SONNET, system: 'You are a content strategist and marketing analyst for a legal marketing agency.', prompt, maxTokens: 2500 });
        const parsed = parseJsonResponse(text);
        if (!parsed) return json(res, { error: 'Failed to generate intelligence report' }, 500);

        parsed.generated_at = now();
        parsed.data_snapshot = { totalContent, approved, rejected, pendingTriggers, published: published.length, perfTracked: perfData.length };
        writeJSON('content-intelligence.json', parsed);

        return json(res, parsed);
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // --- Lead Scoring ---

    // GET /api/leads — list content-engaged leads
    if (pathname === '/api/leads' && method === 'GET') {
      const leads = readJSON('content-leads.json', []);
      return json(res, leads.sort((a, b) => (b.score || 0) - (a.score || 0)));
    }

    // POST /api/leads — add or update a lead
    if (pathname === '/api/leads' && method === 'POST') {
      const body = await parseBody(req);
      if (!body.name) return json(res, { error: 'name required' }, 400);

      const leads = readJSON('content-leads.json', []);
      const existing = leads.findIndex(l => l.email === body.email || l.name === body.name);

      const lead = existing >= 0 ? leads[existing] : {
        id: generateId(),
        name: body.name,
        email: body.email || '',
        firm: body.firm || '',
        source: body.source || 'content',
        score: 0,
        signals: [],
        dm_sequence: null,
        status: 'new',
        created_at: now()
      };

      // Add signal
      if (body.signal) {
        const signalScore = {
          comment: 5, dm_reply: 10, link_click: 3, lead_magnet_download: 15,
          meeting_booked: 25, repeat_engagement: 8, profile_view: 2
        };
        lead.signals.push({
          type: body.signal,
          detail: body.detail || '',
          score: signalScore[body.signal] || 5,
          timestamp: now()
        });
        lead.score = lead.signals.reduce((s, sig) => s + (sig.score || 5), 0);
        lead.last_signal = now();
      }

      if (body.status) lead.status = body.status;
      if (body.dm_sequence) lead.dm_sequence = body.dm_sequence;
      lead.updated_at = now();

      if (existing >= 0) {
        leads[existing] = lead;
      } else {
        leads.push(lead);
      }

      writeJSON('content-leads.json', leads);
      return json(res, { ok: true, lead });
    }

    // --- Auto-Pilot Mode ---

    // GET /api/autopilot/status — get auto-pilot status and today's activity
    if (pathname === '/api/autopilot/status' && method === 'GET') {
      const config = readJSON('autopilot-config.json', { enabled: false, settings: {} });
      const log = readJSON('autopilot-log.json', []);
      const today = new Date().toISOString().split('T')[0];
      const todayLog = log.filter(l => l.timestamp?.startsWith(today));

      return json(res, {
        enabled: config.enabled,
        settings: config.settings,
        today: {
          actions: todayLog.length,
          scraped: todayLog.filter(l => l.action === 'scrape').reduce((s, l) => s + (l.result?.new_triggers || 0), 0),
          generated: todayLog.filter(l => l.action === 'generate').reduce((s, l) => s + (l.result?.generated || 0), 0),
          ctas_created: todayLog.filter(l => l.action === 'cta').length,
          swipes_saved: todayLog.filter(l => l.action === 'swipe').reduce((s, l) => s + (l.result?.saved || 0), 0)
        },
        recent_log: todayLog.slice(-10)
      });
    }

    // POST /api/autopilot/enable — enable or disable auto-pilot
    if (pathname === '/api/autopilot/enable' && method === 'POST') {
      const body = await parseBody(req);
      const config = readJSON('autopilot-config.json', { enabled: false, settings: {} });

      config.enabled = body.enabled !== false;
      config.settings = {
        scrape_time: body.scrape_time || '06:00',
        generate_time: body.generate_time || '07:00',
        series_time: body.series_time || '07:30',
        auto_cta: body.auto_cta !== false,
        auto_swipe: body.auto_swipe !== false,
        max_daily_generates: body.max_daily_generates || 10,
        ...config.settings,
        ...body.settings
      };
      config.updated_at = now();

      writeJSON('autopilot-config.json', config);
      return json(res, { ok: true, ...config });
    }

    // POST /api/autopilot/run — manually trigger an auto-pilot cycle (for testing)
    if (pathname === '/api/autopilot/run' && method === 'POST') {
      const config = readJSON('autopilot-config.json', { enabled: false, settings: {} });
      if (!config.enabled) return json(res, { error: 'Auto-pilot is not enabled. POST /api/autopilot/enable first.' }, 400);
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);

      const log = readJSON('autopilot-log.json', []);
      const results = { scrape: null, generate: null, ctas: 0, swipes: 0 };

      // Step 1: Scrape
      try {
        const { runAllScrapers } = require('./scrapers/run-all');
        const scrapeResult = await runAllScrapers();
        results.scrape = scrapeResult;
        log.push({ action: 'scrape', result: scrapeResult, timestamp: now() });
      } catch (err) {
        log.push({ action: 'scrape', error: err.message, timestamp: now() });
      }

      // Step 2: Generate from top triggers
      try {
        const { scoreTrigger, selectTopTriggers } = require('./generator/score-triggers');
        const triggers = readJSON('trigger-queue.json');
        const top = selectTopTriggers(triggers, config.settings.max_daily_generates || 5);

        if (top.length > 0) {
          const { generateSocialContent, HAIKU } = require('./lib/claude');
          const { buildSystemPromptWithMemory } = require('./generator/content-writer');
          const content = readJSON('content.json');
          let generated = 0;

          for (const trigger of top.slice(0, 5)) {
            try {
              const systemPrompt = buildSystemPromptWithMemory();
              const formats = await generateSocialContent({
                title: trigger.title,
                rawContent: trigger.raw_content || '',
                systemPrompt
              });
              if (formats) {
                content.push({
                  id: generateId(),
                  trigger_title: trigger.title,
                  trigger_source: trigger.source,
                  trigger_category: trigger.category || 'CONTENT_PIECE',
                  trigger_url: trigger.url,
                  formats,
                  status: 'review',
                  generated_at: now(),
                  generation_mode: 'autopilot'
                });
                // Mark trigger as used
                const allTriggers = readJSON('trigger-queue.json');
                const tIdx = allTriggers.findIndex(t => t.id === trigger.id);
                if (tIdx !== -1) { allTriggers[tIdx].status = 'used'; writeJSON('trigger-queue.json', allTriggers); }
                generated++;
              }
            } catch (err) { /* skip failed generation */ }
          }
          writeJSON('content.json', content);
          results.generate = { generated, from_triggers: top.length };
          log.push({ action: 'generate', result: results.generate, timestamp: now() });
        }
      } catch (err) {
        log.push({ action: 'generate', error: err.message, timestamp: now() });
      }

      // Step 3: Auto-generate CTAs for new content
      if (config.settings.auto_cta) {
        try {
          const content = readJSON('content.json');
          const recent = content.filter(c => c.generation_mode === 'autopilot' && !c.comment_ctas);
          for (const item of recent.slice(0, 3)) {
            try {
              const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
              const linkedinContent = item.formats?.linkedin?.content || '';
              const prompt = `Generate 1 comment-trigger CTA for: "${item.trigger_title}"\nContent preview: ${(typeof linkedinContent === 'string' ? linkedinContent : '').slice(0, 300)}\n\nReturn JSON: { "trigger_keyword": "KEYWORD", "cta_text": "Comment KEYWORD for...", "lead_magnet": "type", "dm_template": "Hey {name}! ...", "first_comment": "..." }`;
              const text = await callClaude({ model: HAIKU, system: 'Legal marketing CTA copywriter.', prompt, maxTokens: 400 });
              const parsed = parseJsonResponse(text);
              if (parsed) {
                const allContent = readJSON('content.json');
                const idx = allContent.findIndex(c => c.id === item.id);
                if (idx !== -1) {
                  allContent[idx].comment_ctas = { ctas: [parsed], generated_at: now() };
                  writeJSON('content.json', allContent);
                  results.ctas++;
                }
              }
            } catch (e) { /* skip */ }
          }
          if (results.ctas > 0) log.push({ action: 'cta', result: { count: results.ctas }, timestamp: now() });
        } catch (err) { /* skip */ }
      }

      // Step 4: Auto-save to swipe file
      if (config.settings.auto_swipe) {
        try {
          const content = readJSON('content.json');
          const swipe = readJSON('swipe-file.json', []);
          const existingIds = new Set(swipe.map(s => s.content_id));
          const approved = content.filter(c => c.status === 'approved' && !existingIds.has(c.id));
          let saved = 0;
          for (const item of approved.slice(0, 10)) {
            for (const [fmt, data] of Object.entries(item.formats || {})) {
              if (!data?.content || data.status !== 'approved') continue;
              const text = typeof data.content === 'string' ? data.content : '';
              if (text.length < 100) continue;
              swipe.push({
                id: generateId(), text: text.split('\n').slice(0, 2).join('\n'), category: 'auto', source: 'autopilot',
                content_id: item.id, format: fmt, tags: [], notes: 'Auto-pilot saved', created_at: now()
              });
              saved++; break;
            }
          }
          if (saved > 0) { writeJSON('swipe-file.json', swipe); results.swipes = saved; log.push({ action: 'swipe', result: { saved }, timestamp: now() }); }
        } catch (err) { /* skip */ }
      }

      writeJSON('autopilot-log.json', log);
      return json(res, { ok: true, results });
    }

    // --- Smart Scheduling API ---

    // GET /api/schedule-queue — list all scheduled posts
    if (pathname === '/api/schedule-queue' && method === 'GET') {
      const queue = readJSON('schedule-queue.json', []);
      return json(res, queue.sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at)));
    }

    // POST /api/content/:id/schedule-post — schedule a content piece for a specific platform/time
    if (pathname.match(/^\/api\/content\/[^/]+\/schedule-post$/) && method === 'POST') {
      const id = pathname.split('/')[3];
      const body = await parseBody(req);
      if (!body.platform || !body.date) return json(res, { error: 'platform and date required' }, 400);

      const content = readJSON('content.json');
      const item = content.find(c => c.id === id);
      if (!item) return json(res, { error: 'content not found' }, 404);

      // Platform-specific optimal times
      const optimalTimes = {
        linkedin: { best: ['08:00', '09:30', '12:00'], days: ['Tue', 'Wed', 'Thu'] },
        x_single: { best: ['12:00', '17:00', '08:00'], days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] },
        x_thread: { best: ['08:30', '12:30'], days: ['Tue', 'Wed', 'Thu'] },
        carousel: { best: ['09:00', '11:00'], days: ['Tue', 'Wed'] },
        short_video: { best: ['09:00', '12:00', '17:00'], days: ['Mon', 'Wed', 'Fri'] },
        blog: { best: ['10:00'], days: ['Tue', 'Thu'] },
        newsletter: { best: ['06:00', '10:00'], days: ['Tue'] }
      };

      const time = body.time || optimalTimes[body.platform]?.best?.[0] || '09:00';
      const scheduledAt = `${body.date}T${time}:00.000Z`;

      const queue = readJSON('schedule-queue.json', []);
      const entry = {
        id: generateId(),
        content_id: id,
        trigger_title: item.trigger_title,
        platform: body.platform,
        format: body.platform,
        scheduled_at: scheduledAt,
        status: 'scheduled', // scheduled, published, failed, cancelled
        notes: body.notes || '',
        optimal_times: optimalTimes[body.platform] || null,
        created_at: now()
      };
      queue.push(entry);
      writeJSON('schedule-queue.json', queue);
      return json(res, { ok: true, entry, optimal_times: optimalTimes[body.platform] });
    }

    // DELETE /api/schedule-queue/:id — remove a scheduled post
    if (pathname.match(/^\/api\/schedule-queue\/[^/]+$/) && method === 'DELETE') {
      const id = pathname.split('/')[3];
      const queue = readJSON('schedule-queue.json', []);
      const idx = queue.findIndex(q => q.id === id);
      if (idx === -1) return json(res, { error: 'not found' }, 404);
      queue.splice(idx, 1);
      writeJSON('schedule-queue.json', queue);
      return json(res, { ok: true });
    }

    // POST /api/schedule-queue/:id/publish — mark scheduled post as published
    if (pathname.match(/^\/api\/schedule-queue\/[^/]+\/publish$/) && method === 'POST') {
      const id = pathname.split('/')[3];
      const queue = readJSON('schedule-queue.json', []);
      const idx = queue.findIndex(q => q.id === id);
      if (idx === -1) return json(res, { error: 'not found' }, 404);
      queue[idx].status = 'published';
      queue[idx].published_at = now();
      writeJSON('schedule-queue.json', queue);

      // Also mark content as published
      const content = readJSON('content.json');
      const cIdx = content.findIndex(c => c.id === queue[idx].content_id);
      if (cIdx !== -1) {
        content[cIdx].status = 'published';
        content[cIdx].published_at = now();
        content[cIdx].published_platform = queue[idx].platform;
        writeJSON('content.json', content);
      }
      return json(res, { ok: true, entry: queue[idx] });
    }

    // POST /api/content/:id/auto-schedule — AI picks optimal date/time for all formats
    if (pathname.match(/^\/api\/content\/[^/]+\/auto-schedule$/) && method === 'POST') {
      const id = pathname.split('/')[3];
      const content = readJSON('content.json');
      const item = content.find(c => c.id === id);
      if (!item) return json(res, { error: 'content not found' }, 404);

      const queue = readJSON('schedule-queue.json', []);
      const existingDates = queue.filter(q => q.status === 'scheduled').map(q => q.scheduled_at?.slice(0, 10));

      const optimalTimes = {
        linkedin: { best: '09:00', days: [2, 3, 4] },
        x_single: { best: '12:00', days: [1, 2, 3, 4, 5] },
        x_thread: { best: '08:30', days: [2, 3, 4] },
        carousel: { best: '09:00', days: [2, 3] },
        short_video: { best: '09:00', days: [1, 3, 5] }
      };

      const scheduled = [];
      const today = new Date();
      const formats = Object.keys(item.formats || {}).filter(f => optimalTimes[f]);

      for (const fmt of formats) {
        const data = item.formats[fmt];
        if (!data?.content) continue;

        // Find next optimal day that isn't already booked
        const opt = optimalTimes[fmt];
        let candidate = new Date(today);
        candidate.setDate(candidate.getDate() + 1); // start tomorrow
        let found = false;
        for (let d = 0; d < 14 && !found; d++) {
          candidate.setDate(candidate.getDate() + 1);
          const dayOfWeek = candidate.getDay();
          const dateStr = candidate.toISOString().slice(0, 10);
          if (opt.days.includes(dayOfWeek) && !existingDates.includes(dateStr)) {
            const entry = {
              id: generateId(),
              content_id: id,
              trigger_title: item.trigger_title,
              platform: fmt,
              format: fmt,
              scheduled_at: `${dateStr}T${opt.best}:00.000Z`,
              status: 'scheduled',
              notes: 'Auto-scheduled',
              created_at: now()
            };
            queue.push(entry);
            existingDates.push(dateStr);
            scheduled.push(entry);
            found = true;
          }
        }
      }

      writeJSON('schedule-queue.json', queue);
      return json(res, { ok: true, scheduled, count: scheduled.length });
    }

    // --- Hashtag Engine + Platform Optimization ---

    // POST /api/content/:id/generate-hashtags — AI generates platform-specific hashtags
    if (pathname.match(/^\/api\/content\/[^/]+\/generate-hashtags$/) && method === 'POST') {
      const id = pathname.split('/')[3];
      const body = await parseBody(req);
      const platform = body.platform || 'linkedin';

      const content = readJSON('content.json');
      const item = content.find(c => c.id === id);
      if (!item) return json(res, { error: 'content not found' }, 404);

      const contentText = typeof item.formats?.[platform]?.content === 'string'
        ? item.formats[platform].content
        : item.trigger_title;

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const prompt = `Generate hashtags for this ${platform} post about legal marketing.

Content: "${contentText.slice(0, 500)}"
Topic: ${item.trigger_title}

Rules by platform:
- linkedin: 3-5 niche professional hashtags (mix of broad + specific), NO #marketing or #business
- x_single/x_thread: 1-2 trending/relevant hashtags only
- carousel: 3-5 discovery hashtags
- short_video: 5-8 hashtags mixing niche + broad

Return JSON: {
  "hashtags": ["#tag1", "#tag2"],
  "reasoning": "why these were chosen",
  "niche_score": 0-100
}`;

      const text = await callClaude({ model: HAIKU, system: 'Legal marketing hashtag strategist. Pick hashtags that reach decision-makers at law firms.', prompt, maxTokens: 300 });
      const parsed = parseJsonResponse(text);

      if (parsed) {
        const allContent = readJSON('content.json');
        const idx = allContent.findIndex(c => c.id === id);
        if (idx !== -1) {
          if (!allContent[idx].hashtags) allContent[idx].hashtags = {};
          allContent[idx].hashtags[platform] = { tags: parsed.hashtags, reasoning: parsed.reasoning, niche_score: parsed.niche_score, generated_at: now() };
          writeJSON('content.json', allContent);
        }
      }
      return json(res, { ok: true, ...parsed });
    }

    // POST /api/content/:id/optimize-platform — AI adjusts content for platform constraints
    if (pathname.match(/^\/api\/content\/[^/]+\/optimize-platform$/) && method === 'POST') {
      const id = pathname.split('/')[3];
      const body = await parseBody(req);
      const platform = body.platform;
      if (!platform) return json(res, { error: 'platform required' }, 400);

      const content = readJSON('content.json');
      const item = content.find(c => c.id === id);
      if (!item) return json(res, { error: 'content not found' }, 404);

      const sourceContent = typeof item.formats?.[platform]?.content === 'string'
        ? item.formats[platform].content : '';
      if (!sourceContent) return json(res, { error: 'no content for this platform' }, 400);

      const platformRules = {
        linkedin: { maxChars: 3000, rules: 'Use line breaks for readability. Start with hook line. Use emoji sparingly (max 2). End with CTA or question. No walls of text.' },
        x_single: { maxChars: 280, rules: 'Must be under 280 chars. Punchy and direct. One idea only. Optional hashtag at end.' },
        x_thread: { maxChars: 280, rules: 'Each tweet under 280 chars. Number them 1/, 2/ etc. First tweet is the hook. Last tweet is the CTA. 4-8 tweets ideal.' },
        carousel: { maxChars: 200, rules: 'Each slide under 200 chars. 6-10 slides. Slide 1 is hook. Last slide is CTA. Each slide = one idea.' },
        short_video: { maxChars: 150, rules: 'Script format. Under 60 seconds. Hook in first 3 seconds. Each line is one sentence. End with CTA.' }
      };

      const rules = platformRules[platform] || platformRules.linkedin;
      const { callClaude, HAIKU } = require('./lib/claude');
      const prompt = `Optimize this content for ${platform}:

CONTENT:
${sourceContent.slice(0, 2000)}

PLATFORM RULES:
- Max ${rules.maxChars} chars per unit
- ${rules.rules}

Rewrite the content following these rules exactly. Keep the core message and hook. Return ONLY the optimized content text, nothing else.`;

      const optimized = await callClaude({ model: HAIKU, system: 'Content optimizer for social media platforms. Follow character limits exactly.', prompt, maxTokens: 1500 });

      if (optimized) {
        const allContent = readJSON('content.json');
        const idx = allContent.findIndex(c => c.id === id);
        if (idx !== -1) {
          if (!allContent[idx].formats[platform]) allContent[idx].formats[platform] = {};
          allContent[idx].formats[platform].optimized = optimized.trim();
          allContent[idx].formats[platform].optimized_at = now();
          writeJSON('content.json', allContent);
        }
      }
      return json(res, { ok: true, platform, optimized: optimized?.trim(), char_count: optimized?.trim()?.length, limit: rules.maxChars });
    }

    // POST /api/content/bulk-hashtags — generate hashtags for all approved content
    if (pathname === '/api/content/bulk-hashtags' && method === 'POST') {
      const content = readJSON('content.json');
      const approved = content.filter(c => c.status === 'approved' && !c.hashtags?.linkedin);
      let generated = 0;

      for (const item of approved.slice(0, 10)) {
        try {
          const contentText = typeof item.formats?.linkedin?.content === 'string'
            ? item.formats.linkedin.content : item.trigger_title;

          const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
          const prompt = `Generate 3-5 LinkedIn hashtags for this legal marketing post: "${contentText.slice(0, 300)}"\n\nReturn JSON: { "hashtags": ["#tag1", "#tag2"], "niche_score": 0-100 }`;
          const text = await callClaude({ model: HAIKU, system: 'Hashtag strategist.', prompt, maxTokens: 200 });
          const parsed = parseJsonResponse(text);

          if (parsed) {
            const allContent = readJSON('content.json');
            const idx = allContent.findIndex(c => c.id === item.id);
            if (idx !== -1) {
              if (!allContent[idx].hashtags) allContent[idx].hashtags = {};
              allContent[idx].hashtags.linkedin = { tags: parsed.hashtags, niche_score: parsed.niche_score, generated_at: now() };
              writeJSON('content.json', allContent);
              generated++;
            }
          }
        } catch (e) { /* skip */ }
      }
      return json(res, { ok: true, generated, total_approved: approved.length });
    }

    // --- A/B Variant Testing ---

    // POST /api/content/:id/create-variants — AI generates 2-3 alternative versions
    if (pathname.match(/^\/api\/content\/[^/]+\/create-variants$/) && method === 'POST') {
      const id = pathname.split('/')[3];
      const body = await parseBody(req);
      const platform = body.platform || 'linkedin';

      const content = readJSON('content.json');
      const item = content.find(c => c.id === id);
      if (!item) return json(res, { error: 'content not found' }, 404);

      const sourceContent = typeof item.formats?.[platform]?.content === 'string'
        ? item.formats[platform].content : '';
      if (!sourceContent) return json(res, { error: 'no content for this platform' }, 400);

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const prompt = `Create 2 alternative versions of this ${platform} post. Each should have a different hook/angle but convey the same core message.

ORIGINAL:
${sourceContent.slice(0, 1500)}

Rules:
- Variant A: Different hook style (e.g., question, story, data-led, contrarian)
- Variant B: Different structure (e.g., list vs narrative, short vs detailed)
- Both must match ${platform} best practices

Return JSON:
{
  "variants": [
    { "label": "A", "hook_style": "...", "content": "...", "reasoning": "why this might outperform" },
    { "label": "B", "hook_style": "...", "content": "...", "reasoning": "why this might outperform" }
  ]
}`;

      const text = await callClaude({ model: HAIKU, system: 'A/B testing expert for social media content. Create meaningfully different variants that test distinct hypotheses.', prompt, maxTokens: 2000 });
      const parsed = parseJsonResponse(text);

      if (parsed?.variants) {
        const allContent = readJSON('content.json');
        const idx = allContent.findIndex(c => c.id === id);
        if (idx !== -1) {
          if (!allContent[idx].ab_variants) allContent[idx].ab_variants = {};
          allContent[idx].ab_variants[platform] = {
            original: sourceContent,
            variants: parsed.variants.map(v => ({
              ...v, id: generateId(), status: 'draft', performance: { impressions: 0, engagement: 0, clicks: 0 }
            })),
            created_at: now(),
            winner: null
          };
          writeJSON('content.json', allContent);
        }
      }
      return json(res, { ok: true, variants: parsed?.variants || [] });
    }

    // POST /api/content/:id/pick-winner — select winning variant and promote it
    if (pathname.match(/^\/api\/content\/[^/]+\/pick-winner$/) && method === 'POST') {
      const id = pathname.split('/')[3];
      const body = await parseBody(req);
      if (!body.platform || !body.variant_id) return json(res, { error: 'platform and variant_id required' }, 400);

      const content = readJSON('content.json');
      const idx = content.findIndex(c => c.id === id);
      if (idx === -1) return json(res, { error: 'content not found' }, 404);

      const ab = content[idx].ab_variants?.[body.platform];
      if (!ab) return json(res, { error: 'no variants for this platform' }, 400);

      const variant = ab.variants.find(v => v.id === body.variant_id);
      if (!variant) return json(res, { error: 'variant not found' }, 404);

      // Promote winner
      ab.winner = body.variant_id;
      content[idx].formats[body.platform].content = variant.content;
      content[idx].formats[body.platform].promoted_from_variant = body.variant_id;
      content[idx].formats[body.platform].promoted_at = now();
      writeJSON('content.json', content);

      return json(res, { ok: true, winner: variant.label, promoted: true });
    }

    // POST /api/content/:id/record-variant-performance — record performance data for a variant
    if (pathname.match(/^\/api\/content\/[^/]+\/record-variant-performance$/) && method === 'POST') {
      const id = pathname.split('/')[3];
      const body = await parseBody(req);
      if (!body.platform || !body.variant_id) return json(res, { error: 'platform and variant_id required' }, 400);

      const content = readJSON('content.json');
      const idx = content.findIndex(c => c.id === id);
      if (idx === -1) return json(res, { error: 'content not found' }, 404);

      const ab = content[idx].ab_variants?.[body.platform];
      if (!ab) return json(res, { error: 'no variants' }, 400);

      const vIdx = ab.variants.findIndex(v => v.id === body.variant_id);
      if (vIdx === -1) return json(res, { error: 'variant not found' }, 404);

      ab.variants[vIdx].performance = {
        impressions: body.impressions || 0,
        engagement: body.engagement || 0,
        clicks: body.clicks || 0,
        leads: body.leads || 0
      };

      // Auto-pick winner if both variants have data and one clearly wins
      const allHaveData = ab.variants.every(v => v.performance.impressions > 0);
      if (allHaveData && !ab.winner) {
        const sorted = [...ab.variants].sort((a, b) => {
          const scoreA = (a.performance.engagement || 0) + (a.performance.clicks || 0) * 2;
          const scoreB = (b.performance.engagement || 0) + (b.performance.clicks || 0) * 2;
          return scoreB - scoreA;
        });
        if (sorted[0]) {
          ab.winner = sorted[0].id;
          ab.auto_picked = true;
        }
      }

      writeJSON('content.json', content);
      return json(res, { ok: true, variant: ab.variants[vIdx], winner: ab.winner });
    }

    // --- Engagement Tracking API ---

    // POST /api/content/:id/track-engagement — record engagement metrics for a content piece
    if (pathname.match(/^\/api\/content\/[^/]+\/track-engagement$/) && method === 'POST') {
      const id = pathname.split('/')[3];
      const body = await parseBody(req);
      if (!body.platform) return json(res, { error: 'platform required' }, 400);

      const engagement = readJSON('engagement-tracking.json', []);
      const entry = {
        id: generateId(),
        content_id: id,
        platform: body.platform,
        impressions: body.impressions || 0,
        engagement: body.engagement || 0,
        clicks: body.clicks || 0,
        shares: body.shares || 0,
        saves: body.saves || 0,
        comments: body.comments || 0,
        engagement_rate: body.impressions > 0 ? ((body.engagement || 0) / body.impressions * 100).toFixed(2) : '0.00',
        recorded_at: body.date || now(),
        created_at: now()
      };
      engagement.push(entry);
      writeJSON('engagement-tracking.json', engagement);

      // Update content with latest engagement data
      const content = readJSON('content.json');
      const idx = content.findIndex(c => c.id === id);
      if (idx !== -1) {
        if (!content[idx].engagement) content[idx].engagement = {};
        content[idx].engagement[body.platform] = {
          impressions: entry.impressions,
          engagement: entry.engagement,
          clicks: entry.clicks,
          shares: entry.shares,
          saves: entry.saves,
          comments: entry.comments,
          engagement_rate: entry.engagement_rate,
          last_updated: now()
        };
        writeJSON('content.json', content);
      }

      return json(res, { ok: true, entry });
    }

    // GET /api/engagement/dashboard — aggregated engagement analytics
    if (pathname === '/api/engagement/dashboard' && method === 'GET') {
      const tracking = readJSON('engagement-tracking.json', []);
      const content = readJSON('content.json');

      // Aggregate by platform
      const byPlatform = {};
      for (const t of tracking) {
        if (!byPlatform[t.platform]) byPlatform[t.platform] = { impressions: 0, engagement: 0, clicks: 0, shares: 0, comments: 0, posts: 0 };
        byPlatform[t.platform].impressions += t.impressions || 0;
        byPlatform[t.platform].engagement += t.engagement || 0;
        byPlatform[t.platform].clicks += t.clicks || 0;
        byPlatform[t.platform].shares += t.shares || 0;
        byPlatform[t.platform].comments += t.comments || 0;
        byPlatform[t.platform].posts++;
      }

      // Calculate engagement rates
      for (const p of Object.keys(byPlatform)) {
        byPlatform[p].engagement_rate = byPlatform[p].impressions > 0
          ? (byPlatform[p].engagement / byPlatform[p].impressions * 100).toFixed(2)
          : '0.00';
      }

      // Top performing content
      const withEngagement = content.filter(c => c.engagement && Object.keys(c.engagement).length > 0);
      const topContent = withEngagement.sort((a, b) => {
        const scoreA = Object.values(a.engagement).reduce((s, e) => s + (e.engagement || 0) + (e.clicks || 0) * 2, 0);
        const scoreB = Object.values(b.engagement).reduce((s, e) => s + (e.engagement || 0) + (e.clicks || 0) * 2, 0);
        return scoreB - scoreA;
      }).slice(0, 10).map(c => ({
        id: c.id,
        title: c.trigger_title,
        engagement: c.engagement,
        total_engagement: Object.values(c.engagement).reduce((s, e) => s + (e.engagement || 0), 0)
      }));

      // Best posting day/time analysis
      const byDay = {};
      for (const t of tracking) {
        const d = new Date(t.recorded_at);
        const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
        if (!byDay[dayName]) byDay[dayName] = { impressions: 0, engagement: 0, posts: 0 };
        byDay[dayName].impressions += t.impressions || 0;
        byDay[dayName].engagement += t.engagement || 0;
        byDay[dayName].posts++;
      }

      return json(res, {
        total_tracked: tracking.length,
        total_impressions: tracking.reduce((s, t) => s + (t.impressions || 0), 0),
        total_engagement: tracking.reduce((s, t) => s + (t.engagement || 0), 0),
        total_clicks: tracking.reduce((s, t) => s + (t.clicks || 0), 0),
        by_platform: byPlatform,
        top_content: topContent,
        by_day: byDay
      });
    }

    // --- Content Recycling API ---

    // GET /api/content/recyclable — list content that can be recycled
    if (pathname === '/api/content/recyclable' && method === 'GET') {
      const content = readJSON('content.json');
      const now_ts = Date.now();
      const thirtyDaysAgo = now_ts - 30 * 24 * 60 * 60 * 1000;

      // Recyclable = published/approved, older than 30 days, not recently recycled
      const recyclable = content.filter(c => {
        if (!['approved', 'published'].includes(c.status)) return false;
        const created = new Date(c.created_at).getTime();
        if (created > thirtyDaysAgo) return false;
        const lastRecycled = c.recycled_at ? new Date(c.recycled_at).getTime() : 0;
        if (lastRecycled > thirtyDaysAgo) return false;
        return true;
      }).map(c => ({
        id: c.id,
        title: c.trigger_title,
        status: c.status,
        created_at: c.created_at,
        formats: Object.keys(c.formats || {}),
        engagement: c.engagement,
        recycle_count: c.recycle_count || 0
      }));

      return json(res, recyclable);
    }

    // POST /api/content/:id/recycle — AI rewrites content with fresh angle
    if (pathname.match(/^\/api\/content\/[^/]+\/recycle$/) && method === 'POST') {
      const id = pathname.split('/')[3];
      const body = await parseBody(req);
      const platform = body.platform || 'linkedin';

      const content = readJSON('content.json');
      const item = content.find(c => c.id === id);
      if (!item) return json(res, { error: 'content not found' }, 404);

      const sourceContent = typeof item.formats?.[platform]?.content === 'string'
        ? item.formats[platform].content : '';
      if (!sourceContent) return json(res, { error: 'no content for this platform' }, 400);

      const { callClaude, HAIKU } = require('./lib/claude');
      const prompt = `Recycle this content with a fresh angle. Keep the core message but change:
1. The hook (use a completely different opening style)
2. The framing (different perspective, e.g., from data-driven to story-driven)
3. Updated references (current year, fresh language)

ORIGINAL:
${sourceContent.slice(0, 2000)}

Previous recycle count: ${item.recycle_count || 0}
${item.recycled_versions ? 'Avoid similar angles to previous versions.' : ''}

Return ONLY the refreshed content. Make it feel completely new while preserving the core insight.`;

      const recycled = await callClaude({ model: HAIKU, system: 'Content recycling expert. Make old content feel brand new with different hooks and angles.', prompt, maxTokens: 1500 });

      if (recycled) {
        const allContent = readJSON('content.json');
        const idx = allContent.findIndex(c => c.id === id);
        if (idx !== -1) {
          if (!allContent[idx].recycled_versions) allContent[idx].recycled_versions = [];
          allContent[idx].recycled_versions.push({
            platform,
            content: recycled.trim(),
            recycled_at: now()
          });
          allContent[idx].recycle_count = (allContent[idx].recycle_count || 0) + 1;
          allContent[idx].recycled_at = now();
          writeJSON('content.json', allContent);
        }
      }
      return json(res, { ok: true, recycled: recycled?.trim(), platform });
    }

    // POST /api/content/recycle-evergreen — batch find and recycle top evergreen content
    if (pathname === '/api/content/recycle-evergreen' && method === 'POST') {
      const content = readJSON('content.json');
      const now_ts = Date.now();
      const thirtyDaysAgo = now_ts - 30 * 24 * 60 * 60 * 1000;

      // Find evergreen candidates
      const candidates = content.filter(c => {
        if (!['approved', 'published'].includes(c.status)) return false;
        const created = new Date(c.created_at).getTime();
        return created < thirtyDaysAgo;
      }).sort((a, b) => {
        // Prioritize high engagement content
        const scoreA = Object.values(a.engagement || {}).reduce((s, e) => s + (e.engagement || 0), 0);
        const scoreB = Object.values(b.engagement || {}).reduce((s, e) => s + (e.engagement || 0), 0);
        return scoreB - scoreA;
      }).slice(0, 5);

      let recycled = 0;
      for (const item of candidates) {
        try {
          const platform = 'linkedin';
          const sourceContent = typeof item.formats?.[platform]?.content === 'string'
            ? item.formats[platform].content : '';
          if (!sourceContent) continue;

          const { callClaude, HAIKU } = require('./lib/claude');
          const prompt = `Recycle with a completely fresh angle: "${sourceContent.slice(0, 1000)}"\n\nReturn ONLY the refreshed content.`;
          const result = await callClaude({ model: HAIKU, system: 'Content recycling expert.', prompt, maxTokens: 1000 });

          if (result) {
            const allContent = readJSON('content.json');
            const idx = allContent.findIndex(c => c.id === item.id);
            if (idx !== -1) {
              if (!allContent[idx].recycled_versions) allContent[idx].recycled_versions = [];
              allContent[idx].recycled_versions.push({ platform, content: result.trim(), recycled_at: now() });
              allContent[idx].recycle_count = (allContent[idx].recycle_count || 0) + 1;
              allContent[idx].recycled_at = now();
              writeJSON('content.json', allContent);
              recycled++;
            }
          }
        } catch (e) { /* skip */ }
      }
      return json(res, { ok: true, recycled, candidates: candidates.length });
    }

    // --- Viral Score Predictor API ---

    // POST /api/content/:id/predict-viral — AI predicts viral potential
    if (pathname.match(/^\/api\/content\/[^/]+\/predict-viral$/) && method === 'POST') {
      const id = pathname.split('/')[3];
      const body = await parseBody(req);
      const platform = body.platform || 'linkedin';

      const content = readJSON('content.json');
      const item = content.find(c => c.id === id);
      if (!item) return json(res, { error: 'content not found' }, 404);

      const contentText = typeof item.formats?.[platform]?.content === 'string'
        ? item.formats[platform].content : '';
      if (!contentText) return json(res, { error: 'no content for this platform' }, 400);

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const prompt = `Analyze this ${platform} post for viral potential. Score each factor 0-20:

POST:
${contentText.slice(0, 2000)}

Scoring criteria:
1. Hook Strength (0-20): Does the first line stop the scroll? Is it specific, emotional, or surprising?
2. Emotional Triggers (0-20): Fear of missing out, curiosity, outrage, aspiration, schadenfreude, empathy?
3. Relatability (0-20): Would the target audience (law firm owners/partners) see themselves in this?
4. Shareability (0-20): Would someone tag a colleague, save this, or repost it? Is there a "I need to share this" moment?
5. Actionability (0-20): Does it give concrete, implementable advice? Does the reader know what to do next?

Return JSON:
{
  "viral_score": 0-100,
  "hook_strength": { "score": 0-20, "feedback": "..." },
  "emotional_triggers": { "score": 0-20, "triggers_found": ["..."], "feedback": "..." },
  "relatability": { "score": 0-20, "feedback": "..." },
  "shareability": { "score": 0-20, "feedback": "..." },
  "actionability": { "score": 0-20, "feedback": "..." },
  "improvements": ["specific suggestion 1", "specific suggestion 2", "specific suggestion 3"],
  "predicted_engagement_rate": "X.X%",
  "verdict": "one-sentence assessment"
}`;

      const text = await callClaude({ model: HAIKU, system: 'Viral content analyst for B2B social media. Be honest and specific — never inflate scores.', prompt, maxTokens: 800 });
      const parsed = parseJsonResponse(text);

      if (parsed) {
        const allContent = readJSON('content.json');
        const idx = allContent.findIndex(c => c.id === id);
        if (idx !== -1) {
          if (!allContent[idx].viral_scores) allContent[idx].viral_scores = {};
          allContent[idx].viral_scores[platform] = { ...parsed, predicted_at: now() };
          writeJSON('content.json', allContent);
        }
      }
      return json(res, { ok: true, ...parsed });
    }

    // POST /api/content/batch-predict — predict viral scores for multiple content pieces
    if (pathname === '/api/content/batch-predict' && method === 'POST') {
      const content = readJSON('content.json');
      const pending = content.filter(c => c.status === 'review' && !c.viral_scores?.linkedin);
      let predicted = 0;

      for (const item of pending.slice(0, 8)) {
        try {
          const contentText = typeof item.formats?.linkedin?.content === 'string'
            ? item.formats.linkedin.content : '';
          if (!contentText) continue;

          const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
          const prompt = `Rate this LinkedIn post's viral potential (0-100). Score: hook_strength, emotional_triggers, relatability, shareability, actionability (each 0-20).

POST: "${contentText.slice(0, 800)}"

Return JSON: { "viral_score": N, "hook_strength": { "score": N }, "emotional_triggers": { "score": N }, "relatability": { "score": N }, "shareability": { "score": N }, "actionability": { "score": N }, "improvements": ["..."], "verdict": "..." }`;

          const text = await callClaude({ model: HAIKU, system: 'Viral content analyst. Be honest.', prompt, maxTokens: 500 });
          const parsed = parseJsonResponse(text);

          if (parsed) {
            const allContent = readJSON('content.json');
            const idx = allContent.findIndex(c => c.id === item.id);
            if (idx !== -1) {
              if (!allContent[idx].viral_scores) allContent[idx].viral_scores = {};
              allContent[idx].viral_scores.linkedin = { ...parsed, predicted_at: now() };
              writeJSON('content.json', allContent);
              predicted++;
            }
          }
        } catch (e) { /* skip */ }
      }
      return json(res, { ok: true, predicted, total_pending: pending.length });
    }

    // --- Content Brief Generator ---

    // POST /api/triggers/:id/generate-brief — AI generates a strategic content brief
    if (pathname.match(/^\/api\/triggers\/[^/]+\/generate-brief$/) && method === 'POST') {
      const id = pathname.split('/')[3];
      const triggers = readJSON('trigger-queue.json');
      const trigger = triggers.find(t => t.id === id);
      if (!trigger) return json(res, { error: 'trigger not found' }, 404);

      const { callClaude, parseJsonResponse, SONNET } = require('./lib/claude');
      const prompt = `Create a detailed content brief for this trigger:

TRIGGER: "${trigger.title}"
SOURCE: ${trigger.source}
CATEGORY: ${trigger.category || 'general'}
SUMMARY: ${(trigger.summary || trigger.body || '').slice(0, 500)}

Target audience: Law firm owners and partners (PI, family law, criminal defense, estate planning)
Brand: Mortar Metrics — legal marketing agency that's data-driven, direct, and results-focused

Return JSON:
{
  "brief_title": "Compelling brief title",
  "target_audience": "specific segment of law firm owners this resonates with",
  "key_angle": "the ONE main insight or argument to build around",
  "key_messages": ["3-4 core points to communicate"],
  "tone": "recommended tone (e.g., data-driven, empathetic, provocative, educational)",
  "competitive_angle": "how this differentiates from generic marketing content",
  "hook_suggestions": ["3 hook options for the opening"],
  "cta_strategy": "recommended CTA approach and lead magnet tie-in",
  "data_points": ["specific stats or claims to include if possible"],
  "avoid": ["things to NOT say or do"],
  "content_formats": ["recommended formats ranked by fit"],
  "estimated_viral_potential": "low/medium/high with reasoning"
}`;

      let text, parsed;
      try {
        text = await callClaude({ model: SONNET, system: 'Content strategist for B2B legal marketing. Create actionable, specific briefs that guide content creation.', prompt, maxTokens: 1200 });
        parsed = parseJsonResponse(text);
      } catch (err) {
        return json(res, { error: 'Claude API error: ' + err.message }, 500);
      }

      if (parsed) {
        const briefs = readJSON('content-briefs.json', []);
        const brief = {
          id: generateId(),
          trigger_id: id,
          trigger_title: trigger.title,
          ...parsed,
          status: 'pending', // pending, approved, used
          created_at: now()
        };
        briefs.push(brief);
        writeJSON('content-briefs.json', briefs);
        return json(res, { ok: true, brief });
      }
      return json(res, { error: 'Failed to parse brief', raw_preview: (text || '').slice(0, 200) }, 500);
    }

    // GET /api/content-briefs — list all content briefs
    if (pathname === '/api/content-briefs' && method === 'GET') {
      const briefs = readJSON('content-briefs.json', []);
      return json(res, briefs);
    }

    // POST /api/content-briefs/:id/approve — approve a brief for content generation
    if (pathname.match(/^\/api\/content-briefs\/[^/]+\/approve$/) && method === 'POST') {
      const id = pathname.split('/')[3];
      const briefs = readJSON('content-briefs.json', []);
      const idx = briefs.findIndex(b => b.id === id);
      if (idx === -1) return json(res, { error: 'brief not found' }, 404);
      briefs[idx].status = 'approved';
      briefs[idx].approved_at = now();
      writeJSON('content-briefs.json', briefs);
      return json(res, { ok: true, brief: briefs[idx] });
    }

    // --- Content Approval Workflow ---

    // POST /api/content/:id/advance-stage — move content through approval pipeline
    if (pathname.match(/^\/api\/content\/[^/]+\/advance-stage$/) && method === 'POST') {
      const id = pathname.split('/')[3];
      const body = await parseBody(req);

      const stages = ['draft', 'review', 'edited', 'approved', 'scheduled', 'published'];
      const content = readJSON('content.json');
      const idx = content.findIndex(c => c.id === id);
      if (idx === -1) return json(res, { error: 'content not found' }, 404);

      const currentStage = content[idx].workflow_stage || content[idx].status || 'review';
      const currentIdx = stages.indexOf(currentStage);

      let nextStage;
      if (body.stage) {
        nextStage = body.stage;
      } else {
        nextStage = stages[Math.min(currentIdx + 1, stages.length - 1)];
      }

      if (!stages.includes(nextStage)) return json(res, { error: 'invalid stage' }, 400);

      // Update workflow
      if (!content[idx].workflow_history) content[idx].workflow_history = [];
      content[idx].workflow_history.push({
        from: currentStage,
        to: nextStage,
        timestamp: now(),
        note: body.note || ''
      });
      content[idx].workflow_stage = nextStage;

      // Also update status for backward compatibility
      if (nextStage === 'approved') content[idx].status = 'approved';
      if (nextStage === 'published') { content[idx].status = 'published'; content[idx].published_at = now(); }

      writeJSON('content.json', content);
      return json(res, { ok: true, stage: nextStage, previous: currentStage });
    }

    // POST /api/content/:id/add-review-note — add a review/feedback note
    if (pathname.match(/^\/api\/content\/[^/]+\/add-review-note$/) && method === 'POST') {
      const id = pathname.split('/')[3];
      const body = await parseBody(req);
      if (!body.note) return json(res, { error: 'note required' }, 400);

      const content = readJSON('content.json');
      const idx = content.findIndex(c => c.id === id);
      if (idx === -1) return json(res, { error: 'content not found' }, 404);

      if (!content[idx].review_notes) content[idx].review_notes = [];
      content[idx].review_notes.push({
        note: body.note,
        author: body.author || 'reviewer',
        timestamp: now()
      });
      writeJSON('content.json', content);
      return json(res, { ok: true, notes: content[idx].review_notes });
    }

    // GET /api/workflow/pipeline — get pipeline view with stage counts
    if (pathname === '/api/workflow/pipeline' && method === 'GET') {
      const content = readJSON('content.json');
      const stages = ['draft', 'review', 'edited', 'approved', 'scheduled', 'published'];
      const pipeline = {};
      for (const stage of stages) {
        pipeline[stage] = content.filter(c => (c.workflow_stage || c.status) === stage).length;
      }
      // Map old statuses
      if (!pipeline.draft) pipeline.draft = 0;
      pipeline.total = content.length;
      return json(res, pipeline);
    }

    // --- Content Quality Auto-Scorer ---

    // POST /api/content/:id/quality-check — AI quality check before publishing
    if (pathname.match(/^\/api\/content\/[^/]+\/quality-check$/) && method === 'POST') {
      const id = pathname.split('/')[3];
      const body = await parseBody(req);
      const platform = body.platform || 'linkedin';

      const content = readJSON('content.json');
      const item = content.find(c => c.id === id);
      if (!item) return json(res, { error: 'content not found' }, 404);

      const contentText = typeof item.formats?.[platform]?.content === 'string'
        ? item.formats[platform].content : '';
      if (!contentText) return json(res, { error: 'no content for this platform' }, 400);

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const prompt = `Perform a quality check on this ${platform} post for a legal marketing agency (Mortar Metrics):

POST:
${contentText.slice(0, 2000)}

Score each dimension 0-20 and give pass/fail:

1. Brand Voice (0-20): Data-driven? Direct, not fluffy? Speaks to law firm owners? Avoids generic marketing speak?
2. Grammar & Clarity (0-20): Clean writing? No awkward phrasing? Clear sentence structure?
3. Hook Quality (0-20): First line stops the scroll? Specific? Creates curiosity or emotion?
4. CTA Presence (0-20): Has a clear next step? Comment trigger, link, question? Reader knows what to do?
5. Format & Length (0-20): Appropriate for ${platform}? Good use of line breaks, lists, or structure?

Return JSON:
{
  "quality_score": 0-100,
  "pass": true/false (pass if >= 65),
  "brand_voice": { "score": N, "pass": bool, "feedback": "..." },
  "grammar_clarity": { "score": N, "pass": bool, "feedback": "..." },
  "hook_quality": { "score": N, "pass": bool, "feedback": "..." },
  "cta_presence": { "score": N, "pass": bool, "feedback": "..." },
  "format_length": { "score": N, "pass": bool, "feedback": "..." },
  "issues": ["critical issues that must be fixed"],
  "suggestions": ["nice-to-have improvements"]
}`;

      let text, parsed;
      try {
        text = await callClaude({ model: HAIKU, system: 'Content quality auditor. Be strict and specific. Always respond with valid JSON only.', prompt, maxTokens: 1000 });
        parsed = parseJsonResponse(text);
      } catch (err) {
        return json(res, { error: 'Claude API error: ' + err.message }, 500);
      }

      if (parsed) {
        const allContent = readJSON('content.json');
        const idx = allContent.findIndex(c => c.id === id);
        if (idx !== -1) {
          if (!allContent[idx].quality_checks) allContent[idx].quality_checks = {};
          allContent[idx].quality_checks[platform] = { ...parsed, checked_at: now() };
          writeJSON('content.json', allContent);
        }
        return json(res, { ok: true, ...parsed });
      }
      return json(res, { error: 'Failed to parse quality check', raw_preview: (text || '').slice(0, 300) }, 500);
    }

    // POST /api/content/batch-quality-check — quality check all approved content
    if (pathname === '/api/content/batch-quality-check' && method === 'POST') {
      const content = readJSON('content.json');
      const toCheck = content.filter(c => c.status === 'approved' && !c.quality_checks?.linkedin);
      let checked = 0, passed = 0;

      for (const item of toCheck.slice(0, 10)) {
        try {
          const contentText = typeof item.formats?.linkedin?.content === 'string'
            ? item.formats.linkedin.content : '';
          if (!contentText) continue;

          const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
          const prompt = `Quality check this LinkedIn post (legal marketing agency). Score 0-100 across brand voice, grammar, hook, CTA, format. Return JSON: { "quality_score": N, "pass": bool, "brand_voice": { "score": N }, "grammar_clarity": { "score": N }, "hook_quality": { "score": N }, "cta_presence": { "score": N }, "format_length": { "score": N }, "issues": [] }

POST: "${contentText.slice(0, 800)}"`;

          const text = await callClaude({ model: HAIKU, system: 'Content quality auditor. Respond with JSON only.', prompt, maxTokens: 600 });
          const parsed = parseJsonResponse(text);

          if (parsed) {
            const allContent = readJSON('content.json');
            const idx = allContent.findIndex(c => c.id === item.id);
            if (idx !== -1) {
              if (!allContent[idx].quality_checks) allContent[idx].quality_checks = {};
              allContent[idx].quality_checks.linkedin = { ...parsed, checked_at: now() };
              writeJSON('content.json', allContent);
              checked++;
              if (parsed.pass) passed++;
            }
          }
        } catch (e) { /* skip */ }
      }
      return json(res, { ok: true, checked, passed, failed: checked - passed, total_unchecked: toCheck.length });
    }

    // --- Repurposing Matrix + Cross-Platform Analytics ---

    // GET /api/content/:id/repurpose-matrix — show platform coverage and gaps
    if (pathname.match(/^\/api\/content\/[^/]+\/repurpose-matrix$/) && method === 'GET') {
      const id = pathname.split('/')[3];
      const content = readJSON('content.json');
      const item = content.find(c => c.id === id);
      if (!item) return json(res, { error: 'content not found' }, 404);

      const allPlatforms = ['linkedin', 'x_single', 'x_thread', 'short_video', 'carousel', 'blog', 'newsletter', 'youtube_script', 'case_study', 'lead_magnet'];
      const matrix = allPlatforms.map(p => ({
        platform: p,
        has_content: !!(item.formats?.[p]?.content),
        content_length: typeof item.formats?.[p]?.content === 'string' ? item.formats[p].content.length : 0,
        has_hashtags: !!(item.hashtags?.[p]),
        has_optimized: !!(item.formats?.[p]?.optimized),
        has_viral_score: !!(item.viral_scores?.[p]),
        has_quality_check: !!(item.quality_checks?.[p]),
        engagement: item.engagement?.[p] || null
      }));

      const queue = readJSON('schedule-queue.json', []);
      for (const m of matrix) {
        m.scheduled = queue.some(q => q.content_id === id && q.platform === m.platform && q.status === 'scheduled');
      }

      return json(res, { content_id: id, title: item.trigger_title, matrix, coverage: `${matrix.filter(m => m.has_content).length}/${allPlatforms.length}`, gaps: matrix.filter(m => !m.has_content).map(m => m.platform) });
    }

    // GET /api/analytics/cross-platform — compare performance across platforms
    if (pathname === '/api/analytics/cross-platform' && method === 'GET') {
      const content = readJSON('content.json');

      const platforms = {};
      for (const item of content) {
        for (const [fmt, data] of Object.entries(item.formats || {})) {
          if (!data?.content) continue;
          if (!platforms[fmt]) platforms[fmt] = { content_count: 0, total_length: 0, with_engagement: 0, total_engagement: 0, total_impressions: 0 };
          platforms[fmt].content_count++;
          platforms[fmt].total_length += typeof data.content === 'string' ? data.content.length : 0;
          if (item.engagement?.[fmt]) {
            platforms[fmt].with_engagement++;
            platforms[fmt].total_engagement += item.engagement[fmt].engagement || 0;
            platforms[fmt].total_impressions += item.engagement[fmt].impressions || 0;
          }
        }
      }

      for (const p of Object.values(platforms)) {
        p.avg_length = p.content_count > 0 ? Math.round(p.total_length / p.content_count) : 0;
        p.engagement_rate = p.total_impressions > 0 ? (p.total_engagement / p.total_impressions * 100).toFixed(2) : '0.00';
      }

      return json(res, { platforms, total_content: content.length });
    }

    // --- Audience Persona Targeting ---

    // GET /api/personas — list all personas
    if (pathname === '/api/personas' && method === 'GET') {
      const defaults = [
        { id: 'pi-attorney', name: 'PI Attorney', title: 'Personal Injury Attorney', firm_size: '2-15 attorneys', budget: '$5K-$25K/mo', pain_points: ['Rising Google Ads costs', 'Low-quality leads', 'Competing against mass tort firms'], goals: ['More signed cases', 'Better cost per case', 'Reviews & reputation'], tone: 'results-driven, ROI-focused, skeptical of agencies' },
        { id: 'family-law', name: 'Family Law Partner', title: 'Family Law Managing Partner', firm_size: '1-8 attorneys', budget: '$2K-$10K/mo', pain_points: ['Emotional clients hard to convert online', 'Seasonal fluctuations', 'Low avg case value'], goals: ['Consistent lead flow', 'Higher-value cases', 'Community authority'], tone: 'empathetic, trust-building, community-focused' },
        { id: 'criminal-defense', name: 'Criminal Defense Solo', title: 'Solo Criminal Defense Attorney', firm_size: '1-3 attorneys', budget: '$1K-$8K/mo', pain_points: ['Urgent need for leads', 'Reputation management', 'Public defender competition'], goals: ['24/7 lead capture', 'Fast intake', 'DUI niche dominance'], tone: 'urgent, direct, no-BS' },
        { id: 'estate-planning', name: 'Estate Planning Firm', title: 'Estate Planning Attorney', firm_size: '1-5 attorneys', budget: '$2K-$8K/mo', pain_points: ['Long sales cycle', 'DIY legal service competition', 'Difficulty showing urgency'], goals: ['Educational trust content', 'Seminar attendance', 'Referral growth'], tone: 'educational, authoritative, patient' },
        { id: 'multi-practice', name: 'Multi-Practice Firm', title: 'Managing Partner', firm_size: '5-30 attorneys', budget: '$10K-$50K/mo', pain_points: ['Unified brand across practices', 'Attribution across campaigns', 'Partner buy-in'], goals: ['Practice area-specific leads', 'Centralized dashboard', 'Scalable growth'], tone: 'strategic, data-heavy, executive-level' }
      ];
      const fs = require('fs'), path = require('path');
      const personasPath = path.join(__dirname, 'data', 'personas.json');
      if (!fs.existsSync(personasPath)) { writeJSON('personas.json', defaults); }
      const personas = readJSON('personas.json', defaults);
      return json(res, personas);
    }

    // POST /api/personas — add a custom persona
    if (pathname === '/api/personas' && method === 'POST') {
      const body = await parseBody(req);
      if (!body.name) return json(res, { error: 'name required' }, 400);
      const personas = readJSON('personas.json', []);
      const persona = { id: generateId(), name: body.name, title: body.title || '', firm_size: body.firm_size || '', budget: body.budget || '', pain_points: body.pain_points || [], goals: body.goals || [], tone: body.tone || '', created_at: now() };
      personas.push(persona);
      writeJSON('personas.json', personas);
      return json(res, { ok: true, persona });
    }

    // POST /api/content/:id/target-persona — AI adapts content for a specific persona
    if (pathname.match(/^\/api\/content\/[^/]+\/target-persona$/) && method === 'POST') {
      const id = pathname.split('/')[3];
      const body = await parseBody(req);
      if (!body.persona_id) return json(res, { error: 'persona_id required' }, 400);
      const platform = body.platform || 'linkedin';

      const content = readJSON('content.json');
      const item = content.find(c => c.id === id);
      if (!item) return json(res, { error: 'content not found' }, 404);

      const personas = readJSON('personas.json', []);
      const persona = personas.find(p => p.id === body.persona_id);
      if (!persona) return json(res, { error: 'persona not found' }, 404);

      const contentText = typeof item.formats?.[platform]?.content === 'string' ? item.formats[platform].content : '';
      if (!contentText) return json(res, { error: 'no content for this platform' }, 400);

      const { callClaude, HAIKU } = require('./lib/claude');
      const prompt = `Rewrite this ${platform} post targeting: ${persona.name} — ${persona.title}
Firm: ${persona.firm_size} | Budget: ${persona.budget}
Pain points: ${(persona.pain_points || []).join(', ')}
Goals: ${(persona.goals || []).join(', ')}
Tone: ${persona.tone}

ORIGINAL: ${contentText.slice(0, 2000)}

Keep same core message. Adjust language, examples, pain points for this persona. Return ONLY the rewritten content.`;

      const adapted = await callClaude({ model: HAIKU, system: 'Content personalization expert for legal marketing.', prompt, maxTokens: 1500 });

      if (adapted) {
        const allContent = readJSON('content.json');
        const idx = allContent.findIndex(c => c.id === id);
        if (idx !== -1) {
          if (!allContent[idx].persona_versions) allContent[idx].persona_versions = {};
          allContent[idx].persona_versions[persona.id] = { platform, persona_name: persona.name, content: adapted.trim(), created_at: now() };
          writeJSON('content.json', allContent);
        }
      }
      return json(res, { ok: true, persona: persona.name, adapted: adapted?.trim(), platform });
    }

    // --- Enhanced Calendar ---

    // GET /api/calendar/week — week view with scheduled posts by platform
    if (pathname === '/api/calendar/week' && method === 'GET') {
      const queue = readJSON('schedule-queue.json', []);
      const weekParam = url.searchParams.get('week');

      const startOfWeek = weekParam ? new Date(weekParam) : (() => { const d = new Date(); d.setDate(d.getDate() - d.getDay() + 1); return d; })();
      const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      const days = [];

      for (let i = 0; i < 7; i++) {
        const day = new Date(startOfWeek);
        day.setDate(startOfWeek.getDate() + i);
        const dateStr = day.toISOString().slice(0, 10);
        const scheduled = queue.filter(q => q.scheduled_at?.slice(0, 10) === dateStr && q.status === 'scheduled');
        days.push({
          date: dateStr, day_name: dayNames[i],
          posts: scheduled.map(s => ({ id: s.id, content_id: s.content_id, platform: s.platform, time: s.scheduled_at?.slice(11, 16), title: s.trigger_title })),
          count: scheduled.length
        });
      }

      return json(res, {
        week_start: startOfWeek.toISOString().slice(0, 10), days,
        total_posts: days.reduce((s, d) => s + d.count, 0),
        gaps: days.filter(d => d.count === 0).map(d => d.day_name)
      });
    }

    // POST /api/calendar/suggest — AI suggests posts to fill calendar gaps
    if (pathname === '/api/calendar/suggest' && method === 'POST') {
      const queue = readJSON('schedule-queue.json', []);
      const content = readJSON('content.json');
      const unscheduled = content.filter(c => c.status === 'approved' && !queue.some(q => q.content_id === c.id && q.status === 'scheduled'));

      if (unscheduled.length === 0) return json(res, { ok: true, suggestions: [], message: 'No approved content to schedule' });

      const today = new Date();
      const suggestions = [];
      const slots = [
        { day: 1, platform: 'linkedin', time: '09:00' }, { day: 2, platform: 'x_single', time: '12:00' },
        { day: 3, platform: 'linkedin', time: '09:30' }, { day: 4, platform: 'x_thread', time: '08:30' },
        { day: 5, platform: 'linkedin', time: '09:00' }, { day: 5, platform: 'short_video', time: '12:00' }
      ];

      for (const slot of slots) {
        const d = new Date(today);
        d.setDate(d.getDate() + ((slot.day - d.getDay() + 7) % 7 || 7));
        const dateStr = d.toISOString().slice(0, 10);
        if (queue.find(q => q.scheduled_at?.slice(0, 10) === dateStr && q.platform === slot.platform && q.status === 'scheduled')) continue;
        const match = unscheduled.find(c => c.formats?.[slot.platform]?.content);
        if (match) suggestions.push({ content_id: match.id, title: match.trigger_title, platform: slot.platform, date: dateStr, time: slot.time });
      }

      return json(res, { ok: true, suggestions });
    }

    // POST /api/calendar/apply-suggestions — schedule all suggested posts
    if (pathname === '/api/calendar/apply-suggestions' && method === 'POST') {
      const body = await parseBody(req);
      const suggestions = body.suggestions || [];
      const queue = readJSON('schedule-queue.json', []);
      let applied = 0;
      for (const s of suggestions) {
        queue.push({ id: generateId(), content_id: s.content_id, trigger_title: s.title, platform: s.platform, format: s.platform, scheduled_at: `${s.date}T${s.time}:00.000Z`, status: 'scheduled', notes: 'AI suggested', created_at: now() });
        applied++;
      }
      writeJSON('schedule-queue.json', queue);
      return json(res, { ok: true, applied });
    }

    // --- Performance Benchmarks ---

    // GET /api/benchmarks — get current performance benchmarks
    if (pathname === '/api/benchmarks' && method === 'GET') {
      const benchmarks = readJSON('benchmarks.json', {
        linkedin: { impressions: 500, engagement: 25, engagement_rate: 5.0, clicks: 10, shares: 3 },
        x_single: { impressions: 200, engagement: 10, engagement_rate: 5.0, clicks: 5 },
        x_thread: { impressions: 300, engagement: 15, engagement_rate: 5.0, clicks: 8 },
        carousel: { impressions: 400, engagement: 30, engagement_rate: 7.5, clicks: 12 },
        short_video: { impressions: 1000, engagement: 50, engagement_rate: 5.0, clicks: 20 }
      });
      return json(res, benchmarks);
    }

    // POST /api/benchmarks/set — update benchmarks
    if (pathname === '/api/benchmarks/set' && method === 'POST') {
      const body = await parseBody(req);
      const benchmarks = readJSON('benchmarks.json', {});
      Object.assign(benchmarks, body);
      benchmarks.updated_at = now();
      writeJSON('benchmarks.json', benchmarks);
      return json(res, { ok: true, benchmarks });
    }

    // GET /api/benchmarks/report — compare all tracked content against benchmarks
    if (pathname === '/api/benchmarks/report' && method === 'GET') {
      const benchmarks = readJSON('benchmarks.json', { linkedin: { impressions: 500, engagement: 25, engagement_rate: 5.0 } });
      const content = readJSON('content.json');
      const tracked = content.filter(c => c.engagement && Object.keys(c.engagement).length > 0);

      const overperformers = [];
      const underperformers = [];

      for (const item of tracked) {
        for (const [platform, eng] of Object.entries(item.engagement)) {
          const bench = benchmarks[platform];
          if (!bench) continue;
          const score = ((eng.impressions || 0) / (bench.impressions || 500) + (eng.engagement || 0) / (bench.engagement || 25)) / 2 * 100;
          const entry = { id: item.id, title: item.trigger_title, platform, engagement: eng, benchmark: bench, score: Math.round(score) };
          if (score >= 120) overperformers.push(entry);
          if (score < 80) underperformers.push(entry);
        }
      }

      return json(res, {
        total_tracked: tracked.length,
        overperformers: overperformers.sort((a, b) => b.score - a.score),
        underperformers: underperformers.sort((a, b) => a.score - b.score),
        summary: { over: overperformers.length, under: underperformers.length, on_track: tracked.length - overperformers.length - underperformers.length }
      });
    }

    // --- Content Idea Generator ---

    // POST /api/ideas/generate — AI generates content ideas based on gaps and trends
    if (pathname === '/api/ideas/generate' && method === 'POST') {
      const content = readJSON('content.json');
      const triggers = readJSON('trigger-queue.json');
      const trending = readJSON('trending-topics.json', {});

      // Build context
      const recentTopics = content.slice(-20).map(c => c.trigger_title).join(', ');
      const topTrending = (trending.trending_topics || []).slice(0, 5).map(t => t.topic).join(', ');
      const categories = {};
      for (const t of triggers.slice(-50)) { categories[t.category || 'unknown'] = (categories[t.category || 'unknown'] || 0) + 1; }

      const { callClaude, parseJsonResponse, SONNET } = require('./lib/claude');
      const prompt = `Generate 10 content ideas for a legal marketing agency (Mortar Metrics) that targets law firm owners.

RECENT CONTENT TOPICS: ${recentTopics.slice(0, 500) || 'None yet'}
TRENDING: ${topTrending || 'General legal marketing trends'}
CONTENT CATEGORIES COVERED: ${JSON.stringify(categories)}

Generate ideas that:
1. Fill content gaps (topics NOT recently covered)
2. Capitalize on trending topics
3. Address different audience personas (PI, family law, criminal defense, estate planning)
4. Mix formats (data-driven posts, stories, contrarian takes, frameworks, case studies)

Return JSON:
{
  "ideas": [
    {
      "title": "...",
      "angle": "unique perspective or hook",
      "category": "pain_point|data_point|case_study|framework|contrarian|trend|question",
      "target_persona": "pi-attorney|family-law|criminal-defense|estate-planning|multi-practice|all",
      "recommended_formats": ["linkedin", "x_thread", "blog"],
      "priority": "high|medium|low",
      "reasoning": "why this idea will perform well"
    }
  ]
}`;

      let text, parsed;
      try {
        text = await callClaude({ model: SONNET, system: 'Content strategist for B2B legal marketing. Generate creative, specific, actionable content ideas.', prompt, maxTokens: 2000 });
        parsed = parseJsonResponse(text);
      } catch (err) {
        return json(res, { error: 'Claude API error: ' + err.message }, 500);
      }

      if (parsed?.ideas) {
        const ideas = readJSON('content-ideas.json', []);
        const newIdeas = parsed.ideas.map(idea => ({
          id: generateId(),
          ...idea,
          status: 'new', // new, saved, promoted, dismissed
          created_at: now()
        }));
        ideas.push(...newIdeas);
        writeJSON('content-ideas.json', ideas);
        return json(res, { ok: true, ideas: newIdeas, total: ideas.length });
      }
      return json(res, { error: 'Failed to generate ideas', raw_preview: (text || '').slice(0, 200) }, 500);
    }

    // GET /api/ideas — list all content ideas
    if (pathname === '/api/ideas' && method === 'GET') {
      const ideas = readJSON('content-ideas.json', []);
      return json(res, ideas);
    }

    // POST /api/ideas/:id/promote — convert idea to a trigger
    if (pathname.match(/^\/api\/ideas\/[^/]+\/promote$/) && method === 'POST') {
      const id = pathname.split('/')[3];
      const ideas = readJSON('content-ideas.json', []);
      const idx = ideas.findIndex(i => i.id === id);
      if (idx === -1) return json(res, { error: 'idea not found' }, 404);

      const idea = ideas[idx];
      ideas[idx].status = 'promoted';
      writeJSON('content-ideas.json', ideas);

      // Create trigger from idea
      const triggers = readJSON('trigger-queue.json');
      const trigger = {
        id: 'idea-' + generateId(),
        title: idea.title,
        source: 'content-ideas',
        source_detail: idea.angle,
        category: idea.category || 'pain_point',
        summary: idea.reasoning,
        score: idea.priority === 'high' ? 16 : idea.priority === 'medium' ? 12 : 8,
        status: 'pending',
        captured_at: now()
      };
      triggers.push(trigger);
      writeJSON('trigger-queue.json', triggers);

      return json(res, { ok: true, trigger });
    }

    // DELETE /api/ideas/:id — dismiss an idea
    if (pathname.match(/^\/api\/ideas\/[^/]+$/) && method === 'DELETE') {
      const id = pathname.split('/')[3];
      const ideas = readJSON('content-ideas.json', []);
      const idx = ideas.findIndex(i => i.id === id);
      if (idx === -1) return json(res, { error: 'not found' }, 404);
      ideas[idx].status = 'dismissed';
      writeJSON('content-ideas.json', ideas);
      return json(res, { ok: true });
    }

    // === Batch 43: Content Repurposing Chains + Social Proof + Content ROI ===

    // POST /api/content/:id/chain-repurpose — auto-generate all missing platform versions
    if (pathname.match(/^\/api\/content\/[^/]+\/chain-repurpose$/) && method === 'POST') {
      const id = pathname.split('/')[3];
      const content = readJSON('content.json', []);
      const item = content.find(c => c.id === id);
      if (!item) return json(res, { error: 'not found' }, 404);

      const allFormats = ['linkedin', 'x_single', 'x_thread', 'carousel', 'short_video', 'hot_take', 'poll'];
      const existing = Object.keys(item.formats || {});
      const missing = allFormats.filter(f => !existing.includes(f));

      if (missing.length === 0) return json(res, { ok: true, message: 'All formats already exist', generated: 0 });

      // Find best source content (prefer linkedin > blog > any)
      let sourceFormat = existing.find(f => f === 'linkedin') || existing.find(f => f === 'blog') || existing[0];
      let sourceContent = item.formats[sourceFormat]?.content;
      if (!sourceContent) return json(res, { error: 'No source content found to repurpose' }, 400);

      const { repurposeContent } = require('./lib/claude.js');
      const { BRAND_SYSTEM_PROMPT } = require('./generator/content-writer.js');
      const system = BRAND_SYSTEM_PROMPT;
      const results = [];

      for (const targetFormat of missing) {
        try {
          const repurposed = await repurposeContent(sourceContent, sourceFormat, targetFormat, system);
          if (!item.formats) item.formats = {};
          item.formats[targetFormat] = {
            content: repurposed,
            status: 'draft',
            generated_at: now(),
            source_chain: { from_format: sourceFormat, chain_type: 'auto-repurpose' }
          };
          results.push({ format: targetFormat, ok: true });
        } catch (err) {
          results.push({ format: targetFormat, ok: false, error: err.message });
        }
      }

      writeJSON('content.json', content);
      return json(res, { ok: true, generated: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results });
    }

    // GET /api/content/:id/chain-status — see repurpose coverage
    if (pathname.match(/^\/api\/content\/[^/]+\/chain-status$/) && method === 'GET') {
      const id = pathname.split('/')[3];
      const content = readJSON('content.json', []);
      const item = content.find(c => c.id === id);
      if (!item) return json(res, { error: 'not found' }, 404);

      const allFormats = ['linkedin', 'x_single', 'x_thread', 'carousel', 'short_video', 'hot_take', 'poll', 'blog', 'youtube_script', 'newsletter'];
      const coverage = {};
      for (const f of allFormats) {
        coverage[f] = item.formats?.[f] ? { exists: true, status: item.formats[f].status, chain: item.formats[f].source_chain || null } : { exists: false };
      }
      const total = allFormats.length;
      const covered = allFormats.filter(f => item.formats?.[f]).length;
      return json(res, { coverage, covered, total, percentage: Math.round((covered / total) * 100) });
    }

    // --- Social Proof Tracker ---

    // GET /api/social-proof — list all proof elements
    if (pathname === '/api/social-proof' && method === 'GET') {
      return json(res, readJSON('social-proof.json', []));
    }

    // POST /api/social-proof — add a proof element
    if (pathname === '/api/social-proof' && method === 'POST') {
      const body = await parseBody(req);
      const proof = readJSON('social-proof.json', []);
      const entry = {
        id: generateId(),
        type: body.type || 'testimonial', // testimonial, case_metric, social_mention, review, award
        client_name: body.client_name || '',
        content: body.content || '',
        metric_value: body.metric_value || null, // e.g. "300% ROI", "+45 leads/month"
        metric_label: body.metric_label || null,
        platform: body.platform || null, // where it came from
        url: body.url || null,
        tags: body.tags || [],
        verified: body.verified || false,
        used_in: [], // content IDs where this proof was used
        created_at: now()
      };
      proof.push(entry);
      writeJSON('social-proof.json', proof);
      return json(res, { ok: true, proof: entry });
    }

    // PUT /api/social-proof/:id — update a proof element
    if (pathname.match(/^\/api\/social-proof\/[^/]+$/) && method === 'PUT') {
      const id = pathname.split('/')[3];
      const body = await parseBody(req);
      const proof = readJSON('social-proof.json', []);
      const idx = proof.findIndex(p => p.id === id);
      if (idx === -1) return json(res, { error: 'not found' }, 404);
      Object.assign(proof[idx], body, { updated_at: now() });
      writeJSON('social-proof.json', proof);
      return json(res, { ok: true, proof: proof[idx] });
    }

    // DELETE /api/social-proof/:id
    if (pathname.match(/^\/api\/social-proof\/[^/]+$/) && method === 'DELETE') {
      const id = pathname.split('/')[3];
      const proof = readJSON('social-proof.json', []);
      const filtered = proof.filter(p => p.id !== id);
      writeJSON('social-proof.json', filtered);
      return json(res, { ok: true });
    }

    // POST /api/social-proof/auto-extract — AI extract proof from meeting/content
    if (pathname === '/api/social-proof/auto-extract' && method === 'POST') {
      const body = await parseBody(req);
      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude.js');
      const sourceText = body.text || body.content || '';
      if (!sourceText) return json(res, { error: 'Provide text or content to extract from' }, 400);

      const text = await callClaude({
        model: HAIKU,
        system: 'You extract social proof elements from text. Return JSON array.',
        prompt: `Extract testimonials, case study metrics, success stories, and social proof from this text.

TEXT:
${sourceText.slice(0, 4000)}

Return JSON array of objects with: type (testimonial|case_metric|social_mention), client_name, content (the proof statement), metric_value (if applicable), metric_label (if applicable).
Only return elements that are genuine social proof — client wins, results, praise. Skip generic statements.`,
        maxTokens: 1500
      });

      const extracted = parseJsonResponse(text) || [];
      const proof = readJSON('social-proof.json', []);
      const added = [];
      for (const item of extracted) {
        const entry = { id: generateId(), ...item, verified: false, used_in: [], auto_extracted: true, created_at: now() };
        proof.push(entry);
        added.push(entry);
      }
      writeJSON('social-proof.json', proof);
      return json(res, { ok: true, extracted: added.length, items: added });
    }

    // --- Content ROI Calculator ---

    // POST /api/content/:id/attribute-lead — attribute a lead/revenue to content
    if (pathname.match(/^\/api\/content\/[^/]+\/attribute-lead$/) && method === 'POST') {
      const id = pathname.split('/')[3];
      const body = await parseBody(req);
      const roi = readJSON('content-roi.json', []);
      const entry = {
        id: generateId(),
        content_id: id,
        lead_name: body.lead_name || '',
        lead_email: body.lead_email || '',
        attribution_type: body.type || 'direct', // direct, assisted, influenced
        revenue: body.revenue || 0,
        source_platform: body.platform || '',
        notes: body.notes || '',
        created_at: now()
      };
      roi.push(entry);
      writeJSON('content-roi.json', roi);
      return json(res, { ok: true, attribution: entry });
    }

    // GET /api/roi/report — ROI report across all content
    if (pathname === '/api/roi/report' && method === 'GET') {
      const roi = readJSON('content-roi.json', []);
      const content = readJSON('content.json', []);

      // Group by content_id
      const byContent = {};
      for (const r of roi) {
        if (!byContent[r.content_id]) byContent[r.content_id] = { leads: 0, revenue: 0, attributions: [] };
        byContent[r.content_id].leads++;
        byContent[r.content_id].revenue += (r.revenue || 0);
        byContent[r.content_id].attributions.push(r);
      }

      // By platform
      const byPlatform = {};
      for (const r of roi) {
        const p = r.source_platform || 'unknown';
        if (!byPlatform[p]) byPlatform[p] = { leads: 0, revenue: 0 };
        byPlatform[p].leads++;
        byPlatform[p].revenue += (r.revenue || 0);
      }

      // Top content by ROI
      const topContent = Object.entries(byContent)
        .map(([contentId, data]) => {
          const item = content.find(c => c.id === contentId);
          return { content_id: contentId, title: item?.trigger_title || 'Unknown', ...data };
        })
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 10);

      return json(res, {
        total_attributions: roi.length,
        total_leads: roi.length,
        total_revenue: roi.reduce((s, r) => s + (r.revenue || 0), 0),
        by_platform: byPlatform,
        top_content: topContent,
        by_type: {
          direct: roi.filter(r => r.attribution_type === 'direct').length,
          assisted: roi.filter(r => r.attribution_type === 'assisted').length,
          influenced: roi.filter(r => r.attribution_type === 'influenced').length
        }
      });
    }

    // GET /api/roi/content/:id — ROI for specific content
    if (pathname.match(/^\/api\/roi\/content\/[^/]+$/) && method === 'GET') {
      const id = pathname.split('/')[4];
      const roi = readJSON('content-roi.json', []);
      const attributions = roi.filter(r => r.content_id === id);
      return json(res, {
        content_id: id,
        total_leads: attributions.length,
        total_revenue: attributions.reduce((s, r) => s + (r.revenue || 0), 0),
        attributions
      });
    }

    // === Batch 44: Distribution Planner + Audience Growth + Theme Clustering ===

    // POST /api/content/:id/distribution-plan — AI creates optimal distribution plan
    if (pathname.match(/^\/api\/content\/[^/]+\/distribution-plan$/) && method === 'POST') {
      const id = pathname.split('/')[3];
      const content = readJSON('content.json', []);
      const item = content.find(c => c.id === id);
      if (!item) return json(res, { error: 'not found' }, 404);

      const formats = Object.keys(item.formats || {}).filter(f => item.formats[f]?.content);
      if (formats.length === 0) return json(res, { error: 'No content formats generated yet' }, 400);

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude.js');
      let text, parsed;
      try {
        text = await callClaude({
          model: HAIKU,
          system: 'You are a social media distribution strategist. Return JSON only.',
          prompt: `Create an optimal 7-day distribution plan for this content across platforms.

CONTENT TITLE: ${item.trigger_title}
AVAILABLE FORMATS: ${formats.join(', ')}

Create a day-by-day plan with:
- Which format to post on which day
- Optimal time (EST)
- Cross-promotion notes (e.g., "tease the blog in LinkedIn post")
- Engagement strategy (e.g., "respond to comments within 1 hour")

Return JSON: {
  "plan": [{ "day": 1, "day_name": "Mon", "posts": [{ "platform": "linkedin", "format": "linkedin", "time": "08:30", "caption_note": "...", "cross_promote": "..." }] }],
  "strategy_notes": ["..."],
  "expected_reach": "estimate",
  "key_cta": "primary call to action"
}`,
          maxTokens: 2000
        });
        parsed = parseJsonResponse(text);
      } catch (err) {
        return json(res, { error: 'AI error: ' + err.message }, 500);
      }
      if (!parsed) return json(res, { error: 'Failed to generate plan', raw_preview: (text || '').slice(0, 200) }, 500);

      // Save the plan
      const plans = readJSON('distribution-plans.json', []);
      const plan = { id: generateId(), content_id: id, title: item.trigger_title, ...parsed, created_at: now() };
      plans.push(plan);
      writeJSON('distribution-plans.json', plans);

      return json(res, { ok: true, plan });
    }

    // GET /api/distribution-plans — list all distribution plans
    if (pathname === '/api/distribution-plans' && method === 'GET') {
      return json(res, readJSON('distribution-plans.json', []));
    }

    // POST /api/distribution-plans/:id/execute — schedule all posts from a plan
    if (pathname.match(/^\/api\/distribution-plans\/[^/]+\/execute$/) && method === 'POST') {
      const planId = pathname.split('/')[3];
      const plans = readJSON('distribution-plans.json', []);
      const plan = plans.find(p => p.id === planId);
      if (!plan) return json(res, { error: 'not found' }, 404);

      const schedule = readJSON('schedule-queue.json', []);
      let scheduled = 0;
      const today = new Date();

      for (const day of (plan.plan || [])) {
        for (const post of (day.posts || [])) {
          const postDate = new Date(today);
          postDate.setDate(today.getDate() + (day.day - 1));
          const [hours, mins] = (post.time || '09:00').split(':');
          postDate.setHours(parseInt(hours), parseInt(mins), 0, 0);

          schedule.push({
            id: generateId(),
            content_id: plan.content_id,
            trigger_title: plan.title,
            platform: post.platform,
            format: post.format,
            scheduled_at: postDate.toISOString(),
            status: 'scheduled',
            notes: post.caption_note || post.cross_promote || 'From distribution plan',
            plan_id: plan.id,
            created_at: now()
          });
          scheduled++;
        }
      }
      writeJSON('schedule-queue.json', schedule);
      return json(res, { ok: true, scheduled });
    }

    // --- Audience Growth Tracker ---

    // POST /api/audience/snapshot — record current follower counts
    if (pathname === '/api/audience/snapshot' && method === 'POST') {
      const body = await parseBody(req);
      const snapshots = readJSON('audience-growth.json', []);
      const snapshot = {
        id: generateId(),
        date: new Date().toISOString().slice(0, 10),
        linkedin_followers: body.linkedin_followers || 0,
        linkedin_connections: body.linkedin_connections || 0,
        x_followers: body.x_followers || 0,
        youtube_subscribers: body.youtube_subscribers || 0,
        email_subscribers: body.email_subscribers || 0,
        website_visitors: body.website_visitors || 0,
        notes: body.notes || '',
        created_at: now()
      };
      snapshots.push(snapshot);
      writeJSON('audience-growth.json', snapshots);
      return json(res, { ok: true, snapshot });
    }

    // GET /api/audience/growth — growth report
    if (pathname === '/api/audience/growth' && method === 'GET') {
      const snapshots = readJSON('audience-growth.json', []);
      if (snapshots.length === 0) return json(res, { snapshots: [], growth: null, summary: { total_snapshots: 0 } });

      const latest = snapshots[snapshots.length - 1];
      const previous = snapshots.length >= 2 ? snapshots[snapshots.length - 2] : null;

      const growth = {};
      if (previous) {
        for (const key of ['linkedin_followers', 'linkedin_connections', 'x_followers', 'youtube_subscribers', 'email_subscribers', 'website_visitors']) {
          const prev = previous[key] || 0;
          const curr = latest[key] || 0;
          growth[key] = { current: curr, previous: prev, change: curr - prev, change_pct: prev > 0 ? Math.round(((curr - prev) / prev) * 100) : 0 };
        }
      }

      return json(res, {
        snapshots: snapshots.slice(-30),
        latest,
        growth,
        summary: {
          total_snapshots: snapshots.length,
          first_date: snapshots[0].date,
          latest_date: latest.date
        }
      });
    }

    // --- Content Theme Clustering ---

    // POST /api/themes/analyze — AI clusters content into themes
    if (pathname === '/api/themes/analyze' && method === 'POST') {
      const content = readJSON('content.json', []);
      if (content.length < 3) return json(res, { error: 'Need at least 3 content pieces to analyze themes' }, 400);

      const titles = content.slice(0, 50).map(c => `- ${c.trigger_title}`).join('\n');

      const { callClaude, parseJsonResponse, SONNET } = require('./lib/claude.js');
      let text, parsed;
      try {
        text = await callClaude({
          model: SONNET,
          system: 'You are a content strategist analyzing content themes. Return JSON only.',
          prompt: `Analyze these content titles and cluster them into 5-8 themes.

CONTENT TITLES:
${titles}

For each theme, provide:
- name: short theme name (2-4 words)
- description: what this theme covers
- color: hex color for the theme
- content_titles: which titles belong to this theme
- strength: 'strong' (4+ pieces), 'moderate' (2-3), 'weak' (1)
- gap_opportunity: what's missing in this theme area

Return JSON: { "themes": [...], "recommendations": ["..."], "theme_balance": "assessment of theme diversity" }`,
          maxTokens: 2000
        });
        parsed = parseJsonResponse(text);
      } catch (err) {
        return json(res, { error: 'AI error: ' + err.message }, 500);
      }
      if (!parsed) return json(res, { error: 'Failed to analyze themes', raw_preview: (text || '').slice(0, 200) }, 500);

      // Save the analysis
      parsed.analyzed_at = now();
      parsed.content_count = content.length;
      writeJSON('content-themes.json', parsed);

      return json(res, { ok: true, ...parsed });
    }

    // GET /api/themes — get current theme analysis
    if (pathname === '/api/themes' && method === 'GET') {
      return json(res, readJSON('content-themes.json', { themes: [], recommendations: [], analyzed_at: null }));
    }

    // === Batch 45: Content-to-DM Pipeline + Competitor Monitor + Scoring Model ===

    // POST /api/content/:id/generate-dm-sequence — AI creates DM sequence from content
    if (pathname.match(/^\/api\/content\/[^/]+\/generate-dm-sequence$/) && method === 'POST') {
      const id = pathname.split('/')[3];
      const content = readJSON('content.json', []);
      const item = content.find(c => c.id === id);
      if (!item) return json(res, { error: 'not found' }, 404);

      const linkedinContent = item.formats?.linkedin?.content || item.formats?.x_single?.content || Object.values(item.formats || {})[0]?.content || '';
      if (!linkedinContent) return json(res, { error: 'No content to build DM from' }, 400);

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude.js');
      let text, parsed;
      try {
        text = await callClaude({
          model: HAIKU,
          system: 'You create DM outreach sequences for LinkedIn. Return JSON only.',
          prompt: `Create a 3-message DM sequence to send to people who engage with this content.

CONTENT: ${linkedinContent.slice(0, 2000)}
CONTENT TITLE: ${item.trigger_title}

The DM sequence should:
- Message 1: Warm opener referencing their engagement/comment (sent within 2 hours)
- Message 2: Value-add follow-up with a relevant insight or resource (sent 24 hours later)
- Message 3: Soft CTA for a call/audit (sent 48 hours later)

For each message, provide:
- Trigger: what engagement triggers this DM (comment, share, like)
- Template: the DM text with [NAME] and [COMPANY] placeholders
- Timing: when to send relative to engagement
- Goal: what you want to achieve

Return JSON: {
  "sequence_name": "...",
  "target_audience": "...",
  "messages": [{ "step": 1, "trigger": "...", "template": "...", "timing": "...", "goal": "..." }],
  "expected_reply_rate": "estimate"
}`,
          maxTokens: 2000
        });
        parsed = parseJsonResponse(text);
      } catch (err) {
        return json(res, { error: 'AI error: ' + err.message }, 500);
      }
      if (!parsed) return json(res, { error: 'Failed to generate DM sequence', raw_preview: (text || '').slice(0, 200) }, 500);

      const dmPipelines = readJSON('dm-pipelines.json', []);
      const pipeline = {
        id: generateId(),
        content_id: id,
        title: item.trigger_title,
        ...parsed,
        status: 'active',
        stats: { sent: 0, replied: 0, booked: 0 },
        created_at: now()
      };
      dmPipelines.push(pipeline);
      writeJSON('dm-pipelines.json', dmPipelines);
      return json(res, { ok: true, pipeline });
    }

    // GET /api/dm-pipelines — list all DM pipelines
    if (pathname === '/api/dm-pipelines' && method === 'GET') {
      return json(res, readJSON('dm-pipelines.json', []));
    }

    // POST /api/dm-pipelines/:id/track — track DM stats
    if (pathname.match(/^\/api\/dm-pipelines\/[^/]+\/track$/) && method === 'POST') {
      const pipelineId = pathname.split('/')[3];
      const body = await parseBody(req);
      const pipelines = readJSON('dm-pipelines.json', []);
      const pipeline = pipelines.find(p => p.id === pipelineId);
      if (!pipeline) return json(res, { error: 'not found' }, 404);

      if (body.sent) pipeline.stats.sent += body.sent;
      if (body.replied) pipeline.stats.replied += body.replied;
      if (body.booked) pipeline.stats.booked += body.booked;
      pipeline.last_updated = now();
      writeJSON('dm-pipelines.json', pipelines);
      return json(res, { ok: true, stats: pipeline.stats });
    }

    // --- Competitor Content Monitor ---

    // POST /api/competitors/track — add competitor to track
    if (pathname === '/api/competitors/track' && method === 'POST') {
      const body = await parseBody(req);
      if (!body.name) return json(res, { error: 'Competitor name required' }, 400);

      const competitors = readJSON('competitors-tracked.json', []);
      const entry = {
        id: generateId(),
        name: body.name,
        linkedin_url: body.linkedin_url || '',
        website: body.website || '',
        x_handle: body.x_handle || '',
        notes: body.notes || '',
        content_samples: [],
        analysis: null,
        created_at: now()
      };
      competitors.push(entry);
      writeJSON('competitors-tracked.json', competitors);
      return json(res, { ok: true, competitor: entry });
    }

    // GET /api/competitors — list tracked competitors
    if (pathname === '/api/competitors/tracked' && method === 'GET') {
      return json(res, readJSON('competitors-tracked.json', []));
    }

    // POST /api/competitors/:id/add-sample — add content sample from competitor
    if (pathname.match(/^\/api\/competitors\/[^/]+\/add-sample$/) && method === 'POST') {
      const compId = pathname.split('/')[3];
      const body = await parseBody(req);
      const competitors = readJSON('competitors-tracked.json', []);
      const comp = competitors.find(c => c.id === compId);
      if (!comp) return json(res, { error: 'not found' }, 404);

      comp.content_samples.push({
        title: body.title || '',
        content: body.content || '',
        platform: body.platform || 'linkedin',
        url: body.url || '',
        engagement: body.engagement || {},
        added_at: now()
      });
      writeJSON('competitors-tracked.json', competitors);
      return json(res, { ok: true, samples: comp.content_samples.length });
    }

    // POST /api/competitors/:id/analyze — AI analyzes competitor content
    if (pathname.match(/^\/api\/competitors\/[^/]+\/analyze$/) && method === 'POST') {
      const compId = pathname.split('/')[3];
      const competitors = readJSON('competitors-tracked.json', []);
      const comp = competitors.find(c => c.id === compId);
      if (!comp) return json(res, { error: 'not found' }, 404);
      if (comp.content_samples.length < 2) return json(res, { error: 'Need at least 2 content samples to analyze' }, 400);

      const samples = comp.content_samples.slice(0, 10).map(s => `- ${s.title}: ${(s.content || '').slice(0, 200)}`).join('\n');

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude.js');
      let text, parsed;
      try {
        text = await callClaude({
          model: HAIKU,
          system: 'You analyze competitor content strategies. Return JSON only.',
          prompt: `Analyze this competitor's content strategy based on their recent posts.

COMPETITOR: ${comp.name}
CONTENT SAMPLES:
${samples}

Analyze:
1. Content themes and topics
2. Posting frequency and patterns
3. Tone and voice
4. Strengths and weaknesses
5. Opportunities for us to differentiate

Return JSON: {
  "themes": ["..."],
  "posting_frequency": "estimate",
  "tone": "description",
  "strengths": ["..."],
  "weaknesses": ["..."],
  "differentiation_opportunities": ["..."],
  "content_ideas_to_counter": ["..."]
}`,
          maxTokens: 1500
        });
        parsed = parseJsonResponse(text);
      } catch (err) {
        return json(res, { error: 'AI error: ' + err.message }, 500);
      }
      if (!parsed) return json(res, { error: 'Failed to analyze', raw_preview: (text || '').slice(0, 200) }, 500);

      comp.analysis = { ...parsed, analyzed_at: now() };
      writeJSON('competitors-tracked.json', competitors);
      return json(res, { ok: true, analysis: comp.analysis });
    }

    // DELETE /api/competitors/:id
    if (pathname.match(/^\/api\/competitors\/[^/]+$/) && method === 'DELETE') {
      const compId = pathname.split('/')[3];
      const competitors = readJSON('competitors-tracked.json', []);
      writeJSON('competitors-tracked.json', competitors.filter(c => c.id !== compId));
      return json(res, { ok: true });
    }

    // --- Content Scoring Model ---

    // POST /api/content/score-model — build predictive model from engagement data
    if (pathname === '/api/content/score-model' && method === 'POST') {
      const content = readJSON('content.json', []);
      const engagement = readJSON('engagement-tracking.json', []);

      // Find content with engagement data
      const scoredContent = content.filter(c => {
        const eng = engagement.find(e => e.content_id === c.id);
        return eng && Object.values(c.formats || {}).some(f => f.content);
      }).map(c => {
        const eng = engagement.find(e => e.content_id === c.id);
        return {
          title: c.trigger_title,
          formats: Object.keys(c.formats || {}).filter(f => c.formats[f]?.content),
          source: c.source,
          engagement_rate: parseFloat(eng?.engagement_rate || 0),
          impressions: eng?.impressions || 0,
          clicks: eng?.clicks || 0
        };
      });

      if (scoredContent.length < 3) {
        return json(res, { error: 'Need at least 3 content pieces with engagement data to build model' }, 400);
      }

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude.js');
      const data = scoredContent.slice(0, 20).map(c =>
        `- "${c.title}" (${c.source}, formats: ${c.formats.join(',')}) -> ${c.engagement_rate}% rate, ${c.impressions} imp, ${c.clicks} clicks`
      ).join('\n');

      let text, parsed;
      try {
        text = await callClaude({
          model: HAIKU,
          system: 'You analyze content performance data. Return JSON only.',
          prompt: `Analyze this content performance data and create a scoring model.

PERFORMANCE DATA:
${data}

Based on this data, identify:
1. Which content characteristics correlate with high engagement
2. Scoring weights for different factors (topic, format, source, length, hook style)
3. Predictions for what types of content will perform best

Return JSON: {
  "model_version": "v1",
  "factors": [{ "factor": "...", "weight": 0-100, "insight": "..." }],
  "top_performing_patterns": ["..."],
  "underperforming_patterns": ["..."],
  "recommendations": ["..."],
  "confidence": "low|medium|high"
}`,
          maxTokens: 1500
        });
        parsed = parseJsonResponse(text);
      } catch (err) {
        return json(res, { error: 'AI error: ' + err.message }, 500);
      }
      if (!parsed) return json(res, { error: 'Failed to build model', raw_preview: (text || '').slice(0, 200) }, 500);

      parsed.trained_on = scoredContent.length;
      parsed.trained_at = now();
      writeJSON('scoring-model.json', parsed);
      return json(res, { ok: true, model: parsed });
    }

    // GET /api/content/score-model — get current scoring model
    if (pathname === '/api/content/score-model' && method === 'GET') {
      return json(res, readJSON('scoring-model.json', { factors: [], trained_at: null }));
    }

    // POST /api/content/:id/predict-performance — predict performance before publishing
    if (pathname.match(/^\/api\/content\/[^/]+\/predict-performance$/) && method === 'POST') {
      const id = pathname.split('/')[3];
      const content = readJSON('content.json', []);
      const item = content.find(c => c.id === id);
      if (!item) return json(res, { error: 'not found' }, 404);

      const model = readJSON('scoring-model.json', { factors: [] });
      const linkedinContent = item.formats?.linkedin?.content || '';

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude.js');
      let text, parsed;
      try {
        text = await callClaude({
          model: HAIKU,
          system: 'You predict content performance. Return JSON only.',
          prompt: `Predict the performance of this content based on our scoring model.

CONTENT TITLE: ${item.trigger_title}
CONTENT: ${linkedinContent.slice(0, 1500)}
FORMATS: ${Object.keys(item.formats || {}).join(', ')}
SOURCE: ${item.source}

SCORING MODEL FACTORS:
${model.factors?.map(f => `- ${f.factor} (weight: ${f.weight}): ${f.insight}`).join('\n') || 'No model trained yet'}

Predict:
1. Expected engagement rate
2. Predicted impressions range
3. Likelihood of going viral (low/medium/high)
4. Best platform to post first
5. Optimal posting time

Return JSON: {
  "predicted_engagement_rate": "X%",
  "predicted_impressions": { "low": N, "high": N },
  "viral_likelihood": "low|medium|high",
  "best_platform": "...",
  "optimal_time": "...",
  "confidence": "low|medium|high",
  "reasoning": "..."
}`,
          maxTokens: 800
        });
        parsed = parseJsonResponse(text);
      } catch (err) {
        return json(res, { error: 'AI error: ' + err.message }, 500);
      }
      if (!parsed) return json(res, { error: 'Failed to predict', raw_preview: (text || '').slice(0, 200) }, 500);

      return json(res, { ok: true, prediction: parsed });
    }

    // === Batch 46: Drip Campaigns + Auto-Responder + Content Expiration ===

    // POST /api/drip-campaigns — create multi-day content drip from a topic
    if (pathname === '/api/drip-campaigns' && method === 'POST') {
      const body = await parseBody(req);
      const topic = body.topic || body.title;
      if (!topic) return json(res, { error: 'Topic required' }, 400);

      const { callClaude, parseJsonResponse, SONNET } = require('./lib/claude.js');
      const { BRAND_SYSTEM_PROMPT } = require('./generator/content-writer.js');
      let text, parsed;
      try {
        text = await callClaude({
          model: SONNET,
          system: BRAND_SYSTEM_PROMPT + '\nReturn JSON only.',
          prompt: `Create a 5-day content drip campaign for nurturing law firm leads on the topic: "${topic}"

TARGET: Law firm owners considering hiring a marketing agency
GOAL: Build trust, demonstrate expertise, and drive to a consultation call

For each day, create:
- Day number and theme
- LinkedIn post content (300-800 chars, direct and specific)
- Email subject + body (3-5 paragraphs)
- CTA for that day
- Key data point or story to include

Return JSON: {
  "campaign_name": "...",
  "target_audience": "...",
  "days": [{
    "day": 1,
    "theme": "...",
    "linkedin_post": "...",
    "email_subject": "...",
    "email_body": "...",
    "cta": "...",
    "data_point": "..."
  }],
  "success_metric": "...",
  "nurture_goal": "..."
}`,
          maxTokens: 6000
        });
        parsed = parseJsonResponse(text);
      } catch (err) {
        return json(res, { error: 'AI error: ' + err.message }, 500);
      }
      if (!parsed) return json(res, { error: 'Failed to create drip', raw_preview: (text || '').slice(0, 200) }, 500);

      const drips = readJSON('drip-campaigns.json', []);
      const drip = {
        id: generateId(),
        topic,
        ...parsed,
        status: 'active',
        subscribers: 0,
        created_at: now()
      };
      drips.push(drip);
      writeJSON('drip-campaigns.json', drips);
      return json(res, { ok: true, campaign: drip });
    }

    // GET /api/drip-campaigns — list all drip campaigns
    if (pathname === '/api/drip-campaigns' && method === 'GET') {
      return json(res, readJSON('drip-campaigns.json', []));
    }

    // DELETE /api/drip-campaigns/:id
    if (pathname.match(/^\/api\/drip-campaigns\/[^/]+$/) && method === 'DELETE') {
      const id = pathname.split('/')[3];
      const drips = readJSON('drip-campaigns.json', []);
      writeJSON('drip-campaigns.json', drips.filter(d => d.id !== id));
      return json(res, { ok: true });
    }

    // --- Engagement Auto-Responder ---

    // POST /api/auto-responses/generate — AI generates response templates
    if (pathname === '/api/auto-responses/generate' && method === 'POST') {
      const body = await parseBody(req);
      const contentTitle = body.content_title || 'general legal marketing content';

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude.js');
      let text, parsed;
      try {
        text = await callClaude({
          model: HAIKU,
          system: 'You create engagement response templates. Return JSON only.',
          prompt: `Create response templates for engaging with comments on this content: "${contentTitle}"

Create templates for these comment types:
1. Question about services
2. Objection/pushback
3. Agreement/support
4. Request for help
5. Competitor mention
6. Price question

For each template provide:
- Category name
- 2 response variants (short and detailed)
- Tone guidance
- CTA to include

Return JSON: {
  "templates": [{
    "category": "...",
    "short_response": "...",
    "detailed_response": "...",
    "tone": "...",
    "cta": "..."
  }]
}`,
          maxTokens: 2000
        });
        parsed = parseJsonResponse(text);
      } catch (err) {
        return json(res, { error: 'AI error: ' + err.message }, 500);
      }
      if (!parsed) return json(res, { error: 'Failed to generate responses', raw_preview: (text || '').slice(0, 200) }, 500);

      const responses = readJSON('auto-responses.json', []);
      const entry = { id: generateId(), content_title: contentTitle, ...parsed, created_at: now() };
      responses.push(entry);
      writeJSON('auto-responses.json', responses);
      return json(res, { ok: true, responses: entry });
    }

    // GET /api/auto-responses — list all response templates
    if (pathname === '/api/auto-responses' && method === 'GET') {
      return json(res, readJSON('auto-responses.json', []));
    }

    // --- Content Expiration & Refresh ---

    // GET /api/content/expiring — flag aging content
    if (pathname === '/api/content/expiring' && method === 'GET') {
      const allContent = readJSON('content.json', []);
      const now_ms = Date.now();
      const DAY = 24 * 60 * 60 * 1000;

      const expiring = allContent
        .filter(c => {
          const created = new Date(c.created_at || c.generated_at || 0).getTime();
          return (now_ms - created) > 30 * DAY;
        })
        .map(c => {
          const created = new Date(c.created_at || c.generated_at || 0).getTime();
          const ageDays = Math.floor((now_ms - created) / DAY);
          const urgency = ageDays > 90 ? 'critical' : ageDays > 60 ? 'high' : 'moderate';
          return { id: c.id, title: c.trigger_title, age_days: ageDays, urgency, formats: Object.keys(c.formats || {}).length, status: c.status };
        })
        .sort((a, b) => b.age_days - a.age_days);

      return json(res, {
        total_expiring: expiring.length,
        critical: expiring.filter(e => e.urgency === 'critical').length,
        high: expiring.filter(e => e.urgency === 'high').length,
        moderate: expiring.filter(e => e.urgency === 'moderate').length,
        items: expiring
      });
    }

    // POST /api/content/:id/refresh — AI refreshes content with updated angle
    if (pathname.match(/^\/api\/content\/[^/]+\/refresh$/) && method === 'POST') {
      const id = pathname.split('/')[3];
      const allContent = readJSON('content.json', []);
      const item = allContent.find(c => c.id === id);
      if (!item) return json(res, { error: 'not found' }, 404);

      const linkedinContent = item.formats?.linkedin?.content || Object.values(item.formats || {})[0]?.content || '';
      if (!linkedinContent) return json(res, { error: 'No content to refresh' }, 400);

      const { callClaude, HAIKU } = require('./lib/claude.js');
      const { BRAND_SYSTEM_PROMPT } = require('./generator/content-writer.js');

      const refreshed = await callClaude({
        model: HAIKU,
        system: BRAND_SYSTEM_PROMPT,
        prompt: `Refresh this content with a new hook, updated data, and fresh perspective. Keep the core insight but make it feel new.

ORIGINAL (${item.trigger_title}):
${linkedinContent.slice(0, 2000)}

Rules: New opening hook, update dated references, add fresh data point, keep core message, same length/format.`,
        maxTokens: 2000
      });

      if (!item.formats) item.formats = {};
      const originalKey = item.formats.linkedin ? 'linkedin' : Object.keys(item.formats)[0] || 'linkedin';
      item.formats[originalKey + '_refreshed'] = {
        content: refreshed,
        status: 'draft',
        generated_at: now(),
        refresh_of: originalKey
      };
      item.last_refreshed = now();
      writeJSON('content.json', allContent);

      return json(res, { ok: true, refreshed_content: refreshed.slice(0, 300) + '...' });
    }

    // === Batch 47: Amplification Engine + Lead Magnet Funnel + Calendar Optimizer ===

    // POST /api/content/:id/amplify — AI creates paid ad copy + targeting
    if (pathname.match(/^\/api\/content\/[^/]+\/amplify$/) && method === 'POST') {
      const id = pathname.split('/')[3];
      const allContent = readJSON('content.json', []);
      const item = allContent.find(c => c.id === id);
      if (!item) return json(res, { error: 'not found' }, 404);

      const bestContent = item.formats?.linkedin?.content || Object.values(item.formats || {})[0]?.content || '';
      if (!bestContent) return json(res, { error: 'No content to amplify' }, 400);

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude.js');
      let text, parsed;
      try {
        text = await callClaude({
          model: HAIKU,
          system: 'You create paid social ad campaigns for law firms. Return JSON only.',
          prompt: `Create paid ad versions and targeting for this organic content.

CONTENT TITLE: ${item.trigger_title}
ORGANIC CONTENT: ${bestContent.slice(0, 1500)}

Create:
1. LinkedIn Sponsored Content version (shorter, more direct CTA)
2. Facebook/Instagram ad version
3. Google Display ad copy (headline + description)
4. Targeting recommendations per platform

Return JSON: {
  "linkedin_ad": { "text": "...", "headline": "...", "cta_button": "Learn More|Download|Book Now", "budget_suggestion": "$X/day" },
  "meta_ad": { "primary_text": "...", "headline": "...", "description": "...", "cta_button": "...", "budget_suggestion": "$X/day" },
  "google_display": { "headline_1": "...", "headline_2": "...", "description": "...", "budget_suggestion": "$X/day" },
  "targeting": {
    "linkedin": { "job_titles": ["..."], "industries": ["..."], "company_size": "..." },
    "meta": { "interests": ["..."], "demographics": "...", "lookalike": "..." },
    "google": { "keywords": ["..."], "audiences": ["..."] }
  },
  "estimated_cpl": "cost per lead estimate",
  "recommended_budget": "$X/week total"
}`,
          maxTokens: 2000
        });
        parsed = parseJsonResponse(text);
      } catch (err) {
        return json(res, { error: 'AI error: ' + err.message }, 500);
      }
      if (!parsed) return json(res, { error: 'Failed to create ads', raw_preview: (text || '').slice(0, 200) }, 500);

      const amplifications = readJSON('amplifications.json', []);
      const amp = { id: generateId(), content_id: id, title: item.trigger_title, ...parsed, created_at: now() };
      amplifications.push(amp);
      writeJSON('amplifications.json', amplifications);
      return json(res, { ok: true, amplification: amp });
    }

    // GET /api/amplifications — list all amplified content
    if (pathname === '/api/amplifications' && method === 'GET') {
      return json(res, readJSON('amplifications.json', []));
    }

    // POST /api/content/:id/build-funnel — AI builds landing page + email sequence from lead magnet
    if (pathname.match(/^\/api\/content\/[^/]+\/build-funnel$/) && method === 'POST') {
      const id = pathname.split('/')[3];
      const allContent = readJSON('content.json', []);
      const item = allContent.find(c => c.id === id);
      if (!item) return json(res, { error: 'not found' }, 404);

      const leadMagnetContent = item.formats?.lead_magnet?.content || item.formats?.blog?.content || '';
      if (!leadMagnetContent) return json(res, { error: 'No lead magnet or blog content to build funnel from' }, 400);

      const { callClaude, parseJsonResponse, SONNET } = require('./lib/claude.js');
      const { BRAND_SYSTEM_PROMPT } = require('./generator/content-writer.js');
      let text, parsed;
      try {
        text = await callClaude({
          model: SONNET,
          system: BRAND_SYSTEM_PROMPT + '\nReturn JSON only.',
          prompt: `Build a complete lead generation funnel from this content.

CONTENT TITLE: ${item.trigger_title}
CONTENT: ${(typeof leadMagnetContent === 'string' ? leadMagnetContent : JSON.stringify(leadMagnetContent)).slice(0, 3000)}

Create:
1. Landing page copy (headline, subheadline, 3 bullet points, CTA, social proof line)
2. Thank you page copy
3. 3-email nurture sequence (delivered over 5 days)

Return JSON: {
  "funnel_name": "...",
  "landing_page": {
    "headline": "...",
    "subheadline": "...",
    "bullet_points": ["..."],
    "cta_text": "...",
    "social_proof": "...",
    "objection_handler": "..."
  },
  "thank_you_page": { "headline": "...", "next_step": "..." },
  "email_sequence": [{
    "day": 1,
    "subject": "...",
    "body": "...",
    "cta": "..."
  }],
  "conversion_estimate": "X%",
  "lead_magnet_type": "..."
}`,
          maxTokens: 4000
        });
        parsed = parseJsonResponse(text);
      } catch (err) {
        return json(res, { error: 'AI error: ' + err.message }, 500);
      }
      if (!parsed) return json(res, { error: 'Failed to build funnel', raw_preview: (text || '').slice(0, 200) }, 500);

      const funnels = readJSON('lead-funnels.json', []);
      const funnel = { id: generateId(), content_id: id, title: item.trigger_title, ...parsed, status: 'draft', created_at: now() };
      funnels.push(funnel);
      writeJSON('lead-funnels.json', funnels);
      return json(res, { ok: true, funnel });
    }

    // GET /api/lead-funnels — list all funnels
    if (pathname === '/api/lead-funnels' && method === 'GET') {
      return json(res, readJSON('lead-funnels.json', []));
    }

    // POST /api/calendar/optimize — AI rearranges calendar based on performance
    if (pathname === '/api/calendar/optimize' && method === 'POST') {
      const schedule = readJSON('schedule-queue.json', []);
      const engagement = readJSON('engagement-tracking.json', []);
      const scheduled = schedule.filter(s => s.status === 'scheduled');

      if (scheduled.length < 2) return json(res, { error: 'Need at least 2 scheduled posts to optimize' }, 400);

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude.js');
      const engData = engagement.slice(0, 10).map(e =>
        `- ${e.platform}: ${e.engagement_rate}% rate, ${e.impressions} imp (posted at ${e.last_updated?.slice(11, 16) || 'unknown'})`
      ).join('\n');

      const schedData = scheduled.map(s =>
        `- ${s.platform} on ${s.scheduled_at?.slice(0, 10)} at ${s.scheduled_at?.slice(11, 16)} | "${(s.trigger_title || '').slice(0, 40)}"`
      ).join('\n');

      let text, parsed;
      try {
        text = await callClaude({
          model: HAIKU,
          system: 'You optimize content calendars for maximum engagement. Return JSON only.',
          prompt: `Optimize this content calendar based on engagement data.

CURRENT SCHEDULE:
${schedData}

ENGAGEMENT DATA:
${engData || 'No engagement data yet — use industry best practices'}

Analyze and suggest:
1. Posts that should be moved to better time slots
2. Platform adjustments (e.g., LinkedIn works better on Tue AM)
3. Spacing improvements (avoid posting too close together)
4. Priority order changes

Return JSON: {
  "optimizations": [{ "post_id": "...", "current_time": "...", "suggested_time": "...", "reason": "..." }],
  "insights": ["..."],
  "best_performing_slots": [{ "platform": "...", "day": "...", "time": "...", "reason": "..." }],
  "overall_score": 0-100
}`,
          maxTokens: 1500
        });
        parsed = parseJsonResponse(text);
      } catch (err) {
        return json(res, { error: 'AI error: ' + err.message }, 500);
      }
      if (!parsed) return json(res, { error: 'Failed to optimize', raw_preview: (text || '').slice(0, 200) }, 500);

      return json(res, { ok: true, ...parsed });
    }

    // GET /api/calendar/insights — AI-generated calendar insights
    if (pathname === '/api/calendar/insights' && method === 'GET') {
      const schedule = readJSON('schedule-queue.json', []);
      const engagement = readJSON('engagement-tracking.json', []);

      const platformCount = {};
      const dayCount = {};
      for (const s of schedule) {
        platformCount[s.platform] = (platformCount[s.platform] || 0) + 1;
        const day = new Date(s.scheduled_at).toLocaleDateString('en-US', { weekday: 'short' });
        dayCount[day] = (dayCount[day] || 0) + 1;
      }

      return json(res, {
        total_scheduled: schedule.filter(s => s.status === 'scheduled').length,
        total_published: schedule.filter(s => s.status === 'published').length,
        by_platform: platformCount,
        by_day: dayCount,
        avg_engagement_rate: engagement.length > 0
          ? (engagement.reduce((s, e) => s + parseFloat(e.engagement_rate || 0), 0) / engagement.length).toFixed(1) + '%'
          : 'N/A',
        tracked_posts: engagement.length
      });
    }

    // === Batch 48: Workflow Automation + Weekly Digest + Split Testing ===

    // POST /api/workflow/automate — set automation rules
    if (pathname === '/api/workflow/automate' && method === 'POST') {
      const body = await parseBody(req);
      const rules = readJSON('workflow-rules.json', {
        auto_approve_threshold: 80,
        auto_schedule_approved: false,
        auto_generate_hashtags: true,
        auto_quality_check: true,
        max_daily_approvals: 10,
        notify_on_approval: true,
        enabled: false
      });
      Object.assign(rules, body, { updated_at: now() });
      writeJSON('workflow-rules.json', rules);
      return json(res, { ok: true, rules });
    }

    // GET /api/workflow/rules — get current automation rules
    if (pathname === '/api/workflow/rules' && method === 'GET') {
      return json(res, readJSON('workflow-rules.json', {
        auto_approve_threshold: 80,
        auto_schedule_approved: false,
        auto_generate_hashtags: true,
        auto_quality_check: true,
        max_daily_approvals: 10,
        enabled: false
      }));
    }

    // POST /api/workflow/run-automation — execute workflow rules on pending content
    if (pathname === '/api/workflow/run-automation' && method === 'POST') {
      const rules = readJSON('workflow-rules.json', { enabled: false });
      if (!rules.enabled) return json(res, { error: 'Workflow automation is disabled' }, 400);

      const allContent = readJSON('content.json', []);
      let approved = 0, scheduled = 0, checked = 0;

      for (const item of allContent) {
        for (const [fmt, data] of Object.entries(item.formats || {})) {
          if (!data.content || data.status !== 'draft') continue;

          // Auto quality check
          if (rules.auto_quality_check && !data.quality_score) {
            checked++;
          }

          // Auto approve if quality score meets threshold
          if (data.quality_score >= rules.auto_approve_threshold && data.status === 'draft') {
            data.status = 'approved';
            data.auto_approved = true;
            data.approved_at = now();
            approved++;
          }
        }
      }

      writeJSON('content.json', allContent);
      return json(res, { ok: true, approved, scheduled, checked });
    }

    // --- Weekly Analytics Digest ---

    // GET /api/analytics/weekly-digest — AI summary of all performance
    if (pathname === '/api/analytics/weekly-digest' && method === 'GET') {
      const cached = readJSON('weekly-digest.json', null);
      if (cached && cached.generated_at) {
        const age = Date.now() - new Date(cached.generated_at).getTime();
        if (age < 24 * 60 * 60 * 1000) return json(res, cached); // 24h cache
      }
      return json(res, cached || { summary: null, generated_at: null });
    }

    // POST /api/analytics/generate-digest — generate weekly digest
    if (pathname === '/api/analytics/generate-digest' && method === 'POST') {
      const allContent = readJSON('content.json', []);
      const engagement = readJSON('engagement-tracking.json', []);
      const schedule = readJSON('schedule-queue.json', []);
      const roi = readJSON('content-roi.json', []);
      const leads = readJSON('content-leads.json', []);

      const stats = {
        total_content: allContent.length,
        total_formats: allContent.reduce((s, c) => s + Object.keys(c.formats || {}).length, 0),
        approved: allContent.filter(c => Object.values(c.formats || {}).some(f => f.status === 'approved')).length,
        published: schedule.filter(s => s.status === 'published').length,
        scheduled: schedule.filter(s => s.status === 'scheduled').length,
        total_engagement: engagement.reduce((s, e) => s + (e.engagement || 0), 0),
        total_impressions: engagement.reduce((s, e) => s + (e.impressions || 0), 0),
        avg_engagement_rate: engagement.length > 0
          ? (engagement.reduce((s, e) => s + parseFloat(e.engagement_rate || 0), 0) / engagement.length).toFixed(1)
          : '0',
        total_leads: leads.length,
        total_revenue: roi.reduce((s, r) => s + (r.revenue || 0), 0)
      };

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude.js');
      let text, parsed;
      try {
        text = await callClaude({
          model: HAIKU,
          system: 'You generate weekly content marketing analytics summaries. Return JSON only.',
          prompt: `Generate a weekly analytics digest from this data.

STATS:
${JSON.stringify(stats, null, 2)}

Create a concise weekly summary with:
1. Key wins this week
2. Areas needing attention
3. Recommendations for next week
4. Performance grade (A-F)

Return JSON: {
  "grade": "A-F",
  "headline": "one-line summary",
  "key_wins": ["..."],
  "attention_needed": ["..."],
  "recommendations": ["..."],
  "metrics_highlight": { "best_metric": "...", "worst_metric": "...", "trend": "up|down|flat" }
}`,
          maxTokens: 1000
        });
        parsed = parseJsonResponse(text);
      } catch (err) {
        return json(res, { error: 'AI error: ' + err.message }, 500);
      }
      if (!parsed) return json(res, { error: 'Failed to generate digest', raw_preview: (text || '').slice(0, 200) }, 500);

      const digest = { ...parsed, stats, generated_at: now() };
      writeJSON('weekly-digest.json', digest);
      return json(res, { ok: true, digest });
    }

    // --- Content Split Testing ---

    // POST /api/content/:id/split-test — create 2 hook variants for A/B testing
    if (pathname.match(/^\/api\/content\/[^/]+\/split-test$/) && method === 'POST') {
      const id = pathname.split('/')[3];
      const allContent = readJSON('content.json', []);
      const item = allContent.find(c => c.id === id);
      if (!item) return json(res, { error: 'not found' }, 404);

      const linkedinContent = item.formats?.linkedin?.content || '';
      if (!linkedinContent) return json(res, { error: 'Need LinkedIn content to split test' }, 400);

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude.js');
      let text, parsed;
      try {
        text = await callClaude({
          model: HAIKU,
          system: 'You create A/B test variants for LinkedIn content. Return JSON only.',
          prompt: `Create 2 hook variants for this LinkedIn post for A/B testing.

ORIGINAL POST:
${linkedinContent.slice(0, 1500)}

Rules:
- Variant A: Different opening hook (story-driven)
- Variant B: Different opening hook (data-driven)
- Keep the core message and body the same
- Only change the first 2-3 lines (the hook)

Return JSON: {
  "variant_a": { "hook_style": "story", "content": "full post with new hook..." },
  "variant_b": { "hook_style": "data", "content": "full post with new hook..." },
  "hypothesis": "which variant should perform better and why"
}`,
          maxTokens: 3000
        });
        parsed = parseJsonResponse(text);
      } catch (err) {
        return json(res, { error: 'AI error: ' + err.message }, 500);
      }
      if (!parsed) return json(res, { error: 'Failed to create variants', raw_preview: (text || '').slice(0, 200) }, 500);

      const tests = readJSON('split-tests.json', []);
      const test = {
        id: generateId(),
        content_id: id,
        title: item.trigger_title,
        ...parsed,
        performance: { a: { impressions: 0, engagement: 0 }, b: { impressions: 0, engagement: 0 } },
        status: 'active',
        winner: null,
        created_at: now()
      };
      tests.push(test);
      writeJSON('split-tests.json', tests);
      return json(res, { ok: true, test });
    }

    // GET /api/split-tests — list all split tests
    if (pathname === '/api/split-tests' && method === 'GET') {
      return json(res, readJSON('split-tests.json', []));
    }

    // POST /api/split-tests/:id/record — record variant performance
    if (pathname.match(/^\/api\/split-tests\/[^/]+\/record$/) && method === 'POST') {
      const testId = pathname.split('/')[3];
      const body = await parseBody(req);
      const tests = readJSON('split-tests.json', []);
      const test = tests.find(t => t.id === testId);
      if (!test) return json(res, { error: 'not found' }, 404);

      const variant = body.variant; // 'a' or 'b'
      if (variant !== 'a' && variant !== 'b') return json(res, { error: 'variant must be "a" or "b"' }, 400);
      if (body.impressions) test.performance[variant].impressions += body.impressions;
      if (body.engagement) test.performance[variant].engagement += body.engagement;

      writeJSON('split-tests.json', tests);
      return json(res, { ok: true, performance: test.performance });
    }

    // POST /api/split-tests/:id/declare-winner — declare winning variant
    if (pathname.match(/^\/api\/split-tests\/[^/]+\/declare-winner$/) && method === 'POST') {
      const testId = pathname.split('/')[3];
      const body = await parseBody(req);
      const tests = readJSON('split-tests.json', []);
      const test = tests.find(t => t.id === testId);
      if (!test) return json(res, { error: 'not found' }, 404);

      const winner = body.winner || 'a';
      test.winner = winner;
      test.status = 'completed';
      test.completed_at = now();

      // Update the content with the winning variant
      const allContent = readJSON('content.json', []);
      const item = allContent.find(c => c.id === test.content_id);
      if (item && item.formats?.linkedin) {
        const winContent = winner === 'a' ? test.variant_a?.content : test.variant_b?.content;
        if (winContent) {
          item.formats.linkedin.content = winContent;
          item.formats.linkedin.split_test_winner = winner;
          writeJSON('content.json', allContent);
        }
      }

      writeJSON('split-tests.json', tests);
      return json(res, { ok: true, winner, test });
    }

    // --- Content Series API ---

    // GET /api/series — list all content series
    if (pathname === '/api/series' && method === 'GET') {
      const series = readJSON('series.json', []);
      return json(res, series);
    }

    // POST /api/series — create a new series
    if (pathname === '/api/series' && method === 'POST') {
      const body = await parseBody(req);
      if (!body.name || !body.day) return json(res, { error: 'name and day required' }, 400);
      const series = readJSON('series.json', []);
      const newSeries = {
        id: body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        name: body.name,
        day: body.day,
        frequency: body.frequency || 'weekly',
        description: body.description || '',
        template_prompt: body.template_prompt || '',
        formats: body.formats || ['linkedin', 'x_single'],
        pillar: body.pillar || 'tactical',
        hashtag: body.hashtag || '',
        active: true,
        episodes: [],
        created_at: now()
      };
      series.push(newSeries);
      writeJSON('series.json', series);
      return json(res, { ok: true, series: newSeries });
    }

    // PUT /api/series/:id — update a series
    const seriesUpdateMatch = pathname.match(/^\/api\/series\/([\w-]+)$/);
    if (seriesUpdateMatch && method === 'PUT') {
      const body = await parseBody(req);
      const series = readJSON('series.json', []);
      const idx = series.findIndex(s => s.id === seriesUpdateMatch[1]);
      if (idx === -1) return json(res, { error: 'Series not found' }, 404);
      if (body.name !== undefined) series[idx].name = body.name;
      if (body.day !== undefined) series[idx].day = body.day;
      if (body.description !== undefined) series[idx].description = body.description;
      if (body.template_prompt !== undefined) series[idx].template_prompt = body.template_prompt;
      if (body.formats !== undefined) series[idx].formats = body.formats;
      if (body.active !== undefined) series[idx].active = body.active;
      if (body.hashtag !== undefined) series[idx].hashtag = body.hashtag;
      writeJSON('series.json', series);
      return json(res, { ok: true, series: series[idx] });
    }

    // POST /api/series/:id/generate — generate next episode for a series
    const seriesGenMatch = pathname.match(/^\/api\/series\/([\w-]+)\/generate$/);
    if (seriesGenMatch && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const body = await parseBody(req);
      const series = readJSON('series.json', []);
      const idx = series.findIndex(s => s.id === seriesGenMatch[1]);
      if (idx === -1) return json(res, { error: 'Series not found' }, 404);

      const s = series[idx];
      const episodeNum = (s.episodes || []).length + 1;

      // Find a matching trigger to use as source material
      const triggers = readJSON('trigger-queue.json');
      const { scoreTrigger } = require('./generator/score-triggers');
      let sourceTrigger = null;
      if (body.trigger_id) {
        sourceTrigger = triggers.find(t => t.id === body.trigger_id);
      } else {
        // Pick top ungenerated trigger matching the series pillar/category
        const candidates = triggers
          .filter(t => t.status === 'pending')
          .map(t => ({ ...t, score: scoreTrigger(t) }))
          .sort((a, b) => b.score - a.score);
        sourceTrigger = candidates[0] || null;
      }

      if (!sourceTrigger) return json(res, { error: 'No trigger available for series episode' }, 400);

      try {
        const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
        const { buildSystemPromptWithMemory } = require('./generator/content-writer');
        const systemPrompt = buildSystemPromptWithMemory();

        const prompt = `You are generating episode #${episodeNum} of the "${s.name}" content series.

SERIES CONCEPT: ${s.description}
SERIES DAY: ${s.day} (${s.frequency})
HASHTAG: ${s.hashtag || 'none'}

TEMPLATE INSTRUCTIONS:
${s.template_prompt}

SOURCE MATERIAL (use this as inspiration/data for the episode):
Title: ${sourceTrigger.title}
Content: ${(sourceTrigger.raw_content || '').slice(0, 2000)}

Generate content for these formats: ${s.formats.join(', ')}

Return a JSON object (raw JSON, no markdown fences) with these keys:
{
  "episode_title": "A catchy title for this episode",
  "episode_hook": "The opening hook (first 2 lines)",
${s.formats.map(f => {
  if (f === 'linkedin') return '  "linkedin": "Full LinkedIn post (800-1300 chars)"';
  if (f === 'x_single') return '  "x_single": "Single tweet under 280 chars"';
  if (f === 'x_thread') return '  "x_thread": ["tweet1", "tweet2", "tweet3", "tweet4", "tweet5"]';
  if (f === 'carousel') return '  "carousel": ["Slide 1", "Slide 2", "Slide 3", "Slide 4", "Slide 5"]';
  if (f === 'short_video') return '  "short_video": "30-90 second script with [PAUSE] markers"';
  if (f === 'newsletter') return '  "newsletter": "Full newsletter with subject line"';
  if (f === 'blog') return '  "blog": "Full blog post in markdown (1500+ words)"';
  return `  "${f}": "Content for ${f} format"`;
}).join(',\n')}
}

Add the series hashtag ${s.hashtag || ''} naturally at the end of social posts.`;

        const text = await callClaude({ model: HAIKU, system: systemPrompt, prompt, maxTokens: 4000 });
        const parsed = parseJsonResponse(text);
        if (!parsed) return json(res, { error: 'Failed to parse series content' }, 500);

        // Create content item from series episode
        const content = readJSON('content.json');
        const contentId = generateId();
        const formats = {};
        for (const fmt of s.formats) {
          if (parsed[fmt]) {
            formats[fmt] = { content: parsed[fmt], status: 'review', edited: false };
          }
        }

        const contentItem = {
          id: contentId,
          trigger_id: sourceTrigger.id,
          trigger_title: parsed.episode_title || sourceTrigger.title,
          trigger_source: 'series',
          trigger_category: s.pillar?.toUpperCase() || 'CONTENT_PIECE',
          series_id: s.id,
          series_episode: episodeNum,
          formats,
          status: 'review',
          quality_score: null,
          created_at: now()
        };
        content.push(contentItem);
        writeJSON('content.json', content);

        // Record episode
        series[idx].episodes = series[idx].episodes || [];
        series[idx].episodes.push({
          number: episodeNum,
          content_id: contentId,
          title: parsed.episode_title || `Episode ${episodeNum}`,
          trigger_id: sourceTrigger.id,
          generated_at: now()
        });
        writeJSON('series.json', series);

        // Mark trigger as used
        const trigIdx = triggers.findIndex(t => t.id === sourceTrigger.id);
        if (trigIdx !== -1) {
          triggers[trigIdx].status = 'used';
          triggers[trigIdx].used_at = now();
          writeJSON('trigger-queue.json', triggers);
        }

        return json(res, { ok: true, content_id: contentId, episode: episodeNum, title: parsed.episode_title });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // --- Lead Magnet Auto-Generation ---

    // POST /api/lead-magnets/generate — auto-generate lead magnets from top triggers
    if (pathname === '/api/lead-magnets/generate' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const body = await parseBody(req);
      const count = Math.min(body.count || 3, 5);

      const batchId = generateId();
      _batchProgress[batchId] = { total: count, completed: 0, errors: 0, results: [], status: 'starting', type: 'lead_magnets' };

      setImmediate(async () => {
        try {
          const { generateLeadMagnet } = require('./lib/claude');
          const { renderLeadMagnetHTML } = require('./generator/lead-magnet-renderer');
          const { buildSystemPromptWithMemory } = require('./generator/content-writer');
          const { scoreTrigger } = require('./generator/score-triggers');
          const systemPrompt = buildSystemPromptWithMemory();

          const triggers = readJSON('trigger-queue.json');
          // Find triggers with lead_magnet_topic or high scores
          const candidates = triggers
            .filter(t => t.status === 'pending')
            .map(t => ({ ...t, score: scoreTrigger(t) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, count);

          _batchProgress[batchId].total = candidates.length;
          _batchProgress[batchId].status = 'running';

          for (const trigger of candidates) {
            try {
              const triggerWithTopic = { ...trigger, lead_magnet_topic: trigger.lead_magnet_topic || trigger.title };
              const parsed = await generateLeadMagnet(triggerWithTopic, systemPrompt);
              const html = renderLeadMagnetHTML(parsed);

              // Create or update content item
              let content = readJSON('content.json');
              let existing = content.find(c => c.trigger_id === trigger.id);
              if (existing) {
                const idx = content.indexOf(existing);
                content[idx].formats.lead_magnet = { content: html, status: 'review', edited: false };
                content[idx].lead_magnet_meta = { title: parsed.title, type: parsed.type, subtitle: parsed.subtitle };
              } else {
                const contentItem = {
                  id: generateId(),
                  trigger_id: trigger.id,
                  trigger_title: trigger.title,
                  trigger_source: trigger.source,
                  trigger_category: trigger.category,
                  formats: { lead_magnet: { content: html, status: 'review', edited: false } },
                  lead_magnet_meta: { title: parsed.title, type: parsed.type, subtitle: parsed.subtitle },
                  status: 'review',
                  created_at: now()
                };
                content.push(contentItem);
                existing = contentItem;
              }
              writeJSON('content.json', content);

              _batchProgress[batchId].completed++;
              _batchProgress[batchId].results.push({ content_id: existing.id, title: parsed.title, type: parsed.type });
            } catch (err) {
              _batchProgress[batchId].errors++;
              console.error(`[lead-magnet] Error for trigger ${trigger.id}: ${err.message}`);
            }
          }
          _batchProgress[batchId].status = 'done';
        } catch (err) {
          _batchProgress[batchId].status = 'error';
          _batchProgress[batchId].error = err.message;
        }
        setTimeout(() => { delete _batchProgress[batchId]; }, 30 * 60 * 1000);
      });

      return json(res, { ok: true, batch_id: batchId });
    }

    // GET /api/lead-magnets — list all generated lead magnets
    if (pathname === '/api/lead-magnets' && method === 'GET') {
      const content = readJSON('content.json');
      const magnets = content
        .filter(c => c.formats?.lead_magnet)
        .map(c => ({
          content_id: c.id,
          title: c.lead_magnet_meta?.title || c.trigger_title,
          type: c.lead_magnet_meta?.type || 'unknown',
          subtitle: c.lead_magnet_meta?.subtitle || '',
          status: c.formats.lead_magnet.status,
          trigger_title: c.trigger_title,
          created_at: c.created_at
        }))
        .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
      return json(res, magnets);
    }

    // --- Multi-Platform Publish Tracking ---

    // POST /api/content/:id/track-publish — track where content was published
    const trackPublishMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/track-publish$/);
    if (trackPublishMatch && method === 'POST') {
      const body = await parseBody(req);
      if (!body.format || !body.platform) return json(res, { error: 'format and platform required' }, 400);

      const content = readJSON('content.json');
      const idx = content.findIndex(c => c.id === trackPublishMatch[1]);
      if (idx === -1) return json(res, { error: 'Not found' }, 404);

      // Track publish across platforms
      if (!content[idx].publish_tracking) content[idx].publish_tracking = [];
      content[idx].publish_tracking.push({
        format: body.format,
        platform: body.platform,
        url: body.url || null,
        published_at: now(),
        notes: body.notes || ''
      });

      // Also update format status
      if (content[idx].formats[body.format]) {
        content[idx].formats[body.format].status = 'published';
        content[idx].formats[body.format].published_at = now();
        content[idx].formats[body.format].publish_url = body.url || null;
      }

      writeJSON('content.json', content);

      // Also add to published.json
      const published = readJSON('published.json');
      published.push({
        content_id: content[idx].id,
        format: body.format,
        platform: body.platform,
        published_at: now(),
        url: body.url || null,
        title: content[idx].trigger_title || 'Untitled'
      });
      writeJSON('published.json', published);

      return json(res, { ok: true });
    }

    // GET /api/publish-tracker — overview of publish status across platforms
    if (pathname === '/api/publish-tracker' && method === 'GET') {
      const content = readJSON('content.json');
      const platforms = ['linkedin', 'x', 'youtube', 'blog', 'newsletter', 'instagram'];
      const tracker = [];

      for (const item of content) {
        if (!item.formats) continue;
        const approvedFormats = Object.entries(item.formats)
          .filter(([, f]) => f.status === 'approved' || f.status === 'published');
        if (approvedFormats.length === 0) continue;

        const publishStatus = {};
        for (const p of platforms) {
          const tracking = (item.publish_tracking || []).find(t => t.platform === p);
          publishStatus[p] = tracking ? { published: true, url: tracking.url, date: tracking.published_at } : { published: false };
        }

        tracker.push({
          content_id: item.id,
          title: item.trigger_title || 'Untitled',
          formats: Object.keys(item.formats).filter(f => item.formats[f].status === 'approved' || item.formats[f].status === 'published'),
          publish_status: publishStatus,
          series_id: item.series_id || null,
          created_at: item.created_at
        });
      }

      tracker.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
      return json(res, { items: tracker, platforms });
    }

    // --- Batch 49: YouTube Pipeline + Carousel Generator + Content Matrix + Hook Analyzer + CTA Strategy ---

    // POST /api/youtube/pipeline — full YouTube video pipeline (script + thumbnail + SEO + Shorts)
    const ytPipelineMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/youtube-pipeline$/);
    if (ytPipelineMatch && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const id = ytPipelineMatch[1];
      const allContent = readJSON('content.json', []);
      const item = allContent.find(c => c.id === id);
      if (!item) return json(res, { error: 'Content not found' }, 404);

      const { callClaude, parseJsonResponse, SONNET } = require('./lib/claude');
      const { BRAND_SYSTEM_PROMPT } = require('./generator/content-writer');
      const topic = item.trigger_title || 'Untitled';
      const rawContent = item.formats?.blog?.content || item.formats?.linkedin?.content || '';

      const prompt = `You are a YouTube content strategist for a legal marketing agency. Create a COMPLETE YouTube video pipeline for this topic:

Topic: ${topic}
Source content: ${rawContent.slice(0, 3000)}

Return a JSON object with this structure:
{
  "script": {
    "title": "Video title (under 70 chars, primary keyword in first 40 chars)",
    "hook": "First 10 seconds — bold claim, specific number, or pattern interrupt",
    "intro": "30 seconds — credibility flash + what they'll learn",
    "body_sections": [
      { "heading": "section name", "duration": "2-3 min", "content": "detailed script with [VISUAL:] and [CUT TO:] markers", "key_point": "one takeaway" }
    ],
    "mid_roll_cta": "CTA placed right after biggest value moment — soft, reciprocity-based",
    "case_study": "2 min proof section with specific results",
    "end_cta": "Final 30s CTA with specific offer",
    "estimated_duration": "10-15 min"
  },
  "thumbnail": {
    "concept": "describe the thumbnail layout",
    "text_overlay": "2-4 words max for thumbnail text",
    "emotion": "which facial expression to use (surprise/shock/concern/excitement)",
    "color_scheme": "2 contrasting colors",
    "visual_element": "what to show besides face (dashboard, metrics, before/after)"
  },
  "seo": {
    "title_options": ["title 1", "title 2", "title 3"],
    "description_first_2_lines": "CTA + link area (shown before 'Show More')",
    "full_description": "200+ word description with natural keyword usage",
    "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
    "chapters": [{ "timestamp": "0:00", "label": "chapter name" }]
  },
  "shorts": [
    {
      "clip_title": "title for this Short",
      "clip_script": "15-60 second script — one key insight with dynamic caption markers",
      "hook": "first 2 seconds text hook",
      "timestamp_range": "where in long-form this comes from"
    }
  ],
  "cta_strategy": {
    "pinned_comment": "text for pinned comment with CTA",
    "description_cta": "CTA for first 2 lines of description",
    "verbal_ctas": ["mid-roll CTA", "end CTA"],
    "lead_magnet_tie_in": "what free resource to offer"
  }
}`;

      try {
        const text = await callClaude({ model: SONNET, system: BRAND_SYSTEM_PROMPT, prompt, maxTokens: 6000 });
        const parsed = parseJsonResponse(text);
        if (!parsed) return json(res, { error: 'Failed to generate pipeline', raw_preview: (text || '').slice(0, 300) }, 500);

        const pipelines = readJSON('youtube-pipelines.json', []);
        const pipeline = {
          id: generateId(),
          content_id: id,
          title: topic,
          ...parsed,
          status: 'draft',
          created_at: now()
        };
        pipelines.push(pipeline);
        writeJSON('youtube-pipelines.json', pipelines);
        return json(res, { ok: true, pipeline });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // GET /api/youtube/pipelines — list all YouTube pipelines
    if (pathname === '/api/youtube/pipelines' && method === 'GET') {
      return json(res, readJSON('youtube-pipelines.json', []));
    }

    // POST /api/content/:id/carousel-slides — generate structured carousel slides
    const carouselMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/carousel-slides$/);
    if (carouselMatch && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const id = carouselMatch[1];
      const allContent = readJSON('content.json', []);
      const item = allContent.find(c => c.id === id);
      if (!item) return json(res, { error: 'Content not found' }, 404);

      const { callClaude, parseJsonResponse, SONNET } = require('./lib/claude');
      const { BRAND_SYSTEM_PROMPT } = require('./generator/content-writer');
      const topic = item.trigger_title || 'Untitled';
      const source = item.formats?.linkedin?.content || item.formats?.blog?.content || '';

      const prompt = `Create a LinkedIn carousel (PDF-style) from this content. LinkedIn carousels have the HIGHEST engagement rate (6.60%) of any format.

Topic: ${topic}
Source: ${source.slice(0, 3000)}

Return a JSON object:
{
  "title": "carousel title",
  "slide_count": 6-10,
  "slides": [
    {
      "slide_number": 1,
      "type": "cover",
      "headline": "bold hook headline (max 8 words)",
      "subtext": "supporting line",
      "visual_note": "design suggestion"
    },
    {
      "slide_number": 2,
      "type": "content",
      "headline": "slide headline",
      "body": "2-3 bullet points or short paragraph",
      "stat_highlight": "key number if applicable",
      "visual_note": "icon/graphic suggestion"
    },
    ...
    {
      "slide_number": N,
      "type": "cta",
      "headline": "takeaway or CTA",
      "body": "what to do next",
      "cta_text": "Comment AUDIT for free analysis",
      "visual_note": "design suggestion"
    }
  ],
  "design_guidelines": {
    "color_primary": "#hex",
    "color_accent": "#hex",
    "font_style": "bold sans-serif",
    "brand_element": "Mortar Metrics logo bottom-right"
  },
  "companion_post": "LinkedIn text post to accompany the carousel (200-400 chars with hook)"
}

Rules:
- Slide 1 must be an irresistible hook (curiosity gap)
- Each slide should be self-contained — one idea per slide
- Use specific numbers/stats on at least 3 slides
- Final slide is ALWAYS a CTA
- Write for mobile — short text, large fonts implied
- 6-10 slides total (sweet spot for engagement)`;

      try {
        const text = await callClaude({ model: SONNET, system: BRAND_SYSTEM_PROMPT, prompt, maxTokens: 4000 });
        const parsed = parseJsonResponse(text);
        if (!parsed) return json(res, { error: 'Failed to generate carousel', raw_preview: (text || '').slice(0, 300) }, 500);

        const carousels = readJSON('carousels.json', []);
        const carousel = {
          id: generateId(),
          content_id: id,
          title: topic,
          ...parsed,
          status: 'draft',
          created_at: now()
        };
        carousels.push(carousel);
        writeJSON('carousels.json', carousels);
        return json(res, { ok: true, carousel });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // GET /api/carousels — list all carousels
    if (pathname === '/api/carousels' && method === 'GET') {
      return json(res, readJSON('carousels.json', []));
    }

    // POST /api/content-matrix/build — Justin Welsh's content matrix system
    if (pathname === '/api/content-matrix/build' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const { callClaude, parseJsonResponse, SONNET } = require('./lib/claude');
      const { BRAND_SYSTEM_PROMPT } = require('./generator/content-writer');

      const body = await parseBody(req);
      const mantra = body.mantra || 'Law firms deserve marketing that actually generates signed cases, not vanity metrics.';
      const pillars = body.pillars || ['lead_generation', 'digital_advertising', 'content_seo', 'business_of_law', 'industry_trends'];

      const prompt = `Build a Content Matrix (Justin Welsh's framework) for a legal marketing agency.

Mantra: "${mantra}"
Pillars: ${JSON.stringify(pillars)}

For each pillar, create 2 "core concepts" (strong opinions). Then for each concept, generate 5 post types:
1. Teaching — how-to
2. Contrarian — "Unpopular opinion: ..."
3. Case study — results-driven
4. Listicle — "5 things..." or "3 mistakes..."
5. Teardown — audit/critique

IMPORTANT: Keep hooks under 80 chars. Outlines must be ONE sentence max. Be concise.

Return JSON (no markdown fences):
{"mantra":"...","pillars":[{"id":"pillar_id","name":"Pillar Name","concepts":[{"belief":"the opinion","posts":[{"type":"teaching","hook":"first line"},{"type":"contrarian","hook":"..."},{"type":"case_study","hook":"..."},{"type":"listicle","hook":"..."},{"type":"teardown","hook":"..."}]}]}],"total_posts":50,"weeks_of_content":10,"recommended_schedule":{"monday":"pillar+type","tuesday":"pillar+type","wednesday":"pillar+type","thursday":"pillar+type","friday":"pillar+type"}}`;

      try {
        const text = await callClaude({ model: SONNET, system: BRAND_SYSTEM_PROMPT, prompt, maxTokens: 8000 });
        const parsed = parseJsonResponse(text);
        if (!parsed) return json(res, { error: 'Failed to build matrix', raw_preview: (text || '').slice(0, 300) }, 500);

        writeJSON('content-matrix.json', { ...parsed, built_at: now() });
        return json(res, { ok: true, matrix: parsed });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // GET /api/content-matrix — get the content matrix
    if (pathname === '/api/content-matrix' && method === 'GET') {
      return json(res, readJSON('content-matrix.json', null));
    }

    // POST /api/content-matrix/generate-post — generate a full post from a matrix cell
    if (pathname === '/api/content-matrix/generate-post' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const { BRAND_SYSTEM_PROMPT } = require('./generator/content-writer');
      const body = await parseBody(req);
      if (!body.hook || !body.outline) return json(res, { error: 'hook and outline required' }, 400);

      const prompt = `Write a LinkedIn post using this hook and outline:

Hook: ${body.hook}
Outline: ${body.outline}
Post type: ${body.type || 'general'}
Pillar: ${body.pillar || 'general'}

Write a complete LinkedIn post (800-1300 characters). Use the hook as the opening line. Follow the Mortar Metrics voice: blunt, specific, operator-style. Include specific numbers. End with a soft engagement CTA (question, not "DM me").

Return JSON: { "content": "the full post", "hashtags": ["tag1", "tag2", "tag3"], "cta_tier": "conversation|keyword_comment|link_in_comments", "estimated_engagement": "low|medium|high" }`;

      try {
        const text = await callClaude({ model: HAIKU, system: BRAND_SYSTEM_PROMPT, prompt, maxTokens: 1500 });
        const parsed = parseJsonResponse(text);
        if (!parsed) return json(res, { error: 'Failed to generate post', raw_preview: (text || '').slice(0, 200) }, 500);
        return json(res, { ok: true, post: parsed });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // POST /api/hooks/analyze — analyze and score hooks
    if (pathname === '/api/hooks/analyze' && method === 'POST') {
      const body = await parseBody(req);
      const hooks = body.hooks || [];
      if (!hooks.length) {
        // Analyze hooks from existing content
        const content = readJSON('content.json', []);
        for (const item of content.slice(0, 20)) {
          const linkedin = item.formats?.linkedin?.content;
          if (linkedin) {
            const firstLine = linkedin.split('\n').find(l => l.trim()) || '';
            hooks.push({ content_id: item.id, title: item.trigger_title, hook: firstLine });
          }
        }
      }

      const results = hooks.map(h => {
        const hook = h.hook || '';
        let score = 0;
        const signals = [];

        // 1. Specific number in hook (+3)
        if (/\$[\d,]+|\d+%|\d+x|\d+ (cases|clients|leads|firms|calls|months|years|days)/.test(hook)) {
          score += 3; signals.push('specific_number');
        }
        // 2. Information gap (+2)
        if (/but|however|except|the problem|what nobody|the truth|here'?s what|turns out/i.test(hook)) {
          score += 2; signals.push('information_gap');
        }
        // 3. Contrarian frame (+2)
        if (/wrong|myth|stop|don'?t|isn'?t|won'?t work|unpopular|everyone says/i.test(hook)) {
          score += 2; signals.push('contrarian');
        }
        // 4. Short and punchy — under 80 chars (+1)
        if (hook.length > 10 && hook.length < 80) {
          score += 1; signals.push('concise');
        }
        // 5. Pain point / emotional (+2)
        if (/wast|lost|bleed|fail|broke|mistake|terrible|brutal|panic|fired/i.test(hook)) {
          score += 2; signals.push('emotional_pain');
        }
        // 6. Specificity — named tools, companies, locations (+1)
        if (/Google|CallRail|Clio|HubSpot|Salesforce|law firm|PI firm|personal injury/i.test(hook)) {
          score += 1; signals.push('specific_reference');
        }
        // 7. Story opener — time/place marker (+1)
        if (/last (week|month|year|thursday|monday)|yesterday|at \d|in \d{4}|a \w+ firm/i.test(hook)) {
          score += 1; signals.push('story_opener');
        }
        // 8. Direct address (+1)
        if (/^(I |We |A |The |"|\d|Last|\$)/.test(hook.trim())) {
          score += 1; signals.push('strong_opener');
        }

        const maxScore = 13;
        const pct = Math.round((score / maxScore) * 100);
        let grade = 'F';
        if (pct >= 85) grade = 'A';
        else if (pct >= 70) grade = 'B';
        else if (pct >= 55) grade = 'C';
        else if (pct >= 40) grade = 'D';

        // Formula detection
        let formula = 'generic';
        if (signals.includes('specific_number') && signals.includes('emotional_pain')) formula = 'specific_result';
        else if (signals.includes('contrarian')) formula = 'contrarian_take';
        else if (signals.includes('story_opener')) formula = 'story_opener';
        else if (signals.includes('specific_number')) formula = 'bold_claim_with_data';
        else if (signals.includes('emotional_pain')) formula = 'pain_point_confession';
        else if (signals.includes('information_gap')) formula = 'curiosity_gap';

        return { ...h, score, max_score: maxScore, percentage: pct, grade, formula, signals };
      });

      const avgScore = results.length ? Math.round(results.reduce((s, r) => s + r.percentage, 0) / results.length) : 0;
      return json(res, {
        hooks: results.sort((a, b) => b.percentage - a.percentage),
        average_score: avgScore,
        best_hook: results[0] || null,
        formulas_used: [...new Set(results.map(r => r.formula))],
        improvement_tips: [
          avgScore < 50 ? 'Add specific numbers ($X, Y%, Z cases) to your hooks' : null,
          !results.some(r => r.signals.includes('contrarian')) ? 'Try contrarian hooks — they drive 2-3x more comments' : null,
          !results.some(r => r.signals.includes('story_opener')) ? 'Add story openers with time markers ("Last month, a PI firm...")' : null,
          !results.some(r => r.signals.includes('emotional_pain')) ? 'Use pain language (wasted, lost, bleeding) — it stops the scroll' : null,
          results.filter(r => r.hook.length > 100).length > results.length / 2 ? 'Shorten your hooks — under 80 chars performs best' : null
        ].filter(Boolean)
      });
    }

    // GET /api/cta-strategy — track value:ask ratio and CTA tier usage
    if (pathname === '/api/cta-strategy' && method === 'GET') {
      const content = readJSON('content.json', []);
      const published = readJSON('published.json', []);

      let valuePostCount = 0;
      let ctaPostCount = 0;
      const ctaTiers = { conversation: 0, keyword_comment: 0, link_in_comments: 0, soft_dm: 0, resource_offer: 0, direct_ask: 0 };

      for (const item of content) {
        const linkedin = item.formats?.linkedin?.content || '';
        const hasCta = /DM me|link in|comment .{1,20} (and|to)|book a|sign up|download|grab the|check out/i.test(linkedin);
        if (hasCta) {
          ctaPostCount++;
          if (/comment .{1,20} (and|to) I/i.test(linkedin)) ctaTiers.keyword_comment++;
          else if (/link in (the )?comment/i.test(linkedin)) ctaTiers.link_in_comments++;
          else if (/DM me/i.test(linkedin)) ctaTiers.soft_dm++;
          else if (/book a|sign up|schedule/i.test(linkedin)) ctaTiers.direct_ask++;
          else if (/download|grab|check out/i.test(linkedin)) ctaTiers.resource_offer++;
          else ctaTiers.conversation++;
        } else {
          valuePostCount++;
        }
      }

      const ratio = ctaPostCount > 0 ? (valuePostCount / ctaPostCount).toFixed(1) : 'Infinity';
      const idealRatio = 4; // Amanda Natividad's 4:1 rule
      const ratioHealth = parseFloat(ratio) >= idealRatio ? 'healthy' :
                          parseFloat(ratio) >= 2 ? 'borderline' : 'too_aggressive';

      return json(res, {
        value_posts: valuePostCount,
        cta_posts: ctaPostCount,
        ratio: `${ratio}:1`,
        ideal_ratio: '4:1',
        ratio_health: ratioHealth,
        cta_tiers: ctaTiers,
        recommendation: ratioHealth === 'too_aggressive'
          ? 'You are asking too often. Add more zero-click value posts before your next CTA.'
          : ratioHealth === 'borderline'
          ? 'Getting close to ask fatigue. Next 2-3 posts should be pure value.'
          : 'Good balance. You have earned the right to include a CTA in your next post.',
        next_cta_suggestion: ctaTiers.keyword_comment === 0
          ? 'Try a keyword-comment CTA next: "Comment AUDIT and I\'ll DM you a free analysis"'
          : ctaTiers.link_in_comments === 0
          ? 'Try dropping a link in comments instead of the post body (avoids 60% reach penalty)'
          : 'Rotate between tiers to keep CTAs fresh',
        total_published: published.length
      });
    }

    // POST /api/content/:id/generate-shorts — generate YouTube Shorts scripts from long-form content
    const shortsMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/generate-shorts$/);
    if (shortsMatch && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const id = shortsMatch[1];
      const allContent = readJSON('content.json', []);
      const item = allContent.find(c => c.id === id);
      if (!item) return json(res, { error: 'Content not found' }, 404);

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const { BRAND_SYSTEM_PROMPT } = require('./generator/content-writer');
      const source = item.formats?.youtube_script?.content || item.formats?.blog?.content || item.formats?.linkedin?.content || '';

      const prompt = `Extract 3-5 YouTube Shorts (15-60 seconds each) from this content:

Title: ${item.trigger_title}
Content: ${source.slice(0, 4000)}

Each Short should be the single best moment — one powerful insight, stat, or story beat.

Return JSON: {
  "shorts": [
    {
      "title": "Short title (under 50 chars)",
      "hook": "first 2 seconds — text overlay that stops scroll",
      "script": "full 15-60 second script with [CAPTION: key phrase] markers for dynamic captions",
      "duration_seconds": 30,
      "hashtags": ["tag1", "tag2"],
      "cta": "Follow for more / Full breakdown on the channel"
    }
  ]
}

Rules:
- Each Short must work as standalone content
- Hook must grab attention in first 2 seconds
- Add [CAPTION: highlighted word] for dynamic caption emphasis (50% watch without audio)
- End each Short with a channel CTA`;

      try {
        const text = await callClaude({ model: HAIKU, system: BRAND_SYSTEM_PROMPT, prompt, maxTokens: 3000 });
        const parsed = parseJsonResponse(text);
        if (!parsed) return json(res, { error: 'Failed to generate shorts', raw_preview: (text || '').slice(0, 200) }, 500);
        return json(res, { ok: true, content_id: id, ...parsed });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // --- Batch 50: Recurring Series + Content Banking + Engagement Triggers + Video Repurposer + Comment-DM ---

    // POST /api/series-templates/setup — set up branded recurring series
    if (pathname === '/api/series-templates/setup' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const { callClaude, parseJsonResponse, SONNET } = require('./lib/claude');
      const { BRAND_SYSTEM_PROMPT } = require('./generator/content-writer');
      const body = await parseBody(req);

      const prompt = `Create a branded weekly content series system for a legal marketing agency.

${body.custom_pillars ? `Use these pillars: ${JSON.stringify(body.custom_pillars)}` : ''}

Design 5 recurring series (one per weekday) following these rules:
- Each series has a catchy name, a specific day, a specific format, and a consistent structure
- Each series ties to a lead magnet
- The series names should be memorable and brandable (like "Metric Monday" or "Teardown Tuesday")

Return JSON (no markdown fences):
{
  "series": [
    {
      "name": "Series Name",
      "day": "monday",
      "format": "carousel|text|case_study|hot_take|story",
      "description": "what this series covers",
      "template_prompt": "specific prompt prefix for AI generation",
      "hashtag": "#SeriesHashtag",
      "lead_magnet_type": "scorecard|checklist|audit|calculator",
      "lead_magnet_cta": "what to offer",
      "example_topics": ["topic1", "topic2", "topic3"],
      "cta_tier": "conversation|keyword_comment|link_in_comments|soft_dm|resource_offer"
    }
  ],
  "cadence_notes": "posting schedule advice",
  "engagement_strategy": "daily engagement routine (30-45 min)"
}`;

      try {
        const text = await callClaude({ model: SONNET, system: BRAND_SYSTEM_PROMPT, prompt, maxTokens: 4000 });
        const parsed = parseJsonResponse(text);
        if (!parsed) return json(res, { error: 'Failed to generate series templates', raw_preview: (text || '').slice(0, 300) }, 500);

        writeJSON('series-templates.json', { ...parsed, created_at: now() });
        return json(res, { ok: true, templates: parsed });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // GET /api/series-templates — get series templates
    if (pathname === '/api/series-templates' && method === 'GET') {
      return json(res, readJSON('series-templates.json', null));
    }

    // POST /api/content-bank/log — log a post as value or CTA
    if (pathname === '/api/content-bank/log' && method === 'POST') {
      const body = await parseBody(req);
      if (!body.content_id || !body.type) return json(res, { error: 'content_id and type (value|cta) required' }, 400);
      const bank = readJSON('content-bank.json', { log: [], stats: { value: 0, cta: 0 } });
      bank.log.push({ content_id: body.content_id, type: body.type, platform: body.platform || 'linkedin', posted_at: now() });
      if (body.type === 'value') bank.stats.value++;
      else if (body.type === 'cta') bank.stats.cta++;
      writeJSON('content-bank.json', bank);
      return json(res, { ok: true, stats: bank.stats });
    }

    // GET /api/content-bank — get content banking status
    if (pathname === '/api/content-bank' && method === 'GET') {
      const bank = readJSON('content-bank.json', { log: [], stats: { value: 0, cta: 0 } });
      const ratio = bank.stats.cta > 0 ? (bank.stats.value / bank.stats.cta).toFixed(1) : 'Infinity';
      const last10 = bank.log.slice(-10);
      const recentCtas = last10.filter(l => l.type === 'cta').length;
      const recentValue = last10.filter(l => l.type === 'value').length;

      let canAsk = true;
      let nextAction = 'value';
      // Amanda Natividad: 4-5 value posts per CTA
      if (recentCtas > 0 && recentValue / recentCtas < 4) {
        canAsk = false;
        nextAction = 'value';
      } else if (recentValue >= 4 && recentCtas === 0) {
        nextAction = 'cta';
      }

      return json(res, {
        ...bank,
        ratio: `${ratio}:1`,
        recent_10: last10,
        can_ask: canAsk,
        next_action: nextAction,
        recommendation: nextAction === 'cta'
          ? 'You have earned the right to include a CTA. Use a keyword-comment or resource offer tier.'
          : `Post ${4 - recentValue + recentCtas * 4} more value posts before your next CTA.`
      });
    }

    // POST /api/engagement/trigger-check — check if any content crossed engagement thresholds
    if (pathname === '/api/engagement/trigger-check' && method === 'POST') {
      const body = await parseBody(req);
      const threshold = body.threshold || 20;
      const content = readJSON('content.json', []);
      const published = readJSON('published.json', []);
      const triggered = [];

      for (const item of content) {
        const engData = item.engagement || {};
        const totalEng = (engData.likes || 0) + (engData.comments || 0) * 8 + (engData.shares || 0) * 3;
        if (totalEng >= threshold && !item._engagement_triggered) {
          triggered.push({
            content_id: item.id,
            title: item.trigger_title,
            total_engagement: totalEng,
            breakdown: engData,
            recommendation: totalEng >= 100
              ? 'Viral threshold — auto-generate all derivatives, amplify, create carousel'
              : totalEng >= 50
              ? 'Strong performer — generate carousel + YouTube pipeline'
              : 'Trending — generate Shorts clips and distribution plan'
          });
          item._engagement_triggered = true;
        }
      }

      if (triggered.length > 0) writeJSON('content.json', content);
      return json(res, { triggered, count: triggered.length, threshold });
    }

    // POST /api/content/:id/video-to-social — repurpose video script/transcript into social posts
    const v2sMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/video-to-social$/);
    if (v2sMatch && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const id = v2sMatch[1];
      const allContent = readJSON('content.json', []);
      const item = allContent.find(c => c.id === id);
      if (!item) return json(res, { error: 'Content not found' }, 404);

      const script = item.formats?.youtube_script?.content || '';
      if (!script) return json(res, { error: 'No YouTube script found for this content' }, 400);

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const { BRAND_SYSTEM_PROMPT } = require('./generator/content-writer');

      const prompt = `Repurpose this YouTube video script into social media posts. Extract the BEST moments.

Script: ${script.slice(0, 5000)}

Return JSON (no markdown fences):
{
  "linkedin_post": "full LinkedIn post (800-1300 chars) — pick the most compelling story/stat from the video",
  "x_thread": ["tweet 1 (280 chars)", "tweet 2", "tweet 3", "tweet 4", "tweet 5"],
  "x_single": "one punchy tweet (280 chars) — the single best insight",
  "carousel_hook": "carousel cover slide text (if this were a carousel, what's the hook?)",
  "hot_take": "contrarian take derived from the video (under 200 chars)",
  "pull_quotes": ["quotable line 1", "quotable line 2", "quotable line 3"],
  "key_stats": ["stat 1", "stat 2", "stat 3"]
}`;

      try {
        const text = await callClaude({ model: HAIKU, system: BRAND_SYSTEM_PROMPT, prompt, maxTokens: 3000 });
        const parsed = parseJsonResponse(text);
        if (!parsed) return json(res, { error: 'Failed to repurpose', raw_preview: (text || '').slice(0, 200) }, 500);
        return json(res, { ok: true, content_id: id, repurposed: parsed });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // POST /api/content/:id/comment-dm-cta — generate keyword-comment CTA variants
    const cdmMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/comment-dm-cta$/);
    if (cdmMatch && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const id = cdmMatch[1];
      const allContent = readJSON('content.json', []);
      const item = allContent.find(c => c.id === id);
      if (!item) return json(res, { error: 'Content not found' }, 404);

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const { BRAND_SYSTEM_PROMPT } = require('./generator/content-writer');
      const topic = item.trigger_title || 'Untitled';

      const prompt = `Create keyword-comment CTA variants for this content. The "comment KEYWORD" tactic is the highest-converting LinkedIn CTA pattern — it creates public engagement AND opens a DM channel.

Topic: ${topic}
Content: ${(item.formats?.linkedin?.content || '').slice(0, 1000)}

Return JSON (no markdown fences):
{
  "cta_variants": [
    {
      "keyword": "AUDIT",
      "cta_line": "Comment AUDIT and I'll send you a free analysis of your [specific thing].",
      "dm_first_message": "Hey! Here's the [resource] I mentioned. Quick question — [qualifying question]?",
      "dm_followup": "Did you get a chance to look at [resource]? Happy to jump on a quick call if you want to walk through it.",
      "lead_magnet_tie_in": "what free resource to deliver"
    }
  ],
  "pinned_comment": "text for pinned comment version",
  "description_cta": "text for LinkedIn description version",
  "best_keyword": "the recommended keyword to use"
}`;

      try {
        const text = await callClaude({ model: HAIKU, system: BRAND_SYSTEM_PROMPT, prompt, maxTokens: 2000 });
        const parsed = parseJsonResponse(text);
        if (!parsed) return json(res, { error: 'Failed to generate CTAs', raw_preview: (text || '').slice(0, 200) }, 500);
        return json(res, { ok: true, content_id: id, ...parsed });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // POST /api/content/:id/zero-click — rewrite content as zero-click (all value in feed, no link)
    const zcMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/zero-click$/);
    if (zcMatch && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const id = zcMatch[1];
      const allContent = readJSON('content.json', []);
      const item = allContent.find(c => c.id === id);
      if (!item) return json(res, { error: 'Content not found' }, 404);

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const { BRAND_SYSTEM_PROMPT } = require('./generator/content-writer');
      const source = item.formats?.blog?.content || item.formats?.linkedin?.content || '';

      const prompt = `Rewrite this content as a "zero-click" LinkedIn post. Zero-click content delivers ALL value in the feed itself — no links, no "read more at my blog", no external redirects.

Why: LinkedIn suppresses reach by 60% when you include external links. Zero-click posts get 8x more reach (Amanda Natividad / SparkToro).

Source content: ${source.slice(0, 3000)}

Return JSON (no markdown fences):
{
  "zero_click_post": "the full LinkedIn post (1000-2000 chars) that delivers all value in-feed",
  "soft_cta": "engagement CTA at the end (question, not a link)",
  "why_no_link": "brief explanation of why this works better without a link",
  "reach_estimate": "estimated reach multiplier vs linked version"
}`;

      try {
        const text = await callClaude({ model: HAIKU, system: BRAND_SYSTEM_PROMPT, prompt, maxTokens: 2000 });
        const parsed = parseJsonResponse(text);
        if (!parsed) return json(res, { error: 'Failed to generate', raw_preview: (text || '').slice(0, 200) }, 500);
        return json(res, { ok: true, content_id: id, ...parsed });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // --- Batch 51: Post Structure Wizard + Engagement Playbook + 1-to-20 Repurposer + Platform Optimizer ---

    // POST /api/content/:id/structure-wizard — generate post using proven structure
    const swMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/structure-wizard$/);
    if (swMatch && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const id = swMatch[1];
      const body = await parseBody(req);
      const structure = body.structure || 'lessons_learned'; // lessons_learned, contrarian, before_after, build_in_public, myth_buster

      const allContent = readJSON('content.json', []);
      const item = allContent.find(c => c.id === id);
      if (!item) return json(res, { error: 'Content not found' }, 404);

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const { BRAND_SYSTEM_PROMPT } = require('./generator/content-writer');
      const source = item.formats?.linkedin?.content || item.formats?.blog?.content || '';

      const structures = {
        lessons_learned: `Write using the LESSONS LEARNED LIST structure:
[Number] things I learned from [specific experience]:
1. [Lesson] — [Brief explanation]
2. [Lesson] — [Brief explanation]
...
The biggest surprise? [Unexpected insight].
End with: Comment "SEND" and I'll DM you [resource].`,
        contrarian: `Write using the CONTRARIAN TAKE structure:
Unpopular opinion: [Contrarian statement]
Most [audience] believe [conventional wisdom].
But here's what the data shows:
-> [Evidence 1] -> [Evidence 2] -> [Evidence 3]
End with: Agree or disagree? Drop your take below.`,
        before_after: `Write using the BEFORE/AFTER CASE STUDY structure:
[Time ago], [client/situation] was [painful situation].
Today, [impressive result].
The shift: [Key change 1] [Key change 2] [Key change 3]
We did this without [common expensive approach].
End with: If this sounds like your firm, link in comments.`,
        build_in_public: `Write using the BUILD-IN-PUBLIC structure:
Here's exactly what happened with [project] last month:
[Metric] went from X to Y. [Another metric] changed.
[Honest admission about what didn't work].
What we're changing: -> [Action 1] -> [Action 2]
End with: DM me "audit" for a free video review.`,
        myth_buster: `Write using the MYTH BUSTER structure:
[Number] [industry] myths I wish I'd stopped believing:
Myth 1: "[Common belief]" — Reality: [What actually works]
Myth 2: "[Common belief]" — Reality: [What actually works]
Myth 3: "[Common belief]" — Reality: [What actually works]
End with: Which surprised you?`
      };

      const prompt = `Rewrite this content using a proven LinkedIn post structure.

Source: ${source.slice(0, 2000)}
Topic: ${item.trigger_title}

${structures[structure] || structures.lessons_learned}

Return JSON (no markdown fences):
{
  "post": "the full LinkedIn post (800-1500 chars)",
  "structure_used": "${structure}",
  "hook": "the opening line",
  "cta_type": "conversation|keyword_comment|soft_dm",
  "estimated_engagement": "low|medium|high|viral"
}`;

      try {
        const text = await callClaude({ model: HAIKU, system: BRAND_SYSTEM_PROMPT, prompt, maxTokens: 2000 });
        const parsed = parseJsonResponse(text);
        if (!parsed) return json(res, { error: 'Failed to generate structured post', raw_preview: (text || '').slice(0, 200) }, 500);
        return json(res, { ok: true, content_id: id, ...parsed });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // GET /api/engagement-playbook — get daily engagement routine + strategy
    if (pathname === '/api/engagement-playbook' && method === 'GET') {
      const content = readJSON('content.json', []);
      const published = readJSON('published.json', []);
      const bank = readJSON('content-bank.json', { log: [], stats: { value: 0, cta: 0 } });

      const today = new Date();
      const dayOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][today.getDay()];
      const seriesTemplates = readJSON('series-templates.json', { series: [] });
      const todaySeries = (seriesTemplates.series || []).find(s => s.day === dayOfWeek);

      return json(res, {
        daily_routine: {
          pre_post: {
            time: '15 min before posting',
            actions: [
              'Comment thoughtfully on 5-10 posts from your ICP',
              'This "warms up" the algorithm before your post appears',
              'Focus on posts from larger accounts (50K+ followers)'
            ]
          },
          golden_hour: {
            time: 'First 90 minutes after posting',
            actions: [
              'Respond to every comment immediately',
              'Ask follow-up questions (turn comments into threads)',
              'Comments are weighted 8x more than likes by the algorithm'
            ]
          },
          drafting: {
            time: 'Daily (15-20 min)',
            actions: [
              'Find 3-5 posts from larger accounts in your space',
              'Leave a substantive comment adding value (data point, counter-perspective)',
              'This puts you in front of their audience'
            ]
          }
        },
        todays_series: todaySeries ? {
          name: todaySeries.name,
          format: todaySeries.format,
          hashtag: todaySeries.hashtag,
          cta_tier: todaySeries.cta_tier,
          example_topics: todaySeries.example_topics?.slice(0, 3)
        } : null,
        posting_rules: [
          'Never include external links in post body (60% reach penalty)',
          'Put links in comments or profile instead',
          'Optimal length: 1300-2000 characters for text posts',
          'Minimum 12-hour gap between posts',
          'Do not edit posts within first hour (resets algorithm)',
          '3-5 hashtags maximum',
          'Write at 4th grade reading level — short sentences, simple words',
          'Carousels get 6.60% engagement (highest format)',
          'Comments are weighted 15x more than likes'
        ],
        content_bank_status: {
          value_posts: bank.stats.value,
          cta_posts: bank.stats.cta,
          can_ask: bank.stats.cta === 0 || (bank.stats.value / bank.stats.cta) >= 4,
          recommendation: bank.stats.cta === 0 || (bank.stats.value / bank.stats.cta) >= 4
            ? 'You can include a CTA today'
            : 'Post value content today — save your CTA for later'
        },
        day_of_week: dayOfWeek,
        best_posting_time: ['tuesday', 'wednesday', 'thursday'].includes(dayOfWeek)
          ? '8:00-10:00 AM' : '12:00-2:00 PM'
      });
    }

    // POST /api/content/:id/atomize-20 — 1-to-20 derivative formula from pillar content
    const a20Match = pathname.match(/^\/api\/content\/([a-f0-9]+)\/atomize-20$/);
    if (a20Match && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const id = a20Match[1];
      const allContent = readJSON('content.json', []);
      const item = allContent.find(c => c.id === id);
      if (!item) return json(res, { error: 'Content not found' }, 404);

      const { callClaude, parseJsonResponse, SONNET } = require('./lib/claude');
      const { BRAND_SYSTEM_PROMPT } = require('./generator/content-writer');
      const source = item.formats?.blog?.content || item.formats?.linkedin?.content || item.formats?.youtube_script?.content || '';
      if (!source) return json(res, { error: 'No content to atomize' }, 400);

      const prompt = `Extract 15-20 derivative content pieces from this pillar content using the 1-to-20 formula.

Source: ${source.slice(0, 4000)}
Topic: ${item.trigger_title}

Extract across 4 tiers:

TIER 1 (Direct Extractions — no AI rewrite needed):
- Pull 3-5 standalone statistics as quote graphics
- Extract any numbered list as a carousel outline
- Pull the opening hook as a standalone X post

TIER 2 (AI-Reformatted):
- LinkedIn narrative post (story angle)
- LinkedIn hot take (controversial angle)
- X thread (5-7 tweets)
- X single tweet (punchiest stat)
- Short video script (30-60 sec)
- Poll post
- Before/after post

TIER 3 (Platform-Expanded):
- Newsletter edition outline
- YouTube script outline (5-8 min)
- Email nurture sequence (3 emails)

TIER 4 (Future Recycled):
- Contrarian response post
- "One year ago" repost angle
- Reader Q&A reframe

Return JSON (no markdown fences):
{
  "derivatives": [
    {
      "tier": 1,
      "type": "quote_graphic",
      "content": "the actual content",
      "platform": "linkedin|x|youtube|email|instagram",
      "schedule_day": "today|tomorrow|day3|week2|week4"
    }
  ],
  "total_pieces": N,
  "coverage_weeks": N,
  "original_topic": "..."
}`;

      try {
        const text = await callClaude({ model: SONNET, system: BRAND_SYSTEM_PROMPT, prompt, maxTokens: 6000 });
        const parsed = parseJsonResponse(text);
        if (!parsed) return json(res, { error: 'Failed to atomize', raw_preview: (text || '').slice(0, 300) }, 500);

        // Save atomization
        const atomizations = readJSON('atomizations.json', []);
        const entry = { id: generateId(), content_id: id, title: item.trigger_title, ...parsed, created_at: now() };
        atomizations.push(entry);
        writeJSON('atomizations.json', atomizations);
        return json(res, { ok: true, atomization: entry });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // GET /api/atomizations — list all atomizations
    if (pathname === '/api/atomizations' && method === 'GET') {
      return json(res, readJSON('atomizations.json', []));
    }

    // GET /api/platform-rules — get per-platform optimization rules
    if (pathname === '/api/platform-rules' && method === 'GET') {
      return json(res, {
        linkedin: {
          algorithm: '2025-2026',
          key_rules: [
            'Depth Score is the primary metric — dwell time, comment depth, carousel swipes',
            'External links suppress reach by 60% — use link-in-comments instead',
            'Comments are weighted 8-15x more than likes',
            'Carousels get highest engagement rate (6.60%)',
            'Personal profiles get 561% more reach than company pages',
            'Do not edit posts within first hour',
            'Optimal length: 1300-2000 characters',
            '3-5 hashtags max',
            'Write at 4th grade reading level',
            'Brand-building before selling: 2.3x better campaigns'
          ],
          best_times: { peak: 'Tue/Wed/Thu 8-10 AM', secondary: 'Mon/Fri 12-2 PM', avoid: 'Weekends (50% lower engagement)' },
          format_ranking: { carousel: '6.60%', document: '6.10%', multi_image: '6.60%', polls: '200% above avg reach', text: '2-3%', video: 'dropped 200% vs 2024' },
          cadence: { minimum: '3/week', optimal: '5/week (Mon-Fri)', max: 'daily', gap: '12+ hours between posts' }
        },
        x_twitter: {
          algorithm: '2025-2026',
          key_rules: [
            'Threads outperform single tweets for engagement',
            'Images increase engagement by 150%',
            'Threads should have 5-7 tweets for optimal performance',
            'First tweet is the hook — must be compelling standalone',
            'Use hashtags sparingly (1-2 max)',
            'Quote tweets with your own take outperform plain retweets'
          ],
          best_times: { peak: 'Mon-Fri 12-3 PM', secondary: 'Wed 9 AM', avoid: 'Late night' },
          cadence: { minimum: '3-5 tweets/day', optimal: '5-10 including retweets', max: 'no hard limit' }
        },
        youtube: {
          algorithm: '2025-2026',
          key_rules: [
            'YouTube AI now understands content from audio/visual — not just metadata',
            'Only 6% of top-ranking videos use exact keyword matches in titles',
            'Thumbnails with expressive faces get 20-30% higher CTR',
            'Mid-roll CTAs get more clicks than end-roll',
            'Chapters/timestamps help YouTube serve clips in search',
            'Upload accurate transcripts — AI reads them for content understanding',
            'Shorts attract, long-form converts'
          ],
          thumbnail_rules: { resolution: '1280x720', text: '3-5 words max', emotion: 'surprise/shock/concern/excitement', contrast: 'complementary colors' },
          best_format: { tutorial: '8-12 min', case_study: '10-15 min', breakdown: '12-20 min', shorts: '15-60 sec' },
          cadence: { long_form: '1-2/week', shorts: '3-5/week from long-form clips' }
        },
        email: {
          key_rules: [
            'Subject lines under 50 characters get highest open rates',
            'Personalized subject lines increase open rate by 26%',
            'Best send times: Tue/Wed/Thu 10 AM local',
            'Mobile-optimized is mandatory (60%+ opens on mobile)',
            'One clear CTA per email'
          ],
          cadence: { newsletter: '1/week', drip: 'daily for 5-7 days', nurture: '2-3/week' }
        }
      });
    }

    // --- Batch 52: Auto Calendar Builder + Email Sequences + Profile Optimizer + Social Proof Posts ---

    // POST /api/calendar/auto-build — auto-generate a full week using series + matrix + atomizations
    if (pathname === '/api/calendar/auto-build' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const { BRAND_SYSTEM_PROMPT } = require('./generator/content-writer');

      const series = readJSON('series-templates.json', { series: [] });
      const matrix = readJSON('content-matrix.json', null);
      const atomizations = readJSON('atomizations.json', []);
      const content = readJSON('content.json', []);
      const bank = readJSON('content-bank.json', { log: [], stats: { value: 0, cta: 0 } });

      // Determine CTA eligibility from bank
      const canAsk = bank.stats.cta === 0 || (bank.stats.value / bank.stats.cta) >= 4;

      // Build weekly plan combining all sources
      const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
      const weekPlan = [];

      for (const day of days) {
        const seriesForDay = (series.series || []).find(s => s.day === day);
        const matrixPosts = matrix?.pillars?.flatMap(p => p.concepts?.flatMap(c => c.posts || []) || []) || [];
        const unusedMatrix = matrixPosts.filter(p => !p._used);
        const randomMatrix = unusedMatrix.length > 0 ? unusedMatrix[Math.floor(Math.random() * unusedMatrix.length)] : null;

        // Check for pending atomization derivatives
        const pendingAtomizations = atomizations.flatMap(a => (a.derivatives || []).filter(d => d.schedule_day === day || d.schedule_day === 'tomorrow'));

        weekPlan.push({
          day,
          series: seriesForDay ? { name: seriesForDay.name, format: seriesForDay.format, hashtag: seriesForDay.hashtag, template_prompt: seriesForDay.template_prompt } : null,
          matrix_suggestion: randomMatrix ? { type: randomMatrix.type, hook: randomMatrix.hook } : null,
          atomization_available: pendingAtomizations.length > 0 ? pendingAtomizations[0] : null,
          cta_allowed: canAsk && day === 'wednesday', // One CTA per week, mid-week
          posting_time: ['tuesday', 'wednesday', 'thursday'].includes(day) ? '8:00-10:00 AM' : '12:00-2:00 PM'
        });
      }

      return json(res, {
        ok: true,
        week_plan: weekPlan,
        sources: {
          series_available: (series.series || []).length,
          matrix_posts_available: matrix?.total_posts || 0,
          atomizations_available: atomizations.reduce((s, a) => s + (a.derivatives?.length || 0), 0)
        },
        bank_status: { value: bank.stats.value, cta: bank.stats.cta, can_ask: canAsk }
      });
    }

    // POST /api/content/:id/email-sequence — generate email nurture sequence from content
    const emailSeqMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/email-sequence$/);
    if (emailSeqMatch && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const id = emailSeqMatch[1];
      const allContent = readJSON('content.json', []);
      const item = allContent.find(c => c.id === id);
      if (!item) return json(res, { error: 'Content not found' }, 404);

      const { callClaude, parseJsonResponse, SONNET } = require('./lib/claude');
      const { BRAND_SYSTEM_PROMPT } = require('./generator/content-writer');
      const source = item.formats?.blog?.content || item.formats?.linkedin?.content || '';

      const prompt = `Create a 5-email nurture sequence from this content. This is for people who downloaded a lead magnet or engaged with a post but haven't booked a call yet.

Topic: ${item.trigger_title}
Source: ${source.slice(0, 3000)}

Return JSON (no markdown fences):
{
  "sequence_name": "descriptive name",
  "target_audience": "who this sequence is for",
  "emails": [
    {
      "day": 1,
      "subject": "under 50 chars, personalized feel",
      "preview_text": "what shows after subject in inbox",
      "body": "full email (200-400 words, conversational tone, one key insight per email)",
      "cta": "specific action",
      "cta_type": "reply|link|book_call"
    }
  ],
  "expected_metrics": {
    "open_rate": "35-45%",
    "click_rate": "8-12%",
    "reply_rate": "5-8%",
    "booking_rate": "3-5%"
  },
  "send_schedule": "daily|every_other_day"
}`;

      try {
        const text = await callClaude({ model: SONNET, system: BRAND_SYSTEM_PROMPT, prompt, maxTokens: 5000 });
        const parsed = parseJsonResponse(text);
        if (!parsed) return json(res, { error: 'Failed to generate sequence', raw_preview: (text || '').slice(0, 300) }, 500);

        const sequences = readJSON('email-sequences.json', []);
        const seq = { id: generateId(), content_id: id, title: item.trigger_title, ...parsed, status: 'draft', created_at: now() };
        sequences.push(seq);
        writeJSON('email-sequences.json', sequences);
        return json(res, { ok: true, sequence: seq });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // GET /api/email-sequences — list all email sequences
    if (pathname === '/api/email-sequences' && method === 'GET') {
      return json(res, readJSON('email-sequences.json', []));
    }

    // POST /api/profile-optimizer — analyze LinkedIn profile and suggest improvements
    if (pathname === '/api/profile-optimizer' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const { callClaude, parseJsonResponse, SONNET } = require('./lib/claude');
      const { BRAND_SYSTEM_PROMPT } = require('./generator/content-writer');
      const body = await parseBody(req);

      const prompt = `Optimize a LinkedIn profile for a legal marketing agency owner. The profile should convert profile visitors into booked calls.

Current info:
Name: ${body.name || 'Mortar Metrics Founder'}
Headline: ${body.headline || 'Legal Marketing Agency'}
About: ${body.about || 'We help law firms grow.'}
Experience: ${body.experience || 'Marketing agency owner'}

Based on research from top B2B creators (Adam Robinson, Justin Welsh, Chris Walker), generate an optimized profile:

Return JSON (no markdown fences):
{
  "headline": {
    "current": "...",
    "optimized": "under 120 chars, includes ICP + result + proof",
    "why": "explanation"
  },
  "about_section": {
    "optimized": "2000 chars max, follows: Hook → Story → Proof → Offer → CTA format",
    "structure_notes": "what each paragraph does"
  },
  "featured_section": [
    { "type": "post|article|link", "title": "what to feature", "why": "why this converts" }
  ],
  "banner_image": {
    "text_suggestion": "what text to put on the banner",
    "design_notes": "design recommendations"
  },
  "cta_button": {
    "text": "Visit Website / Book a Call / etc",
    "url_suggestion": "where it should point"
  },
  "tips": [
    "specific actionable improvement"
  ]
}`;

      try {
        const text = await callClaude({ model: SONNET, system: BRAND_SYSTEM_PROMPT, prompt, maxTokens: 4000 });
        const parsed = parseJsonResponse(text);
        if (!parsed) return json(res, { error: 'Failed to optimize profile', raw_preview: (text || '').slice(0, 300) }, 500);
        return json(res, { ok: true, profile: parsed });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // POST /api/content/:id/social-proof-post — generate testimonial-style post from case study data
    const spPostMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/social-proof-post$/);
    if (spPostMatch && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const id = spPostMatch[1];
      const allContent = readJSON('content.json', []);
      const item = allContent.find(c => c.id === id);
      if (!item) return json(res, { error: 'Content not found' }, 404);

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const { BRAND_SYSTEM_PROMPT } = require('./generator/content-writer');
      const source = item.formats?.linkedin?.content || item.formats?.blog?.content || '';

      const prompt = `Extract social proof and create a results-focused testimonial-style post from this content.

Source: ${source.slice(0, 2000)}
Topic: ${item.trigger_title}

Case study posts are the #1 highest-converting format for booking calls on LinkedIn. Create a post that makes the reader think "I want that for my firm."

Return JSON (no markdown fences):
{
  "before_after_post": "full LinkedIn post showing transformation (before metrics → what changed → after metrics)",
  "results_snapshot": {
    "before": "pain state with numbers",
    "after": "success state with numbers",
    "timeframe": "how long",
    "investment": "what it cost/required"
  },
  "quote_graphic_text": "one-line quotable result for a graphic",
  "client_type": "what kind of firm/client this serves"
}`;

      try {
        const text = await callClaude({ model: HAIKU, system: BRAND_SYSTEM_PROMPT, prompt, maxTokens: 2000 });
        const parsed = parseJsonResponse(text);
        if (!parsed) return json(res, { error: 'Failed to generate', raw_preview: (text || '').slice(0, 200) }, 500);
        return json(res, { ok: true, content_id: id, ...parsed });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // GET /api/weekly-content-plan — generate comprehensive weekly plan combining all systems
    if (pathname === '/api/weekly-content-plan' && method === 'GET') {
      const series = readJSON('series-templates.json', { series: [] });
      const matrix = readJSON('content-matrix.json', null);
      const bank = readJSON('content-bank.json', { log: [], stats: { value: 0, cta: 0 } });
      const playbook = readJSON('engagement-playbook.json', null);

      const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
      const plan = days.map(day => {
        const s = (series.series || []).find(sr => sr.day === day);
        return {
          day,
          series_name: s?.name || null,
          format: s?.format || 'text',
          hashtag: s?.hashtag || null,
          cta_tier: s?.cta_tier || 'conversation',
          posting_time: ['tuesday', 'wednesday', 'thursday'].includes(day) ? '8-10 AM' : '12-2 PM',
          example_topic: s?.example_topics?.[0] || null,
          lead_magnet: s?.lead_magnet_cta || null
        };
      });

      return json(res, {
        plan,
        matrix_posts_remaining: matrix?.total_posts || 0,
        bank_balance: `${bank.stats.value} value, ${bank.stats.cta} CTA (${bank.stats.cta > 0 ? (bank.stats.value / bank.stats.cta).toFixed(1) : 'Infinity'}:1)`,
        notes: [
          'Post 5x/week (Mon-Fri) for optimal LinkedIn growth',
          'One CTA per week maximum (Wednesday recommended)',
          'Carousel on Monday for highest engagement format',
          'Story/transparency posts build most trust (Wednesday/Thursday)'
        ]
      });
    }

    // --- Batch 53: Content Repurposing Chain + Lead Magnet Funnels + Engagement Predictor + Calendar Export ---

    // POST /api/content/:id/repurpose-chain — full repurposing chain from one pillar piece
    const repChainMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/repurpose-chain$/);
    if (repChainMatch && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const id = repChainMatch[1];
      const allContent = readJSON('content.json', []);
      const item = allContent.find(c => c.id === id);
      if (!item) return json(res, { error: 'Content not found' }, 404);

      const { callClaude, parseJsonResponse, SONNET } = require('./lib/claude');
      const { BRAND_SYSTEM_PROMPT } = require('./generator/content-writer');

      // Find the longest format as the source
      const formats = item.formats || {};
      let sourceFmt = null, sourceText = '';
      for (const [k, v] of Object.entries(formats)) {
        const t = typeof v?.content === 'string' ? v.content : '';
        if (t.length > sourceText.length) { sourceFmt = k; sourceText = t; }
      }
      if (!sourceText || sourceText.length < 200) return json(res, { error: 'Need at least one format with 200+ chars to repurpose' }, 400);

      const prompt = `You are a content repurposing expert. Take this ${sourceFmt} content and create a full repurposing chain — each piece should feel NATIVE to its platform, not copy-pasted.

Source (${sourceFmt}): ${sourceText.slice(0, 4000)}
Topic: ${item.trigger_title}

Create ALL of the following in one response. Return JSON (no markdown fences):
{
  "linkedin_post": "full post (1200-1500 chars, hook + story + insight + CTA, no links)",
  "x_thread": ["tweet 1 (hook, under 280 chars)", "tweet 2", "tweet 3", "tweet 4", "tweet 5 (CTA)"],
  "x_single": "standalone tweet (under 280 chars, punchy insight)",
  "newsletter_intro": "email intro paragraph (150-200 words, personal tone, links to full content)",
  "youtube_short_script": "60-second script (hook in first 3 seconds, one key insight, CTA)",
  "carousel_outline": ["slide 1: hook", "slide 2-6: key points", "slide 7: CTA"],
  "poll_question": { "question": "under 140 chars", "options": ["opt1", "opt2", "opt3", "opt4"] },
  "quote_graphic": "one-sentence quotable insight for an image",
  "blog_seo_title": "SEO-optimized title for long-form version",
  "repurpose_notes": "what angle each piece takes and why"
}`;

      try {
        const text = await callClaude({ model: SONNET, system: BRAND_SYSTEM_PROMPT, prompt, maxTokens: 6000 });
        const parsed = parseJsonResponse(text);
        if (!parsed) return json(res, { error: 'Failed to generate chain', raw_preview: (text || '').slice(0, 300) }, 500);

        const chains = readJSON('repurpose-chains.json', []);
        const chain = { id: generateId(), content_id: id, title: item.trigger_title, source_format: sourceFmt, ...parsed, created_at: now() };
        chains.push(chain);
        writeJSON('repurpose-chains.json', chains);
        return json(res, { ok: true, chain });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // GET /api/repurpose-chains — list all repurposing chains
    if (pathname === '/api/repurpose-chains' && method === 'GET') {
      return json(res, readJSON('repurpose-chains.json', []));
    }

    // POST /api/lead-magnet-funnel — create a lead magnet funnel tracker
    if (pathname === '/api/lead-magnet-funnel' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const { BRAND_SYSTEM_PROMPT } = require('./generator/content-writer');
      const body = await parseBody(req);

      const prompt = `Design a lead magnet funnel for a legal marketing agency targeting law firm owners.

Topic: ${body.topic || 'Google Ads for law firms'}
Lead Magnet Type: ${body.type || 'checklist'}
Target Audience: ${body.audience || 'PI and family law firm owners spending $3K-$15K/month on ads'}

Return JSON (no markdown fences):
{
  "funnel_name": "descriptive name",
  "lead_magnet": {
    "title": "compelling title that promises a specific result",
    "format": "PDF checklist|calculator|audit template|swipe file",
    "description": "2-sentence pitch",
    "key_sections": ["section 1", "section 2", "section 3"]
  },
  "landing_page": {
    "headline": "benefit-focused, under 12 words",
    "subheadline": "specific outcome + timeframe",
    "bullet_points": ["benefit 1", "benefit 2", "benefit 3"],
    "social_proof": "what proof to include",
    "cta_button_text": "action text"
  },
  "email_followup": [
    { "delay_hours": 0, "subject": "...", "purpose": "deliver + quick win", "cta": "..." },
    { "delay_hours": 24, "subject": "...", "purpose": "expand on one insight", "cta": "..." },
    { "delay_hours": 72, "subject": "...", "purpose": "case study + book call", "cta": "..." }
  ],
  "promotion_posts": {
    "linkedin": "post that drives downloads without feeling salesy",
    "x_tweet": "tweet promoting the lead magnet"
  },
  "metrics_to_track": ["download rate", "email open rate", "call booking rate"]
}`;

      try {
        const text = await callClaude({ model: HAIKU, system: BRAND_SYSTEM_PROMPT, prompt, maxTokens: 3000 });
        const parsed = parseJsonResponse(text);
        if (!parsed) return json(res, { error: 'Failed to generate funnel', raw_preview: (text || '').slice(0, 300) }, 500);

        const funnels = readJSON('lead-magnet-funnels.json', []);
        const funnel = { id: generateId(), ...parsed, status: 'draft', downloads: 0, leads_converted: 0, created_at: now() };
        funnels.push(funnel);
        writeJSON('lead-magnet-funnels.json', funnels);
        return json(res, { ok: true, funnel });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // GET /api/lead-magnet-funnels — list all funnels
    if (pathname === '/api/lead-magnet-funnels' && method === 'GET') {
      return json(res, readJSON('lead-magnet-funnels.json', []));
    }

    // POST /api/content/:id/predict-engagement — predict engagement score before posting
    const engPredMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/predict-engagement$/);
    if (engPredMatch && method === 'POST') {
      const id = engPredMatch[1];
      const allContent = readJSON('content.json', []);
      const item = allContent.find(c => c.id === id);
      if (!item) return json(res, { error: 'Content not found' }, 404);
      const body = await parseBody(req);
      const formatKey = body.format || 'linkedin';
      const text = item.formats?.[formatKey]?.content || '';
      if (!text) return json(res, { error: 'No content for that format' }, 400);

      // Algorithm-based scoring (no AI needed — faster, cheaper)
      let score = 50; // base
      const factors = [];

      // Hook quality (first line)
      const firstLine = text.split('\n')[0] || '';
      if (firstLine.length < 80) { score += 5; factors.push({ factor: 'Short hook (under 80 chars)', impact: +5 }); }
      if (/\d/.test(firstLine)) { score += 8; factors.push({ factor: 'Numbers in hook', impact: +8 }); }
      if (/\?$/.test(firstLine.trim())) { score += 3; factors.push({ factor: 'Question hook', impact: +3 }); }
      if (/\$[\d,]+/.test(firstLine)) { score += 6; factors.push({ factor: 'Dollar amount in hook', impact: +6 }); }

      // Content structure
      const lines = text.split('\n').filter(l => l.trim());
      const avgLineLen = lines.reduce((s, l) => s + l.length, 0) / (lines.length || 1);
      if (avgLineLen < 60) { score += 5; factors.push({ factor: 'Short line lengths (scannable)', impact: +5 }); }
      if (lines.length >= 10 && lines.length <= 25) { score += 4; factors.push({ factor: 'Good length (10-25 lines)', impact: +4 }); }
      if (text.length > 2000) { score -= 5; factors.push({ factor: 'Too long (2000+ chars)', impact: -5 }); }

      // Engagement triggers
      if (/\b(agree|disagree|wrong|mistake|truth|secret|nobody|everyone)\b/i.test(text)) { score += 6; factors.push({ factor: 'Polarizing language', impact: +6 }); }
      if (/\b(story|happened|remember|year ago|last week|yesterday)\b/i.test(text)) { score += 5; factors.push({ factor: 'Story elements', impact: +5 }); }
      if (/\n\n/.test(text)) { score += 3; factors.push({ factor: 'White space breaks', impact: +3 }); }

      // CTA presence
      if (/\b(comment|share|repost|DM me|link in|drop a)\b/i.test(text)) { score += 4; factors.push({ factor: 'Has CTA', impact: +4 }); }

      // Platform-specific
      if (formatKey === 'linkedin' && text.includes('#')) { score -= 2; factors.push({ factor: 'Hashtags in body (put in comment)', impact: -2 }); }
      if (formatKey === 'linkedin' && /https?:\/\//.test(text)) { score -= 8; factors.push({ factor: 'External link (60% reach penalty)', impact: -8 }); }

      // Time-of-day bonus
      const hour = new Date().getHours();
      if (hour >= 8 && hour <= 10) { score += 3; factors.push({ factor: 'Posting during peak hours (8-10 AM)', impact: +3 }); }

      score = Math.max(0, Math.min(100, score));
      const verdict = score >= 75 ? 'High engagement predicted — post it' :
                      score >= 55 ? 'Moderate — consider hook improvements' :
                      'Low predicted engagement — rework before posting';

      return json(res, { ok: true, content_id: id, format: formatKey, engagement_score: score, verdict, factors: factors.sort((a, b) => b.impact - a.impact) });
    }

    // POST /api/calendar/export — export weekly calendar as CSV or Markdown
    if (pathname === '/api/calendar/export' && method === 'POST') {
      const body = await parseBody(req);
      const format = body.format || 'csv'; // 'csv' or 'markdown'
      const series = readJSON('series-templates.json', { series: [] });
      const plan = readJSON('content-bank.json', { log: [], stats: { value: 0, cta: 0 } });
      const weekPlan = (series.series || []);

      if (format === 'csv') {
        const rows = [['Day', 'Series', 'Format', 'Hashtag', 'CTA Tier', 'Post Time', 'Lead Magnet'].join(',')];
        for (const s of weekPlan) {
          rows.push([s.day, s.name, s.format, s.hashtag, s.cta_tier, ['tuesday', 'wednesday', 'thursday'].includes(s.day) ? '8-10 AM' : '12-2 PM', `"${(s.lead_magnet_cta || '').replace(/"/g, '""')}"`].join(','));
        }
        res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename=content-calendar.csv' });
        return res.end(rows.join('\n'));
      } else {
        const md = ['# Weekly Content Calendar\n'];
        for (const s of weekPlan) {
          md.push(`## ${s.day.charAt(0).toUpperCase() + s.day.slice(1)} — ${s.name}`);
          md.push(`- **Format:** ${s.format}`);
          md.push(`- **Hashtag:** ${s.hashtag}`);
          md.push(`- **CTA Tier:** ${s.cta_tier}`);
          md.push(`- **Post Time:** ${['tuesday', 'wednesday', 'thursday'].includes(s.day) ? '8-10 AM' : '12-2 PM'}`);
          if (s.lead_magnet_cta) md.push(`- **Lead Magnet:** ${s.lead_magnet_cta}`);
          md.push(`- **Template:** ${s.template_prompt?.slice(0, 100)}...`);
          md.push('');
        }
        md.push(`\n---\nBank Balance: ${plan.stats.value} value / ${plan.stats.cta} CTA`);
        res.writeHead(200, { 'Content-Type': 'text/markdown', 'Content-Disposition': 'attachment; filename=content-calendar.md' });
        return res.end(md.join('\n'));
      }
    }

    // POST /api/content/:id/thread-to-carousel — convert X thread to LinkedIn carousel
    const t2cMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/thread-to-carousel$/);
    if (t2cMatch && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const id = t2cMatch[1];
      const allContent = readJSON('content.json', []);
      const item = allContent.find(c => c.id === id);
      if (!item) return json(res, { error: 'Content not found' }, 404);

      const thread = item.formats?.x_thread?.content;
      if (!thread || !Array.isArray(thread)) return json(res, { error: 'No X thread found for this content' }, 400);

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const { BRAND_SYSTEM_PROMPT } = require('./generator/content-writer');

      const prompt = `Convert this X/Twitter thread into LinkedIn carousel slides. Each slide should be a single focused point with big text.

Thread:
${thread.map((t, i) => `Tweet ${i + 1}: ${t}`).join('\n')}

Return JSON (no markdown fences):
{
  "title": "carousel title",
  "slides": [
    { "slide_number": 1, "headline": "hook text (large)", "body": "supporting text (small)", "visual_note": "what image/icon to use" }
  ],
  "companion_post": "LinkedIn post to accompany the carousel document",
  "design_notes": "color scheme and font suggestions"
}`;

      try {
        const text = await callClaude({ model: HAIKU, system: BRAND_SYSTEM_PROMPT, prompt, maxTokens: 3000 });
        const parsed = parseJsonResponse(text);
        if (!parsed) return json(res, { error: 'Failed to convert', raw_preview: (text || '').slice(0, 200) }, 500);

        const carousels = readJSON('carousels.json', []);
        const carousel = { id: generateId(), content_id: id, title: parsed.title || item.trigger_title, ...parsed, source: 'thread_conversion', created_at: now() };
        carousels.push(carousel);
        writeJSON('carousels.json', carousels);
        return json(res, { ok: true, carousel });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // POST /api/content/:id/headline-variants — generate 10 headline/hook variants for testing
    const headlineMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/headline-variants$/);
    if (headlineMatch && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const id = headlineMatch[1];
      const allContent = readJSON('content.json', []);
      const item = allContent.find(c => c.id === id);
      if (!item) return json(res, { error: 'Content not found' }, 404);

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const body = await parseBody(req);
      const formatKey = body.format || 'linkedin';
      const text = item.formats?.[formatKey]?.content || '';
      const currentHook = text.split('\n')[0] || item.trigger_title;

      const prompt = `Generate 10 headline/hook variants for this content. Each should use a different proven hook formula.

Current hook: ${currentHook}
Topic: ${item.trigger_title}
Platform: ${formatKey}

Hook formulas to use:
1. Specific Number ("I audited 47 law firm ad accounts...")
2. Information Gap ("Most law firms don't know this about Google Ads...")
3. Contrarian ("Stop spending money on SEO. Here's why.")
4. Pain Point ("Your intake process is losing $4K/month. Here's proof.")
5. Social Proof ("How one PI firm went from $4K to $92K/month")
6. Question ("What's your cost per signed case? (Most firms can't answer this)")
7. Story Opener ("Last Tuesday, a firm owner called me furious...")
8. Before/After ("From 3 cases/month to 15 — same ad budget")
9. Challenge ("I bet your Google Ads account has at least 3 of these problems")
10. Curiosity Gap ("The $200/month tool that saved a firm $4,800/month")

Return JSON (no markdown fences):
{
  "variants": [
    { "hook": "the hook text (under 100 chars)", "formula": "which formula", "why": "why this works for this topic" }
  ],
  "recommended": 0
}`;

      try {
        const text2 = await callClaude({ model: HAIKU, prompt, maxTokens: 2000 });
        const parsed = parseJsonResponse(text2);
        if (!parsed) return json(res, { error: 'Failed to generate variants', raw_preview: (text2 || '').slice(0, 200) }, 500);
        return json(res, { ok: true, content_id: id, format: formatKey, current_hook: currentHook, ...parsed });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // GET /api/content-performance-report — aggregate content performance insights
    if (pathname === '/api/content-performance-report' && method === 'GET') {
      const content = readJSON('content.json', []);
      const bank = readJSON('content-bank.json', { log: [], stats: { value: 0, cta: 0 } });
      const atomizations = readJSON('atomizations.json', []);
      const chains = readJSON('repurpose-chains.json', []);
      const sequences = readJSON('email-sequences.json', []);
      const pipelines = readJSON('youtube-pipelines.json', []);
      const carousels = readJSON('carousels.json', []);
      const matrix = readJSON('content-matrix.json', null);

      // Format distribution
      const formatCounts = {};
      for (const c of content) {
        for (const fmt of Object.keys(c.formats || {})) {
          formatCounts[fmt] = (formatCounts[fmt] || 0) + 1;
        }
      }

      // Status distribution
      const statusCounts = {};
      for (const c of content) {
        statusCounts[c.status] = (statusCounts[c.status] || 0) + 1;
      }

      // Content age (days since creation)
      const now2 = Date.now();
      const ages = content.map(c => Math.floor((now2 - new Date(c.created_at || 0).getTime()) / 86400000));
      const avgAge = ages.length > 0 ? (ages.reduce((s, a) => s + a, 0) / ages.length).toFixed(1) : 0;

      // Repurposing efficiency
      const totalFormats = Object.values(formatCounts).reduce((s, c) => s + c, 0);
      const repurposeRatio = content.length > 0 ? (totalFormats / content.length).toFixed(1) : 0;

      return json(res, {
        total_content: content.length,
        status_breakdown: statusCounts,
        format_breakdown: formatCounts,
        repurpose_ratio: `${repurposeRatio} formats per trigger`,
        avg_content_age_days: avgAge,
        bank_balance: bank.stats,
        bank_ratio: bank.stats.cta > 0 ? (bank.stats.value / bank.stats.cta).toFixed(1) + ':1' : 'No CTAs yet',
        atomizations_total: atomizations.length,
        derivatives_total: atomizations.reduce((s, a) => s + (a.derivatives?.length || 0), 0),
        repurpose_chains: chains.length,
        email_sequences: sequences.length,
        youtube_pipelines: pipelines.length,
        carousels: carousels.length,
        matrix_posts: matrix?.total_posts || 0,
        recommendations: [
          bank.stats.value < 4 ? 'Post more value content before asking (need 4:1 ratio)' : null,
          atomizations.length === 0 ? 'Atomize a blog post to get 15-20 derivative pieces' : null,
          pipelines.length === 0 ? 'Create a YouTube pipeline from your best content' : null,
          chains.length === 0 ? 'Use repurpose chains to maximize each piece of content' : null,
          sequences.length === 0 ? 'Build email sequences for lead magnet follow-up' : null,
          content.filter(c => c.status === 'review').length > 10 ? 'Review backlog growing — approve or reject pending content' : null
        ].filter(Boolean)
      });
    }

    // --- Batch 54: Content Pillars + Competitor Monitor + Auto-Nurture + Trending Topics + Authority Builder ---

    // POST /api/content-pillars/generate — generate strategic content pillars based on business goals
    if (pathname === '/api/content-pillars/generate' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const { callClaude, parseJsonResponse, SONNET } = require('./lib/claude');
      const { BRAND_SYSTEM_PROMPT } = require('./generator/content-writer');
      const body = await parseBody(req);

      const prompt = `Design 5 strategic content pillars for a legal marketing agency (Mortar Metrics) that targets law firm owners.

Business goals: ${body.goals || 'Book 10 discovery calls/month from LinkedIn content'}
Target audience: ${body.audience || 'PI, family law, and criminal defense firm owners doing $500K-$3M/year'}
Current services: ${body.services || 'Google Ads management, call tracking, intake optimization, website redesign'}

Each pillar should have a clear PURPOSE (educate, build trust, create desire, handle objections, or convert).

Return JSON (no markdown fences):
{
  "pillars": [
    {
      "name": "pillar name (2-4 words)",
      "purpose": "educate|trust|desire|objections|convert",
      "description": "what this pillar covers and why",
      "content_ratio": "what % of content should be this pillar",
      "formats": ["best formats for this pillar"],
      "example_topics": ["topic 1", "topic 2", "topic 3", "topic 4", "topic 5"],
      "buyer_journey_stage": "awareness|consideration|decision",
      "kpis": ["what to measure for this pillar"]
    }
  ],
  "posting_mix": "how to distribute across the week",
  "funnel_flow": "how pillars connect to move someone from follower to client"
}`;

      try {
        const text = await callClaude({ model: SONNET, system: BRAND_SYSTEM_PROMPT, prompt, maxTokens: 5000 });
        const parsed = parseJsonResponse(text);
        if (!parsed) return json(res, { error: 'Failed to generate pillars', raw_preview: (text || '').slice(0, 300) }, 500);

        writeJSON('content-pillars.json', { ...parsed, generated_at: now() });
        return json(res, { ok: true, ...parsed });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // GET /api/content-pillars — get generated content pillars
    if (pathname === '/api/content-pillars' && method === 'GET') {
      return json(res, readJSON('content-pillars.json', null));
    }

    // POST /api/competitor-analysis — analyze competitor content strategy
    if (pathname === '/api/competitor-analysis' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const body = await parseBody(req);

      // Pull recent competitor triggers from our scraper data
      const triggers = readJSON('trigger-queue.json', []);
      const compTriggers = triggers.filter(t => t.source === 'competitor' || t.competitive_angle).slice(0, 20);
      const compSummary = compTriggers.map(t => `- ${t.title} (${t.source_name || t.url || 'competitor'})`).join('\n');

      const prompt = `Analyze competitor content strategy based on their recent posts. Identify gaps we can exploit.

Our competitors' recent content:
${compSummary || 'No competitor data available yet — analyze based on typical legal marketing agency content.'}

Our brand: Mortar Metrics — data-driven, direct, no-BS legal marketing.

Return JSON (no markdown fences):
{
  "competitor_themes": ["theme 1 they focus on", "theme 2", "theme 3"],
  "content_gaps": ["topic they miss that we should own", "gap 2", "gap 3"],
  "differentiation_angles": ["how to position differently", "angle 2"],
  "counter_posts": [
    { "competitor_claim": "what they're saying", "our_counter": "our contrarian angle", "post_hook": "hook for our post" }
  ],
  "trending_in_space": ["what's hot in legal marketing content"],
  "steal_worthy": ["formats or approaches worth adapting"]
}`;

      try {
        const text = await callClaude({ model: HAIKU, prompt, maxTokens: 3000 });
        const parsed = parseJsonResponse(text);
        if (!parsed) return json(res, { error: 'Failed to analyze', raw_preview: (text || '').slice(0, 200) }, 500);

        const analyses = readJSON('competitor-analyses.json', []);
        analyses.push({ id: generateId(), ...parsed, triggers_analyzed: compTriggers.length, created_at: now() });
        if (analyses.length > 20) analyses.splice(0, analyses.length - 20);
        writeJSON('competitor-analyses.json', analyses);
        return json(res, { ok: true, ...parsed });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // GET /api/competitor-analyses — get recent competitor analyses
    if (pathname === '/api/competitor-analyses' && method === 'GET') {
      return json(res, readJSON('competitor-analyses.json', []));
    }

    // POST /api/content/:id/nurture-touchpoints — generate multi-touch nurture campaign from content
    const nurtureMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/nurture-touchpoints$/);
    if (nurtureMatch && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const id = nurtureMatch[1];
      const allContent = readJSON('content.json', []);
      const item = allContent.find(c => c.id === id);
      if (!item) return json(res, { error: 'Content not found' }, 404);

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const { BRAND_SYSTEM_PROMPT } = require('./generator/content-writer');
      const source = Object.values(item.formats || {}).map(f => typeof f?.content === 'string' ? f.content : '').sort((a, b) => b.length - a.length)[0] || '';

      const prompt = `Create a 14-day multi-channel nurture campaign based on this content. Someone engaged with this topic — now we guide them to a call.

Topic: ${item.trigger_title}
Content: ${source.slice(0, 2000)}

Each touchpoint should feel natural, not salesy. Build trust through value, then invite a conversation.

Return JSON (no markdown fences):
{
  "campaign_name": "descriptive name",
  "touchpoints": [
    {
      "day": 1,
      "channel": "linkedin_post|email|dm|comment|story",
      "action": "what to post/send",
      "content_snippet": "first 2-3 lines or subject line",
      "intent": "educate|relate|prove|convert",
      "call_to_action": "soft CTA if any"
    }
  ],
  "conversion_trigger": "what signal means they're ready for a call",
  "expected_timeline": "days to conversion"
}`;

      try {
        const text = await callClaude({ model: HAIKU, system: BRAND_SYSTEM_PROMPT, prompt, maxTokens: 3000 });
        const parsed = parseJsonResponse(text);
        if (!parsed) return json(res, { error: 'Failed to generate', raw_preview: (text || '').slice(0, 200) }, 500);

        const nurtures = readJSON('nurture-campaigns.json', []);
        nurtures.push({ id: generateId(), content_id: id, title: item.trigger_title, ...parsed, status: 'draft', created_at: now() });
        writeJSON('nurture-campaigns.json', nurtures);
        return json(res, { ok: true, campaign: nurtures[nurtures.length - 1] });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // GET /api/nurture-campaigns — list all nurture campaigns
    if (pathname === '/api/nurture-campaigns' && method === 'GET') {
      return json(res, readJSON('nurture-campaigns.json', []));
    }

    // POST /api/trending-angles — find trending angles to create content about right now
    if (pathname === '/api/trending-angles' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');

      // Pull recent triggers for context
      const triggers = readJSON('trigger-queue.json', []);
      const recent = triggers.filter(t => {
        const age = Date.now() - new Date(t.created_at || 0).getTime();
        return age < 7 * 86400000; // last 7 days
      }).slice(0, 15);
      const recentSummary = recent.map(t => `- ${t.title} (${t.source || 'unknown'})`).join('\n');

      const prompt = `Based on recent legal marketing news and trends, identify 8 hot angles Mortar Metrics should create content about THIS WEEK.

Recent triggers from our scrapers:
${recentSummary || 'No recent triggers — generate based on current legal marketing trends.'}

For each angle, explain why it's timely and give a ready-to-use hook.

Return JSON (no markdown fences):
{
  "trending_angles": [
    {
      "angle": "the topic/angle",
      "why_now": "why this is timely",
      "hook": "ready-to-post hook (under 100 chars)",
      "format": "best format (linkedin|carousel|video|thread|hot_take)",
      "urgency": "high|medium|low",
      "tie_to_service": "how this connects to our services"
    }
  ],
  "content_calendar_suggestion": "which angles to post which days this week"
}`;

      try {
        const text = await callClaude({ model: HAIKU, prompt, maxTokens: 3000 });
        const parsed = parseJsonResponse(text);
        if (!parsed) return json(res, { error: 'Failed to find trends', raw_preview: (text || '').slice(0, 200) }, 500);
        return json(res, { ok: true, ...parsed, triggers_analyzed: recent.length });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // POST /api/authority-builder — generate thought leadership positioning plan
    if (pathname === '/api/authority-builder' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const { callClaude, parseJsonResponse, SONNET } = require('./lib/claude');
      const { BRAND_SYSTEM_PROMPT } = require('./generator/content-writer');
      const body = await parseBody(req);

      const content = readJSON('content.json', []);
      const published = readJSON('published.json', []);
      const bank = readJSON('content-bank.json', { log: [], stats: { value: 0, cta: 0 } });

      const prompt = `Create a 90-day thought leadership positioning plan for Mortar Metrics on LinkedIn.

Current state:
- ${content.length} pieces of content created
- ${published.length} published
- Content bank: ${bank.stats.value} value posts, ${bank.stats.cta} CTA posts
- Focus: ${body.focus || 'Becoming the go-to expert for law firm Google Ads and intake optimization'}

Build a plan that positions the founder as THE authority in legal marketing. Think Gary Vee's playbook but for B2B legal services.

Return JSON (no markdown fences):
{
  "positioning_statement": "one sentence that defines the authority position",
  "core_narrative": "the 2-3 paragraph story that everything ties back to",
  "month_1": {
    "theme": "month theme",
    "goal": "specific goal",
    "content_focus": ["what to post about"],
    "key_actions": ["action 1", "action 2", "action 3"],
    "milestone": "what success looks like"
  },
  "month_2": { "theme": "...", "goal": "...", "content_focus": [], "key_actions": [], "milestone": "..." },
  "month_3": { "theme": "...", "goal": "...", "content_focus": [], "key_actions": [], "milestone": "..." },
  "signature_content": [
    { "type": "recurring series|signature post|pillar content", "name": "...", "description": "...", "frequency": "..." }
  ],
  "engagement_targets": {
    "month_1": { "posts_per_week": 5, "comments_per_day": 10, "dms_per_week": 5, "target_followers": "..." },
    "month_2": { "posts_per_week": 5, "comments_per_day": 15, "dms_per_week": 10, "target_followers": "..." },
    "month_3": { "posts_per_week": 5, "comments_per_day": 20, "dms_per_week": 15, "target_followers": "..." }
  }
}`;

      try {
        const text = await callClaude({ model: SONNET, system: BRAND_SYSTEM_PROMPT, prompt, maxTokens: 5000 });
        const parsed = parseJsonResponse(text);
        if (!parsed) return json(res, { error: 'Failed to generate', raw_preview: (text || '').slice(0, 300) }, 500);

        writeJSON('authority-plan.json', { ...parsed, generated_at: now() });
        return json(res, { ok: true, ...parsed });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // GET /api/authority-plan — get the authority builder plan
    if (pathname === '/api/authority-plan' && method === 'GET') {
      return json(res, readJSON('authority-plan.json', null));
    }

    // POST /api/content/:id/micro-content — extract micro-content pieces (quotes, stats, insights)
    const microMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/micro-content$/);
    if (microMatch && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const id = microMatch[1];
      const allContent = readJSON('content.json', []);
      const item = allContent.find(c => c.id === id);
      if (!item) return json(res, { error: 'Content not found' }, 404);

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const source = Object.values(item.formats || {}).map(f => typeof f?.content === 'string' ? f.content : '').sort((a, b) => b.length - a.length)[0] || '';
      if (source.length < 100) return json(res, { error: 'Not enough content to extract micro-content' }, 400);

      const prompt = `Extract micro-content pieces from this content. Each piece should work standalone as a social post, graphic, or caption.

Source: ${source.slice(0, 3000)}
Topic: ${item.trigger_title}

Return JSON (no markdown fences):
{
  "quotes": ["quotable line 1 (under 100 chars)", "quote 2", "quote 3"],
  "stats": ["stat with context", "stat 2"],
  "one_liners": ["punchy one-liner for X/Twitter", "one-liner 2", "one-liner 3"],
  "graphic_text": ["text for image graphic 1", "text 2"],
  "story_hooks": ["story opening that creates curiosity", "hook 2"],
  "controversial_takes": ["hot take that starts debate", "take 2"],
  "total_pieces": 0
}`;

      try {
        const text = await callClaude({ model: HAIKU, prompt, maxTokens: 2000 });
        const parsed = parseJsonResponse(text);
        if (!parsed) return json(res, { error: 'Failed to extract', raw_preview: (text || '').slice(0, 200) }, 500);
        parsed.total_pieces = (parsed.quotes?.length || 0) + (parsed.stats?.length || 0) + (parsed.one_liners?.length || 0) + (parsed.graphic_text?.length || 0) + (parsed.story_hooks?.length || 0) + (parsed.controversial_takes?.length || 0);
        return json(res, { ok: true, content_id: id, ...parsed });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // --- Batch 55: Content Flywheel + Smart Scheduling + Audience Segmentation + Content Grading + Batch Generator ---

    // POST /api/content-flywheel — analyze content performance and recommend next actions
    if (pathname === '/api/content-flywheel' && method === 'POST') {
      const content = readJSON('content.json', []);
      const bank = readJSON('content-bank.json', { log: [], stats: { value: 0, cta: 0 } });
      const series = readJSON('series-templates.json', { series: [] });
      const atomizations = readJSON('atomizations.json', []);
      const chains = readJSON('repurpose-chains.json', []);
      const sequences = readJSON('email-sequences.json', []);
      const funnels = readJSON('lead-magnet-funnels.json', []);
      const nurtures = readJSON('nurture-campaigns.json', []);
      const pillars = readJSON('content-pillars.json', null);

      // Calculate flywheel metrics
      const approved = content.filter(c => c.status === 'approved').length;
      const review = content.filter(c => c.status === 'review').length;
      const totalFormats = content.reduce((s, c) => s + Object.keys(c.formats || {}).length, 0);
      const derivativesTotal = atomizations.reduce((s, a) => s + (a.derivatives?.length || 0), 0);

      // Calculate content velocity (pieces per day)
      const dates = content.map(c => new Date(c.created_at || 0).getTime()).filter(d => d > 0).sort();
      const daySpan = dates.length >= 2 ? (dates[dates.length - 1] - dates[0]) / 86400000 : 1;
      const velocity = (content.length / Math.max(daySpan, 1)).toFixed(1);

      // Flywheel stages
      const stages = [
        { stage: 'Create', metric: content.length, label: 'pieces', health: content.length >= 20 ? 'green' : content.length >= 10 ? 'yellow' : 'red' },
        { stage: 'Repurpose', metric: chains.length + atomizations.length, label: 'chains + atomizations', health: (chains.length + atomizations.length) >= 5 ? 'green' : (chains.length + atomizations.length) >= 2 ? 'yellow' : 'red' },
        { stage: 'Distribute', metric: approved, label: 'ready to post', health: approved >= 10 ? 'green' : approved >= 5 ? 'yellow' : 'red' },
        { stage: 'Nurture', metric: sequences.length + nurtures.length, label: 'sequences + campaigns', health: (sequences.length + nurtures.length) >= 3 ? 'green' : (sequences.length + nurtures.length) >= 1 ? 'yellow' : 'red' },
        { stage: 'Convert', metric: funnels.length, label: 'funnels', health: funnels.length >= 2 ? 'green' : funnels.length >= 1 ? 'yellow' : 'red' }
      ];

      // Next actions based on weakest stage
      const weakest = stages.find(s => s.health === 'red') || stages.find(s => s.health === 'yellow');
      const actions = [];
      if (review > approved * 2) actions.push({ priority: 'high', action: 'Review and approve content', reason: `${review} pieces pending review vs ${approved} approved` });
      if (chains.length === 0 && content.length >= 5) actions.push({ priority: 'high', action: 'Create a repurpose chain', reason: 'No chains yet — repurposing multiplies every piece 9x' });
      if (sequences.length === 0 && approved >= 3) actions.push({ priority: 'medium', action: 'Build an email sequence', reason: 'No email sequences — leads need nurturing after engagement' });
      if (funnels.length === 0) actions.push({ priority: 'medium', action: 'Design a lead magnet funnel', reason: 'No funnels — content without a funnel has no conversion path' });
      if (!pillars) actions.push({ priority: 'low', action: 'Generate content pillars', reason: 'Pillars provide strategic direction for all content' });
      if (bank.stats.value < 4 && bank.stats.cta > 0) actions.push({ priority: 'high', action: 'Post more value content', reason: `Bank ratio: ${(bank.stats.value / bank.stats.cta).toFixed(1)}:1 (need 4:1)` });

      return json(res, {
        ok: true,
        flywheel: {
          stages,
          overall_health: stages.every(s => s.health === 'green') ? 'thriving' : stages.some(s => s.health === 'red') ? 'needs_work' : 'growing',
          velocity: `${velocity} pieces/day`,
          total_derivative_pieces: derivativesTotal + (chains.length * 9),
          content_multiplier: content.length > 0 ? ((totalFormats + derivativesTotal) / content.length).toFixed(1) + 'x' : '0x'
        },
        next_actions: actions.sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.priority] || 3) - ({ high: 0, medium: 1, low: 2 }[b.priority] || 3)),
        weakest_stage: weakest ? weakest.stage : null
      });
    }

    // POST /api/smart-schedule — intelligently schedule content for optimal times
    if (pathname === '/api/smart-schedule' && method === 'POST') {
      const content = readJSON('content.json', []);
      const series = readJSON('series-templates.json', { series: [] });
      const bank = readJSON('content-bank.json', { log: [], stats: { value: 0, cta: 0 } });
      const body = await parseBody(req);
      const daysAhead = body.days || 7;

      // Get approved + unscheduled content
      const unscheduled = content.filter(c => c.status === 'approved' && !c.scheduled_at);
      if (unscheduled.length === 0) return json(res, { error: 'No approved unscheduled content to schedule' }, 400);

      // Build schedule
      const schedule = [];
      const today = new Date();
      const canAsk = bank.stats.cta === 0 || (bank.stats.value / bank.stats.cta) >= 4;

      for (let d = 0; d < daysAhead; d++) {
        const date = new Date(today);
        date.setDate(date.getDate() + d);
        const dayOfWeek = date.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();

        // Skip weekends (LinkedIn dead zone)
        if (['saturday', 'sunday'].includes(dayOfWeek)) continue;

        // Find series for this day
        const daysSeries = (series.series || []).find(s => s.day === dayOfWeek);
        const postTime = ['tuesday', 'wednesday', 'thursday'].includes(dayOfWeek) ? '08:00' : '12:00';

        // Pick best content for this slot
        const candidate = unscheduled.find(c => {
          if (daysSeries) {
            // Match format if series exists
            const fmts = Object.keys(c.formats || {});
            return fmts.includes(daysSeries.format) || fmts.includes('linkedin') || fmts.includes('x_single');
          }
          return true;
        });

        if (candidate) {
          const idx = unscheduled.indexOf(candidate);
          unscheduled.splice(idx, 1);

          schedule.push({
            content_id: candidate.id,
            title: (candidate.trigger_title || '').slice(0, 60),
            date: date.toISOString().slice(0, 10),
            day: dayOfWeek,
            time: postTime,
            series: daysSeries?.name || null,
            format: daysSeries?.format || Object.keys(candidate.formats || {})[0] || 'linkedin',
            is_cta: canAsk && dayOfWeek === 'wednesday' && d >= 4 // Only CTA after 4 value posts
          });
        }
      }

      return json(res, { ok: true, schedule, total_scheduled: schedule.length, unscheduled_remaining: unscheduled.length });
    }

    // POST /api/audience-segments — define audience segments for targeted content
    if (pathname === '/api/audience-segments' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const { BRAND_SYSTEM_PROMPT } = require('./generator/content-writer');
      const body = await parseBody(req);

      const prompt = `Define 5 audience segments for Mortar Metrics' content strategy. Each segment needs different messaging and content.

Target market: ${body.market || 'Law firm owners in the US (PI, family law, criminal defense) doing $500K-$5M/year'}

Return JSON (no markdown fences):
{
  "segments": [
    {
      "name": "segment name (2-3 words)",
      "description": "who they are",
      "pain_points": ["pain 1", "pain 2"],
      "content_that_resonates": ["what content type works"],
      "conversion_trigger": "what makes them buy",
      "objections": ["common objection"],
      "messaging_tone": "how to talk to them",
      "linkedin_behavior": "how they use LinkedIn",
      "estimated_size": "what % of audience"
    }
  ]
}`;

      try {
        const text = await callClaude({ model: HAIKU, system: BRAND_SYSTEM_PROMPT, prompt, maxTokens: 3000 });
        const parsed = parseJsonResponse(text);
        if (!parsed) return json(res, { error: 'Failed to segment', raw_preview: (text || '').slice(0, 200) }, 500);

        writeJSON('audience-segments.json', { ...parsed, generated_at: now() });
        return json(res, { ok: true, ...parsed });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // GET /api/audience-segments — get audience segments
    if (pathname === '/api/audience-segments' && method === 'GET') {
      return json(res, readJSON('audience-segments.json', null));
    }

    // POST /api/content/:id/grade — comprehensive AI-powered content grading
    const gradeMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/grade$/);
    if (gradeMatch && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const id = gradeMatch[1];
      const allContent = readJSON('content.json', []);
      const item = allContent.find(c => c.id === id);
      if (!item) return json(res, { error: 'Content not found' }, 404);

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const body = await parseBody(req);
      const formatKey = body.format || 'linkedin';
      const text = typeof item.formats?.[formatKey]?.content === 'string' ? item.formats[formatKey].content : '';
      if (!text) return json(res, { error: 'No content for format' }, 400);

      const prompt = `Grade this ${formatKey} content on a scale of A+ to F. Be brutally honest.

Content: ${text.slice(0, 2000)}

Grade on these criteria (each /20):
1. Hook strength — does the first line stop the scroll?
2. Value density — is every sentence worth reading?
3. Readability — short sentences, white space, scannable?
4. Authenticity — does it sound like a real person, not AI?
5. CTA effectiveness — is there a clear next step?

Return JSON (no markdown fences):
{
  "overall_grade": "A+|A|B+|B|C+|C|D|F",
  "overall_score": 0,
  "criteria": {
    "hook": { "score": 0, "grade": "A-F", "feedback": "specific feedback" },
    "value": { "score": 0, "grade": "A-F", "feedback": "..." },
    "readability": { "score": 0, "grade": "A-F", "feedback": "..." },
    "authenticity": { "score": 0, "grade": "A-F", "feedback": "..." },
    "cta": { "score": 0, "grade": "A-F", "feedback": "..." }
  },
  "top_issue": "the #1 thing to fix",
  "rewrite_suggestion": "rewritten first 2-3 lines showing improvement"
}`;

      try {
        const text2 = await callClaude({ model: HAIKU, prompt, maxTokens: 2000 });
        const parsed = parseJsonResponse(text2);
        if (!parsed) return json(res, { error: 'Failed to grade', raw_preview: (text2 || '').slice(0, 200) }, 500);

        // Save grade to content item
        const idx = allContent.findIndex(c => c.id === id);
        if (idx >= 0) {
          if (!allContent[idx].grades) allContent[idx].grades = {};
          allContent[idx].grades[formatKey] = { ...parsed, graded_at: now() };
          writeJSON('content.json', allContent);
        }
        return json(res, { ok: true, content_id: id, format: formatKey, ...parsed });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // POST /api/batch-generate — generate content for multiple triggers at once
    if (pathname === '/api/batch-generate' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const body = await parseBody(req);
      const count = Math.min(body.count || 5, 10);
      const format = body.format || 'linkedin';

      const triggers = readJSON('trigger-queue.json', []);
      const pending = triggers.filter(t => t.status === 'pending').slice(0, count);
      if (pending.length === 0) return json(res, { error: 'No pending triggers to generate from' }, 400);

      // Generate in parallel (up to 3 concurrent)
      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const { BRAND_SYSTEM_PROMPT } = require('./generator/content-writer');
      const allContent = readJSON('content.json', []);
      const results = [];

      for (const trigger of pending) {
        try {
          const prompt = `Write a ${format} post about this topic. Make it actionable, data-driven, and direct.

Topic: ${trigger.title}
${trigger.summary ? `Summary: ${trigger.summary.slice(0, 500)}` : ''}

${format === 'linkedin' ? 'Format: LinkedIn post (1200-1500 chars, hook + story + insight + soft CTA, no external links)' : ''}
${format === 'x_single' ? 'Format: Tweet (under 280 chars, punchy and quotable)' : ''}
${format === 'hot_take' ? 'Format: Contrarian hot take (500-800 chars, bold opinion with evidence)' : ''}

Write the post directly. No JSON wrapper needed.`;

          const text = await callClaude({ model: HAIKU, system: BRAND_SYSTEM_PROMPT, prompt, maxTokens: 1500 });
          if (text && text.length > 50) {
            const id = generateId();
            allContent.push({
              id,
              trigger_id: trigger.id,
              trigger_title: trigger.title,
              formats: { [format]: { content: text.trim(), status: 'review', generated_at: now() } },
              status: 'review',
              created_at: now()
            });
            results.push({ id, title: trigger.title, format, chars: text.length, status: 'ok' });
          }
        } catch (err) {
          results.push({ title: trigger.title, status: 'error', error: err.message });
        }
      }

      writeJSON('content.json', allContent);
      return json(res, { ok: true, generated: results.filter(r => r.status === 'ok').length, failed: results.filter(r => r.status === 'error').length, results });
    }

    // GET /api/content-velocity — content production velocity metrics
    if (pathname === '/api/content-velocity' && method === 'GET') {
      const content = readJSON('content.json', []);

      // Group by day
      const byDay = {};
      for (const c of content) {
        const day = (c.created_at || '').slice(0, 10);
        if (day) byDay[day] = (byDay[day] || 0) + 1;
      }

      // Group by week
      const byWeek = {};
      for (const c of content) {
        const d = new Date(c.created_at || 0);
        const weekStart = new Date(d);
        weekStart.setDate(weekStart.getDate() - weekStart.getDay());
        const week = weekStart.toISOString().slice(0, 10);
        byWeek[week] = (byWeek[week] || 0) + 1;
      }

      // Calculate averages
      const days = Object.values(byDay);
      const weeks = Object.values(byWeek);
      const avgPerDay = days.length > 0 ? (days.reduce((s, d) => s + d, 0) / days.length).toFixed(1) : 0;
      const avgPerWeek = weeks.length > 0 ? (weeks.reduce((s, w) => s + w, 0) / weeks.length).toFixed(1) : 0;

      // Status pipeline
      const pipeline = {
        pending_triggers: readJSON('trigger-queue.json', []).filter(t => t.status === 'pending').length,
        review: content.filter(c => c.status === 'review').length,
        approved: content.filter(c => c.status === 'approved').length,
        published: content.filter(c => c.status === 'published').length
      };

      return json(res, {
        total: content.length,
        avg_per_day: avgPerDay,
        avg_per_week: avgPerWeek,
        daily_breakdown: Object.entries(byDay).sort().slice(-14).map(([d, c]) => ({ date: d, count: c })),
        weekly_breakdown: Object.entries(byWeek).sort().slice(-8).map(([w, c]) => ({ week: w, count: c })),
        pipeline
      });
    }

    // --- Batch 56: Content DNA + Topic Clusters + Cross-Platform Sync + Post Mortem + Voice Cloner ---

    // POST /api/content-dna — analyze your best performing content to find patterns
    if (pathname === '/api/content-dna' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const { callClaude, parseJsonResponse, SONNET } = require('./lib/claude');
      const content = readJSON('content.json', []);

      // Get approved/published content as "best performers"
      const best = content.filter(c => c.status === 'approved' || c.status === 'published');
      if (best.length < 3) return json(res, { error: 'Need at least 3 approved/published pieces to analyze DNA' }, 400);

      const samples = best.slice(0, 10).map(c => {
        const text = Object.values(c.formats || {}).map(f => typeof f?.content === 'string' ? f.content : '').sort((a, b) => b.length - a.length)[0] || '';
        return `Title: ${c.trigger_title}\nContent: ${text.slice(0, 500)}\n---`;
      }).join('\n');

      const prompt = `Analyze these top-performing content pieces and extract the "Content DNA" — the patterns, structures, and elements that make them work.

${samples}

Find the common threads across all pieces. This becomes our content playbook.

Return JSON (no markdown fences):
{
  "voice_patterns": {
    "tone": "how we sound",
    "sentence_length": "typical pattern",
    "vocabulary_level": "simple|moderate|technical",
    "signature_phrases": ["phrases we use often"],
    "forbidden_words": ["words/phrases to avoid"]
  },
  "structural_patterns": {
    "typical_hook": "how our hooks work",
    "body_structure": "how we organize content",
    "typical_cta": "how we close",
    "avg_length": "typical post length"
  },
  "topic_patterns": {
    "themes": ["recurring themes"],
    "angles": ["how we approach topics"],
    "data_usage": "how we use numbers/stats"
  },
  "differentiators": ["what makes our content unique vs competitors"],
  "formula": "our content formula in one sentence",
  "replication_guide": "step-by-step how to write like this"
}`;

      try {
        const text = await callClaude({ model: SONNET, prompt, maxTokens: 4000 });
        const parsed = parseJsonResponse(text);
        if (!parsed) return json(res, { error: 'Failed to analyze DNA', raw_preview: (text || '').slice(0, 300) }, 500);

        writeJSON('content-dna.json', { ...parsed, pieces_analyzed: best.length, generated_at: now() });
        return json(res, { ok: true, ...parsed });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // GET /api/content-dna — get content DNA analysis
    if (pathname === '/api/content-dna' && method === 'GET') {
      return json(res, readJSON('content-dna.json', null));
    }

    // POST /api/topic-clusters — generate SEO-optimized topic clusters
    if (pathname === '/api/topic-clusters' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const { BRAND_SYSTEM_PROMPT } = require('./generator/content-writer');
      const body = await parseBody(req);

      const prompt = `Create 5 topic clusters for Mortar Metrics' content strategy. Each cluster should have a pillar page + supporting content.

Focus area: ${body.focus || 'Law firm marketing, Google Ads, intake optimization'}

Return JSON (no markdown fences):
{
  "clusters": [
    {
      "pillar_topic": "main topic (broad, evergreen)",
      "pillar_keyword": "target SEO keyword",
      "supporting_topics": [
        { "topic": "specific subtopic", "keyword": "target keyword", "format": "blog|video|linkedin|carousel", "search_intent": "informational|commercial|navigational" }
      ],
      "internal_linking_strategy": "how pieces connect",
      "content_gap": "what competitors miss in this cluster"
    }
  ]
}`;

      try {
        const text = await callClaude({ model: HAIKU, system: BRAND_SYSTEM_PROMPT, prompt, maxTokens: 4000 });
        const parsed = parseJsonResponse(text);
        if (!parsed) return json(res, { error: 'Failed to generate clusters', raw_preview: (text || '').slice(0, 200) }, 500);

        writeJSON('topic-clusters.json', { ...parsed, generated_at: now() });
        return json(res, { ok: true, ...parsed });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // GET /api/topic-clusters — get topic clusters
    if (pathname === '/api/topic-clusters' && method === 'GET') {
      return json(res, readJSON('topic-clusters.json', null));
    }

    // POST /api/content/:id/post-mortem — analyze why a piece performed well or poorly
    const postMortemMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/post-mortem$/);
    if (postMortemMatch && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const id = postMortemMatch[1];
      const allContent = readJSON('content.json', []);
      const item = allContent.find(c => c.id === id);
      if (!item) return json(res, { error: 'Content not found' }, 404);

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const body = await parseBody(req);
      const formatKey = body.format || 'linkedin';
      const text = typeof item.formats?.[formatKey]?.content === 'string' ? item.formats[formatKey].content : '';
      const metrics = body.metrics || {};

      const prompt = `Perform a post-mortem analysis on this ${formatKey} content.

Content: ${text.slice(0, 2000)}
Performance metrics: ${JSON.stringify(metrics)}

Assume this was ${body.outcome || 'average'} performing. Analyze why and give specific improvement advice.

Return JSON (no markdown fences):
{
  "performance_rating": "great|good|average|poor",
  "what_worked": ["element that helped performance"],
  "what_didnt": ["element that hurt performance"],
  "hook_analysis": "was the hook strong enough?",
  "timing_factor": "was timing a factor?",
  "audience_fit": "did it match the right audience?",
  "improvements": [
    { "change": "specific change", "expected_impact": "high|medium|low", "reasoning": "why this helps" }
  ],
  "rewrite_hook": "improved version of the hook",
  "lessons_learned": "key takeaway for future content"
}`;

      try {
        const text2 = await callClaude({ model: HAIKU, prompt, maxTokens: 2000 });
        const parsed = parseJsonResponse(text2);
        if (!parsed) return json(res, { error: 'Failed to analyze', raw_preview: (text2 || '').slice(0, 200) }, 500);
        return json(res, { ok: true, content_id: id, format: formatKey, ...parsed });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // POST /api/voice-clone — analyze writing samples to create a voice profile
    if (pathname === '/api/voice-clone' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const { callClaude, parseJsonResponse, SONNET } = require('./lib/claude');
      const body = await parseBody(req);

      const samples = body.samples || [];
      if (samples.length < 2) return json(res, { error: 'Need at least 2 writing samples' }, 400);

      const prompt = `Analyze these writing samples and create a detailed voice profile that can be used to generate content in this exact voice.

Samples:
${samples.map((s, i) => `--- Sample ${i + 1} ---\n${s.slice(0, 1000)}`).join('\n\n')}

Return JSON (no markdown fences):
{
  "voice_profile": {
    "name": "${body.name || 'Custom Voice'}",
    "personality": "overall personality description",
    "tone_spectrum": { "formal_casual": "1-10 scale", "serious_humorous": "1-10", "technical_simple": "1-10", "empathetic_direct": "1-10" },
    "sentence_patterns": ["typical sentence structures used"],
    "vocabulary": {
      "favorite_words": ["words used frequently"],
      "avoided_words": ["words never used"],
      "jargon_level": "none|light|moderate|heavy"
    },
    "rhetorical_devices": ["devices used (metaphors, analogies, lists, etc.)"],
    "opening_patterns": ["how they typically start content"],
    "closing_patterns": ["how they typically end"],
    "punctuation_style": "description of punctuation habits",
    "paragraph_length": "typical paragraph length",
    "system_prompt": "a system prompt that would make an AI write in this voice"
  }
}`;

      try {
        const text = await callClaude({ model: SONNET, prompt, maxTokens: 3000 });
        const parsed = parseJsonResponse(text);
        if (!parsed) return json(res, { error: 'Failed to clone voice', raw_preview: (text || '').slice(0, 300) }, 500);

        const voices = readJSON('voice-profiles.json', []);
        const profile = { id: generateId(), ...parsed.voice_profile || parsed, samples_count: samples.length, created_at: now() };
        voices.push(profile);
        writeJSON('voice-profiles.json', voices);
        return json(res, { ok: true, profile });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // GET /api/voice-profiles — list voice profiles
    if (pathname === '/api/voice-profiles' && method === 'GET') {
      return json(res, readJSON('voice-profiles.json', []));
    }

    // POST /api/content/:id/cross-platform — adapt content for multiple platforms simultaneously
    const crossPlatMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/cross-platform$/);
    if (crossPlatMatch && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const id = crossPlatMatch[1];
      const allContent = readJSON('content.json', []);
      const item = allContent.find(c => c.id === id);
      if (!item) return json(res, { error: 'Content not found' }, 404);

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const { BRAND_SYSTEM_PROMPT } = require('./generator/content-writer');
      const source = Object.values(item.formats || {}).map(f => typeof f?.content === 'string' ? f.content : '').sort((a, b) => b.length - a.length)[0] || '';
      if (source.length < 100) return json(res, { error: 'Need at least 100 chars to adapt' }, 400);

      const prompt = `Adapt this content for 5 platforms simultaneously. Each version should feel NATIVE to the platform.

Source: ${source.slice(0, 2000)}
Topic: ${item.trigger_title}

Return JSON (no markdown fences):
{
  "linkedin": { "content": "professional, insight-led, 1200-1500 chars", "posting_tip": "when and how to post" },
  "twitter": { "content": "punchy, under 280 chars", "posting_tip": "..." },
  "email_subject": "compelling subject line",
  "email_body": "200 word personal email version",
  "youtube_community": "YouTube community tab post (under 500 chars, asks for engagement)"
}`;

      try {
        const text = await callClaude({ model: HAIKU, system: BRAND_SYSTEM_PROMPT, prompt, maxTokens: 4000 });
        const parsed = parseJsonResponse(text);
        if (!parsed) return json(res, { error: 'Failed to adapt', raw_preview: (text || '').slice(0, 200) }, 500);
        return json(res, { ok: true, content_id: id, platforms: parsed });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // --- Batch 57: X/Twitter Optimizer + DM Scripts + Reply Strategy + Bio Optimizer + Thread Builder ---

    // POST /api/content/:id/x-optimize — optimize content specifically for X/Twitter algorithm
    const xOptMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/x-optimize$/);
    if (xOptMatch && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const id = xOptMatch[1];
      const allContent = readJSON('content.json', []);
      const item = allContent.find(c => c.id === id);
      if (!item) return json(res, { error: 'Content not found' }, 404);

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const { BRAND_SYSTEM_PROMPT } = require('./generator/content-writer');
      const source = Object.values(item.formats || {}).map(f => typeof f?.content === 'string' ? f.content : '').sort((a, b) => b.length - a.length)[0] || '';

      const prompt = `Optimize this content for maximum X/Twitter engagement. Key algorithm facts:
- Replies weighted 13.5-27x a like, reply-to-reply is 75x
- External links get near-zero reach — NEVER include links
- Text-only posts get 3.24% engagement rate (highest)
- 1-2 hashtags max, 3+ triggers spam detection
- First 30-60 min engagement determines everything

Source content: ${source.slice(0, 2000)}
Topic: ${item.trigger_title}

Return JSON (no markdown fences):
{
  "single_tweet": "under 280 chars, punchy, designed to provoke replies",
  "thread": ["tweet 1 (hook — spend 80% of effort here)", "tweet 2 (context/credibility)", "tweet 3-7 (one insight each)", "tweet 8 (lesson)", "tweet 9 (soft CTA)", "tweet 10 (DM CTA)"],
  "hot_take_version": "contrarian take under 280 chars that starts arguments",
  "question_version": "engagement question that drives replies (75x weight)",
  "quote_tweet_bait": "something so strong people quote-tweet it with their own take (20x weight)",
  "reply_strategy": "which accounts to reply to with this content for borrowed audience",
  "posting_notes": "best time, day, and context for this post"
}`;

      try {
        const text = await callClaude({ model: HAIKU, system: BRAND_SYSTEM_PROMPT, prompt, maxTokens: 3000 });
        const parsed = parseJsonResponse(text);
        if (!parsed) return json(res, { error: 'Failed to optimize', raw_preview: (text || '').slice(0, 200) }, 500);
        return json(res, { ok: true, content_id: id, ...parsed });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // POST /api/dm-scripts — generate DM conversation scripts for converting engagers to calls
    if (pathname === '/api/dm-scripts' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const { BRAND_SYSTEM_PROMPT } = require('./generator/content-writer');
      const body = await parseBody(req);

      const prompt = `Create DM conversation scripts for converting X/LinkedIn engagers into booked discovery calls.

Context: ${body.context || 'Someone commented on our post about law firm marketing'}
Service: ${body.service || 'Google Ads management + intake optimization for law firms'}
Lead type: ${body.lead_type || 'Law firm owner who engaged with our content'}

The scripts should feel natural, not salesy. Follow the proven 3-message sequence:
1. Acknowledge + deliver value + qualify
2. Share specific insight for their situation
3. Low-friction meeting ask

Return JSON (no markdown fences):
{
  "scripts": [
    {
      "trigger": "what they did (commented, liked, DM'd keyword)",
      "message_1": { "text": "initial outreach (deliver promised value + one qualifying question)", "timing": "when to send" },
      "message_2": { "text": "follow-up with specific insight (only if they respond)", "timing": "how long to wait" },
      "message_3": { "text": "bridge to meeting (low-friction ask)", "timing": "..." },
      "if_no_response": "what to do if they don't reply"
    }
  ],
  "qualifying_questions": ["question to identify hot leads vs tire kickers"],
  "objection_handlers": { "too_busy": "response", "not_ready": "response", "already_have_agency": "response" }
}`;

      try {
        const text = await callClaude({ model: HAIKU, system: BRAND_SYSTEM_PROMPT, prompt, maxTokens: 3000 });
        const parsed = parseJsonResponse(text);
        if (!parsed) return json(res, { error: 'Failed to generate scripts', raw_preview: (text || '').slice(0, 200) }, 500);

        const scripts = readJSON('dm-scripts.json', []);
        scripts.push({ id: generateId(), ...parsed, context: body.context || 'general', created_at: now() });
        if (scripts.length > 20) scripts.splice(0, scripts.length - 20);
        writeJSON('dm-scripts.json', scripts);
        return json(res, { ok: true, ...parsed });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // GET /api/dm-scripts — list DM scripts
    if (pathname === '/api/dm-scripts' && method === 'GET') {
      return json(res, readJSON('dm-scripts.json', []));
    }

    // POST /api/reply-strategy — generate a reply strategy for borrowed audience growth
    if (pathname === '/api/reply-strategy' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const body = await parseBody(req);

      const prompt = `Create a daily reply strategy for growing audience on X/Twitter and LinkedIn through strategic commenting.

The reply strategy is the most underrated growth lever: replying to bigger accounts puts you in front of their audience. A reply is weighted 13.5-27x a like, and reply-to-reply is 75x.

Niche: ${body.niche || 'Legal marketing, law firm growth, B2B services'}
Platform: ${body.platform || 'both X and LinkedIn'}

Return JSON (no markdown fences):
{
  "target_accounts": [
    { "type": "direct competitor|adjacent industry|thought leader|potential client", "description": "who to target", "example_accounts": "types of accounts", "follower_range": "ideal follower count range" }
  ],
  "reply_templates": [
    { "situation": "when to use this", "template": "reply framework (not copy-paste — structure)", "example": "specific example reply", "why_it_works": "what makes this effective" }
  ],
  "daily_routine": {
    "time_commitment": "30-45 min",
    "schedule": [
      { "time_block": "8:00-8:15 AM", "action": "what to do" }
    ]
  },
  "rules": ["do this", "never do this"],
  "growth_milestones": { "week_1": "expected result", "month_1": "expected result", "month_3": "expected result" }
}`;

      try {
        const text = await callClaude({ model: HAIKU, prompt, maxTokens: 3000 });
        const parsed = parseJsonResponse(text);
        if (!parsed) return json(res, { error: 'Failed to generate', raw_preview: (text || '').slice(0, 200) }, 500);

        writeJSON('reply-strategy.json', { ...parsed, generated_at: now() });
        return json(res, { ok: true, ...parsed });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // GET /api/reply-strategy — get reply strategy
    if (pathname === '/api/reply-strategy' && method === 'GET') {
      return json(res, readJSON('reply-strategy.json', null));
    }

    // POST /api/bio-optimizer — optimize social media bios for conversion
    if (pathname === '/api/bio-optimizer' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const body = await parseBody(req);

      const prompt = `Optimize social media bios for maximum follower-to-lead conversion.

Platform: ${body.platform || 'X/Twitter'}
Current bio: ${body.current_bio || 'Mortar Metrics — Legal Marketing Agency'}
Name: ${body.name || 'Fardeen'}
Services: ${body.services || 'Google Ads, intake optimization, call tracking for law firms'}

Bio structure that converts:
Line 1: What you do + who you do it for
Line 2: Proof/credibility (results, client count, revenue)
Line 3: CTA (DM me for X / Free resource below)
Link: Lead capture page, NOT homepage

Return JSON (no markdown fences):
{
  "x_bio": { "text": "optimized X bio (under 160 chars)", "name_field": "name with keyword", "location": "strategic location" },
  "linkedin_headline": "optimized headline (under 120 chars)",
  "linkedin_tagline": "short tagline",
  "pinned_tweet_suggestion": "what to pin on X profile",
  "featured_content_suggestions": ["what to feature on LinkedIn"],
  "link_suggestion": "what URL to put in bio link",
  "tips": ["specific tip for this profile"]
}`;

      try {
        const text = await callClaude({ model: HAIKU, prompt, maxTokens: 2000 });
        const parsed = parseJsonResponse(text);
        if (!parsed) return json(res, { error: 'Failed to optimize bio', raw_preview: (text || '').slice(0, 200) }, 500);
        return json(res, { ok: true, ...parsed });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // POST /api/content/:id/build-thread — build an optimized X thread from any content
    const threadMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/build-thread$/);
    if (threadMatch && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, { error: 'ANTHROPIC_API_KEY not set' }, 500);
      const id = threadMatch[1];
      const allContent = readJSON('content.json', []);
      const item = allContent.find(c => c.id === id);
      if (!item) return json(res, { error: 'Content not found' }, 404);

      const { callClaude, parseJsonResponse, SONNET } = require('./lib/claude');
      const { BRAND_SYSTEM_PROMPT } = require('./generator/content-writer');
      const source = Object.values(item.formats || {}).map(f => typeof f?.content === 'string' ? f.content : '').sort((a, b) => b.length - a.length)[0] || '';

      const prompt = `Build a viral X/Twitter thread from this content. Threads get 63% more impressions and 3x more engagement.

Source: ${source.slice(0, 3000)}
Topic: ${item.trigger_title}

Thread structure:
- Tweet 1: HOOK (write 3 versions — curiosity gap + specific numbers)
- Tweet 2: CONTEXT/CREDIBILITY
- Tweets 3-8: ONE insight per tweet, each standalone valuable
- Tweet 9: LESSON/SYNTHESIS
- Tweet 10: Soft CTA (follow for more)
- Tweet 11: Hard CTA (DM me keyword)

Rules:
- Each tweet under 280 chars
- No links in any tweet
- No hashtags except maybe 1 in last tweet
- Numbered for easy scanning
- Write 3 hook variations for tweet 1

Return JSON (no markdown fences):
{
  "thread_title": "internal title",
  "hook_variations": ["hook 1", "hook 2", "hook 3"],
  "recommended_hook": 0,
  "tweets": ["tweet 1 (best hook)", "tweet 2", "...up to tweet 11"],
  "reply_tweet": "tweet to post as a reply 1 hour later with additional value",
  "quote_tweet_suggestion": "suggested quote tweet to post next day recycling the hook",
  "best_posting_time": "when to post this thread",
  "engagement_prediction": "expected engagement level and why"
}`;

      try {
        const text = await callClaude({ model: SONNET, system: BRAND_SYSTEM_PROMPT, prompt, maxTokens: 4000 });
        const parsed = parseJsonResponse(text);
        if (!parsed) return json(res, { error: 'Failed to build thread', raw_preview: (text || '').slice(0, 300) }, 500);

        // Save thread to content item
        const idx = allContent.findIndex(c => c.id === id);
        if (idx >= 0) {
          if (!allContent[idx].formats) allContent[idx].formats = {};
          allContent[idx].formats.x_thread_optimized = { content: parsed.tweets, status: 'review', generated_at: now(), hook_variations: parsed.hook_variations };
          writeJSON('content.json', allContent);
        }
        return json(res, { ok: true, content_id: id, ...parsed });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // GET /api/content-system-health — comprehensive health check of the entire content system
    if (pathname === '/api/content-system-health' && method === 'GET') {
      const checks = [];
      const dataFiles = [
        'content.json', 'trigger-queue.json', 'content-bank.json', 'series-templates.json',
        'content-matrix.json', 'atomizations.json', 'repurpose-chains.json', 'email-sequences.json',
        'lead-magnet-funnels.json', 'nurture-campaigns.json', 'content-pillars.json',
        'authority-plan.json', 'content-dna.json', 'topic-clusters.json', 'youtube-pipelines.json',
        'carousels.json', 'competitor-analyses.json', 'voice-profiles.json', 'audience-segments.json'
      ];

      for (const file of dataFiles) {
        const data = readJSON(file, null);
        const name = file.replace('.json', '').replace(/-/g, ' ');
        if (data === null) {
          checks.push({ system: name, status: 'not_set_up', message: 'Not configured yet' });
        } else if (Array.isArray(data)) {
          checks.push({ system: name, status: data.length > 0 ? 'active' : 'empty', count: data.length });
        } else if (typeof data === 'object') {
          checks.push({ system: name, status: 'configured', has_data: Object.keys(data).length > 0 });
        }
      }

      // Check API keys
      checks.push({ system: 'Claude API', status: process.env.ANTHROPIC_API_KEY ? 'connected' : 'missing' });
      checks.push({ system: 'Fireflies API', status: process.env.FIREFLIES_API_KEY ? 'connected' : 'not_set' });

      const active = checks.filter(c => c.status === 'active' || c.status === 'configured' || c.status === 'connected').length;
      const total = checks.length;

      return json(res, {
        health_score: Math.round((active / total) * 100),
        active_systems: active,
        total_systems: total,
        checks,
        recommendation: active < total * 0.5 ? 'Many systems unconfigured — run setup actions from dashboard' : active < total * 0.8 ? 'Good progress — a few systems need attention' : 'System is well configured!'
      });
    }

    // ======= BATCH 58: LinkedIn Optimizer, Content Recycler, Comment Strategy, Newsletter Compiler, A/B Variants =======

    // POST /api/content/:id/linkedin-optimize — Optimize content specifically for LinkedIn algorithm
    if (method === 'POST' && pathname.match(/^\/api\/content\/([^/]+)\/linkedin-optimize$/)) {
      const contentId = pathname.split('/')[3];
      const allContent = readJSON('content.json', []);
      const item = allContent.find(c => c.id === contentId);
      if (!item) return json(res, { error: 'Content not found' }, 404);
      const body = await parseBody(req);
      const formatKey = body.format || Object.keys(item.formats || {}).find(k => k.includes('linkedin')) || 'linkedin_post';
      const text = item.formats?.[formatKey]?.text || item.formats?.[formatKey];
      if (!text) return json(res, { error: 'No LinkedIn content found' }, 400);

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const result = await callClaude({
        model: HAIKU,
        system: 'You are a LinkedIn algorithm expert. You know that: dwell time is the #1 signal (long-form beats short), native document/carousel posts get 2-3x reach, first 3 lines must hook (before "see more"), posts with 0-3 hashtags perform best, external links kill reach by 50%+, commenting on your own post within first hour boosts it, posting between 7-9 AM local time is optimal, tagging 3-5 people increases distribution, polls get highest engagement rate but lowest quality. Return JSON only.',
        prompt: `Optimize this LinkedIn post for maximum reach and engagement. Return JSON:
{
  "optimized_post": "the full optimized post text",
  "hook_line": "compelling first line before see-more cutoff (max 150 chars)",
  "hashtags": ["3 optimal hashtags"],
  "self_comment": "your first comment to boost engagement",
  "tag_suggestions": ["types of people to tag, not specific names"],
  "posting_time": "optimal posting window",
  "format_recommendation": "text|carousel|poll|document",
  "dwell_time_tricks": ["techniques to increase time-on-post"],
  "engagement_bait": "question or CTA to drive comments",
  "predicted_reach_multiplier": "1.5x-3x estimate vs original"
}

Original post:
${typeof text === 'string' ? text.slice(0, 3000) : JSON.stringify(text).slice(0, 3000)}`,
        maxTokens: 3000
      });
      const parsed = parseJsonResponse(result);
      return json(res, { ok: true, content_id: contentId, ...parsed });
    }

    // POST /api/content-recycler — Find old approved content that can be refreshed and reposted
    if (method === 'POST' && pathname === '/api/content-recycler') {
      const allContent = readJSON('content.json', []);
      const published = readJSON('published.json', []);
      const now_ts = Date.now();
      const thirtyDaysAgo = now_ts - 30 * 24 * 60 * 60 * 1000;

      // Find content that was published 30+ days ago or approved but never published
      const recyclable = allContent.filter(c => {
        if (c.status === 'approved') {
          const pubEntry = published.find(p => p.content_id === c.id);
          if (!pubEntry) return true; // approved but never published
          const pubDate = new Date(pubEntry.published_at || pubEntry.date).getTime();
          return pubDate < thirtyDaysAgo;
        }
        return false;
      }).slice(0, 10);

      if (recyclable.length === 0) return json(res, { ok: true, recyclable: [], message: 'No content ready to recycle yet' });

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const summaries = recyclable.map(c => {
        const firstFormat = Object.keys(c.formats || {})[0];
        const text = c.formats?.[firstFormat]?.text || c.formats?.[firstFormat] || '';
        return { id: c.id, trigger: c.trigger_title || c.title || 'Untitled', format: firstFormat, snippet: (typeof text === 'string' ? text : '').slice(0, 200) };
      });

      const result = await callClaude({
        model: HAIKU,
        system: 'You are a content recycling expert. Help refresh old content with new angles, updated stats, and fresh hooks. Return JSON only.',
        prompt: `These content pieces are ready to be recycled. For each, suggest a fresh angle, updated hook, and what to change. Return JSON array:
[{
  "id": "content_id",
  "original_topic": "what it was about",
  "fresh_angle": "new perspective or updated take",
  "new_hook": "updated first line that feels new",
  "changes_needed": ["list of specific updates"],
  "best_platform": "where to repost first",
  "recycle_score": 1-10
}]

Content to recycle:
${JSON.stringify(summaries, null, 2)}`,
        maxTokens: 3000
      });
      const parsed = parseJsonResponse(result);
      const recycled = { suggestions: Array.isArray(parsed) ? parsed : parsed.suggestions || [], generated_at: now() };
      writeJSON('content-recycler.json', recycled);
      return json(res, { ok: true, ...recycled });
    }

    // GET /api/content-recycler
    if (method === 'GET' && pathname === '/api/content-recycler') {
      return json(res, readJSON('content-recycler.json', { suggestions: [] }));
    }

    // POST /api/comment-strategy — Generate strategic commenting plan for borrowed audience growth
    if (method === 'POST' && pathname === '/api/comment-strategy') {
      const triggers = readJSON('trigger-queue.json', []);
      const recentTopics = triggers.slice(0, 20).map(t => t.title || t.topic).join(', ');

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const result = await callClaude({
        model: HAIKU,
        system: 'You are a social media growth strategist specializing in comment-based growth. Strategic commenting on larger accounts is the fastest way to grow from 0 to 10K followers. A great comment gets more visibility than a great post because it rides the original post\'s distribution. Return JSON only.',
        prompt: `Create a daily commenting strategy for a legal marketing agency. We discuss: ${recentTopics.slice(0, 500)}

Return JSON:
{
  "daily_targets": [
    {
      "account_type": "type of account to target",
      "platform": "linkedin or x",
      "why": "why their audience overlaps ours",
      "comment_approach": "what kind of comment to leave",
      "example_comment": "a specific example",
      "timing": "when to comment relative to their post"
    }
  ],
  "comment_templates": [
    {
      "trigger": "when to use this",
      "template": "comment structure with [BLANKS]",
      "goal": "what this achieves"
    }
  ],
  "rules": ["golden rules for commenting"],
  "daily_quota": { "linkedin": 5, "x": 10 },
  "time_budget": "minutes per day",
  "growth_projection": "expected follower growth per month"
}`,
        maxTokens: 3000
      });
      const parsed = parseJsonResponse(result);
      const strategy = { ...parsed, generated_at: now() };
      writeJSON('comment-strategy.json', strategy);
      return json(res, { ok: true, ...strategy });
    }

    // GET /api/comment-strategy
    if (method === 'GET' && pathname === '/api/comment-strategy') {
      return json(res, readJSON('comment-strategy.json', null));
    }

    // POST /api/newsletter-compiler — Compile a weekly newsletter from best content
    if (method === 'POST' && pathname === '/api/newsletter-compiler') {
      const allContent = readJSON('content.json', []);
      const approved = allContent.filter(c => c.status === 'approved').slice(0, 20);
      const triggers = readJSON('trigger-queue.json', []);
      const topTriggers = triggers.filter(t => (t.score || 0) >= 60).slice(0, 5);

      if (approved.length === 0 && topTriggers.length === 0) return json(res, { error: 'No content to compile — approve some content first' }, 400);

      const contentSummaries = approved.map(c => {
        const fmts = Object.keys(c.formats || {});
        const firstText = c.formats?.[fmts[0]]?.text || c.formats?.[fmts[0]] || '';
        return { title: c.trigger_title || c.title, text: (typeof firstText === 'string' ? firstText : '').slice(0, 300) };
      });

      const { callClaude, parseJsonResponse, SONNET } = require('./lib/claude');
      const result = await callClaude({
        model: SONNET,
        system: 'You are a newsletter editor for Mortar Metrics, a legal marketing agency. Write newsletters that feel like a personal letter from a smart friend, not a corporate email. Short paragraphs. Punchy insights. One CTA. No fluff. Return JSON only.',
        prompt: `Compile a weekly newsletter from this content. Format it for email delivery.

Available content:
${JSON.stringify(contentSummaries.slice(0, 10), null, 2)}

Trending topics this week:
${topTriggers.map(t => t.title).join('\n')}

Return JSON:
{
  "subject_line": "compelling subject line (under 50 chars, no spam words)",
  "preview_text": "email preview text (under 90 chars)",
  "greeting": "casual opening line",
  "main_story": {
    "headline": "primary story headline",
    "body": "2-3 paragraph main story with data/insight",
    "cta": "what to do with this info"
  },
  "quick_hits": [
    { "headline": "short headline", "one_liner": "one sentence insight", "link_text": "Read more" }
  ],
  "data_point": {
    "stat": "one surprising number",
    "context": "why it matters"
  },
  "closer": "sign-off paragraph with soft CTA",
  "ps_line": "P.S. line (creates urgency or curiosity)",
  "estimated_read_time": "X min"
}`,
        maxTokens: 4000
      });
      const parsed = parseJsonResponse(result);
      const newsletters = readJSON('newsletters.json', []);
      const newsletter = { id: generateId(), ...parsed, compiled_at: now() };
      newsletters.unshift(newsletter);
      writeJSON('newsletters.json', newsletters);
      return json(res, { ok: true, ...newsletter });
    }

    // GET /api/newsletters
    if (method === 'GET' && pathname === '/api/newsletters') {
      return json(res, readJSON('newsletters.json', []));
    }

    // POST /api/content/:id/ab-variants — Generate A/B test variants for a piece of content
    if (method === 'POST' && pathname.match(/^\/api\/content\/([^/]+)\/ab-variants$/)) {
      const contentId = pathname.split('/')[3];
      const allContent = readJSON('content.json', []);
      const item = allContent.find(c => c.id === contentId);
      if (!item) return json(res, { error: 'Content not found' }, 404);
      const body = await parseBody(req);
      const formatKey = body.format || Object.keys(item.formats || {}).find(k => k.includes('linkedin') || k.includes('x_')) || Object.keys(item.formats || {})[0];
      const text = item.formats?.[formatKey]?.text || item.formats?.[formatKey];
      if (!text) return json(res, { error: 'No content for this format' }, 400);

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const result = await callClaude({
        model: HAIKU,
        system: 'You are a content testing expert. Create meaningful A/B variants that test specific hypotheses about what drives engagement. Each variant should change ONE variable while keeping everything else constant. Return JSON only.',
        prompt: `Create A/B test variants for this content. Each variant tests a different hypothesis.

Original (Version A):
${typeof text === 'string' ? text.slice(0, 2000) : JSON.stringify(text).slice(0, 2000)}

Return JSON:
{
  "original_label": "Version A — [what it tests]",
  "variants": [
    {
      "label": "Version B — [what it changes]",
      "hypothesis": "what we're testing",
      "content": "full rewritten content",
      "change_description": "exactly what changed and why",
      "expected_impact": "what we expect to happen"
    },
    {
      "label": "Version C — [what it changes]",
      "hypothesis": "what we're testing",
      "content": "full rewritten content",
      "change_description": "exactly what changed and why",
      "expected_impact": "what we expect to happen"
    }
  ],
  "testing_plan": "how to run this test (post both within same week, measure X)"
}`,
        maxTokens: 3000
      });
      const parsed = parseJsonResponse(result);
      return json(res, { ok: true, content_id: contentId, format: formatKey, ...parsed });
    }

    // POST /api/content/:id/viral-hook — Rewrite content with a viral hook formula
    if (method === 'POST' && pathname.match(/^\/api\/content\/([^/]+)\/viral-hook$/)) {
      const contentId = pathname.split('/')[3];
      const allContent = readJSON('content.json', []);
      const item = allContent.find(c => c.id === contentId);
      if (!item) return json(res, { error: 'Content not found' }, 404);
      const body = await parseBody(req);
      const formatKey = body.format || Object.keys(item.formats || {})[0];
      const text = item.formats?.[formatKey]?.text || item.formats?.[formatKey];
      if (!text) return json(res, { error: 'No content for this format' }, 400);

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const result = await callClaude({
        model: HAIKU,
        system: 'You are a viral content architect. You study hooks from the most shared posts on LinkedIn and X. The best hooks create curiosity gaps, pattern interrupts, or emotional jolts in the first 8 words. Return JSON only.',
        prompt: `Rewrite this content with 5 different viral hook formulas. Keep the body mostly the same but completely rewrite the opening.

Original:
${typeof text === 'string' ? text.slice(0, 2000) : JSON.stringify(text).slice(0, 2000)}

Return JSON:
{
  "hooks": [
    {
      "formula": "name of the hook formula",
      "hook": "the new opening (first 2-3 sentences)",
      "full_rewrite": "complete post with new hook + adapted body",
      "why_it_works": "psychology behind this hook",
      "best_for": "linkedin|x|both"
    }
  ],
  "recommended": 0,
  "hook_analysis_of_original": "what was wrong/right with the original hook"
}

Use these proven formulas:
1. Curiosity Gap ("I spent $50K on X. Here's what nobody tells you.")
2. Bold Contrarian ("Everyone says X. They're wrong.")
3. Specific Number ("347 law firms taught me one thing.")
4. Before/After ("Last year I was doing X. Now I do Y.")
5. Question Hook ("Why do 80% of law firms fail at marketing?")`,
        maxTokens: 4000
      });
      const parsed = parseJsonResponse(result);
      return json(res, { ok: true, content_id: contentId, format: formatKey, ...parsed });
    }

    // POST /api/engagement-booster — Get daily engagement tasks to grow audience
    if (method === 'POST' && pathname === '/api/engagement-booster') {
      const replyStrategy = readJSON('reply-strategy.json', null);
      const commentStrategy = readJSON('comment-strategy.json', null);
      const dmScripts = readJSON('dm-scripts.json', []);
      const published = readJSON('published.json', []);

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const result = await callClaude({
        model: HAIKU,
        system: 'You are a social media engagement coach. Create a specific, time-blocked daily engagement routine that takes 30-45 minutes and maximizes audience growth. Focus on activities with the highest ROI: replying to comments, strategic commenting on larger accounts, DM conversations, and community participation. Return JSON only.',
        prompt: `Create today's engagement action plan for a legal marketing agency on LinkedIn and X.

We have ${published.length} published posts, ${dmScripts.length > 0 ? 'DM scripts ready' : 'no DM scripts yet'}, ${replyStrategy ? 'a reply strategy' : 'no reply strategy'}, ${commentStrategy ? 'a commenting strategy' : 'no commenting strategy'}.

Return JSON:
{
  "morning_block": {
    "time": "8:00-8:15 AM",
    "tasks": [
      { "action": "specific task", "platform": "linkedin|x", "duration": "5 min", "priority": "high|medium" }
    ]
  },
  "midday_block": {
    "time": "12:00-12:15 PM",
    "tasks": [{ "action": "...", "platform": "...", "duration": "...", "priority": "..." }]
  },
  "evening_block": {
    "time": "5:00-5:15 PM",
    "tasks": [{ "action": "...", "platform": "...", "duration": "...", "priority": "..." }]
  },
  "weekly_tasks": ["things to do once per week"],
  "metrics_to_track": ["what to measure daily"],
  "todays_focus": "one sentence focus for today"
}`,
        maxTokens: 2500
      });
      const parsed = parseJsonResponse(result);
      return json(res, { ok: true, ...parsed, generated_at: now() });
    }

    // POST /api/content/:id/carousel-builder — Build a visual carousel with slide-by-slide content
    if (method === 'POST' && pathname.match(/^\/api\/content\/([^/]+)\/carousel-builder$/)) {
      const contentId = pathname.split('/')[3];
      const allContent = readJSON('content.json', []);
      const item = allContent.find(c => c.id === contentId);
      if (!item) return json(res, { error: 'Content not found' }, 404);
      const formatKey = Object.keys(item.formats || {}).find(k => k.includes('linkedin') || k.includes('carousel')) || Object.keys(item.formats || {})[0];
      const text = item.formats?.[formatKey]?.text || item.formats?.[formatKey];
      if (!text) return json(res, { error: 'No content found' }, 400);

      const { callClaude, parseJsonResponse, SONNET } = require('./lib/claude');
      const result = await callClaude({
        model: SONNET,
        system: 'You are a LinkedIn carousel designer. Carousels get 2-3x the reach of text posts. Each slide should have: a headline (max 8 words), 2-3 bullet points or a short paragraph, and a visual direction note. First slide is the hook (must stop the scroll). Last slide is the CTA. Aim for 8-12 slides. Return JSON only.',
        prompt: `Convert this content into a LinkedIn carousel (document post). Design each slide.

Content:
${typeof text === 'string' ? text.slice(0, 3000) : JSON.stringify(text).slice(0, 3000)}

Return JSON:
{
  "title": "carousel title for the document",
  "slides": [
    {
      "slide_number": 1,
      "type": "hook|content|data|quote|cta",
      "headline": "big text on slide (max 8 words)",
      "body": "supporting text (2-3 short lines)",
      "visual_note": "design direction for this slide",
      "background_color": "hex color suggestion"
    }
  ],
  "caption": "the LinkedIn post text that accompanies the carousel",
  "hashtags": ["3 hashtags"],
  "posting_notes": "best time and day to post carousels"
}`,
        maxTokens: 4000
      });
      const parsed = parseJsonResponse(result);
      return json(res, { ok: true, content_id: contentId, ...parsed });
    }

    // ======= BATCH 59: Content Distribution, Social Proof Automation, Advanced Analytics =======

    // POST /api/distribution-engine — Auto-generate distribution plan for approved content
    if (method === 'POST' && pathname === '/api/distribution-engine') {
      const allContent = readJSON('content.json', []);
      const approved = allContent.filter(c => c.status === 'approved').slice(0, 15);
      if (approved.length === 0) return json(res, { error: 'No approved content to distribute' }, 400);

      const series = readJSON('series-templates.json', { series: [] });
      const contentBank = readJSON('content-bank.json', { log: [], stats: {} });

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const contentList = approved.map(c => ({
        id: c.id,
        title: c.trigger_title || c.title,
        formats: Object.keys(c.formats || {}),
        created: c.created_at
      }));

      const result = await callClaude({
        model: HAIKU,
        system: 'You are a content distribution strategist. You plan multi-channel distribution that maximizes reach by posting the right format on the right platform at the right time. Each piece should be distributed across 3-5 channels over 7 days. Return JSON only.',
        prompt: `Create a 7-day distribution plan for ${approved.length} approved content pieces.

Series schedule: ${JSON.stringify((series.series || []).map(s => ({ name: s.name, day: s.day, format: s.format })))}
Content bank: ${contentBank.stats?.value || 0} value posts, ${contentBank.stats?.cta || 0} CTA posts

Content to distribute:
${JSON.stringify(contentList, null, 2)}

Return JSON:
{
  "plan": [
    {
      "day": "Monday",
      "slots": [
        {
          "time": "8:00 AM ET",
          "platform": "linkedin|x|email|youtube",
          "content_id": "...",
          "format": "which format to use",
          "action": "post|thread|story|newsletter",
          "notes": "specific posting instructions"
        }
      ]
    }
  ],
  "cross_promotion": [
    { "from": "linkedin post", "to": "x thread", "timing": "same day 2pm", "adaptation": "what to change" }
  ],
  "total_touchpoints": 20,
  "platform_breakdown": { "linkedin": 7, "x": 8, "email": 3, "youtube": 2 }
}`,
        maxTokens: 4000
      });
      const parsed = parseJsonResponse(result);
      const plan = { ...parsed, generated_at: now() };
      writeJSON('distribution-engine.json', plan);
      return json(res, { ok: true, ...plan });
    }

    // GET /api/distribution-engine
    if (method === 'GET' && pathname === '/api/distribution-engine') {
      return json(res, readJSON('distribution-engine.json', null));
    }

    // POST /api/social-proof-engine — Auto-generate social proof assets from meeting data
    if (method === 'POST' && pathname === '/api/social-proof-engine') {
      const meetings = db.getMeetings({ limit: 50 });
      const clients = db.getClients({});
      const atoms = db.getAtoms({});

      const successStories = atoms.filter(a => a.type === 'success_story');
      const quotes = atoms.filter(a => a.type === 'quote');

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const result = await callClaude({
        model: HAIKU,
        system: 'You are a social proof content creator. Convert real client interactions into compelling proof assets. Anonymize where needed but keep specific numbers. Social proof is the #1 conversion driver — make it feel authentic, not manufactured. Return JSON only.',
        prompt: `Create social proof content from real client data.

${successStories.length} success stories available: ${successStories.slice(0, 5).map(s => s.content).join(' | ')}
${quotes.length} client quotes available: ${quotes.slice(0, 5).map(q => q.content).join(' | ')}
${clients.length} clients, ${meetings.length} meetings processed.

Return JSON:
{
  "testimonial_posts": [
    {
      "type": "before_after|case_study_mini|client_win|data_proof",
      "headline": "attention-grabbing headline",
      "body": "full post text for LinkedIn",
      "platform": "linkedin|x|both",
      "anonymized": true
    }
  ],
  "proof_stats": [
    { "stat": "specific number", "context": "why it matters", "use_in": "post|bio|email_signature|website" }
  ],
  "authority_signals": ["ways to demonstrate expertise without bragging"],
  "weekly_proof_plan": "how to weave proof into regular content"
}`,
        maxTokens: 3000
      });
      const parsed = parseJsonResponse(result);
      const proofData = { ...parsed, generated_at: now() };
      writeJSON('social-proof-engine.json', proofData);
      return json(res, { ok: true, ...proofData });
    }

    // GET /api/social-proof-engine
    if (method === 'GET' && pathname === '/api/social-proof-engine') {
      return json(res, readJSON('social-proof-engine.json', null));
    }

    // GET /api/advanced-analytics — Comprehensive content analytics with growth metrics
    if (method === 'GET' && pathname === '/api/advanced-analytics') {
      const allContent = readJSON('content.json', []);
      const published = readJSON('published.json', []);
      const triggers = readJSON('trigger-queue.json', []);
      const series = readJSON('series-templates.json', { series: [] });
      const contentBank = readJSON('content-bank.json', { log: [], stats: {} });

      const now_ts = Date.now();
      const sevenDaysAgo = now_ts - 7 * 24 * 60 * 60 * 1000;
      const thirtyDaysAgo = now_ts - 30 * 24 * 60 * 60 * 1000;

      const recentContent = allContent.filter(c => new Date(c.created_at) > sevenDaysAgo);
      const monthContent = allContent.filter(c => new Date(c.created_at) > thirtyDaysAgo);

      const weeklyRate = recentContent.length;
      const monthlyRate = monthContent.length;
      const avgFormatsPerItem = allContent.length > 0 ? Math.round(allContent.reduce((sum, c) => sum + Object.keys(c.formats || {}).length, 0) / allContent.length) : 0;

      const pipelineHealth = {
        triggers_pending: triggers.filter(t => t.status === 'pending').length,
        content_review: allContent.filter(c => c.status === 'review').length,
        content_approved: allContent.filter(c => c.status === 'approved').length,
        published_total: published.length,
        rejection_rate: allContent.length > 0 ? Math.round(allContent.filter(c => c.status === 'rejected').length / allContent.length * 100) : 0
      };

      const sourceStats = {};
      triggers.forEach(t => {
        const src = t.source || 'unknown';
        if (!sourceStats[src]) sourceStats[src] = { total: 0, used: 0, avg_score: 0, scores: [] };
        sourceStats[src].total++;
        if (t.status === 'used') sourceStats[src].used++;
        if (t.score) sourceStats[src].scores.push(t.score);
      });
      Object.keys(sourceStats).forEach(src => {
        const s = sourceStats[src];
        s.avg_score = s.scores.length > 0 ? Math.round(s.scores.reduce((a, b) => a + b, 0) / s.scores.length) : 0;
        s.conversion_rate = s.total > 0 ? Math.round(s.used / s.total * 100) : 0;
        delete s.scores;
      });

      const formatCount = {};
      allContent.forEach(c => {
        Object.keys(c.formats || {}).forEach(f => {
          formatCount[f] = (formatCount[f] || 0) + 1;
        });
      });

      return json(res, {
        production: {
          total_content: allContent.length,
          this_week: weeklyRate,
          this_month: monthlyRate,
          avg_formats_per_item: avgFormatsPerItem,
          total_formats: Object.values(formatCount).reduce((a, b) => a + b, 0),
          total_published: published.length
        },
        pipeline: pipelineHealth,
        sources: sourceStats,
        formats: formatCount,
        content_bank: contentBank.stats || {},
        series_count: (series.series || []).length,
        health_indicators: {
          trigger_freshness: triggers.filter(t => new Date(t.captured_at) > sevenDaysAgo).length > 0 ? 'fresh' : 'stale',
          review_backlog: pipelineHealth.content_review > 20 ? 'high' : pipelineHealth.content_review > 5 ? 'moderate' : 'low',
          production_rate: weeklyRate >= 5 ? 'strong' : weeklyRate >= 2 ? 'moderate' : 'low',
          publish_rate: published.length > 0 ? 'active' : 'not_started'
        }
      });
    }

    // POST /api/content/:id/social-media-copy — Generate platform-specific copy with CTAs and hashtags
    if (method === 'POST' && pathname.match(/^\/api\/content\/([^/]+)\/social-media-copy$/)) {
      const contentId = pathname.split('/')[3];
      const allContent = readJSON('content.json', []);
      const item = allContent.find(c => c.id === contentId);
      if (!item) return json(res, { error: 'Content not found' }, 404);
      const formatKey = Object.keys(item.formats || {})[0];
      const text = item.formats?.[formatKey]?.text || item.formats?.[formatKey];
      if (!text) return json(res, { error: 'No content found' }, 400);

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const result = await callClaude({
        model: HAIKU,
        system: 'You are a social media copywriter who writes platform-native copy. Each platform has different character limits, audience expectations, and algorithm preferences. LinkedIn is professional storytelling. X is punchy and provocative. Instagram is visual and hashtag-heavy. Email is personal and direct. Return JSON only.',
        prompt: `Write platform-specific copy for all major channels from this content:

${typeof text === 'string' ? text.slice(0, 2500) : JSON.stringify(text).slice(0, 2500)}

Return JSON:
{
  "linkedin": {
    "post": "full LinkedIn post (1300 chars max, hook first line)",
    "hashtags": ["3 hashtags"],
    "cta": "comment-driving CTA"
  },
  "x_tweet": {
    "post": "tweet (280 chars max)",
    "hashtags": ["1-2 hashtags"],
    "cta": "engagement CTA"
  },
  "x_thread": {
    "tweets": ["tweet 1 (hook)", "tweet 2", "tweet 3", "tweet 4 (CTA)"],
    "hook_style": "what makes tweet 1 compelling"
  },
  "instagram_caption": {
    "caption": "Instagram caption with line breaks",
    "hashtags": ["10-15 hashtags"],
    "cta": "bio link CTA"
  },
  "email_subject": {
    "subject": "email subject line",
    "preview": "preview text",
    "opening": "first 2 sentences of email"
  },
  "youtube_community": {
    "post": "YouTube community tab post",
    "cta": "engagement CTA"
  }
}`,
        maxTokens: 4000
      });
      const parsed = parseJsonResponse(result);
      return json(res, { ok: true, content_id: contentId, ...parsed });
    }

    // POST /api/growth-playbook — Generate a comprehensive growth playbook based on current content
    if (method === 'POST' && pathname === '/api/growth-playbook') {
      const allContent = readJSON('content.json', []);
      const published = readJSON('published.json', []);
      const contentDna = readJSON('content-dna.json', null);
      const audienceSegments = readJSON('audience-segments.json', null);

      const { callClaude, parseJsonResponse, SONNET } = require('./lib/claude');
      const result = await callClaude({
        model: SONNET,
        system: 'You are a growth strategist who creates actionable 90-day playbooks for B2B companies using content-led growth. Focus on compound growth — actions that build on each other over time. Return JSON only.',
        prompt: `Create a 90-day growth playbook for a legal marketing agency.

Current state: ${allContent.length} content pieces, ${published.length} published, ${contentDna ? 'DNA analysis done' : 'no DNA yet'}, ${audienceSegments ? 'audience segments defined' : 'no segments yet'}.

Return JSON:
{
  "month_1": {
    "theme": "Foundation",
    "goals": ["measurable goal 1", "goal 2"],
    "weekly_actions": [
      { "week": 1, "focus": "what to focus on", "actions": ["action 1", "action 2"], "content_target": 5 }
    ],
    "kpis": ["what to measure"]
  },
  "month_2": {
    "theme": "Acceleration",
    "goals": ["..."],
    "weekly_actions": [{ "week": 5, "focus": "...", "actions": ["..."], "content_target": 7 }],
    "kpis": ["..."]
  },
  "month_3": {
    "theme": "Scale",
    "goals": ["..."],
    "weekly_actions": [{ "week": 9, "focus": "...", "actions": ["..."], "content_target": 10 }],
    "kpis": ["..."]
  },
  "critical_path": ["must-do items in order of priority"],
  "quick_wins": ["things that can show results in week 1"],
  "compound_effects": ["how month 1 actions compound by month 3"]
}`,
        maxTokens: 5000
      });
      const parsed = parseJsonResponse(result);
      const playbook = { ...parsed, generated_at: now() };
      writeJSON('growth-playbook.json', playbook);
      return json(res, { ok: true, ...playbook });
    }

    // GET /api/growth-playbook
    if (method === 'GET' && pathname === '/api/growth-playbook') {
      return json(res, readJSON('growth-playbook.json', null));
    }

    // POST /api/content/:id/cta-optimizer — Optimize CTAs for maximum conversion
    if (method === 'POST' && pathname.match(/^\/api\/content\/([^/]+)\/cta-optimizer$/)) {
      const contentId = pathname.split('/')[3];
      const allContent = readJSON('content.json', []);
      const item = allContent.find(c => c.id === contentId);
      if (!item) return json(res, { error: 'Content not found' }, 404);
      const body = await parseBody(req);
      const formatKey = body.format || Object.keys(item.formats || {})[0];
      const text = item.formats?.[formatKey]?.text || item.formats?.[formatKey];
      if (!text) return json(res, { error: 'No content found' }, 400);

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const result = await callClaude({
        model: HAIKU,
        system: 'You are a CTA optimization expert. The best CTAs feel like a natural next step, not a sales pitch. They use specificity, urgency, and social proof. For LinkedIn: comment-based CTAs outperform link CTAs 4:1. For X: quote-tweet bait and "reply with X" work best. Return JSON only.',
        prompt: `Optimize the CTA for this content piece.

Content:
${typeof text === 'string' ? text.slice(0, 2000) : JSON.stringify(text).slice(0, 2000)}

Return JSON:
{
  "current_cta_analysis": "what the current CTA is (if any) and why it could be better",
  "optimized_ctas": [
    {
      "type": "comment_cta|dm_cta|link_cta|reply_cta|save_cta",
      "cta_text": "the optimized CTA",
      "placement": "where to put it in the post",
      "psychology": "why this works",
      "expected_conversion": "low|medium|high"
    }
  ],
  "recommended": 0,
  "avoid": ["CTA patterns that hurt engagement on this platform"]
}`,
        maxTokens: 2500
      });
      const parsed = parseJsonResponse(result);
      return json(res, { ok: true, content_id: contentId, format: formatKey, ...parsed });
    }

    // ======= BATCH 60: Lead Magnet Automation, Funnel Optimization, Content Repurpose Automation =======

    // POST /api/lead-magnet-generator — Auto-generate a lead magnet from best content
    if (method === 'POST' && pathname === '/api/lead-magnet-generator') {
      const allContent = readJSON('content.json', []);
      const body = await parseBody(req);
      const contentId = body.content_id;
      const magType = body.type || 'checklist';

      let sourceText = '';
      if (contentId) {
        const item = allContent.find(c => c.id === contentId);
        if (!item) return json(res, { error: 'Content not found' }, 404);
        const fk = Object.keys(item.formats || {})[0];
        sourceText = item.formats?.[fk]?.text || item.formats?.[fk] || '';
      } else {
        const approved = allContent.filter(c => c.status === 'approved').slice(0, 5);
        sourceText = approved.map(c => {
          const fk = Object.keys(c.formats || {})[0];
          return (c.formats?.[fk]?.text || c.formats?.[fk] || '').toString().slice(0, 500);
        }).join('\n\n');
      }
      if (!sourceText) return json(res, { error: 'No source content available' }, 400);

      const { callClaude, parseJsonResponse, SONNET } = require('./lib/claude');
      const result = await callClaude({
        model: SONNET,
        system: `You are a lead magnet designer for Mortar Metrics, a legal marketing agency. Create ${magType} lead magnets that are so valuable law firm owners can't resist downloading them. Make them specific, actionable, and immediately useful. Return JSON only.`,
        prompt: `Create a ${magType} lead magnet from this content.

Source material:
${typeof sourceText === 'string' ? sourceText.slice(0, 3000) : JSON.stringify(sourceText).slice(0, 3000)}

Return JSON:
{
  "title": "compelling title that promises specific outcome",
  "subtitle": "what they'll learn/get",
  "landing_page": {
    "headline": "above-the-fold headline",
    "subheadline": "supporting line",
    "bullet_points": ["5 specific outcomes they'll get"],
    "cta_button": "Download Now — button text",
    "social_proof": "X firms have used this to Y"
  },
  "content": {
    "sections": [
      {
        "title": "section title",
        "body": "detailed content for this section",
        "actionable_tip": "what to do right now"
      }
    ],
    "bonus": "bonus tip or resource at the end"
  },
  "follow_up_email": {
    "subject": "email subject for delivery",
    "body": "email body with download link placeholder and next steps"
  },
  "promotion_post": "LinkedIn post to promote this lead magnet",
  "estimated_conversion": "expected opt-in rate with good promotion"
}`,
        maxTokens: 5000
      });
      const parsed = parseJsonResponse(result);
      const magnets = readJSON('generated-lead-magnets.json', []);
      const magnet = { id: generateId(), type: magType, ...parsed, generated_at: now() };
      magnets.unshift(magnet);
      writeJSON('generated-lead-magnets.json', magnets);
      return json(res, { ok: true, ...magnet });
    }

    // GET /api/generated-lead-magnets
    if (method === 'GET' && pathname === '/api/generated-lead-magnets') {
      return json(res, readJSON('generated-lead-magnets.json', []));
    }

    // POST /api/funnel-analyzer — Analyze content funnel health and find gaps
    if (method === 'POST' && pathname === '/api/funnel-analyzer') {
      const allContent = readJSON('content.json', []);
      const triggers = readJSON('trigger-queue.json', []);
      const published = readJSON('published.json', []);
      const leadMagnets = readJSON('generated-lead-magnets.json', []);
      const newsletters = readJSON('newsletters.json', []);
      const emailSeqs = readJSON('email-sequences.json', []);

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const result = await callClaude({
        model: HAIKU,
        system: 'You are a marketing funnel analyst. Analyze the full content-to-lead pipeline and identify gaps, bottlenecks, and optimization opportunities at each stage: TOFU (awareness), MOFU (consideration), BOFU (decision). Return JSON only.',
        prompt: `Analyze this content funnel.

Stats:
- ${triggers.length} triggers (${triggers.filter(t => t.status === 'pending').length} pending)
- ${allContent.length} content pieces (${allContent.filter(c => c.status === 'approved').length} approved)
- ${published.length} published
- ${leadMagnets.length} lead magnets
- ${newsletters.length} newsletters compiled
- ${emailSeqs.length} email sequences

Return JSON:
{
  "funnel_health": "strong|moderate|weak",
  "stages": [
    {
      "stage": "TOFU|MOFU|BOFU",
      "health": "strong|moderate|weak",
      "content_count": 0,
      "gaps": ["what's missing"],
      "recommendations": ["what to create"],
      "priority": "high|medium|low"
    }
  ],
  "bottleneck": {
    "stage": "where the biggest drop-off is",
    "reason": "why people get stuck here",
    "fix": "specific action to unblock"
  },
  "quick_wins": ["immediate improvements ranked by impact"],
  "content_needs": [
    { "type": "what to create", "stage": "TOFU|MOFU|BOFU", "priority": "high|medium|low", "why": "expected impact" }
  ],
  "conversion_estimate": "estimated lead capture rate given current assets"
}`,
        maxTokens: 3000
      });
      const parsed = parseJsonResponse(result);
      writeJSON('funnel-analysis.json', { ...parsed, analyzed_at: now() });
      return json(res, { ok: true, ...parsed });
    }

    // GET /api/funnel-analysis
    if (method === 'GET' && pathname === '/api/funnel-analysis') {
      return json(res, readJSON('funnel-analysis.json', null));
    }

    // POST /api/auto-repurpose — Auto-repurpose top content across all formats and platforms
    if (method === 'POST' && pathname === '/api/auto-repurpose') {
      const allContent = readJSON('content.json', []);
      const approved = allContent.filter(c => c.status === 'approved').slice(0, 5);
      if (approved.length === 0) return json(res, { error: 'No approved content to repurpose' }, 400);

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const repurposed = [];

      for (const item of approved.slice(0, 3)) {
        const fk = Object.keys(item.formats || {})[0];
        const text = item.formats?.[fk]?.text || item.formats?.[fk] || '';
        if (!text || typeof text !== 'string' || text.length < 100) continue;

        const result = await callClaude({
          model: HAIKU,
          system: 'You are a content repurposing machine. Take one piece of content and transform it into 6 different formats, each optimized for its target platform. Every output should feel native to the platform, not like a lazy copy-paste. Return JSON only.',
          prompt: `Repurpose this content into 6 platform-native formats.

Original:
${text.slice(0, 2000)}

Return JSON:
{
  "linkedin_post": "full LinkedIn post",
  "x_thread": ["tweet 1", "tweet 2", "tweet 3", "tweet 4"],
  "youtube_short_script": "60-second video script",
  "newsletter_section": "newsletter-ready paragraph",
  "carousel_outline": ["slide 1 headline", "slide 2", "slide 3", "slide 4", "CTA slide"],
  "email_teaser": "email subject + 2-line teaser"
}`,
          maxTokens: 3000
        });
        const parsed = parseJsonResponse(result);
        repurposed.push({ content_id: item.id, title: item.trigger_title || item.title, formats: parsed });
      }

      const batch = { items: repurposed, generated_at: now() };
      writeJSON('auto-repurpose.json', batch);
      return json(res, { ok: true, count: repurposed.length, ...batch });
    }

    // GET /api/auto-repurpose
    if (method === 'GET' && pathname === '/api/auto-repurpose') {
      return json(res, readJSON('auto-repurpose.json', { items: [] }));
    }

    // POST /api/content/:id/story-builder — Build a compelling narrative from data/facts content
    if (method === 'POST' && pathname.match(/^\/api\/content\/([^/]+)\/story-builder$/)) {
      const contentId = pathname.split('/')[3];
      const allContent = readJSON('content.json', []);
      const item = allContent.find(c => c.id === contentId);
      if (!item) return json(res, { error: 'Content not found' }, 404);
      const formatKey = Object.keys(item.formats || {})[0];
      const text = item.formats?.[formatKey]?.text || item.formats?.[formatKey];
      if (!text) return json(res, { error: 'No content found' }, 400);

      const { callClaude, parseJsonResponse, SONNET } = require('./lib/claude');
      const result = await callClaude({
        model: SONNET,
        system: 'You are a storytelling expert who transforms dry facts and data into compelling narratives. Stories are 22x more memorable than facts alone. Use the Hero\'s Journey, tension/resolution, and specific details to make content stick. Return JSON only.',
        prompt: `Transform this content into a compelling story.

Original:
${typeof text === 'string' ? text.slice(0, 3000) : JSON.stringify(text).slice(0, 3000)}

Return JSON:
{
  "story_version": "full story post for LinkedIn (800-1200 words)",
  "mini_story": "condensed story for X (3-5 tweets)",
  "story_structure": {
    "hook": "opening that creates immediate tension",
    "setup": "context that makes the audience care",
    "conflict": "the problem or challenge",
    "turning_point": "the breakthrough moment",
    "resolution": "the result with specific numbers",
    "lesson": "the takeaway that applies to the reader"
  },
  "emotional_arc": "how the story makes the reader feel at each stage",
  "why_it_works": "storytelling principles used"
}`,
        maxTokens: 4000
      });
      const parsed = parseJsonResponse(result);
      return json(res, { ok: true, content_id: contentId, ...parsed });
    }

    // POST /api/weekly-action-plan — Generate a specific weekly action plan
    if (method === 'POST' && pathname === '/api/weekly-action-plan') {
      const allContent = readJSON('content.json', []);
      const triggers = readJSON('trigger-queue.json', []);
      const published = readJSON('published.json', []);
      const series = readJSON('series-templates.json', { series: [] });
      const commentStrategy = readJSON('comment-strategy.json', null);
      const replyStrategy = readJSON('reply-strategy.json', null);

      const dayOfWeek = new Date().toLocaleDateString('en-US', { weekday: 'long' });

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const result = await callClaude({
        model: HAIKU,
        system: 'You are a marketing operations manager. Create hyper-specific daily action plans that someone can follow step-by-step with zero ambiguity. Include exact times, exact actions, and expected outcomes. Return JSON only.',
        prompt: `Create this week's action plan starting from ${dayOfWeek}.

Current state:
- ${triggers.filter(t => t.status === 'pending').length} pending triggers
- ${allContent.filter(c => c.status === 'review').length} content in review
- ${allContent.filter(c => c.status === 'approved').length} approved (ready to publish)
- ${published.length} published total
- ${(series.series || []).length} content series defined
- Comment strategy: ${commentStrategy ? 'ready' : 'not created'}
- Reply strategy: ${replyStrategy ? 'ready' : 'not created'}

Return JSON:
{
  "week_theme": "this week's focus",
  "days": [
    {
      "day": "Monday",
      "morning": [{ "time": "8:00 AM", "action": "specific task", "duration": "15 min", "tool": "content-machine|linkedin|x|manual" }],
      "midday": [{ "time": "12:00 PM", "action": "...", "duration": "...", "tool": "..." }],
      "afternoon": [{ "time": "3:00 PM", "action": "...", "duration": "...", "tool": "..." }]
    }
  ],
  "weekly_kpis": [{ "metric": "what to track", "target": "number to hit", "how": "how to measure" }],
  "content_targets": { "create": 5, "review": 10, "publish": 3, "engage": 30 }
}`,
        maxTokens: 4000
      });
      const parsed = parseJsonResponse(result);
      const plan = { ...parsed, generated_at: now() };
      writeJSON('weekly-action-plan.json', plan);
      return json(res, { ok: true, ...plan });
    }

    // GET /api/weekly-action-plan
    if (method === 'GET' && pathname === '/api/weekly-action-plan') {
      return json(res, readJSON('weekly-action-plan.json', null));
    }

    // ======= BATCH 61: AI Content Reviewer, Trends Analyzer, Publishing Workflow, Authority Score =======

    // POST /api/content/:id/ai-review — Comprehensive AI content review with actionable feedback
    if (method === 'POST' && pathname.match(/^\/api\/content\/([^/]+)\/ai-review$/)) {
      const contentId = pathname.split('/')[3];
      const allContent = readJSON('content.json', []);
      const item = allContent.find(c => c.id === contentId);
      if (!item) return json(res, { error: 'Content not found' }, 404);
      const body = await parseBody(req);
      const formatKey = body.format || Object.keys(item.formats || {})[0];
      const text = item.formats?.[formatKey]?.text || item.formats?.[formatKey];
      if (!text) return json(res, { error: 'No content found' }, 400);

      const { callClaude, parseJsonResponse, SONNET } = require('./lib/claude');
      const result = await callClaude({
        model: SONNET,
        system: 'You are a senior content editor for a legal marketing agency. Review content like a tough-but-fair editor: be honest about what\'s weak, specific about how to fix it, and generous about what works. Score on 5 dimensions: hook quality, value density, readability, brand voice, and CTA effectiveness. Return JSON only.',
        prompt: `Review this ${formatKey} content piece as a senior editor.

Content:
${typeof text === 'string' ? text.slice(0, 3000) : JSON.stringify(text).slice(0, 3000)}

Return JSON:
{
  "overall_verdict": "publish|revise|kill",
  "overall_score": 0-100,
  "dimensions": {
    "hook_quality": { "score": 0-100, "feedback": "specific feedback", "fix": "how to improve" },
    "value_density": { "score": 0-100, "feedback": "...", "fix": "..." },
    "readability": { "score": 0-100, "feedback": "...", "fix": "..." },
    "brand_voice": { "score": 0-100, "feedback": "...", "fix": "..." },
    "cta_effectiveness": { "score": 0-100, "feedback": "...", "fix": "..." }
  },
  "strengths": ["what's working well"],
  "weaknesses": ["what needs fixing"],
  "line_edits": [
    { "original": "problematic sentence", "suggested": "improved version", "reason": "why" }
  ],
  "rewrite_hook": "if the hook is weak, here's a better one",
  "missing_elements": ["what the content should include but doesn't"],
  "competitive_analysis": "how this compares to top legal marketing content on LinkedIn"
}`,
        maxTokens: 4000
      });
      const parsed = parseJsonResponse(result);

      // Save review to content item
      const idx = allContent.findIndex(c => c.id === contentId);
      if (idx !== -1) {
        if (!allContent[idx].reviews) allContent[idx].reviews = {};
        allContent[idx].reviews[formatKey] = { ...parsed, reviewed_at: now() };
        writeJSON('content.json', allContent);
      }
      return json(res, { ok: true, content_id: contentId, format: formatKey, ...parsed });
    }

    // POST /api/trends-analyzer — Analyze trending topics across all scraped sources
    if (method === 'POST' && pathname === '/api/trends-analyzer') {
      const triggers = readJSON('trigger-queue.json', []);
      const now_ts = Date.now();
      const sevenDaysAgo = now_ts - 7 * 24 * 60 * 60 * 1000;
      const recentTriggers = triggers.filter(t => new Date(t.captured_at) > sevenDaysAgo);

      const sourceBreakdown = {};
      recentTriggers.forEach(t => {
        const src = t.source || 'unknown';
        if (!sourceBreakdown[src]) sourceBreakdown[src] = [];
        sourceBreakdown[src].push(t.title || t.topic);
      });

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const result = await callClaude({
        model: HAIKU,
        system: 'You are a trends analyst who spots emerging patterns before they peak. Analyze scraped content to identify trending topics, emerging conversations, and content opportunities that a legal marketing agency should jump on NOW. Return JSON only.',
        prompt: `Analyze these ${recentTriggers.length} triggers from the past 7 days to identify trends.

By source:
${Object.entries(sourceBreakdown).map(([src, titles]) => `${src} (${titles.length}): ${titles.slice(0, 10).join(' | ')}`).join('\n')}

Return JSON:
{
  "emerging_trends": [
    {
      "trend": "what's trending",
      "signals": ["where you're seeing this"],
      "velocity": "rising|peaking|declining",
      "content_angle": "how to create content about this",
      "urgency": "post_today|this_week|this_month",
      "format": "best content format for this"
    }
  ],
  "dying_topics": ["topics that are losing traction"],
  "gap_opportunities": ["topics nobody is covering well"],
  "content_calendar_suggestions": [
    { "day": "Monday", "topic": "...", "angle": "...", "why_now": "..." }
  ],
  "competitor_moves": ["what competitors seem to be doing based on the data"]
}`,
        maxTokens: 3000
      });
      const parsed = parseJsonResponse(result);
      const analysis = { ...parsed, trigger_count: recentTriggers.length, analyzed_at: now() };
      writeJSON('trends-analysis.json', analysis);
      return json(res, { ok: true, ...analysis });
    }

    // GET /api/trends-analysis
    if (method === 'GET' && pathname === '/api/trends-analysis') {
      return json(res, readJSON('trends-analysis.json', null));
    }

    // POST /api/publish-workflow — Execute publishing workflow for a content piece
    if (method === 'POST' && pathname === '/api/publish-workflow') {
      const body = await parseBody(req);
      const contentId = body.content_id;
      const platform = body.platform || 'linkedin';

      if (!contentId) return json(res, { error: 'content_id required' }, 400);

      const allContent = readJSON('content.json', []);
      const item = allContent.find(c => c.id === contentId);
      if (!item) return json(res, { error: 'Content not found' }, 404);

      // Find the best format for the target platform
      const platformFormats = {
        linkedin: ['linkedin_post', 'linkedin', 'carousel', 'poll', 'hot_take'],
        x: ['x_single', 'x_thread', 'hot_take'],
        email: ['newsletter', 'blog'],
        youtube: ['youtube_script', 'short_video_script']
      };
      const candidates = platformFormats[platform] || Object.keys(item.formats || {});
      const formatKey = candidates.find(f => item.formats?.[f]) || Object.keys(item.formats || {})[0];
      const text = item.formats?.[formatKey]?.text || item.formats?.[formatKey];
      if (!text) return json(res, { error: `No ${platform} format found` }, 400);

      // Build publishing package
      const published = readJSON('published.json', []);
      const contentBank = readJSON('content-bank.json', { log: [], stats: {} });

      const publishEntry = {
        content_id: contentId,
        platform,
        format: formatKey,
        content: typeof text === 'string' ? text : JSON.stringify(text),
        published_at: now(),
        status: 'ready'
      };

      published.push(publishEntry);
      writeJSON('published.json', published);

      // Update content bank
      const contentType = text.toString().includes('audit') || text.toString().includes('free') || text.toString().includes('DM') ? 'cta' : 'value';
      contentBank.log.push({ content_id: contentId, type: contentType, platform, posted_at: now() });
      contentBank.stats[contentType] = (contentBank.stats[contentType] || 0) + 1;
      writeJSON('content-bank.json', contentBank);

      // Mark content as published
      const idx = allContent.findIndex(c => c.id === contentId);
      if (idx !== -1) {
        allContent[idx].status = 'published';
        allContent[idx].published_at = now();
        allContent[idx].published_platform = platform;
        writeJSON('content.json', allContent);
      }

      return json(res, {
        ok: true,
        content_id: contentId,
        platform,
        format: formatKey,
        content: typeof text === 'string' ? text.slice(0, 500) : 'Content ready',
        bank_type: contentType,
        bank_ratio: `${contentBank.stats.value || 0} value : ${contentBank.stats.cta || 0} CTA`,
        next_action: `Copy content and post to ${platform}. Engage with comments for first 60 minutes.`
      });
    }

    // GET /api/authority-score — Calculate overall authority score based on all activities
    if (method === 'GET' && pathname === '/api/authority-score') {
      const allContent = readJSON('content.json', []);
      const published = readJSON('published.json', []);
      const series = readJSON('series-templates.json', { series: [] });
      const leadMagnets = readJSON('generated-lead-magnets.json', []);
      const newsletters = readJSON('newsletters.json', []);
      const contentDna = readJSON('content-dna.json', null);
      const audienceSegments = readJSON('audience-segments.json', null);
      const growthPlaybook = readJSON('growth-playbook.json', null);

      let score = 0;
      const breakdown = [];

      // Content Volume (max 20 points)
      const contentPts = Math.min(20, allContent.length);
      score += contentPts;
      breakdown.push({ category: 'Content Volume', score: contentPts, max: 20, detail: `${allContent.length} pieces` });

      // Publishing Consistency (max 20 points)
      const pubPts = Math.min(20, published.length * 4);
      score += pubPts;
      breakdown.push({ category: 'Publishing', score: pubPts, max: 20, detail: `${published.length} published` });

      // Strategic Assets (max 20 points)
      const assetPts = Math.min(20, (leadMagnets.length * 4) + (newsletters.length * 3) + ((series.series || []).length * 2));
      score += assetPts;
      breakdown.push({ category: 'Strategic Assets', score: assetPts, max: 20, detail: `${leadMagnets.length} magnets, ${newsletters.length} newsletters` });

      // Content Strategy (max 20 points)
      const stratPts = (contentDna ? 5 : 0) + (audienceSegments ? 5 : 0) + (growthPlaybook ? 5 : 0) + ((series.series || []).length > 3 ? 5 : 0);
      score += stratPts;
      breakdown.push({ category: 'Strategy Depth', score: stratPts, max: 20, detail: `DNA + Segments + Playbook + Series` });

      // Content Quality (max 20 points)
      const approved = allContent.filter(c => c.status === 'approved' || c.status === 'published').length;
      const qualPts = allContent.length > 0 ? Math.min(20, Math.round(approved / allContent.length * 20)) : 0;
      score += qualPts;
      breakdown.push({ category: 'Quality Rate', score: qualPts, max: 20, detail: `${approved}/${allContent.length} approved` });

      const level = score >= 80 ? 'Authority' : score >= 60 ? 'Rising Voice' : score >= 40 ? 'Building' : score >= 20 ? 'Getting Started' : 'Beginner';

      return json(res, {
        authority_score: score,
        level,
        breakdown,
        next_milestone: score < 40 ? 'Build: Create 10 more content pieces and publish 3' : score < 60 ? 'Rise: Generate lead magnets and start weekly newsletter' : score < 80 ? 'Lead: Establish content DNA and grow to 20+ published' : 'Maintain: Keep publishing consistently and expand to new platforms'
      });
    }

    // POST /api/content/:id/rewrite — AI rewrite with specific direction
    if (method === 'POST' && pathname.match(/^\/api\/content\/([^/]+)\/rewrite$/)) {
      const contentId = pathname.split('/')[3];
      const allContent = readJSON('content.json', []);
      const item = allContent.find(c => c.id === contentId);
      if (!item) return json(res, { error: 'Content not found' }, 404);
      const body = await parseBody(req);
      const formatKey = body.format || Object.keys(item.formats || {})[0];
      const text = item.formats?.[formatKey]?.text || item.formats?.[formatKey];
      if (!text) return json(res, { error: 'No content found' }, 400);
      const direction = body.direction || 'more engaging and punchy';

      const { callClaude, parseJsonResponse, SONNET } = require('./lib/claude');
      const result = await callClaude({
        model: SONNET,
        system: 'You are a senior content writer for Mortar Metrics, a legal marketing agency. Rewrite content based on specific editorial direction while preserving the core message and data points. Return JSON only.',
        prompt: `Rewrite this content with this direction: "${direction}"

Original:
${typeof text === 'string' ? text.slice(0, 3000) : JSON.stringify(text).slice(0, 3000)}

Return JSON:
{
  "rewritten": "the full rewritten content",
  "changes_made": ["list of specific changes"],
  "preserved": ["what was kept from the original"],
  "word_count_change": "+X or -X words"
}`,
        maxTokens: 4000
      });
      const parsed = parseJsonResponse(result);

      // Save as a new version
      const idx = allContent.findIndex(c => c.id === contentId);
      if (idx !== -1 && parsed.rewritten) {
        if (!allContent[idx].versions) allContent[idx].versions = {};
        if (!allContent[idx].versions[formatKey]) allContent[idx].versions[formatKey] = [];
        allContent[idx].versions[formatKey].push({
          text: typeof text === 'string' ? text : JSON.stringify(text),
          saved_at: now()
        });
        if (typeof allContent[idx].formats[formatKey] === 'string') {
          allContent[idx].formats[formatKey] = parsed.rewritten;
        } else if (allContent[idx].formats[formatKey]?.text) {
          allContent[idx].formats[formatKey].text = parsed.rewritten;
        }
        writeJSON('content.json', allContent);
      }
      return json(res, { ok: true, content_id: contentId, format: formatKey, ...parsed });
    }

    // ======= BATCH 62: Content Intelligence, Conversion Optimization, Automated Workflows =======

    // POST /api/content-intelligence — AI-powered content strategy recommendations
    if (method === 'POST' && pathname === '/api/content-intelligence') {
      const allContent = readJSON('content.json', []);
      const triggers = readJSON('trigger-queue.json', []);
      const published = readJSON('published.json', []);
      const contentDna = readJSON('content-dna.json', null);
      const trendsAnalysis = readJSON('trends-analysis.json', null);
      const funnelAnalysis = readJSON('funnel-analysis.json', null);

      const { callClaude, parseJsonResponse, SONNET } = require('./lib/claude');
      const result = await callClaude({
        model: SONNET,
        system: 'You are a chief content strategist with data-driven insights. Analyze the full content ecosystem and provide specific, actionable intelligence that will grow the audience and generate leads. No vague advice — every recommendation should be "do X by Y to achieve Z". Return JSON only.',
        prompt: `Analyze our content ecosystem and provide intelligence briefing.

Current state:
- ${allContent.length} content pieces, ${published.length} published
- ${triggers.filter(t => t.status === 'pending').length} pending triggers
- DNA analysis: ${contentDna ? 'done' : 'not done'}
- Trends: ${trendsAnalysis?.emerging_trends?.length || 0} emerging trends
- Funnel: ${funnelAnalysis?.funnel_health || 'not analyzed'}
- Approval rate: ${allContent.length > 0 ? Math.round(allContent.filter(c => c.status === 'approved' || c.status === 'published').length / allContent.length * 100) : 0}%
- Top sources: ${Object.entries(triggers.reduce((acc, t) => { acc[t.source || 'unknown'] = (acc[t.source || 'unknown'] || 0) + 1; return acc; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s, c]) => `${s}(${c})`).join(', ')}

Return JSON:
{
  "executive_summary": "2-3 sentence state of the content program",
  "biggest_opportunity": {
    "what": "specific opportunity",
    "why": "why now",
    "how": "exact steps to capture it",
    "expected_impact": "quantified outcome"
  },
  "biggest_risk": {
    "what": "specific risk",
    "impact": "what happens if ignored",
    "mitigation": "how to prevent it"
  },
  "this_week_priorities": [
    { "priority": 1, "action": "specific action", "expected_outcome": "...", "time_needed": "30 min" }
  ],
  "content_gaps": [
    { "gap": "what's missing", "impact": "why it matters", "solution": "what to create" }
  ],
  "performance_insights": [
    { "insight": "data-driven observation", "action": "what to do about it" }
  ],
  "competitor_intelligence": "what competitors are doing that we should respond to"
}`,
        maxTokens: 4000
      });
      const parsed = parseJsonResponse(result);
      const intel = { ...parsed, generated_at: now() };
      writeJSON('content-intelligence.json', intel);
      return json(res, { ok: true, ...intel });
    }

    // GET /api/content-intelligence
    if (method === 'GET' && pathname === '/api/content-intelligence') {
      return json(res, readJSON('content-intelligence.json', null));
    }

    // POST /api/conversion-optimizer — Optimize content for lead conversion
    if (method === 'POST' && pathname === '/api/conversion-optimizer') {
      const allContent = readJSON('content.json', []);
      const published = readJSON('published.json', []);
      const leadMagnets = readJSON('generated-lead-magnets.json', []);
      const emailSeqs = readJSON('email-sequences.json', []);

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const result = await callClaude({
        model: HAIKU,
        system: 'You are a conversion rate optimization expert for B2B content marketing. Focus on turning content consumers into leads: comment → DM → email → call. Every piece of content should have a clear conversion path. Return JSON only.',
        prompt: `Optimize our content-to-conversion pipeline.

Assets: ${published.length} published, ${leadMagnets.length} lead magnets, ${emailSeqs.length} email sequences.
Content ready: ${allContent.filter(c => c.status === 'approved').length} approved pieces.

Return JSON:
{
  "conversion_score": 0-100,
  "current_path": "description of current conversion journey",
  "optimized_path": {
    "step_1": { "stage": "awareness", "action": "what happens", "content_type": "what to use", "conversion_trigger": "what moves them forward" },
    "step_2": { "stage": "interest", "action": "...", "content_type": "...", "conversion_trigger": "..." },
    "step_3": { "stage": "consideration", "action": "...", "content_type": "...", "conversion_trigger": "..." },
    "step_4": { "stage": "decision", "action": "...", "content_type": "...", "conversion_trigger": "..." }
  },
  "cta_matrix": [
    { "content_type": "linkedin_post", "primary_cta": "comment-based", "secondary_cta": "DM offer", "conversion_rate": "expected %" }
  ],
  "missing_assets": ["what needs to be created for the funnel to work"],
  "quick_fixes": ["immediate changes to increase conversion"],
  "dm_playbook": {
    "trigger": "when to DM someone",
    "opener": "first message",
    "follow_up": "if no response",
    "close": "moving to a call"
  }
}`,
        maxTokens: 3000
      });
      const parsed = parseJsonResponse(result);
      writeJSON('conversion-optimizer.json', { ...parsed, generated_at: now() });
      return json(res, { ok: true, ...parsed });
    }

    // GET /api/conversion-optimizer
    if (method === 'GET' && pathname === '/api/conversion-optimizer') {
      return json(res, readJSON('conversion-optimizer.json', null));
    }

    // POST /api/content/:id/persona-adapt — Adapt content for specific audience persona
    if (method === 'POST' && pathname.match(/^\/api\/content\/([^/]+)\/persona-adapt$/)) {
      const contentId = pathname.split('/')[3];
      const allContent = readJSON('content.json', []);
      const item = allContent.find(c => c.id === contentId);
      if (!item) return json(res, { error: 'Content not found' }, 404);
      const body = await parseBody(req);
      const formatKey = body.format || Object.keys(item.formats || {})[0];
      const text = item.formats?.[formatKey]?.text || item.formats?.[formatKey];
      if (!text) return json(res, { error: 'No content found' }, 400);

      const audienceSegments = readJSON('audience-segments.json', null);
      const personas = audienceSegments?.segments || [
        { name: 'Solo PI Attorney', pain: 'Overwhelmed, needs cases but no time for marketing' },
        { name: 'Managing Partner', pain: 'Wants growth, skeptical of agencies after bad experiences' },
        { name: 'Marketing Director', pain: 'Needs to prove ROI to partners, limited budget' }
      ];

      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const result = await callClaude({
        model: HAIKU,
        system: 'You are an audience adaptation specialist. Take one piece of content and rewrite it specifically for different audience personas. Each version should speak directly to that persona\'s pain points, language, and decision-making criteria. Return JSON only.',
        prompt: `Adapt this content for each audience persona.

Original:
${typeof text === 'string' ? text.slice(0, 2000) : JSON.stringify(text).slice(0, 2000)}

Personas:
${personas.slice(0, 3).map((p, i) => `${i + 1}. ${p.name}: ${p.pain || p.description || ''}`).join('\n')}

Return JSON:
{
  "adaptations": [
    {
      "persona": "persona name",
      "adapted_content": "full rewritten content for this persona",
      "key_changes": ["what was changed and why"],
      "best_platform": "where this persona is most active",
      "cta": "persona-specific CTA"
    }
  ],
  "universal_elements": ["what works for all personas"],
  "testing_suggestion": "which persona version to test first and why"
}`,
        maxTokens: 4000
      });
      const parsed = parseJsonResponse(result);
      return json(res, { ok: true, content_id: contentId, format: formatKey, ...parsed });
    }

    // POST /api/content-audit — Full audit of all content quality and strategy alignment
    if (method === 'POST' && pathname === '/api/content-audit') {
      const allContent = readJSON('content.json', []);
      const triggers = readJSON('trigger-queue.json', []);
      const series = readJSON('series-templates.json', { series: [] });

      // Calculate audit metrics without AI
      const totalContent = allContent.length;
      const byStatus = { review: 0, approved: 0, rejected: 0, published: 0 };
      allContent.forEach(c => { byStatus[c.status] = (byStatus[c.status] || 0) + 1; });

      const formatDistribution = {};
      allContent.forEach(c => {
        Object.keys(c.formats || {}).forEach(f => {
          formatDistribution[f] = (formatDistribution[f] || 0) + 1;
        });
      });

      const avgFormats = totalContent > 0 ? (Object.values(formatDistribution).reduce((a, b) => a + b, 0) / totalContent).toFixed(1) : 0;

      // Source quality
      const sourceQuality = {};
      triggers.forEach(t => {
        const src = t.source || 'unknown';
        if (!sourceQuality[src]) sourceQuality[src] = { total: 0, high_score: 0, used: 0 };
        sourceQuality[src].total++;
        if ((t.score || 0) >= 70) sourceQuality[src].high_score++;
        if (t.status === 'used') sourceQuality[src].used++;
      });

      // Age distribution
      const now_ts = Date.now();
      const ageGroups = { today: 0, this_week: 0, this_month: 0, older: 0 };
      allContent.forEach(c => {
        const age = now_ts - new Date(c.created_at).getTime();
        if (age < 86400000) ageGroups.today++;
        else if (age < 604800000) ageGroups.this_week++;
        else if (age < 2592000000) ageGroups.this_month++;
        else ageGroups.older++;
      });

      return json(res, {
        ok: true,
        total_content: totalContent,
        status_breakdown: byStatus,
        format_distribution: formatDistribution,
        avg_formats_per_piece: parseFloat(avgFormats),
        source_quality: sourceQuality,
        age_distribution: ageGroups,
        series_defined: (series.series || []).length,
        approval_rate: totalContent > 0 ? Math.round((byStatus.approved + byStatus.published) / totalContent * 100) : 0,
        recommendations: [
          byStatus.review > 10 ? `Review backlog: ${byStatus.review} pieces need review` : null,
          byStatus.approved > 5 ? `${byStatus.approved} approved pieces ready to publish` : null,
          Object.keys(formatDistribution).length < 5 ? 'Limited format diversity — try carousels, polls, or video scripts' : null,
          ageGroups.older > totalContent * 0.5 ? 'Over 50% of content is 30+ days old — recycle or refresh' : null
        ].filter(Boolean),
        audited_at: now()
      });
    }

    // POST /api/one-click-publish — One-click generation + optimization + publishing package
    if (method === 'POST' && pathname === '/api/one-click-publish') {
      const body = await parseBody(req);
      const triggerId = body.trigger_id;

      if (!triggerId) return json(res, { error: 'trigger_id required' }, 400);

      const triggers = readJSON('trigger-queue.json', []);
      const trigger = triggers.find(t => t.id === triggerId);
      if (!trigger) return json(res, { error: 'Trigger not found' }, 404);

      // Step 1: Generate content
      const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
      const genResult = await callClaude({
        model: HAIKU,
        system: 'You are a content writer for Mortar Metrics, a legal marketing agency that helps law firms get more signed cases. Write in a direct, data-driven style. No fluff. Every post should teach something or provoke thought. Return JSON only.',
        prompt: `Create a LinkedIn post and an X tweet from this trigger.

Trigger: ${trigger.title || trigger.topic}
Source: ${trigger.source || 'unknown'}
Context: ${trigger.summary || trigger.description || ''}

Return JSON:
{
  "linkedin_post": "full LinkedIn post (800-1200 chars, hook first line, end with CTA)",
  "x_tweet": "single tweet (280 chars max, punchy)",
  "hashtags": ["3 LinkedIn hashtags"],
  "best_posting_time": "when to post for max reach",
  "engagement_prediction": "low|medium|high"
}`,
        maxTokens: 2000
      });
      const genParsed = parseJsonResponse(genResult);

      // Step 2: Save as content
      const allContent = readJSON('content.json', []);
      const contentId = generateId();
      const newContent = {
        id: contentId,
        trigger_id: triggerId,
        trigger_title: trigger.title || trigger.topic,
        status: 'approved',
        formats: {
          linkedin_post: { text: genParsed.linkedin_post, status: 'approved' },
          x_single: { text: genParsed.x_tweet, status: 'approved' }
        },
        created_at: now(),
        auto_generated: true
      };
      allContent.push(newContent);
      writeJSON('content.json', allContent);

      // Step 3: Mark trigger as used
      const tIdx = triggers.findIndex(t => t.id === triggerId);
      if (tIdx !== -1) {
        triggers[tIdx].status = 'used';
        triggers[tIdx].used_at = now();
        writeJSON('trigger-queue.json', triggers);
      }

      return json(res, {
        ok: true,
        content_id: contentId,
        linkedin_post: genParsed.linkedin_post,
        x_tweet: genParsed.x_tweet,
        hashtags: genParsed.hashtags,
        best_posting_time: genParsed.best_posting_time,
        engagement_prediction: genParsed.engagement_prediction,
        next_step: 'Copy the LinkedIn post and X tweet above. Post them now!'
      });
    }

    // --- Static file serving ---

    // Serve dashboard
    if (pathname === '/' || pathname === '/index.html') {
      return serveStatic(res, path.join(__dirname, 'dashboard', 'index.html'), 'text/html');
    }

    // Serve other static files from dashboard/
    const ext = path.extname(pathname);
    if (ext && MIME[ext]) {
      const filePath = path.join(__dirname, 'dashboard', pathname);
      const resolved = path.resolve(filePath);
      const dashboardDir = path.resolve(path.join(__dirname, 'dashboard'));
      if (!resolved.startsWith(dashboardDir + path.sep) && resolved !== dashboardDir) {
        return json(res, { error: 'Forbidden' }, 403);
      }
      if (fs.existsSync(filePath)) {
        return serveStatic(res, filePath, MIME[ext]);
      }
    }

    // 404
    json(res, { error: 'Not found' }, 404);

  } catch (err) {
    console.error('Server error:', err);
    json(res, { error: 'Internal server error' }, 500);
  }
}

// --- Error handling ---

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('[FATAL] Unhandled rejection:', err);
});

// --- Cron jobs ---

const cron = require('node-cron');

// Daily brief at 8 AM EST (13:00 UTC)
cron.schedule('0 13 * * *', async () => {
  console.log('[cron] Running daily brief...');
  try {
    const { generateBrief, sendTelegram } = require('./generator/daily-brief');
    const brief = await generateBrief();
    await sendTelegram(brief);
    console.log('[cron] Daily brief sent');
  } catch (err) {
    console.error('[cron] Daily brief failed:', err.message);
    try { db.logError('cron', 'daily_brief', err.message); } catch {}
  }
});

// Alert check every 2 hours — pestering due, cold deals, overdue proposals
cron.schedule('0 */2 * * *', async () => {
  try {
    const conn = db.getDb();
    const now = new Date().toISOString();

    // Pestering due
    const duePestering = conn.prepare(`
      SELECT p.*, c.name as client_name, c.firm_name
      FROM pestering_log p
      LEFT JOIN clients c ON p.client_id = c.id
      WHERE p.status = 'pending' AND p.scheduled_for <= ?
      ORDER BY p.scheduled_for ASC LIMIT 10
    `).all(now);

    for (const entry of duePestering) {
      sendTelegramAlert(
        `\u{1F4CB} Pestering due: ${entry.client_name || entry.firm_name || 'Unknown'} \u2014 ${entry.channel} ${entry.message_type}\n${entry.content ? entry.content.substring(0, 200) : 'Generate message in dashboard'}`
      );
    }

    // Deals going cold (7+ days no contact)
    const coldDeals = conn.prepare(`
      SELECT c.name, c.firm_name,
        CAST((julianday('now') - julianday(COALESCE(c.last_seen, c.created_at))) AS INTEGER) as days_silent
      FROM clients c
      WHERE c.status NOT IN ('lost', 'churned')
        AND CAST((julianday('now') - julianday(COALESCE(c.last_seen, c.created_at))) AS INTEGER) >= 7
      ORDER BY days_silent DESC LIMIT 5
    `).all();

    for (const deal of coldDeals) {
      sendTelegramAlert(
        `\u{1F534} ${deal.name || deal.firm_name} silent ${deal.days_silent} days. Yaseer: call or WhatsApp NOW.`
      );
    }

    // Proposals overdue (discovery calls 4+ hours ago without a proposal)
    const overdueProposals = conn.prepare(`
      SELECT c.name, c.firm_name, m.date as discovery_date,
        ROUND((julianday('now') - julianday(m.date)) * 24, 1) as hours_since
      FROM meetings m
      LEFT JOIN clients c ON m.client_name = c.name
      WHERE m.meeting_type = 'discovery'
        AND m.date >= datetime('now', '-3 days')
        AND m.id NOT IN (SELECT meeting_id FROM proposals WHERE meeting_id IS NOT NULL)
        AND ROUND((julianday('now') - julianday(m.date)) * 24) >= 4
      LIMIT 5
    `).all();

    for (const p of overdueProposals) {
      const target = p.hours_since >= 24 ? 'Fardeen' : 'Yaseer';
      sendTelegramAlert(
        `\u{26A0}\u{FE0F} Proposal overdue: ${p.name || p.firm_name || 'Unknown'}. Discovery was ${Math.round(p.hours_since)}h ago. ${target}: send it NOW.`
      );
    }

    if (duePestering.length || coldDeals.length || overdueProposals.length) {
      console.log(`[cron] Alerts sent: ${duePestering.length} pestering, ${coldDeals.length} cold, ${overdueProposals.length} proposals`);
    }
  } catch (err) {
    console.error('[cron] Alert check failed:', err.message);
    try { db.logError('cron', 'alert_check', err.message); } catch {}
  }
});

// Fireflies auto-sync every 6 hours
cron.schedule('0 */6 * * *', async () => {
  if (!process.env.FIREFLIES_API_KEY) return;
  console.log('[cron] Auto-syncing Fireflies transcripts...');
  try {
    const list = await fireflies.listTranscripts({ limit: 20 });
    const conn = db.getDb();
    let synced = 0;
    for (const t of list) {
      const exists = conn.prepare('SELECT 1 FROM meetings WHERE fireflies_id = ?').get(t.id);
      if (exists) continue;
      const full = await fireflies.fetchTranscript(t.id);
      if (!full) continue;
      const transcript = fireflies.sentencesToTranscript(full.sentences || []);
      const meeting = db.insertMeeting({
        fireflies_id: full.id,
        title: full.title || 'Untitled',
        date: full.dateString || new Date().toISOString(),
        duration_minutes: full.duration || 0,
        transcript,
        raw_response: full
      });
      try { await processMeeting(meeting); } catch (e) { console.error('[cron] Process meeting error:', e.message); }
      synced++;
    }
    if (synced > 0) {
      console.log(`[cron] Synced ${synced} new meetings`);
      sendTelegramAlert(`\u{1F399}\u{FE0F} Auto-synced ${synced} new meeting${synced > 1 ? 's' : ''} from Fireflies`);
    }
  } catch (err) {
    console.error('[cron] Fireflies auto-sync failed:', err.message);
    try { db.logError('cron', 'fireflies_sync', err.message); } catch {}
  }
});

// Auto-archive old published/rejected content (daily at 2AM EST)
cron.schedule('0 7 * * *', () => {
  try {
    const content = readJSON('content.json');
    const now = Date.now();
    const ARCHIVE_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
    let archived = 0;
    for (const item of content) {
      if (item.status === 'archived') continue;
      if (item.status !== 'published' && item.status !== 'rejected') continue;
      const age = now - new Date(item.generated_at || 0).getTime();
      if (age > ARCHIVE_AGE_MS) {
        item.status = 'archived';
        item.archived_at = new Date().toISOString();
        archived++;
      }
    }
    if (archived > 0) {
      writeJSON('content.json', content);
      console.log(`[cron] Auto-archived ${archived} old content pieces`);
    }
  } catch (err) {
    console.error('[cron] Auto-archive failed:', err.message);
  }
});

// Auto-archive stale triggers (daily at 2:30AM EST = 7:30 UTC)
cron.schedule('30 7 * * *', () => {
  try {
    const triggers = readJSON('trigger-queue.json');
    const archived = readJSON('archived-triggers.json');
    const cutoff = Date.now() - 21 * 24 * 60 * 60 * 1000;
    const toArchive = [];
    const keep = [];
    for (const t of triggers) {
      if (t.status === 'used') { keep.push(t); continue; }
      const age = new Date(t.captured_at || t.scraped_at || t.date || 0).getTime();
      if ((t.status === 'pending' && age < cutoff) || t.status === 'rejected') {
        toArchive.push({ ...t, status: 'archived', archived_at: now() });
      } else {
        keep.push(t);
      }
    }
    if (toArchive.length > 0) {
      writeJSON('trigger-queue.json', keep);
      writeJSON('archived-triggers.json', [...archived, ...toArchive]);
      console.log(`[cron] Trigger auto-archive: ${toArchive.length} archived, ${keep.length} remaining`);
    }
  } catch (err) {
    console.error('[cron] Trigger auto-archive failed:', err.message);
    try { db.logError('cron', 'trigger_archive', err.message); } catch {}
  }
});

// Auto-scrape for fresh triggers (daily at 6AM EST = 11 UTC)
cron.schedule('0 11 * * *', async () => {
  try {
    console.log('[cron] Running daily scrape...');
    const { runAll } = require('./scrapers/run-all');
    await runAll();
    const triggers = readJSON('trigger-queue.json');
    const fresh = triggers.filter(t => {
      const age = Date.now() - new Date(t.captured_at || t.scraped_at || t.date || 0).getTime();
      return t.status === 'pending' && age < 24 * 60 * 60 * 1000;
    });
    console.log(`[cron] Daily scrape complete: ${fresh.length} new triggers today, ${triggers.length} total`);
  } catch (err) {
    console.error('[cron] Daily scrape failed:', err.message);
    try { db.logError('cron', 'daily_scrape', err.message); } catch {}
  }
});

// Content queue auto-generation — check every 4 hours, generate if queue is low
cron.schedule('0 */4 * * *', async () => {
  try {
    const content = readJSON('content.json');
    const approvedFormats = content.reduce((sum, c) => {
      return sum + Object.values(c.formats || {}).filter(f => f.status === 'approved' && !f.published_at).length;
    }, 0);
    const daysLeft = Math.floor(approvedFormats / 2);
    if (daysLeft < 3 && process.env.ANTHROPIC_API_KEY) {
      console.log(`[cron] Content queue low (${approvedFormats} approved, ~${daysLeft}d left). Auto-generating 3 pieces...`);
      const { runDaily } = require('./generator/run-daily');
      const result = await runDaily({ count: 3 });
      const generated = result || [];
      for (const item of generated) autoScheduleContent(item);
      console.log(`[cron] Auto-generated ${generated.length} content pieces`);
    }
  } catch (err) {
    console.error('[cron] Queue auto-generation failed:', err.message);
  }
});

// --- Auto-generate today's series episode every morning at 7:30 AM ---
cron.schedule('30 7 * * *', async () => {
  if (!process.env.ANTHROPIC_API_KEY) return;
  try {
    const series = readJSON('series.json', []);
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const today = days[new Date().getDay()];
    const dueSeries = series.filter(s => s.active && s.day === today);
    if (dueSeries.length === 0) { console.log(`[cron-series] No series due on ${today}`); return; }

    const { callClaude, parseJsonResponse, HAIKU } = require('./lib/claude');
    const { buildSystemPromptWithMemory } = require('./generator/content-writer');
    const { scoreTrigger } = require('./generator/score-triggers');
    const systemPrompt = buildSystemPromptWithMemory();
    const triggers = readJSON('trigger-queue.json');
    const content = readJSON('content.json');

    for (const s of dueSeries) {
      const episodeNum = (s.episodes || []).length + 1;
      // Pick top ungenerated trigger
      const candidates = triggers
        .filter(t => t.status === 'pending')
        .map(t => ({ ...t, score: scoreTrigger(t, triggers) }))
        .sort((a, b) => b.score - a.score);
      const sourceTrigger = candidates[0];
      if (!sourceTrigger) { console.log(`[cron-series] No triggers available for ${s.name}`); continue; }

      const prompt = `Generate episode #${episodeNum} of "${s.name}" series.
SERIES: ${s.description}
TEMPLATE: ${s.template_prompt}
SOURCE: ${sourceTrigger.title}\n${(sourceTrigger.raw_content || '').slice(0, 1500)}

Return JSON: { "episode_title": "title", ${s.formats.map(f => `"${f}": "content for ${f}"`).join(', ')} }`;

      const text = await callClaude({ model: HAIKU, system: systemPrompt, prompt, maxTokens: 3000 });
      const parsed = parseJsonResponse(text);
      if (!parsed) { console.log(`[cron-series] Failed to parse ${s.name} episode`); continue; }

      const contentId = generateId();
      const formats = {};
      for (const fmt of s.formats) {
        if (parsed[fmt]) formats[fmt] = { content: parsed[fmt], status: 'review', edited: false };
      }
      content.push({
        id: contentId, trigger_id: sourceTrigger.id,
        trigger_title: parsed.episode_title || sourceTrigger.title,
        trigger_source: 'series', trigger_category: s.pillar?.toUpperCase() || 'CONTENT_PIECE',
        series_id: s.id, series_episode: episodeNum, formats, status: 'review', created_at: now()
      });

      const sIdx = series.findIndex(x => x.id === s.id);
      if (sIdx !== -1) {
        series[sIdx].episodes = series[sIdx].episodes || [];
        series[sIdx].episodes.push({ number: episodeNum, content_id: contentId, title: parsed.episode_title || `Episode ${episodeNum}`, generated_at: now() });
      }

      // Mark trigger used
      const tIdx = triggers.findIndex(t => t.id === sourceTrigger.id);
      if (tIdx !== -1) { triggers[tIdx].status = 'used'; triggers[tIdx].used_at = now(); }

      console.log(`[cron-series] Generated ${s.name} #${episodeNum}: ${parsed.episode_title || 'Untitled'}`);
    }
    writeJSON('content.json', content);
    writeJSON('series.json', series);
    writeJSON('trigger-queue.json', triggers);
  } catch (err) {
    console.error('[cron-series] Error:', err.message);
  }
}, { timezone: 'America/New_York' });

// --- Start server ---

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (err) {
    console.error('[server] Unhandled error:', err.message);
    try { db.logError('server', 'unhandled', err.message, { stack: err.stack, url: req.url, method: req.method }); } catch {}
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
});

const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log(`\n  Mortar Metrics Command Centre`);
  console.log(`  =============================`);
  console.log(`  Running at: http://localhost:${PORT}`);
  console.log(`  Claude API: ${process.env.ANTHROPIC_API_KEY ? 'OK' : 'NOT SET'}`);
  console.log(`  Fireflies: ${process.env.FIREFLIES_API_KEY ? 'OK' : 'NOT SET'}`);
  console.log(`  Telegram: ${process.env.TELEGRAM_BOT_TOKEN ? 'OK' : 'NOT SET'}`);
  console.log(`  MCP SSE: /mcp/{pipeline,fireflies,ghl,instantly}/sse`);
  console.log(`  MCP Health: /mcp/health`);
  console.log(`  Cron: daily brief 8AM EST, alerts every 2h`);
  console.log('');

  // Register Telegram webhook for reply handling
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const publicDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (tgToken && publicDomain) {
    const webhookUrl = `https://${publicDomain}/api/webhooks/telegram`;
    require('https').get(`https://api.telegram.org/bot${tgToken}/setWebhook?url=${encodeURIComponent(webhookUrl)}`, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => console.log(`  Telegram webhook: ${d.includes('"ok":true') ? 'registered' : 'FAILED'}`));
    }).on('error', (e) => console.error('  Telegram webhook error:', e.message));
  }
});

// --- Graceful shutdown ---

function gracefulShutdown(signal) {
  console.log(`\n[shutdown] ${signal} received, shutting down...`);
  server.close(() => {
    console.log('[shutdown] HTTP server closed');
    try {
      const conn = db.getDb();
      conn.pragma('wal_checkpoint(TRUNCATE)');
      conn.close();
      console.log('[shutdown] Database closed');
    } catch {}
    process.exit(0);
  });
  // Force exit after 10s if graceful fails
  setTimeout(() => { console.error('[shutdown] Forced exit'); process.exit(1); }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
