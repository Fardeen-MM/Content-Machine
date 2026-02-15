const { generateId, now, matchesKeywords, stripHtml, truncate, parseXml, extractCdata } = require('../lib/utils');

const FEEDS = [
  { name: 'ABA Journal', url: 'https://www.abajournal.com/feed' },
  { name: 'Clio Blog', url: 'https://www.clio.com/blog/feed/' },
  { name: 'Lawyerist', url: 'https://lawyerist.com/feed/' },
  { name: 'Attorney at Work', url: 'https://www.attorneyatwork.com/feed/' },
  { name: 'National Law Review', url: 'https://www.natlawreview.com/rss.xml' },
  { name: 'JD Supra', url: 'https://www.jdsupra.com/rss/news.xml' },
  { name: 'Law Technology Today', url: 'https://www.lawtechnologytoday.org/feed/' }
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
      console.error(`[rss] ${feed.name} returned ${res.status}`);
      return triggers;
    }

    const xml = await res.text();
    const items = parseRssItems(xml);

    for (const item of items) {
      const fullText = `${item.title} ${item.description} ${item.content}`;
      if (!matchesKeywords(fullText)) continue;

      const id = `rss-${Buffer.from(item.link || item.title).toString('base64').slice(0, 16)}`;
      if (existingIds.has(id)) continue;

      let category = 'NEWS';
      const titleLower = item.title.toLowerCase();
      if (titleLower.includes('how to') || titleLower.includes('guide') || titleLower.includes('tips')) {
        category = 'CONTENT_PIECE';
      }
      if (/\d+%|\$[\d,]+|report|study|survey/i.test(fullText)) {
        category = 'DATA_POINT';
      }

      triggers.push({
        id,
        source: 'rss',
        source_detail: feed.name,
        title: truncate(item.title, 200),
        raw_content: truncate(item.content || item.description, 3000),
        url: item.link,
        category,
        captured_at: item.pubDate ? new Date(item.pubDate).toISOString() : now(),
        status: 'pending',
        score: 0
      });
    }
  } catch (err) {
    console.error(`[rss] Error fetching ${feed.name}:`, err.message);
  }

  return triggers;
}

async function scrapeAll(existingTriggers = []) {
  const existingIds = new Set(existingTriggers.map(t => t.id));
  const allTriggers = [];

  console.log(`[rss] Fetching ${FEEDS.length} RSS feeds...`);

  // Fetch all feeds concurrently (they're different domains)
  const results = await Promise.allSettled(
    FEEDS.map(feed => scrapeFeed(feed, existingIds))
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      allTriggers.push(...result.value);
    }
  }

  console.log(`[rss] Found ${allTriggers.length} new triggers`);
  return allTriggers;
}

module.exports = { scrapeAll };
