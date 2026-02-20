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
  const prompt = `Create content from this trigger. Your job is to find the most HUMAN, SPECIFIC, STORY-DRIVEN angle — not just summarize the information.

TRIGGER:
Title: ${trigger.title}
Source: ${trigger.source}
Category: ${trigger.category}
Raw content: ${trigger.raw_content?.slice(0, 2000) || 'N/A'}

BEFORE YOU WRITE, think about:
- What's the ONE specific failure, mistake, or surprising insight here?
- What's the dollar amount or case count this translates to?
- What would a frustrated law firm owner say about this in a group chat?

Return a JSON object (no markdown fences, raw JSON only):
{
  "linkedin_post": "800-1300 chars. Open with a specific micro-story or data point (NOT a question, NOT 'did you know'). One thought per line. Show the math. End with 3-5 action steps. NO hashtags.",
  "linkedin_hooks": ["Hook variant 1 (the opening 2 lines — failure story angle)", "Hook variant 2 (data bomb angle)", "Hook variant 3 (contrarian/myth-buster angle)"],
  "x_single": "Under 280 chars. The most provocative, quotable, argument-starting line from this topic. Should make someone reply.",
  "x_hooks": ["Tweet variant 1 (data angle)", "Tweet variant 2 (contrarian angle)", "Tweet variant 3 (story angle)"],
  "x_thread": ["Tweet 1: Hook that stops the scroll — specific number or failure", "Tweet 2: The context/setup", "Tweet 3: The data/proof", "Tweet 4: The insight most people miss", "Tweet 5: The action step + punch ending"],
  "short_video_script": "30-90 second script. Open with: 'If you're a [practice area] firm and [specific problem]...' Include [PAUSE] markers. Conversational — NOT scripted-sounding. End with one clear takeaway.",
  "linkedin_carousel": ["Slide 1: Bold provocative statement (8 words max, designed to stop scrolling)", "Slide 2: The problem with a specific number", "Slide 3: Why most firms get this wrong", "Slide 4: Step 1 of the fix", "Slide 5: Step 2 of the fix", "Slide 6: The result/proof", "Slide 7: Save this + follow @mortarmetrics"],
  "linkedin_poll": {"question": "Controversial question that people genuinely disagree on (under 140 chars)", "options": ["Option A", "Option B", "Option C", "Option D"], "post_text": "2-3 sentences that set up WHY this question matters — include a stat or insight"},
  "quote_cards": ["Punchy one-liner (under 12 words) — sounds like something said in conversation, not a motivational poster", "Second one-liner — contrarian or surprising"],
  "stat_graphic": {"number": "exact number from the content (e.g. 52%, $4,183, 47/90)", "label": "short label (under 8 words)", "context": "one sentence explaining why this matters"},
  "hot_take": "A genuinely controversial opinion about legal marketing that would split a room 50/50. Not generic. Specific to practice area if possible.",
  "before_after": {"before": "The specific painful reality (with numbers)", "after": "The specific transformed state (with numbers)"},
  "listicle_post": "5-7 items, each a specific actionable step (not vague advice). Number each item. 400-600 chars total. Each item earns its spot — no filler.",
  "image_prompt": "Branded image prompt: navy blue (#1e3a5f) and white, clean minimal design, featuring the key stat or headline from this content",
  "blog_keyword": "SEO keyword (3-5 words, search intent: someone with this problem) or null",
  "youtube_topic": "Video topic that would get clicks (curiosity gap in title) or null",
  "lead_magnet_topic": "A tool/calculator/checklist that solves the specific problem in this content, or null"
}`;

  const text = await callClaude({ model: HAIKU, system, prompt, maxTokens: 4000 });
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

