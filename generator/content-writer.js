const { generateSocialContent, generateBlogPost, generateYouTubeScript } = require('../lib/claude');
const { generateId, now } = require('../lib/utils');

const BRAND_SYSTEM_PROMPT = `You are the content strategist for Mortar Metrics, a legal marketing agency that helps law firms get more signed cases through digital marketing.

VOICE & TONE:
- Direct, confident, zero fluff
- Specific numbers always ("We helped a 3-attorney PI firm go from 4 to 28 signed cases/month" not "we get results")
- Conversational but authoritative — smart friend who happens to be an expert
- Never salesy. Never "DM me." Pure value with soft CTAs
- Short sentences. Punchy. Line breaks between thoughts.
- Write like you talk. No corporate jargon.

KEY PROOF POINT:
We helped Mandall Law generate 30+ signed cases per month through our system.

AUDIENCE:
Law firm owners — personal injury, family law, criminal defense, employment law. They care about CASES and REVENUE. Not "leads," not "impressions," not "brand awareness." Cases. Revenue. Money.

HOOK FORMULAS TO USE:
- Contrarian: "Everyone says [X]. They're wrong."
- Specific Result: "We helped a [type] firm go from [A] to [B]."
- Story Open: "A law firm owner called me last [day]..."
- Framework: "I've audited [N] law firm websites. The top [X]% do these [N] things:"
- Data Drop: "We analyzed [N] campaigns. [X]% shared the same fatal flaw."

CONTENT RULES:
- Every post must deliver actionable value
- Use real-sounding (not made up) numbers and benchmarks
- Reference the legal industry specifically — not generic business advice
- LinkedIn: 800-1300 chars, hook first, line breaks between thoughts, no links
- Twitter: Punchy, opinionated, conversation-starting
- Video scripts: Natural spoken language, [PAUSE] for emphasis
- Blog posts: SEO-optimized, keyword in title + H2s, 1500-2500 words
- YouTube scripts: Hook → Problem → Content → Proof → CTA, 8-15 minutes`;

async function generateAllContent(trigger) {
  const contentId = generateId();

  console.log(`[writer] Generating social content for: ${trigger.title}`);

  let social = null;
  try {
    social = await generateSocialContent(trigger, BRAND_SYSTEM_PROMPT);
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
      }
    },
    image_prompt: social?.image_prompt || null,
    image_url: null,
    blog_keyword: social?.blog_keyword || null,
    youtube_topic: social?.youtube_topic || null,
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
    const blogContent = await generateBlogPost(trigger, content.blog_keyword, BRAND_SYSTEM_PROMPT);
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
    const scriptContent = await generateYouTubeScript(trigger, content.youtube_topic, BRAND_SYSTEM_PROMPT);
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

module.exports = { generateAllContent, generateBlog, generateYouTube, BRAND_SYSTEM_PROMPT };
