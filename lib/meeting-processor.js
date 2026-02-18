const { callClaude, parseJsonResponse, HAIKU, SONNET } = require('./claude');
const { generateId, readJSON, writeJSON } = require('./utils');
const db = require('./db');
const { getKnowledgeBase } = require('./knowledge');

// Skip processing meetings shorter than this (likely connection tests, failed calls)
const MIN_TRANSCRIPT_LENGTH = 500;

async function processMeeting(meetingRow) {
  console.log(`[processor] Processing meeting #${meetingRow.id}: ${meetingRow.title}`);

  const transcript = meetingRow.transcript || '';
  if (!transcript.trim() || transcript.length < MIN_TRANSCRIPT_LENGTH) {
    console.log(`[processor] Skipping meeting #${meetingRow.id} — transcript too short (${transcript.length} chars)`);
    db.updateMeeting(meetingRow.id, {
      meeting_type: 'unknown',
      processed_at: new Date().toISOString()
    });
    return meetingRow;
  }

  // Step 1: Classify
  const classification = await classifyMeeting(meetingRow.title, transcript);
  console.log(`[processor] Classified as: ${classification.type} (${classification.confidence}%)`);

  // Skip AI processing for junk/test meetings
  if (classification.type === 'unknown' && classification.confidence < 40) {
    console.log(`[processor] Skipping low-confidence meeting #${meetingRow.id}`);
    db.updateMeeting(meetingRow.id, {
      meeting_type: 'unknown',
      classification,
      processed_at: new Date().toISOString()
    });
    return meetingRow;
  }

  // Step 2: Extract
  const extracted = await extractMeetingData(transcript, meetingRow.title);
  console.log(`[processor] Extracted ${extracted.action_items?.length || 0} action items`);

  // Step 3: Content Atoms (skip for internal/unknown meetings)
  let atoms = [];
  if (classification.type !== 'internal' && classification.type !== 'unknown') {
    atoms = await extractContentAtoms(transcript, extracted);
    console.log(`[processor] Found ${atoms.length} content atoms`);
  }

  // Step 4: Pattern Analysis
  const existingPatterns = db.getPatterns({ limit: 50 });
  const newPatterns = await analyzePatterns(extracted, existingPatterns);
  console.log(`[processor] Identified ${newPatterns.length} patterns`);

  // Step 5: Coaching (for discovery, review, and evaluation calls)
  let coaching = null;
  if (['discovery', 'review'].includes(classification.type)) {
    coaching = await generateCoaching(transcript, extracted, classification.type);
    console.log(`[processor] Coaching score: ${coaching.score}/100`);
  }

  // Step 6: Auto-create client profiles (one per person, not combined)
  let clientId = null;
  const clients = extracted.client_contacts || [];
  if (clients.length > 0) {
    for (const contact of clients) {
      if (!contact.name) continue;
      const client = db.upsertClient(contact.email || null, {
        name: contact.name,
        email: contact.email || null,
        firm_name: contact.firm || extracted.client_info?.firm || null,
        practice_areas: contact.practice_areas || extracted.client_info?.practice_areas || [],
        source: 'fireflies'
      });
      if (!clientId) clientId = client?.id || null;
    }
  } else if (extracted.client_info?.name) {
    // Fallback to single client_info
    const client = db.upsertClient(extracted.client_info.email || null, {
      name: extracted.client_info.name,
      email: extracted.client_info.email || null,
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

  // Step 8.5: Auto-create content trigger from high-value atoms
  if (atoms.length > 0 && ['discovery', 'review', 'demo'].includes(classification.type)) {
    try {
      const highValue = atoms.filter(a => ['pain_point', 'success_story', 'objection', 'insight'].includes(a.type));
      if (highValue.length >= 2) {
        const atomsText = highValue.map(a => `[${a.type}] ${a.content}`).join('\n\n');
        const trigger = {
          id: generateId(),
          source: 'meeting',
          source_id: String(meetingRow.id),
          title: `Meeting insight: ${(extracted.summary || meetingRow.title || '').slice(0, 80)}`,
          raw_content: atomsText,
          relevance_score: 85,
          category: 'CONTENT_PIECE',
          tags: ['from-call', classification.type, ...(extracted.services_discussed || []).slice(0, 3)],
          auto_generated: true,
          status: 'pending',
          created_at: new Date().toISOString()
        };

        const triggers = readJSON('trigger-queue.json');
        // Avoid duplicate triggers for the same meeting
        const exists = triggers.some(t => t.source === 'meeting' && t.source_id === String(meetingRow.id));
        if (!exists) {
          triggers.push(trigger);
          writeJSON('trigger-queue.json', triggers);
          console.log(`[processor] Created content trigger from meeting #${meetingRow.id}`);
        }
      }
    } catch (err) {
      console.error(`[processor] Failed to create trigger:`, err.message);
    }
  }

  // Step 9: Upsert patterns
  for (const pattern of newPatterns) {
    db.upsertPattern(pattern.type, pattern.description, meetingRow.id);
  }

  // Step 10: Update meeting row — use AI-extracted client info, NOT organizer_email
  const primaryClient = clients[0] || extracted.client_info || {};
  const updated = db.updateMeeting(meetingRow.id, {
    meeting_type: classification.type,
    summary: extracted.summary || null,
    sentiment: extracted.sentiment || null,
    classification,
    extracted_data: extracted,
    coaching_notes: coaching,
    client_name: primaryClient.name || meetingRow.client_name || null,
    client_email: primaryClient.email || null,  // Only use AI-extracted email, never organizer
    processed_at: new Date().toISOString()
  });

  // Step 11: Extract learned insights (objections, techniques, pricing reactions)
  if (['discovery', 'review', 'demo'].includes(classification.type)) {
    try {
      await extractInsights(extracted, meetingRow.id);
    } catch (err) {
      console.error(`[processor] Insight extraction failed:`, err.message);
    }
  }

  // Step 12: Auto-generate LinkedIn posts from meeting atoms (for Monty)
  if (atoms.length >= 2 && ['discovery', 'review', 'demo'].includes(classification.type)) {
    try {
      await generateLinkedInFromAtoms(atoms, extracted, meetingRow.id);
    } catch (err) {
      console.error(`[processor] LinkedIn post generation failed:`, err.message);
    }
  }

  console.log(`[processor] Meeting #${meetingRow.id} processed successfully`);
  return updated;
}

async function classifyMeeting(title, transcript) {
  const snippet = transcript.slice(0, 800);
  const prompt = `Classify this meeting based on its title and transcript snippet.

Title: ${title}
Transcript snippet: ${snippet}

Return JSON only (no markdown fences):
{
  "type": "discovery" | "onboarding" | "review" | "strategy" | "internal" | "demo" | "unknown",
  "confidence": 0-100,
  "signals": ["signal1", "signal2"]
}

Types:
- discovery: First call with a prospect, exploring their needs and qualifying them
- demo: Presenting/demonstrating a product or service to prospects (mostly one-way presentation)
- onboarding: Setting up a new client who has already committed
- review: Reviewing performance/results with existing client
- strategy: Planning session (internal or with client) about specific initiatives
- internal: Team-only meeting, no external participants
- unknown: Cannot determine, or it's a connection test / technical call with no real content

IMPORTANT: If the transcript is mostly technical troubleshooting (audio issues, connection problems) with no business substance, classify as "unknown" with low confidence.`;

  const text = await callClaude({ model: HAIKU, system: 'You classify business meetings. Return JSON only.', prompt, maxTokens: 300 });
  return parseJsonResponse(text) || { type: 'unknown', confidence: 0, signals: [] };
}

async function extractMeetingData(transcript, title) {
  const truncated = transcript.slice(0, 8000);
  const prompt = `Extract structured data from this meeting transcript. The meeting host is Yaseer Choudhury from Mortar Metrics (a marketing agency). Anyone else on the call who is NOT from Mortar Metrics is a client/prospect.

Title: ${title}

--- TRANSCRIPT ---
${truncated}
--- END ---

Return JSON only (no markdown fences):
{
  "summary": "2-3 sentence summary focusing on the business substance of the meeting",
  "pain_points": ["specific pain point mentioned by the client/prospect"],
  "goals": ["specific goal the client/prospect mentioned"],
  "budget": { "mentioned": true/false, "range": "$X-$Y/mo or null" },
  "timeline": "specific timeline mentioned or null",
  "services_discussed": ["SEO", "PPC", "Web Design", "Voice Agent", "CRM", "Lead Gen", etc.],
  "objections": ["specific objection raised by prospect"],
  "decisions": ["specific decision made during the call"],
  "action_items": [{ "description": "specific next step", "owner": "us" or "client", "due": "specific date/timeframe mentioned or null" }],
  "sentiment": "positive" | "neutral" | "negative" | "mixed",
  "client_info": {
    "name": "primary client/prospect name (NOT Yaseer, NOT the host)",
    "email": "client email if explicitly mentioned in conversation, otherwise null",
    "firm": "client's company/firm name or null",
    "practice_areas": ["their industry/specialty"]
  },
  "client_contacts": [
    { "name": "Person 1 name", "email": "email or null", "firm": "firm name or null", "role": "their role", "practice_areas": [] }
  ]
}

IMPORTANT RULES:
- client_info.email: ONLY include an email if you hear the client SAY their email address in the conversation. Do NOT use meeting organizer emails, calendar invite emails, or Fireflies metadata. If no email is explicitly spoken, use null.
- client_contacts: List EACH external person separately (not combined). Yaseer Choudhury and anyone from Mortar Metrics are NOT clients.
- action_items: Be specific about what needs to happen. Include due dates when discussed.
- pain_points: Only include genuine business pain points, not technical call issues.`;

  const kb = getKnowledgeBase();
  const extractSystem = `You extract structured data from sales meeting transcripts for Mortar Metrics, a legal marketing agency. Return JSON only.\n\nBUSINESS CONTEXT:\n${kb.slice(0, 3000)}`;
  const text = await callClaude({ model: SONNET, system: extractSystem, prompt, maxTokens: 2500 });
  return parseJsonResponse(text) || {
    summary: null, pain_points: [], goals: [], budget: { mentioned: false, range: null },
    timeline: null, services_discussed: [], objections: [], decisions: [],
    action_items: [], sentiment: 'neutral', client_info: {}, client_contacts: []
  };
}

async function extractContentAtoms(transcript, extracted) {
  const truncated = transcript.slice(0, 4000);
  const prompt = `Extract reusable content atoms from this client meeting that could be repurposed into marketing content for Mortar Metrics (a legal/professional services marketing agency).

--- TRANSCRIPT ---
${truncated}
--- END ---

Meeting summary: ${extracted.summary || 'N/A'}
Pain points: ${JSON.stringify(extracted.pain_points || [])}
Services discussed: ${JSON.stringify(extracted.services_discussed || [])}

Return a JSON array (no markdown fences):
[
  {
    "type": "pain_point" | "success_story" | "objection" | "insight" | "quote",
    "content": "The actual content atom, written as a standalone insight that could become a social post or blog paragraph. Anonymize client details.",
    "tags": ["tag1", "tag2"]
  }
]

RULES:
- Only include atoms with genuine marketing value — insights about client challenges, industry trends, sales lessons, or quotable moments
- Do NOT include atoms about technical call issues (audio, connection, muting)
- Do NOT include atoms about small talk (weather, location, personal stories) unless they reveal a business insight
- Anonymize: Replace specific names/firms with generic terms like "a law firm" or "one client"
- Write each atom so it could stand alone as a LinkedIn post hook or blog insight
- Return 2-5 high-quality atoms. Quality over quantity.`;

  const text = await callClaude({ model: HAIKU, system: 'You extract marketing content atoms from business meetings. Return JSON array only.', prompt, maxTokens: 1500 });
  return parseJsonResponse(text) || [];
}

async function analyzePatterns(extracted, existingPatterns) {
  const patternSummary = existingPatterns.slice(0, 20).map(p =>
    `${p.type}: ${p.description} (seen ${p.frequency}x)`
  ).join('\n');

  const prompt = `Identify recurring patterns from this meeting data. Compare against existing patterns we've seen across other meetings.

Meeting data:
- Pain points: ${JSON.stringify(extracted.pain_points || [])}
- Objections: ${JSON.stringify(extracted.objections || [])}
- Goals: ${JSON.stringify(extracted.goals || [])}
- Services discussed: ${JSON.stringify(extracted.services_discussed || [])}

Existing patterns from previous meetings:
${patternSummary || '(none yet)'}

Return a JSON array of patterns found (no markdown fences):
[
  {
    "type": "objection" | "pain_point" | "feature_request" | "pricing_concern",
    "description": "Brief, generalized pattern description (not specific to one client)",
    "is_new": true if this pattern hasn't been seen before, false if it matches an existing one
  }
]

Only include clear, distinct patterns that represent recurring themes. If a pattern matches an existing one, use the EXACT same description text. Return 0-5 items.`;

  const text = await callClaude({ model: HAIKU, system: 'You identify patterns across sales meetings. Return JSON array only.', prompt, maxTokens: 800 });
  return parseJsonResponse(text) || [];
}

async function generateCoaching(transcript, extracted, meetingType) {
  const truncated = transcript.slice(0, 6000);
  const prompt = `Evaluate this ${meetingType} call by Yaseer from Mortar Metrics (a marketing agency) and provide coaching feedback.

--- TRANSCRIPT ---
${truncated}
--- END ---

Meeting summary: ${extracted.summary || 'N/A'}
Services discussed: ${JSON.stringify(extracted.services_discussed || [])}
Objections raised: ${JSON.stringify(extracted.objections || [])}

Return JSON only (no markdown fences):
{
  "score": 0-100,
  "strengths": ["strength 1 — be specific with examples from the transcript"],
  "improvements": ["improvement 1 — be specific and actionable"],
  "missed_opportunities": ["missed opportunity 1 — what should have been said/asked"]
}

Scoring criteria for a ${meetingType} call:
- Did they set an agenda/expectations at the start?
- Did they ask discovery questions before presenting solutions?
- Did they uncover pain points, budget, timeline, decision process?
- Did they handle objections effectively?
- Was there a clear next step/CTA at the end?
- Was the talk ratio balanced (not a monologue)?
- Did they create urgency and quantify value?

Score guide:
- 80-100: Excellent — strong structure, good discovery, clear next steps
- 60-79: Good — covered most bases, some missed opportunities
- 40-59: Average — significant gaps in discovery or structure
- Below 40: Needs work — mostly presenting without engaging, no clear next steps

Keep strengths to 3-5 items, improvements to 3-5 items, missed opportunities to 2-4 items. Be direct and actionable.`;

  const kb = getKnowledgeBase();
  const coachSystem = `You are a sales coaching expert for Mortar Metrics. Evaluate Yaseer's calls and provide actionable feedback. Return JSON only.\n\nBUSINESS CONTEXT:\n${kb.slice(0, 2000)}`;
  const text = await callClaude({ model: SONNET, system: coachSystem, prompt, maxTokens: 1500 });
  return parseJsonResponse(text) || { score: 0, strengths: [], improvements: [], missed_opportunities: [] };
}

async function extractInsights(extracted, meetingId) {
  const existingInsights = db.getInsights({ limit: 30 });
  const existingSummary = existingInsights.map(i => `[${i.category}] ${i.insight}`).join('\n');

  const prompt = `Given this call data and existing learned insights, identify NEW insights to learn.

Call data:
- Pain points: ${JSON.stringify(extracted.pain_points || [])}
- Objections: ${JSON.stringify(extracted.objections || [])}
- Services discussed: ${JSON.stringify(extracted.services_discussed || [])}
- Budget: ${JSON.stringify(extracted.budget || {})}
- Sentiment: ${extracted.sentiment || 'unknown'}

Existing insights:
${existingSummary || '(none yet)'}

Return JSON array (no fences):
[{ "category": "objection"|"pricing"|"technique"|"pain_point"|"process_gap", "insight": "concise insight text", "is_new": true/false }]

Rules:
- If it matches an existing insight, set is_new=false and use the EXACT same text
- Focus on actionable learnings: what objections come up, what pricing works, what techniques close
- Max 5 insights per call`;

  const text = await callClaude({ model: HAIKU, system: 'You extract sales insights from meeting data. Return JSON array only.', prompt, maxTokens: 800 });
  const insights = parseJsonResponse(text) || [];

  for (const insight of insights) {
    if (insight.insight) {
      db.upsertInsight(insight.category || 'general', insight.insight, 'meeting', String(meetingId));
    }
  }

  console.log(`[processor] Extracted ${insights.length} insights from meeting #${meetingId}`);
  return insights;
}

async function generateLinkedInFromAtoms(atoms, extracted, meetingId) {
  const highValue = atoms.filter(a => ['pain_point', 'success_story', 'objection', 'insight'].includes(a.type));
  if (highValue.length < 2) return;

  const atomsText = highValue.map(a => `[${a.type}] ${a.content}`).join('\n');
  const kb = getKnowledgeBase();

  const prompt = `Generate 1-2 LinkedIn posts from these meeting insights. Each post should be a standalone thought leadership piece for a legal marketing agency.

MEETING INSIGHTS:
${atomsText}

Services discussed: ${JSON.stringify(extracted.services_discussed || [])}
Summary: ${extracted.summary || 'N/A'}

Rules:
- Under 200 words each
- Pull from REAL insights above — not generic marketing advice
- Anonymize client details ("A law firm we spoke with" not specific names)
- Hook in first line (pattern interrupt)
- End with a takeaway or question
- No hashtags, no AI-speak, no "In today's competitive landscape"
- Sound like a founder sharing real experiences, not a content marketer
- Write as "we" (Mortar Metrics team voice)

Return JSON array (no fences):
[{ "content": "The full LinkedIn post text", "hook": "The first line" }]`;

  const text = await callClaude({
    model: HAIKU,
    system: `${kb.slice(0, 2000)}\n\nYou write short LinkedIn posts from real meeting insights for a legal marketing agency. Return JSON array only.`,
    prompt,
    maxTokens: 1000
  });

  const posts = parseJsonResponse(text) || [];
  if (!Array.isArray(posts) || posts.length === 0) return;

  // Store as content pieces in content.json
  const content = readJSON('content.json');
  for (const post of posts.slice(0, 2)) {
    if (!post.content) continue;
    const piece = {
      id: generateId(),
      trigger_id: `meeting-${meetingId}`,
      trigger_title: `Call insight: ${(post.hook || extracted.summary || '').slice(0, 60)}`,
      trigger_source: 'meeting',
      trigger_category: 'CONTENT_PIECE',
      status: 'review',
      formats: {
        linkedin: { content: post.content, status: 'review' }
      },
      generated_at: new Date().toISOString(),
      auto_generated: true
    };
    content.push(piece);
  }
  writeJSON('content.json', content);
  console.log(`[processor] Generated ${posts.length} LinkedIn post(s) from meeting #${meetingId}`);
}

module.exports = { processMeeting };