async function generateLeadMagnet(trigger, system) {
  const topic = trigger.lead_magnet_topic || trigger.title;
  const prompt = `Create a lead magnet resource based on this topic:

Topic: ${topic}
Trigger Title: ${trigger.title}
Source: ${trigger.source}
Category: ${trigger.category}
Content: ${trigger.raw_content?.slice(0, 2000) || 'N/A'}

Pick the BEST lead magnet type from these 10 options based on the topic:
- scorecard: Interactive quiz (8-12 questions) with instant score
- calculator: Number inputs with instant calculated results
- checklist: Checkable items grouped by category
- audit: Diagnostic evaluation with pass/warn/fail ratings
- benchmark: Data comparison with industry averages
- swipe_file: Ready-to-use templates and copy
- blueprint: Step-by-step implementation framework
- cheat_sheet: Quick-reference one-pager with data
- toolkit: Collection of curated resources and tools
- worksheet: Fill-in-the-blank planning exercise

Return a JSON object (no markdown fences, raw JSON only) with this structure:

{
  "title": "The lead magnet title",
  "subtitle": "A compelling subtitle",
  "type": "one of the 10 types above",
  "cta_text": "Call-to-action text (e.g., Get a custom version for your firm)",
  "sections": [type-specific content - see below]
}

Type-specific "sections" format:

For "scorecard": Array of questions, each with:
  { "question": "text", "options": [{ "label": "text", "score": 0-3 }] }
  Include 8-12 questions. Also include "result_tiers": [{ "min": 0, "max": 12, "label": "Poor", "description": "text", "color": "#dc2626" }, ...]

For "calculator": { "inputs": [{ "label": "text", "placeholder": "text", "default": number, "unit": "$" or "%" or "" }], "formula_description": "text explaining the calculation", "result_label": "text" }

For "checklist": Array of categories, each with:
  { "category": "name", "items": ["item 1", "item 2", ...] }

For "audit": Array of criteria, each with:
  { "criterion": "text", "what_good_looks_like": "text", "red_flag": "text" }

For "benchmark": Array of metrics, each with:
  { "metric": "name", "bottom_25": "value", "average": "value", "top_10": "value", "unit": "$" or "%" or "" }

For "swipe_file": Array of templates, each with:
  { "title": "template name", "use_case": "when to use", "copy": "the actual template text" }

For "blueprint": Array of phases, each with:
  { "phase": "Phase 1: Name", "timeline": "Week 1-2", "steps": ["step 1", "step 2"], "outcome": "expected result" }

For "cheat_sheet": Array of sections, each with:
  { "heading": "section name", "rows": [{ "label": "text", "value": "text" }] }

For "toolkit": Array of tools, each with:
  { "name": "tool name", "category": "category", "description": "what it does", "why": "why you need it" }

For "worksheet": Array of sections, each with:
  { "heading": "section name", "guidance": "instructions", "prompts": [{ "label": "text", "type": "text" or "textarea" or "number" }] }

Make it specific to the legal industry. Use real-sounding numbers and benchmarks. Make it genuinely useful — a lawyer should be able to use this immediately and get value from it.`;

  const text = await callClaude({ model: SONNET, system, prompt, maxTokens: 6000 });
  const parsed = parseJsonResponse(text);
  if (!parsed) throw new Error('Failed to parse lead magnet JSON');
  return parsed;
}

async function extractSpokes(pillarContent, pillarType, trigger, system) {
  const prompt = `You have a pillar content piece. Your job is to extract social media content FROM this specific piece — every social post should reference specific stats, quotes, frameworks, or insights that actually appear in the pillar.

PILLAR TYPE: ${pillarType}
TRIGGER TITLE: ${trigger.title}

--- BEGIN PILLAR CONTENT ---
${(typeof pillarContent === 'string' ? pillarContent : JSON.stringify(pillarContent)).slice(0, 6000)}
--- END PILLAR CONTENT ---

Extract social media spokes DERIVED FROM the pillar above. Each spoke must reference specific content from the pillar — not generic takes on the topic.

Return a JSON object (no markdown fences, raw JSON only):
{
  "linkedin_post": "800-1300 char LinkedIn post pulling the BEST single insight from the pillar, with specific numbers/quotes from it. Hook-first format, line breaks between thoughts.",
  "x_single": "280 char max tweet — the single most provocative or surprising line from the pillar",
  "x_thread": ["tweet 1: hook from pillar", "tweet 2: key point 1", "tweet 3: key point 2", "tweet 4: key point 3", "tweet 5: CTA"],
  "short_video_script": "30-90 second script using the hook + 1 key insight from the pillar. Include [PAUSE] markers.",
  "linkedin_carousel": ["Slide 1: Hook headline from pillar (10 words max)", "Slide 2: First framework/step from pillar", "Slide 3: Second point", "Slide 4: Third point", "Slide 5: Key stat from pillar", "Slide 6: Proof point", "Slide 7: CTA"],
  "linkedin_poll": {"question": "Poll question based on the pillar's most debatable point", "options": ["Option A", "Option B", "Option C", "Option D"], "post_text": "2-3 sentence context from the pillar"},
  "quote_cards": ["Verbatim punchy one-liner from the pillar", "Another quotable line from the pillar"],
  "stat_graphic": {"number": "specific stat from pillar", "label": "what it measures", "context": "one sentence from pillar"},
  "hot_take": "The most contrarian claim from the pillar, stated as a provocative standalone take",
  "before_after": {"before": "Problem state described in the pillar", "after": "Solution/result described in the pillar"},
  "listicle_post": "5-7 key points from the pillar as a numbered list (400-600 chars)",
  "email_snippet": "3-4 sentence teaser for the pillar that drives readers to the full piece. Create curiosity gap."
}`;

  const text = await callClaude({ model: HAIKU, system, prompt, maxTokens: 4000 });
  const parsed = parseJsonResponse(text);
  if (!parsed) throw new Error('Failed to parse spokes JSON');
  return parsed;
}

