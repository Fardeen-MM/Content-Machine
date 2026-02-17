const { generateSocialContent, generateBlogPost, generateYouTubeScript, generateLeadMagnet, generateNewsletter, generateCaseStudy, extractSpokes } = require('../lib/claude');
const { generateId, now, readJSON } = require('../lib/utils');

function makeSlot(content) {
  return { content, status: 'review', edited: false };
}

const BRAND_SYSTEM_PROMPT = `You are the content strategist for Mortar Metrics, a legal marketing agency that helps law firms get more signed cases through digital marketing.

VOICE & TONE:
- Direct, confident, zero fluff
- Specific numbers always ("We helped a 3-attorney PI firm go from 4 to 28 signed cases/month" not "we get results")
- Conversational but authoritative — smart friend who happens to be an expert
- Never salesy. Never "DM me." Pure value with soft CTAs
- Short sentences. Punchy. Line breaks between thoughts.
- Write like you talk. No corporate jargon.
- Use analogies from outside legal — sports, restaurants, military
- Admit what doesn't work — it builds credibility
- Reference real tools and platforms by name (CallRail, Clio, Google Ads, etc.)

KEY PROOF POINTS (use ONLY real case studies — never fabricate):
- Mandall Law (immigration firm): went from $4K/month ad budget to $92K/month revenue through our full-stack system. 30+ signed cases per month.
- Our speed-to-lead system responds in under 60 seconds
- If we only have one case study, reference it once and focus on frameworks/insights instead of stacking fake proof

AUDIENCE:
Law firm owners — personal injury, family law, criminal defense, employment law, workers' comp, estate planning, immigration. They care about CASES and REVENUE. Not "leads," not "impressions," not "brand awareness." Cases. Revenue. Money.

HOOK FORMULAS TO USE:
- Contrarian: "Everyone says [X]. They're wrong."
- Specific Result: "We helped a [type] firm go from [A] to [B]."
- Story Open: "A law firm owner called me last [day]..."
- Framework: "I've audited [N] law firm websites. The top [X]% do these [N] things:"
- Data Drop: "We analyzed [N] campaigns. [X]% shared the same fatal flaw."
- Myth Buster: "Your [X] isn't broken. Your [Y] is."
- Cost of Inaction: "[N] law firms tracked this metric. The ones who ignored it lost $[X]/month."
- Hot Take: "The best legal marketing strategy in 2026 isn't [obvious thing]. It's [surprising thing]."

CONTENT RULES:
- Every post must deliver actionable value
- Use real-sounding (not made up) numbers and benchmarks
- Reference the legal industry specifically — not generic business advice
- Include at least one specific, implementable takeaway
- LinkedIn: 800-1300 chars, hook first, line breaks between thoughts, no links
- Twitter: Punchy, opinionated, conversation-starting
- Video scripts: Natural spoken language, [PAUSE] for emphasis
- Blog posts: SEO-optimized, keyword in title + H2s, 1500-2500 words
- YouTube scripts: Hook → Problem → Content → Proof → CTA, 8-15 minutes
- Threads: 5-7 tweets, each can stand alone, build narrative arc`;

let _cachedPrompt = null;
let _cachedPromptAt = 0;
const PROMPT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function buildSystemPromptWithMemory() {
  if (_cachedPrompt && Date.now() - _cachedPromptAt < PROMPT_CACHE_TTL) {
    return _cachedPrompt;
  }
  let prompt = BRAND_SYSTEM_PROMPT;
  try {
    const memory = readJSON('memory.json');
    // Add style notes
    if (memory.style_notes?.length > 0) {
      prompt += '\n\nSTYLE PREFERENCES (from human feedback):\n';
      for (const note of memory.style_notes.slice(-10)) {
        prompt += `- ${note.note}\n`;
      }
    }
    // Add approved examples as reference (last 3 per format)
    const examples = memory.approved_examples || [];
    if (examples.length > 0) {
      prompt += '\n\nAPPROVED CONTENT EXAMPLES (match this style and quality):\n';
      const byFormat = {};
      for (const ex of examples) {
        if (!byFormat[ex.format]) byFormat[ex.format] = [];
        byFormat[ex.format].push(ex);
      }
      for (const [fmt, exs] of Object.entries(byFormat)) {
        const recent = exs.slice(-3);
        for (const ex of recent) {
          prompt += `\n[${fmt.toUpperCase()} EXAMPLE — "${ex.trigger_title}"]:\n${ex.content.slice(0, 500)}\n`;
        }
      }
    }
  } catch (err) {
    console.log('[writer] No memory loaded:', err.message);
  }
  _cachedPrompt = prompt;
  _cachedPromptAt = Date.now();
  return prompt;
}

