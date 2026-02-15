const { loadEnv, readJSON, writeJSON, now } = require('../lib/utils');

loadEnv();

const reddit = require('./reddit');
const rss = require('./rss');
const youtube = require('./youtube');

async function runAll() {
  console.log('=== Content Machine Scraper Run ===');
  console.log(`Started: ${now()}`);

  const existingTriggers = readJSON('trigger-queue.json');
  console.log(`Existing triggers in queue: ${existingTriggers.length}`);

  const results = { reddit: [], rss: [], youtube: [] };

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

  const newTriggers = [
    ...results.reddit,
    ...results.rss,
    ...results.youtube
  ];

  if (newTriggers.length > 0) {
    const updated = [...existingTriggers, ...newTriggers];
    writeJSON('trigger-queue.json', updated);
    console.log(`\nAdded ${newTriggers.length} new triggers (total: ${updated.length})`);
    console.log(`  Reddit: ${results.reddit.length}`);
    console.log(`  RSS: ${results.rss.length}`);
    console.log(`  YouTube: ${results.youtube.length}`);
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
