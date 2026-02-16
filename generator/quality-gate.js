/**
 * quality-gate.js — Synchronous content quality scorer (zero deps)
 * Returns { score: 0-100, pass: boolean, issues: [], suggestions: [] }
 * pass = score >= 70, high quality = score >= 85
 */

const fs = require('fs');
const path = require('path');

const LENGTH_RULES = {
  linkedin:       { min: 400, max: 1500, unit: 'chars' },
  x_single:       { min: 10,  max: 280,  unit: 'chars' },
  x_thread:       { min: 3,   max: 7,    unit: 'tweets', tweetMax: 280 },
  short_video:    { min: 200, max: 2000,  unit: 'chars' },
  carousel:       { min: 5,   max: 10,   unit: 'slides' },
  hot_take:       { min: 20,  max: 280,  unit: 'chars' },
  listicle:       { min: 200, max: 800,  unit: 'chars' },
  blog:           { min: 3000, max: 50000, unit: 'chars' },
  youtube_script: { min: 3000, max: 50000, unit: 'chars' },
  newsletter:     { min: 1500, max: 20000, unit: 'chars' },
  case_study:     { min: 400,  max: 3000,  unit: 'chars' },
};

const STRUCTURED_FIELDS = {
  poll:          ['question', 'options'],
  stat_graphic:  ['stat', 'caption'],
  before_after:  ['before', 'after'],
  quote_cards:   ['quote', 'attribution'],
};

const WEAK_OPENERS = ["in today's", "as a", "it's important", "in this post"];
const STRONG_OPENERS = [/^\d/, /^[""\u201c]?you /i, /^[""\u201c]?i /i, /^[""\u201c]?we /i, /^[""\u201c]?stop/i, /^[""\u201c]?the /i, /\?/];
const VAGUE_PHRASES = ["many firms", "a lot of", "significantly", "various", "some studies"];
const BANNED_PHRASES = ["leverage", "synergy", "paradigm", "utilize", "facilitate", "innovative solution"];
const JARGON = ["holistic approach", "cutting-edge", "world-class", "best-in-class"];
const PROOF_POINTS = ["mandall", "metro pi", "davis family", "peak defense", "$12m", "2.8x", "97%"];
const LONG_FORM = new Set(['blog', 'newsletter', 'youtube_script']);
const SOCIAL_FORMATS = new Set(['linkedin', 'x_single', 'x_thread', 'hot_take', 'listicle', 'short_video', 'carousel']);

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.join('\n');
  if (content && typeof content === 'object') return Object.values(content).flat().join('\n');
  return String(content || '');
}

