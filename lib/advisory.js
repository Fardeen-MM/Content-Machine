const db = require('./db');
const { callClaude, parseJsonResponse, SONNET } = require('./claude');
const { getKnowledgeBase } = require('./knowledge');
const { buildIntelligenceContext } = require('./intelligence');

// ROI calculator for proposals and chat brain
function calculateROI({ practice_area, avg_case_value, current_cases, desired_cases, current_spend }) {
  const caseValue = avg_case_value || 5000;
  const currentRev = (current_cases || 0) * caseValue;

  // Conservative projections based on practice area
  const multipliers = {
    'personal injury': { low: 1.5, mid: 2.5, high: 4.0 },
    'immigration': { low: 1.3, mid: 2.0, high: 3.0 },
    'family law': { low: 1.2, mid: 1.8, high: 2.5 },
    'criminal defense': { low: 1.3, mid: 2.0, high: 3.0 },
    'default': { low: 1.2, mid: 1.8, high: 2.5 }
  };

  const mult = multipliers[practice_area?.toLowerCase()] || multipliers.default;
  const baseCases = current_cases || 5;

  const scenarios = {
    worst: {
      label: 'Conservative',
      cases: Math.round(baseCases * mult.low),
      revenue: Math.round(baseCases * mult.low * caseValue),
    },
    expected: {
      label: 'Expected',
      cases: desired_cases || Math.round(baseCases * mult.mid),
      revenue: (desired_cases || Math.round(baseCases * mult.mid)) * caseValue,
    },
    strong: {
      label: 'Strong',
      cases: Math.round(baseCases * mult.high),
      revenue: Math.round(baseCases * mult.high * caseValue),
    }
  };

  // Recommend fee based on projected revenue
  const expectedRev = scenarios.expected.revenue;
  const recommendedFee = Math.min(Math.max(Math.round(expectedRev * 0.1 / 500) * 500, 3000), 10000);

  return {
    current: { cases: current_cases || 0, revenue: currentRev, spend: current_spend || 0 },
    scenarios,
    recommended_fee: recommendedFee,
    roi: recommendedFee > 0 ? Math.round((scenarios.expected.revenue - currentRev) / recommendedFee * 10) / 10 : 0,
    practice_area: practice_area || 'general'
  };
}

// Gap detection — analyze operational gaps
async function detectGaps() {
  const kb = getKnowledgeBase();
  const intel = buildIntelligenceContext();
  const stats = db.getStats();
  const health = db.getHealthOverview();
  const patterns = db.getPatterns({ limit: 20 });
  const insights = db.getInsights({ limit: 20 });
  const deals = db.getDealOutcomes({ limit: 20 });

  const context = `CURRENT STATE:
- ${stats.meetings?.total || 0} meetings, ${stats.clients?.total || 0} clients, ${stats.actions?.open || 0} open actions
- Health: ${health.summary?.green || 0} green, ${health.summary?.yellow || 0} yellow, ${health.summary?.red || 0} red
- ${deals.length} deal outcomes tracked

TOP PATTERNS:
${patterns.slice(0, 10).map(p => `- [${p.type}] ${p.description} (${p.frequency}x)`).join('\n') || '(none)'}

LEARNED INSIGHTS:
${insights.slice(0, 10).map(i => `- [${i.category}] ${i.insight}`).join('\n') || '(none)'}

DEAL OUTCOMES:
${deals.slice(0, 10).map(d => `- ${d.client_name || 'Unknown'}: ${d.outcome}${d.monthly_value ? ' $' + d.monthly_value + '/mo' : ''}${d.loss_reason ? ' — ' + d.loss_reason : ''}`).join('\n') || '(none yet)'}`;

  const prompt = `Given the current state of Mortar Metrics, identify the top 3-5 operational gaps that would most impact the path to $100K MRR.

${context}

Known gaps to consider:
- No sales deck (Yaseer wings calls)
- No discovery call script/framework
- No ROI calculator during calls
- No formal guarantee structure
- No email segmentation
- No client reporting dashboard
- GHL pipeline too loose
- Proposal turnaround too slow
- Speed to lead not tracked

Return JSON (no fences):
{ "gaps": [{ "gap": "description", "lever": "Volume|Conversion|Speed|Retention", "impact": "high|medium|low", "fix": "specific actionable fix", "owner": "fardeen|yaseer|monty|juhi" }], "bottleneck": "the single biggest constraint right now" }`;

  const text = await callClaude({
    model: SONNET,
    system: `${kb}\n\n${intel}\n\nYou are a $10M agency consultant analyzing operational gaps. Be specific and actionable.`,
    prompt,
    maxTokens: 2000
  });

  return parseJsonResponse(text) || { gaps: [], bottleneck: 'Unknown' };
}

// Extract discovery call framework from best calls
async function extractDiscoveryFramework() {
  const meetings = db.getMeetings({ limit: 50, type: 'discovery' });
  // Find the best calls (ones with high coaching scores and positive sentiment)
  const bestCalls = meetings
    .filter(m => m.coaching_notes?.score >= 60 && m.extracted_data)
    .sort((a, b) => (b.coaching_notes?.score || 0) - (a.coaching_notes?.score || 0))
    .slice(0, 5);

  if (bestCalls.length === 0) {
    return { framework: null, message: 'Not enough scored discovery calls to extract a framework. Need at least 1 call with coaching score >= 60.' };
  }

  const callSummaries = bestCalls.map(m => {
    const ed = m.extracted_data || {};
    const cn = m.coaching_notes || {};
    return `Score: ${cn.score}/100 | ${m.client_name || m.title}
    Strengths: ${(cn.strengths || []).join('; ')}
    Pain points uncovered: ${(ed.pain_points || []).join('; ')}
    Services discussed: ${(ed.services_discussed || []).join(', ')}
    Objections: ${(ed.objections || []).join('; ')}
    Result: ${ed.sentiment || 'unknown'}`;
  }).join('\n\n');

  const kb = getKnowledgeBase();

  const prompt = `Analyze these top-scoring discovery calls and extract a reusable call framework for Yaseer.

BEST CALLS:
${callSummaries}

Create a discovery call framework that captures what works. Return JSON (no fences):
{
  "framework": {
    "opening": ["step 1", "step 2"],
    "discovery_questions": ["question 1", "question 2"],
    "presentation": ["step 1"],
    "objection_handling": ["technique 1"],
    "closing": ["step 1"]
  },
  "key_principles": ["principle 1"],
  "common_mistakes": ["mistake 1"]
}`;

  const text = await callClaude({
    model: SONNET,
    system: `${kb}\n\nYou extract sales call frameworks from real call data. Be specific and actionable for someone who wings calls.`,
    prompt,
    maxTokens: 2000
  });

  return parseJsonResponse(text) || { framework: null };
}

module.exports = { calculateROI, detectGaps, extractDiscoveryFramework };
