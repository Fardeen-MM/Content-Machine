#!/usr/bin/env node
/**
 * seed-more.js — Add 30+ more triggers and 12 more content pieces
 * Run: node scripts/seed-more.js
 */

const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');

function readJSON(file) {
  const p = path.join(DATA_DIR, file);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : [];
}
function writeJSON(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}
function now() { return new Date().toISOString(); }
function hoursAgo(h) { return new Date(Date.now() - h * 3600000).toISOString(); }
function id() { return Math.random().toString(16).slice(2, 18); }

// ── NEW TRIGGERS ──────────────────────────────────────────────

const newTriggers = [
  // Reddit — lead gen & conversion
  {
    id: `reddit-${id()}`, source: 'reddit', source_detail: 'r/LawFirm',
    title: 'We switched from Avvo to Google LSAs — 4x more cases at half the cost',
    raw_content: 'We were spending $1,800/mo on Avvo for our family law practice. Switched to LSAs 3 months ago. Getting 4x the signed cases at roughly $900/mo. The quality is night and day. Avvo leads wanted free advice, LSA leads are ready to hire. Anyone else seeing this?',
    url: 'https://reddit.com/r/LawFirm/comments/lsa_vs_avvo', category: 'DATA_POINT',
    engagement: { upvotes: 87, comments: 34 }, captured_at: hoursAgo(6), status: 'pending', score: 0
  },
  {
    id: `reddit-${id()}`, source: 'reddit', source_detail: 'r/personalinjury',
    title: 'Our intake team started texting leads within 30 seconds — conversion up 41%',
    raw_content: 'We implemented an automated text that fires within 30 seconds of a form fill. Simple message: "Hi [name], this is [firm]. We received your inquiry about [practice area]. An attorney will call you within 5 minutes." Conversion from lead to consult went from 22% to 31%. Game changer.',
    url: 'https://reddit.com/r/personalinjury/comments/text_intake', category: 'DATA_POINT',
    engagement: { upvotes: 112, comments: 45 }, captured_at: hoursAgo(3), status: 'pending', score: 0
  },
  {
    id: `reddit-${id()}`, source: 'reddit', source_detail: 'r/LawFirm',
    title: 'How much should a 5-attorney firm spend on marketing per month?',
    raw_content: 'We are a 5-attorney PI firm in a mid-size market. Currently spending about $8K/month on marketing (mostly Google Ads + some SEO). Revenue is around $2.5M. Are we underspending? What percentage of revenue should go to marketing?',
    url: 'https://reddit.com/r/LawFirm/comments/marketing_budget', category: 'QUESTION',
    engagement: { upvotes: 43, comments: 67 }, captured_at: hoursAgo(12), status: 'pending', score: 0
  },
  {
    id: `reddit-${id()}`, source: 'reddit', source_detail: 'r/SEO',
    title: 'Google just rolled out AI Overviews for legal queries — is SEO for lawyers dead?',
    raw_content: 'I manage SEO for several law firm clients. Noticed Google AI Overviews are now showing for queries like "how to file a personal injury claim" and "do I need a lawyer for DUI." Click-through rates dropped 35% on these informational queries. But transactional queries like "personal injury lawyer near me" seem unaffected. Thoughts?',
    url: 'https://reddit.com/r/SEO/comments/ai_overviews_legal', category: 'NEWS',
    engagement: { upvotes: 156, comments: 89 }, captured_at: hoursAgo(8), status: 'pending', score: 0
  },
  {
    id: `reddit-${id()}`, source: 'reddit', source_detail: 'r/lawyers',
    title: 'The referral fee model is broken — why I stopped paying 33% to other attorneys',
    raw_content: 'I was paying 33% referral fees on cases from other attorneys. Over $180K last year. Started investing that money into Google Ads and SEO instead. 8 months later, I have a pipeline of my own leads and my cost per case dropped from $5,500 (referral) to $1,900 (digital). Referrals are great but at some point you need to own your lead gen.',
    url: 'https://reddit.com/r/lawyers/comments/referral_fees', category: 'PAIN_POINT',
    engagement: { upvotes: 201, comments: 78 }, captured_at: hoursAgo(18), status: 'pending', score: 0
  },
  {
    id: `reddit-${id()}`, source: 'reddit', source_detail: 'r/smallbusiness',
    title: 'Hired 3 marketing agencies in 2 years — all terrible. What am I doing wrong?',
    raw_content: 'Law firm owner here. First agency promised 20 leads/month, got 3. Second agency had nice reports but no cases. Third agency ran my Google Ads to the wrong geo for 4 months. $57K spent across all three with maybe 12 cases to show for it. Is the legal marketing industry just a scam or am I picking wrong?',
    url: 'https://reddit.com/r/smallbusiness/comments/bad_agencies', category: 'PAIN_POINT',
    engagement: { upvotes: 334, comments: 156 }, captured_at: hoursAgo(2), status: 'pending', score: 0
  },
  {
    id: `reddit-${id()}`, source: 'reddit', source_detail: 'r/GoogleAds',
    title: 'Negative keywords saved my law firm client $3,200/month',
    raw_content: 'Audited a PI firm\'s Google Ads account. They had ZERO negative keywords. Was showing up for "lawyer salary", "law school requirements", "free legal advice." Added 340 negative keywords. CPC dropped 22%, conversion rate went from 3.1% to 7.8%. Saved them $3,200/month in wasted spend.',
    url: 'https://reddit.com/r/GoogleAds/comments/negative_keywords', category: 'DATA_POINT',
    engagement: { upvotes: 267, comments: 92 }, captured_at: hoursAgo(5), status: 'pending', score: 0
  },
  {
    id: `reddit-${id()}`, source: 'reddit', source_detail: 'r/Entrepreneur',
    title: 'I built a $3M law firm in 4 years with zero referrals — here\'s every channel I used',
    raw_content: 'Solo PI attorney in a competitive market. Year 1: $320K. Year 4: $3.1M. Every single case from digital. Breakdown: Google Ads 45%, SEO 30%, LSAs 15%, YouTube 10%. Monthly spend went from $4K to $35K as ROI proved out. Happy to break down any channel.',
    url: 'https://reddit.com/r/Entrepreneur/comments/3m_law_firm', category: 'DATA_POINT',
    engagement: { upvotes: 892, comments: 234 }, captured_at: hoursAgo(24), status: 'pending', score: 0
  },
  // Reddit — practice operations
  {
    id: `reddit-${id()}`, source: 'reddit', source_detail: 'r/LawFirm',
    title: 'Our Google Business Profile drives more calls than our website',
    raw_content: 'Checked our call tracking data. GBP click-to-call: 47 calls/month. Website form + phone combined: 31 calls/month. Our GBP is generating 60% of all inbound calls and we barely optimize it. Just started posting weekly, responding to every review, and adding Q&As. Expecting this to grow.',
    url: 'https://reddit.com/r/LawFirm/comments/gbp_calls', category: 'DATA_POINT',
    engagement: { upvotes: 98, comments: 41 }, captured_at: hoursAgo(10), status: 'pending', score: 0
  },
  {
    id: `reddit-${id()}`, source: 'reddit', source_detail: 'r/marketing',
    title: 'Landing pages vs homepage for law firm ads — A/B test results',
    raw_content: 'Ran an A/B test for a criminal defense firm. Sent half the Google Ads traffic to homepage, half to a dedicated landing page. Results after 30 days: Homepage: 2.1% conversion. Landing page: 8.7% conversion. 4.1x improvement. The landing page had: one CTA, social proof, FAQ section, click-to-call. No navigation menu.',
    url: 'https://reddit.com/r/marketing/comments/landing_vs_homepage', category: 'DATA_POINT',
    engagement: { upvotes: 445, comments: 112 }, captured_at: hoursAgo(15), status: 'pending', score: 0
  },
  // RSS — legal tech & trends
  {
    id: `rss-${id()}`, source: 'rss', source_detail: 'Clio Blog',
    title: 'The 2026 State of Legal Tech: 78% of firms now use some form of automation',
    raw_content: 'Clio\'s annual survey shows automation adoption hit 78% in 2025, up from 52% in 2023. The most adopted tools: automated email responses (61%), document automation (54%), intake forms (48%), and billing automation (43%). Firms using 3+ automation tools report 23% higher revenue per attorney.',
    url: 'https://clio.com/blog/state-of-legal-tech-2026', category: 'DATA_POINT',
    captured_at: hoursAgo(4), status: 'pending', score: 0
  },
  {
    id: `rss-${id()}`, source: 'rss', source_detail: 'Above the Law',
    title: 'ChatGPT is now the first stop for 42% of people with legal questions',
    raw_content: 'A new survey by the National Bar Foundation found that 42% of people with a legal question now consult AI before calling a lawyer. For under-35 respondents, it was 67%. The implication for law firms: your competition isn\'t just other lawyers, it\'s AI giving "good enough" answers for free.',
    url: 'https://abovethelaw.com/chatgpt-legal-questions-survey', category: 'NEWS',
    captured_at: hoursAgo(7), status: 'pending', score: 0
  },
  {
    id: `rss-${id()}`, source: 'rss', source_detail: 'Search Engine Journal',
    title: 'Local SEO in 2026: Google Business Profile signals now account for 36% of local ranking',
    raw_content: 'Whitespark\'s annual local search ranking factors study shows GBP signals grew to 36% of local ranking factors, up from 32% last year. Reviews are the fastest-growing factor. On-page SEO declined to 17%. Link signals dropped to 11%. The message is clear: your Google Business Profile matters more than your website for local visibility.',
    url: 'https://searchenginejournal.com/local-seo-2026-ranking-factors', category: 'DATA_POINT',
    captured_at: hoursAgo(9), status: 'pending', score: 0
  },
  {
    id: `rss-${id()}`, source: 'rss', source_detail: 'HubSpot Marketing',
    title: 'Video content gets 3x more engagement than text for professional services',
    raw_content: 'HubSpot analyzed 2.4 million social posts across professional services firms. Video content generated 3.1x more engagement (likes, comments, shares) than text-only posts. Short-form video (under 90 seconds) outperformed long-form by 2.4x on LinkedIn. The ideal LinkedIn video: 45-60 seconds, face-to-camera, one key insight.',
    url: 'https://blog.hubspot.com/marketing/video-engagement-professional-services', category: 'DATA_POINT',
    captured_at: hoursAgo(11), status: 'pending', score: 0
  },
  {
    id: `rss-${id()}`, source: 'rss', source_detail: 'Rankings.io Blog',
    title: 'We analyzed 500 PI firm websites — the top 10% all do these 7 things',
    raw_content: 'Rankings.io analyzed 500 personal injury firm websites for conversion rate, page speed, and SEO. The top 10% (converting above 8%) shared 7 traits: (1) Click-to-call above fold, (2) Live chat or chatbot, (3) Social proof on every page, (4) Case results page, (5) FAQ schema markup, (6) Page speed under 2.5 seconds, (7) Dedicated landing pages for each practice area.',
    url: 'https://rankings.io/blog/pi-website-analysis-2026', category: 'CONTENT_PIECE',
    captured_at: hoursAgo(14), status: 'pending', score: 0
  },
  {
    id: `rss-${id()}`, source: 'rss', source_detail: 'Neil Patel Blog',
    title: 'The death of the 10-blue-links: How AI search changes service business marketing',
    raw_content: 'Google AI Overviews now appear on 38% of legal-related searches. For informational queries the click-through rate dropped 41%. But for "near me" and location-specific queries, CTR actually increased 12% because AI overviews push users toward calling local businesses. Strategy shift: invest MORE in local/transactional SEO, LESS in informational blog content.',
    url: 'https://neilpatel.com/blog/ai-search-service-business-marketing', category: 'NEWS',
    captured_at: hoursAgo(16), status: 'pending', score: 0
  },
  {
    id: `rss-${id()}`, source: 'rss', source_detail: 'Lawyerist',
    title: 'Client review response rate directly correlates with revenue growth',
    raw_content: 'Lawyerist surveyed 300 law firms on review practices. Firms that respond to 90%+ of Google reviews grew revenue 2.3x faster than those responding to under 50%. The top driver: responding to negative reviews professionally actually increased trust. 71% of prospective clients said they read owner responses to 1-2 star reviews before making a call.',
    url: 'https://lawyerist.com/client-review-response-revenue', category: 'DATA_POINT',
    captured_at: hoursAgo(20), status: 'pending', score: 0
  },
  // YouTube-sourced triggers
  {
    id: `yt-${id()}`, source: 'youtube', source_detail: 'Alex Hormozi',
    title: 'How to Calculate True Customer Acquisition Cost (Most Businesses Get This Wrong)',
    raw_content: 'Alex breaks down why most businesses miscalculate CAC. They only count ad spend, not staff time, software, lost opportunity cost. Real formula: (Total marketing spend + Sales team cost + Tech stack + Agency fees) / New customers. For service businesses, the "hidden" costs often double the number.',
    url: 'https://youtube.com/watch?v=hormozi_cac', category: 'CONTENT_PIECE',
    thumbnail: 'https://i.ytimg.com/vi/hormozi_cac/hqdefault.jpg',
    captured_at: hoursAgo(13), status: 'pending', score: 0
  },
  {
    id: `yt-${id()}`, source: 'youtube', source_detail: 'Gary Vaynerchuk',
    title: 'LinkedIn Is Underpriced Attention — Why Every Service Business Should Be Posting Daily',
    raw_content: 'Gary explains that LinkedIn organic reach is at an all-time high. Average post reaches 10-15% of your network vs Facebook at 2-3%. For professional services (lawyers, accountants, consultants), it is the #1 platform. His advice: post daily, be real, don\'t sell — teach. Personal brand > company page.',
    url: 'https://youtube.com/watch?v=gary_linkedin', category: 'CONTENT_PIECE',
    thumbnail: 'https://i.ytimg.com/vi/gary_linkedin/hqdefault.jpg',
    captured_at: hoursAgo(22), status: 'pending', score: 0
  },
  {
    id: `yt-${id()}`, source: 'youtube', source_detail: 'Neil Patel',
    title: 'I Spent $100M on Google Ads — Here Are My 10 Biggest Lessons',
    raw_content: 'Neil\'s top lessons from spending $100M on Google Ads across clients: (1) Negative keywords are more important than positive keywords, (2) Landing pages matter more than ad copy, (3) Call tracking is non-negotiable, (4) Branded search is the cheapest traffic, (5) Remarketing converts 3x better than cold, (6) Quality Score is worth fighting for.',
    url: 'https://youtube.com/watch?v=neil_100m_ads', category: 'CONTENT_PIECE',
    thumbnail: 'https://i.ytimg.com/vi/neil_100m_ads/hqdefault.jpg',
    captured_at: hoursAgo(28), status: 'pending', score: 0
  },
  {
    id: `yt-${id()}`, source: 'youtube', source_detail: 'Chris Dreyer / Rankings.io',
    title: 'Why Most Law Firm SEO Takes 12 Months to Work (And How to Speed It Up)',
    raw_content: 'Chris explains the typical SEO timeline for law firms. Months 1-3: technical fixes and content. Months 4-6: start seeing movement in rankings. Months 7-9: consistent lead flow begins. Months 10-12: compound growth kicks in. Speed it up: (1) Fix technical issues first, (2) Target low-competition long-tail, (3) Build local links aggressively, (4) Combine with PPC while waiting.',
    url: 'https://youtube.com/watch?v=dreyer_seo_timeline', category: 'CONTENT_PIECE',
    thumbnail: 'https://i.ytimg.com/vi/dreyer_seo_timeline/hqdefault.jpg',
    captured_at: hoursAgo(30), status: 'pending', score: 0
  },
  // Competitor intelligence
  {
    id: `comp-${id()}`, source: 'competitor', source_detail: 'Crisp Video',
    title: 'The $50K Website vs the $5K Website — What Actually Matters',
    raw_content: 'Competitor analysis: Crisp Video published a comparison of high-budget vs low-budget law firm websites. Their data: expensive sites convert 12% higher BUT only when they include video testimonials and chat. Without those two features, a $5K website performs identically. The design doesn\'t matter. The social proof and speed-to-contact do.',
    url: 'https://crispvideo.com/blog/50k-website-vs-5k-website', category: 'CONTENT_PIECE',
    captured_at: hoursAgo(36), status: 'pending', score: 0
  },
  {
    id: `comp-${id()}`, source: 'competitor', source_detail: 'Scorpion',
    title: 'Scorpion claims 89% of their PI clients see positive ROI within 6 months',
    raw_content: 'Scorpion published a case study claiming 89% of PI firm clients achieve positive ROI within 6 months. Average cost per lead: $78 for PI, $45 for family law, $62 for criminal defense. They attribute success to their "full stack" approach — website, SEO, PPC, LSAs all managed together.',
    url: 'https://scorpion.co/case-studies/pi-roi-2026', category: 'DATA_POINT',
    captured_at: hoursAgo(48), status: 'pending', score: 0
  },
  // Questions from audience
  {
    id: `q-${id()}`, source: 'question', source_detail: 'LinkedIn DM',
    title: 'Should I invest in SEO or PPC first? Budget is $5K/month',
    raw_content: 'Common question from a 3-attorney criminal defense firm in Phoenix. $5K/month marketing budget. Currently doing nothing digital. Should they start with Google Ads for immediate leads or SEO for long-term growth? Classic chicken-and-egg problem.',
    category: 'QUESTION', captured_at: hoursAgo(1), status: 'pending', score: 0
  },
  {
    id: `q-${id()}`, source: 'question', source_detail: 'Email',
    title: 'What CRM should a small law firm use? We have 4 attorneys',
    raw_content: 'Small PI firm asking about CRM options. Currently using spreadsheets to track leads. Wants something that integrates with their phone system and can track lead source → consultation → signed case. Budget is $200-500/month.',
    category: 'QUESTION', captured_at: hoursAgo(8), status: 'pending', score: 0
  },
  {
    id: `q-${id()}`, source: 'question', source_detail: 'Instagram comment',
    title: 'How many Google reviews do we need to rank in the local pack?',
    raw_content: 'Family law attorney in a suburb of Dallas. Has 23 Google reviews (4.8 stars). Competitors have 80-200 reviews. Wants to know the minimum to be competitive and how to get more reviews without seeming desperate.',
    category: 'QUESTION', captured_at: hoursAgo(14), status: 'pending', score: 0
  },
  {
    id: `q-${id()}`, source: 'question', source_detail: 'Webinar Q&A',
    title: 'Is TikTok worth it for a law firm? Seems unprofessional',
    raw_content: 'Estate planning attorney asks if TikTok is appropriate for their practice. Concerned about seeming unprofessional. Notes that several competitor attorneys have large TikTok followings but questions whether it actually generates cases.',
    category: 'QUESTION', captured_at: hoursAgo(20), status: 'pending', score: 0
  },
  // More RSS news
  {
    id: `rss-${id()}`, source: 'rss', source_detail: 'Law.com',
    title: 'Mass tort advertising spend hits $1.2B in 2025 — up 34% YoY',
    raw_content: 'Mass tort advertising spending reached $1.2 billion in 2025, a 34% increase from the prior year. Camp Lejeune, PFAS, and hair relaxer cases drove the surge. TV still dominates at 52% of spend, but digital overtook radio for the first time at 28% vs 12%. Cost per case for mass tort has risen to $3,200-$8,500 depending on the tort.',
    url: 'https://law.com/mass-tort-advertising-spend-2025', category: 'DATA_POINT',
    captured_at: hoursAgo(25), status: 'pending', score: 0
  },
  {
    id: `rss-${id()}`, source: 'rss', source_detail: 'Attorney at Work',
    title: 'The virtual receptionist vs AI chatbot debate: which converts better for law firms?',
    raw_content: 'Attorney at Work compared conversion rates across 45 law firms. Virtual receptionist: 28% lead-to-consultation rate. AI chatbot: 19% lead-to-consultation rate. Phone call direct to attorney: 42% conversion. BUT — AI chatbot captured 3x more after-hours leads. Combined strategy (chatbot after hours + human during hours) hit 35%.',
    url: 'https://attorneyatwork.com/virtual-receptionist-vs-ai-chatbot', category: 'DATA_POINT',
    captured_at: hoursAgo(32), status: 'pending', score: 0
  },
  {
    id: `rss-${id()}`, source: 'rss', source_detail: 'Moz Blog',
    title: 'Link building for local businesses in 2026: what still works',
    raw_content: 'Moz analyzed 15,000 local business sites. Top link building strategies that still move rankings: (1) Local sponsorships and events, (2) Data-driven PR studies, (3) Legal directories with high DA, (4) Guest posting on local news, (5) HARO/Connectively responses. Paid link building showed diminishing returns with higher penalty risk. Average links needed to rank top 3 for "lawyer + city": 47 referring domains.',
    url: 'https://moz.com/blog/local-link-building-2026', category: 'CONTENT_PIECE',
    captured_at: hoursAgo(38), status: 'pending', score: 0
  },
  {
    id: `rss-${id()}`, source: 'rss', source_detail: 'Content Marketing Institute',
    title: 'Why thought leadership content generates 4x more qualified leads than promotional content',
    raw_content: 'CMI surveyed 1,200 B2B buyers. 62% said thought leadership content was the primary reason they chose one vendor over another. For professional services, the ratio was even higher: 78%. Thought leadership pieces generated 4.1x more qualified leads than promotional content. The winning formula: original data + specific frameworks + honest takes on what doesn\'t work.',
    url: 'https://contentmarketinginstitute.com/thought-leadership-qualified-leads', category: 'DATA_POINT',
    captured_at: hoursAgo(40), status: 'pending', score: 0
  },
];

