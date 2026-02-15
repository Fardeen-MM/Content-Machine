# Content Machine

Automated content engine for **Mortar Metrics**. Scrapes the internet for content triggers, generates all content formats with AI, and provides a dashboard to review, edit, approve, and copy.

## Quick Start

```bash
# 1. Start the dashboard
node server.js

# 2. Open in browser
open http://localhost:3000
```

The dashboard comes pre-seeded with 18 triggers and 8 content pieces so you can see it in action immediately.

## Environment Variables

Create a `.env` file in the project root:

```
ANTHROPIC_API_KEY=sk-ant-...      # Required for content generation
IDEOGRAM_API_KEY=...               # Optional, for image generation
YOUTUBE_API_KEY=...                # Optional, for YouTube scraper
```

Without API keys, the dashboard still works — you just can't generate new content or images.

## Architecture

**Zero npm dependencies.** Node.js 18+ built-ins only.

```
server.js              → HTTP server + API (12 endpoints)
dashboard/index.html   → Single-file SPA (vanilla JS, ~50KB)
scrapers/              → Reddit, RSS, YouTube scrapers
generator/             → Scoring, content generation, calendar
lib/                   → Claude API, Ideogram, utilities
data/                  → JSON data store (triggers, content, published)
.github/workflows/     → Automated scraping (6h) + generation (daily)
```

## Commands

```bash
node server.js             # Start dashboard (default port 3000)
node scrapers/run-all.js   # Run all scrapers manually
node generator/run-daily.js # Run content generation manually
PORT=3001 node server.js   # Use a different port
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/stats` | Dashboard statistics |
| GET | `/api/triggers` | All triggers (filterable) |
| GET | `/api/content` | All content (filterable by status) |
| GET | `/api/content/:id` | Single content piece |
| PUT | `/api/content/:id` | Update content (inline edit) |
| POST | `/api/content/:id/approve` | Approve format(s) |
| POST | `/api/content/:id/reject` | Reject format(s) |
| POST | `/api/content/:id/publish` | Mark as published |
| GET | `/api/calendar` | Weekly content calendar |
| POST | `/api/triggers/generate` | Generate for specific trigger |
| POST | `/api/generate-daily` | Run daily generation |
| POST | `/api/save-url` | Scrape URL + create trigger |

## GitHub Actions

- **scrape.yml** — Every 6 hours, runs all scrapers
- **generate.yml** — Daily at 6 AM EST, generates content
- **on-demand.yml** — Manual trigger (scrape / generate / both)

Required secrets: `ANTHROPIC_API_KEY`, `IDEOGRAM_API_KEY`, `YOUTUBE_API_KEY`

## Dashboard Features

- Review all generated content (LinkedIn, X, Thread, Video Script, Blog, YouTube)
- Edit inline, approve/reject per format, copy with one click
- "Approve All" button on each card
- Trigger queue with scoring and source filters
- Weekly content calendar with pillar rotation
- Stats overview with source/category breakdowns
- Save URL — paste any link to create a trigger
- Keyboard shortcuts (1-4 for navigation, Esc to close)
- Mobile responsive
- Branded: Navy blue + electric blue, Fraunces + Outfit fonts
