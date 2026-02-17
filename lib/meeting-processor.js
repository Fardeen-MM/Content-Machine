const { callClaude, parseJsonResponse, HAIKU, SONNET } = require('./claude');
const db = require('./db');

async function processMeeting(meetingRow) {
  console.log(`[processor] Processing meeting #${meetingRow.id}: ${meetingRow.title}`);

  const transcript = meetingRow.transcript || '';
  if (!transcript.trim()) {
    console.log(`[processor] Skipping meeting #${meetingRow.id} — no transcript`);
    return meetingRow;
  }

  // Step 1: Classify
  const classification = await classifyMeeting(meetingRow.title, transcript);
  console.log(`[processor] Classified as: ${classification.type} (${classification.confidence}%)`);

  // Step 2: Extract
  const extracted = await extractMeetingData(transcript);
  console.log(`[processor] Extracted ${extracted.action_items?.length || 0} action items`);

  // Step 3: Content Atoms
  const atoms = await extractContentAtoms(transcript, extracted);
  console.log(`[processor] Found ${atoms.length} content atoms`);

  // Step 4: Pattern Analysis
  const existingPatterns = db.getPatterns({ limit: 50 });
  const newPatterns = await analyzePatterns(extracted, existingPatterns);
  console.log(`[processor] Identified ${newPatterns.length} patterns`);

  // Step 5: Coaching (only for discovery/review calls)
  let coaching = null;
  if (classification.type === 'discovery' || classification.type === 'review') {
    coaching = await generateCoaching(transcript, extracted);
    console.log(`[processor] Coaching score: ${coaching.score}/100`);
  }

  // Step 6: Auto-create client profile
  let clientId = null;
  if (extracted.client_info?.email || extracted.client_info?.name) {
    const client = db.upsertClient(extracted.client_info.email, {
      name: extracted.client_info.name || meetingRow.client_name || 'Unknown',
      email: extracted.client_info.email || meetingRow.client_email,
      firm_name: extracted.client_info.firm || null,
      practice_areas: extracted.client_info.practice_areas || [],
      source: 'fireflies'
    });
    clientId = client?.id || null;
  }

  // Step 7: Insert action items
  if (extracted.action_items?.length > 0) {
    for (const item of extracted.action_items) {
      db.insertAction({
        meeting_id: meetingRow.id,
        client_id: clientId,
        description: item.description,
        owner: item.owner || null,
        due_date: item.due || null
      });
    }
  }

  // Step 8: Insert content atoms
  for (const atom of atoms) {
    db.insertAtom({
      meeting_id: meetingRow.id,
      type: atom.type,
      content: atom.content,
      tags: atom.tags || []
    });
  }

  // Step 9: Upsert patterns
  for (const pattern of newPatterns) {
    db.upsertPattern(pattern.type, pattern.description, meetingRow.id);
  }

  // Step 10: Update meeting row
  const updated = db.updateMeeting(meetingRow.id, {
    meeting_type: classification.type,
    summary: extracted.summary || null,
    sentiment: extracted.sentiment || null,
    classification,
    extracted_data: extracted,
    coaching_notes: coaching,
    client_name: extracted.client_info?.name || meetingRow.client_name,
    client_email: extracted.client_info?.email || meetingRow.client_email,
    processed_at: new Date().toISOString()
  });

  console.log(`[processor] Meeting #${meetingRow.id} processed successfully`);
  return updated;
}

async function classifyMeeting(title, transcript) {
  const snippet = transcript.slice(0, 500);
  const prompt = `Classify this meeting based on its title and transcript snippet.

Title: ${title}
Transcript snippet: ${snippet}

Return JSON only (no markdown fences):
{
  "type": "discovery" | "onboarding" | "review" | "strategy" | "internal" | "unknown",
  "confidence": 0-100,
  "signals": ["signal1", "signal2"]
}

Types:
- discovery: First call with a prospect, exploring their needs
- onboarding: Setting up a new client
- review: Reviewing performance/results with existing client
- strategy: Planning session (internal or with client)
- internal: Team-only meeting
- unknown: Cannot determine`;

  const text = await callClaude({ model: HAIKU, system: 'You classify meetings. Return JSON only.', prompt, maxTokens: 300 });
  return parseJsonResponse(text) || { type: 'unknown', confidence: 0, signals: [] };
}

