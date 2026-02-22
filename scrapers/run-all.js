const { loadEnv, readJSON, writeJSON, now } = require('../lib/utils');

loadEnv();

const reddit = require('./reddit');
const rss = require('./rss');
const youtube = require('./youtube');
const googleNews = require('./google-news');
const hackernews = require('./hackernews');
const competitors = require('./competitors');

function normalizeTitle(title) {
  return (title || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

async function runAll() {
  console.log('=== Content Machine Scraper Run ===');
  console.log(`Started: ${now()}`);

  const existingTriggers = readJSON('trigger-queue.json');
  console.log(`Existing triggers in queue: ${existingTriggers.length}`);

  const results = { reddit: [], rss: [], youtube: [], 'google-news': [], hackernews: [], competitors: [] };

  // Run scrapers with error isolation
  try {
    results.reddit = await reddit.scrapeAll(existingTriggers);
  } catch (err) {
    console.error('[scraper] Reddit failed:', err.message);
  }

  try {
    results.rss = await rss.scrapeAll(existingTriggers);
  } catch (err) {
    console.error('[scraper] RSS failed:', err.message);
  }

  try {
    results.youtube = await youtube.scrapeAll(existingTriggers);
  } catch (err) {
    console.error('[scraper] YouTube failed:', err.message);
  }

  try {
    results['google-news'] = await googleNews.scrapeAll(existingTriggers);
  } catch (err) {
    console.error('[scraper] Google News failed:', err.message);
  }

  try {
    results.hackernews = await hackernews.scrapeAll(existingTriggers);
  } catch (err) {
    console.error('[scraper] Hacker News failed:', err.message);
  }

  try {
    results.competitors = await competitors.scrapeAll(existingTriggers);
  } catch (err) {
    console.error('[scraper] Competitors failed:', err.message);
  }

  const allNew = [
    ...(results.reddit || []),
    ...(results.rss || []),
    ...(results.youtube || []),
    ...(results['google-news'] || []),
    ...(results.hackernews || []),
    ...(results.competitors || [])
  ];

  // Cross-scraper deduplication — remove triggers with same URL or similar titles
  const existingUrls = new Set(existingTriggers.map(t => t.url).filter(Boolean));
  const existingTitlesNorm = existingTriggers.map(t => normalizeTitle(t.title));
  const seenUrls = new Set();
  const seenTitlesNorm = [];
  const newTriggers = allNew.filter(t => {
    const url = t.url || '';
    const titleNorm = normalizeTitle(t.title);
    // Exact URL match
    if (url && (existingUrls.has(url) || seenUrls.has(url))) return false;
    // Exact normalized title match
    if (titleNorm && (existingTitlesNorm.includes(titleNorm) || seenTitlesNorm.includes(titleNorm))) return false;
    // Fuzzy title match — check if >70% of words overlap with any existing title
    if (titleNorm && titleNorm.length > 20) {
      const words = new Set(titleNorm.split(' ').filter(w => w.length > 3));
      if (words.size >= 3) {
        const isSimilar = [...existingTitlesNorm, ...seenTitlesNorm].some(existing => {
          if (!existing || existing.length < 20) return false;
          const existingWords = new Set(existing.split(' ').filter(w => w.length > 3));
          if (existingWords.size < 3) return false;
          const overlap = [...words].filter(w => existingWords.has(w)).length;
          const similarity = overlap / Math.min(words.size, existingWords.size);
          return similarity > 0.7;
        });
        if (isSimilar) return false;
      }
    }
    if (url) seenUrls.add(url);
    if (titleNorm) seenTitlesNorm.push(titleNorm);
    return true;
  });

  const dupes = allNew.length - newTriggers.length;
  if (dupes > 0) console.log(`  Deduplication: removed ${dupes} cross-scraper duplicates`);

  if (newTriggers.length > 0) {
    const updated = [...existingTriggers, ...newTriggers];
    writeJSON('trigger-queue.json', updated);
    console.log(`\nAdded ${newTriggers.length} new triggers (total: ${updated.length})`);
    console.log(`  Reddit: ${results.reddit.length}`);
    console.log(`  RSS: ${results.rss.length}`);
    console.log(`  YouTube: ${results.youtube.length}`);
    console.log(`  Google News: ${results['google-news'].length}`);
    console.log(`  Hacker News: ${results.hackernews.length}`);
    console.log(`  Competitors: ${results.competitors.length}`);
  } else {
    console.log('\nNo new triggers found this run.');
  }

  console.log(`\nFinished: ${now()}`);
}

if (require.main === module) {
  runAll().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { runAll };
