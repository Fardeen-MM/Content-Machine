const db = require('./db');
const { callClaude, HAIKU } = require('./claude');
const { readJSON, writeJSON, generateId, now } = require('./utils');

async function extractDealPatterns(deal) {
  const fields = [];
  if (deal.outcome) fields.push(`Outcome: ${deal.outcome}`);
  if (deal.loss_reason) fields.push(`Loss reason: ${deal.loss_reason}`);
  if (deal.what_worked) fields.push(`What worked: ${deal.what_worked}`);
  if (deal.what_failed) fields.push(`What failed: ${deal.what_failed}`);
  if (deal.practice_area) fields.push(`Practice area: ${deal.practice_area}`);
  if (deal.source_channel) fields.push(`Source: ${deal.source_channel}`);
  if (deal.monthly_value) fields.push(`Value: $${deal.monthly_value}/mo`);

  if (fields.length < 2) return [];

  try {
    const text = await callClaude({
      model: HAIKU,
      system: 'You extract generalized sales patterns from deal outcomes for a legal marketing agency. Return JSON only.',
      prompt: `Extract 1-3 generalized patterns from this deal outcome. Each pattern should be a reusable insight, not specific to one client.

Deal data:
${fields.join('\n')}

Return JSON array: [{"type": "objection"|"pain_point"|"win_factor"|"channel_insight"|"pricing", "description": "concise pattern description"}]

JSON only, no markdown:`,
      maxTokens: 400
    });

    const cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const patterns = JSON.parse(cleaned);
    if (!Array.isArray(patterns)) return [];

    const results = [];
    for (const p of patterns.slice(0, 3)) {
      if (!p.type || !p.description) continue;
      const pattern = db.upsertPattern(p.type, p.description, null);
      results.push(pattern);
    }
    return results;
  } catch (err) {
    console.error('[intelligence] extractDealPatterns failed:', err.message);
    return [];
  }
}

async function processDealOutcome(deal) {
  // Extract patterns via AI
  const patterns = await extractDealPatterns(deal);
  if (patterns.length > 0) {
    console.log(`[intelligence] Extracted ${patterns.length} patterns from deal`);
  }

  // Auto-create content trigger for lost deals with detailed loss_reason
  if ((deal.outcome === 'lost' || deal.outcome === 'ghosted') && (deal.loss_reason || '').length >= 20) {
    try {
      const triggers = readJSON('trigger-queue.json');
      triggers.push({
        id: `deal-${generateId()}`,
        source: 'deal_insight',
        title: `Deal lost: ${deal.loss_reason.slice(0, 80)}`,
        raw_content: `Loss reason: ${deal.loss_reason}\n${deal.what_failed ? 'What failed: ' + deal.what_failed : ''}\nPractice area: ${deal.practice_area || 'unknown'}`,
        category: 'PAIN_POINT',
        url: null,
        captured_at: now(),
        status: 'pending'
      });
      writeJSON('trigger-queue.json', triggers);
      console.log('[intelligence] Created content trigger from lost deal');
    } catch (err) {
      console.error('[intelligence] Failed to create lost deal trigger:', err.message);
    }
  }

  // Auto-create content trigger for won deals with what_worked
  if (deal.outcome === 'won' && (deal.what_worked || '').length >= 10) {
    try {
      const triggers = readJSON('trigger-queue.json');
      triggers.push({
        id: `deal-${generateId()}`,
        source: 'deal_insight',
        title: `Win story: ${deal.what_worked.slice(0, 80)}`,
        raw_content: `What worked: ${deal.what_worked}\n${deal.monthly_value ? 'Value: $' + deal.monthly_value + '/mo' : ''}\nPractice area: ${deal.practice_area || 'unknown'}`,
        category: 'DATA_POINT',
        tags: ['case-study-candidate'],
        url: null,
        captured_at: now(),
        status: 'pending'
      });
      writeJSON('trigger-queue.json', triggers);
      console.log('[intelligence] Created content trigger from won deal');
    } catch (err) {
      console.error('[intelligence] Failed to create won deal trigger:', err.message);
    }
  }

  return patterns;
}

function getTopInsights(limit = 20) {
  const d = db.getDb();
  return d.prepare(`
    SELECT * FROM learned_insights
    WHERE status = 'active'
    ORDER BY (confidence * frequency) DESC
    LIMIT ?
  `).all(limit);
}

function getRecentInputs(limit = 10) {
  const d = db.getDb();
  return d.prepare(`
    SELECT * FROM team_inputs
    WHERE answer IS NOT NULL
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);
}

function getDealPatterns() {
  const d = db.getDb();
  const outcomes = d.prepare(`SELECT * FROM deal_outcomes ORDER BY recorded_at DESC LIMIT 50`).all();
  if (outcomes.length === 0) return null;

  const closed = outcomes.filter(o => o.outcome === 'closed');
  const lost = outcomes.filter(o => o.outcome === 'lost' || o.outcome === 'ghosted');

  const avgCloseTime = closed.length > 0
    ? Math.round(closed.reduce((s, o) => s + (o.close_time_days || 0), 0) / closed.length)
    : null;

  const avgValue = closed.length > 0
    ? Math.round(closed.reduce((s, o) => s + (o.monthly_value || 0), 0) / closed.length)
    : null;

  const lossReasons = {};
  for (const o of lost) {
    if (o.loss_reason) {
      lossReasons[o.loss_reason] = (lossReasons[o.loss_reason] || 0) + 1;
    }
  }

  return {
    total_deals: outcomes.length,
    closed: closed.length,
    lost: lost.length,
    close_rate: outcomes.length > 0 ? Math.round(closed.length / outcomes.length * 100) : 0,
    avg_close_time_days: avgCloseTime,
    avg_monthly_value: avgValue,
    top_loss_reasons: Object.entries(lossReasons).sort((a, b) => b[1] - a[1]).slice(0, 5)
  };
}

function buildIntelligenceContext() {
  const parts = [];

  // Top insights
  const insights = getTopInsights(15);
  if (insights.length > 0) {
    parts.push('LEARNED INTELLIGENCE:');
    for (const i of insights) {
      parts.push(`- [${i.category}] ${i.insight} (confidence: ${Math.round(i.confidence * 100)}%, seen ${i.frequency}x)`);
    }
  }

  // Deal patterns
  const patterns = getDealPatterns();
  if (patterns && patterns.total_deals > 0) {
    parts.push(`\nDEAL PATTERNS (${patterns.total_deals} deals tracked):`);
    parts.push(`- Close rate: ${patterns.close_rate}%`);
    if (patterns.avg_close_time_days) parts.push(`- Avg time to close: ${patterns.avg_close_time_days} days`);
    if (patterns.avg_monthly_value) parts.push(`- Avg deal value: $${patterns.avg_monthly_value}/mo`);
    if (patterns.top_loss_reasons.length > 0) {
      parts.push('- Top loss reasons: ' + patterns.top_loss_reasons.map(([r, c]) => `${r} (${c}x)`).join(', '));
    }
  }

  // Recent team inputs
  const inputs = getRecentInputs(5);
  if (inputs.length > 0) {
    parts.push('\nRECENT TEAM INPUTS:');
    for (const i of inputs) {
      parts.push(`- Q: ${i.question} → A: ${i.answer} (by ${i.answered_by || 'unknown'})`);
    }
  }

  return parts.join('\n');
}

module.exports = { getTopInsights, getRecentInputs, getDealPatterns, buildIntelligenceContext, extractDealPatterns, processDealOutcome };
