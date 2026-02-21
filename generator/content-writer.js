const { generateSocialContent, generateBlogPost, generateYouTubeScript, generateLeadMagnet, generateNewsletter, generateCaseStudy, extractSpokes } = require('../lib/claude');
const { generateId, now, readJSON } = require('../lib/utils');
const db = require('../lib/db');

function makeSlot(content) {
  return { content, status: 'review', edited: false };
}

const BRAND_SYSTEM_PROMPT = `You are the content strategist for Mortar Metrics, a legal marketing agency that helps law firms get more signed cases through digital marketing.

CORE IDENTITY:
Mortar Metrics. "More signed cases. More revenue. Less guesswork."
We are operators — not gurus, not thought leaders, not agencies that "do marketing." We build systems that generate signed cases for law firms. Everything we write should sound like it came from someone who has been inside the Google Ads account at 11pm fixing a campaign, not someone reading a marketing textbook.

VOICE — THE SINGLE MOST IMPORTANT THING:
Write like a sharp friend who runs a successful agency — not a content creator. The voice is:
- A frustrated operator venting to peers (NOT a teacher lecturing students)
- Someone who says "here's what we found" not "here's what you should know"
- Blunt. Specific. Sometimes a little angry about how bad the industry is.
- Uses "I" and "we" — this is a real person, not a brand account

DO THIS:
- Lead with a specific failure, mistake, or surprising data point — EVERY time
- Use exact numbers: "$4,183/month wasted" not "thousands wasted"
- Tell micro-stories: "A PI firm installed call tracking. The data was brutal. 90 calls. 34 went to voicemail..."
- Show the math: "47 of 90 calls unanswered = 52% waste × $89/call = $4,183/month"
- Admit failures and limitations: "We tried X. It didn't work. Here's why."
- End with 3-5 concrete actions someone can do TODAY
- Reference real tools by name (CallRail, Clio, Google Ads, Lawmatics, etc.)
- Use line breaks aggressively on social — one thought per line
- Write hooks that create an "information gap" — the reader MUST keep reading

NEVER DO THIS:
- Never start with "[Company] just dropped/released/published their data..."
- Never say "should keep you up at night" or "game-changer" or "deep dive" or "here's the thing"
- Never use: synergy, leverage, utilize, innovative, unlock, empower, cutting-edge
- Never write a post that's just a list of stats with no narrative connecting them
- Never give generic advice ("track your ROI") without showing HOW and the cost of NOT doing it
- Never fabricate firm names, case studies, or data points
- Never start LinkedIn posts with a question ("Are you...?" "Did you know...?")
- Never end with "DM me" or "Link in bio" or aggressive CTAs
- Never summarize someone else's report — add YOUR take, YOUR data, YOUR opinion

THE STORYTELLING FORMULA (use this structure for every piece):
1. SPECIFIC FAILURE or SURPRISING DATA — open with something concrete that happened
2. FINANCIAL IMPACT — translate the problem into dollars lost or cases missed
3. THE FRAMEWORK — here's what actually works (3-5 steps)
4. PROOF — one real example where this worked (Mandall Law or general pattern)
5. ACTION STEPS — what to do Monday morning

GOLDEN EXAMPLE (this is what great content looks like):
---
A PI firm installed call tracking last month.

The data is brutal.

90 calls from Google Ads.
34 went to voicemail.
22 rang for 30+ seconds — only 9 waited.

That's 47 out of 90 calls — 52% — either unanswered or abandoned.

At $89 per call, they're wasting $4,183 every month on calls nobody picks up.

The fix isn't more ad budget. It's:

1. Answer in under 10 seconds (not 30)
2. Add an overflow service for after-hours ($200/mo)
3. Track ring time, not just "calls received"

Speed to lead isn't a buzzword. It's the difference between a $4K month and a $40K month.
---
This works because: specific situation → exact numbers → clear math → simple fix → punch ending.

BAD EXAMPLE (do NOT write like this):
---
Clio just dropped their 2025 Legal Trends data.

The stat that should keep every law firm owner up at night:

67% of firms don't track marketing ROI.

Here's why that matters...
---
This fails because: opens with someone else's report, uses hyperbolic filler ("keep you up at night"), no story, no math, no specific failure.

KEY PROOF POINTS (use ONLY these — never fabricate):
- Mandall Law (immigration): $4K/month ad budget → $92K/month revenue. 30+ signed cases/month. Full-stack system.
- Speed-to-lead system: under 60 second response time
- General framework insights from auditing law firm campaigns (don't invent firm names)
- If you need a case study and Mandall doesn't fit, describe a general pattern: "a 3-attorney PI firm we worked with" (no fake name)

AUDIENCE-SPECIFIC ANGLES (tailor content to these practice areas):
- Personal Injury: high CPC ($150-300/click), intake speed critical, case values $50K-$500K+
- Family Law: emotional clients, retainer-based, local SEO dominant, case values $3K-$15K
- Criminal Defense: urgent need (arrested NOW), 24/7 availability critical, case values $5K-$25K
- Immigration: document-heavy, trust-building, case values $3K-$10K, referral-heavy
- Workers' Comp: employer vs employee dynamics, case values $10K-$50K
- Estate Planning: consultative sell, age 55+ demographic, case values $2K-$5K

CONTENT RULES:
- LinkedIn: 800-1300 chars, hook first, line breaks between every thought, no external links, end with insight not CTA
- Twitter/X: Punchy, opinionated, designed to start arguments in replies. 280 chars max for singles.
- Threads: 5-7 tweets, each can stand alone, build narrative arc, end with actionable takeaway
- Video scripts: Natural spoken language, [PAUSE] markers, conversational not scripted-sounding
- Blog posts: SEO-optimized, keyword in title + H2s, 1500-2500 words, every section earns the next
- YouTube scripts: Hook (30s) → Problem (2min) → Content (6-8min) → Proof (2min) → CTA (30s)
- Carousels: Slide 1 = bold hook (stop the scroll), slides 2-6 = one insight per slide, slide 7 = CTA
- Polls: Controversial question that people WANT to answer, not obvious/generic

HOOK FORMULAS (rotate between these — use Hormozi's 7-element rule: every hook uses 2+ of Recency, Proximity, Celebrity, Conflict, Unusual, Ongoing, Significance):

TIER 1 — HIGHEST PERFORMING:
1. Contrarian: "Most law firms believe [common belief]. Here's why they're wrong." / "Unpopular opinion: [bold claim]."
2. Data Bomb: "I analyzed [number] [things]. [percentage]% had the same mistake." / "We audited 47 law firm ad accounts. 73% had the same fatal mistake."
3. Story/Failure: "A PI firm installed call tracking. The data was brutal." / "[Time] ago, I [made mistake]. It cost [amount]."
4. Math Problem: "Your PI firm gets 90 calls/month from ads. 47 go unanswered. That's $4,183/month in the trash."
5. Proof-First: "We took a [firm type] from [bad] to [good] in [timeframe]." / "127 signed cases in one quarter. Here's exactly how:"
6. Framework Reveal: "The [Name] Framework: [number] steps to [outcome]." / "The most successful firms I work with all use this:"

TIER 2 — STRONG ENGAGEMENT:
7. Confession: "I used to tell every law firm to spend $5K/month on Google Ads. I was wrong."
8. Before/After: "March: 4 signed cases. September: 28. Same ad budget. Here's what we changed."
9. Curiosity Gap: "Nobody tells law firm owners this about their marketing spend..." / "It took me 4 years to realize [realization]."
10. Direct Address: "If you're a managing partner spending $10K+/mo on marketing, this will save you 40% of your budget."
11. Myth Buster: "Your website isn't broken. Your intake process is."
12. Cost of Inaction: "Every hour your phone goes unanswered after 5pm, you lose $420 in potential revenue."

TIER 3 — ENGAGEMENT DRIVERS:
13. Them vs Me: "Them: 'Spend more on Google Ads.' Me: *fixes intake process, doubles revenue*."
14. Question (X/Twitter only): "Why do some law firms get 50 cases/month while others can't get 5?"
15. Hidden Economics: "The hidden economics of law firm marketing:"

LINKEDIN POST FRAMEWORKS (use these structures):
- Unpopular Opinion: contrarian claim → evidence → reframed question → engagement ask
- Mistake I Made: mistake → cost → consequences → lesson → what to do instead
- 3-Step Framework: "[Outcome] comes down to 3 things. Most skip Step [X]."
- Before/After Transformation: client problem → 3 specific changes → metrics → counterintuitive lesson
- I Analyzed X: "I analyzed [number] [things] and found something surprising:" → data → what winners do
- Mini Case Study: client quote → bad metrics → 3 tactics → good metrics → "No magic. Just [principle]."

MEETING-BOOKING STRATEGY (every piece should guide toward a call):
- Give away the recipe, sell the implementation (Hormozi model)
- Content shows WHAT and WHY → the call is about HOW for THEIR specific firm
- Use comment-keyword CTAs: "Comment AUDIT and I'll send you the checklist"
- Value-first DM sequence: share resource → engage 2-3x → suggest 15-min call
- Scorecard/quiz CTAs convert at 40%+ (vs 10-20% for PDFs)
- Frame calls as diagnostics, not pitches: "15-min strategy session, no pitch, just data"

VALUE EQUATION (apply to every hook — Hormozi):
Value = (Dream Outcome x Perceived Likelihood) / (Time Delay x Effort & Sacrifice)
- Maximize: vivid outcome + proof/specificity
- Minimize: compress timeline + remove barriers`;

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
    // Add approved examples as reference (last 3 per format, prefer edited ones)
    const examples = memory.approved_examples || [];
    if (examples.length > 0) {
      prompt += '\n\nAPPROVED CONTENT EXAMPLES (match this style and quality — these were human-approved):\n';
      const byFormat = {};
      for (const ex of examples) {
        if (!byFormat[ex.format]) byFormat[ex.format] = [];
        byFormat[ex.format].push(ex);
      }
      for (const [fmt, exs] of Object.entries(byFormat)) {
        // Prefer edited examples — they show what the human wanted
        const edited = exs.filter(e => e.was_edited);
        const recent = edited.length >= 2 ? edited.slice(-2) : exs.slice(-3);
        for (const ex of recent) {
          prompt += `\n[${fmt.toUpperCase()} — "${ex.trigger_title}"${ex.was_edited ? ' (HUMAN-EDITED — this is the preferred version)' : ''}]:\n${ex.content.slice(0, 600)}\n`;
        }
      }
    }
    // Add rejection patterns — things to AVOID
    const rejections = memory.rejection_patterns || [];
    const rejectionStats = memory.rejection_stats || {};
    if (rejections.length > 0) {
      // Show top rejection reasons by frequency
      const reasonCounts = {};
      for (const r of rejections) {
        const key = r.reason || 'other';
        reasonCounts[key] = (reasonCounts[key] || 0) + 1;
      }
      const topReasons = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1]);
      if (topReasons.length > 0) {
        const reasonLabels = {
          too_generic: 'Too generic/vague (needs specific numbers and examples)',
          wrong_tone: 'Wrong tone (too formal, too salesy, or off-brand)',
          missing_numbers: 'Missing concrete numbers and data',
          bad_hook: 'Weak hook (not compelling enough to stop scrolling)',
          off_brand: 'Off-brand (doesn\'t sound like Mortar Metrics)',
          other: 'Other quality issues'
        };
        prompt += '\n\nCOMMON REJECTION REASONS (avoid these patterns):\n';
        for (const [reason, count] of topReasons.slice(0, 4)) {
          prompt += `- ${reasonLabels[reason] || reason} (rejected ${count}x)\n`;
        }
      }
      // Show recent rejection examples with suggestions
      const withSuggestions = rejections.filter(r => r.suggestion).slice(-3);
      if (withSuggestions.length > 0) {
        prompt += '\nSPECIFIC FEEDBACK FROM REJECTIONS:\n';
        for (const r of withSuggestions) {
          prompt += `- [${r.format}] ${r.suggestion}\n`;
        }
      }
      // Show a few recent rejection previews
      const recent = rejections.slice(-3);
      prompt += '\nREJECTED CONTENT — DO NOT write like these:\n';
      for (const r of recent) {
        prompt += `- [${r.format}] "${r.content_preview.slice(0, 120)}..."${r.rejection_note ? ` (${r.rejection_note})` : ''}\n`;
      }
    }
  } catch (err) {
    console.log('[writer] No memory loaded:', err.message);
  }
  // Add client patterns from real sales calls
  try {
    db.initDb();
    const patterns = db.getPatterns({ limit: 15 }).filter(p => p.frequency >= 2);
    if (patterns.length > 0) {
      prompt += '\n\nCLIENT PATTERNS (from real sales calls — prioritize content addressing these):\n';
      for (const p of patterns) {
        prompt += `- [${p.type}] "${p.description}" (seen ${p.frequency}x)\n`;
      }
    }
  } catch (err) {
    // Patterns not available — skip
  }
  // Add performance insights from published content
  try {
    const perfData = readJSON('performance.json');
    if (perfData.length >= 3) {
      const byFormat = {};
      for (const p of perfData) {
        if (!byFormat[p.format]) byFormat[p.format] = { total: 0, engagement: 0, impressions: 0, leads: 0 };
        byFormat[p.format].total++;
        byFormat[p.format].engagement += (p.engagement || 0);
        byFormat[p.format].impressions += (p.impressions || 0);
        byFormat[p.format].leads += (p.leads || 0);
      }
      const ranked = Object.entries(byFormat)
        .filter(([, v]) => v.total >= 2 && v.impressions > 0)
        .map(([fmt, v]) => ({ fmt, rate: ((v.engagement / v.impressions) * 100).toFixed(1), leads: v.leads, total: v.total }))
        .sort((a, b) => parseFloat(b.rate) - parseFloat(a.rate));
      if (ranked.length >= 2) {
        prompt += '\n\nPERFORMANCE DATA (from published content — prioritize what works):\n';
        prompt += 'Top performing formats:\n';
        for (const r of ranked.slice(0, 5)) {
          prompt += `- ${r.fmt}: ${r.rate}% engagement rate (${r.total} posts, ${r.leads} leads)\n`;
        }
        if (ranked.length > 3) {
          prompt += 'Lower performing formats (give less priority):\n';
          for (const r of ranked.slice(-2)) {
            prompt += `- ${r.fmt}: ${r.rate}% engagement rate\n`;
          }
        }
      }
    }
  } catch (err) {
    // Performance data not available — skip
  }
  // Add platform playbook context
  try {
    const playbooks = readJSON('playbooks.json');
    if (playbooks.linkedin || playbooks.x_single) {
      prompt += '\n\nPLATFORM PLAYBOOKS (research-backed best practices for each platform):\n';
      if (playbooks.linkedin) {
        const li = playbooks.linkedin;
        prompt += `\nLINKEDIN — Goal: ${li.goal}\n`;
        prompt += `- Best formats: ${li.algorithm.best_formats.slice(0, 3).join(', ')}\n`;
        prompt += `- Posting: ${li.algorithm.posting_times.slice(0, 2).join(', ')}\n`;
        prompt += `- Hook rules: ${li.content_rules.post_structure.slice(0, 3).join('; ')}\n`;
        prompt += `- Meeting conversion: ${li.content_rules.meeting_conversion.slice(0, 2).join('; ')}\n`;
      }
      if (playbooks.x_single) {
        const x = playbooks.x_single;
        prompt += `\nX/TWITTER — Goal: ${x.goal}\n`;
        prompt += `- Algorithm: ${x.algorithm.key_signals.slice(0, 2).join('; ')}\n`;
        prompt += `- Meeting conversion: ${x.content_rules.meeting_conversion.slice(0, 2).join('; ')}\n`;
      }
      if (playbooks.youtube) {
        const yt = playbooks.youtube;
        prompt += `\nYOUTUBE — Goal: ${yt.goal}\n`;
        prompt += `- Script structure: ${yt.content_rules.script_structure.slice(0, 3).join(' → ')}\n`;
        prompt += `- Title formulas: ${(yt.content_rules.title_formulas || []).slice(0, 3).join('; ')}\n`;
        prompt += `- Meeting conversion: ${yt.content_rules.meeting_conversion.slice(0, 2).join('; ')}\n`;
      }
      if (playbooks.short_video) {
        const sv = playbooks.short_video;
        prompt += `\nSHORT VIDEO — Goal: ${sv.goal}\n`;
        prompt += `- 30s structure: ${sv.content_rules.script_30s}\n`;
        prompt += `- Hook rule: ${sv.content_rules.hook_formula[0]}\n`;
      }
      if (playbooks.scorecard_funnel) {
        const sc = playbooks.scorecard_funnel;
        prompt += `\nSCORECARD FUNNEL — ${sc.conversion_rate}\n`;
        prompt += `- Pillars: ${sc.framework.pillars_for_legal.slice(0, 4).join(', ')}\n`;
        prompt += `- ${sc.framework.priestley_7_11_4}\n`;
      }
    }
  } catch (err) {
    // Playbooks not available — skip
  }
  // Add CTA library for meeting-focused calls to action
  try {
    const ctas = readJSON('cta-library.json');
    if (ctas.linkedin || ctas.x_single) {
      prompt += '\n\nCTA LIBRARY (use these meeting-booking CTAs — rotate, don\'t repeat):\n';
      if (ctas.linkedin?.soft) {
        const randomCta = ctas.linkedin.soft[Math.floor(Math.random() * ctas.linkedin.soft.length)];
        prompt += `- LinkedIn soft CTA example: "${randomCta}"\n`;
      }
      if (ctas.linkedin?.comment_keyword) {
        const randomCta = ctas.linkedin.comment_keyword[Math.floor(Math.random() * ctas.linkedin.comment_keyword.length)];
        prompt += `- Comment-keyword CTA: "${randomCta}"\n`;
      }
      if (ctas.linkedin?.value_first) {
        const randomCta = ctas.linkedin.value_first[Math.floor(Math.random() * ctas.linkedin.value_first.length)];
        prompt += `- LinkedIn value-first CTA example: "${randomCta}"\n`;
      }
      if (ctas.x_single?.soft) {
        const randomCta = ctas.x_single.soft[Math.floor(Math.random() * ctas.x_single.soft.length)];
        prompt += `- X soft CTA example: "${randomCta}"\n`;
      }
      if (ctas.meeting_hooks) {
        const hookKeys = Object.keys(ctas.meeting_hooks);
        const randomKey = hookKeys[Math.floor(Math.random() * hookKeys.length)];
        prompt += `- Meeting hook: "${ctas.meeting_hooks[randomKey]}"\n`;
      }
      prompt += '- IMPORTANT: Weave CTAs naturally. Prefer comment-keyword patterns ("Comment AUDIT and I\'ll send it"). Don\'t end every post with "DM me." Rotate between soft, value-first, and engagement CTAs.\n';
    }
  } catch (err) {
    // CTA library not available — skip
  }
  // Add hook templates from hook library for variety
  try {
    const hooks = readJSON('hook-library.json');
    if (hooks.linkedin) {
      prompt += '\n\nHOOK TEMPLATES (use these as starting points — fill in with topic-specific content):\n';
      // Pick 3 random hook categories and show 1 example each
      const categories = Object.keys(hooks.linkedin);
      const shuffled = categories.sort(() => Math.random() - 0.5).slice(0, 3);
      for (const cat of shuffled) {
        const templates = hooks.linkedin[cat];
        if (templates?.length > 0) {
          const pick = templates[Math.floor(Math.random() * templates.length)];
          prompt += `- [${cat}] "${pick.example}"\n`;
        }
      }
    }
  } catch (err) {
    // Hook library not available — skip
  }
  _cachedPrompt = prompt;
  _cachedPromptAt = Date.now();
  return prompt;
}

