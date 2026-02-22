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

  let data;
  try { data = await res.json(); } catch { throw new Error('Claude API returned invalid JSON'); }
  const text = data?.content?.[0]?.text || '';
  return text;
}

function parseJsonResponse(text) {
  function tryParse(str) {
    try { return JSON.parse(str); } catch {}
    // Strip trailing commas before } or ]
    const cleaned = str.replace(/,(\s*[}\]])/g, '$1');
    try { return JSON.parse(cleaned); } catch {}
    return null;
  }

  // Try direct parse first
  const direct = tryParse(text);
  if (direct) return direct;

  // Try extracting from markdown code block
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    const result = tryParse(fenceMatch[1]);
    if (result) return result;
  }

  // Try finding JSON object/array in text
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    const result = tryParse(objMatch[0]);
    if (result) return result;
  }

  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    const result = tryParse(arrMatch[0]);
    if (result) return result;
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
- Apply the Value Equation: maximize (Dream Outcome x Perceived Likelihood) / minimize (Time Delay x Effort)

LINKEDIN POST STRUCTURE — use one of these frameworks:
1. Unpopular Opinion: contrarian claim → data evidence → reframed question → engagement ask
2. Mistake I Made: specific mistake → dollar cost → consequences → lesson → what to do instead
3. 3-Step Framework: "[Outcome] comes down to 3 things:" → steps → "Most skip Step [X]" → proof
4. Before/After: client problem → 3 specific changes → metrics before/after → counterintuitive lesson
5. I Analyzed X: "I analyzed [N] [things]" → surprising finding → data breakdown → what winners do
6. Mini Case Study: client situation → bad metrics → 3 tactics → results → "No magic. Just [principle]."

X/TWITTER THREAD STRUCTURE — use one of these:
1. "I spent $[X] on [thing]. Here's what works (and what's waste):" → lessons → CTA
2. Strategy Breakdown: how [entity] achieved [result] → their step-by-step playbook
3. Contrarian Take: bold claim → evidence → rebuttal → nuanced conclusion
4. Case Study: situation → diagnosis → changes → results → lesson → "Reply [keyword] for template"

SHORT VIDEO SCRIPT STRUCTURE (pick based on length):
- 30s: HOOK (0-3s bold claim) → PROBLEM (3-10s) → SOLUTION (10-25s, 2-3 steps) → CTA (25-30s)
- 60s: HOOK → CONTEXT (credibility) → PROBLEM (counter-evidence) → VALUE (3 steps) → PROOF (result) → CTA
- 90s: HOOK → STORY (client scenario) → ROOT CAUSES → 3-STEP FIX → RESULTS (metrics) → LESSON → CTA + LOOP

