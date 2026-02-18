const { callClaude, parseJsonResponse, SONNET } = require('./claude');
const db = require('./db');
const { getKnowledgeBase } = require('./knowledge');
const { calculateROI } = require('./advisory');

async function generateProposal(meetingId) {
  const meeting = db.getMeeting(meetingId);
  if (!meeting) throw new Error(`Meeting #${meetingId} not found`);

  const ed = meeting.extracted_data || {};
  const classification = meeting.classification || {};

  // Calculate ROI projections for this prospect
  const roi = calculateROI({
    practice_area: (ed.client_info?.practice_areas || [])[0] || null,
    avg_case_value: ed.budget?.avg_case_value || null,
    current_cases: ed.budget?.current_cases || null,
    desired_cases: ed.budget?.desired_cases || null,
    current_spend: ed.budget?.current_spend || null
  });

  // Build context from meeting data
  const context = [];
  context.push(`Meeting: ${meeting.title}`);
  context.push(`Date: ${meeting.date}`);
  context.push(`Type: ${classification.type || meeting.meeting_type || 'unknown'}`);
  if (meeting.summary) context.push(`Summary: ${meeting.summary}`);
  if (ed.pain_points?.length) context.push(`Pain Points: ${ed.pain_points.join('; ')}`);
  if (ed.goals?.length) context.push(`Goals: ${ed.goals.join('; ')}`);
  if (ed.services_discussed?.length) context.push(`Services Discussed: ${ed.services_discussed.join(', ')}`);
  if (ed.objections?.length) context.push(`Objections: ${ed.objections.join('; ')}`);
  if (ed.budget?.mentioned) context.push(`Budget: ${ed.budget.range || 'mentioned but no range given'}`);
  if (ed.timeline) context.push(`Timeline: ${ed.timeline}`);
  if (ed.client_info?.name) context.push(`Client: ${ed.client_info.name}${ed.client_info.firm ? ' at ' + ed.client_info.firm : ''}`);
  if (ed.client_info?.practice_areas?.length) context.push(`Practice Areas: ${ed.client_info.practice_areas.join(', ')}`);

  // Add ROI projections to context
  context.push(`\nROI PROJECTIONS:`);
  context.push(`Conservative: ${roi.scenarios.worst.cases} cases/mo → $${roi.scenarios.worst.revenue.toLocaleString()}/mo`);
  context.push(`Expected: ${roi.scenarios.expected.cases} cases/mo → $${roi.scenarios.expected.revenue.toLocaleString()}/mo`);
  context.push(`Strong: ${roi.scenarios.strong.cases} cases/mo → $${roi.scenarios.strong.revenue.toLocaleString()}/mo`);
  context.push(`Recommended fee: $${roi.recommended_fee.toLocaleString()}/mo`);
  context.push(`Expected ROI: ${roi.roi}x`);

  // Include transcript snippet for extra context
  const transcript = (meeting.transcript || '').slice(0, 4000);
  if (transcript) context.push(`\nTranscript snippet:\n${transcript}`);

  const prompt = `Generate a 10-section proposal for this prospect based on the discovery call data below.

${context.join('\n')}

THE GRAND SLAM OFFER (Full Intake Machine — $10K/month target):
Value Stack ($21,500/mo perceived): AI Voice Agent ($4,500), Paid Advertising ($3,500), CRM Build ($2,000), Automated Follow-Up ($2,500), Dead Lead Reactivation ($2,000), Consultation Reminders ($500), Real-Time Dashboard ($1,500), Monthly Reports ($500), Dedicated Account Manager ($4,000).
Bonuses ($9,500): CRM Migration ($2,000), Dead Lead Blitz ($2,500), Competitor Intel Report ($1,500), Quarterly Strategy Session ($3,500).
Wave Fee: Option A $20K setup + $7.5K/mo OR Option B (recommended) $0 setup + $10K/mo (12-month, 90-day exit).
Guarantee: "Minimum [X] booked, qualified consultations in 90 days. If not — and you completed onboarding in 7 days and maintained ad budget — exit with no wave fee, last month refunded."
Guarantee is for CONSULTATIONS not clients. Conditional on their cooperation.
NEVER present price before value. NEVER discount — add bonuses instead.

Return JSON only (no markdown fences):
{
  "title": "Proposal title",
  "letter": "1-2 paragraphs personalized letter based on their pain points. Reference specific things from the call.",
  "value_stack": [
    { "item": "Service/component name", "description": "What it does for THEM specifically", "perceived_value": monthly perceived value as number }
  ],
  "case_study": "2-3 paragraphs about Mandall Law IMMIGRATION: $4K ad budget → $92K/mo revenue, 30+ signed cases/month. Connect to this prospect's situation.",
  "voice_ai_scenarios": ["Scenario 1: prospect calls at 2 AM...", "Scenario 2: ...", "Scenario 3: ..."],
  "differentiators": ["Why Mortar Metrics point 1", "Point 2", "Point 3"],
  "roi_section": "Paragraph framing investment vs return using the ROI projections. Show 3 scenarios with THEIR numbers.",
  "pricing": {
    "option_a": { "setup": 20000, "monthly": 7500 },
    "option_b": { "setup": 0, "monthly": 10000, "commitment": "12 months, 90-day exit clause" },
    "recommended": "B",
    "ad_spend": "3000-5000/mo on their own account (separate)"
  },
  "timeline": [
    { "week": "Week 1-2", "deliverables": "CRM build, voice agent setup, ad creative" },
    { "week": "Week 3-4", "deliverables": "Campaigns live, first leads" }
  ],
  "faq": [
    { "question": "Objection/question from their call", "answer": "Direct answer" }
  ],
  "guarantee": "Specific guarantee statement tied to consultations, conditional on their cooperation.",
  "next_steps": ["Step 1", "Step 2"],
  "monthly_investment": recommended monthly investment as number
}

RULES:
- Adapt the Grand Slam Offer to their practice area and situation
- Only include value stack items relevant to what they need
- Case study MUST be Mandall Law IMMIGRATION — never fake firms
- FAQ must address their ACTUAL objections from the call (not generic)
- ROI section uses the projections provided, not made-up numbers
- Guarantee is for consultations, not revenue or clients
- Voice AI scenarios should be specific to their practice area
- Price should reflect what they discussed — $10K is the target but flex based on services needed
- Terms: no contract, 30 days notice, keep everything built`;

  const kb = getKnowledgeBase();
  const text = await callClaude({
    model: SONNET,
    system: `You are the proposal writer for Mortar Metrics. Generate targeted 10-section proposals using the Hormozi Grand Slam Offer framework. Return JSON only.\n\nBUSINESS CONTEXT:\n${kb}`,
    prompt,
    maxTokens: 4000
  });

  const parsed = parseJsonResponse(text) || {};

  // Find or create client
  let clientId = null;
  const clientInfo = ed.client_info || {};
  if (clientInfo.name || meeting.client_name) {
    const client = db.upsertClient(clientInfo.email || meeting.client_email || null, {
      name: clientInfo.name || meeting.client_name,
      firm_name: clientInfo.firm || null,
      practice_areas: clientInfo.practice_areas || []
    });
    clientId = client?.id || null;
  }

  // Build 10-section markdown proposal
  const totalMonthly = parsed.monthly_investment || parsed.pricing?.option_b?.monthly || 10000;
  const valueStack = parsed.value_stack || [];
  const totalPerceived = valueStack.reduce((s, v) => s + (v.perceived_value || 0), 0);

  let md = `# ${parsed.title || 'The Full Intake Machine'}\n\n`;

  // 1. Letter
  md += `## A Note For You\n\n${parsed.letter || ''}\n\n`;

  // 2. What You Get (Value Stack)
  md += `## What You Get\n\n`;
  for (const item of valueStack) {
    md += `### ${item.item}${item.perceived_value ? ` ($${item.perceived_value.toLocaleString()}/mo value)` : ''}\n`;
    md += `${item.description}\n\n`;
  }
  if (totalPerceived) {
    md += `**Total Value: $${totalPerceived.toLocaleString()}/month**\n\n`;
  }

  // 3. Case Study
  md += `## Proof: Mandall Law\n\n${parsed.case_study || 'Mandall Law (immigration) went from $4,000/month ad budget to $92,000/month in revenue with 30+ signed cases every month.'}\n\n`;

  // 4. Voice AI
  if (parsed.voice_ai_scenarios?.length) {
    md += `## Your AI Intake Agent\n\n`;
    for (const scenario of parsed.voice_ai_scenarios) {
      md += `- ${scenario}\n`;
    }
    md += '\n';
  }

  // 5. Why Mortar Metrics
  if (parsed.differentiators?.length) {
    md += `## Why Mortar Metrics\n\n`;
    for (const d of parsed.differentiators) {
      md += `- ${d}\n`;
    }
    md += '\n';
  }

  // 6. The Math (ROI)
  md += `## The Math\n\n${parsed.roi_section || ''}\n\n`;
  md += `| Scenario | Cases/Month | Monthly Revenue |\n|----------|------------|----------------|\n`;
  md += `| Conservative | ${roi.scenarios.worst.cases} | $${roi.scenarios.worst.revenue.toLocaleString()} |\n`;
  md += `| Expected | ${roi.scenarios.expected.cases} | $${roi.scenarios.expected.revenue.toLocaleString()} |\n`;
  md += `| Strong | ${roi.scenarios.strong.cases} | $${roi.scenarios.strong.revenue.toLocaleString()} |\n\n`;

  // 7. Pricing
  md += `## Investment\n\n`;
  if (parsed.pricing) {
    const p = parsed.pricing;
    md += `**Option A:** $${(p.option_a?.setup || 20000).toLocaleString()} setup + $${(p.option_a?.monthly || 7500).toLocaleString()}/month\n\n`;
    md += `**Option B (Recommended):** $0 setup + $${(p.option_b?.monthly || 10000).toLocaleString()}/month\n`;
    md += `${p.option_b?.commitment || '12-month commitment, 90-day exit clause'}\n\n`;
    md += `*Ad spend: $${p.ad_spend || '3,000-5,000'}/month on your own account (separate)*\n\n`;
  } else {
    md += `**Monthly: $${totalMonthly.toLocaleString()}/mo**\n\n`;
  }

  // 8. Timeline
  if (parsed.timeline?.length) {
    md += `## Timeline\n\n`;
    for (const t of parsed.timeline) {
      md += `**${t.week}:** ${t.deliverables}\n\n`;
    }
  }

  // 9. FAQ
  if (parsed.faq?.length) {
    md += `## Questions You Might Have\n\n`;
    for (const f of parsed.faq) {
      md += `**${f.question}**\n${f.answer}\n\n`;
    }
  }

  // 10. Guarantee + Next Steps
  if (parsed.guarantee) {
    md += `## Our Guarantee\n\n${parsed.guarantee}\n\n`;
  }
  md += `## Next Steps\n\n`;
  for (const step of (parsed.next_steps || ['Schedule a follow-up call', 'Choose your option'])) {
    md += `1. ${step}\n`;
  }
  md += `\n*Terms: No long-term contract. 30 days notice. You keep everything we build.*\n`;

  // Insert proposal
  const proposal = db.insertProposal({
    meeting_id: meetingId,
    client_id: clientId,
    title: parsed.title || `Proposal for ${clientInfo.name || meeting.client_name || 'Prospect'}`,
    content: md,
    services: valueStack.map(v => v.item),
    monthly_value: totalMonthly,
    status: 'draft'
  });

  console.log(`[proposal] Generated proposal #${proposal.id}: ${proposal.title} ($${totalMonthly}/mo)`);
  return { ...proposal, parsed };
}

module.exports = { generateProposal };
