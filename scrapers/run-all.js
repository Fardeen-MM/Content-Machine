const { loadEnv, readJSON, writeJSON, now } = require('../lib/utils');

loadEnv();

const reddit = require('./reddit');
const rss = require('./rss');
const youtube = require('./youtube');
const googleNews = require('./google-news');
const hackernews = require('./hackernews');
const competitors = require('./competitors');

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
    ...results.reddit,
    ...results.rss,
    ...results.youtube,
    ...results['google-news'],
    ...results.hackernews,
    ...results.competitors
  ];

  // Cross-scraper deduplication — remove triggers with same URL or very similar titles
  const existingUrls = new Set(existingTriggers.map(t => t.url).filter(Boolean));
  const existingTitles = new Set(existingTriggers.map(t => (t.title || '').toLowerCase().trim()));
  const seenUrls = new Set();
  const seenTitles = new Set();
  const newTriggers = allNew.filter(t => {
    const url = t.url || '';
    const title = (t.title || '').toLowerCase().trim();
    if (url && (existingUrls.has(url) || seenUrls.has(url))) return false;
    if (title && (existingTitles.has(title) || seenTitles.has(title))) return false;
    if (url) seenUrls.add(url);
    if (title) seenTitles.add(title);
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
