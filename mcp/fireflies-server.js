#!/usr/bin/env node
/**
 * MCP Server: Fireflies Meetings
 *
 * Exposes 5 tools for Claude Desktop to query meeting transcripts
 * and call data from Fireflies + the local SQLite database.
 *
 * Run: node mcp/fireflies-server.js
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema
} = require('@modelcontextprotocol/sdk/types.js');

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));
require('../lib/utils').loadEnv();
const db = require('../lib/db');
db.initDb();

const fireflies = require('../lib/fireflies');
const { processMeeting } = require('../lib/meeting-processor');

const server = new Server(
  { name: 'mortar-fireflies', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: 'get_recent_calls',
    description: 'Get recent meeting transcripts from the local database. Returns summaries, classification, sentiment, and extracted data.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max meetings (default 10)' },
        type: { type: 'string', description: 'Filter by meeting type (discovery, review, strategy, onboarding, internal)' }
      }
    }
  },
  {
    name: 'get_call',
    description: 'Get full details for a single meeting including transcript, extracted data, coaching notes, and action items.',
    inputSchema: {
      type: 'object',
      properties: { meeting_id: { type: 'number' } },
      required: ['meeting_id']
    }
  },
  {
    name: 'search_calls',
    description: 'Full-text search across meeting titles, transcripts, and summaries.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search text' } },
      required: ['query']
    }
  },
  {
    name: 'get_calls_by_prospect',
    description: 'Get all meetings associated with a specific client/prospect name.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Client or prospect name' } },
      required: ['name']
    }
  },
  {
    name: 'sync_fireflies',
    description: 'Fetch latest transcripts from Fireflies API, process new ones with AI pipeline. Requires FIREFLIES_API_KEY.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max transcripts to fetch (default 20)' }
      }
    }
  }
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'get_recent_calls': {
        const meetings = db.getMeetings({ limit: args.limit || 10, type: args.type || undefined });
        return ok({
          count: meetings.length,
          meetings: meetings.map(m => ({
            id: m.id,
            title: m.title,
            date: m.date,
            duration: m.duration_minutes,
            type: m.meeting_type,
            client: m.client_name,
            sentiment: m.sentiment,
            summary: m.summary,
            extracted: m.extracted_data ? {
              pain_points: m.extracted_data.pain_points,
              goals: m.extracted_data.goals,
              services: m.extracted_data.services_discussed,
              objections: m.extracted_data.objections,
              budget: m.extracted_data.budget
            } : null,
            coaching_score: m.coaching_notes?.score
          }))
        });
      }

      case 'get_call': {
        const meeting = db.getMeeting(args.meeting_id);
        if (!meeting) return err('Meeting not found');
        const actions = db.getActions({ meeting_id: meeting.id });
        const atoms = db.getAtoms({ meeting_id: meeting.id });
        return ok({
          ...meeting,
          transcript: meeting.transcript ? meeting.transcript.slice(0, 15000) : null,
          actions,
          atoms
        });
      }

      case 'search_calls': {
        const results = db.searchMeetings(args.query);
        return ok({
          count: results.length,
          meetings: results.map(m => ({
            id: m.id, title: m.title, date: m.date,
            type: m.meeting_type, client: m.client_name,
            summary: m.summary
          }))
        });
      }

      case 'get_calls_by_prospect': {
        const meetings = db.getMeetings({ client: args.name, limit: 50 });
        return ok({
          prospect: args.name,
          count: meetings.length,
          meetings: meetings.map(m => ({
            id: m.id, title: m.title, date: m.date,
            type: m.meeting_type, sentiment: m.sentiment,
            summary: m.summary,
            coaching_score: m.coaching_notes?.score
          }))
        });
      }

      case 'sync_fireflies': {
        if (!process.env.FIREFLIES_API_KEY) return err('FIREFLIES_API_KEY not set');
        const limit = args.limit || 20;
        const transcripts = await fireflies.listTranscripts({ limit });
        let synced = 0;
        let processed = 0;

        for (const t of transcripts) {
          const existing = db.getDb().prepare('SELECT id FROM meetings WHERE fireflies_id = ?').get(t.id);
          if (existing) continue;

          const full = await fireflies.fetchTranscript(t.id);
          if (!full) continue;

          const transcript = full.sentences ? fireflies.sentencesToTranscript(full.sentences) : '';
          const meeting = db.insertMeeting({
            fireflies_id: t.id,
            title: full.title || t.title,
            date: full.dateString || t.dateString || new Date().toISOString(),
            duration_minutes: full.duration || null,
            client_name: null,
            client_email: (full.organizer_email || '').includes('mortar') ? null : full.organizer_email,
            transcript,
            raw_response: JSON.stringify(full)
          });
          synced++;

          try {
            await processMeeting(meeting);
            processed++;
          } catch (err) {
            console.error(`[mcp] Failed to process meeting #${meeting.id}:`, err.message);
          }
        }

        return ok({ synced, processed, total_checked: transcripts.length });
      }

      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return err(error.message);
  }
});

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function err(message) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[mcp] Fireflies server running');
}

main().catch(err => { console.error(err); process.exit(1); });