Return a JSON object (no markdown fences, raw JSON only):
{
  "linkedin_post": "800-1300 chars. Use one of the 6 frameworks above. Open with a specific micro-story, data point, or contrarian claim (NOT a question, NOT 'did you know'). One thought per line. Show the math. End with 3-5 action steps. NO hashtags.",
  "linkedin_hooks": ["Hook variant 1 (failure story angle — '[Time] ago, [mistake]. It cost [amount].')", "Hook variant 2 (data bomb — 'I analyzed [N] [things]. [X]% had the same mistake.')", "Hook variant 3 (contrarian — 'Most law firms believe [X]. Here's why they're wrong.')"],
  "x_single": "Under 280 chars. The most provocative, quotable, argument-starting line. Format options: 'Them: [advice]. Me: *[contradictory action]*.' OR '[surprising stat]. Let that sink in.' OR bold claim.",
  "x_hooks": ["Tweet variant 1 (data angle)", "Tweet variant 2 (contrarian angle)", "Tweet variant 3 (story angle)"],
  "x_thread": ["Tweet 1: Hook that stops the scroll — specific number or failure + thread emoji", "Tweet 2: The context/credibility", "Tweet 3: The data/proof", "Tweet 4: The insight most people miss", "Tweet 5: The action step + CTA ('Reply AUDIT and I'll DM the template. Repost to help a firm owner.')"],
  "short_video_script": "30-90 second script using the structure above. HOOK must grab in 3 seconds — bold claim, surprising stat, or 'If you're a [audience], stop scrolling.' Include [PAUSE] markers. Conversational NOT scripted. End with comment-keyword CTA.",
  "linkedin_carousel": ["Slide 1: Bold provocative statement (8 words max, designed to stop scrolling)", "Slide 2: The problem with a specific number", "Slide 3: Why most firms get this wrong", "Slide 4: Step 1 of the fix", "Slide 5: Step 2 of the fix", "Slide 6: The result/proof", "Slide 7: Save this + follow @mortarmetrics"],
  "linkedin_poll": {"question": "Controversial question that people genuinely disagree on (under 140 chars)", "options": ["Option A", "Option B", "Option C", "Option D"], "post_text": "2-3 sentences that set up WHY this question matters — include a stat or insight"},
  "quote_cards": ["Punchy one-liner (under 12 words) — sounds like something said in conversation, not a motivational poster", "Second one-liner — contrarian or surprising"],
  "stat_graphic": {"number": "exact number from the content (e.g. 52%, $4,183, 47/90)", "label": "short label (under 8 words)", "context": "one sentence explaining why this matters"},
  "hot_take": "A genuinely controversial opinion about legal marketing that would split a room 50/50. Not generic. Specific to practice area if possible.",
  "before_after": {"before": "The specific painful reality (with numbers)", "after": "The specific transformed state (with numbers)"},
  "listicle_post": "5-7 items, each a specific actionable step (not vague advice). Number each item. 400-600 chars total. Each item earns its spot — no filler.",
  "image_prompt": "Branded image prompt: navy blue (#1e3a5f) and white, clean minimal design, featuring the key stat or headline from this content",
  "blog_keyword": "SEO keyword (3-5 words, search intent: someone with this problem) or null",
  "youtube_topic": "Video topic using a title formula: 'How to [action] (Even If [objection])' or 'I [action] for [time] — Here's What Happened' or 'Why [common thing] Doesn't Work (And What Does)'. Must create curiosity gap. Or null.",
  "lead_magnet_topic": "A tool/calculator/scorecard/checklist that solves this problem. Prefer scorecards (40%+ conversion) and calculators (8-11% conversion) over PDFs. Or null.",
  "linkedin_cta": "Use comment-keyword pattern: 'Comment [KEYWORD] and I'll send you [specific resource].' Rotate keywords: AUDIT, INTAKE, SCORECARD, TEMPLATE, DATA. NOT 'DM me' or 'Link in bio'.",
  "x_cta": "Thread closing CTA: 'Reply [keyword] and I'll DM the template. If useful, repost — a firm owner needs this.'"
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

TITLE OPTIMIZATION — suggest a click-worthy title using one of these formulas:
- "How to [action] (Even If [common objection])"
- "I [action] for [timeframe] — Here's What Happened"
- "Why [common thing] Doesn't Work (And What Does)"
- "From [bad state] to [good state]: The Complete [process]"
- "[Number] Mistakes Every [audience] Makes in 2026"
- Keep under 60 chars. Main keyword in first 5 words.

THUMBNAIL SUGGESTION: Describe a thumbnail (face expression + 1-3 words max text + colors). Text should COMPLEMENT the title, not repeat it.

Requirements:
- 8-15 minute script (1,500-3,000 words)
- Structure (Hormozi method):
  * HOOK (0-30s): Proof statement (why listen to you) + Promise (what they'll learn) + Plan (structure preview)
  * PROBLEM (30s-3min): Agitate the pain with specific numbers — make them FEEL it
  * CONTENT (3-10min): Framework with concrete steps. Mini-hooks between sections ("But here's where it gets interesting..."). Pattern interrupts every 60 seconds.
  * PROOF (10-12min): Case study or data that validates the framework. Show the math.
  * CTA (last 30s): Single action — lead magnet download or subscribe. Direct to description link.
- Spoken language — write how you talk. Short sentences. Punchy.
- Include [VISUAL: description] markers for B-roll/graphics
- Include [PAUSE] markers for emphasis
- Include [PATTERN INTERRUPT: description] every 60s (zoom, text overlay, B-roll, cut)
- Include [CUT TO: description] for scene changes
- Include [MID-ROLL CTA] at a natural break around minute 5-6
- Hook MUST grab in first 5 seconds — target 35-55% retention at 5s mark
- End with clear CTA: "I built a free [scorecard/calculator] for this. Link in the description. Takes 5 minutes."

Return as:
SUGGESTED TITLE: [title]
THUMBNAIL: [description]

[Full script below]`;

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

CONVERSION RATES BY TYPE (pick the highest-converting type that fits the topic):
- scorecard: 30-50% conversion (BEST — creates urgency through self-discovery, collects zero-party data for sales team)
- calculator: 8-11% conversion (STRONG — financial tools that show dollar impact)
- audit: 6-10% conversion (GOOD — diagnostic reveals hidden problems)
- checklist: 5-6% conversion (SOLID — easy to consume, immediately actionable)
- benchmark: 4-5% conversion (comparison data motivates action)
- swipe_file: Ready-to-use templates and copy
- blueprint: Step-by-step implementation framework
- cheat_sheet: Quick-reference one-pager with data
- toolkit: Collection of curated resources and tools
- worksheet: Fill-in-the-blank planning exercise

PREFER scorecard or calculator — they convert 3-5x better than PDFs.

SCORECARD DESIGN (Daniel Priestley model — if you pick scorecard):
- Define 5-7 PILLARS of your methodology (the core areas a client needs to get right)
- 2-3 questions per pillar (12-20 total)
- Questions designed so even strong firms score below 100%
- Score reveals which pillar is WEAKEST (the "root cause")
- Results page: overall score + per-pillar breakdown + dollar impact estimate
- The weakest pillar = the sales conversation topic
- Score buckets: Red (0-40), Yellow (41-70), Green (71-100) with different messages

CALCULATOR DESIGN (if you pick calculator):
- Inputs that the user knows: practice area, monthly ad spend, average case value, current conversion rate
- Outputs: estimated revenue gap, cost per signed case, comparison to benchmarks
- Show the "money left on the table" number prominently

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

SUBJECT LINE — use one of these proven formulas (under 50 chars, no emojis, no ALL CAPS):
- "[Number] [adjective] ways to [benefit]" → "5 proven ways to sign more PI cases"
- "The [number]-word tweak that [result]" → "The 3-word tweak that doubled callbacks"
- "How [similar company] [achieved outcome]" → "How a 4-attorney firm signed 15 cases in 30 days"
- "From [bad state] to [good state] in [time]" → "From 2 cases/mo to 18 in 60 days"
- "[Number] mistakes costing [audience] [amount]" → "3 mistakes costing PI firms $100K/year"
- "Why your [metric] is [problem]" → "Why your cost per case is 3x too high"

Requirements:
- 800-1200 words
- Single-topic deep dive format
- Structure: Subject line → Preview text → Opening story/insight hook → 3 key sections → One actionable takeaway → Soft CTA
- Write for law firm owners — they care about cases and revenue
- Conversational, punchy, scannable
- Short paragraphs (2-3 sentences max)
- Include specific numbers and benchmarks
- End with soft CTA: "Hit reply if you have questions — I read every email." or "P.S. I have 3 audit slots open this week."
- Give away the punchline upfront (paradoxically drives MORE engagement)

Return a JSON object (no markdown fences, raw JSON only):
{
  "subject_line": "Email subject (under 50 chars, use a formula above)",
  "preview_text": "Preview text that appears in inbox (under 90 chars, creates curiosity gap)",
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

async function repurposeContent(sourceContent, sourceFormat, targetFormat, system) {
  const formatInstructions = {
    linkedin: 'LinkedIn post: 800-1300 chars. One thought per line. Aggressive line breaks. Specific numbers. End with action steps, not CTA. Hook in first 2 lines.',
    x_single: 'Single tweet: under 280 chars. Most provocative, quotable, argument-starting line. Should make someone reply.',
    x_thread: 'Twitter thread: 5-7 tweets as JSON array. Each stands alone. Build narrative arc. Last tweet = CTA.',
    carousel: 'LinkedIn carousel: JSON array of 5-7 slide texts. Slide 1 = bold hook. One insight per slide. Last slide = CTA.',
    short_video: 'Short video script: 30-90 seconds. Open with hook. Include [PAUSE] markers. Conversational. One clear takeaway.',
    blog: 'Blog post: 1500-2500 words in Markdown. SEO-optimized. H2 headers. Specific advice. Short paragraphs.',
    youtube_script: 'YouTube script: 8-12 min read time. Hook (30s) → Problem (2min) → Content (6-8min) → Proof (2min) → CTA (30s). Include [PAUSE] markers.',
    newsletter: 'Newsletter email: subject line + body. Opening insight → framework → CTA. Conversational.',
    hot_take: 'Hot take: genuinely controversial opinion that would split a room 50/50. Specific. 1-3 sentences.',
    poll: 'LinkedIn poll: JSON with "question" (under 140 chars), "options" (array of 4), "post_text" (2-3 sentences). Controversial question people genuinely disagree on.'
  };

  const prompt = `Repurpose this ${sourceFormat} content into a ${targetFormat} piece.

SOURCE CONTENT (${sourceFormat}):
${typeof sourceContent === 'string' ? sourceContent.slice(0, 3000) : JSON.stringify(sourceContent).slice(0, 3000)}

TARGET FORMAT INSTRUCTIONS:
${formatInstructions[targetFormat] || targetFormat}

RULES:
- Keep the core insight and data points from the source
- Adapt the structure and tone for the target platform
- Add platform-specific hooks and CTAs
- Don't just copy-paste — genuinely reimagine for the platform
- Include specific numbers and examples from the source

Return ONLY the repurposed content as a string (for text formats) or JSON (for structured formats like carousel, thread, poll).`;

  const text = await callClaude({ model: HAIKU, system, prompt, maxTokens: 3000 });

  // For structured formats, try to parse as JSON
  if (['x_thread', 'carousel', 'poll'].includes(targetFormat)) {
    const parsed = parseJsonResponse(text);
    if (parsed) return parsed;
  }
  return text;
}

// --- AI-powered lead magnet generator (100+ styles, fully dynamic) ---

const LEAD_MAGNET_STYLES = `INTERACTIVE ASSESSMENTS (highest conversion — 25-50%):
1. Scorecard — 6-12 questions across pillars, score reveal with per-category breakdown
2. Quiz — Multiple choice personality/type quiz (e.g. "What kind of law firm are you?")
3. Maturity Model — Rate yourself 1-5 across dimensions, see your maturity level
4. Risk Assessment — Identify vulnerabilities, show risk score with red/yellow/green zones
5. Readiness Checker — "Are you ready for X?" diagnostic with go/no-go verdict
6. Gap Analysis — Current state vs ideal state comparison across metrics
7. Health Check — Traffic-light dashboard of key health indicators
8. Compliance Audit — Check/fail list against regulations or best practices
9. Competitive Benchmark — Rate yourself vs industry averages, see where you lag
10. Opportunity Finder — Answer questions to reveal hidden revenue opportunities

CALCULATORS (high conversion — 15-30%):
11. ROI Calculator — Input spend/metrics, see projected return
12. Cost Calculator — "What is [problem] actually costing you?" with dollar output
13. Savings Calculator — Show money saved by switching/improving
14. Revenue Gap Calculator — Current vs potential revenue with specific levers
15. Case Value Calculator — Estimate case values across practice areas
16. Budget Allocator — Input total budget, get recommended allocation across channels
17. Break-Even Calculator — How many cases/clients to cover marketing investment
18. Time-to-ROI Calculator — When will your investment pay off
19. Lifetime Value Calculator — Client LTV across different practice areas
20. Comparison Calculator — Side-by-side cost comparison of approaches

CHECKLISTS & AUDITS (solid conversion — 8-15%):
21. Launch Checklist — Step-by-step with checkboxes, progress bar
22. Weekly Review Checklist — Recurring tasks with completion tracking
23. Onboarding Checklist — New client/tool setup steps
24. Pre-Campaign Checklist — Everything to verify before going live
25. Quarterly Audit — Systematic review with pass/fail/needs-work
26. Website Audit — Page-by-page review criteria
27. SEO Audit Checklist — Technical + content + local SEO checks
28. Ad Account Audit — Campaign structure, targeting, creative review
29. Social Profile Audit — Completeness, optimization, content quality
30. Tech Stack Audit — Review tools and identify gaps/redundancies

FRAMEWORKS & BLUEPRINTS (good conversion — 5-10%):
31. 90-Day Blueprint — Phased action plan with milestones
32. Strategy Canvas — Fill-in visual framework (like Business Model Canvas)
33. Decision Matrix — Weighted scoring across options
34. Priority Matrix — Eisenhower/impact-effort grid with drag-and-drop
35. Playbook — Situation → action → expected result scenarios
36. Workflow Builder — Step-by-step process with decision branches
37. Goal-Setting Framework — SMART goals with tracking metrics
38. Campaign Planner — Channel × message × audience planning grid
39. Content Calendar Template — Pre-filled weekly/monthly schedule
40. Budget Template — Allocation worksheet with recommended splits

DATA & INSIGHTS (engagement — 5-8%):
41. Industry Benchmark Report — Key stats with your-firm comparison inputs
42. Salary/Pricing Guide — Interactive ranges by role/service/market
43. Market Map — Visual landscape of competitors/tools/approaches
44. Trend Report — Data visualizations with key takeaways
45. State-of-Industry Dashboard — Key metrics with interactive filters
46. Comparison Matrix — Feature-by-feature product/service comparison
47. Cost Breakdown — Where the money actually goes (interactive pie/bar)
48. Performance Dashboard — KPI tracker with input fields
49. Forecast Model — Input current metrics, project future growth
50. Heat Map — Visual intensity map across dimensions

SWIPE FILES & TEMPLATES (steady conversion — 4-8%):
51. Email Swipe File — Copy-paste email templates with fill-in blanks
52. Ad Copy Swipe File — Headline + body + CTA templates
53. Script Templates — Phone/video scripts with branching paths
54. Objection Handlers — Common objections with response scripts
55. Social Post Templates — Fill-in frameworks for each platform
56. Proposal Template — Section-by-section proposal builder
57. Follow-Up Sequences — Multi-touch outreach templates with timing
58. Testimonial Request Templates — Ask scripts that actually work
59. Partnership Pitch Templates — Outreach templates for referrals
60. Client Communication Templates — Onboarding, updates, reviews

EDUCATIONAL & TRAINING (trust-building):
61. Mini-Course — 3-5 lesson interactive module with quizzes
62. Masterclass Workbook — Follow-along worksheet for a training
63. Glossary/Dictionary — Interactive searchable term definitions
64. FAQ Builder — Common questions with expandable detailed answers
65. Case Study Collection — Filterable before/after stories
66. Myth vs Reality — Interactive flip cards (click to reveal truth)
67. Common Mistakes Guide — Expandable accordion with fixes
68. Expert Interview Highlights — Key quotes with context
69. Research Summary — Key findings with interactive data viz
70. Best Practices Guide — Do's and Don'ts with examples

PLANNING & STRATEGY TOOLS:
71. SWOT Analysis — Interactive 4-quadrant fill-in
72. Persona Builder — Fill in demographics, goals, pains, channels
73. Competitor Analysis — Side-by-side comparison builder
74. Value Proposition Canvas — Jobs, pains, gains mapping
75. Customer Journey Map — Stage-by-stage touchpoint planner
76. Content Strategy Planner — Pillar topics, formats, channels, cadence
77. Meeting Prep Sheet — Pre-call research template
78. Quarterly Planning Template — OKRs with progress tracking
79. Annual Marketing Plan — Month-by-month strategy grid
80. Hiring Scorecard — Candidate evaluation framework

VISUAL & INTERACTIVE (engagement):
81. Interactive Timeline — Milestones with expandable details
82. Process Flowchart — Visual step-by-step with decision points
83. Before/After Slider — Drag to compare two states
84. Progress Tracker — Multi-step journey with completion indicators
85. Interactive Infographic — Clickable sections with deep-dive data
86. Comparison Slider — Side-by-side with toggle switches
87. Interactive Org Chart — Roles with responsibilities on hover
88. Funnel Visualizer — Stage-by-stage metrics with input fields
89. Wheel/Radar Chart — Interactive skill/category radar visualization
90. Stack Ranker — Drag items to rank priorities

WORKSHEETS & EXERCISES:
91. Strategy Worksheet — Guided questions that build a strategy
92. Pricing Worksheet — Calculate optimal pricing with inputs
93. Goal Decomposition — Break big goals into actionable tasks
94. Client Intake Form — Professional intake questionnaire
95. Vendor Evaluation — Weighted scoring for choosing partners
96. Brand Voice Worksheet — Define tone, vocabulary, personality
97. USP Builder — Guided exercise to craft unique selling proposition
98. Ideal Client Profile — Demographics + psychographics builder
99. Content Idea Generator — Topic × angle × format combination tool
100. Action Plan Builder — Goal → obstacles → actions → deadlines`;

async function generateSmartLeadMagnet(contentText, contentFormat, triggerTitle, system) {
  const prompt = `You are building an interactive lead magnet web page for Mortar Metrics, a legal marketing agency.

CONTENT THIS LEAD MAGNET IS BASED ON:
Title: ${triggerTitle}
Format: ${contentFormat}
---
${(typeof contentText === 'string' ? contentText : JSON.stringify(contentText)).slice(0, 4000)}
---

YOUR TASK: Create a lead magnet that captures the VALUE from the above content in an interactive format that converts visitors into leads.

CHOOSE THE BEST STYLE from this list based on the content:
${LEAD_MAGNET_STYLES}

PICK the style that:
1. Best matches the content topic (calculators for money topics, scorecards for assessment topics, checklists for process topics, etc.)
2. Maximizes interactivity — the user should click, type, select, drag, or interact
3. Creates a "score reveal" or "result reveal" moment that makes the user want to share

GENERATE the complete HTML body and JavaScript for the lead magnet.

IMPORTANT CSS CLASSES AVAILABLE (already included in the page):
- .card — white card with shadow and rounded corners (padding: 32px)
- .card-header — card title (1.35rem, font-weight 600)
- .btn, .btn-primary — indigo button with rounded corners
- .btn-outline — outlined button
- .btn-sm — small button
- .progress-bar-container, .progress-bar-fill — animated progress bar
- .result-panel — gradient result section (add .visible to show)
- h1-h4 use Fraunces serif font, body uses Outfit sans-serif
- CSS vars: --primary (#4f46e5), --success (#059669), --warning (#d97706), --danger (#dc2626), --ink (#0a0a0a), --cream (#FDFCF9), --gray-100 through --gray-700, --radius (16px), --radius-sm (10px)

YOUR OUTPUT must be a JSON object with these fields:
{
  "style_number": 1-100 (which style you chose),
  "style_name": "name of the style",
  "title": "compelling title for the lead magnet",
  "subtitle": "one-line subtitle explaining the value",
  "badge_text": "short badge text like 'Free Scorecard' or 'ROI Calculator'",
  "html_body": "the complete HTML body content (cards, forms, interactive elements, results panels). Use the available CSS classes. Add custom <style> tags for any extra styles needed. Make it BEAUTIFUL and PROFESSIONAL.",
  "script": "the complete JavaScript for interactivity (no <script> tags, just the JS code). Must be self-contained, no external libraries. Use vanilla JS. Include input validation, result calculation, animations, and reveal logic."
}

DESIGN RULES:
- Mobile responsive (use flexbox/grid, relative units)
- Smooth animations (CSS transitions, scrollIntoView)
- Professional color palette using the CSS variables
- Clear visual hierarchy with plenty of whitespace
- Input validation and helpful error states
- Result reveal should feel rewarding (animation, color, bold numbers)
- Include 8-15 interactive elements minimum (inputs, selects, radio groups, sliders, checkboxes)
- All interactive elements must actually work and produce meaningful results
- Numbers and benchmarks should be realistic for the legal industry
- The result/output section should be hidden initially and revealed on calculation

Return ONLY the JSON object, no markdown fences.`;

  const text = await callClaude({ model: SONNET, system, prompt, maxTokens: 8000 });
  const parsed = parseJsonResponse(text);
  if (!parsed) throw new Error('Failed to parse smart lead magnet JSON');
  return parsed;
}

// --- AI Performance Prediction ---

async function predictContentPerformance(triggerTitle, triggerCategory, triggerRawContent, format, system) {
  const prompt = `You are a content performance analyst for a legal marketing agency.

Predict the performance of content generated from this trigger for the ${format} platform.

TRIGGER:
Title: ${triggerTitle}
Category: ${triggerCategory}
Content preview: ${(triggerRawContent || '').slice(0, 1500)}

TARGET FORMAT: ${format}

Analyze based on:
1. Topic relevance to law firm owners (the audience)
2. Hook potential — does this topic lend itself to strong opening hooks?
3. Specificity — are there concrete numbers, stories, or data points?
4. Emotional resonance — will this trigger frustration, surprise, or urgency?
5. Actionability — can the reader do something immediately?
6. Platform fit — how well does this topic work on ${format}?

Return a JSON object:
{
  "predicted_engagement_tier": "exceptional" | "high" | "moderate" | "low",
  "confidence": 0.0-1.0,
  "predicted_engagement_rate": "1.2%-3.5%",
  "strengths": ["strength 1", "strength 2"],
  "weaknesses": ["weakness 1"],
  "recommended_hook_type": "data_bomb" | "contrarian" | "story" | "math_problem" | "proof_first" | "framework",
  "recommended_angle": "Brief description of the best angle to take",
  "skip_recommendation": false,
  "skip_reason": null
}`;

  const text = await callClaude({ model: HAIKU, system, prompt, maxTokens: 800 });
  const parsed = parseJsonResponse(text);
  if (!parsed) throw new Error('Failed to parse performance prediction');
  return parsed;
}

// --- AI Tone Adjustment ---

async function adjustContentTone(content, currentFormat, targetTone, system) {
  const toneDescriptions = {
    aggressive: 'More direct, confrontational, urgent. Challenge the reader. Use stronger language. Shorter sentences. More exclamation-worthy claims.',
    educational: 'More instructive, patient, thorough. Explain the "why" behind each point. Add context. Still specific but less confrontational.',
    storytelling: 'More narrative-driven. Lead with a specific character/situation. Build tension. Resolve with insight. Make the reader FEEL the problem.',
    data_heavy: 'More numbers, stats, benchmarks. Every claim backed by data. Show the math. Comparison tables. Percentage improvements.',
    conversational: 'More casual, like texting a friend who runs a firm. Shorter sentences. Rhetorical questions OK. Humor where appropriate.',
    authoritative: 'More expert-positioning. Reference frameworks, industry knowledge, proprietary data. Position as the definitive take on this topic.'
  };

  const prompt = `Rewrite this ${currentFormat} content with a ${targetTone} tone.

CURRENT CONTENT:
${(typeof content === 'string' ? content : JSON.stringify(content)).slice(0, 3000)}

TARGET TONE: ${targetTone}
${toneDescriptions[targetTone] || 'Adjust the tone as described.'}

RULES:
- Keep ALL specific numbers, data points, and facts from the original
- Keep the same core message and insight
- Change the framing, hook style, sentence structure, and emotional register
- Maintain platform-appropriate length (LinkedIn: 800-1300 chars, Tweet: 280 chars max, Thread: 5-7 tweets)
- The result should feel like a completely different writer covered the same topic

Return ONLY the rewritten content (string for text formats, JSON array for threads/carousels).`;

  const text = await callClaude({ model: HAIKU, system, prompt, maxTokens: 2000 });
  // For structured formats, try JSON parse
  if (['x_thread', 'carousel'].includes(currentFormat)) {
    const parsed = parseJsonResponse(text);
    if (parsed) return parsed;
  }
  return text;
}

// --- AI Audience Variant ---

async function generateAudienceVariant(content, currentFormat, practiceArea, system) {
  const practiceAreaContext = {
    personal_injury: 'PI firms: high CPC ($150-300/click), intake speed critical, case values $50K-$500K+, contingency fee model, high volume needed',
    family_law: 'Family law: emotional clients, retainer-based ($3K-$15K), local SEO dominant, custody/divorce/adoption, trust-building critical',
    criminal_defense: 'Criminal defense: urgent need (arrested NOW), 24/7 availability critical, case values $5K-$25K, bail/DUI/felony',
    immigration: 'Immigration: document-heavy, trust-building, case values $3K-$10K, referral-heavy, visa/green card/asylum',
    estate_planning: 'Estate planning: consultative sell, age 55+ demographic, case values $2K-$5K, wills/trusts/probate',
    workers_comp: 'Workers comp: employer vs employee dynamics, case values $10K-$50K, medical documentation focus',
    bankruptcy: 'Bankruptcy: price-sensitive clients, case values $1.5K-$5K, Ch 7 vs Ch 13, high competition on Google Ads',
    real_estate: 'Real estate law: transaction-based, commercial vs residential, title issues, case values $2K-$10K'
  };

  const prompt = `Rewrite this ${currentFormat} content specifically for ${practiceArea.replace(/_/g, ' ')} attorneys.

CURRENT CONTENT:
${(typeof content === 'string' ? content : JSON.stringify(content)).slice(0, 3000)}

TARGET PRACTICE AREA: ${practiceArea.replace(/_/g, ' ')}
${practiceAreaContext[practiceArea] || ''}

RULES:
- Translate generic marketing advice into practice-area-specific advice
- Use practice-area-specific numbers, metrics, and benchmarks
- Reference tools and platforms relevant to this practice area
- Use practice-area-specific pain points and wins
- Keep the same structure and format as the original
- If the original mentions a specific practice area, translate the example to the target area
- Make it feel like it was WRITTEN for this audience, not adapted

Return ONLY the rewritten content (string for text formats, JSON array for threads/carousels).`;

  const text = await callClaude({ model: HAIKU, system, prompt, maxTokens: 2000 });
  if (['x_thread', 'carousel'].includes(currentFormat)) {
    const parsed = parseJsonResponse(text);
    if (parsed) return parsed;
  }
  return text;
}

// --- AI Batch Coherence Check ---

async function checkBatchCoherence(contentPieces, system) {
  const summaries = contentPieces.slice(0, 10).map((c, i) => {
    const liContent = c.formats?.linkedin?.content || '';
    const preview = typeof liContent === 'string' ? liContent.slice(0, 200) : '';
    return `${i + 1}. [${c.trigger_category || 'unknown'}] "${c.trigger_title}" — ${preview}...`;
  }).join('\n');

  const prompt = `You are a content strategist reviewing a batch of ${contentPieces.length} content pieces for a legal marketing agency's weekly publishing queue.

CONTENT BATCH:
${summaries}

Analyze for:
1. REDUNDANCY — Are any pieces covering essentially the same topic/angle? (list pairs)
2. NARRATIVE FLOW — If published Mon→Fri, is there a logical progression? Or is it random?
3. TOPIC BALANCE — Is there variety across: practice areas, content types (data vs story vs framework), emotional tones?
4. GAPS — What important topics/angles are missing from this batch?
5. SUGGESTED REORDER — What's the optimal publishing order for maximum engagement?

Return a JSON object:
{
  "coherence_score": 0-100,
  "redundant_pairs": [{"piece_a": 1, "piece_b": 3, "overlap": "Both cover Google Ads waste"}],
  "narrative_assessment": "brief assessment of flow",
  "topic_balance": {"good": ["topics well covered"], "missing": ["topics that should be added"]},
  "suggested_order": [3, 1, 5, 2, 4],
  "suggested_order_reasoning": "Why this order works better",
  "recommendations": ["Specific actionable recommendation 1", "Recommendation 2"],
  "pieces_to_consider_replacing": [{"index": 2, "reason": "Too similar to piece 1, suggest replacing with a case study"}]
}`;

  const text = await callClaude({ model: HAIKU, system, prompt, maxTokens: 1500 });
  const parsed = parseJsonResponse(text);
  if (!parsed) throw new Error('Failed to parse coherence check');
  return parsed;
}

module.exports = {
  callClaude, parseJsonResponse, generateSocialContent,
  generateBlogPost, generateYouTubeScript, generateLeadMagnet,
  generateNewsletter, generateCaseStudy, extractSpokes, remixContent,
  repurposeContent, generateSmartLeadMagnet,
  predictContentPerformance, adjustContentTone, generateAudienceVariant, checkBatchCoherence,
  HAIKU, SONNET
};
