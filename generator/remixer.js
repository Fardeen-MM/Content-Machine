const { callClaude, parseJsonResponse, SONNET } = require('../lib/claude');
const { atomizeContent } = require('./atomizer');

const SYSTEM = `You are the content strategist for Mortar Metrics, a legal marketing agency.
A competitor published content. Your job: take the same TOPIC and create Mortar Metrics' BETTER version.

RULES:
- Do NOT copy or paraphrase. Take the topic and give OUR angle with OUR data.
- Use OUR proof points (ONLY real case studies):
  • Mandall Law (immigration): $4K/month ad budget → $92K/month revenue, 30+ signed cases/month through our full-stack system
- Be direct, confident, zero fluff. Specific numbers always.
- Short sentences. Punchy. Write like you talk.

Return raw JSON (no markdown fences) with this exact structure:
{
  "title": "string",
  "angle": "one sentence explaining how ours differs from the competitor's take",
  "blog_post": "1500-2500 word markdown blog post",
  "linkedin_post": "string",
  "x_single": "string under 280 chars",
  "carousel": ["slide 1", "slide 2", "slide 3", "slide 4", "slide 5", "slide 6", "slide 7"]
}`;

async function remixContent(originalText, sourceUrl, system) {
  const atoms = await atomizeContent(originalText, sourceUrl).catch(() => []) || [];

  const prompt = `COMPETITOR CONTENT (source: ${sourceUrl}):
---
${(originalText || '').slice(0, 6000)}
---

EXTRACTED ATOMS FROM THEIR CONTENT:
${JSON.stringify(atoms, null, 2).slice(0, 3000)}

Create Mortar Metrics' version. Same topic, OUR angle, OUR data. Don't copy — outperform.
Blog post must be 1500-2500 words in markdown. Carousel must be exactly 7 slides.`;

  const raw = await callClaude({
    model: SONNET,
    system: system || SYSTEM,
    prompt,
    maxTokens: 4096
  });

  const parsed = parseJsonResponse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { _error: 'Failed to parse response', _sourceUrl: sourceUrl };
  }

  return { ...parsed, atoms, _sourceUrl: sourceUrl };
}

module.exports = { remixContent };