// ── NEW CONTENT PIECES ──────────────────────────────────────────

const newContent = [
  {
    id: id(), trigger_id: newTriggers[0].id,
    trigger_title: newTriggers[0].title,
    trigger_source: 'reddit', trigger_category: 'DATA_POINT',
    trigger_url: newTriggers[0].url,
    generated_at: hoursAgo(5), status: 'review',
    formats: {
      linkedin: {
        content: `A family law firm was spending $1,800/month on Avvo.\n\nThe leads? People looking for free legal advice.\n\nThey switched to Google Local Service Ads 3 months ago.\n\nThe results:\n→ 4x more signed cases\n→ $900/month (half the cost)\n→ Leads that are actually ready to hire\n\nHere's the difference most firms miss:\n\nAvvo leads are browsing. They're comparing 5 attorneys, reading reviews, looking for the cheapest option. By the time they call you, they've already called 3 other firms.\n\nLSA leads searched "family lawyer near me" and clicked the first Google Screened result. They need help NOW.\n\nThe math: $1,800/mo on Avvo = ~6 signed cases. $900/mo on LSAs = ~24 signed cases.\n\nThat's not a marginal improvement. That's a 4x multiplier at half the budget.\n\nIf you're still paying premium directory rates, run a 90-day test. Put half that budget into LSAs. Track cost per signed case — not leads, not calls — signed cases.\n\nThe data will make the decision for you.\n\n#LSA #GoogleScreened #LegalMarketing #LawFirmGrowth`,
        status: 'review', edited: false
      },
      x_single: {
        content: 'Family law firm: Avvo $1,800/mo → 6 cases. Switched to LSAs: $900/mo → 24 cases. 4x cases at half the cost. Avvo leads want free advice. LSA leads want to hire. The platform matters.',
        status: 'review', edited: false
      },
      x_thread: {
        content: [
          'A family law firm switched from Avvo to Google Local Service Ads. The results should make every directory-dependent firm reconsider their strategy 🧵',
          'Before: $1,800/month on Avvo. About 6 signed cases. Most leads wanted free advice or were comparing 5+ attorneys. Intake conversion rate: 8%.',
          'After: $900/month on Google LSAs. About 24 signed cases. These leads searched "family lawyer near me" and called the first Google Screened result. Intake conversion rate: 31%.',
          'The difference: intent. Avvo users are browsing. LSA users are buying. Same practice area. Same attorneys. Same intake process. Just a different lead source.',
          'This doesn\'t mean Avvo is useless — it\'s still good for credibility and reviews. But as a lead SOURCE, it\'s increasingly outperformed by Google\'s own products.',
          'If you\'re spending $1K+ on any directory, run a 90-day test: shift half to LSAs. Track cost per SIGNED case (not leads, not calls). Let the data decide.'
        ],
        status: 'review', edited: false
      },
      short_video: {
        content: "HOOK: A law firm cut their marketing spend in half and got 4x more cases.\n\n[PAUSE]\n\nThey were spending $1,800 a month on Avvo. Getting about 6 signed cases.\n\nSwitched to Google Local Service Ads. $900 a month. 24 signed cases.\n\n[PAUSE]\n\nThe difference is intent. Avvo leads are browsing. They're comparing five attorneys. Looking for free advice.\n\nLSA leads searched \"family lawyer near me\" and clicked the first Google Screened result. They want to hire someone TODAY.\n\n[PAUSE]\n\nIf you're spending over $1,000 a month on any legal directory — run a 90-day test. Put half into LSAs. Track cost per signed case.\n\nThe data will make the decision for you.",
        status: 'review', edited: false
      }
    },
    image_prompt: 'Split comparison: Avvo logo with "$1,800/mo → 6 cases" vs Google LSA badge with "$900/mo → 24 cases". Clean data visualization, before/after style.',
    image_url: null, blog_keyword: 'Avvo vs Google LSAs for law firms', youtube_topic: null,
    blog_post: null, youtube_script: null, notes: ''
  },
  {
    id: id(), trigger_id: newTriggers[1].id,
    trigger_title: newTriggers[1].title,
    trigger_source: 'reddit', trigger_category: 'DATA_POINT',
    trigger_url: newTriggers[1].url,
    generated_at: hoursAgo(2), status: 'review',
    formats: {
      linkedin: {
        content: `One automated text message.\n\nThat's all it took to increase a PI firm's conversion rate by 41%.\n\nThe text fires within 30 seconds of a form submission:\n\n"Hi [name], this is [firm]. We received your inquiry about [practice area]. An attorney will call you within 5 minutes."\n\nThat's it. No AI. No fancy chatbot. Just a fast, human acknowledgment.\n\nBefore: 22% lead-to-consultation rate\nAfter: 31% lead-to-consultation rate\n\nWhy does this work so well?\n\nBecause 78% of leads go with the first firm that responds.\n\nNot the best firm. Not the cheapest firm. The FIRST firm.\n\nYour potential client just filled out a form while sitting in an ER waiting room, or during their lunch break, or at 11pm. They're anxious. They want to know someone heard them.\n\nA 30-second text does that.\n\nSet this up today. Every CRM can do it. Every intake platform can do it.\n\nIt's a 15-minute setup that generates more cases than most $5K/month ad campaigns.\n\n#SpeedToLead #IntakeAutomation #LegalMarketing #Conversion`,
        status: 'review', edited: false
      },
      x_single: {
        content: 'PI firm added one automated text within 30 seconds of form fills. Lead-to-consultation rate: 22% → 31%. 78% of leads hire the first firm that responds. A 15-minute setup that outperforms most $5K/mo ad campaigns.',
        status: 'review', edited: false
      },
      x_thread: {
        content: [
          'A PI firm increased their conversion rate by 41% with one change. Not more ads. Not a new website. One automated text message 🧵',
          'The setup: an automated text fires within 30 seconds of any form submission. The message: "Hi [name], this is [firm]. We received your inquiry about [practice area]. An attorney will call you within 5 minutes."',
          'Before the text: 22% of form fills converted to consultations. After: 31%. Same ads. Same budget. Same intake team. Just faster acknowledgment.',
          'Why it works: 78% of leads hire the first firm that responds. Not the best firm. The FIRST one. That 30-second text puts you first in line.',
          'Think about your client: they\'re filling out a form at 11pm from an ER waiting room. They\'re anxious. They want to know someone heard them. That instant text says "we got you."',
          'Every CRM can do this. Clio, MyCase, PracticePanther — all of them. It\'s a 15-minute setup. If you\'re not doing this, you\'re losing cases to firms who are.'
        ],
        status: 'review', edited: false
      },
      short_video: {
        content: "HOOK: One text message increased this law firm's conversion rate by 41%.\n\n[PAUSE]\n\nHere's the text. It fires automatically within 30 seconds of a form submission.\n\n\"Hi [name], this is [firm]. We received your inquiry. An attorney will call you within 5 minutes.\"\n\n[PAUSE]\n\nThat's it. No AI. No chatbot. Just a fast acknowledgment.\n\nBefore: 22% of leads became consultations.\nAfter: 31%.\n\n[PAUSE]\n\n78% of leads hire the FIRST firm that responds. Not the best firm. The first one.\n\nEvery CRM can do this. It's a 15-minute setup. If you're not doing it, you're losing cases to firms who are.",
        status: 'review', edited: false
      }
    },
    image_prompt: 'Phone screen showing a text message conversation. "Hi Sarah, we received your inquiry..." with a timestamp showing ":30 seconds". Clean mockup style.',
    image_url: null, blog_keyword: 'automated text intake law firm conversion', youtube_topic: null,
    blog_post: null, youtube_script: null, notes: ''
  },
  {
    id: id(), trigger_id: newTriggers[3].id,
    trigger_title: newTriggers[3].title,
    trigger_source: 'reddit', trigger_category: 'NEWS',
    trigger_url: newTriggers[3].url,
    generated_at: hoursAgo(7), status: 'review',
    formats: {
      linkedin: {
        content: `"Is SEO for lawyers dead?"\n\nI hear this every time Google changes something.\n\nThis time it's AI Overviews showing up on legal queries.\n\nThe data is more nuanced than the headlines suggest.\n\nInformational queries ("how to file a PI claim"):\n→ Click-through rate dropped 35%\n→ AI Overviews give "good enough" answers\n→ Less traffic to blog content\n\nTransactional queries ("personal injury lawyer near me"):\n→ Click-through rate actually UP 12%\n→ AI Overviews push users toward local results\n→ More calls from Maps/LSAs\n\nThe takeaway isn't that SEO is dead. It's that the SEO STRATEGY needs to shift.\n\nOld strategy: Write 50 blog posts targeting informational keywords, hope they rank, hope they convert.\n\nNew strategy: Dominate local/transactional keywords. Optimize GBP. Get more reviews. Build landing pages for specific practice areas + locations.\n\nThe firms that pivot now will capture the traffic that old-school SEO firms are losing.\n\nInformational content still matters — but for brand awareness and authority, not direct lead gen.\n\nThe game changed. Adapt or get left behind.\n\n#SEO #LegalMarketing #AIOverviews #GoogleUpdate`,
        status: 'review', edited: false
      },
      x_single: {
        content: 'Google AI Overviews: informational legal queries CTR down 35%. But "lawyer near me" queries CTR actually UP 12%. SEO isn\'t dead — it\'s shifting from blog content to local/transactional. Adapt or get left behind.',
        status: 'review', edited: false
      },
      x_thread: {
        content: [
          '"Is SEO for lawyers dead?" I hear this every time Google changes something. This time it\'s AI Overviews. The data tells a more nuanced story 🧵',
          'Informational queries ("how to file a PI claim"): CTR dropped 35%. AI Overviews give "good enough" answers. Blog traffic is declining for these terms. This is real.',
          'But transactional queries ("personal injury lawyer near me"): CTR actually INCREASED 12%. AI Overviews push users toward calling local businesses. More phone calls from Maps and LSAs.',
          'What this means for law firm SEO strategy: the old playbook (write 50 blog posts, target informational keywords, pray for conversion) is dying. Fast.',
          'The new playbook: dominate local keywords. Optimize your Google Business Profile. Get more reviews. Build dedicated landing pages for every practice area + city combination.',
          'Informational content still matters for authority and brand. But if you\'re counting on blog posts to generate cases in 2026, you\'re fighting a losing battle against AI.',
          'The firms that shift their SEO budget toward local/transactional NOW will capture the traffic that old-school content marketing firms are losing.'
        ],
        status: 'review', edited: false
      },
      short_video: {
        content: "HOOK: Google AI Overviews are showing up on legal searches. Everyone's asking: is SEO for lawyers dead?\n\n[PAUSE]\n\nShort answer: no. But the strategy has to change.\n\nInformational queries — \"how to file a personal injury claim\" — click-through rates dropped 35%. AI gives good enough answers.\n\n[PAUSE]\n\nBUT — transactional queries — \"personal injury lawyer near me\" — click-through rates actually went UP 12%.\n\nAI Overviews are pushing people toward calling local businesses.\n\n[PAUSE]\n\nOld SEO strategy: write blog posts, target informational keywords, hope for conversion.\n\nNew strategy: dominate local search. Google Business Profile. Reviews. Practice area landing pages.\n\nSEO isn't dead. But the SEO that worked in 2023 is. Adapt now.",
        status: 'review', edited: false
      }
    },
    image_prompt: 'Split screen: declining chart for informational queries vs rising chart for local queries. Google AI Overview interface mockup. Blue and navy color scheme.',
    image_url: null, blog_keyword: 'Google AI Overviews impact on law firm SEO', youtube_topic: 'Is SEO for Lawyers Dead? What AI Overviews Actually Mean for Your Firm',
    blog_post: null, youtube_script: null, notes: ''
  },
  {
    id: id(), trigger_id: newTriggers[5].id,
    trigger_title: newTriggers[5].title,
    trigger_source: 'reddit', trigger_category: 'PAIN_POINT',
    trigger_url: newTriggers[5].url,
    generated_at: hoursAgo(1), status: 'approved',
    formats: {
      linkedin: {
        content: `A law firm owner spent $57K on three marketing agencies.\n\nTotal signed cases across all three: 12.\n\nThat's $4,750 per case.\n\nHere's why every agency failed — and what to look for instead.\n\nAgency 1: Promised 20 leads/month. Delivered 3. No call tracking. No reporting. "Trust the process."\n\nAgency 2: Beautiful reports. Impressions, clicks, CTR all going up. Cases? Zero new ones. They were optimizing for vanity metrics.\n\nAgency 3: Ran Google Ads to the wrong geographic area. For 4 months. While billing $2K/month for management.\n\nThe pattern: none of them were measured on the only metric that matters — signed cases.\n\nHere's the filter I give every firm:\n\nBefore hiring any agency, ask these 3 questions:\n\n1. "How do you define a lead?" (If they say 'anyone who clicks,' run)\n2. "What's my expected cost per signed case?" (If they don't know, run)\n3. "Can I have login access to all ad accounts?" (If no, run)\n\nGood agencies welcome accountability. Bad agencies hide behind impressions.\n\n$57K is a lot of tuition. But the lesson is priceless.\n\n#LegalMarketing #LawFirmGrowth #AgencyAccountability`,
        status: 'approved', edited: false
      },
      x_single: {
        content: '$57K across 3 agencies. 12 cases total. $4,750 per case. None tracked signed cases as their metric. Before hiring any agency: ask for cost per signed case, demand ad account access, and define what a "lead" is. Accountability > promises.',
        status: 'approved', edited: false
      },
      x_thread: {
        content: [
          'A law firm owner spent $57K on three marketing agencies in two years. Total signed cases: 12. That\'s $4,750 per case. Here\'s exactly what went wrong with each one 🧵',
          'Agency 1: Promised 20 leads/month. Delivered 3. No call tracking set up. No way to verify. Their response to complaints: "trust the process." After 6 months and $18K, the firm fired them.',
          'Agency 2: Beautiful reports. Impressions up 200%. Click-through rate "above industry average." Social engagement growing. Cases? Zero new ones. They optimized for metrics that look good in a slide deck but don\'t pay rent.',
          'Agency 3: Ran Google Ads to the wrong geographic area for 4 months. When caught, their response: "that\'s a default Google setting." They never checked the basics. While billing $2K/month for "management."',
          'The pattern across all three: NONE were measured on signed cases. Not one. They were measured on leads, clicks, impressions — everything except the thing that pays the bills.',
          'Before hiring any agency, ask three questions: (1) How do you define a lead? (2) What\'s my expected cost per signed case? (3) Can I have login access to all ad accounts? If any answer is unsatisfactory, walk away.',
          'Good agencies welcome accountability. They\'ll tell you exactly what a case costs and prove it monthly. Bad agencies hide behind vanity metrics and "trust the process." $57K is expensive tuition, but the lesson is worth sharing.'
        ],
        status: 'approved', edited: false
      },
      short_video: {
        content: "HOOK: A law firm owner spent $57,000 on three marketing agencies. Total signed cases across all three: twelve.\n\n[PAUSE]\n\nAgency one: promised 20 leads a month. Delivered three. No call tracking. \"Trust the process.\"\n\nAgency two: beautiful reports. Impressions up, clicks up, cases... zero.\n\nAgency three: ran Google Ads to the wrong geographic area. For four months.\n\n[PAUSE]\n\nThe pattern? None of them were measured on signed cases. Not one.\n\nBefore you hire any agency, ask three questions.\n\n[PAUSE]\n\nOne: how do you define a lead?\nTwo: what's my expected cost per signed case?\nThree: can I have login access to my ad accounts?\n\nIf any answer is vague, walk away. Good agencies welcome accountability.",
        status: 'approved', edited: false
      }
    },
    image_prompt: 'Three agency logos crossed out with red X marks. "$57K → 12 Cases = $4,750/case" in bold typography. Professional but alarming color scheme.',
    image_url: null, blog_keyword: 'how to hire a law firm marketing agency',
    youtube_topic: 'How to Hire a Law Firm Marketing Agency (Without Wasting $57K)',
    blog_post: null, youtube_script: null, notes: ''
  },
  {
    id: id(), trigger_id: newTriggers[6].id,
    trigger_title: newTriggers[6].title,
    trigger_source: 'reddit', trigger_category: 'DATA_POINT',
    trigger_url: newTriggers[6].url,
    generated_at: hoursAgo(4), status: 'review',
    formats: {
      linkedin: {
        content: `340 negative keywords.\n\nThat's how many were missing from a PI firm's Google Ads account.\n\nThey'd been running ads for 18 months with ZERO negative keywords.\n\nShowing up for:\n→ "lawyer salary"\n→ "law school requirements"\n→ "free legal advice"\n→ "legal aid near me"\n→ "how to become a lawyer"\n\nNone of these people will ever become a client.\n\nAfter adding 340 negative keywords:\n\nCPC dropped 22%\nConversion rate: 3.1% → 7.8%\nMonthly savings: $3,200\n\nThat's $38,400/year they were burning on completely irrelevant clicks.\n\nHere's the thing: this isn't an edge case. I audit law firm Google Ads accounts regularly. The average account has fewer than 50 negative keywords. The good ones have 300+.\n\nNegative keywords are the most underrated lever in PPC.\n\nThey don't get you more traffic. They eliminate the traffic that wastes your money.\n\nWhen was the last time you checked your search terms report? If the answer is "I don't know," that's the problem.\n\n#GoogleAds #PPC #LegalMarketing #NegativeKeywords`,
        status: 'review', edited: false
      },
      x_single: {
        content: 'PI firm: zero negative keywords for 18 months. Showing up for "lawyer salary" and "free legal advice." Added 340 negatives. CPC down 22%. Conversion: 3.1% → 7.8%. $3,200/mo saved. Check your search terms report today.',
        status: 'review', edited: false
      },
      x_thread: {
        content: [
          'I audited a PI firm\'s Google Ads account. They had zero negative keywords. For 18 months. Here\'s what that cost them 🧵',
          'They were showing ads for: "lawyer salary," "law school requirements," "free legal advice," "legal aid near me," "how to become a lawyer." Not one of these searches will ever produce a client.',
          'After adding 340 negative keywords: CPC dropped 22%. Conversion rate went from 3.1% to 7.8%. Monthly savings: $3,200. That\'s $38,400/year in wasted clicks.',
          'This isn\'t an edge case. I audit law firm Google Ads accounts regularly. The average has fewer than 50 negative keywords. The well-managed ones have 300+.',
          'Negative keywords don\'t get you more traffic. They eliminate the traffic that wastes your money. It\'s subtraction, not addition. And it\'s the most underrated lever in PPC.',
          'Action step: log into your Google Ads account. Go to Keywords > Search Terms. Sort by cost. Look at what you\'re actually paying for. I guarantee you\'ll find waste within 60 seconds.'
        ],
        status: 'review', edited: false
      },
      short_video: {
        content: "HOOK: A law firm was burning $3,200 a month on completely irrelevant Google Ad clicks.\n\n[PAUSE]\n\nThey had been running ads for 18 months with ZERO negative keywords.\n\nShowing up for \"lawyer salary.\" \"Law school requirements.\" \"Free legal advice.\"\n\nNone of these people will ever become a client.\n\n[PAUSE]\n\nAfter adding 340 negative keywords: CPC dropped 22%. Conversion rate went from 3.1% to 7.8%.\n\nThat's $38,400 a year they were burning.\n\n[PAUSE]\n\nLog into your Google Ads. Click Keywords. Click Search Terms. Sort by cost.\n\nI guarantee you'll find waste within 60 seconds.",
        status: 'review', edited: false
      }
    },
    image_prompt: 'Google Ads search terms list with irrelevant searches highlighted in red and crossed out. "340 Negative Keywords = $38,400 Saved" in bold. Clean data style.',
    image_url: null, blog_keyword: 'Google Ads negative keywords law firm',
    youtube_topic: null, blog_post: null, youtube_script: null, notes: ''
  },
  {
    id: id(), trigger_id: newTriggers[9].id,
    trigger_title: newTriggers[9].title,
    trigger_source: 'reddit', trigger_category: 'DATA_POINT',
    trigger_url: newTriggers[9].url,
    generated_at: hoursAgo(14), status: 'review',
    formats: {
      linkedin: {
        content: `A criminal defense firm ran an A/B test.\n\nHalf their Google Ads traffic → homepage.\nHalf → dedicated landing page.\n\n30 days later:\n\nHomepage: 2.1% conversion rate\nLanding page: 8.7% conversion rate\n\nThat's a 4.1x improvement.\n\nThe landing page had:\n✓ One single CTA (call or form)\n✓ No navigation menu\n✓ 3 client testimonials above the fold\n✓ FAQ section with schema markup\n✓ Click-to-call button (sticky on mobile)\n✓ "What happens when you call" section\n\nThe homepage had: everything. About us, practice areas, blog, team, contact, awards, 47 links competing for attention.\n\nWhen someone clicks a Google Ad for "DUI lawyer in [city]," they have ONE question: "Can this firm help me right now?"\n\nYour homepage tries to answer every question. A landing page answers the only one that matters.\n\nIf you're sending paid traffic to your homepage, you're paying 4x more per case than you need to.\n\n#LandingPages #LegalMarketing #ConversionRate #PPC`,
        status: 'review', edited: false
      },
      x_single: {
        content: 'Criminal defense firm A/B test: Homepage = 2.1% conversion. Landing page = 8.7% conversion. 4.1x improvement. The landing page had one CTA, no navigation, and social proof. Stop sending paid traffic to your homepage.',
        status: 'review', edited: false
      },
      x_thread: {
        content: [
          'A criminal defense firm ran an A/B test with their Google Ads. Half the traffic went to their homepage. Half went to a dedicated landing page. The results after 30 days 🧵',
          'Homepage conversion rate: 2.1%. Landing page conversion rate: 8.7%. That\'s 4.1x more conversions from the exact same ad spend and traffic volume.',
          'What the landing page had: (1) One CTA — call or fill out a form. (2) No navigation menu. (3) Three client testimonials above the fold. (4) FAQ section with schema markup. (5) Sticky click-to-call on mobile.',
          'What the homepage had: everything. About us, 7 practice areas, blog, team bios, awards, contact page, 47 different links competing for attention. When someone needs a DUI lawyer NOW, they don\'t want a website tour.',
          'The math: if you spend $5K/month on ads and send it to your homepage at 2.1% conversion = ~10 leads. Same $5K to a landing page at 8.7% = ~43 leads. That\'s 33 extra potential clients. Per month.',
          'If you\'re running Google Ads and sending traffic to your homepage, you\'re paying 4x more per case than you need to. Build one landing page. Test it for 30 days. The data will convince you.'
        ],
        status: 'review', edited: false
      },
      short_video: {
        content: "HOOK: A law firm was paying 4x more per case than they needed to. Because of one mistake.\n\n[PAUSE]\n\nThey were sending all their Google Ads traffic to their homepage.\n\nSo they ran an A/B test. Half the traffic to the homepage. Half to a dedicated landing page.\n\n[PAUSE]\n\nHomepage: 2.1% conversion.\nLanding page: 8.7% conversion.\n\n4.1x improvement. Same ads. Same budget.\n\n[PAUSE]\n\nThe landing page had one CTA. No navigation menu. Three testimonials. A click-to-call button.\n\nThe homepage had everything — which is exactly the problem.\n\nWhen someone searches \"DUI lawyer near me,\" they have one question: can this firm help me right now?\n\nYour landing page should answer that. Nothing else.",
        status: 'review', edited: false
      }
    },
    image_prompt: 'Split screen mockup: cluttered homepage on left vs clean landing page on right. "2.1% vs 8.7%" conversion rate labels. A/B test style visual.',
    image_url: null, blog_keyword: 'law firm landing page vs homepage conversion',
    youtube_topic: null, blog_post: null, youtube_script: null, notes: ''
  },
  {
    id: id(), trigger_id: newTriggers[7].id,
    trigger_title: newTriggers[7].title,
    trigger_source: 'reddit', trigger_category: 'DATA_POINT',
    trigger_url: newTriggers[7].url,
    generated_at: hoursAgo(23), status: 'review',
    formats: {
      linkedin: {
        content: `Solo PI attorney.\nCompetitive market.\nZero referrals.\n\nYear 1: $320K\nYear 4: $3.1M\n\nEvery single case from digital marketing.\n\nHere's the full channel breakdown:\n\nGoogle Ads: 45% of cases ($35K/mo spend by Year 4)\nSEO: 30% of cases (invested heavily in local + practice area pages)\nLSAs: 15% of cases (Google Screened = instant credibility)\nYouTube: 10% of cases (weekly educational videos)\n\nThe spending scaled with proof:\n→ Year 1: $4K/month (testing what works)\n→ Year 2: $12K/month (doubled down on winners)\n→ Year 3: $25K/month (systemized everything)\n→ Year 4: $35K/month (scaling what's proven)\n\nThe key insight: he didn't start with $35K/month. He started with $4K and PROVED it before scaling.\n\nMost firms either (a) spend too little to get meaningful data, or (b) scale before they know what works.\n\nThe formula:\n1. Start with $3-5K/month on Google Ads\n2. Track cost per signed case religiously\n3. Once you have a profitable channel, double it\n4. Add new channels one at a time\n5. Never scale what you can't measure\n\nFrom solo to $3.1M with zero referrals. Digital marketing works — if you treat it like a science, not a slot machine.\n\n#LawFirmGrowth #DigitalMarketing #PersonalInjury`,
        status: 'review', edited: false
      },
      x_single: {
        content: 'Solo PI attorney. Zero referrals. $320K → $3.1M in 4 years. All digital. Google Ads 45%, SEO 30%, LSAs 15%, YouTube 10%. Started at $4K/mo, scaled to $35K/mo. The key: prove it small, then double what works.',
        status: 'review', edited: false
      },
      x_thread: {
        content: [
          'A solo PI attorney built a $3.1M practice in 4 years. Zero referrals. Every single case came from digital marketing. Here\'s the full breakdown 🧵',
          'Revenue trajectory: Year 1 = $320K, Year 2 = $890K, Year 3 = $1.8M, Year 4 = $3.1M. Marketing spend scaled alongside: $4K/mo → $12K → $25K → $35K/mo.',
          'Channel mix at $3.1M: Google Ads = 45% of cases. SEO = 30%. Local Service Ads = 15%. YouTube = 10%. No referrals. No Avvo. No billboards. Pure digital.',
          'The Google Ads ramp: started with 3 campaigns targeting high-intent keywords. Tested for 90 days. Found that "car accident lawyer [city]" converted 3x better than "personal injury attorney." Doubled budget on winners, killed losers.',
          'SEO strategy: built dedicated pages for every practice area + city combination within a 50-mile radius. 47 landing pages total. Combined with aggressive Google Business Profile optimization and review generation.',
          'YouTube was the surprise winner for conversion quality. Weekly 5-minute educational videos. "What to do after a car accident in [state]." The leads who watched videos before calling had a 40% higher sign rate.',
          'The formula: (1) Start with $3-5K/mo on Google Ads, (2) Track cost per signed case, (3) Once profitable, double it, (4) Add channels one at a time, (5) Never scale what you can\'t measure. Treat marketing like a science, not a slot machine.'
        ],
        status: 'review', edited: false
      },
      short_video: {
        content: "HOOK: Solo PI attorney. Zero referrals. $320K to $3.1 million in four years.\n\n[PAUSE]\n\nEvery single case came from digital marketing.\n\nGoogle Ads: 45% of cases.\nSEO: 30%.\nLocal Service Ads: 15%.\nYouTube: 10%.\n\n[PAUSE]\n\nHe started at $4,000 a month. By year 4, he was spending $35,000 a month.\n\nBut here's the key — he didn't start at $35K. He proved it at $4K first.\n\n[PAUSE]\n\nThe formula: start small. Track cost per signed case. Once you have a profitable channel, double it. Add new channels one at a time.\n\nTreat marketing like a science. Not a slot machine.",
        status: 'review', edited: false
      }
    },
    image_prompt: 'Growth chart showing revenue from $320K to $3.1M over 4 years. Channel breakdown pie chart: Google Ads 45%, SEO 30%, LSA 15%, YouTube 10%. Professional data visualization.',
    image_url: null, blog_keyword: 'how to grow a law firm with digital marketing',
    youtube_topic: 'From $320K to $3.1M: How a Solo PI Firm Grew with Zero Referrals',
    blog_post: null, youtube_script: null, notes: ''
  },
  {
    id: id(), trigger_id: newTriggers[8].id,
    trigger_title: newTriggers[8].title,
    trigger_source: 'reddit', trigger_category: 'DATA_POINT',
    trigger_url: newTriggers[8].url,
    generated_at: hoursAgo(9), status: 'review',
    formats: {
      linkedin: {
        content: `Your Google Business Profile drives more calls than your website.\n\nYou just don't know it yet.\n\nA PI firm checked their call tracking data:\n\n→ GBP click-to-call: 47 calls/month\n→ Website (forms + phone): 31 calls/month\n\nTheir Google Business Profile generates 60% of all inbound calls. And they barely optimize it.\n\nMost firms treat their GBP like a set-it-and-forget-it directory listing.\n\nThat's like having a billboard on the busiest highway in town and never changing the message.\n\nHere's what the top firms do with GBP:\n\n1. Post weekly (Google rewards activity)\n2. Respond to EVERY review within 24 hours\n3. Add Q&As proactively (you can ask/answer your own)\n4. Upload photos monthly (office, team, results)\n5. Use the Products/Services section\n6. Track calls with UTM parameters\n\nGoogle Business Profile is free. It's local. It's where 90% of "lawyer near me" searches end up.\n\nIf you're spending $5K/month on SEO but ignoring your GBP, you're optimizing the wrong thing.\n\n#GoogleBusinessProfile #LocalSEO #LegalMarketing`,
        status: 'review', edited: false
      },
      x_single: {
        content: 'PI firm call tracking data: GBP = 47 calls/month. Website = 31 calls/month. Their Google Business Profile drives 60% of all inbound calls and they barely optimize it. Post weekly. Respond to every review. It\'s free and it\'s your biggest lead source.',
        status: 'review', edited: false
      },
      x_thread: {
        content: [
          'Your Google Business Profile probably drives more calls than your website. Most firms have no idea. Here\'s the data that should change your priorities 🧵',
          'A PI firm checked their call tracking: GBP click-to-call = 47 calls/month. Website forms + phone combined = 31 calls/month. Their GBP generates 60% of all inbound calls.',
          'And they barely optimize it. No weekly posts. Slow review responses. No Q&As. No recent photos. They treat it like a directory listing when it\'s actually their #1 lead source.',
          'What Whitespark\'s data shows: GBP signals now account for 36% of local ranking factors. Up from 32% last year. Reviews are the fastest-growing factor. Your GBP matters more than your website for local visibility.',
          'What top firms do with GBP: (1) Post weekly, (2) Respond to every review within 24 hours, (3) Add Q&As proactively, (4) Upload photos monthly, (5) Use Products/Services section, (6) Track calls with UTM parameters.',
          'Google Business Profile is free. It\'s local. It\'s where "lawyer near me" searches end up. If you\'re spending $5K/month on SEO but ignoring your GBP, you\'re optimizing the wrong thing.'
        ],
        status: 'review', edited: false
      },
      short_video: {
        content: "HOOK: Your Google Business Profile probably drives more calls than your website. And you're ignoring it.\n\n[PAUSE]\n\nA PI firm checked their call tracking. GBP click-to-call: 47 calls a month. Website: 31.\n\nSixty percent of their inbound calls come from their Google Business Profile. And they barely optimize it.\n\n[PAUSE]\n\nGoogle data shows GBP signals are now 36% of local ranking factors. More than your website. More than your links.\n\nYet most firms treat their GBP like a set-it-and-forget-it listing.\n\n[PAUSE]\n\nPost weekly. Respond to every review. Add Q&As. Upload photos.\n\nIt's free. It's your biggest lead source. Start treating it like one.",
        status: 'review', edited: false
      }
    },
    image_prompt: 'Google Business Profile card showing a law firm with 47 calls highlighted. Side-by-side comparison with website showing 31 calls. Map pins in the background.',
    image_url: null, blog_keyword: 'Google Business Profile optimization law firm',
    youtube_topic: null, blog_post: null, youtube_script: null, notes: ''
  },
  {
    id: id(), trigger_id: newTriggers[23].id,
    trigger_title: newTriggers[23].title,
    trigger_source: 'question', trigger_category: 'QUESTION',
    generated_at: hoursAgo(1), status: 'review',
    formats: {
      linkedin: {
        content: `"SEO or PPC first? Budget is $5K/month."\n\nI get this question every week.\n\nHere's the honest answer: it depends on how fast you need cases.\n\nNeed cases THIS month?\n→ Google Ads. $5K/month, you'll have leads in 48 hours.\n→ Expected: 15-30 leads/month for criminal defense\n→ Cost per lead: $170-330\n→ Close rate: 15-25% depending on intake\n\nCan you wait 6-12 months?\n→ SEO. Build the asset that compounds.\n→ Month 1-3: nothing visible happens\n→ Month 4-6: rankings start moving\n→ Month 7+: leads start flowing at near-zero marginal cost\n\nMy actual recommendation for a $5K budget:\n\n$3,500 → Google Ads (covers bills while SEO ramps)\n$1,500 → SEO (technical fixes + GBP optimization first)\n\nAfter 6 months, as SEO leads grow, shift budget:\n$2,500 → Google Ads\n$2,500 → SEO\n\nAfter 12 months:\n$1,500 → Google Ads (just the highest-ROI campaigns)\n$3,500 → SEO (compounding returns)\n\nThe mistake most firms make: putting all $5K into SEO, getting zero cases for 6 months, running out of patience, and concluding "digital marketing doesn't work."\n\nPPC buys you time. SEO builds you an asset. You need both.\n\n#SEO #PPC #LegalMarketing #LawFirmGrowth`,
        status: 'review', edited: false
      },
      x_single: {
        content: 'SEO or PPC first? With $5K/month: start $3,500 PPC + $1,500 SEO. PPC covers bills while SEO ramps. After 6 months shift toward SEO. PPC buys you time. SEO builds you an asset. You need both.',
        status: 'review', edited: false
      },
      x_thread: {
        content: [
          '"Should I start with SEO or PPC?" I get this question every week from law firm owners. Here\'s the honest answer most agencies won\'t give you 🧵',
          'If you need cases THIS month: Google Ads. $5K/month will get you 15-30 leads within 48 hours. Cost per lead for criminal defense: $170-330. Not cheap, but immediate.',
          'If you can wait 6-12 months: SEO compounds. Months 1-3 feel like nothing\'s happening. Months 4-6 rankings start moving. Month 7+ leads flow at near-zero marginal cost. The best ROI in marketing — but only if you survive the wait.',
          'My recommendation for a $5K budget: Month 1-6: $3,500 Google Ads + $1,500 SEO. PPC covers the bills while SEO ramps. After 6 months: shift to $2,500/$2,500 split. After 12 months: $1,500 PPC + $3,500 SEO.',
          'The mistake 90% of firms make: putting all $5K into SEO, getting zero cases for 6 months, running out of patience, and concluding "digital marketing doesn\'t work."',
          'PPC buys you time. SEO builds you an asset. You need both. The split just changes over time as SEO matures and starts generating its own leads.'
        ],
        status: 'review', edited: false
      },
      short_video: {
        content: "HOOK: SEO or PPC first? I get this question every single week.\n\n[PAUSE]\n\nHere's the honest answer.\n\nIf you need cases this month — Google Ads. $5K a month, you'll have leads in 48 hours.\n\nIf you can wait 6 to 12 months — SEO compounds. The best ROI in marketing. But you have to survive the wait.\n\n[PAUSE]\n\nMy actual recommendation: split it.\n\n$3,500 on Google Ads. $1,500 on SEO.\n\nPPC covers your bills while SEO ramps up. After 6 months, shift more toward SEO.\n\n[PAUSE]\n\nThe mistake? Putting everything into SEO, getting zero cases for 6 months, and quitting.\n\nPPC buys you time. SEO builds you an asset. You need both.",
        status: 'review', edited: false
      }
    },
    image_prompt: 'Timeline showing PPC (immediate results, bar chart) vs SEO (compounding curve over 12 months). Budget split visualization: 70/30 shifting to 30/70. Clean infographic.',
    image_url: null, blog_keyword: 'SEO vs PPC for law firms which first',
    youtube_topic: 'SEO vs PPC for Law Firms: Which Should You Invest in First?',
    blog_post: null, youtube_script: null, notes: ''
  },
  {
    id: id(), trigger_id: newTriggers[25].id,
    trigger_title: newTriggers[25].title,
    trigger_source: 'question', trigger_category: 'QUESTION',
    generated_at: hoursAgo(13), status: 'review',
    formats: {
      linkedin: {
        content: `"How many Google reviews do I need to rank in the local pack?"\n\nShort answer: more than your top 3 competitors.\n\nLong answer:\n\nA family law attorney in Dallas has 23 reviews (4.8 stars). Her top competitors have 80-200 reviews.\n\nShe's invisible in the local pack.\n\nHere's what the data says:\n\n→ In most legal markets, the local pack top 3 average 100+ reviews\n→ Review velocity matters as much as total count (5 reviews/month > 50 in one burst)\n→ 4.5-4.8 star average outperforms perfect 5.0 (people trust imperfect averages)\n→ Recency matters: reviews older than 12 months lose ranking weight\n\nHow to get there without being desperate:\n\n1. Ask at case resolution (they just won, emotions are high)\n2. Text, don't email (3x higher completion rate)\n3. Include a direct link to your Google review page\n4. Respond to every single review within 24 hours\n5. NEVER incentivize or buy reviews (Google will delist you)\n\nThe target: 5-10 new reviews per month consistently. Not 50 in January and 0 the rest of the year.\n\nReviews are the most important Google ranking factor you directly control. And they're free.\n\n#GoogleReviews #LocalSEO #LawFirmMarketing`,
        status: 'review', edited: false
      },
      x_single: {
        content: 'How many Google reviews to rank? More than your top 3 competitors. Most legal local packs: top 3 have 100+ reviews. Velocity > volume (5/month > 50 in one burst). Ask at case resolution. Text, don\'t email. Respond to every review.',
        status: 'review', edited: false
      },
      x_thread: {
        content: [
          '"How many Google reviews do I need?" Wrong question. The right question: how many more than my competitors? Here\'s the data 🧵',
          'In most legal markets, the top 3 in the local pack average 100+ reviews. If you have 23 and your competitors have 150, you\'re not competing. You\'re spectating.',
          'But total count isn\'t everything. Review velocity (how fast you get new reviews) matters as much. 5 reviews/month consistently beats 50 in one burst. Google rewards momentum.',
          'Star rating sweet spot: 4.5-4.8 outperforms 5.0. Why? People don\'t trust perfect scores. A few 4-star reviews actually increase trust. Don\'t panic over the occasional 3-star.',
          'How to get reviews without being desperate: (1) Ask at case resolution when emotions are high, (2) Send a text — 3x higher completion vs email, (3) Include a direct link to your Google review page, (4) Respond to every review within 24 hours.',
          'The target: 5-10 new reviews per month, consistently. And NEVER buy or incentivize reviews. Google will delist you. Organic consistency wins this game.'
        ],
        status: 'review', edited: false
      },
      short_video: {
        content: "HOOK: How many Google reviews do you need to rank in the local pack?\n\n[PAUSE]\n\nShort answer: more than your top three competitors.\n\nIn most legal markets, the top 3 in the local pack average over 100 reviews. If you have 23, you're not competing.\n\n[PAUSE]\n\nBut here's what most people get wrong. Total count isn't everything.\n\nReview velocity — how fast you get new reviews — matters just as much. 5 reviews a month, every month, beats 50 in one burst.\n\n[PAUSE]\n\nHow to get them: Ask at case resolution when emotions are high. Text, don't email — 3x higher completion rate. Respond to every single review.\n\nThe target: 5 to 10 new reviews per month. Consistently. That's the game.",
        status: 'review', edited: false
      }
    },
    image_prompt: 'Google review stars with count comparison: "23 reviews" vs "150 reviews" showing local pack ranking positions. Review velocity graph showing steady growth.',
    image_url: null, blog_keyword: 'how many Google reviews law firm local SEO',
    youtube_topic: null, blog_post: null, youtube_script: null, notes: ''
  },
  {
    id: id(), trigger_id: newTriggers[13].id,
    trigger_title: newTriggers[13].title,
    trigger_source: 'rss', trigger_category: 'DATA_POINT',
    generated_at: hoursAgo(10), status: 'review',
    formats: {
      linkedin: {
        content: `HubSpot analyzed 2.4 million social posts.\n\nFor professional services firms, video content gets 3.1x more engagement than text.\n\nShort-form video (under 90 seconds) outperformed long-form by 2.4x on LinkedIn.\n\nThe ideal LinkedIn video:\n→ 45-60 seconds\n→ Face-to-camera\n→ One key insight\n→ No fancy editing\n→ Captions (80% watch on mute)\n\nAnd yet...\n\n92% of law firms post text-only on LinkedIn.\n\nThe opportunity is wide open.\n\nYou don't need a production team. You need your phone and one thing worth saying.\n\nRecord it during your commute. Between meetings. After a client call that reminded you of a pattern.\n\nThe bar for "good enough" video is lower than you think. The bar for "better than your competitors" is almost on the floor.\n\n$0 budget. 60 seconds. Your face. Your expertise.\n\nThat beats a $5K branded graphic post every single time.\n\n#VideoMarketing #LinkedInVideo #LegalMarketing`,
        status: 'review', edited: false
      },
      x_single: {
        content: 'HubSpot data: video gets 3.1x more engagement than text for professional services. Short-form (under 90 seconds) beats long-form by 2.4x on LinkedIn. 92% of law firms post text-only. The opportunity is wide open.',
        status: 'review', edited: false
      },
      x_thread: {
        content: [
          'HubSpot analyzed 2.4 million social posts. For professional services, video gets 3.1x more engagement than text. And 92% of law firms still only post text. Here\'s the opportunity 🧵',
          'Short-form video (under 90 seconds) outperformed long-form by 2.4x on LinkedIn. The sweet spot: 45-60 seconds. Face-to-camera. One key insight. No fancy editing. Captions always (80% watch on mute).',
          'Why most attorneys don\'t post video: "I\'m not a content creator." "It seems unprofessional." "I don\'t have time." "I don\'t have equipment." All of these are myths holding you back.',
          'The reality: the bar for "good enough" video is your iPhone, natural lighting, and 60 seconds of expertise you share with clients every day. That\'s it.',
          'The bar for "better than your competitors" is even lower. Because 92% of them aren\'t doing video at all. You don\'t need to be great. You need to be present.',
          'One video per week. 60 seconds. One insight from your practice area. That\'s $0 budget and will outperform most law firms\' $5K/month social media strategies.'
        ],
        status: 'review', edited: false
      },
      short_video: {
        content: "HOOK: Video gets 3.1x more engagement than text for professional services. And 92% of law firms don't post video.\n\n[PAUSE]\n\nThat's from HubSpot's analysis of 2.4 million social posts.\n\nShort-form video — under 90 seconds — outperforms long-form by 2.4x on LinkedIn.\n\n[PAUSE]\n\nThe ideal LinkedIn video: 45 to 60 seconds. Your face. One insight. No fancy editing. Add captions because 80% watch on mute.\n\nYou don't need a production team. You need your phone.\n\n[PAUSE]\n\nThe bar for \"better than your competitors\" is almost on the floor. Because they're not doing this.\n\nOne video per week. 60 seconds. Start this week.",
        status: 'review', edited: false
      }
    },
    image_prompt: 'Phone in selfie mode recording an attorney. "3.1x" engagement multiplier shown prominently. Before/after: text post with low engagement vs video with high engagement. Clean social media style.',
    image_url: null, blog_keyword: 'video marketing for law firms LinkedIn',
    youtube_topic: null, blog_post: null, youtube_script: null, notes: ''
  },
  {
    id: id(), trigger_id: newTriggers[26].id,
    trigger_title: newTriggers[26].title,
    trigger_source: 'question', trigger_category: 'QUESTION',
    generated_at: hoursAgo(19), status: 'approved',
    formats: {
      linkedin: {
        content: `"Is TikTok appropriate for a law firm?"\n\nAn estate planning attorney asked me this last week.\n\nShort answer: yes — if you do it right.\n\nLong answer:\n\nThe lawyers crushing TikTok aren't dancing. They're teaching.\n\n"3 things you need in your will if you have kids"\n"What happens to your house if you die without a trust"\n"The biggest mistake I see in estate planning"\n\n60-second educational clips. Face to camera. Plain language.\n\nThe results speak:\n→ Estate planning attorney in Miami: 420K followers, 8-12 new consults/month directly from TikTok\n→ PI lawyer in Atlanta: 180K followers, average 5 signed cases/month from TikTok content repurposed to Instagram Reels\n→ Criminal defense in NYC: 1.2M followers, waitlist for consultations\n\nThe "unprofessional" concern is valid for 2020. In 2026, NOT being on short-form video is the unprofessional move.\n\nYour future clients are on TikTok. They're watching legal content. If it's not your content, it's your competitor's.\n\nStart with one 60-second video per week answering the #1 question your clients ask.\n\nThat's it. That's the strategy.\n\n#TikTokLawyer #LegalMarketing #VideoMarketing`,
        status: 'approved', edited: false
      },
      x_single: {
        content: 'Estate planning attorney on TikTok: 420K followers, 8-12 new consults/month. They\'re not dancing. They\'re teaching. "3 things you need in your will if you have kids." NOT being on short-form video in 2026 is the unprofessional move.',
        status: 'approved', edited: false
      },
      x_thread: {
        content: [
          '"Is TikTok appropriate for a law firm?" I get this question constantly. The lawyers who asked this 2 years ago and started anyway are now drowning in consultations. Here\'s why 🧵',
          'The attorneys crushing TikTok aren\'t dancing. They\'re teaching. "3 things you need in your will." "What happens if you die without a trust." "The biggest mistake I see in DUI cases." 60 seconds. Face to camera. Plain language.',
          'Results from real attorneys: Estate planning in Miami: 420K followers, 8-12 consults/month from TikTok. PI in Atlanta: 180K followers, 5 signed cases/month. Criminal defense in NYC: 1.2M followers, waitlist for consultations.',
          'The "unprofessional" concern was valid in 2020. In 2026, your future clients are already watching legal content on TikTok. If it\'s not yours, it\'s your competitor\'s.',
          'The strategy is absurdly simple: one 60-second video per week. Answer the #1 question your clients ask you. Film it on your phone. Post it. Repurpose to Instagram Reels and YouTube Shorts.',
          'Start ugly. Start imperfect. Start now. The attorneys who started 2 years ago aren\'t better on camera — they just started earlier. The best time was 2024. The second best time is today.'
        ],
        status: 'approved', edited: false
      },
      short_video: {
        content: "HOOK: Is TikTok appropriate for a law firm? Let me show you the numbers.\n\n[PAUSE]\n\nEstate planning attorney in Miami. 420,000 followers. 8 to 12 new consultations per month from TikTok.\n\nPI lawyer in Atlanta. 180,000 followers. 5 signed cases per month.\n\n[PAUSE]\n\nThey're not dancing. They're teaching.\n\n\"Three things you need in your will if you have kids.\" That's the content. 60 seconds. Face to camera. Plain language.\n\n[PAUSE]\n\nThe \"unprofessional\" concern was valid in 2020. In 2026, NOT being on short-form video is the unprofessional move.\n\nStart with one video per week. Answer the number one question your clients ask you.\n\nThat's the whole strategy.",
        status: 'approved', edited: false
      }
    },
    image_prompt: 'Phone screen showing TikTok interface with a professional attorney recording. Follower count "420K" and "8-12 consults/month" stat overlay. Clean, modern design.',
    image_url: null, blog_keyword: 'TikTok marketing for law firms',
    youtube_topic: 'TikTok for Law Firms: How Attorneys Are Getting 8-12 Consults/Month from 60-Second Videos',
    blog_post: null, youtube_script: null, notes: ''
  },
];