async function generateNewsletter(trigger, system) {
  const prompt = `Write an email newsletter deep dive based on this trigger:

Title: ${trigger.title}
Source: ${trigger.source}
Category: ${trigger.category}
Content: ${trigger.raw_content?.slice(0, 2000) || 'N/A'}

Requirements:
- 800-1200 words
- Single-topic deep dive format
- Structure: Subject line → Preview text → Opening hook → 3 key sections → One actionable takeaway → Soft CTA
- Write for law firm owners — they care about cases and revenue
- Conversational, punchy, scannable
- Short paragraphs (2-3 sentences max)
- Include specific numbers and benchmarks
- End with a soft CTA to Mortar Metrics

Return a JSON object (no markdown fences, raw JSON only):
{
  "subject_line": "Email subject (under 60 chars, curiosity-driven)",
  "preview_text": "Preview text that appears in inbox (under 90 chars)",
  "body": "The full newsletter body in markdown format"
}`;

  const text = await callClaude({ model: SONNET, system, prompt, maxTokens: 4000 });
  const parsed = parseJsonResponse(text);
  if (!parsed) throw new Error('Failed to parse newsletter JSON');
  return parsed;
}

async function generateCaseStudy(trigger, system) {
  const prompt = `Write a mini case study based on this trigger topic:

Title: ${trigger.title}
Source: ${trigger.source}
Category: ${trigger.category}
Content: ${trigger.raw_content?.slice(0, 2000) || 'N/A'}

Requirements:
- 200-400 words
- Problem → Solution → Results structure
- Use one of Mortar Metrics' proof points and connect it to this topic
- Include specific numbers (cases/month, ROI, cost reduction, etc.)
- ONLY use verified proof points: Mandall Law (immigration, $4K budget to $92K/mo revenue, 30+ signed cases/month) or Agile Legal Services. NEVER invent firm names.
- End with a takeaway that connects back to the topic
- Write in third-person narrative style

Return the full case study in markdown format (no JSON wrapper needed).`;

  return callClaude({ model: HAIKU, system, prompt, maxTokens: 1500 });
}

async function remixContent(originalContent, originalTitle, mode, system) {
  const modeInstructions = {
    'new-angle': 'Create the SAME content but from a completely different angle. If the original used a data-bomb approach, try a story/failure approach. If it was a how-to, make it a myth-buster. The core insight stays the same, but the framing and hook are totally different.',
    'different-audience': 'Rewrite for a DIFFERENT practice area or audience. If the original was for PI firms, rewrite for family law or estate planning. Adapt the numbers, examples, and pain points to the new audience.',
    'expand': 'Take the core insight and expand it — create a deeper, more detailed version with additional steps, more specific numbers, and a longer narrative arc. Add what was left out of the original.',
    'simplify': 'Take the core insight and make it MORE punchy, MORE provocative, MORE shareable. Strip away complexity. Make every word earn its place. This should be the version that goes viral.'
  };

  const prompt = `Remix this existing content into something fresh and different.

ORIGINAL CONTENT (title: "${originalTitle}"):
${(typeof originalContent === 'string' ? originalContent : JSON.stringify(originalContent)).slice(0, 2000)}

REMIX MODE: ${mode}
${modeInstructions[mode] || modeInstructions['new-angle']}

Return a JSON object with these remixed formats (raw JSON, no markdown fences):
{
  "linkedin_post": "800-1300 chars remixed version",
  "x_single": "Under 280 chars — the most provocative angle",
  "x_thread": ["5 tweet thread with fresh angle"],
  "hot_take": "A genuinely controversial take on this topic",
  "remix_angle": "2-sentence description of how this remix differs from the original"
}`;

  const text = await callClaude({ model: HAIKU, system, prompt, maxTokens: 3000 });
  const parsed = parseJsonResponse(text);
  if (!parsed) throw new Error('Failed to parse remix JSON');
  return parsed;
}

module.exports = {
  callClaude, parseJsonResponse, generateSocialContent,
  generateBlogPost, generateYouTubeScript, generateLeadMagnet,
  generateNewsletter, generateCaseStudy, extractSpokes, remixContent,
  HAIKU, SONNET
};
