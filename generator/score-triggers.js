const { keywordScore, daysAgo, readJSON } = require('../lib/utils');

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

function scoreTrigger(trigger) {
  let score = 0;
  const text = `${trigger.title || ''} ${trigger.raw_content || ''}`;
  const textLower = text.toLowerCase();

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
  // After 7 days: 0.95^7 = 0.70 (30% penalty)
  // After 14 days: 0.95^14 = 0.49 (51% penalty)
  // After 30 days: 0.95^30 = 0.21 (79% penalty)
  if (age > 3) {
    score = Math.round(score * Math.pow(0.95, age - 3));
  }

  // Source reliability weighting — boost proven sources, penalize poor ones
  const reliability = getSourceReliability();
  const srcInfo = reliability[trigger.source];
  if (srcInfo && srcInfo.factor !== 1.0) {
    score = Math.round(score * srcInfo.factor);
  }

  return Math.max(0, score);
}

function scoreAndSort(triggers) {
  return triggers
    .filter(t => t.status === 'pending')
    .map(t => ({ ...t, score: scoreTrigger(t) }))
    .sort((a, b) => b.score - a.score);
}

function selectTopTriggers(triggers, count = 10) {
  const scored = scoreAndSort(triggers);
  return scored.slice(0, count);
}

module.exports = { scoreTrigger, scoreAndSort, selectTopTriggers, getSourceReliability };