// ── MERGE INTO DATA FILES ──────────────────────────────────────

const existingTriggers = readJSON('trigger-queue.json');
const existingContent = readJSON('content.json');

const existingTriggerIds = new Set(existingTriggers.map(t => t.id));
const existingContentIds = new Set(existingContent.map(c => c.id));

let addedTriggers = 0;
let addedContent = 0;

for (const t of newTriggers) {
  if (!existingTriggerIds.has(t.id)) {
    existingTriggers.push(t);
    addedTriggers++;
  }
}

for (const c of newContent) {
  if (!existingContentIds.has(c.id)) {
    existingContent.push(c);
    addedContent++;
  }
}

writeJSON('trigger-queue.json', existingTriggers);
writeJSON('content.json', existingContent);

console.log(`\nSeed More Complete!`);
console.log(`==================`);
console.log(`Triggers: ${existingTriggers.length} total (+${addedTriggers} new)`);
console.log(`Content:  ${existingContent.length} total (+${addedContent} new)`);
console.log(`\nNew trigger sources:`);
console.log(`  Reddit:     ${newTriggers.filter(t => t.source === 'reddit').length}`);
console.log(`  RSS:        ${newTriggers.filter(t => t.source === 'rss').length}`);
console.log(`  YouTube:    ${newTriggers.filter(t => t.source === 'youtube').length}`);
console.log(`  Competitor: ${newTriggers.filter(t => t.source === 'competitor').length}`);
console.log(`  Questions:  ${newTriggers.filter(t => t.source === 'question').length}`);
console.log(`\nNew content pieces: ${newContent.length}`);
console.log(`  Approved: ${newContent.filter(c => c.status === 'approved').length}`);
console.log(`  Review:   ${newContent.filter(c => c.status === 'review').length}`);
