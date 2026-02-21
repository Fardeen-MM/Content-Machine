const { keywordScore, daysAgo, readJSON } = require('../lib/utils');
const db = require('../lib/db');

// Source reliability cache — recalculated every 10 minutes
let _sourceReliability = null;
let _reliabilityCachedAt = 0;
const RELIABILITY_CACHE_MS = 10 * 60 * 1000;

function getSourceReliability() {
  if (_sourceReliability && Date.now() - _reliabilityCachedAt < RELIABILITY_CACHE_MS) {
    return _sourceReliability;
  }
  try {
    const content = readJSON('content.json');
    const stats = {};
    for (const c of content) {
      const src = c.trigger_source || 'unknown';
      if (!stats[src]) stats[src] = { total: 0, approved: 0, rejected: 0 };
      stats[src].total++;
      if (c.status === 'approved') stats[src].approved++;
      else if (c.status === 'rejected') stats[src].rejected++;
    }
    // Calculate reliability factor: 0.6x to 1.8x based on approval rate
    // Baseline: sources with <3 content pieces get 1.0x (no data yet)
    const reliability = {};
    for (const [src, data] of Object.entries(stats)) {
      if (data.total < 3) {
        reliability[src] = { factor: 1.0, approval_rate: 0, total: data.total, note: 'insufficient data' };
        continue;
      }
      const rate = data.approved / data.total;
      // Linear mapping: 0% → 0.6x, 50% → 1.0x, 100% → 1.8x
      const factor = rate <= 0.5
        ? 0.6 + (rate / 0.5) * 0.4   // 0.6 to 1.0
        : 1.0 + ((rate - 0.5) / 0.5) * 0.8; // 1.0 to 1.8
      reliability[src] = {
        factor: Math.round(factor * 100) / 100,
        approval_rate: Math.round(rate * 100),
        total: data.total,
        approved: data.approved,
        rejected: data.rejected
      };
    }
    _sourceReliability = reliability;
    _reliabilityCachedAt = Date.now();
    return reliability;
  } catch {
    return {};
  }
}

const HIGH_VALUE_TERMS = [
  'ROI', 'cases', 'intake', 'revenue', 'signed cases', 'cost per case',
  'cost per lead', 'conversion rate', 'retainer', 'close rate',
  'speed to lead', 'after hours', 'missed calls', 'cost per acquisition',
  'client lifetime value', 'average case value', 'marketing spend',
  'Google Ads', 'LSA', 'local service ads', 'Google screened',
  'landing page', 'call tracking', 'form conversion', 'chat widget',
  'virtual receptionist', 'AI intake', 'automation',
  'Google Business Profile', 'local SEO', 'link building',
  'content strategy', 'video marketing', 'reputation management'
];