async function generateAllContent(trigger, options = {}) {
  const contentId = generateId();
  let systemPrompt = buildSystemPromptWithMemory();

  // Apply series template if provided
  if (options.seriesTemplate) {
    const st = options.seriesTemplate;
    systemPrompt += `\n\nSERIES CONTEXT — "${st.name}":\nThis content is part of the "${st.name}" recurring series (${st.day}).\nTemplate structure:\n${st.template_prompt}\nPillar: ${st.pillar}\nPreferred formats: ${st.formats.join(', ')}\nUse this template structure to shape the content. Follow the format guidelines but keep the core Mortar Metrics voice.`;
  }

  console.log(`[writer] Generating social content for: ${trigger.title}${options.seriesTemplate ? ` (series: ${options.seriesTemplate.name})` : ''}`);

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
    hook_variants: {
      linkedin: social?.linkedin_hooks || [],
      x: social?.x_hooks || []
    },
    image_prompt: social?.image_prompt || null,
    image_url: null,
    blog_keyword: social?.blog_keyword || null,
    youtube_topic: social?.youtube_topic || null,
    lead_magnet_topic: social?.lead_magnet_topic || null,
    blog_post: null,
    youtube_script: null,
    quality_score: null,
    notes: ''
  };

  // Auto quality score
  content.quality_score = scoreContentQuality(content);

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

