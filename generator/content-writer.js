const { generateSocialContent, generateBlogPost, generateYouTubeScript, generateLeadMagnet, generateNewsletter, generateCaseStudy } = require('../lib/claude');
const { generateId, now, readJSON } = require('../lib/utils');

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

KEY PROOF POINTS (rotate these across content):
- We helped Mandall Law generate 30+ signed cases per month through our system
- Metro PI Group saw 3.2x ROI in 90 days from Google Ads + landing page optimization
- Davis Family Law cut their cost per lead by 47% through SEO + content strategy
- Peak Defense Attorneys got a 200% increase in consultation bookings via speed-to-lead system
- We've generated over $12M in case revenue for our clients collectively
- Average client sees 2.8x ROI within 6 months
- Our speed-to-lead system responds in under 60 seconds
- We manage $2M+ in annual legal ad spend across 40+ firms
- 97% client retention rate

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

function buildSystemPromptWithMemory() {
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
      linkedin: {
        content: social?.linkedin_post || null,
        status: 'review',
        edited: false
      },
      x_single: {
        content: social?.x_single || null,
        status: 'review',
        edited: false
      },
      x_thread: {
        content: social?.x_thread || null,
        status: 'review',
        edited: false
      },
      short_video: {
        content: social?.short_video_script || null,
        status: 'review',
        edited: false
      },
      carousel: {
        content: social?.linkedin_carousel || null,
        status: 'review',
        edited: false
      },
      poll: {
        content: social?.linkedin_poll || null,
        status: 'review',
        edited: false
      },
      quote_cards: {
        content: social?.quote_cards || null,
        status: 'review',
        edited: false
      },
      stat_graphic: {
        content: social?.stat_graphic || null,
        status: 'review',
        edited: false
      },
      hot_take: {
        content: social?.hot_take || null,
        status: 'review',
        edited: false
      },
      before_after: {
        content: social?.before_after || null,
        status: 'review',
        edited: false
      },
      listicle: {
        content: social?.listicle_post || null,
        status: 'review',
        edited: false
      }
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
    content.formats.blog = {
      content: blogContent,
      status: 'review',
      edited: false
    };
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
    content.formats.youtube_script = {
      content: scriptContent,
      status: 'review',
      edited: false
    };
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
    content.formats.lead_magnet = { content: html, status: 'review', edited: false };
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
    content.formats.newsletter = {
      content: parsed.body || parsed,
      status: 'review',
      edited: false
    };
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
    content.formats.case_study = {
      content: caseStudy,
      status: 'review',
      edited: false
    };
  } catch (err) {
    console.error(`[writer] Case study generation failed: ${err.message}`);
  }

  return content;
}

module.exports = {
  generateAllContent, generateBlog, generateYouTube,
  generateLeadMagnetContent, generateNewsletterContent, generateCaseStudyContent,
  buildSystemPromptWithMemory, BRAND_SYSTEM_PROMPT
};
