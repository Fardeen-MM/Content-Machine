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