function jaccard(a, b) {
  const sa = new Set(a), sb = new Set(b);
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function wordSet(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
}

function qualityCheck(content, formatKey, trigger) {
  let score = 100;
  const issues = [];
  const suggestions = [];
  const text = textOf(content);
  const lower = text.toLowerCase();

  // ---------- 1. Length check ----------
  const rule = LENGTH_RULES[formatKey];
  if (rule) {
    if (rule.unit === 'chars') {
      const len = text.length;
      if (len < rule.min) { score -= 15; issues.push(`Too short: ${len}/${rule.min} chars`); }
      if (len > rule.max) { score -= 10; issues.push(`Too long: ${len}/${rule.max} chars`); }
    } else if (rule.unit === 'tweets') {
      const tweets = Array.isArray(content) ? content : text.split(/\n{2,}/);
      if (tweets.length < rule.min) { score -= 15; issues.push(`Only ${tweets.length} tweets, need ${rule.min}+`); }
      if (tweets.length > rule.max) { score -= 10; issues.push(`${tweets.length} tweets exceeds max ${rule.max}`); }
      const long = tweets.filter(t => t.length > rule.tweetMax);
      if (long.length) { score -= 10; issues.push(`${long.length} tweet(s) over 280 chars`); }
    } else if (rule.unit === 'slides') {
      const slides = Array.isArray(content) ? content : text.split(/\n{2,}/);
      if (slides.length < rule.min) { score -= 15; issues.push(`Only ${slides.length} slides, need ${rule.min}+`); }
      if (slides.length > rule.max) { score -= 10; issues.push(`${slides.length} slides exceeds max ${rule.max}`); }
    }
  }
  const sf = STRUCTURED_FIELDS[formatKey];
  if (sf && typeof content === 'object' && !Array.isArray(content)) {
    const missing = sf.filter(f => !content[f]);
    if (missing.length) { score -= 15; issues.push(`Missing fields: ${missing.join(', ')}`); }
  }

  // ---------- 2. Hook check ----------
  const firstLine = text.split(/[\n.!?]/)[0] || '';
  const firstLower = firstLine.toLowerCase().trim();
  if (WEAK_OPENERS.some(w => firstLower.startsWith(w))) {
    score -= 10;
    issues.push('Weak opener detected');
    suggestions.push('Start with a number, question, or direct address ("You", "Stop", "I")');
  }
  if (STRONG_OPENERS.some(p => p.test(firstLine.trim()))) score += 5;
  if (firstLine.length > 100) {
    score -= 5;
    issues.push('First line over 100 chars \u2014 keep hooks punchy');
  }

  // ---------- 3. Specificity check ----------
  const statCount = (text.match(/\d+[\d,.]*%?|\$[\d,.]+/g) || []).length;
  const minStats = LONG_FORM.has(formatKey) ? 3 : 1;
  if (statCount < minStats) {
    score -= 10;
    issues.push(`Only ${statCount} number(s) found, want ${minStats}+`);
    suggestions.push('Add concrete stats, dollar amounts, or percentages');
  }
  for (const vp of VAGUE_PHRASES) {
    if (lower.includes(vp)) {
      score -= 5;
      issues.push(`Vague phrase: "${vp}"`);
      break; // deduct once
    }
  }

  // ---------- 4. Brand voice check ----------
  for (const bp of BANNED_PHRASES) {
    if (lower.includes(bp)) {
      score -= 10;
      issues.push(`Banned phrase: "${bp}"`);
      suggestions.push(`Replace "${bp}" with a plain-English alternative`);
      break;
    }
  }
  for (const j of JARGON) {
    if (lower.includes(j)) {
      score -= 5;
      issues.push(`Jargon: "${j}"`);
      break;
    }
  }
  const proofHits = PROOF_POINTS.filter(p => lower.includes(p)).length;
  if (proofHits > 0) { score += 5; suggestions.push('Good \u2014 proof points referenced'); }

  // ---------- 5. Duplicate check ----------
  try {
    const contentPath = path.join(__dirname, '..', 'data', 'content.json');
    if (fs.existsSync(contentPath)) {
      const existing = JSON.parse(fs.readFileSync(contentPath, 'utf8'));
      const recent = (Array.isArray(existing) ? existing : [])
        .filter(c => c.format === formatKey)
        .slice(-20);
      const words = wordSet(text);
      for (const item of recent) {
        const itemWords = wordSet(textOf(item.content || item.body || ''));
        if (jaccard(words, itemWords) > 0.5) {
          score -= 15;
          issues.push('High similarity with recent content in same format');
          suggestions.push('Rework the angle or pick a different trigger');
          break;
        }
      }
    }
  } catch (_) { /* skip duplicate check on read error */ }

  // ---------- 6. CTA check ----------
  if (LONG_FORM.has(formatKey) && !/mortar/i.test(text)) {
    score -= 10;
    issues.push('Long-form content missing Mortar CTA');
    suggestions.push('Add a mention of Mortar Metrics or link to mortarmetrics.com');
  }

  // ---------- 7. Platform rules ----------
  if (formatKey === 'x_single' && text.length > 280) {
    score -= 15;
    issues.push(`Tweet is ${text.length} chars \u2014 must be \u2264280`);
  }
  if (formatKey === 'linkedin' && /(https?:\/\/|www\.)/i.test(text)) {
    score -= 5;
    issues.push('LinkedIn post contains a link \u2014 algorithm penalizes external URLs');
    suggestions.push('Move the link to the first comment instead');
  }
  if (formatKey === 'carousel') {
    const slides = Array.isArray(content) ? content : text.split(/\n{2,}/);
    const longSlides = slides.filter(s => String(s).length > 100);
    if (longSlides.length) {
      score -= 5;
      issues.push(`${longSlides.length} carousel slide(s) over 100 chars`);
    }
  }

  // ---------- Clamp & return ----------
  score = Math.max(0, Math.min(100, score));
  return { score, pass: score >= 70, issues, suggestions };
}

module.exports = { qualityCheck };
