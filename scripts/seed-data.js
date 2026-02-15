#!/usr/bin/env node
/**
 * seed-data.js — Seeds realistic sample data for the content management dashboard.
 * Populates data/trigger-queue.json (18 triggers) and data/content.json (8 content pieces).
 *
 * Usage: node scripts/seed-data.js
 */

const { writeJSON, generateId, now } = require('../lib/utils');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hoursAgo(h) {
  return new Date(Date.now() - h * 3600 * 1000).toISOString();
}

function shortId(prefix) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 7; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return `${prefix}-${id}`;
}

// ---------------------------------------------------------------------------
// 18 Triggers
// ---------------------------------------------------------------------------

const triggers = [

  // =========================================================================
  // 5 REDDIT PAIN POINTS
  // =========================================================================
  {
    id: shortId('reddit'),
    source: 'reddit',
    source_detail: 'r/LawFirm',
    title: 'Spent $5K/month on Google Ads for my PI firm and got 2 cases',
    raw_content:
      'I have a 4-attorney PI firm in Dallas. We\'ve been running Google Ads with a local agency for 8 months now — $5,000/month ad spend plus $1,500/month management fee. In 8 months we\'ve signed exactly 9 cases from it. That\'s over $7,200 per signed case just in ad costs.\n\n' +
      'The agency keeps telling me "the campaigns are optimizing" and showing me reports with click-through rates and impressions. Cool. But I can\'t pay my associates with impressions. Last month we got 47 leads from the campaigns. 31 were junk — wrong practice area, already represented, or tire-kickers wanting free advice. Of the 16 real prospects, our intake team got 8 on the phone and signed 2.\n\n' +
      'I asked the agency what a good cost per signed case should be and they literally said "it depends." Am I getting fleeced here? What are other PI firms seeing for cost per acquisition from PPC? I\'m seriously considering just burning the Google Ads budget and putting it into SEO instead.\n\n' +
      'For context: Dallas is a competitive market but we\'re not trying to compete with the billboard firms. Just want steady mid-range cases — car accidents, slip and falls, premises liability.',
    url: 'https://example.com/r/LawFirm/comments/abc1234/spent_5k_month_google_ads_pi_firm',
    category: 'PAIN_POINT',
    engagement: { upvotes: 187, comments: 73 },
    captured_at: hoursAgo(6),
    status: 'pending',
    score: 0
  },
  {
    id: shortId('reddit'),
    source: 'reddit',
    source_detail: 'r/LawFirm',
    title: 'My web designer charges $300/mo and my site looks like it\'s from 2005',
    raw_content:
      'Solo family law attorney in Phoenix. I\'ve been paying this "web guy" $300/month for the last 3 years for website maintenance and "SEO." That\'s $10,800 I\'ve spent. My website still has a stock photo of a gavel on the homepage, loads in about 6 seconds on mobile, and when I Google "family law attorney Phoenix" I\'m nowhere in the first 5 pages.\n\n' +
      'I finally looked at Google Analytics for the first time (he never set it up — I did it myself last month) and the site gets 89 visitors per month. Eighty-nine. And most of them bounce in under 10 seconds.\n\n' +
      'What should I actually be looking for in a web provider? I don\'t need some $30K custom site. I just need something that looks professional, loads fast, shows up on Google, and actually converts visitors into calls. Is that really so hard?',
    url: 'https://example.com/r/LawFirm/comments/def5678/web_designer_charges_300_month',
    category: 'PAIN_POINT',
    engagement: { upvotes: 142, comments: 56 },
    captured_at: hoursAgo(14),
    status: 'pending',
    score: 0
  },
  {
    id: shortId('reddit'),
    source: 'reddit',
    source_detail: 'r/LawFirm',
    title: 'Fired my 3rd marketing agency this year — what am I doing wrong?',
    raw_content:
      'Criminal defense firm in Atlanta, 6 attorneys. I\'ve been through three marketing agencies in the last 11 months:\n\n' +
      'Agency 1 (Jan-Apr): Promised us "50 qualified leads per month." Got about 50 leads alright — 50 people wanting a public defender or asking if we do immigration. They were running our ads for criminal defense with broad match keywords. Fired after 4 months and $24K.\n\n' +
      'Agency 2 (May-Aug): Boutique legal marketing shop. Better leads, worse communication. I couldn\'t get my account manager on the phone. Monthly reports were 40-page PDFs full of vanity metrics. When I asked for cost-per-signed-case they said they "don\'t track downstream conversions." Fired after 4 months and $18K.\n\n' +
      'Agency 3 (Sep-Nov): The "we only do legal" agency. First month was great. Then they clearly handed us off to a junior. Copy quality tanked, they started reusing the same ad creative, and our cost per lead went from $85 to $210. Fired after 3 months and $15K.\n\n' +
      'I\'ve now spent $57K on agency fees this year with basically nothing to show for it. Is the problem me? Is there a way to actually vet these agencies before handing over a check?',
    url: 'https://example.com/r/LawFirm/comments/ghi9012/fired_3rd_marketing_agency_this_year',
    category: 'PAIN_POINT',
    engagement: { upvotes: 203, comments: 81 },
    captured_at: hoursAgo(28),
    status: 'pending',
    score: 0
  },
  {
    id: shortId('reddit'),
    source: 'reddit',
    source_detail: 'r/PersonalInjuryLawyer',
    title: 'Speed to lead is killing us — callers hang up after 30 seconds',
    raw_content:
      'We run a 3-attorney PI shop in Houston. Installed call tracking last month and the data is painful. We\'re spending $8K/month on Google Ads generating roughly 90 calls. Here\'s the breakdown:\n\n' +
      '- 34 calls went to voicemail (we were on other calls or it was after hours)\n- 22 calls rang for more than 30 seconds before someone picked up\n- Of those 22, only 9 stayed on the line\n- Average time to answer for our receptionist: 28 seconds\n\n' +
      'So basically 47 of our 90 paid calls — 52% — either went unanswered or the caller hung up waiting. At $89/call average cost, that\'s $4,183/month we\'re lighting on fire.\n\n' +
      'We can\'t afford a full-time after-hours receptionist. Anyone using an answering service or AI intake? What actually works? Our current setup of "hope someone\'s at the desk" clearly isn\'t cutting it.',
    url: 'https://example.com/r/PersonalInjuryLawyer/comments/jkl3456/speed_to_lead_killing_us',
    category: 'PAIN_POINT',
    engagement: { upvotes: 94, comments: 41 },
    captured_at: hoursAgo(52),
    status: 'pending',
    score: 0
  },
  {
    id: shortId('reddit'),
    source: 'reddit',
    source_detail: 'r/LawFirm',
    title: 'Just found out my marketing agency was running ads to the wrong zip codes for 6 months',
    raw_content:
      'I am livid. We\'re a workers\' comp firm in Chicago. We only handle cases in Illinois. I was reviewing our Google Ads account (something I should\'ve done months ago, I know) and discovered our agency had our location targeting set to "presence or interest in" instead of "presence in." Meaning anyone who Googled anything about Chicago workers comp — even from Florida — was seeing our ads.\n\n' +
      'It gets worse. The radius was set to 150 miles, which means we were also hitting parts of Indiana, Wisconsin, and Iowa. For a state-specific practice. For six months.\n\n' +
      'I pulled the geographic report and roughly 31% of our clicks came from outside Illinois. At $45/click average, that\'s about $8,100 in wasted spend over 6 months. The agency\'s response? "That\'s a default Google setting." Cool. I\'m paying you $2K/month to manage this and you left the defaults on?\n\n' +
      'This is why I have trust issues with agencies. Always audit your own accounts, people.',
    url: 'https://example.com/r/LawFirm/comments/mno7890/marketing_agency_wrong_zip_codes',
    category: 'PAIN_POINT',
    engagement: { upvotes: 156, comments: 62 },
    captured_at: hoursAgo(9),
    status: 'pending',
    score: 0
  },

  // =========================================================================
  // 4 RSS NEWS ITEMS
  // =========================================================================
  {
    id: shortId('rss'),
    source: 'rss',
    source_detail: 'Clio Blog',
    title: 'Clio Legal Trends Report: 67% of firms don\'t track marketing ROI',
    raw_content:
      'Clio\'s 2025 Legal Trends Report found that 67% of law firms surveyed do not track return on investment for their marketing spend. The report, based on aggregated data from over 90,000 legal professionals, also found that the average firm spends 7.2% of revenue on marketing — but only 12% of firms could identify their cost per signed client with confidence.\n\n' +
      'Other key findings: firms that tracked marketing ROI grew revenue 34% faster than those that didn\'t, and intake response time was the #1 predictor of lead conversion, outranking ad spend, website quality, and referral volume.',
    url: 'https://example.com/clio-blog/legal-trends-report-2025-marketing-roi',
    category: 'DATA_POINT',
    engagement: null,
    captured_at: hoursAgo(18),
    status: 'pending',
    score: 0
  },
  {
    id: shortId('rss'),
    source: 'rss',
    source_detail: 'ABA Journal',
    title: 'ABA: Average PI firm spends $124K on marketing annually',
    raw_content:
      'The American Bar Association\'s annual survey of legal marketing expenditures shows that the average personal injury firm with 3-10 attorneys spends $124,000 per year on marketing, up 18% from 2023. The biggest line items: Google Ads ($42K avg), SEO ($28K avg), website ($14K avg), and social media management ($11K avg).\n\n' +
      'The survey also found that firms spending above $100K/year on marketing reported an average cost per signed case of $1,850 for PI, $920 for family law, and $680 for criminal defense.',
    url: 'https://example.com/aba-journal/pi-firm-marketing-spend-2025',
    category: 'DATA_POINT',
    engagement: null,
    captured_at: hoursAgo(36),
    status: 'pending',
    score: 0
  },
  {
    id: shortId('rss'),
    source: 'rss',
    source_detail: 'National Law Review',
    title: 'National Law Review: AI is transforming how law firms acquire clients',
    raw_content:
      'A new analysis from National Law Review explores how AI tools are reshaping law firm client acquisition in 2025 and 2026. Key trends include AI-powered intake (reducing response times from minutes to seconds), predictive analytics for ad spend optimization, and automated follow-up sequences that have increased lead-to-client conversion rates by 23% at early-adopter firms.\n\n' +
      'The article cites case studies from three mid-size firms that implemented AI intake tools and saw cost per acquisition drop by 28-41% within 6 months, primarily from reduced lead leakage and faster speed to lead.',
    url: 'https://example.com/national-law-review/ai-transforming-client-acquisition-law-firms',
    category: 'NEWS',
    engagement: null,
    captured_at: hoursAgo(42),
    status: 'pending',
    score: 0
  },
  {
    id: shortId('rss'),
    source: 'rss',
    source_detail: 'Lawyerist',
    title: 'Lawyerist: The hidden cost of missed after-hours calls for law firms',
    raw_content:
      'New research from Lawyerist shows that law firms miss an average of 35% of inbound calls, with after-hours calls accounting for the largest share. For firms spending on paid advertising, the math is brutal: at a $75 average cost per call, a firm generating 120 calls/month loses roughly $3,150/month — $37,800/year — on calls that go to voicemail.\n\n' +
      'The data also shows that only 8% of callers who reach voicemail leave a message, and just 32% of those who leave a message are ever successfully called back and converted. The article argues that after-hours call coverage is the single highest-ROI investment most small firms can make.',
    url: 'https://example.com/lawyerist/hidden-cost-missed-after-hours-calls',
    category: 'DATA_POINT',
    engagement: null,
    captured_at: hoursAgo(55),
    status: 'pending',
    score: 0
  },

  // =========================================================================
  // 3 YOUTUBE CONTENT PIECES
  // =========================================================================
  {
    id: shortId('youtube'),
    source: 'youtube',
    source_detail: 'Chris Dreyer — Rankings.io',
    title: 'Chris Dreyer: How I Built a $10M Legal Marketing Agency',
    raw_content:
      'Chris Dreyer, founder of Rankings.io, breaks down his journey from solo SEO consultant to running a $10M/year legal marketing agency. Key takeaways: (1) He niched down to PI-only SEO and that specificity was the growth lever, (2) The firms getting the best ROI are the ones that invest in both SEO and paid simultaneously — not one or the other, (3) The average Rankings.io client sees breakeven on SEO at month 7-9, and (4) The #1 reason firms churn from agencies is lack of transparent reporting on cost per signed case, not lack of results.',
    url: 'https://example.com/youtube/watch?v=dreyer-10m-legal-agency',
    category: 'CONTENT_PIECE',
    engagement: { views: 34200, likes: 1870 },
    captured_at: hoursAgo(20),
    status: 'pending',
    score: 0
  },
  {
    id: shortId('youtube'),
    source: 'youtube',
    source_detail: 'Alex Hormozi',
    title: 'Alex Hormozi: Why Most Service Businesses Fail at Lead Gen',
    raw_content:
      'Hormozi explains why most service businesses (including law firms) waste money on lead generation: they optimize for lead volume instead of lead quality, they don\'t track full-funnel metrics, and they have no systematic follow-up process. His framework: (1) Define your "dream 100" referral sources, (2) Calculate your max allowable cost per acquisition and work backward, (3) Build a "no lead left behind" follow-up system that contacts every lead 7+ times across 3+ channels, (4) Stop measuring marketing by leads and start measuring by revenue generated per dollar spent.',
    url: 'https://example.com/youtube/watch?v=hormozi-service-lead-gen',
    category: 'CONTENT_PIECE',
    engagement: { views: 289000, likes: 18400 },
    captured_at: hoursAgo(32),
    status: 'pending',
    score: 0
  },
  {
    id: shortId('youtube'),
    source: 'youtube',
    source_detail: 'Law Firm Mentor',
    title: 'How a Solo PI Attorney Went from $200K to $2M Revenue',
    raw_content:
      'Interview with a solo PI attorney in Tampa who scaled from $200K to $2M in revenue over 3 years. Her playbook: (1) Spent $0 on ads the first year — built referral relationships with 40 chiropractors and 20 body shops, (2) Year 2: Added Google Ads at $3K/month, hired a virtual receptionist for $400/month, signed 4x more cases just from answering the phone, (3) Year 3: Invested in SEO, started a YouTube channel reviewing local accident intersections, and hired a case manager so she could focus on intake and marketing. Key quote: "The phone is the most expensive thing in your office. Every missed call is a missed case."',
    url: 'https://example.com/youtube/watch?v=solo-pi-200k-to-2m',
    category: 'CLIENT_WIN',
    engagement: { views: 12800, likes: 940 },
    captured_at: hoursAgo(48),
    status: 'pending',
    score: 0
  },

  // =========================================================================
  // 3 GENERAL QUESTIONS
  // =========================================================================
  {
    id: shortId('question'),
    source: 'reddit',
    source_detail: 'r/LawFirm',
    title: 'How much should a PI firm spend on marketing?',
    raw_content:
      'Starting my own PI practice next month after 8 years at a big firm. I have about $150K in savings earmarked for the first year. Everyone keeps telling me I need to spend on marketing but the numbers I\'m hearing are all over the place — anywhere from $2K/month to $20K/month.\n\n' +
      'For a solo PI attorney in a mid-size market (think Raleigh, NC level of competition), what should I realistically budget for marketing in year one? And what should I spend it on? I keep hearing SEO takes 6-12 months to kick in, so should I start with PPC and transition?',
    url: 'https://example.com/r/LawFirm/comments/pqr1234/how_much_pi_firm_spend_marketing',
    category: 'QUESTION',
    engagement: { upvotes: 67, comments: 34 },
    captured_at: hoursAgo(11),
    status: 'pending',
    score: 0
  },
  {
    id: shortId('question'),
    source: 'reddit',
    source_detail: 'r/FamilyLaw',
    title: 'What\'s a good cost per signed case for a family law firm?',
    raw_content:
      'We\'re a 2-attorney family law firm in Denver. Running Google Ads and doing some SEO. Our Google Ads are generating leads at about $120/lead, and we\'re converting roughly 1 in 8 to signed clients. So our cost per signed case from PPC is around $960.\n\n' +
      'Is that good? Bad? I have no frame of reference. What are other family law firms seeing? And does the math work differently for high-asset divorce vs. standard custody cases?',
    url: 'https://example.com/r/FamilyLaw/comments/stu5678/good_cost_per_signed_case_family_law',
    category: 'QUESTION',
    engagement: { upvotes: 43, comments: 28 },
    captured_at: hoursAgo(25),
    status: 'pending',
    score: 0
  },
  {
    id: shortId('question'),
    source: 'reddit',
    source_detail: 'r/LawFirm',
    title: 'Should I do SEO or PPC first for my law firm?',
    raw_content:
      'New solo estate planning attorney in Portland. Limited budget — about $2,500/month total for marketing. Everyone says "you need both SEO and PPC" but I can\'t afford both right now. Which should I start with?\n\n' +
      'My understanding: PPC = immediate leads but expensive and they stop when you stop paying. SEO = cheaper long-term but takes 6-12 months to see results. Is that accurate? For a new firm that needs cases NOW, does PPC make more sense initially even if the long-term play is SEO?',
    url: 'https://example.com/r/LawFirm/comments/uvw9012/seo_or_ppc_first_law_firm',
    category: 'QUESTION',
    engagement: { upvotes: 52, comments: 39 },
    captured_at: hoursAgo(60),
    status: 'pending',
    score: 0
  },

  // =========================================================================
  // 3 COMPETITOR CONTENT / DATA PIECES
  // =========================================================================
  {
    id: shortId('rss'),
    source: 'rss',
    source_detail: 'Rankings.io Blog',
    title: 'Rankings.io: The Ultimate Guide to Law Firm SEO in 2026',
    raw_content:
      'Rankings.io published a comprehensive 8,000-word guide covering law firm SEO strategy for 2026. Key insights: (1) Google\'s AI Overviews are reducing organic click-through rates by 15-30% for informational queries but actually increasing CTR for "near me" and high-intent local queries by 8%, (2) Firms with 50+ Google reviews convert website visitors to calls at 2.3x the rate of firms with under 20 reviews, (3) The average time to rank a new law firm website on page 1 for a city-level keyword is now 9-14 months, up from 6-9 months in 2023, and (4) Local service ads (LSAs) are now generating 40% of all paid leads for PI firms, up from 22% in 2024.',
    url: 'https://example.com/rankings-io/ultimate-guide-law-firm-seo-2026',
    category: 'CONTENT_PIECE',
    engagement: null,
    captured_at: hoursAgo(15),
    status: 'pending',
    score: 0
  },
  {
    id: shortId('rss'),
    source: 'rss',
    source_detail: 'Crisp Video Blog',
    title: 'Crisp Video: Why Video is the #1 Way to Get PI Cases in 2026',
    raw_content:
      'Crisp Video Group argues that video content is now the highest-ROI marketing channel for personal injury firms. Their data from 300+ law firm clients shows: (1) Firms with video on their homepage see 41% more consultation requests, (2) YouTube channels with 20+ videos generate an average of 8 inbound leads per month, (3) Video testimonials increase conversion rates by 34% compared to text testimonials, (4) The average production cost of $2,500-$5,000 per video pays for itself within 60 days through increased conversions.',
    url: 'https://example.com/crisp-video/video-number-one-pi-cases-2026',
    category: 'CONTENT_PIECE',
    engagement: null,
    captured_at: hoursAgo(38),
    status: 'pending',
    score: 0
  },
  {
    id: shortId('rss'),
    source: 'rss',
    source_detail: 'Smith.ai Blog',
    title: 'Smith.ai: 35% of law firm calls happen after business hours',
    raw_content:
      'Smith.ai\'s analysis of 1.2 million inbound calls to law firms reveals that 35% of calls arrive outside standard business hours (before 9am or after 5pm). For personal injury firms specifically, the after-hours rate is even higher at 42%, likely because accident victims are calling from ERs and homes in the evening.\n\n' +
      'The study also found that law firms using live answering services captured 3.2x more after-hours leads than firms relying on voicemail, and that the average lifetime value of an after-hours PI lead was $4,200 — making the $3-5 per call cost of answering services a 1,000%+ ROI.',
    url: 'https://example.com/smith-ai/35-percent-law-firm-calls-after-hours',
    category: 'DATA_POINT',
    engagement: null,
    captured_at: hoursAgo(44),
    status: 'pending',
    score: 0
  }
];

