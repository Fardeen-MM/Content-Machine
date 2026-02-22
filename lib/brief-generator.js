const { callClaude, SONNET } = require('./claude');
const db = require('./db');
const { getKnowledgeBase } = require('./knowledge');

async function generateBrief(clientId) {
  const client = db.getClient(clientId);
  if (!client) throw new Error(`Client #${clientId} not found`);

  // Gather all known data about this client
  const meetings = db.getMeetings({ client: client.name, limit: 10 }) || [];
  const actions = db.getActions({ client_id: clientId }) || [];
  const atoms = [];
  for (const m of meetings) {
    const meetingAtoms = db.getAtoms({ meeting_id: m.id }) || [];
    atoms.push(...meetingAtoms);
  }
  const patterns = db.getPatterns({ limit: 20 }) || [];
  const proposals = db.getProposals({ client_id: clientId }) || [];
  const health = db.computeClientHealth(clientId);

  // Build context
  const sections = [];

  // Client profile
  sections.push(`CLIENT PROFILE:
- Name: ${client.name}
- Email: ${client.email || 'Unknown'}
- Firm: ${client.firm_name || 'Unknown'}
- Practice Areas: ${(client.practice_areas || []).join(', ') || 'Unknown'}
- Status: ${client.status}
- First Contact: ${client.first_seen ? new Date(client.first_seen).toLocaleDateString() : 'Unknown'}
- Last Contact: ${client.last_seen ? new Date(client.last_seen).toLocaleDateString() : 'Unknown'}`);

  // Health
  if (health) {
    sections.push(`HEALTH: ${health.health_status.toUpperCase()} (${health.score}/100) — ${health.notes}`);
  }

  // Meeting history
  if (meetings.length > 0) {
    sections.push('MEETING HISTORY:');
    for (const m of meetings) {
      const ed = m.extracted_data || {};
      const cn = m.coaching_notes;
      let entry = `- ${m.date?.slice(0, 10)} | ${m.title} | ${m.meeting_type}`;
      if (m.summary) entry += `\n  Summary: ${m.summary}`;
      if (ed.pain_points?.length) entry += `\n  Pain points: ${ed.pain_points.join('; ')}`;
      if (ed.goals?.length) entry += `\n  Goals: ${ed.goals.join('; ')}`;
      if (ed.services_discussed?.length) entry += `\n  Services: ${ed.services_discussed.join(', ')}`;
      if (ed.objections?.length) entry += `\n  Objections: ${ed.objections.join('; ')}`;
      if (ed.budget?.mentioned) entry += `\n  Budget: ${ed.budget.range || 'mentioned'}`;
      if (cn) entry += `\n  Coaching: ${cn.score}/100`;
      sections.push(entry);
    }
  }

  // Open actions
  const openActions = actions.filter(a => a.status === 'open');
  if (openActions.length > 0) {
    sections.push('OPEN ACTION ITEMS:');
    for (const a of openActions) {
      sections.push(`- [${a.owner || '?'}] ${a.description}${a.due_date ? ' (due: ' + a.due_date + ')' : ''}`);
    }
  }

  // Proposals
  if (proposals.length > 0) {
    sections.push('PROPOSALS:');
    for (const p of proposals) {
      sections.push(`- ${p.title} | Status: ${p.status} | $${(p.monthly_value || 0).toLocaleString()}/mo | ${(p.services || []).join(', ')}`);
    }
  }

  // Content atoms
  if (atoms.length > 0) {
    sections.push(`KEY INSIGHTS FROM CALLS (${atoms.length} total):`);
    for (const a of atoms.slice(0, 10)) {
      sections.push(`- [${a.type}] ${a.content}`);
    }
  }

  // Relevant patterns
  const relevantPatterns = patterns.filter(p => {
    const meetingIds = meetings.map(m => m.id);
    return (p.meeting_ids || []).some(id => meetingIds.includes(id));
  });
  if (relevantPatterns.length > 0) {
    sections.push('PATTERNS FROM THEIR CALLS:');
    for (const p of relevantPatterns) {
      sections.push(`- [${p.type}] ${p.description}`);
    }
  }

  const context = sections.join('\n\n');

  const prompt = `Generate a pre-call research brief for the upcoming call with this client/prospect. This brief should help the salesperson (Yaseer from Mortar Metrics) prepare.

${context}

Write a concise, actionable brief with these sections:
1. QUICK SUMMARY — Who is this person, what's their situation in 2-3 sentences
2. KEY HISTORY — What happened in previous calls (bullet points)
3. OUTSTANDING ITEMS — What actions are pending, what was promised
4. TALKING POINTS — 3-5 specific things to bring up on this call
5. OBJECTIONS TO EXPECT — Based on patterns and previous objections
6. CLOSE STRATEGY — How to move this deal forward, specific ask to make
7. WARNING FLAGS — Anything to be careful about (stale deal, negative sentiment, etc.)

RULES:
- Be specific. Name specific services, pain points, and numbers discussed.
- Reference what was said in previous calls — continuity matters.
- If there's an open proposal, focus on closing it.
- If the deal is going cold, suggest re-engagement tactics.
- Write like a chief of staff briefing the CEO before a meeting — direct, actionable, no fluff.`;

  const kb = getKnowledgeBase();
  const text = await callClaude({
    model: SONNET,
    system: `You are the sales intelligence analyst for Mortar Metrics preparing call briefings. Be direct, specific, and actionable.\n\nBUSINESS CONTEXT:\n${kb.slice(0, 2000)}`,
    prompt,
    maxTokens: 2000
  });

  // Save to briefs table
  const dbResult = db.getDb().prepare(`
    INSERT INTO briefs (client_id, brief_text)
    VALUES (?, ?)
  `).run(clientId, text);

  const brief = db.getDb().prepare('SELECT * FROM briefs WHERE id = ?').get(dbResult.lastInsertRowid);

  console.log(`[brief-gen] Generated brief #${brief?.id || '?'} for ${client.name}`);
  return { ...(brief || { id: dbResult.lastInsertRowid, client_id: clientId, brief_text: text }), client };
}

function getBriefs({ client_id, limit = 50 } = {}) {
  const db_instance = db.getDb();
  let sql = 'SELECT b.*, c.name as client_name FROM briefs b LEFT JOIN clients c ON b.client_id = c.id WHERE 1=1';
  const params = [];
  if (client_id) { sql += ' AND b.client_id = ?'; params.push(client_id); }
  sql += ' ORDER BY b.created_at DESC LIMIT ?';
  params.push(limit);
  return db_instance.prepare(sql).all(...params);
}

module.exports = { generateBrief, getBriefs };
