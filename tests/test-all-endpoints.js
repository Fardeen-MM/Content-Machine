#!/usr/bin/env node
// Comprehensive endpoint tester — tests every POST then GET endpoint
const BASE = 'http://localhost:3099';

const POST_ENDPOINTS = [
  // Core
  '/api/content',
  '/api/triggers',
  '/api/stats',
  '/api/calendar',
  '/api/settings',

  // Batch 1-73 era endpoints (POST with no body or simple body)
  '/api/scrape-now',
  '/api/generate-daily',
  '/api/content-freshness-scan',
  '/api/lead-magnet-performance',
  '/api/content-sentiment',
  '/api/hashtag-strategy',
  '/api/platform-analytics',
  '/api/post-length-analyzer',
  '/api/pillar-health-check',
  '/api/repurpose-suggestions',
  '/api/distribution-scorecard',
  '/api/content-velocity-tracker',
  '/api/competitor-benchmark',
  '/api/content-queue-manager',
  '/api/persona-content-match',
  '/api/cta-performance',
  '/api/social-proof-widget',
  '/api/content-attribution',
  '/api/conversion-funnel-viz',
  '/api/content-roi-detail',
  '/api/weekly-growth-report',
  '/api/pipeline-board',
  '/api/content-quality-audit',
  '/api/team-activity',
  '/api/calendar-heatmap',
  '/api/content-goals',
  '/api/ab-test-dashboard',
  '/api/engagement-heatmap',

  // Batch 79
  '/api/audience-overlap',
  '/api/viral-detector',
  '/api/cannibalisation-check',
  '/api/engagement-predictor',
  '/api/content-mix-optimizer',
  '/api/evergreen-identifier',
  '/api/content-supply-chain',

  // Batch 80
  '/api/content-decay-tracker',
  '/api/headline-analyzer',
  '/api/content-cluster-map',
  '/api/audience-sentiment-pulse',
  '/api/platform-rate-limiter',
  '/api/content-performance-tiers',

  // Batch 81
  '/api/content-compliance-checker',
  '/api/cross-platform-scheduler',
  '/api/content-lifespan-estimator',
  '/api/competitor-gap-finder',
  '/api/content-recency-score',
  '/api/content-dependency-map',

  // Batch 82
  '/api/engagement-forecast',
  '/api/content-readability-scorer',
  '/api/audience-growth-predictor',
  '/api/content-repurpose-tracker',
  '/api/social-proof-aggregator',
  '/api/weekly-content-scorecard',

  // Batch 83
  '/api/content-format-performance',
  '/api/topic-momentum-tracker',
  '/api/content-production-velocity',
  '/api/brand-voice-consistency',
  '/api/audience-persona-insights',
  '/api/content-calendar-optimizer',
  '/api/content-impact-score',

  // Earlier batches (non-AI)
  '/api/revenue-attribution',
  '/api/pipeline-value-tracker',
  '/api/content-cost-calculator',
  '/api/lead-scorer',
  '/api/retargeting-builder',
  '/api/campaign-roi',
  '/api/monthly-content-report',
  '/api/engagement-alerts',
  '/api/content-audit',
  '/api/content-velocity',
  '/api/engagement-booster',
  '/api/content-archive',
  '/api/profile-optimizer',
  '/api/publish-workflow',
  '/api/golden-hour',
  '/api/micro-content',
  '/api/referral-content',
  '/api/warmup-planner',
  '/api/headline-tester',
  '/api/hook-scorer',
  '/api/newsletter-compiler',
  '/api/one-click-publish',
  '/api/power-hour',
  '/api/content-matrix-generator',
  '/api/funnel-analyzer',
  '/api/content-recycler',
  '/api/content-dna-analyzer',
  '/api/topic-authority-mapper',
  '/api/social-proof-collector',
  '/api/newsletter-builder',
  '/api/dm-sequence-builder',
  '/api/content-recycler-scan',
  '/api/swipe-file',
  '/api/cross-post-tracker',
  '/api/smart-scheduler',
  '/api/content-system-health',
  '/api/competitor-content-tracker',
  '/api/content-scoring',
  '/api/post-scheduler',
  '/api/trend-hijacker',
  '/api/lead-magnet-funnel',
  '/api/outbound-sequence',
  '/api/icp-refiner',
  '/api/win-loss-analysis',
  '/api/content-roi',
  '/api/content-experiments',
  '/api/social-listening',
  '/api/authority-builder',
  '/api/quick-wins',
  '/api/content-calendar-ai',
  '/api/daily-briefing',
  '/api/engagement-tracker',
  '/api/comment-to-dm',
  '/api/content-series-planner',
  '/api/hook-bank',
  '/api/engagement-scorer',
  '/api/conversion-tracker',
  '/api/content-gap-finder',
  '/api/audience-growth-tracker',
  '/api/performance-benchmarks',
  '/api/flywheel-analyzer',
  '/api/content-intelligence',
  '/api/conversion-optimizer',
  '/api/drafting-strategy',
  '/api/zero-click-bank',
  '/api/pillar-rotator',
  '/api/saved-replies',
  '/api/audience-builder',
  '/api/weekly-action-plan',
  '/api/competitive-intel',
  '/api/comment-strategy',
  '/api/distribution-engine',
  '/api/social-proof-engine',
  '/api/growth-playbook',
  '/api/lead-magnet-generator',
  '/api/auto-repurpose',
  '/api/trends-analyzer',
  '/api/batch-generate',
];