async function extractMeetingData(transcript) {
  const truncated = transcript.slice(0, 8000);
  const prompt = `Extract structured data from this meeting transcript.

--- TRANSCRIPT ---
${truncated}
--- END ---

Return JSON only (no markdown fences):
{
  "summary": "2-3 sentence summary of the meeting",
  "pain_points": ["pain point 1", "pain point 2"],
  "goals": ["goal 1", "goal 2"],
  "budget": { "mentioned": true/false, "range": "$X-$Y/mo or null" },
  "timeline": "timeline mentioned or null",
  "services_discussed": ["SEO", "PPC", "Web Design", etc.],
  "objections": ["objection 1"],
  "decisions": ["decision 1"],
  "action_items": [{ "description": "what needs to happen", "owner": "us" or "client", "due": "date or null" }],
  "sentiment": "positive" | "neutral" | "negative" | "mixed",
  "client_info": { "name": "name or null", "email": "email or null", "firm": "firm name or null", "practice_areas": ["area1"] }
}`;

  const text = await callClaude({ model: SONNET, system: 'You extract structured data from meeting transcripts. Return JSON only.', prompt, maxTokens: 2000 });
  return parseJsonResponse(text) || {
    summary: null, pain_points: [], goals: [], budget: { mentioned: false, range: null },
    timeline: null, services_discussed: [], objections: [], decisions: [],
    action_items: [], sentiment: 'neutral', client_info: {}
  };
}

async function extractContentAtoms(transcript, extracted) {
  const truncated = transcript.slice(0, 4000);
  const prompt = `Extract reusable content atoms from this meeting for marketing content.

--- TRANSCRIPT ---
${truncated}
--- END ---

Meeting summary: ${extracted.summary || 'N/A'}
Pain points: ${JSON.stringify(extracted.pain_points || [])}

Return a JSON array (no markdown fences):
[
  {
    "type": "pain_point" | "success_story" | "objection" | "insight" | "quote",
    "content": "The actual content atom — a quote, insight, or observation",
    "tags": ["tag1", "tag2"]
  }
]

Only include genuinely interesting/useful atoms that could become social posts or blog content. Return 3-8 atoms max.`;

  const text = await callClaude({ model: HAIKU, system: 'You extract content atoms from meetings. Return JSON array only.', prompt, maxTokens: 1500 });
  return parseJsonResponse(text) || [];
}

async function analyzePatterns(extracted, existingPatterns) {
  const patternSummary = existingPatterns.slice(0, 20).map(p =>
    `${p.type}: ${p.description} (seen ${p.frequency}x)`
  ).join('\n');

  const prompt = `Identify patterns from this meeting data. Compare against existing patterns.

Meeting data:
- Pain points: ${JSON.stringify(extracted.pain_points || [])}
- Objections: ${JSON.stringify(extracted.objections || [])}
- Goals: ${JSON.stringify(extracted.goals || [])}
- Services discussed: ${JSON.stringify(extracted.services_discussed || [])}

Existing patterns:
${patternSummary || '(none yet)'}

Return a JSON array of patterns found (no markdown fences):
[
  {
    "type": "objection" | "pain_point" | "feature_request" | "pricing_concern",
    "description": "Brief pattern description",
    "is_new": true/false
  }
]

Only include clear, distinct patterns. Return 0-5 items.`;

  const text = await callClaude({ model: HAIKU, system: 'You identify patterns across meetings. Return JSON array only.', prompt, maxTokens: 800 });
  return parseJsonResponse(text) || [];
}

async function generateCoaching(transcript, extracted) {
  const truncated = transcript.slice(0, 6000);
  const prompt = `Evaluate this sales/client call and provide coaching feedback.

--- TRANSCRIPT ---
${truncated}
--- END ---

Meeting summary: ${extracted.summary || 'N/A'}
Services discussed: ${JSON.stringify(extracted.services_discussed || [])}
Objections raised: ${JSON.stringify(extracted.objections || [])}

Return JSON only (no markdown fences):
{
  "score": 0-100,
  "strengths": ["strength 1", "strength 2"],
  "improvements": ["improvement 1", "improvement 2"],
  "missed_opportunities": ["missed opportunity 1"]
}

Score guide:
- 90-100: Exceptional — hit all key points, handled objections well
- 70-89: Good — covered most bases, minor improvements possible
- 50-69: Average — missed some opportunities
- Below 50: Needs work — significant gaps in the conversation`;

  const text = await callClaude({ model: SONNET, system: 'You coach sales teams on meeting performance. Return JSON only.', prompt, maxTokens: 1000 });
  return parseJsonResponse(text) || { score: 0, strengths: [], improvements: [], missed_opportunities: [] };
}

module.exports = { processMeeting };