// Hook strength scoring — information gap, specific numbers, contrarian framing
function scoreHook(text) {
  let score = 0;
  const firstLine = (text || '').split('\n')[0] || '';
  const firstLineLower = firstLine.toLowerCase();
  // Specific number in hook (+3)
  if (/\$[\d,]+|\d+%|\d+x|\d+\/month/.test(firstLine)) score += 3;
  // Information gap — implies more to learn (+2)
  if (/but|however|except|the problem|what nobody|the truth|turns out|here'?s (what|why|how)/i.test(firstLineLower)) score += 2;
  // Contrarian framing (+2)
  if (/wrong|myth|stop|don'?t|isn'?t|won'?t work|overrated|waste|broken|dead/i.test(firstLineLower)) score += 2;
  // Short and punchy hook under 100 chars (+1)
  if (firstLine.length > 10 && firstLine.length < 100) score += 1;
  return Math.min(score, 8);
}

// Specificity score — concrete numbers, dollar amounts, named tools
function scoreSpecificity(text) {
  let score = 0;
  const numbers = (text.match(/\$[\d,]+|\d+%|\d+x|\d+ (cases|clients|leads|firms|calls|months?|weeks?)/g) || []).length;
  score += Math.min(numbers, 4);
  // Named tools show practitioner knowledge
  const tools = ['CallRail', 'Clio', 'Google Ads', 'Lawmatics', 'HubSpot', 'PracticePanther', 'Salesforce', 'LSA', 'Google Business', 'Smith.ai', 'Ruby', 'Filevine', 'Litify'];
  for (const tool of tools) {
    if (text.includes(tool)) { score += 1; break; } // +1 for any named tool
  }
  return Math.min(score, 5);
}

// Trending velocity — same topic appearing across 3+ sources in 48h
let _velocityCache = null;
let _velocityCachedAt = 0;
function scoreTrendingVelocity(trigger, allTriggers) {
  // Cache trigger titles for 5 minutes
  if (!_velocityCache || Date.now() - _velocityCachedAt > 5 * 60 * 1000) {
    const recent = (allTriggers || []).filter(t => daysAgo(t.captured_at) <= 2);
    _velocityCache = recent.map(t => ({
      id: t.id,
      words: new Set((t.title || '').toLowerCase().split(/\s+/).filter(w => w.length > 4))
    }));
    _velocityCachedAt = Date.now();
  }
  const titleWords = new Set((trigger.title || '').toLowerCase().split(/\s+/).filter(w => w.length > 4));
  if (titleWords.size === 0) return 0;
  let matches = 0;
  for (const cached of _velocityCache) {
    if (cached.id === trigger.id) continue;
    for (const w of titleWords) {
      if (cached.words.has(w)) { matches++; break; }
    }
  }
  return Math.min(matches, 5); // 0-5 points
}

// Emotional valence — frustration/anger/surprise signals outperform neutral 2-3x
function scoreEmotionalValence(text) {
  const lower = (text || '').toLowerCase();
  let score = 0;
  // Frustration/anger signals
  if (/wasted|bleeding|losing|killing|crushing|destroying|failing|broken|terrible|awful|insane/i.test(lower)) score += 2;
  // Surprise/shock signals
  if (/shocking|surprising|unexpected|unbelievable|mind.?blowing|jaw.?dropping|nobody.*knows|hidden/i.test(lower)) score += 2;
  // Urgency signals
  if (/right now|immediately|urgent|before it'?s too late|running out|deadline/i.test(lower)) score += 1;
  return Math.min(score, 4);
}

// Performance boost — factor published content performance into scoring
let _perfCache = null;
let _perfCachedAt = 0;

function getPerformanceBoost(trigger) {
  try {
    if (!_perfCache || Date.now() - _perfCachedAt > RELIABILITY_CACHE_MS) {
      const perfData = readJSON('performance.json', []);
      const content = readJSON('content.json');

      // Build category -> avg engagement map
      const catEngagement = {};
      for (const p of perfData) {
        const item = content.find(c => c.id === p.content_id);
        const cat = item?.trigger_category || p.category || 'unknown';
        if (!catEngagement[cat]) catEngagement[cat] = { total: 0, engagement: 0 };
        catEngagement[cat].total++;
        catEngagement[cat].engagement += (p.engagement || 0);
      }

      // Calculate avg engagement per category
      const catAvgs = {};
      let allAvg = 0;
      let allCount = 0;
      for (const [cat, data] of Object.entries(catEngagement)) {
        if (data.total > 0) {
          catAvgs[cat] = data.engagement / data.total;
          allAvg += data.engagement;
          allCount += data.total;
        }
      }
      const globalAvg = allCount > 0 ? allAvg / allCount : 0;

      // Build high-performing title keywords
      const highPerfKeywords = new Set();
      for (const p of perfData) {
        if ((p.engagement || 0) > globalAvg * 1.5) {
          const item = content.find(c => c.id === p.content_id);
          const words = (item?.trigger_title || '').toLowerCase().split(/\s+/).filter(w => w.length > 4);
          for (const w of words) highPerfKeywords.add(w);
        }
      }

      _perfCache = { catAvgs, globalAvg, highPerfKeywords, hasData: perfData.length >= 3 };
      _perfCachedAt = Date.now();
    }

    if (!_perfCache.hasData) return 0;

    let boost = 0;
    const catAvg = _perfCache.catAvgs[trigger.category];

    if (catAvg !== undefined && _perfCache.globalAvg > 0) {
      const ratio = catAvg / _perfCache.globalAvg;
      if (ratio >= 1.5) boost += 4;       // Top-quartile category
      else if (ratio >= 1.0) boost += 2;  // Above-average
      else if (ratio < 0.7) boost -= 1;   // Below-average
    }

    // Keyword overlap with high-performing titles
    const titleWords = (trigger.title || '').toLowerCase().split(/\s+/).filter(w => w.length > 4);
    const kwOverlap = titleWords.filter(w => _perfCache.highPerfKeywords.has(w)).length;
    if (kwOverlap >= 2) boost += 2;

    return boost;
  } catch {
    return 0;
  }
}

// Rejection penalty — penalize triggers similar to previously rejected content
let _rejectionCache = null;
let _rejectionCachedAt = 0;

function getRejectionPenalty(trigger) {
  try {
    if (!_rejectionCache || Date.now() - _rejectionCachedAt > RELIABILITY_CACHE_MS) {
      const memory = readJSON('memory.json', {});
      const rejections = memory.rejection_patterns || [];
      const content = readJSON('content.json');

      // Build source rejection rates
      const sourceStats = {};
      for (const r of rejections) {
        const src = r.trigger_source || 'unknown';
        if (!sourceStats[src]) sourceStats[src] = { total: 0, rejected: 0 };
        sourceStats[src].rejected++;
      }
      for (const c of content) {
        const src = c.trigger_source || 'unknown';
        if (!sourceStats[src]) sourceStats[src] = { total: 0, rejected: 0 };
        sourceStats[src].total++;
      }

      // Build rejected keyword set from titles
      const rejectedWords = new Set();
      for (const r of rejections) {
        const words = (r.trigger_title || r.content_preview || '').toLowerCase().split(/\s+/).filter(w => w.length > 4);
        for (const w of words) rejectedWords.add(w);
      }

      // Build rejected category counts
      const rejectedCategories = {};
      for (const r of rejections) {
        if (r.category) rejectedCategories[r.category] = (rejectedCategories[r.category] || 0) + 1;
      }

      _rejectionCache = { sourceStats, rejectedWords, rejectedCategories, totalRejections: rejections.length };
      _rejectionCachedAt = Date.now();
    }

    if (_rejectionCache.totalRejections === 0) return 0;

    let penalty = 0;

    // Source with >3 rejections and >60% rejection rate: -3pts
    const srcInfo = _rejectionCache.sourceStats[trigger.source];
    if (srcInfo && srcInfo.rejected > 3 && srcInfo.total > 0) {
      const rejectRate = srcInfo.rejected / srcInfo.total;
      if (rejectRate > 0.6) penalty -= 3;
    }

    // Title keyword overlap with rejected content (>2 matches): -2pts
    const titleWords = (trigger.title || '').toLowerCase().split(/\s+/).filter(w => w.length > 4);
    const overlap = titleWords.filter(w => _rejectionCache.rejectedWords.has(w)).length;
    if (overlap > 2) penalty -= 2;

    // Category matching frequently rejected categories: -1pt
    const catCount = _rejectionCache.rejectedCategories[trigger.category] || 0;
    if (catCount >= 3) penalty -= 1;

    return Math.max(penalty, -6);
  } catch {
    return 0;
  }
}

// Pattern frequency boost — triggers matching high-frequency patterns from meetings/deals
let _patternCache = null;
let _patternCachedAt = 0;
const PATTERN_CACHE_MS = 10 * 60 * 1000;

function getPatternBoost(trigger) {
  try {
    if (!_patternCache || Date.now() - _patternCachedAt > PATTERN_CACHE_MS) {
      db.initDb();
      _patternCache = db.getPatterns({ limit: 30 });
      _patternCachedAt = Date.now();
    }
    if (!_patternCache || _patternCache.length === 0) return 0;

    const text = `${trigger.title || ''} ${trigger.raw_content || ''}`.toLowerCase();
    let boost = 0;

    for (const pattern of _patternCache) {
      const words = (pattern.description || '').toLowerCase().split(/\s+/).filter(w => w.length > 4);
      const matches = words.filter(w => text.includes(w)).length;
      if (matches >= 2 || (words.length <= 3 && matches >= 1)) {
        boost += Math.min(pattern.frequency || 1, 5);
      }
    }
    return Math.min(boost, 10);
  } catch {
    return 0;
  }
}

function scoreTrigger(trigger, allTriggers) {
  let score = 0;
  const text = `${trigger.title || ''} ${trigger.raw_content || ''}`;
  const textLower = text.toLowerCase();

  // --- Core signals ---

  // Specific numbers (+3)
  if (/\$[\d,]+|\d+%|\d+x|\d+ cases|\d+ clients|\d+ leads/.test(text)) {
    score += 3;
  }

  // Pain points (+3)
  if (trigger.category === 'PAIN_POINT') {
    score += 3;
  }

  // Questions (+2)
  if (trigger.category === 'QUESTION') {
    score += 2;
  }

  // High-value keywords (+2 each, max 6)
  let hvCount = 0;
  for (const term of HIGH_VALUE_TERMS) {
    if (textLower.includes(term.toLowerCase())) {
      hvCount++;
    }
  }
  score += Math.min(hvCount * 2, 6);

  // General keyword density (+1 per keyword, max 4)
  score += Math.min(keywordScore(text), 4);

  // --- Enhanced signals (research-backed) ---

  // Hook strength (0-8 points, weighted at 25%)
  score += scoreHook(trigger.title || trigger.raw_content || '');

  // Specificity score (0-5 points)
  score += scoreSpecificity(text);

  // Trending velocity (0-5 points) — same topic across multiple sources
  if (allTriggers) {
    score += scoreTrendingVelocity(trigger, allTriggers);
  }

  // Emotional valence (0-4 points)
  score += scoreEmotionalValence(text);

  // --- Source signals ---

  // Reddit engagement (+2 if >20 upvotes or >10 comments)
  if (trigger.source === 'reddit' && trigger.engagement) {
    if ((trigger.engagement.upvotes || 0) > 20) score += 2;
    if ((trigger.engagement.comments || 0) > 10) score += 1;
  }

  // YouTube with transcript (+2)
  if (trigger.source === 'youtube' && trigger.raw_content?.includes('[Auto-captions')) {
    score += 2;
  }

  // YouTube thumbnails (+1)
  if (trigger.thumbnail) {
    score += 1;
  }

  // Competitor content is inherently more strategic (+2)
  if (trigger.source === 'competitor') {
    score += 2;
  }

  // --- Temporal signals ---

  // Recency bonus
  const age = daysAgo(trigger.captured_at);
  if (age <= 1) score += 2;
  else if (age <= 3) score += 1;

  // Content length bonus (more raw material = better)
  if ((trigger.raw_content || '').length > 500) score += 1;
  if ((trigger.raw_content || '').length > 1500) score += 1;

  // Data points are valuable (+2)
  if (trigger.category === 'DATA_POINT') {
    score += 2;
  }

  // Freshness decay — old triggers lose relevance
  if (age > 3) {
    score = Math.round(score * Math.pow(0.95, age - 3));
  }

  // Source reliability weighting — boost proven sources, penalize poor ones
  const reliability = getSourceReliability();
  const srcInfo = reliability[trigger.source];
  if (srcInfo && srcInfo.factor !== 1.0) {
    score = Math.round(score * srcInfo.factor);
  }

  // Performance boost — factor published content metrics into scoring
  score += getPerformanceBoost(trigger);

  // Pattern frequency boost — triggers matching meeting/deal patterns score higher
  score += getPatternBoost(trigger);

  // Rejection penalty — penalize triggers similar to previously rejected content
  score += getRejectionPenalty(trigger);

  return Math.max(0, score);
}

// Quality tier for auto-generation decisions
function getQualityTier(score) {
  if (score >= 30) return { tier: 'exceptional', action: 'auto-generate all 16 formats', formats: 'all' };
  if (score >= 22) return { tier: 'high', action: 'generate top 5 social + blog', formats: ['linkedin', 'x_single', 'x_thread', 'carousel', 'short_video', 'blog'] };
  if (score >= 15) return { tier: 'good', action: 'generate top 3 social', formats: ['linkedin', 'x_single', 'x_thread'] };
  if (score >= 10) return { tier: 'moderate', action: 'generate LinkedIn only', formats: ['linkedin'] };
  return { tier: 'low', action: 'skip or manual review', formats: [] };
}

function scoreAndSort(triggers) {
  return triggers
    .filter(t => t.status === 'pending')
    .map(t => ({ ...t, score: scoreTrigger(t, triggers) }))
    .sort((a, b) => b.score - a.score);
}

function selectTopTriggers(triggers, count = 10) {
  const scored = scoreAndSort(triggers);
  return scored.slice(0, count);
}

module.exports = { scoreTrigger, scoreAndSort, selectTopTriggers, getSourceReliability, getQualityTier, scoreHook, scoreSpecificity, scoreEmotionalValence };
