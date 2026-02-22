const { sleep, generateId, now, matchesKeywords, stripHtml, truncate } = require('../lib/utils');

const SUBREDDITS = [
  // Legal profession
  'LawFirm', 'lawyers', 'personalinjury', 'legaladvice',
  'law', 'lawschool', 'LegalAdviceUK', 'Ask_Lawyers',
  'litigation', 'Insurance', 'WorkersComp',
  // Business & entrepreneurship
  'smallbusiness', 'Entrepreneur', 'startups', 'SaaS',
  'sweatystartup', 'EntrepreneurRideAlong',
  // Digital marketing
  'SEO', 'PPC', 'marketing', 'digital_marketing', 'socialmedia',
  'content_marketing', 'webdev', 'analytics', 'bigseo',
  'GoogleAds', 'FacebookAds', 'copywriting', 'AdWords',
  // Sales & growth
  'sales', 'leadgeneration', 'CRM', 'GrowthHacking'
];

const USER_AGENT = 'ContentMachine/1.0 (educational research bot)';

async function scrapeSubreddit(subreddit, existingIds) {
  const url = `https://www.reddit.com/r/${subreddit}/new.json?limit=25`;
  const triggers = [];

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15000)
    });

    if (!res.ok) {
      console.error(`[reddit] r/${subreddit} returned ${res.status}`);
      return triggers;
    }

    const data = await res.json();
    const posts = data?.data?.children || [];

    for (const post of posts) {
      const d = post.data;
      if (!d) continue;

      const fullText = `${d.title || ''} ${d.selftext || ''}`;
      if (!matchesKeywords(fullText)) continue;

      const id = `reddit-${d.id}`;
      if (existingIds.has(id)) continue;

      const upvotes = d.ups || 0;
      const comments = d.num_comments || 0;

      let category = 'PAIN_POINT';
      const titleLower = (d.title || '').toLowerCase();
      if (titleLower.includes('?') || titleLower.startsWith('how') || titleLower.startsWith('what') || titleLower.startsWith('why')) {
        category = 'QUESTION';
      }
      if (/\d+%|\$[\d,]+|\d+x/.test(fullText)) {
        category = 'DATA_POINT';
      }

      triggers.push({
        id,
        source: 'reddit',
        source_detail: `r/${subreddit}`,
        title: truncate(d.title || 'Untitled', 200),
        raw_content: truncate(d.selftext || d.title || '', 3000),
        url: `https://reddit.com${d.permalink}`,
        category,
        engagement: { upvotes, comments },
        captured_at: now(),
        status: 'pending',
        score: 0
      });
    }
  } catch (err) {
    console.error(`[reddit] Error scraping r/${subreddit}:`, err.message);
  }

  return triggers;
}

async function scrapeAll(existingTriggers = []) {
  const existingIds = new Set(existingTriggers.map(t => t.id));
  const allTriggers = [];

  console.log(`[reddit] Scraping ${SUBREDDITS.length} subreddits...`);

  for (const sub of SUBREDDITS) {
    console.log(`[reddit] Scraping r/${sub}...`);
    const triggers = await scrapeSubreddit(sub, existingIds);
    allTriggers.push(...triggers);
    // Rate limit: 1 req per 2 seconds
    await sleep(2000);
  }

  console.log(`[reddit] Found ${allTriggers.length} new triggers`);
  return allTriggers;
}

module.exports = { scrapeAll };
