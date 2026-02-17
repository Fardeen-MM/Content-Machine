const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      const val = trimmed.slice(eqIndex + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

function readJSON(filename, defaultVal = []) {
  const filePath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filePath)) return defaultVal;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return defaultVal;
  }
}

function writeJSON(filename, data) {
  const filePath = path.join(DATA_DIR, filename);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max - 3) + '...' : str;
}

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseXml(xml, tag) {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const matches = [];
  let m;
  while ((m = regex.exec(xml)) !== null) {
    matches.push(m[1].trim());
  }
  return matches;
}

function extractCdata(str) {
  const m = str.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return m ? m[1].trim() : str.trim();
}

function now() {
  return new Date().toISOString();
}

function daysAgo(dateStr) {
  const then = new Date(dateStr);
  const diff = Date.now() - then.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

const KEYWORDS = [
  // Core legal marketing
  'law firm marketing', 'lawyer SEO', 'legal leads', 'Google Ads lawyer',
  'law firm website', 'getting clients', 'intake', 'case acquisition',
  'marketing agency', 'law firm growth', 'personal injury marketing',
  'legal marketing', 'speed to lead', 'law firm CRM', 'after hours leads',
  'law firm revenue', 'lawyer marketing', 'attorney marketing', 'law firm PPC',
  'legal advertising', 'law firm digital marketing', 'client acquisition',
  'lawyer leads', 'legal tech', 'law firm SEO', 'PI marketing',
  'family law marketing', 'criminal defense marketing', 'law firm ROI',
  // Practice areas
  'personal injury lawyer', 'car accident lawyer', 'slip and fall',
  'medical malpractice', 'workers comp attorney', 'estate planning marketing',
  'immigration lawyer marketing', 'DUI attorney', 'bankruptcy lawyer',
  'employment lawyer', 'mass tort', 'class action',
  // Lead gen & conversion
  'lead generation', 'conversion rate', 'cost per lead', 'cost per case',
  'signed cases', 'case value', 'average case value', 'client lifetime value',
  'retainer', 'consultation booking', 'intake process', 'lead follow up',
  'missed calls', 'after hours', 'chat widget', 'live chat',
  'call tracking', 'form submissions', 'landing page',
  // Digital marketing tactics
  'local SEO', 'Google Business Profile', 'Google Maps', 'local pack',
  'link building', 'content marketing', 'social media marketing',
  'Facebook ads', 'Instagram marketing', 'LinkedIn marketing', 'TikTok lawyer',
  'video marketing', 'YouTube marketing', 'email marketing', 'retargeting',
  'remarketing', 'display ads', 'LSA', 'local service ads',
  'Google screened', 'pay per click', 'organic traffic',
  // Reviews & reputation
  'online reviews', 'Google reviews', 'reputation management', 'client reviews',
  'Avvo', 'Martindale', 'SuperLawyers', 'lawyer ratings',
  // Tech & operations
  'CRM', 'practice management', 'Clio', 'MyCase', 'PracticePanther',
  'automation', 'AI legal', 'ChatGPT lawyer', 'legal AI',
  'virtual receptionist', 'answering service',
  // Business metrics
  'revenue growth', 'profit margin', 'marketing budget', 'marketing spend',
  'ROI', 'return on investment', 'scaling', 'hiring', 'law firm operations'
];

function matchesKeywords(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return KEYWORDS.some(kw => lower.includes(kw));
}

function keywordScore(text) {
  if (!text) return 0;
  const lower = text.toLowerCase();
  let score = 0;
  for (const kw of KEYWORDS) {
    if (lower.includes(kw)) score++;
  }
  return score;
}

module.exports = {
  loadEnv, generateId, readJSON, writeJSON,
  sleep, truncate, stripHtml, parseXml, extractCdata,
  now, daysAgo, matchesKeywords, keywordScore, KEYWORDS, DATA_DIR
};
