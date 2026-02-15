const { matchesKeywords, stripHtml, truncate, parseXml, extractCdata, now } = require('../lib/utils');

const FEEDS = [
  {
    name: 'Law Firm Marketing',
    url: 'https://news.google.com/rss/search?q=law+firm+marketing&hl=en-US&gl=US&ceid=US:en'
  },
  {
    name: 'Legal Technology',
    url: 'https://news.google.com/rss/search?q=legal+technology&hl=en-US&gl=US&ceid=US:en'
  },
  {
    name: 'PI Lawyer Advertising',
    url: 'https://news.google.com/rss/search?q=personal+injury+lawyer+advertising&hl=en-US&gl=US&ceid=US:en'
  },
  {
    name: 'Law Firm SEO',
    url: 'https://news.google.com/rss/search?q=law+firm+SEO&hl=en-US&gl=US&ceid=US:en'
  },
  {
    name: 'Legal Marketing Trends',
    url: 'https://news.google.com/rss/search?q=legal+marketing+trends&hl=en-US&gl=US&ceid=US:en'
  },
  {
    name: 'Lawyer Lead Generation',
    url: 'https://news.google.com/rss/search?q=lawyer+lead+generation&hl=en-US&gl=US&ceid=US:en'
  },
  {
    name: 'Law Firm Digital Marketing',
    url: 'https://news.google.com/rss/search?q=law+firm+digital+marketing&hl=en-US&gl=US&ceid=US:en'
  },
  {
    name: 'Legal AI Automation',
    url: 'https://news.google.com/rss/search?q=legal+AI+automation&hl=en-US&gl=US&ceid=US:en'
  }
];

function parseRssItems(xml) {
  const items = [];
  const itemBlocks = parseXml(xml, 'item');

  for (const block of itemBlocks) {
    const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const linkMatch = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
    const descMatch = block.match(/<description[^>]*>([\s\S]*?)<\/description>/i);
    const dateMatch = block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i);
    const sourceMatch = block.match(/<source[^>]*>([\s\S]*?)<\/source>/i);

    const title = titleMatch ? extractCdata(titleMatch[1]) : '';
    const link = linkMatch ? extractCdata(linkMatch[1]).trim() : '';
    const desc = descMatch ? stripHtml(extractCdata(descMatch[1])) : '';
    const pubDate = dateMatch ? extractCdata(dateMatch[1]) : '';
    const publisher = sourceMatch ? extractCdata(sourceMatch[1]) : '';

    items.push({ title, link, description: desc, pubDate, publisher });
  }

  return items;
}

async function scrapeFeed(feed, existingIds) {
  const triggers = [];

  try {
    console.log(`[google-news] Fetching: ${feed.name}`);

    const res = await fetch(feed.url, {
      headers: { 'User-Agent': 'ContentMachine/1.0' },
      signal: AbortSignal.timeout(15000)
    });

    if (!res.ok) {
      console.error(`[google-news] ${feed.name} returned ${res.status}`);
      return triggers;
    }

    const xml = await res.text();
    const items = parseRssItems(xml);

    console.log(`[google-news] ${feed.name}: ${items.length} items found`);

    for (const item of items) {
      const fullText = `${item.title} ${item.description}`;
      if (!matchesKeywords(fullText)) continue;

      const id = `gnews-${Buffer.from(item.link || item.title).toString('base64').slice(0, 16)}`;
      if (existingIds.has(id)) continue;

      let category = 'NEWS';
      const titleLower = item.title.toLowerCase();
      if (titleLower.includes('how to') || titleLower.includes('guide') || titleLower.includes('tips')) {
        category = 'CONTENT_PIECE';
      }
      if (/\d+%|\$[\d,]+|report|study|survey/i.test(fullText)) {
        category = 'DATA_POINT';
      }

      const sourceDetail = item.publisher
        ? `${feed.name} — ${item.publisher}`
        : feed.name;

      triggers.push({
        id,
        source: 'google-news',
        source_detail: sourceDetail,
        title: truncate(item.title, 200),
        raw_content: truncate(item.description, 3000),
        url: item.link,
        category,
        captured_at: item.pubDate ? new Date(item.pubDate).toISOString() : now(),
        status: 'pending',
        score: 0
      });
    }
  } catch (err) {
    console.error(`[google-news] Error fetching ${feed.name}:`, err.message);
  }

  return triggers;
}

async function scrapeAll(existingTriggers = []) {
  const existingIds = new Set(existingTriggers.map(t => t.id));
  const allTriggers = [];

  console.log(`[google-news] Fetching ${FEEDS.length} Google News feeds...`);

  const results = await Promise.allSettled(
    FEEDS.map(feed => scrapeFeed(feed, existingIds))
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      allTriggers.push(...result.value);
    }
  }

  // Deduplicate by URL across feeds (same article can appear in multiple queries)
  const seen = new Set();
  const deduped = [];
  for (const trigger of allTriggers) {
    if (seen.has(trigger.url)) continue;
    seen.add(trigger.url);
    deduped.push(trigger);
  }

  const dupeCount = allTriggers.length - deduped.length;
  if (dupeCount > 0) {
    console.log(`[google-news] Removed ${dupeCount} cross-feed duplicates`);
  }

  console.log(`[google-news] Found ${deduped.length} new triggers`);
  return deduped;
}

module.exports = { scrapeAll };
