const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadEnv, readJSON, writeJSON, generateId, now } = require('./lib/utils');
const jsonStore = require('./lib/json-store');
const db = require('./lib/db');
const fireflies = require('./lib/fireflies');
const { processMeeting } = require('./lib/meeting-processor');

loadEnv();

// Initialize SQLite database
db.initDb();

const PORT = process.env.PORT || 3000;

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

    // GET /api/triggers
    if (pathname === '/api/triggers' && method === 'GET') {
      let triggers = readJSON('trigger-queue.json');
      const source = url.searchParams.get('source');
      const category = url.searchParams.get('category');
      const status = url.searchParams.get('status');

      if (source) triggers = triggers.filter(t => t.source === source);
      if (category) triggers = triggers.filter(t => t.category === category);
      if (status) triggers = triggers.filter(t => t.status === status);

      // Score triggers
      const { scoreTrigger } = require('./generator/score-triggers');
      triggers = triggers.map(t => ({ ...t, score: scoreTrigger(t) }));
      triggers.sort((a, b) => b.score - a.score);

      return json(res, triggers);
    }

    // GET /api/content
    if (pathname === '/api/content' && method === 'GET') {
      let content = readJSON('content.json');
      const status = url.searchParams.get('status');
      const format = url.searchParams.get('format');

      if (status) content = content.filter(c => c.status === status);

      // Sort by generated_at descending
      content.sort((a, b) => new Date(b.generated_at) - new Date(a.generated_at));
      return json(res, content);
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

      // Auto-save approved formats to memory
      const memory = readJSON('memory.json', {});
      const item = content[idx];
      const approvedFormats = Object.entries(item.formats)
        .filter(([, f]) => f.status === 'approved' && f.content);
      for (const [fmtKey, fmt] of approvedFormats) {
        const exists = memory.approved_examples?.some(
          e => e.content_id === item.id && e.format === fmtKey
        );
        if (!exists) {
          if (!memory.approved_examples) memory.approved_examples = [];
          memory.approved_examples.push({
            content_id: item.id,
            format: fmtKey,
            content: typeof fmt.content === 'string' ? fmt.content.slice(0, 2000) : JSON.stringify(fmt.content).slice(0, 2000),
            trigger_title: item.trigger_title,
            trigger_source: item.trigger_source,
            trigger_category: item.trigger_category,
            approved_at: now()
          });
          // Keep only last 50 examples per format
          const byFormat = memory.approved_examples.filter(e => e.format === fmtKey);
          if (byFormat.length > 50) {
            const oldest = byFormat[0];
            memory.approved_examples = memory.approved_examples.filter(e => e !== oldest);
          }
          writeJSON('memory.json', memory);
        }
      }

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

      if (format && content[idx].formats[format]) {
        content[idx].formats[format].status = 'rejected';
      } else {
        for (const key of Object.keys(content[idx].formats)) {
          content[idx].formats[key].status = 'rejected';
        }
        content[idx].status = 'rejected';
      }

      if (body.note) {
        content[idx].notes = (content[idx].notes || '') + `\nRejected: ${body.note}`;
      }

      writeJSON('content.json', content);
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

      published.push({
        content_id: content[idx].id,
        format,
        published_at: now(),
        platform: body.platform || format
      });

      writeJSON('published.json', published);
      return json(res, { ok: true });
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
        return json(res, { ok: true, content: result });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // POST /api/generate-daily — trigger daily generation
    if (pathname === '/api/generate-daily' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) {
        return json(res, { error: 'ANTHROPIC_API_KEY not configured. Set it in .env file.' }, 500);
      }

      try {
        const { runDaily } = require('./generator/run-daily');
        const body = await parseBody(req);
        const result = await runDaily({ count: body.count || 5 });
        return json(res, { ok: true, content: result });
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

    // POST /api/content/:id/schedule
    const scheduleMatch = pathname.match(/^\/api\/content\/([a-f0-9]+)\/schedule$/);
    if (scheduleMatch && method === 'POST') {
      const content = readJSON('content.json');
      const idx = content.findIndex(c => c.id === scheduleMatch[1]);
      if (idx === -1) return json(res, { error: 'Not found' }, 404);

      const body = await parseBody(req);
      content[idx].scheduled_date = body.date || null;
      content[idx].scheduled_platforms = body.platforms || [];
      writeJSON('content.json', content);
      return json(res, { ok: true, ...content[idx] });
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
      return json(res, {
        api_key: !!process.env.ANTHROPIC_API_KEY,
        ideogram_key: !!process.env.IDEOGRAM_API_KEY,
        youtube_key: !!process.env.YOUTUBE_API_KEY,
        fireflies_key: !!process.env.FIREFLIES_API_KEY,
        scrapers: ['reddit', 'rss', 'youtube', 'google-news', 'hackernews', 'competitors'],
        data: {
          triggers: triggers.length,
          content: content.length,
          published: published.length
        }
      });
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
        const { runAll } = require('./scrapers/run-all');
        await runAll();
        return json(res, { ok: true });
      } catch (err) {
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
            client_email: full.organizer_email || null,
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
      // Include meeting history
      const meetings = db.getMeetings({ client: client.email || client.name, limit: 20 });
      return json(res, { ...client, meetings });
    }

    // --- Actions API ---

    // PUT /api/actions/:id — update action status
    const actionUpdateMatch = pathname.match(/^\/api\/actions\/(\d+)$/);
    if (actionUpdateMatch && method === 'PUT') {
      const body = await parseBody(req);
      const action = db.updateAction(parseInt(actionUpdateMatch[1]), body);
      if (!action) return json(res, { error: 'Not found' }, 404);
      return json(res, { ok: true, ...action });
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
            client_email: full.organizer_email || null,
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

    // POST /api/webhooks/instantly
    if (pathname === '/api/webhooks/instantly' && method === 'POST') {
      const secret = process.env.INSTANTLY_WEBHOOK_SECRET;
      if (secret) {
        const headerSecret = req.headers['x-webhook-secret'];
        if (headerSecret !== secret) {
          return json(res, { error: 'Invalid secret' }, 401);
        }
      }

      const body = await parseBody(req);

      db.insertEvent({
        source: 'instantly',
        event_type: body.event_type || null,
        client_name: [body.firstName, body.lastName].filter(Boolean).join(' ') || null,
        client_email: body.lead_email || null,
        data: body
      });

      // Auto-create client for key events
      if (['lead_meeting_booked', 'lead_interested', 'reply_received'].includes(body.event_type)) {
        const name = [body.firstName, body.lastName].filter(Boolean).join(' ');
        if (body.lead_email) {
          db.upsertClient(body.lead_email, {
            name: name || 'Unknown',
            firm_name: body.companyName || null,
            source: 'instantly',
            status: body.event_type === 'lead_meeting_booked' ? 'prospect' : 'prospect'
          });
        }
      }

      return json(res, { ok: true });
    }

    // POST /api/webhooks/reports — mortar-reports webhook
    if (pathname === '/api/webhooks/reports' && method === 'POST') {
      const secret = process.env.MORTAR_REPORTS_WEBHOOK_SECRET;
      if (secret) {
        const headerSecret = req.headers['x-webhook-secret'];
        if (headerSecret !== secret) {
          return json(res, { error: 'Invalid secret' }, 401);
        }
      }

      const body = await parseBody(req);

      db.insertEvent({
        source: 'mortar-reports',
        event_type: body.event || 'report_event',
        client_name: body.lead?.name || null,
        client_email: body.lead?.email || null,
        data: body
      });

      return json(res, { ok: true });
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

// --- Start server ---

const server = http.createServer(handleRequest);

const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log(`\n  Content Machine Dashboard`);
  console.log(`  ========================`);
  console.log(`  Running at: http://localhost:${PORT}`);
  console.log(`  API key: ${process.env.ANTHROPIC_API_KEY ? 'configured' : 'NOT SET (generation disabled)'}`);
  console.log(`  Ideogram: ${process.env.IDEOGRAM_API_KEY ? 'configured' : 'NOT SET (images disabled)'}`);
  console.log(`  YouTube: ${process.env.YOUTUBE_API_KEY ? 'configured' : 'NOT SET (YouTube scraper disabled)'}`);
  console.log(`  Fireflies: ${process.env.FIREFLIES_API_KEY ? 'configured' : 'NOT SET (meeting sync disabled)'}`);
  console.log('');
});
