const { callClaude, parseJsonResponse, SONNET } = require('./claude');
const db = require('./db');

async function generateProposal(meetingId) {
  const meeting = db.getMeeting(meetingId);
  if (!meeting) throw new Error(`Meeting #${meetingId} not found`);

  const ed = meeting.extracted_data || {};
  const classification = meeting.classification || {};

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

  // Include transcript snippet for extra context
  const transcript = (meeting.transcript || '').slice(0, 4000);
  if (transcript) context.push(`\nTranscript snippet:\n${transcript}`);

  const prompt = `Generate a proposal for this prospect based on the discovery call data below.

${context.join('\n')}

Return JSON only (no markdown fences):
{
  "title": "Proposal title (e.g. 'Marketing Growth Plan for [Firm Name]')",
  "executive_summary": "2-3 paragraph executive summary addressing their specific pain points and how we solve them",
  "recommended_services": [
    {
      "service": "Service name (e.g. SEO, PPC, Web Design, Voice Agent, CRM, Lead Gen)",
      "description": "Why this service is recommended based on what they discussed",
      "monthly_cost": estimated monthly cost as number (be realistic: SEO $2000-5000, PPC $1500-4000, Web Design $3000-8000 one-time, Voice Agent $500-1500, CRM $500-1000, Lead Gen $1000-3000)
    }
  ],
  "timeline": "Proposed implementation timeline (e.g. '90-day ramp-up')",
  "monthly_investment": total monthly investment as number,
  "expected_outcomes": ["Specific, measurable outcome 1", "Outcome 2", "Outcome 3"],
  "next_steps": ["Clear next step 1", "Next step 2"]
}

RULES:
- Only recommend services that were actually discussed or clearly needed based on their pain points
- Be specific to their practice area and situation — not generic
- Price realistically for a mid-market legal marketing agency
- Address their specific objections in the executive summary
- If budget was mentioned, stay within or close to their range
- Expected outcomes should be realistic and time-bound`;

  const text = await callClaude({
    model: SONNET,
    system: 'You are a legal marketing agency proposal writer. Generate targeted proposals based on discovery call data. Return JSON only.',
    prompt,
    maxTokens: 3000
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

  // Build markdown proposal
  const services = parsed.recommended_services || [];
  const totalMonthly = parsed.monthly_investment || services.reduce((s, svc) => s + (svc.monthly_cost || 0), 0);

  let markdown = `# ${parsed.title || 'Marketing Growth Plan'}\n\n`;
  markdown += `## Executive Summary\n\n${parsed.executive_summary || ''}\n\n`;
  markdown += `## Recommended Services\n\n`;
  for (const svc of services) {
    markdown += `### ${svc.service}\n${svc.description}\n- Monthly: $${(svc.monthly_cost || 0).toLocaleString()}\n\n`;
  }
  markdown += `## Timeline\n\n${parsed.timeline || 'To be discussed'}\n\n`;
  markdown += `## Expected Outcomes\n\n`;
  for (const outcome of (parsed.expected_outcomes || [])) {
    markdown += `- ${outcome}\n`;
  }
  markdown += `\n## Investment\n\n**Monthly: $${totalMonthly.toLocaleString()}/mo**\n\n`;
  markdown += `## Next Steps\n\n`;
  for (const step of (parsed.next_steps || [])) {
    markdown += `1. ${step}\n`;
  }

  // Insert proposal
  const proposal = db.insertProposal({
    meeting_id: meetingId,
    client_id: clientId,
    title: parsed.title || `Proposal for ${clientInfo.name || meeting.client_name || 'Prospect'}`,
    content: markdown,
    services: services.map(s => s.service),
    monthly_value: totalMonthly,
    status: 'draft'
  });

  console.log(`[proposal] Generated proposal #${proposal.id}: ${proposal.title} ($${totalMonthly}/mo)`);
  return { ...proposal, parsed };
}

module.exports = { generateProposal };
