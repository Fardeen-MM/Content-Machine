const { loadEnv } = require('./utils');

loadEnv();

const API_URL = 'https://api.anthropic.com/v1/messages';
const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-4-5-20250929';

async function callClaude({ model, system, prompt, maxTokens = 2000 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }

  const body = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }]
  };

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || '';
  return text;
}

function parseJsonResponse(text) {
  // Try direct parse first
  try {
    return JSON.parse(text);
  } catch {}

  // Try extracting from markdown code block
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch {}
  }

  // Try finding JSON object/array in text
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0]);
    } catch {}
  }

  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      return JSON.parse(arrMatch[0]);
    } catch {}
  }

  return null;
}

async function generateSocialContent(trigger, system) {
  const prompt = `Generate content based on this trigger:

Title: ${trigger.title}
Source: ${trigger.source}
Category: ${trigger.category}
Content: ${trigger.raw_content?.slice(0, 2000) || 'N/A'}

Return a JSON object with these fields (no markdown fences, raw JSON only):
{
  "linkedin_post": "800-1300 character LinkedIn post with hook-first format, line breaks between thoughts",
  "x_single": "280 character max single tweet",
  "x_thread": ["tweet 1", "tweet 2", "tweet 3", "tweet 4", "tweet 5"],
  "short_video_script": "30-90 second read-to-camera script with [PAUSE] markers",
  "image_prompt": "Prompt for generating a branded image (navy blue and white scheme, professional, minimal)",
  "blog_keyword": "Suggested SEO keyword for a blog post (or null if not deep enough)",
  "youtube_topic": "Suggested YouTube video topic (or null if not deep enough)"
}`;

  const text = await callClaude({ model: HAIKU, system, prompt, maxTokens: 2000 });
  const parsed = parseJsonResponse(text);
  if (!parsed) throw new Error('Failed to parse social content JSON');
  return parsed;
}

async function generateBlogPost(trigger, keyword, system) {
  const prompt = `Write an SEO-optimized blog post based on this trigger:

Title: ${trigger.title}
Source: ${trigger.source}
Category: ${trigger.category}
Content: ${trigger.raw_content?.slice(0, 2000) || 'N/A'}
Target Keyword: ${keyword}

Requirements:
- 1,500-2,500 words
- Keyword in title and at least 2 H2 headers
- Markdown format with proper H1, H2, H3 structure
- Actionable, specific advice with numbers where possible
- Write for law firm owners — they care about cases and revenue
- End with a soft CTA mentioning Mortar Metrics
- Conversational but authoritative tone
- Short paragraphs, punchy sentences

Return the full blog post in Markdown format.`;

  return callClaude({ model: SONNET, system, prompt, maxTokens: 8000 });
}

async function generateYouTubeScript(trigger, topic, system) {
  const prompt = `Write a YouTube video script based on this trigger:

Title: ${trigger.title}
Source: ${trigger.source}
Category: ${trigger.category}
Content: ${trigger.raw_content?.slice(0, 2000) || 'N/A'}
Video Topic: ${topic}

Requirements:
- 8-15 minute script (1,500-3,000 words)
- Structure: Hook (30s) → Problem (2min) → Content (6-8min) → Proof/Case Study (2min) → CTA (30s)
- Spoken language style — write how you talk
- Include [VISUAL: description] markers for B-roll/graphics
- Include [PAUSE] markers for emphasis
- Include [CUT TO: description] for scene changes
- Hook must grab attention in first 10 seconds
- Reference specific numbers, case studies, data points
- End with soft CTA to Mortar Metrics

Return the full script.`;

  return callClaude({ model: SONNET, system, prompt, maxTokens: 8000 });
}

module.exports = {
  callClaude, parseJsonResponse, generateSocialContent,
  generateBlogPost, generateYouTubeScript,
  HAIKU, SONNET
};