// ---------------------------------------------------------------------------
// 8 Content Pieces (linked to first 8 triggers)
// ---------------------------------------------------------------------------

const contentPieces = [

  // ---- Content 1: Reddit $5K Google Ads ----
  {
    id: generateId(),
    trigger_id: triggers[0].id,
    trigger_title: triggers[0].title,
    trigger_source: triggers[0].source,
    trigger_category: triggers[0].category,
    trigger_url: triggers[0].url,
    generated_at: hoursAgo(5),
    status: 'approved',
    formats: {
      linkedin: {
        content:
          'A PI firm owner in Dallas just shared his Google Ads numbers.\n\n' +
          '$5,000/month ad spend.\n$1,500/month agency fee.\n8 months running.\n\n' +
          'Result: 9 signed cases.\n\n' +
          'That\'s $7,200 per signed case in ad costs alone.\n\n' +
          'Here\'s the part that kills me — they got 47 leads last month. But 31 were junk. Wrong practice area. Already represented. Tire-kickers wanting free advice.\n\n' +
          'Of the 16 real prospects:\n- 8 answered the phone\n- 2 signed\n\n' +
          'The agency\'s response when asked about cost per case? "It depends."\n\n' +
          'This is the #1 problem in legal marketing right now. Agencies optimize for leads. Firms need signed cases.\n\n' +
          'The gap between those two metrics is where firms bleed money.\n\n' +
          '3 things every firm should demand from their agency:\n\n' +
          '1. Cost per SIGNED CASE, not cost per lead\n2. Lead quality scoring (what % are junk?)\n3. Full-funnel tracking from click to retainer\n\n' +
          'If your agency can\'t give you these numbers, they\'re hiding something.\n\n' +
          '#LegalMarketing #LawFirmGrowth #GoogleAds #PersonalInjury',
        status: 'approved',
        edited: false
      },
      x_single: {
        content: 'PI firm spent $52K on Google Ads in 8 months. Signed 9 cases. That\'s $5,800/case. Agency\'s response: "It depends." If your agency can\'t tell you your cost per SIGNED case, fire them.',
        status: 'approved',
        edited: false
      },
      x_thread: {
        content: [
          'A PI firm owner just posted his Google Ads numbers and they\'re brutal. $5K/month spend + $1,500/month agency fee for 8 months. Result: 9 signed cases. Let me break down what went wrong 🧵',
          '47 leads came in last month. Sounds decent, right? But 31 were JUNK — wrong practice area, already represented, tire-kickers. That\'s a 66% junk rate. The agency counted all 47 as "leads" in their report.',
          'Of the 16 real prospects, the intake team reached 8 by phone. Signed 2. So the real funnel: 47 "leads" → 16 qualified → 8 contacted → 2 signed. That\'s a 4.3% lead-to-client rate.',
          'The agency showed reports full of impressions, CTR, and quality scores. Classic vanity metrics. The owner asked for cost per signed case. Agency said: "It depends." That phrase is a red flag the size of Texas.',
          'Here\'s what $7,200/case actually means: For a firm that settles average PI cases at $15-25K in fees, they\'re spending 30-48% of revenue on just ONE acquisition channel. The math doesn\'t work.',
          'The fix: (1) Demand cost-per-signed-case reporting, (2) Audit lead quality weekly, (3) Track speed-to-lead — if your intake team takes 30+ seconds to answer, you\'re losing 40% of paid leads before they start.',
          'Bottom line: Spending $5K/month on ads without tracking cost per signed case is like driving with your eyes closed. The dashboard looks fine until you hit the wall.'
        ],
        status: 'approved',
        edited: false
      },
      short_video: {
        content:
          'HOOK: A law firm owner just spent $52,000 on Google Ads and signed 9 cases.\n\n' +
          '[PAUSE]\n\n' +
          'That\'s $5,800 per signed case.\n\n' +
          'Here\'s what happened. They got 47 leads last month. Sounds good, right?\n\n' +
          '[PAUSE]\n\n' +
          '31 were junk. Wrong practice area. Tire-kickers. Already had a lawyer.\n\n' +
          'Of the 16 real leads, only 8 picked up the phone. They signed 2.\n\n' +
          '[PAUSE]\n\n' +
          'When the firm asked their agency for cost per signed case, the agency said — and I quote — "it depends."\n\n' +
          'That phrase is the biggest red flag in legal marketing.\n\n' +
          '[PAUSE]\n\n' +
          'If your agency can\'t tell you exactly what a signed case costs, they\'re optimizing for THEIR metrics, not yours.\n\n' +
          'Demand three numbers: cost per signed case, lead quality percentage, and speed to lead time.\n\n' +
          'That\'s it. Those three numbers tell you everything.',
        status: 'approved',
        edited: false
      }
    },
    image_prompt: 'Minimalist data visualization showing a marketing funnel with dramatic drop-off at each stage. Clean dark background, bright accent colors. Numbers floating: 47 leads, 16 qualified, 8 contacted, 2 signed. Professional, modern, slightly dramatic.',
    image_url: null, // will be generated by Ideogram
    blog_keyword: 'law firm google ads cost per case',
    youtube_topic: 'Why Your Google Ads Cost Per Case Is Too High (And How to Fix It)',
    blog_post: null,
    youtube_script: null,
    notes: ''
  },

  // ---- Content 2: Web designer $300/mo ----
  {
    id: generateId(),
    trigger_id: triggers[1].id,
    trigger_title: triggers[1].title,
    trigger_source: triggers[1].source,
    trigger_category: triggers[1].category,
    trigger_url: triggers[1].url,
    generated_at: hoursAgo(12),
    status: 'review',
    formats: {
      linkedin: {
        content:
          'A solo family law attorney has been paying $300/month for website "maintenance" and "SEO" for 3 years.\n\n' +
          'Total spent: $10,800.\n\n' +
          'The results:\n' +
          '→ Stock gavel photo on the homepage\n' +
          '→ 6-second load time on mobile\n' +
          '→ 89 visitors per month\n' +
          '→ Not on the first 5 pages of Google for their main keyword\n' +
          '→ Google Analytics was never set up (she did it herself)\n\n' +
          'This is more common than you think.\n\n' +
          'There are thousands of "web guys" charging law firms $200-500/month for websites that actively lose them money. A 6-second mobile load time means 53% of visitors leave before the site even renders.\n\n' +
          'At 89 visits/month with a typical 3% conversion rate, that\'s 2-3 potential leads. Per month. For $300.\n\n' +
          'What a law firm website actually needs:\n\n' +
          '1. Under 3 seconds load time (ideally under 2)\n2. Click-to-call button above the fold on mobile\n3. City + practice area in the H1 tag\n4. Google Business Profile linked and optimized\n5. 10+ real Google reviews\n\n' +
          'That\'s it. No fancy animations. No stock gavels. Just fast, clear, and findable.\n\n' +
          '#LegalMarketing #LawFirmWebsite #WebDesign',
        status: 'review',
        edited: false
      },
      x_single: {
        content: 'Solo attorney paid $300/mo for 3 years for website "SEO." Result: 89 visitors/month, 6-sec load time, stock gavel homepage. $10,800 spent. No analytics installed. Your web guy isn\'t doing SEO. He\'s doing invoicing.',
        status: 'review',
        edited: false
      },
      x_thread: {
        content: [
          'A family law attorney just realized she\'s been paying $300/month for 3 years for a website that gets 89 visitors per month. Here\'s the full breakdown of what $10,800 bought her 🧵',
          'The site: stock gavel photo, 6-second mobile load time, not ranking in the first 5 pages of Google, and — here\'s the kicker — Google Analytics was never set up. She installed it herself last month.',
          'At 89 visits/month with a 3% conversion rate, that\'s maybe 2-3 leads per month. She\'s paying $100-150 per potential lead just in website costs. Before a single ad dollar.',
          'A 6-second mobile load time is a conversion killer. Google\'s own data: 53% of mobile visitors leave if a page takes more than 3 seconds to load. Her site was losing half its visitors before they even saw the content.',
          'What a law firm website ACTUALLY needs: (1) Under 3-sec load time, (2) Click-to-call above fold on mobile, (3) City + practice area in the page title, (4) Optimized Google Business Profile, (5) 10+ real reviews. That\'s the whole list.',
          'The real lesson: if your "web guy" has never shown you Google Analytics data, never discussed your load speed, and never mentioned your Google Business Profile — you don\'t have a web strategist. You have an invoice generator.'
        ],
        status: 'review',
        edited: false
      },
      short_video: {
        content:
          'HOOK: A lawyer paid $10,800 for a website that gets 89 visitors per month.\n\n' +
          '[PAUSE]\n\n' +
          '$300 a month. For 3 years. For "maintenance and SEO."\n\n' +
          'Here\'s what $10,800 got her:\n\n' +
          'A stock photo of a gavel on the homepage.\n\n' +
          '[PAUSE]\n\n' +
          'A 6-second load time on mobile — which means half her visitors leave before the site even loads.\n\n' +
          'She\'s not on the first FIVE pages of Google for "family law attorney Phoenix."\n\n' +
          '[PAUSE]\n\n' +
          'And the best part? Google Analytics was never installed. She set it up herself last month.\n\n' +
          'Your law firm website needs 5 things: fast load time, click-to-call button, local keywords, Google Business Profile, and real reviews.\n\n' +
          '[PAUSE]\n\n' +
          'That\'s it. Everything else is a gavel-shaped distraction.',
        status: 'rejected',
        edited: false
      }
    },
    image_prompt: 'Split-screen comparison: left side shows an outdated, slow-loading website with a gavel stock photo and loading spinner. Right side shows a clean, modern law firm website on mobile with a prominent call button. Minimalist style, professional colors.',
    image_url: null,
    blog_keyword: 'law firm website cost how much should you pay',
    youtube_topic: null,
    blog_post: null,
    youtube_script: null,
    notes: ''
  },

  // ---- Content 3: Fired 3rd marketing agency ----
  {
    id: generateId(),
    trigger_id: triggers[2].id,
    trigger_title: triggers[2].title,
    trigger_source: triggers[2].source,
    trigger_category: triggers[2].category,
    trigger_url: triggers[2].url,
    generated_at: hoursAgo(26),
    status: 'review',
    formats: {
      linkedin: {
        content:
          'A criminal defense firm fired 3 marketing agencies this year.\n\n' +
          'Total damage: $57,000.\n\n' +
          'Here\'s what went wrong at each one:\n\n' +
          'Agency 1 (4 months, $24K):\n' +
          'Promised 50 qualified leads/month. Got 50 leads — but they were people wanting public defenders and asking about immigration. Broad match keywords. No negative keyword list.\n\n' +
          'Agency 2 (4 months, $18K):\n' +
          'Better leads. Zero communication. Monthly reports were 40-page PDFs of vanity metrics. When asked for cost per signed case: "We don\'t track downstream conversions." That\'s not a reporting gap. That\'s a philosophy problem.\n\n' +
          'Agency 3 (3 months, $15K):\n' +
          'Great first month. Then they handed the account to a junior. Ad creative got recycled. Cost per lead went from $85 to $210. The classic bait-and-switch.\n\n' +
          'The pattern across all 3:\n\n' +
          '→ None tracked cost per SIGNED case\n' +
          '→ None audited lead quality\n' +
          '→ None had skin in the game\n\n' +
          'Before hiring your next agency, ask:\n' +
          '1. What\'s my current cost per signed case and what will you get it to?\n' +
          '2. Who specifically will manage my account?\n' +
          '3. How do you define a "qualified lead"?\n\n' +
          'If they can\'t answer all 3 clearly — walk.\n\n' +
          '#LegalMarketing #AgencyLife #LawFirmGrowth',
        status: 'review',
        edited: false
      },
      x_single: {
        content: '$57K on 3 agencies in one year. Zero cost-per-case tracking. Agency 1: junk leads. Agency 2: vanity metrics. Agency 3: bait-and-switch. The pattern: none tracked what actually matters — signed cases.',
        status: 'review',
        edited: false
      },
      x_thread: {
        content: [
          'A criminal defense firm burned through 3 marketing agencies in 11 months. $57,000 spent. Here\'s the post-mortem on each one — and the 3 questions that would\'ve prevented all of it 🧵',
          'Agency 1 — Jan to Apr, $24K: Promised 50 "qualified" leads/month. Delivered 50 leads alright. People wanting public defenders. Immigration questions. The agency was running broad match keywords with zero negatives.',
          'Agency 2 — May to Aug, $18K: Lead quality improved. Communication was nonexistent. Monthly reports were 40-page PDFs of impressions and CTR. When the firm asked for cost per signed case, the agency said "we don\'t track downstream conversions." Instant red flag.',
          'Agency 3 — Sep to Nov, $15K: First month was great. Senior strategist on the account, sharp copy, good results. Month 2: handed off to a junior. Cost per lead jumped from $85 to $210. Same recycled ad creative. Classic bait-and-switch.',
          'The pattern across all 3: (1) None tracked cost per signed case, (2) None audited lead quality, (3) None gave the firm visibility into what was actually happening in the ad accounts.',
          'Before hiring your next agency, demand clear answers to these 3 questions: What\'s my target cost per signed case? Who specifically is managing my account? How do you define "qualified lead"? No clear answers = no contract.',
          'The $57K lesson: the best agency in the world can\'t help you if you don\'t know what numbers to hold them accountable for. Track cost per signed case from day one. Everything else is a vanity metric.'
        ],
        status: 'review',
        edited: false
      },
      short_video: {
        content:
          'HOOK: $57,000 on marketing agencies. Three agencies fired in one year. Zero signed cases to show for it.\n\n' +
          '[PAUSE]\n\n' +
          'Here\'s the pattern.\n\n' +
          'Agency one: $24K in 4 months. They promised 50 qualified leads. They delivered 50 people who wanted a public defender.\n\n' +
          '[PAUSE]\n\n' +
          'Agency two: $18K in 4 months. Better leads. But when the firm asked for cost per signed case, the agency said — quote — "we don\'t track downstream conversions."\n\n' +
          '[PAUSE]\n\n' +
          'Agency three: $15K in 3 months. Great first month. Then they handed the account to a junior and cost per lead jumped from $85 to $210.\n\n' +
          '[PAUSE]\n\n' +
          'The problem wasn\'t the agencies. The problem was the firm didn\'t know what to hold them accountable for.\n\n' +
          'Three questions. Before you sign with any agency. What\'s my target cost per signed case? Who\'s actually managing my account? How do you define qualified?\n\n' +
          'If they can\'t answer all three — walk.',
        status: 'review',
        edited: false
      }
    },
    image_prompt: 'Three red "X" marks over agency contract documents, arranged in sequence (Jan, May, Sep). Money burning visual metaphor. $57K figure prominent. Clean, editorial style infographic. Dark background, red and white accents.',
    image_url: null,
    blog_keyword: 'how to vet a legal marketing agency',
    youtube_topic: 'How to Vet a Legal Marketing Agency (Before Wasting $57K)',
    blog_post:
      '# How to Vet a Legal Marketing Agency (Before Wasting $57K)\n\n' +
      'A criminal defense firm in Atlanta just shared a story that every law firm owner needs to hear.\n\n' +
      'In 11 months, they hired and fired three marketing agencies. Total spent: $57,000. Total signed cases attributable to those agencies: essentially zero.\n\n' +
      'This isn\'t an outlier. In our experience working with hundreds of law firms, the average firm goes through 2.4 agencies before finding one that actually delivers. Each failed engagement costs $12-25K in fees and 3-4 months of lost momentum.\n\n' +
      'Here\'s what went wrong — and the exact framework you can use to avoid making the same $57K mistake.\n\n' +
      '## The Three Failures\n\n' +
      '### Agency 1: The Lead Volume Trap ($24K, 4 months)\n\n' +
      'The agency promised 50 qualified leads per month. They delivered on the number — but not the qualifier. The "leads" were people looking for public defenders, immigration attorneys, and free legal advice. The agency was running Google Ads on broad match keywords with no negative keyword list.\n\n' +
      '**The lesson:** "Leads" without quality controls are just expensive noise. Any agency promising a specific lead count without defining what qualifies as a lead is selling volume, not value.\n\n' +
      '### Agency 2: The Vanity Metrics Problem ($18K, 4 months)\n\n' +
      'Better leads. Terrible communication. Monthly reports were 40-page PDFs packed with impressions, click-through rates, and quality scores — metrics that tell you absolutely nothing about business performance.\n\n' +
      'When the firm asked for cost per signed case, the agency said: "We don\'t track downstream conversions."\n\n' +
      'Translation: We have no idea if our work is making you money.\n\n' +
      '**The lesson:** If an agency can\'t report on cost per signed case, they\'re optimizing for their metrics (impressions, clicks, leads) instead of yours (revenue, cases, growth).\n\n' +
      '### Agency 3: The Bait-and-Switch ($15K, 3 months)\n\n' +
      'The first month was excellent. Senior strategist on the account, sharp copy, creative ad angles, strong results. Month two: the senior strategist disappeared. A junior associate took over. Ad creative got recycled. Cost per lead jumped from $85 to $210.\n\n' +
      '**The lesson:** Ask who will manage your account day-to-day. Get it in the contract. If they swap your account manager, you should have the right to exit.\n\n' +
      '## The 3-Question Framework\n\n' +
      'Before signing with any legal marketing agency, demand clear, specific answers to these three questions:\n\n' +
      '### 1. "What\'s my target cost per signed case, and how will you track it?"\n\n' +
      'A good agency will answer with a specific number based on your practice area and market. For example: "For criminal defense in Atlanta, we typically see $600-900 per signed case from PPC within 6 months."\n\n' +
      'A bad agency will say "it depends" or pivot to talking about leads and impressions.\n\n' +
      '### 2. "Who specifically will manage my account, and what happens if they leave?"\n\n' +
      'You should know the first name, experience level, and current client load of the person managing your campaigns. If they have 40 other clients, you\'re not getting attention. Get a clause in your contract about account manager changes.\n\n' +
      '### 3. "How do you define a qualified lead?"\n\n' +
      'The definition should be specific: "A phone call or form submission from someone in your service area who needs criminal defense representation and has the ability to pay." Not "anyone who clicks on your ad."\n\n' +
      '## The Bottom Line\n\n' +
      'The firm that spent $57K on three failed agencies didn\'t have an agency problem. They had an accountability problem. They didn\'t know what numbers to track, what questions to ask, or what benchmarks to hold agencies to.\n\n' +
      'That\'s fixable. Start with cost per signed case. Everything else follows from that single metric.\n\n' +
      '---\n\n' +
      '*Track the metrics that matter. Your agency should be able to tell you exactly what a signed case costs — not hide behind impressions and click-through rates.*\n',
    youtube_script: null,
    notes: ''
  },

  // ---- Content 4: Speed to lead ----
  {
    id: generateId(),
    trigger_id: triggers[3].id,
    trigger_title: triggers[3].title,
    trigger_source: triggers[3].source,
    trigger_category: triggers[3].category,
    trigger_url: triggers[3].url,
    generated_at: hoursAgo(50),
    status: 'review',
    formats: {
      linkedin: {
        content:
          'A PI firm installed call tracking last month.\n\n' +
          'The data is brutal.\n\n' +
          '90 calls from Google Ads.\n' +
          '34 went to voicemail.\n' +
          '22 rang for 30+ seconds — only 9 waited.\n\n' +
          'That\'s 47 out of 90 calls — 52% — either unanswered or abandoned.\n\n' +
          'At $89 per call, they\'re wasting $4,183 every month on calls nobody picks up.\n\n' +
          'Here\'s what most firms don\'t realize:\n\n' +
          'Your phone is your most expensive marketing asset. Not your website. Not your ads. The phone.\n\n' +
          'Because every dollar you spend on marketing eventually funnels to a phone call. And if nobody answers within 15 seconds, you just paid for a lead you\'ll never get back.\n\n' +
          'The fix isn\'t complicated:\n\n' +
          '1. Measure time-to-answer (most firms have no idea)\n2. Set a 10-second answer target\n3. Add overflow coverage (virtual receptionist, AI intake, or after-hours service)\n4. Track missed call recovery rate\n\n' +
          'The math: If this firm recovered even half their missed calls, that\'s ~24 more conversations/month. At a 25% conversion rate, that\'s 6 additional signed cases. Per month.\n\n' +
          'Speed to lead isn\'t a buzzword. It\'s where $50K/year goes to die.\n\n' +
          '#SpeedToLead #LegalMarketing #LawFirmGrowth #Intake',
        status: 'review',
        edited: false
      },
      x_single: {
        content: '52% of a PI firm\'s paid calls went unanswered last month. 34 to voicemail. 13 hung up waiting. At $89/call that\'s $4,183/month evaporating. Your phone is your most expensive marketing asset.',
        status: 'review',
        edited: false
      },
      x_thread: {
        content: [
          'A PI firm installed call tracking and the data should terrify every law firm owner. 90 calls from Google Ads. 52% were either unanswered or abandoned. Here\'s the full breakdown 🧵',
          'The numbers: 34 calls went to voicemail (after hours or staff busy). 22 calls rang for 30+ seconds before someone picked up. Of those 22, only 9 stayed on the line. The other 13 hung up.',
          'Total: 47 out of 90 calls — wasted. At $89/call average from Google Ads, that\'s $4,183/month burning. $50,196/year. On calls they\'re paying for but never answering.',
          'And here\'s the thing most firms miss: only 8% of callers who reach voicemail actually leave a message. And only 32% of those messages ever convert. Voicemail isn\'t a backup plan. It\'s a black hole.',
          'The average law firm receptionist takes 28 seconds to answer. Studies show 40% of callers hang up after 20 seconds. Your speed to answer IS your conversion rate.',
          'The fix: (1) Measure your actual time-to-answer, (2) Set a 10-second target, (3) Add overflow/after-hours coverage — virtual receptionist, AI intake, anything that breathes, (4) Track missed call recovery weekly.',
          'Back-of-napkin math: recovering half the missed calls = ~24 more conversations/month. At 25% close rate = 6 more signed cases/month. At $3K avg case value = $18K/month in new revenue. From answering the phone.'
        ],
        status: 'review',
        edited: false
      },
      short_video: {
        content:
          'HOOK: 52% of this law firm\'s paid phone calls went unanswered last month.\n\n' +
          '[PAUSE]\n\n' +
          'They spend $8,000 a month on Google Ads. That generates about 90 calls.\n\n' +
          '34 went to voicemail. 22 rang for more than 30 seconds, and 13 of those hung up.\n\n' +
          '[PAUSE]\n\n' +
          'That\'s 47 wasted calls. At $89 per call, they\'re burning $4,183 every single month.\n\n' +
          'And here\'s the painful part — only 8% of people who reach voicemail leave a message.\n\n' +
          '[PAUSE]\n\n' +
          'Your phone is your most expensive marketing asset. Not your website. Not your ads. The phone.\n\n' +
          'Because every marketing dollar you spend eventually turns into a phone call. And if nobody answers in 15 seconds, that money is gone.\n\n' +
          '[PAUSE]\n\n' +
          'Measure your time to answer. Set a 10-second target. Get after-hours coverage.\n\n' +
          'It\'s the highest-ROI fix in legal marketing.',
        status: 'review',
        edited: false
      }
    },
    image_prompt: 'Ringing phone with a stopwatch overlay showing 30 seconds. Red warning indicators. Money flying away from the phone with each passing second. Clean infographic style, dark background, urgent feeling.',
    image_url: null,
    blog_keyword: 'law firm speed to lead phone answer time',
    youtube_topic: 'Speed to Lead: The $50K/Year Problem Law Firms Ignore',
    blog_post: null,
    youtube_script:
      '# Speed to Lead: The $50K/Year Problem Law Firms Ignore\n\n' +
      '## INTRO (0:00 - 0:30)\n\n' +
      '[TALKING HEAD — DIRECT TO CAMERA]\n\n' +
      'A law firm owner installed call tracking last month. What he found should terrify every attorney watching this. 52% of his paid calls — calls he paid $89 each for — went unanswered. That\'s over $4,000 a month. Fifty thousand dollars a year. Burning. And he had no idea until he looked at the data.\n\n' +
      'Today I\'m breaking down the speed-to-lead problem that\'s costing law firms more money than bad ads, bad websites, and bad agencies combined.\n\n' +
      '## THE DATA (0:30 - 2:00)\n\n' +
      '[SCREEN RECORDING — SHOW CALL TRACKING DASHBOARD MOCKUP]\n\n' +
      'Here are the actual numbers from this PI firm in Houston. 90 inbound calls from Google Ads in one month. Let\'s break down what happened to each one.\n\n' +
      '34 calls went straight to voicemail. Either it was after hours, or the receptionist was already on another call. That\'s 38% of calls — gone.\n\n' +
      '[B-ROLL — PHONE RINGING ON EMPTY DESK]\n\n' +
      '22 calls rang for more than 30 seconds before someone picked up. Now here\'s the thing — of those 22, only 9 actually stayed on the line. The other 13 hung up.\n\n' +
      'So out of 90 calls they paid for: 47 were either unanswered or abandoned. 52%.\n\n' +
      '[TALKING HEAD]\n\n' +
      'And the voicemail data is even worse. Industry research shows only 8% of callers who reach voicemail leave a message. And of those who DO leave a message, only 32% are ever successfully called back and converted. Voicemail isn\'t your safety net. It\'s a black hole.\n\n' +
      '## THE COST (2:00 - 3:30)\n\n' +
      '[SCREEN — SIMPLE MATH ON SCREEN]\n\n' +
      'Let\'s do the math. 47 wasted calls times $89 per call equals $4,183 per month. That\'s $50,196 per year in ad spend that generates a call that nobody answers.\n\n' +
      'But the REAL cost is worse than that. Because each of those calls is a potential client. If they recover even half — let\'s say 24 additional conversations per month — and they close 25% of those... that\'s 6 more signed cases every month.\n\n' +
      'For a PI firm where the average case generates $3,000-5,000 in fees? That\'s $18,000 to $30,000 in monthly revenue. From answering. The phone.\n\n' +
      '[TALKING HEAD — LEAN IN]\n\n' +
      'This is why I say your phone is the most expensive thing in your office. Every dollar you spend on marketing — every Google Ad click, every SEO ranking, every referral — eventually becomes a phone call. And if nobody picks up within 15 seconds, you just paid full price for a lead you\'ll never get back.\n\n' +
      '## THE FIX (3:30 - 5:00)\n\n' +
      '[TALKING HEAD + GRAPHICS]\n\n' +
      'Here are four things you can implement this week.\n\n' +
      'Number one: measure your actual time to answer. Most firms have literally no idea. Install call tracking — CallRail, WhatConverts, whatever — and look at the data. You can\'t fix what you don\'t measure.\n\n' +
      'Number two: set a 10-second answer target. Not 30 seconds. Not "a few rings." Ten seconds. Every second after 10 costs you conversion rate.\n\n' +
      'Number three: add overflow coverage. This could be a virtual receptionist service at $400/month, an AI intake tool, or even just forwarding to your cell after 3 rings. Anything is better than voicemail.\n\n' +
      'Number four: track your missed call recovery rate. When you DO miss a call, how fast do you call back? Is it 5 minutes or 5 hours? The data shows calling back within 5 minutes makes you 9x more likely to convert than calling back in 30 minutes.\n\n' +
      '## OUTRO (5:00 - 5:30)\n\n' +
      '[TALKING HEAD]\n\n' +
      'Before you spend another dollar on ads, another dollar on SEO, or another dollar on a new website — fix your phone. It\'s the highest-ROI thing you can do in legal marketing and it\'s the one thing almost nobody talks about.\n\n' +
      'If you found this helpful, subscribe. We break down the actual numbers behind legal marketing every week. No fluff, no vanity metrics, just what works.\n',
    notes: ''
  },

  // ---- Content 5: Wrong zip codes ----
  {
    id: generateId(),
    trigger_id: triggers[4].id,
    trigger_title: triggers[4].title,
    trigger_source: triggers[4].source,
    trigger_category: triggers[4].category,
    trigger_url: triggers[4].url,
    generated_at: hoursAgo(8),
    status: 'approved',
    formats: {
      linkedin: {
        content:
          'A workers\' comp firm in Chicago just discovered their agency was running ads to the wrong states. For 6 months.\n\n' +
          'The mistake: location targeting was set to "presence or interest in" instead of "presence in."\n\n' +
          'That means anyone in the country who Googled anything about Chicago workers\' comp saw their ads — including people in Florida, Texas, California.\n\n' +
          'It gets worse. The radius was 150 miles. They were hitting Indiana, Wisconsin, and Iowa too.\n\n' +
          'The damage: 31% of clicks came from outside Illinois. At $45/click, that\'s $8,100 in wasted spend.\n\n' +
          'The agency\'s response: "That\'s a default Google setting."\n\n' +
          'Let me translate that: "We set up your campaign and never checked the basics."\n\n' +
          'This is a 60-second fix. Literally go to Settings > Locations > Location options > "Presence: People in or regularly in your targeted locations." Done.\n\n' +
          'If your agency hasn\'t made this change, you are paying for clicks from people who will never become your clients.\n\n' +
          'Audit your own account. Today. Don\'t trust anyone else to do it.\n\n' +
          '#GoogleAds #LegalMarketing #PPC #LawFirmGrowth',
        status: 'approved',
        edited: false
      },
      x_single: {
        content: 'Workers\' comp firm. Illinois only. Agency left Google Ads on default "interest in" targeting. 31% of clicks from out of state for 6 months. $8,100 wasted. It\'s a 60-second settings fix. Audit your own account.',
        status: 'approved',
        edited: false
      },
      x_thread: {
        content: [
          'A workers\' comp firm just found out their marketing agency was running ads to the wrong states. For 6 months. The total waste: $8,100. And it was caused by ONE settings checkbox 🧵',
          'The firm handles workers\' comp in Illinois only. Their agency set up Google Ads with location targeting set to "presence or interest in" instead of "presence in." That one setting means anyone ANYWHERE who searched Chicago workers comp saw their ads.',
          'The radius was set to 150 miles — hitting Indiana, Wisconsin, and Iowa. For a practice that can only serve Illinois clients. When the firm pulled the geographic report: 31% of all clicks came from outside their service area.',
          'At $45/click average, 31% wasted over 6 months = roughly $8,100 in clicks from people who could never become clients. That\'s not a rounding error. That\'s a month of ad budget gone.',
          'The agency\'s response: "That\'s a default Google setting." Translation: We set up your campaign, turned on the defaults, and never checked. For 6 months. While billing you $2K/month in management fees.',
          'The fix takes 60 seconds: Google Ads > Settings > Locations > Location options > select "Presence: People in or regularly in your targeted locations." That\'s it. One checkbox.',
          'The lesson: always have login access to your own ad accounts. Log in monthly. Check location targeting, search terms report, and negative keywords. Trust but verify. Especially the defaults.'
        ],
        status: 'approved',
        edited: false
      },
      short_video: {
        content:
          'HOOK: A law firm just discovered they were paying for Google Ad clicks from people in the wrong state. For six months.\n\n' +
          '[PAUSE]\n\n' +
          'Workers\' comp firm. Illinois only. Their agency set up the ads with one wrong setting — "presence or interest in" instead of "presence in."\n\n' +
          'That means anyone ANYWHERE who Googled "Chicago workers comp" saw their ads. People in Florida. Texas. California.\n\n' +
          '[PAUSE]\n\n' +
          '31% of clicks came from outside Illinois. At $45 per click, that\'s $8,100 wasted in 6 months.\n\n' +
          'The agency said: "That\'s a default Google setting."\n\n' +
          '[PAUSE]\n\n' +
          'It\'s a 60-second fix. Settings, Locations, Location Options. Change it to "Presence" only. Done.\n\n' +
          'If you run Google Ads, log into your account today and check this setting. Right now. I\'ll wait.',
        status: 'approved',
        edited: false
      }
    },
    image_prompt: 'Map of the United States with Illinois highlighted in green and surrounding states (Indiana, Wisconsin, Iowa) highlighted in red showing wasted ad coverage. Pin drops outside the service area. Clean infographic style, data-driven look.',
    image_url: null,
    blog_keyword: 'google ads location targeting law firm settings',
    youtube_topic: null,
    blog_post: null,
    youtube_script: null,
    notes: ''
  },

  // ---- Content 6: Clio Legal Trends (67% don't track ROI) ----
  {
    id: generateId(),
    trigger_id: triggers[5].id,
    trigger_title: triggers[5].title,
    trigger_source: triggers[5].source,
    trigger_category: triggers[5].category,
    trigger_url: triggers[5].url,
    generated_at: hoursAgo(16),
    status: 'review',
    formats: {
      linkedin: {
        content:
          'Clio just dropped their 2025 Legal Trends data.\n\n' +
          'The stat that should keep every law firm owner up at night:\n\n' +
          '67% of firms don\'t track marketing ROI.\n\n' +
          'They don\'t know what a signed case costs. They don\'t know which channels work. They\'re writing checks to agencies and hoping for the best.\n\n' +
          'But here\'s the stat that matters more:\n\n' +
          'Firms that DO track marketing ROI grew revenue 34% faster than those that don\'t.\n\n' +
          'That\'s not a small edge. That\'s the difference between a firm growing at 8% and a firm growing at 11%. Compounded over 5 years, that\'s nearly double the growth.\n\n' +
          'And the #1 predictor of lead conversion? Not ad spend. Not website quality. Not referral volume.\n\n' +
          'Intake response time.\n\n' +
          'How fast you answer the phone beats how much you spend on ads.\n\n' +
          'Three metrics every firm should track starting today:\n\n' +
          '1. Cost per signed case (by channel)\n2. Lead-to-client conversion rate\n3. Average time to first response\n\n' +
          'That\'s the whole dashboard. Everything else is noise.\n\n' +
          '#LegalTrends #Clio #LawFirmMarketing #MarketingROI',
        status: 'review',
        edited: false
      },
      x_single: {
        content: 'Clio data: 67% of law firms don\'t track marketing ROI. Firms that DO track it grow revenue 34% faster. And the #1 predictor of lead conversion isn\'t ad spend — it\'s intake response time. Three metrics. That\'s all you need.',
        status: 'review',
        edited: false
      },
      x_thread: {
        content: [
          'Clio\'s 2025 Legal Trends Report just dropped. Data from 90,000+ legal professionals. The headline stat: 67% of firms don\'t track marketing ROI. Here\'s why that number should terrify you 🧵',
          'The average firm spends 7.2% of revenue on marketing. For a $1M firm, that\'s $72K/year. And 67% of them have NO IDEA what return they\'re getting on that $72K. They\'re guessing.',
          'But here\'s the flip side: firms that DO track ROI grew revenue 34% faster than those that don\'t. Not 5%. Not 10%. 34%. Measurement isn\'t just nice to have — it\'s a competitive advantage.',
          'And only 12% of firms could identify their cost per signed client "with confidence." Twelve percent. That means 88% of firms can\'t tell you whether their marketing is profitable or not.',
          'The most surprising finding: the #1 predictor of lead conversion wasn\'t ad spend, website quality, or referral volume. It was intake response time. How fast you answer the phone beats everything else.',
          'The whole marketing dashboard for a law firm boils down to 3 metrics: (1) Cost per signed case by channel, (2) Lead-to-client conversion rate, (3) Average time to first response. Track those 3 and you\'re ahead of 88% of firms.'
        ],
        status: 'review',
        edited: false
      },
      short_video: {
        content:
          'HOOK: 67% of law firms don\'t track their marketing ROI.\n\n' +
          'That\'s from Clio\'s data. 90,000 legal professionals surveyed.\n\n' +
          '[PAUSE]\n\n' +
          'Two out of three firms are writing checks to marketing agencies and hoping for the best.\n\n' +
          'But here\'s what matters — firms that DO track their ROI grow revenue 34% faster.\n\n' +
          '[PAUSE]\n\n' +
          'And the number one predictor of whether a lead becomes a client? It\'s not your ad budget. It\'s not your website. It\'s how fast you answer the phone.\n\n' +
          '[PAUSE]\n\n' +
          'Intake response time beats everything.\n\n' +
          'Three metrics. That\'s all you need.\n\n' +
          'Cost per signed case. Lead-to-client conversion rate. Average time to first response.\n\n' +
          'Track those three and you\'re ahead of 88% of law firms.',
        status: 'review',
        edited: false
      }
    },
    image_prompt: 'Large "67%" statistic in bold typography. Pie chart showing firms that track vs don\'t track marketing ROI. Clean, professional data visualization. Clio report style. Blue and dark color scheme.',
    image_url: null,
    blog_keyword: null,
    youtube_topic: null,
    blog_post: null,
    youtube_script: null,
    notes: ''
  },

  // ---- Content 7: ABA PI marketing spend ----
  {
    id: generateId(),
    trigger_id: triggers[6].id,
    trigger_title: triggers[6].title,
    trigger_source: triggers[6].source,
    trigger_category: triggers[6].category,
    trigger_url: triggers[6].url,
    generated_at: hoursAgo(34),
    status: 'review',
    formats: {
      linkedin: {
        content:
          'The ABA just published their annual marketing expenditure data.\n\n' +
          'The average PI firm with 3-10 attorneys spends $124,000/year on marketing.\n\n' +
          'Here\'s where that money goes:\n\n' +
          'Google Ads: $42K (34%)\n' +
          'SEO: $28K (23%)\n' +
          'Website: $14K (11%)\n' +
          'Social media: $11K (9%)\n' +
          'Everything else: $29K (23%)\n\n' +
          'And here\'s the benchmark most firms don\'t know:\n\n' +
          'Average cost per signed case:\n' +
          '→ PI: $1,850\n' +
          '→ Family law: $920\n' +
          '→ Criminal defense: $680\n\n' +
          'If your PI cost per case is above $2,500, you\'re likely overpaying somewhere in the stack. If it\'s below $1,200, you\'re either in a low-competition market or your intake process is elite.\n\n' +
          'The 18% year-over-year increase in marketing spend tells you one thing: the firms that aren\'t investing are falling further behind every quarter.\n\n' +
          'But spending more doesn\'t mean spending smarter. Most firms I talk to have no idea if their $42K in Google Ads is generating $420K or $42K in cases.\n\n' +
          'The number isn\'t the spend. It\'s the return.\n\n' +
          '#LegalMarketing #ABA #PersonalInjury #MarketingSpend',
        status: 'review',
        edited: false
      },
      x_single: {
        content: 'ABA data: avg PI firm (3-10 attorneys) spends $124K/yr on marketing. Cost per signed case: PI $1,850, Family $920, Criminal $680. Spending is up 18% YoY. The question isn\'t how much you spend — it\'s what you get.',
        status: 'review',
        edited: false
      },
      x_thread: {
        content: [
          'The ABA just released annual marketing spend data for law firms. Here are the benchmarks every firm owner should have bookmarked 🧵',
          'Average marketing spend for a PI firm with 3-10 attorneys: $124,000/year. That\'s up 18% from 2023. The firms investing in marketing are investing MORE, not less.',
          'Where the $124K goes: Google Ads $42K (34%), SEO $28K (23%), Website $14K (11%), Social media $11K (9%), Other (directories, LSAs, events, referral programs) $29K (23%).',
          'Cost per signed case benchmarks: PI = $1,850, Family law = $920, Criminal defense = $680. If your PI cost per case is over $2,500, something in your funnel is broken.',
          'The gap between firms is widening. Firms spending $100K+ on marketing are growing faster, signing more cases, and driving down their per-case costs through volume. Firms spending under $50K are competing for leftover demand.',
          'But the spend alone means nothing. I know firms spending $200K/year with a $3,500 cost per case, and firms spending $80K/year with a $1,100 cost per case. The difference: tracking, intake speed, and lead quality control.'
        ],
        status: 'review',
        edited: false
      },
      short_video: {
        content:
          'HOOK: The average PI firm spends $124,000 a year on marketing. Here\'s what they spend it on.\n\n' +
          '[PAUSE]\n\n' +
          'Google Ads: $42K. That\'s the biggest line item at 34% of total spend.\n\n' +
          'SEO: $28K.\n' +
          'Website: $14K.\n' +
          'Social media: $11K.\n\n' +
          '[PAUSE]\n\n' +
          'And here are the benchmarks the ABA found for cost per signed case.\n\n' +
          'Personal injury: $1,850.\n' +
          'Family law: $920.\n' +
          'Criminal defense: $680.\n\n' +
          '[PAUSE]\n\n' +
          'If your PI cost per case is over $2,500, something is broken.\n\n' +
          'If it\'s under $1,200, your intake team deserves a raise.\n\n' +
          'The question isn\'t how much you spend on marketing. It\'s what you get for it.',
        status: 'rejected',
        edited: false
      }
    },
    image_prompt: 'Bar chart showing law firm marketing budget breakdown: Google Ads $42K, SEO $28K, Website $14K, Social $11K. Cost per case comparison: PI $1,850 vs Family $920 vs Criminal $680. Professional financial chart style.',
    image_url: null,
    blog_keyword: 'how much do law firms spend on marketing',
    youtube_topic: null,
    blog_post: null,
    youtube_script: null,
    notes: ''
  },

  // ---- Content 8: AI transforming client acquisition ----
  {
    id: generateId(),
    trigger_id: triggers[7].id,
    trigger_title: triggers[7].title,
    trigger_source: triggers[7].source,
    trigger_category: triggers[7].category,
    trigger_url: triggers[7].url,
    generated_at: hoursAgo(40),
    status: 'review',
    formats: {
      linkedin: {
        content:
          'Three mid-size law firms implemented AI intake tools.\n\n' +
          'Within 6 months, their cost per acquisition dropped 28-41%.\n\n' +
          'Not from better ads. Not from a new website. From answering leads faster.\n\n' +
          'The National Law Review just published the data:\n\n' +
          '→ AI intake reduced response times from minutes to seconds\n' +
          '→ Automated follow-up sequences increased lead-to-client conversion by 23%\n' +
          '→ The biggest gains came from eliminating "lead leakage" — prospects who called, didn\'t get through, and never came back\n\n' +
          'Here\'s my take: AI isn\'t replacing lawyers. It\'s replacing the 28-second wait time that\'s costing you 40% of your paid leads.\n\n' +
          'Most firms think the answer to more cases is more ad spend. It\'s not. The answer is converting more of the leads you already pay for.\n\n' +
          'If you\'re spending $5K/month on ads and converting 15% of leads, you don\'t need more leads. You need a better intake process.\n\n' +
          'Going from 15% to 25% conversion is the equivalent of increasing your ad budget by 67% — without spending another dollar.\n\n' +
          'Fix intake before you scale spend.\n\n' +
          '#AIIntake #LegalTech #LawFirmGrowth #ClientAcquisition',
        status: 'review',
        edited: false
      },
      x_single: {
        content: '3 law firms added AI intake. Cost per acquisition dropped 28-41% in 6 months. Not from better ads — from answering faster. Converting 15% to 25% of leads = same as increasing ad spend 67%. Fix intake before scaling spend.',
        status: 'review',
        edited: false
      },
      x_thread: {
        content: [
          'Three mid-size law firms implemented AI intake tools. Within 6 months, cost per acquisition dropped 28-41%. Not from better ads. Not from more spend. From answering leads faster. Here\'s what happened 🧵',
          'The National Law Review published the case studies. The key insight: the biggest cost savings didn\'t come from the AI being smart. They came from eliminating "lead leakage" — prospects who called, didn\'t get through, and never tried again.',
          'Before AI intake: average response time measured in minutes (or hours for after-hours calls). After: seconds. That single change — speed — was responsible for 60-70% of the conversion improvement.',
          'Automated follow-up sequences added another 23% lift. Not complicated sequences — just consistent ones. Text within 30 seconds. Email within 2 minutes. Call-back within 5 minutes. The AI just made sure it happened EVERY time.',
          'Here\'s the math that should change how you think about marketing: going from 15% lead-to-client conversion to 25% is the same as increasing your ad budget by 67%. Without spending another dollar on ads.',
          'A firm spending $5K/month on ads and converting 15% of leads doesn\'t need more leads. It needs better intake. That\'s the most underspent line item in legal marketing.',
          'The takeaway: before you increase ad spend, fix intake. Measure speed to first response. Automate follow-up. Plug the leaks. Then — and only then — turn up the volume.'
        ],
        status: 'review',
        edited: false
      },
      short_video: {
        content:
          'HOOK: Three law firms added AI to their intake process. Cost per client dropped 28 to 41 percent.\n\n' +
          '[PAUSE]\n\n' +
          'Not from better ads. Not from more budget. From answering faster.\n\n' +
          'The biggest gain? Eliminating lead leakage. That\'s when someone calls, doesn\'t get through, and never calls back.\n\n' +
          '[PAUSE]\n\n' +
          'Response time went from minutes to seconds. That alone drove 60 to 70 percent of the improvement.\n\n' +
          'Here\'s the math that should change how you think about marketing.\n\n' +
          '[PAUSE]\n\n' +
          'Going from a 15% conversion rate to 25% is the same as increasing your ad budget by 67%. Without spending another dollar.\n\n' +
          'Fix intake before you scale spend. That\'s the whole playbook.',
        status: 'review',
        edited: false
      }
    },
    image_prompt: 'Before and after comparison showing response time: "Minutes" with a slow clock vs "Seconds" with a fast clock. Conversion rate arrows going up 28-41%. Clean tech/AI aesthetic with legal professional setting.',
    image_url: null,
    blog_keyword: 'AI intake law firm conversion rate',
    youtube_topic: 'How AI Intake Dropped These Law Firms\' Cost Per Case by 41%',
    blog_post: null,
    youtube_script: null,
    notes: ''
  }
];

// ---------------------------------------------------------------------------
// Write to disk
// ---------------------------------------------------------------------------

console.log('Seeding trigger-queue.json with %d triggers...', triggers.length);
writeJSON('trigger-queue.json', triggers);

console.log('Seeding content.json with %d content pieces...', contentPieces.length);
writeJSON('content.json', contentPieces);

console.log('Done. Data files written to data/.');
