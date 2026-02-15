const { keywordScore, daysAgo } = require('../lib/utils');

const HIGH_VALUE_TERMS = [
  'ROI', 'cases', 'intake', 'revenue', 'signed cases', 'cost per case',
  'cost per lead', 'conversion rate', 'retainer', 'close rate',
  'speed to lead', 'after hours', 'missed calls'
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

module.exports = { scoreTrigger, scoreAndSort, selectTopTriggers };
