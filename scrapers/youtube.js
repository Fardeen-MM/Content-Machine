const { generateId, now, truncate, sleep, matchesKeywords, stripHtml, parseXml, extractCdata } = require('../lib/utils');

// YouTube channels with their RSS feed URLs (no API key needed)
const CHANNELS = [
  // Legal marketing channels
  { name: 'Chris Dreyer / Rankings.io', id: 'UCiRS7BCssVkGrxcNsxCCa6Q' },
  { name: 'Crisp / Michael Mogill', id: 'UCEwWdB83dlhYEcSdTD06XeQ' },
  { name: 'Grow Law Firm / Sasha Berson', id: 'UCrBWJr36by51NtPBZJAreyQ' },
  { name: 'Law Firm Mentor', id: 'UCugTXkH3PsrQlOA6aDipfLg' },
  { name: 'Maximum Lawyer', id: 'UCylfseAvjfOxbI_XSumR_HA' },
  { name: 'Lawyerist', id: 'UCekqBjGbG_pedcxEQTaO0fA' },
  { name: 'LegalEagle', id: 'UCpa-Zb0ZcQjTCPP1Dx_1M8Q' },
  { name: 'Great Legal Marketing / Ben Glass', id: 'UC-rZrcr90ob7pgK6urStw5g' },
  { name: 'Consultwebs', id: 'UCzYy9GcrcoAyQU0PwWwfQZQ' },
  { name: 'Law Venture', id: 'UCE2WHWX21JfkkKfuqWIB3hw' },
  { name: 'Profit with Law / Moshe Amsel', id: 'UC0mcjkhILOSgw6xH8x1CD6A' },
  { name: 'Angela Vorpahl', id: 'UCxl2K1rbHLlkOXCDDHXQzgQ' },
  // Business & marketing gurus
  { name: 'Alex Hormozi', id: 'UCUyDOdBWhC1MCxEjC46d-zw' },
  { name: 'Dan Koe', id: 'UCWXYDYv5STLk-zoxMP2I1Lw' },
  { name: 'Gary Vaynerchuk', id: 'UCctXZhXmG-kf3tlIXgVZUlw' },
  { name: 'Neil Patel', id: 'UCl-Zrl0QhF66lu1aGXaTbfw' },
  { name: 'Patrick Bet-David', id: 'UCGX7nGXpz-CmO_Arg-cgJ7A' },
  { name: 'Noah Kagan', id: 'UCF2v8v8te3_u4xhIQ8tGy1g' },
  { name: 'Russell Brunson', id: 'UC2qUDKqTsz00csykCYgdLuA' },
  // SEO & digital marketing
  { name: 'Ahrefs', id: 'UCWquNQV8Y0_defMKnGKrFOQ' },
  { name: 'Semrush', id: 'UCj7v9UM1aGx6GR-nsY-9u8w' },
  { name: 'Matt Diggity', id: 'UCP5A5lVxaT7cO_LehpxjTZg' },
  { name: 'HubSpot Marketing', id: 'UCVeuau7DLrg7zlAjxxDbdww' },
  { name: 'Bloomberg Law', id: 'UCJL_gIOVp2fjfsKH4kbeEwA' }
];

/**
 * Parse YouTube RSS/Atom feed XML into video objects.
 * YouTube feeds use Atom format with <entry> blocks.
 */
function parseFeedEntries(xml) {
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
  let m;
  while ((m = entryRegex.exec(xml)) !== null) {
    const block = m[1];

    const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const videoIdMatch = block.match(/<yt:videoId>([\s\S]*?)<\/yt:videoId>/i);
    const publishedMatch = block.match(/<published>([\s\S]*?)<\/published>/i);
    const descMatch = block.match(/<media:description>([\s\S]*?)<\/media:description>/i);
    const thumbMatch = block.match(/<media:thumbnail[^>]*url="([^"]+)"/i);
    const authorMatch = block.match(/<author>\s*<name>([\s\S]*?)<\/name>/i);

    const title = titleMatch ? titleMatch[1].trim() : '';
    const videoId = videoIdMatch ? videoIdMatch[1].trim() : '';
    const published = publishedMatch ? publishedMatch[1].trim() : '';
    const description = descMatch ? descMatch[1].trim() : '';
    const thumbnail = thumbMatch ? thumbMatch[1] : '';
    const author = authorMatch ? authorMatch[1].trim() : '';

    if (videoId) {
      entries.push({ videoId, title, published, description, thumbnail, author });
    }
  }
  return entries;
}

async function scrapeChannel(channel, existingIds) {
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channel.id}`;
  const triggers = [];

  try {
    const res = await fetch(feedUrl, {
      headers: { 'User-Agent': 'ContentMachine/1.0' },
      signal: AbortSignal.timeout(15000)
    });

    if (!res.ok) {
      console.error(`[youtube] ${channel.name} returned ${res.status}`);
      return triggers;
    }

    const xml = await res.text();
    const entries = parseFeedEntries(xml);

    for (const entry of entries) {
      const id = `yt-${entry.videoId}`;
      if (existingIds.has(id)) continue;

      const fullText = `${entry.title} ${entry.description}`;
      if (!matchesKeywords(fullText)) continue;

      let category = 'CONTENT_PIECE';
      const titleLower = entry.title.toLowerCase();
      if (titleLower.includes('how') || titleLower.includes('?')) {
        category = 'QUESTION';
      }
      if (/\d+%|\$[\d,]+|million|billion/i.test(fullText)) {
        category = 'DATA_POINT';
      }

      triggers.push({
        id,
        source: 'youtube',
        source_detail: channel.name,
        title: truncate(entry.title, 200),
        raw_content: truncate(entry.description, 3000),
        url: `https://youtube.com/watch?v=${entry.videoId}`,
        thumbnail: entry.thumbnail,
        category,
        captured_at: entry.published || now(),
        status: 'pending',
        score: 0
      });
    }
  } catch (err) {
    console.error(`[youtube] Error fetching ${channel.name}:`, err.message);
  }

  return triggers;
}

async function scrapeAll(existingTriggers = []) {
  const existingIds = new Set(existingTriggers.map(t => t.id));
  const allTriggers = [];

  console.log(`[youtube] Checking ${CHANNELS.length} channels via RSS...`);

  for (const channel of CHANNELS) {
    console.log(`[youtube] Fetching from ${channel.name}...`);
    const triggers = await scrapeChannel(channel, existingIds);
    allTriggers.push(...triggers);
    await sleep(300);
  }

  console.log(`[youtube] Found ${allTriggers.length} new triggers`);
  return allTriggers;
}

module.exports = { scrapeAll };
