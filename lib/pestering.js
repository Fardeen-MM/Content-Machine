const db = require('./db');
const { callClaude, HAIKU } = require('./claude');
const { getKnowledgeBase } = require('./knowledge');

const STAGES = {
  interested: {
    next: 'report_sent',
    schedule: [
      { day: 0, channel: 'phone', type: 'speed_to_lead', target: 'yaseer' },
      { day: 0.5, channel: 'phone', type: 'retry', target: 'yaseer' },
      { day: 1, channel: 'email', type: 'check_in', target: 'yaseer' },
    ]
  },
  report_sent: {
    next: 'call_booked',
    schedule: [
      { day: 2, channel: 'phone', type: 'follow_up', target: 'yaseer' },
      { day: 4, channel: 'whatsapp', type: 'value_add', target: 'yaseer' },
      { day: 6, channel: 'linkedin', type: 'connect', target: 'monty' },
    ]
  },
  call_booked: {
    next: 'discovery_done',
    schedule: [
      { day: -1, channel: 'whatsapp', type: 'pre_call', target: 'yaseer' },
    ]
  },
  discovery_done: {
    next: 'proposal_sent',
    schedule: [
      { hours: 4, channel: 'telegram_alert', type: 'proposal_overdue', target: 'yaseer' },
      { hours: 24, channel: 'telegram_alert', type: 'proposal_urgent', target: 'fardeen' },
    ]
  },
  proposal_sent: {
    next: 'closed',
    schedule: [
      { day: 1, channel: 'whatsapp', type: 'value_add', target: 'yaseer' },
      { day: 2, channel: 'whatsapp', type: 'social_proof', target: 'yaseer' },
      { day: 3, channel: 'phone', type: 'check_in', target: 'yaseer' },
      { day: 5, channel: 'whatsapp', type: 'urgency', target: 'yaseer' },
      { day: 7, channel: 'phone', type: 'fardeen_personal', target: 'fardeen' },
      { day: 10, channel: 'email', type: 'final_attempt', target: 'yaseer' },
    ]
  }
};

function getStages() {
  return STAGES;
}

function createPesterSchedule(clientId, stage, startDate) {
  const stageConfig = STAGES[stage];
  if (!stageConfig) return [];

  const start = new Date(startDate || new Date());
  const entries = [];

  for (const item of stageConfig.schedule) {
    const scheduledFor = new Date(start);
    if (item.hours) {
      scheduledFor.setTime(scheduledFor.getTime() + item.hours * 60 * 60 * 1000);
    } else if (item.day !== undefined) {
      scheduledFor.setTime(scheduledFor.getTime() + item.day * 24 * 60 * 60 * 1000);
    }

    const entry = db.insertPesterEntry({
      client_id: clientId,
      stage,
      channel: item.channel,
      message_type: item.type,
      status: 'pending',
      scheduled_for: scheduledFor.toISOString()
    });
    entries.push(entry);
  }

  return entries;
}

async function generatePesterMessage(entryId) {
  const d = db.getDb();
  const entry = d.prepare(`
    SELECT p.*, c.name as client_name, c.firm_name, c.practice_areas
    FROM pestering_log p LEFT JOIN clients c ON p.client_id = c.id
    WHERE p.id = ?
  `).get(entryId);
  if (!entry) return null;

  // Get recent meeting context for this client
  const meetings = db.getMeetings({ client: entry.client_name, limit: 3 });
  const meetingContext = meetings.map(m => {
    const ed = m.extracted_data || {};
    return `${m.date?.slice(0, 10)}: ${m.summary || m.title}${ed.pain_points?.length ? ' | Pain: ' + ed.pain_points.join(', ') : ''}`;
  }).join('\n');

  const kb = getKnowledgeBase();

  const prompt = `Generate a ${entry.channel} message for ${entry.message_type} follow-up.

Client: ${entry.client_name || 'Unknown'}${entry.firm_name ? ' at ' + entry.firm_name : ''}
Practice areas: ${entry.practice_areas || 'Unknown'}
Stage: ${entry.stage}
Channel: ${entry.channel}

Recent call notes:
${meetingContext || '(no calls yet)'}

Write a short, natural ${entry.channel} message from Yaseer at Mortar Metrics. 1-3 sentences max. Reference something specific from the call if available. Don't be generic.`;

  try {
    const text = await callClaude({
      model: HAIKU,
      system: `${kb.slice(0, 1500)}\n\nYou write short follow-up messages for a legal marketing agency. Natural, direct, not salesy. Return the message text only, no quotes or labels.`,
      prompt,
      maxTokens: 300
    });

    db.updatePesterEntry(entryId, { content: text });
    return text;
  } catch (err) {
    console.error('[pester] Message generation failed:', err.message);
    return null;
  }
}

function getDueEntries() {
  return db.getPesterEntries({ status: 'pending', due_before: new Date().toISOString() });
}

function markSent(entryId) {
  db.updatePesterEntry(entryId, { status: 'sent', sent_at: new Date().toISOString() });
}

function markSkipped(entryId) {
  db.updatePesterEntry(entryId, { status: 'skipped', sent_at: new Date().toISOString() });
}

module.exports = { STAGES, getStages, createPesterSchedule, generatePesterMessage, getDueEntries, markSent, markSkipped };