async function generateAllContent(trigger) {
  const contentId = generateId();
  const systemPrompt = buildSystemPromptWithMemory();

  console.log(`[writer] Generating social content for: ${trigger.title}`);

  let social = null;
  try {
    social = await generateSocialContent(trigger, systemPrompt);
  } catch (err) {
    console.error(`[writer] Social generation failed: ${err.message}`);
    social = null;
  }

  const content = {
    id: contentId,
    trigger_id: trigger.id,
    trigger_title: trigger.title,
    trigger_source: trigger.source,
    trigger_category: trigger.category,
    trigger_url: trigger.url,
    generated_at: now(),
    status: 'review',
    formats: {
      linkedin: makeSlot(social?.linkedin_post || null),
      x_single: makeSlot(social?.x_single || null),
      x_thread: makeSlot(social?.x_thread || null),
      short_video: makeSlot(social?.short_video_script || null),
      carousel: makeSlot(social?.linkedin_carousel || null),
      poll: makeSlot(social?.linkedin_poll || null),
      quote_cards: makeSlot(social?.quote_cards || null),
      stat_graphic: makeSlot(social?.stat_graphic || null),
      hot_take: makeSlot(social?.hot_take || null),
      before_after: makeSlot(social?.before_after || null),
      listicle: makeSlot(social?.listicle_post || null),
    },
    image_prompt: social?.image_prompt || null,
    image_url: null,
    blog_keyword: social?.blog_keyword || null,
    youtube_topic: social?.youtube_topic || null,
    lead_magnet_topic: social?.lead_magnet_topic || null,
    blog_post: null,
    youtube_script: null,
    notes: ''
  };

  return content;
}

async function generateBlog(content, trigger) {
  if (!content.blog_keyword) {
    console.log('[writer] No blog keyword, skipping blog generation');
    return content;
  }

  console.log(`[writer] Generating blog post for keyword: ${content.blog_keyword}`);

  try {
    const blogContent = await generateBlogPost(trigger, content.blog_keyword, buildSystemPromptWithMemory());
    content.formats.blog = makeSlot(blogContent);
    content.blog_post = blogContent;
  } catch (err) {
    console.error(`[writer] Blog generation failed: ${err.message}`);
  }

  return content;
}

async function generateYouTube(content, trigger) {
  if (!content.youtube_topic) {
    console.log('[writer] No YouTube topic, skipping script generation');
    return content;
  }

  console.log(`[writer] Generating YouTube script for: ${content.youtube_topic}`);

  try {
    const scriptContent = await generateYouTubeScript(trigger, content.youtube_topic, buildSystemPromptWithMemory());
    content.formats.youtube_script = makeSlot(scriptContent);
    content.youtube_script = scriptContent;
  } catch (err) {
    console.error(`[writer] YouTube script generation failed: ${err.message}`);
  }

  return content;
}

async function generateLeadMagnetContent(content, trigger) {
  if (!content.lead_magnet_topic) {
    console.log('[writer] No lead magnet topic, skipping generation');
    return content;
  }

  console.log(`[writer] Generating lead magnet for: ${content.lead_magnet_topic}`);

  try {
    const { renderLeadMagnetHTML } = require('./lead-magnet-renderer');
    const triggerWithTopic = { ...trigger, lead_magnet_topic: content.lead_magnet_topic };
    const parsed = await generateLeadMagnet(triggerWithTopic, buildSystemPromptWithMemory());
    const html = renderLeadMagnetHTML(parsed);
    content.formats.lead_magnet = makeSlot(html);
    content.lead_magnet_meta = { title: parsed.title, type: parsed.type, subtitle: parsed.subtitle };
  } catch (err) {
    console.error(`[writer] Lead magnet generation failed: ${err.message}`);
  }

  return content;
}

async function generateNewsletterContent(content, trigger) {
  console.log(`[writer] Generating newsletter for: ${trigger.title}`);

  try {
    const parsed = await generateNewsletter(trigger, buildSystemPromptWithMemory());
    content.formats.newsletter = makeSlot(parsed.body || parsed);
    content.newsletter_meta = {
      subject_line: parsed.subject_line || '',
      preview_text: parsed.preview_text || ''
    };
  } catch (err) {
    console.error(`[writer] Newsletter generation failed: ${err.message}`);
  }

  return content;
}

async function generateCaseStudyContent(content, trigger) {
  console.log(`[writer] Generating case study for: ${trigger.title}`);

  try {
    const caseStudy = await generateCaseStudy(trigger, buildSystemPromptWithMemory());
    content.formats.case_study = makeSlot(caseStudy);
  } catch (err) {
    console.error(`[writer] Case study generation failed: ${err.message}`);
  }

  return content;
}

