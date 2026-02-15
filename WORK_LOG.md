# Content Machine — Build Log

## 2026-02-15 — Autonomous Build Session

### Phase 1: Foundation & Backend (Complete)
- Created repo structure with all directories
- Initialized git repo
- **lib/utils.js** — All shared utilities: loadEnv, JSON read/write, keyword matching, XML parsing, HTML stripping
- **lib/claude.js** — Claude API wrapper with Haiku (social) and Sonnet (long-form), defensive JSON parsing
- **lib/ideogram.js** — Ideogram V_2A_TURBO image generation with graceful failure
- **scrapers/reddit.js** — Reddit .json API scraper, 1 req/2 sec rate limit, 9 subreddits
- **scrapers/rss.js** — RSS feed parser (regex-based, no deps), 7 legal industry feeds, concurrent fetching
- **scrapers/youtube.js** — YouTube Data API v3 scraper, placeholder channel skipping, caption detection
- **scrapers/run-all.js** — Orchestrator with error isolation per scraper
- **generator/score-triggers.js** — Scoring system (0-20+ range): numbers, pain points, keywords, engagement, recency
- **generator/content-writer.js** — Full brand voice system prompt, social + blog + YouTube generation
- **generator/image-gen.js** — Ideogram wrapper for content images
- **generator/calendar-builder.js** — Weekly calendar with pillar rotation and slot filling
- **generator/run-daily.js** — Daily orchestrator: score → select → generate → image → blog → YouTube → save
- **data/voices.json** — Brand config, feeds, channels, keywords
- **.github/workflows/** — scrape.yml (6h cron), generate.yml (daily 6AM EST), on-demand.yml

### Phase 2: Server & Dashboard (Complete)
- **server.js** — Full HTTP server (zero deps) with 12 API endpoints:
  - GET /api/stats, /api/triggers, /api/content, /api/content/:id, /api/calendar
  - PUT /api/content/:id (inline edit)
  - POST /api/content/:id/approve, /reject, /publish
  - POST /api/triggers/generate, /api/generate-daily, /api/save-url, /api/scrape-now
- **dashboard/index.html** — Single-file vanilla JS SPA (no React, no build step):
  - Full navigation: Dashboard, Content, Triggers, Calendar, Save URL
  - Stats grid with source/category breakdowns and visual bars
  - Content review cards with format tabs (LinkedIn, Tweet, Thread, Video, Blog, YouTube)
  - Inline editing with save/cancel
  - One-click approve/reject per format
  - One-click copy to clipboard
  - Thread display (numbered tweets with visual separator)
  - Trigger table with score bars, source badges, generate button
  - Weekly calendar with pillar labels, coverage percentage
  - URL save page (paste → scrape → generate)
  - Filter chips (by status, by source)
  - Toast notifications
  - Keyboard shortcuts (1-4 navigate, Esc close)
  - Responsive design (mobile sidebar toggle, grid reflow)
  - Branded: Fraunces + Outfit fonts, navy/blue palette, glass-morphism cards

### Phase 3: Seed Data (Complete)
- **scripts/seed-data.js** — Created and run
- **18 triggers** seeded (5 Reddit, 4 RSS, 3 YouTube, 3 questions, 3 competitor)
- **8 content pieces** with full LinkedIn posts, tweets, threads, video scripts
- Includes 1 full blog post (~3,900 chars) and 1 full YouTube script (~3,700 chars)
- 2 approved, 6 in review, 2 rejected formats for UI variety
- All content is realistic, specific, with numbers — in Mortar Metrics voice

### Phase 4: Testing (Complete)
- Verified all 18 triggers load correctly with proper sources
- Scoring system tested: range 5-19, "Speed to lead" highest at 19
- All API endpoints tested and working:
  - Stats returns correct counts and breakdowns
  - Triggers return scored and sorted
  - Content CRUD (read, update, approve, reject) all functional
  - Calendar returns 60% coverage with 7 days
  - Dashboard HTML serves correctly
- Server starts clean on any available port

### Phase 5: Polish (In Progress)
- Enhanced dashboard with visual improvements
- Adding more interactive features
- Working on README

---

### Decisions Made
1. **Vanilla JS over React** — Simpler, no build step, single file serves instantly. The h() helper function provides enough DOM abstraction.
2. **Regex XML parsing over DOMParser** — Works in Node.js without jsdom dependency. Good enough for RSS feeds.
3. **Scoring 0-20+ scale** — Provides enough granularity to differentiate triggers. Top triggers genuinely score higher.
4. **Calendar pillar rotation** — Mon: Insight, Tue: How-To, Wed: Social Proof, Thu: Insight, Fri: Hot Take, Sat: BTS, Sun: How-To. Matches the 35/25/20/10/10 weight distribution.
5. **Format-level approve/reject** — Each piece independently controllable, matching the requirement to approve LinkedIn but reject X thread from same trigger.

### Known Limitations
- No WebSocket/SSE for real-time generation progress (would need to add for long-running operations)
- Blog/YouTube script collapse only uses CSS gradient overlay — could add explicit expand button
- No auto-save on edit (must click Save button)
- Calendar only shows current week (no previous/next week navigation)
