const { generateId, now, stripHtml, truncate, parseXml, extractCdata } = require('../lib/utils');

const FEEDS = [
  // Direct competitors — legal marketing agencies
  { name: 'Rankings.io', url: 'https://rankings.io/blog/feed/' },
  { name: 'Consultwebs', url: 'https://www.consultwebs.com/blog/rss.xml' },
  { name: 'Good2bSocial', url: 'https://good2bsocial.com/feed/' },
  { name: 'Gladiator Law Marketing', url: 'https://gladiatorlawmarketing.com/feed/' },
  { name: 'PaperStreet', url: 'https://www.paperstreet.com/blog/feed/' },
  { name: 'Scorpion', url: 'https://www.scorpion.co/blog/feed/' },
  { name: 'Martindale-Avvo Blog', url: 'https://www.martindale.com/blog/feed/' },
  { name: 'GNGF', url: 'https://gngf.com/feed/' },
  { name: 'Justia Blog', url: 'https://onward.justia.com/feed/' },
  { name: 'Foster Web Marketing', url: 'https://www.fosterwebmarketing.com/blog/rss.xml' }
];

function parseRssItems(xml) {
  const items = [];
  // Match <item>...</item> blocks
  const itemBlocks = parseXml(xml, 'item');

  for (const block of itemBlocks) {
    const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const linkMatch = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
    const descMatch = block.match(/<description[^>]*>([\s\S]*?)<\/description>/i);
    const dateMatch = block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i);
    const contentMatch = block.match(/<content:encoded[^>]*>([\s\S]*?)<\/content:encoded>/i);

    const title = titleMatch ? extractCdata(titleMatch[1]) : '';
    const link = linkMatch ? extractCdata(linkMatch[1]).trim() : '';
    const desc = descMatch ? stripHtml(extractCdata(descMatch[1])) : '';
    const content = contentMatch ? stripHtml(extractCdata(contentMatch[1])) : desc;
    const pubDate = dateMatch ? extractCdata(dateMatch[1]) : '';

    items.push({ title, link, description: desc, content, pubDate });
  }

  return items;
}

async function scrapeFeed(feed, existingIds) {
  const triggers = [];

  try {
    const res = await fetch(feed.url, {
      headers: { 'User-Agent': 'ContentMachine/1.0' },
      signal: AbortSignal.timeout(15000)
    });

    if (!res.ok) {
      console.error(`[competitors] ${feed.name} returned ${res.status}`);
      return triggers;
    }

    const xml = await res.text();
    const items = parseRssItems(xml);

    for (const item of items) {
      // No keyword filtering — all competitor content is relevant by definition
      const id = `comp-${Buffer.from(item.link || item.title).toString('base64').slice(0, 16)}`;
      if (existingIds.has(id)) continue;

      triggers.push({
        id,
        source: 'competitor',
        source_detail: feed.name,
        competitor_name: feed.name,
        title: truncate(item.title, 200),
        raw_content: truncate(item.content || item.description, 3000),
        url: item.link,
        category: 'CONTENT_PIECE',
        competitive_angle: true,
        captured_at: item.pubDate ? new Date(item.pubDate).toISOString() : now(),
        status: 'pending',
        score: 0
      });
    }
  } catch (err) {
    console.error(`[competitors] Error fetching ${feed.name}:`, err.message);
  }

  return triggers;
}

async function scrapeAll(existingTriggers = []) {
  const existingIds = new Set(existingTriggers.map(t => t.id));
  const allTriggers = [];

  console.log(`[competitors] Fetching ${FEEDS.length} competitor feeds...`);

  // Fetch all feeds concurrently (they're different domains)
  const results = await Promise.allSettled(
    FEEDS.map(feed => scrapeFeed(feed, existingIds))
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      allTriggers.push(...result.value);
    }
  }

  console.log(`[competitors] Found ${allTriggers.length} new triggers`);
  return allTriggers;
}

module.exports = { scrapeAll };