async function generatePillarWithSpokes(trigger, pillarType = 'blog') {
  const contentId = generateId();
  const systemPrompt = buildSystemPromptWithMemory();

  console.log(`[writer] Generating pillar-to-spoke cascade (${pillarType}) for: ${trigger.title}`);

  // Step 1: Generate the pillar piece first
  let pillarContent = null;
  let pillarMeta = {};

  try {
    if (pillarType === 'blog') {
      const keyword = trigger.title.split(/[:\-|]/).shift().trim().slice(0, 60);
      pillarContent = await generateBlogPost(trigger, keyword, systemPrompt);
      pillarMeta = { blog_keyword: keyword };
    } else if (pillarType === 'youtube') {
      pillarContent = await generateYouTubeScript(trigger, trigger.title, systemPrompt);
      pillarMeta = { youtube_topic: trigger.title };
    } else if (pillarType === 'newsletter') {
      const nlResult = await generateNewsletter(trigger, systemPrompt);
      pillarContent = nlResult.body || nlResult;
      pillarMeta = { newsletter_meta: { subject_line: nlResult.subject_line || '', preview_text: nlResult.preview_text || '' } };
    }
  } catch (err) {
    console.error(`[writer] Pillar generation failed: ${err.message}`);
  }

  if (!pillarContent) {
    console.log('[writer] Pillar failed, falling back to standard generation');
    return generateAllContent(trigger);
  }

  console.log(`[writer] Pillar generated (${typeof pillarContent === 'string' ? pillarContent.length : 0} chars). Extracting spokes...`);

  // Step 2: Extract social spokes FROM the pillar
  let spokes = null;
  try {
    spokes = await extractSpokes(pillarContent, pillarType, trigger, systemPrompt);
  } catch (err) {
    console.error(`[writer] Spoke extraction failed: ${err.message}, falling back to standard social`);
    try {
      spokes = await generateSocialContent(trigger, systemPrompt);
    } catch (err2) {
      console.error(`[writer] Fallback social also failed: ${err2.message}`);
    }
  }

  // Step 3: Build content object with pillar + spokes
  const content = {
    id: contentId,
    trigger_id: trigger.id,
    trigger_title: trigger.title,
    trigger_source: trigger.source,
    trigger_category: trigger.category,
    trigger_url: trigger.url,
    generated_at: now(),
    status: 'review',
    generation_mode: 'pillar_spoke',
    pillar_type: pillarType,
    formats: {
      linkedin: makeSlot(spokes?.linkedin_post || null),
      x_single: makeSlot(spokes?.x_single || null),
      x_thread: makeSlot(spokes?.x_thread || null),
      short_video: makeSlot(spokes?.short_video_script || null),
      carousel: makeSlot(spokes?.linkedin_carousel || null),
      poll: makeSlot(spokes?.linkedin_poll || null),
      quote_cards: makeSlot(spokes?.quote_cards || null),
      stat_graphic: makeSlot(spokes?.stat_graphic || null),
      hot_take: makeSlot(spokes?.hot_take || null),
      before_after: makeSlot(spokes?.before_after || null),
      listicle: makeSlot(spokes?.listicle_post || null),
    },
    image_prompt: spokes?.image_prompt || null,
    image_url: null,
    blog_keyword: pillarMeta.blog_keyword || spokes?.blog_keyword || null,
    youtube_topic: pillarMeta.youtube_topic || spokes?.youtube_topic || null,
    lead_magnet_topic: spokes?.lead_magnet_topic || null,
    email_snippet: spokes?.email_snippet || null,
    blog_post: null,
    youtube_script: null,
    notes: ''
  };

  // Add pillar content to the appropriate format slot
  if (pillarType === 'blog') {
    content.formats.blog = makeSlot(pillarContent);
    content.blog_post = pillarContent;
    content.blog_keyword = pillarMeta.blog_keyword;
  } else if (pillarType === 'youtube') {
    content.formats.youtube_script = makeSlot(pillarContent);
    content.youtube_script = pillarContent;
    content.youtube_topic = pillarMeta.youtube_topic;
  } else if (pillarType === 'newsletter') {
    content.formats.newsletter = makeSlot(pillarContent);
    if (pillarMeta.newsletter_meta) content.newsletter_meta = pillarMeta.newsletter_meta;
  }

  return content;
}

module.exports = {
  generateAllContent, generateBlog, generateYouTube,
  generateLeadMagnetContent, generateNewsletterContent, generateCaseStudyContent,
  generatePillarWithSpokes, buildSystemPromptWithMemory, BRAND_SYSTEM_PROMPT
};
