const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadEnv, readJSON, writeJSON, generateId, now } = require('./lib/utils');

loadEnv();

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');

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
    req.on('data', chunk => { body += chunk; });
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
        published: published.length
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
      return json(res, content[idx]);
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
      const memory = readJSON('memory.json');
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

      return json(res, content[idx]);
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
      return json(res, content[idx]);
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

    // GET /api/calendar
    if (pathname === '/api/calendar' && method === 'GET') {
      const content = readJSON('content.json');
      const { buildWeeklyCalendar } = require('./generator/calendar-builder');
      const calendar = buildWeeklyCalendar(content);
      return json(res, calendar);
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
        return json(res, content[idx]);
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // POST /api/content/bulk-approve
    if (pathname === '/api/content/bulk-approve' && method === 'POST') {
      const body = await parseBody(req);
      const ids = body.ids || [];
      if (!ids.length) return json(res, { error: 'ids required' }, 400);

      const content = readJSON('content.json');
      let updated = 0;
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
      writeJSON('content.json', content);
      return json(res, { ok: true, updated });
    }

    // POST /api/content/bulk-reject
    if (pathname === '/api/content/bulk-reject' && method === 'POST') {
      const body = await parseBody(req);
      const ids = body.ids || [];
      if (!ids.length) return json(res, { error: 'ids required' }, 400);

      const content = readJSON('content.json');
      let updated = 0;
      for (const id of ids) {
        const idx = content.findIndex(c => c.id === id);
        if (idx === -1) continue;
        for (const key of Object.keys(content[idx].formats)) {
          content[idx].formats[key].status = 'rejected';
        }
        content[idx].status = 'rejected';
        updated++;
      }
      writeJSON('content.json', content);
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
      return json(res, content[idx]);
    }

    // DELETE /api/triggers/:id
    const triggerDeleteMatch = pathname.match(/^\/api\/triggers\/([a-zA-Z0-9_-]+)$/);
    if (triggerDeleteMatch && method === 'DELETE') {
      const triggers = readJSON('trigger-queue.json');
      const filtered = triggers.filter(t => t.id !== triggerDeleteMatch[1]);
      if (filtered.length === triggers.length) return json(res, { error: 'Not found' }, 404);
      writeJSON('trigger-queue.json', filtered);
      return json(res, { ok: true });
    }

    // POST /api/triggers/:id/reject
    const triggerRejectMatch = pathname.match(/^\/api\/triggers\/([a-zA-Z0-9_-]+)\/reject$/);
    if (triggerRejectMatch && method === 'POST') {
      const triggers = readJSON('trigger-queue.json');
      const idx = triggers.findIndex(t => t.id === triggerRejectMatch[1]);
      if (idx === -1) return json(res, { error: 'Not found' }, 404);
      triggers[idx].status = 'rejected';
      writeJSON('trigger-queue.json', triggers);
      return json(res, { ok: true });
    }

    // GET /api/memory
    if (pathname === '/api/memory' && method === 'GET') {
      const memory = readJSON('memory.json');
      return json(res, memory);
    }

    // POST /api/memory — add a style note or preference
    if (pathname === '/api/memory' && method === 'POST') {
      const body = await parseBody(req);
      const validTypes = ['style_note', 'remove_example', 'remove_note'];
      if (!body.type || !validTypes.includes(body.type)) {
        return json(res, { error: `type required, must be one of: ${validTypes.join(', ')}` }, 400);
      }

      const memory = readJSON('memory.json');

      if (body.type === 'style_note') {
        if (!body.note || !body.note.trim()) {
          return json(res, { error: 'note required for style_note type' }, 400);
        }
        if (!memory.style_notes) memory.style_notes = [];
        memory.style_notes.push({
          note: body.note.trim(),
          added_at: now()
        });
      }

      if (body.type === 'remove_example') {
        if (typeof body.index !== 'number') {
          return json(res, { error: 'index required for remove_example type' }, 400);
        }
        memory.approved_examples = (memory.approved_examples || []).filter(
          (e, i) => i !== body.index
        );
      }

      if (body.type === 'remove_note') {
        if (typeof body.index !== 'number') {
          return json(res, { error: 'index required for remove_note type' }, 400);
        }
        memory.style_notes = (memory.style_notes || []).filter(
          (n, i) => i !== body.index
        );
      }

      writeJSON('memory.json', memory);
      return json(res, memory);
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
        return json(res, atoms);
      } else if (body.text) {
        const atoms = await atomizeContent(body.text, body.source || 'manual');
        return json(res, atoms);
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

    // --- Static file serving ---

    // Serve dashboard
    if (pathname === '/' || pathname === '/index.html') {
      return serveStatic(res, path.join(__dirname, 'dashboard', 'index.html'), 'text/html');
    }

    // Serve other static files from dashboard/
    const ext = path.extname(pathname);
    if (ext && MIME[ext]) {
      const filePath = path.join(__dirname, 'dashboard', pathname);
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
  console.log('');
});
