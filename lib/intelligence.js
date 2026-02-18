const db = require('./db');

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

module.exports = { getTopInsights, getRecentInputs, getDealPatterns, buildIntelligenceContext };
