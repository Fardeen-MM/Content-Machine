const { loadEnv, readJSON, writeJSON, now } = require('../lib/utils');
const { selectTopTriggers } = require('./score-triggers');
const { generateAllContent, generateBlog, generateYouTube, generateLeadMagnetContent } = require('./content-writer');
const { generateContentImage } = require('./image-gen');
const fs = require('fs');
const path = require('path');

loadEnv();

async function runDaily(options = {}) {
  const { count = 5, triggerId = null, includeBlog = true, includeYouTube = true } = options;

  console.log('=== Content Machine Daily Generation ===');
  console.log(`Started: ${now()}`);

  const triggers = readJSON('trigger-queue.json');
  const existingContent = readJSON('content.json');

  // Duplicate detection: normalize titles for comparison
  const existingTitles = existingContent.map(c => (c.trigger_title || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim());
  function isDuplicateTitle(title) {
    const norm = (title || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    if (!norm || norm.length < 10) return false;
    return existingTitles.some(et => {
      if (et === norm) return true;
      // Check if one contains the other (substring match for >60% length)
      if (et.includes(norm) || norm.includes(et)) {
        const shorter = Math.min(et.length, norm.length);
        const longer = Math.max(et.length, norm.length);
        return shorter / longer > 0.6;
      }
      return false;
    });
  }

  let selectedTriggers;

  if (triggerId) {
    // Generate for a specific trigger
    const trigger = triggers.find(t => t.id === triggerId);
    if (!trigger) {
      console.error(`Trigger ${triggerId} not found`);
      return;
    }
    if (isDuplicateTitle(trigger.title)) {
      console.log(`[dedup] Trigger "${trigger.title}" has similar existing content, generating anyway (explicit request)`);
    }
    selectedTriggers = [trigger];
  } else {
    // Select top N pending triggers, skip duplicates
    const usedTriggerIds = new Set(existingContent.map(c => c.trigger_id));
    const unusedTriggers = triggers.filter(t => {
      if (usedTriggerIds.has(t.id)) return false;
      if (t.status !== 'pending') return false;
      if (isDuplicateTitle(t.title)) {
        console.log(`[dedup] Skipping "${t.title}" — similar content exists`);
        return false;
      }
      return true;
    });
    selectedTriggers = selectTopTriggers(unusedTriggers, count);
  }

  if (selectedTriggers.length === 0) {
    console.log('No pending triggers to process');
    return;
  }

  console.log(`Processing ${selectedTriggers.length} triggers...`);

  const newContent = [];

  for (const trigger of selectedTriggers) {
    console.log(`\n--- Processing: ${trigger.title} ---`);

    try {
      // Step 1: Generate social content
      let content = await generateAllContent(trigger);

      // Step 2: Generate image
      content = await generateContentImage(content);

      // Step 3: Generate blog post (if keyword exists and enabled)
      if (includeBlog && content.blog_keyword) {
        content = await generateBlog(content, trigger);

        // Save blog post to file
        if (content.blog_post) {
          const blogDir = path.join(__dirname, '..', 'blog-posts');
          fs.mkdirSync(blogDir, { recursive: true });
          const filename = `${content.id}-${content.blog_keyword.replace(/\s+/g, '-').toLowerCase()}.md`;
          fs.writeFileSync(path.join(blogDir, filename), content.blog_post);
          console.log(`[blog] Saved to blog-posts/${filename}`);
        }
      }

      // Step 4: Generate YouTube script (if topic exists and enabled)
      if (includeYouTube && content.youtube_topic) {
        content = await generateYouTube(content, trigger);

        // Save script to file
        if (content.youtube_script) {
          const scriptDir = path.join(__dirname, '..', 'scripts');
          fs.mkdirSync(scriptDir, { recursive: true });
          const filename = `${content.id}-${content.youtube_topic.replace(/\s+/g, '-').toLowerCase()}.md`;
          fs.writeFileSync(path.join(scriptDir, filename), content.youtube_script);
          console.log(`[youtube] Saved to scripts/${filename}`);
        }
      }

      // Step 5: Generate lead magnet (if topic exists)
      if (content.lead_magnet_topic) {
        content = await generateLeadMagnetContent(content, trigger);
      }

      newContent.push(content);

      // Mark trigger as used
      const triggerIdx = triggers.findIndex(t => t.id === trigger.id);
      if (triggerIdx !== -1) {
        triggers[triggerIdx].status = 'used';
      }

      console.log(`[done] Content ${content.id} generated successfully`);
    } catch (err) {
      console.error(`[error] Failed to process trigger ${trigger.id}: ${err.message}`);
    }
  }

  // Save everything
  if (newContent.length > 0) {
    writeJSON('content.json', [...existingContent, ...newContent]);
    writeJSON('trigger-queue.json', triggers);
    console.log(`\nGenerated ${newContent.length} content pieces`);
  }

  console.log(`Finished: ${now()}`);
  return newContent;
}

if (require.main === module) {
  runDaily().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { runDaily };
