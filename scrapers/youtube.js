const { generateId, now, truncate, sleep, matchesKeywords } = require('../lib/utils');
const { loadEnv } = require('../lib/utils');

loadEnv();

const CHANNELS = [
  { name: 'Chris Dreyer / Rankings.io', id: 'UCxxxxx_placeholder_dreyer' },
  { name: 'Crisp Video / Michael Mogill', id: 'UCxxxxx_placeholder_mogill' },
  { name: 'Grow Law Firm / Sasha Berson', id: 'UCxxxxx_placeholder_berson' },
  { name: 'Alex Hormozi', id: 'UCVjlpEjEY9GpksqbEesJnNA' },
  { name: 'Dan Koe', id: 'UCkY047vYjF92-aO62Gz-wjg' }
];

const API_BASE = 'https://www.googleapis.com/youtube/v3';

function isPlaceholder(channelId) {
  return channelId.includes('placeholder') || channelId.startsWith('UCxxxxx');
}

async function getRecentVideos(channelId, apiKey) {
  const url = `${API_BASE}/search?part=snippet&channelId=${channelId}&order=date&maxResults=5&type=video&key=${apiKey}`;

  const res = await fetch(url);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`YouTube API ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return (data.items || []).map(item => ({
    videoId: item.id?.videoId,
    title: item.snippet?.title || '',
    description: item.snippet?.description || '',
    publishedAt: item.snippet?.publishedAt || '',
    channelTitle: item.snippet?.channelTitle || '',
    thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.default?.url || ''
  }));
}

async function getCaptions(videoId, apiKey) {
  try {
    // Try to get caption track list
    const url = `${API_BASE}/captions?part=snippet&videoId=${videoId}&key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) return null;

    const data = await res.json();
    const tracks = data.items || [];

    // Find English auto-generated or manual captions
    const enTrack = tracks.find(t =>
      t.snippet?.language === 'en' ||
      t.snippet?.language === 'en-US'
    );

    if (!enTrack) return null;

    // Note: Actually downloading captions requires OAuth, so we'll just note they exist
    return `[Auto-captions available for video ${videoId}]`;
  } catch {
    return null;
  }
}

async function scrapeAll(existingTriggers = []) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    console.log('[youtube] YOUTUBE_API_KEY not set, skipping YouTube scraper');
    return [];
  }

  const existingIds = new Set(existingTriggers.map(t => t.id));
  const allTriggers = [];

  console.log(`[youtube] Checking ${CHANNELS.length} channels...`);

  for (const channel of CHANNELS) {
    if (isPlaceholder(channel.id)) {
      console.log(`[youtube] Skipping ${channel.name} (placeholder ID)`);
      continue;
    }

    try {
      console.log(`[youtube] Fetching from ${channel.name}...`);
      const videos = await getRecentVideos(channel.id, apiKey);

      for (const video of videos) {
        if (!video.videoId) continue;

        const id = `yt-${video.videoId}`;
        if (existingIds.has(id)) continue;

        const fullText = `${video.title} ${video.description}`;
        // For competitor channels, we want most content even without keyword match
        const isRelevant = matchesKeywords(fullText) || true; // Take all from monitored channels

        if (!isRelevant) continue;

        const captions = await getCaptions(video.videoId, apiKey);

        let category = 'CONTENT_PIECE';
        const titleLower = video.title.toLowerCase();
        if (titleLower.includes('how') || titleLower.includes('?')) {
          category = 'QUESTION';
        }
        if (/\d+%|\$[\d,]+|million|billion/i.test(fullText)) {
          category = 'DATA_POINT';
        }

        allTriggers.push({
          id,
          source: 'youtube',
          source_detail: channel.name,
          title: truncate(video.title, 200),
          raw_content: truncate(`${video.description}\n\n${captions || ''}`, 3000),
          url: `https://youtube.com/watch?v=${video.videoId}`,
          thumbnail: video.thumbnail,
          category,
          captured_at: video.publishedAt || now(),
          status: 'pending',
          score: 0
        });
      }

      await sleep(200); // Gentle rate limiting
    } catch (err) {
      console.error(`[youtube] Error fetching ${channel.name}:`, err.message);
    }
  }

  console.log(`[youtube] Found ${allTriggers.length} new triggers`);
  return allTriggers;
}

module.exports = { scrapeAll };