// GET-only endpoints
const GET_ENDPOINTS = [
  '/api/content',
  '/api/triggers',
  '/api/stats',
  '/api/calendar',
  '/api/settings',
  '/api/meetings',
  '/api/meetings/stats',
  '/api/clients',
  '/api/calendar-export',
  '/api/memory',
  '/api/performance',
  '/api/analytics/performance',
  '/api/autopilot',
  '/api/chat',
  '/api/health',
  '/api/insights',
  '/api/deals',
  '/api/published',
  '/api/content-series',
  '/api/predictions',
  '/api/playbooks',
  '/api/cta-library',
  '/api/trending',
  '/api/lead-magnets',
  '/api/content-health',
  '/api/content-briefs',
  '/api/content-leads',
  '/api/content-ideas',
  '/api/social-proof-data',
  '/api/roi-report',
  '/api/audience-growth-data',
  '/api/content-themes',
  '/api/distribution-plans',
  '/api/competitors-tracked',
  '/api/expiring-content',
  '/api/amplifications',
  '/api/lead-funnels',
  '/api/calendar-insights',
  '/api/weekly-digest',
  '/api/split-tests',
  '/api/workflow-rules',
  '/api/youtube-pipelines',
  '/api/carousels',
  '/api/engagement-dashboard',
];

async function testEndpoint(method, path, body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);

  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    opts.signal = controller.signal;

    const res = await fetch(BASE + path, opts);
    clearTimeout(timeout);
    const elapsed = Date.now() - start;
    const text = await res.text();

    let parsed = null;
    let parseErr = null;
    try { parsed = JSON.parse(text); } catch (e) { parseErr = e.message; }

    return {
      path, method, status: res.status, elapsed,
      ok: res.status >= 200 && res.status < 300,
      isJson: !parseErr,
      parseErr,
      size: text.length,
      preview: text.substring(0, 120),
      error: parsed?.error || null,
    };
  } catch (err) {
    return {
      path, method, status: 0, elapsed: Date.now() - start,
      ok: false, isJson: false, parseErr: null,
      size: 0, preview: '', error: err.message,
    };
  }
}

async function main() {
  console.log('=== COMPREHENSIVE ENDPOINT TEST ===\n');
  console.log(`Testing ${POST_ENDPOINTS.length} POST + ${GET_ENDPOINTS.length} GET endpoints\n`);

  const results = { pass: 0, fail: 0, slow: 0, errors: [] };

  // Test all POST endpoints
  console.log('--- POST ENDPOINTS ---');
  for (const path of POST_ENDPOINTS) {
    const r = await testEndpoint('POST', path);
    const status = r.ok ? 'PASS' : 'FAIL';
    const slowTag = r.elapsed > 5000 ? ' [SLOW]' : '';
    if (r.ok) results.pass++; else { results.fail++; results.errors.push(r); }
    if (r.elapsed > 5000) results.slow++;

    const icon = r.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    console.log(`${icon} POST ${path} → ${r.status} (${r.elapsed}ms, ${r.size}B)${slowTag}${r.error ? ' ERR: ' + r.error : ''}`);
  }

  // Test all GET endpoints
  console.log('\n--- GET ENDPOINTS ---');
  for (const path of GET_ENDPOINTS) {
    const r = await testEndpoint('GET', path);
    const status = r.ok ? 'PASS' : 'FAIL';
    if (r.ok) results.pass++; else { results.fail++; results.errors.push(r); }

    const icon = r.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    console.log(`${icon} GET  ${path} → ${r.status} (${r.elapsed}ms, ${r.size}B)${r.error ? ' ERR: ' + r.error : ''}`);
  }

  // Also test GET versions of all POST endpoints
  console.log('\n--- GET VERSIONS OF POST ENDPOINTS ---');
  for (const path of POST_ENDPOINTS) {
    // Skip endpoints that don't have GET versions
    if (['/api/scrape-now', '/api/generate-daily', '/api/batch-generate', '/api/bulk-content-ops',
         '/api/one-click-publish', '/api/content-archive', '/api/publish-workflow'].includes(path)) continue;

    const r = await testEndpoint('GET', path);
    if (r.ok) results.pass++; else { results.fail++; results.errors.push(r); }

    const icon = r.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    if (!r.ok) console.log(`${icon} GET  ${path} → ${r.status} (${r.elapsed}ms)${r.error ? ' ERR: ' + r.error : ''}`);
  }

  // Summary
  console.log('\n=== RESULTS ===');
  console.log(`Total: ${results.pass + results.fail} | Pass: ${results.pass} | Fail: ${results.fail} | Slow: ${results.slow}`);

  if (results.errors.length > 0) {
    console.log('\n=== FAILURES ===');
    for (const e of results.errors) {
      console.log(`  ${e.method} ${e.path} → ${e.status} | ${e.error || e.preview?.substring(0, 80)}`);
    }
  }

  process.exit(results.fail > 0 ? 1 : 0);
}

main();
