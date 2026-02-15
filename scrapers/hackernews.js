const { sleep, matchesKeywords, truncate, now, stripHtml } = require('../lib/utils');

const HN_SEARCH_QUERIES = [
  'law firm',
  'legal tech',
  'lawyer marketing',
  'legal AI',
  'law firm software',
  'legal automation',
  'court technology',
  'legal startup',
  'personal injury',
  'lawyer advertising'
];

// Additional keywords specific to HN legal content that matchesKeywords() might miss.
// These broaden the filter for legal-adjacent tech discussions common on HN.
const HN_LEGAL_KEYWORDS = [
  'legaltech', 'lawtech', 'regtech', 'compliance tech',
  'contract automation', 'e-discovery', 'ediscovery',
  'legal ops', 'legal operations', 'legal workflow',
  'court filing', 'case management software',
  'legal document', 'legal saas', 'lawyer software',
  'attorney tech', 'law practice management',
  'legal industry', 'legal market', 'legal services',
  'access to justice', 'legal aid tech'
];

const RATE_LIMIT_MS = 200;

/**
 * Check if text matches either the shared KEYWORDS list or HN-specific legal keywords.
 */
function isRelevant(text) {
  if (!text) return false;
  if (matchesKeywords(text)) return true;
  const lower = text.toLowerCase();
  return HN_LEGAL_KEYWORDS.some(kw => lower.includes(kw));
}

/**
 * Categorize a HN post based on its title content.
 *   - Titles with "?" or question words -> QUESTION
 *   - Titles with numeric data patterns -> DATA_POINT
 *   - Everything else -> CONTENT_PIECE
 */
function categorize(title) {
  const titleLower = (title || '').toLowerCase();

  if (
    titleLower.includes('?') ||
    titleLower.startsWith('ask hn') ||
    titleLower.startsWith('how') ||
    titleLower.startsWith('what') ||
    titleLower.startsWith('why') ||
    titleLower.startsWith('which') ||
    titleLower.startsWith('is there')
  ) {
    return 'QUESTION';
  }

  if (/\d+%|\$[\d,]+|\d+x|\d+\s*(million|billion|users|customers)/.test(title || '')) {
    return 'DATA_POINT';
  }

  return 'CONTENT_PIECE';
}

/**
 * Search HN Algolia API for a single query and return matching triggers.
 */
async function searchHN(query, existingIds) {
  const encodedQuery = encodeURIComponent(query);
  const url = `https://hn.algolia.com/api/v1/search?query=${encodedQuery}&tags=story`;
  const triggers = [];

  try {
    const res = await fetch(url);

    if (!res.ok) {
      console.error(`[hackernews] Query "${query}" returned ${res.status}`);
      return triggers;
    }

    const data = await res.json();
    const hits = data?.hits || [];

    for (const hit of hits) {
      if (!hit.objectID) continue;

      const id = `hn-${hit.objectID}`;
      if (existingIds.has(id)) continue;

      const title = hit.title || '';
      const storyText = hit.story_text ? stripHtml(hit.story_text) : '';
      const fullText = `${title} ${storyText}`;

      if (!isRelevant(fullText)) continue;

      // Prefer the article URL; fall back to HN comments page
      const articleUrl = hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`;
      const hnUrl = `https://news.ycombinator.com/item?id=${hit.objectID}`;

      const points = hit.points || 0;
      const numComments = hit.num_comments || 0;

      triggers.push({
        id,
        source: 'hackernews',
        source_detail: 'Hacker News',
        title: truncate(title, 200),
        raw_content: truncate(storyText || title, 3000),
        url: articleUrl,
        hn_url: hnUrl,
        category: categorize(title),
        engagement: { points, num_comments: numComments },
        captured_at: now(),
        status: 'pending',
        score: 0
      });

      // Track the id so duplicate hits across queries are skipped
      existingIds.add(id);
    }
  } catch (err) {
    console.error(`[hackernews] Error searching "${query}":`, err.message);
  }

  return triggers;
}

/**
 * Main entry point. Matches the scrapeAll(existingTriggers) signature
 * used by run-all.js.
 */
async function scrapeAll(existingTriggers = []) {
  const existingIds = new Set(existingTriggers.map(t => t.id));
  const allTriggers = [];

  console.log(`[hackernews] Searching ${HN_SEARCH_QUERIES.length} queries...`);

  for (const query of HN_SEARCH_QUERIES) {
    console.log(`[hackernews] Searching "${query}"...`);
    const triggers = await searchHN(query, existingIds);
    allTriggers.push(...triggers);
    await sleep(RATE_LIMIT_MS);
  }

  console.log(`[hackernews] Found ${allTriggers.length} new triggers`);
  return allTriggers;
}

module.exports = { scrapeAll };