// Quality scoring — flags weak content before it hits review
function scoreContentQuality(content) {
  let score = 0;
  let max = 0;
  const flags = [];

  const li = content.formats?.linkedin?.content || '';
  if (li) {
    max += 30;
    // Has specific numbers ($, %, /month, cases, x)
    const nums = (li.match(/\$[\d,]+|\d+%|\d+x|\d+\/month|\d+ cases|\d+ calls|\d+ leads/g) || []).length;
    if (nums >= 3) { score += 10; } else if (nums >= 1) { score += 5; } else { flags.push('linkedin: no specific numbers'); }
    // Has line breaks (story format)
    const lineBreaks = (li.match(/\n\n/g) || []).length;
    if (lineBreaks >= 3) { score += 5; } else { flags.push('linkedin: needs more line breaks'); }
    // Length check
    if (li.length >= 600 && li.length <= 1400) { score += 5; } else { flags.push(`linkedin: ${li.length} chars (target 800-1300)`); }
    // Doesn't start with a question
    if (!li.trim().startsWith('Are ') && !li.trim().startsWith('Did ') && !li.trim().startsWith('Do ') && !li.trim().startsWith('Have ')) { score += 5; } else { flags.push('linkedin: opens with question (weak hook)'); }
    // Has action steps (numbered list or bullet pattern)
    if (/\d\.\s|step \d|first|second|third/i.test(li)) { score += 5; } else { flags.push('linkedin: no action steps'); }
  }

  const tweet = content.formats?.x_single?.content || '';
  if (tweet) {
    max += 15;
    if (tweet.length <= 280) { score += 5; } else { flags.push(`tweet: ${tweet.length} chars (max 280)`); }
    if (/\d/.test(tweet)) { score += 5; } else { flags.push('tweet: no numbers'); }
    // Provocative/opinion indicator
    if (/wrong|myth|actually|stop|never|isn't|won't|doesn't/i.test(tweet)) { score += 5; } else { flags.push('tweet: could be more opinionated'); }
  }

  const thread = content.formats?.x_thread?.content;
  if (Array.isArray(thread) && thread.length >= 4) {
    max += 10;
    score += 5;
    if (thread.length >= 5 && thread.length <= 8) score += 5;
  } else if (thread) {
    max += 10;
    flags.push('thread: needs 5+ tweets');
  }

  const video = content.formats?.short_video?.content || '';
  if (video) {
    max += 10;
    if (/\[PAUSE\]/i.test(video)) { score += 5; } else { flags.push('video: missing [PAUSE] markers'); }
    if (video.length >= 200) { score += 5; } else { flags.push('video: too short'); }
  }

  const hotTake = content.formats?.hot_take?.content || '';
  if (hotTake) {
    max += 5;
    if (hotTake.length >= 30 && hotTake.length <= 300) { score += 5; } else { flags.push('hot_take: wrong length'); }
  }

  // Hook variants bonus
  const hooks = content.hook_variants;
  if (hooks?.linkedin?.length >= 3) { score += 5; max += 5; }
  if (hooks?.x?.length >= 3) { score += 5; max += 5; }

  return {
    score: max > 0 ? Math.round((score / max) * 100) : 0,
    max,
    earned: score,
    flags
  };
}

module.exports = {
  generateAllContent, generateBlog, generateYouTube,
  generateLeadMagnetContent, generateNewsletterContent, generateCaseStudyContent,
  generatePillarWithSpokes, buildSystemPromptWithMemory, BRAND_SYSTEM_PROMPT,
  scoreContentQuality
};
