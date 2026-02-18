#!/usr/bin/env node
/**
 * MCP Server: Command Centre Pipeline
 *
 * Exposes 20 tools for Claude Desktop to interact with the
 * Mortar Metrics Command Centre — pipeline, prospects, deals,
 * actions, pestering, intelligence, advisory, content, meetings.
 *
 * Run: node mcp/pipeline-server.js
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema
} = require('@modelcontextprotocol/sdk/types.js');

// Load env + init DB
const path = require('path');
process.chdir(path.resolve(__dirname, '..'));
require('../lib/utils').loadEnv();
const db = require('../lib/db');
db.initDb();

const { calculateROI, detectGaps, extractDiscoveryFramework } = require('../lib/advisory');
const { generatePesterMessage, getDueEntries, createPesterSchedule, markSent, markSkipped, getStages } = require('../lib/pestering');
const { getTopInsights, getDealPatterns, buildIntelligenceContext } = require('../lib/intelligence');
const { generateProposal } = require('../lib/proposal-generator');
const { readJSON } = require('../lib/utils');
const { generateBrief } = require('../generator/daily-brief');

const server = new Server(
  { name: 'mortar-pipeline', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// ── Tool definitions ──

const TOOLS = [
  {
    name: 'get_pipeline',
    description: 'Get full pipeline overview: clients by status, health scores, stale deals, open actions count.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_prospect',
    description: 'Get detailed info about a specific client/prospect including meetings, proposals, actions, health.',
    inputSchema: {
      type: 'object',
      properties: {
        client_id: { type: 'number', description: 'Client ID' },
        name: { type: 'string', description: 'Client name to search (if no ID)' }
      }
    }
  },
  {
    name: 'update_stage',
    description: 'Update a client status (prospect, active, churned, lost) and optionally add notes.',
    inputSchema: {
      type: 'object',
      properties: {
        client_id: { type: 'number', description: 'Client ID' },
        status: { type: 'string', enum: ['prospect', 'active', 'churned', 'lost'] },
        notes: { type: 'string', description: 'Optional notes about the change' }
      },
      required: ['client_id', 'status']
    }
  },
  {
    name: 'get_stale_deals',
    description: 'Get deals with no contact for N+ days. Default 5 days.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Minimum days of silence (default 5)' }
      }
    }
  },
  {
    name: 'get_actions',
    description: 'Get open action items, optionally filtered by client or owner.',
    inputSchema: {
      type: 'object',
      properties: {
        client_id: { type: 'number' },
        owner: { type: 'string', description: 'Filter by owner (us/client)' },
        status: { type: 'string', enum: ['open', 'done', 'cancelled'], description: 'Default: open' }
      }
    }
  },
  {
    name: 'create_action',
    description: 'Create a new action item for a client.',
    inputSchema: {
      type: 'object',
      properties: {
        client_id: { type: 'number' },
        description: { type: 'string' },
        owner: { type: 'string', enum: ['us', 'client'] },
        due_date: { type: 'string', description: 'ISO date string' }
      },
      required: ['description', 'owner']
    }
  },
  {
    name: 'complete_action',
    description: 'Mark an action item as done.',
    inputSchema: {
      type: 'object',
      properties: { action_id: { type: 'number' } },
      required: ['action_id']
    }
  },
  {
    name: 'get_due_pestering',
    description: 'Get pestering entries that are due now (pending + past scheduled_for).',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'create_pester_schedule',
    description: 'Create a pestering schedule for a client at a given stage.',
    inputSchema: {
      type: 'object',
      properties: {
        client_id: { type: 'number' },
        stage: { type: 'string', description: 'Stage: interested, report_sent, call_booked, discovery_done, proposal_sent' }
      },
      required: ['client_id', 'stage']
    }
  },
  {
    name: 'generate_pester_message',
    description: 'AI-generate a follow-up message for a pestering entry.',
    inputSchema: {
      type: 'object',
      properties: { entry_id: { type: 'number' } },
      required: ['entry_id']
    }
  },
  {
    name: 'log_pestering',
    description: 'Mark a pestering entry as sent or skipped.',
    inputSchema: {
      type: 'object',
      properties: {
        entry_id: { type: 'number' },
        action: { type: 'string', enum: ['sent', 'skipped'] }
      },
      required: ['entry_id', 'action']
    }
  },
  {
    name: 'add_deal_outcome',
    description: 'Record a deal outcome (won or lost) with details.',
    inputSchema: {
      type: 'object',
      properties: {
        client_id: { type: 'number' },
        outcome: { type: 'string', enum: ['won', 'lost'] },
        monthly_value: { type: 'number' },
        close_time_days: { type: 'number' },
        loss_reason: { type: 'string' },
        what_worked: { type: 'string' },
        what_failed: { type: 'string' },
        notes: { type: 'string' }
      },
      required: ['client_id', 'outcome']
    }
  },
  {
    name: 'get_deal_patterns',
    description: 'Get deal outcome analytics: close rate, avg deal size, loss reasons, avg close time.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_insights',
    description: 'Get learned insights from meetings and deals, optionally by category.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Filter: objection, pricing, technique, pain_point, process_gap' },
        limit: { type: 'number' }
      }
    }
  },
  {
    name: 'calculate_roi',
    description: 'Calculate ROI projections for a prospect given their practice area and numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        practice_area: { type: 'string' },
        avg_case_value: { type: 'number' },
        current_cases: { type: 'number' },
        desired_cases: { type: 'number' },
        current_spend: { type: 'number' }
      }
    }
  },
  {
    name: 'detect_gaps',
    description: 'AI-detect gaps and bottlenecks in current pipeline/operations.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'generate_brief',
    description: 'Generate the daily morning brief (same as 8AM Telegram brief).',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_content_queue',
    description: 'Get content pieces pending review (for Monty to approve).',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max items (default 20)' } }
    }
  },
  {
    name: 'get_recent_meetings',
    description: 'Get recent meetings with summaries and classification.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max meetings (default 10)' },
        type: { type: 'string', description: 'Filter by meeting type' }
      }
    }
  },
  {
    name: 'generate_proposal',
    description: 'Generate a Grand Slam Offer proposal from a discovery call meeting.',
    inputSchema: {
      type: 'object',
      properties: { meeting_id: { type: 'number' } },
      required: ['meeting_id']
    }
  }
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// ── Tool handlers ──

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'get_pipeline': {
        const health = db.getHealthOverview();
        const stats = db.getStats();
        const openActions = db.getActions({ status: 'open', limit: 100 });
        const stale = (health.clients || []).filter(c => c.days_since_contact >= 5);
        return ok({
          summary: health.summary,
          stale_deals: stale.map(c => ({ name: c.client_name, firm: c.firm_name, days_silent: c.days_since_contact, score: c.score })),
          stats: { meetings: stats.meetings, clients: stats.clients, open_actions: openActions.length },
          clients: (health.clients || []).map(c => ({
            id: c.client_id, name: c.client_name, firm: c.firm_name,
            status: c.health_status, score: c.score, days_silent: c.days_since_contact
          }))
        });
      }

      case 'get_prospect': {
        let client;
        if (args.client_id) {
          client = db.getClient(args.client_id);
        } else if (args.name) {
          const clients = db.getClients({ search: args.name, limit: 1 });
          client = clients[0];
        }
        if (!client) return err('Client not found');
        const meetings = db.getMeetings({ client: client.name, limit: 10 });
        const proposals = db.getProposals({ client_id: client.id });
        const actions = db.getActions({ client_id: client.id });
        const health = db.computeClientHealth(client.id);
        return ok({ client, meetings, proposals, actions, health });
      }

      case 'update_stage': {
        const client = db.getClient(args.client_id);
        if (!client) return err('Client not found');
        const d = db.getDb();
        d.prepare('UPDATE clients SET status = ?, notes = COALESCE(?, notes), last_seen = datetime(\'now\') WHERE id = ?')
          .run(args.status, args.notes || null, args.client_id);
        return ok({ updated: true, client_id: args.client_id, new_status: args.status });
      }

      case 'get_stale_deals': {
        const minDays = args.days || 5;
        const health = db.getHealthOverview();
        const stale = (health.clients || [])
          .filter(c => c.days_since_contact >= minDays)
          .sort((a, b) => b.days_since_contact - a.days_since_contact);
        return ok({ count: stale.length, deals: stale.map(c => ({
          id: c.client_id, name: c.client_name, firm: c.firm_name,
          days_silent: c.days_since_contact, score: c.score
        }))});
      }

      case 'get_actions': {
        const actions = db.getActions({
          client_id: args.client_id,
          status: args.status || 'open',
          limit: 50
        });
        const filtered = args.owner ? actions.filter(a => a.owner === args.owner) : actions;
        return ok({ count: filtered.length, actions: filtered });
      }

      case 'create_action': {
        const action = db.insertAction({
          client_id: args.client_id || null,
          description: args.description,
          owner: args.owner,
          due_date: args.due_date || null
        });
        return ok({ created: true, action });
      }

      case 'complete_action': {
        const action = db.updateAction(args.action_id, { status: 'done' });
        if (!action) return err('Action not found');
        return ok({ completed: true, action });
      }

      case 'get_due_pestering': {
        const due = getDueEntries();
        return ok({ count: due.length, entries: due });
      }

      case 'create_pester_schedule': {
        const entries = createPesterSchedule(args.client_id, args.stage);
        return ok({ created: entries.length, entries });
      }

      case 'generate_pester_message': {
        const message = await generatePesterMessage(args.entry_id);
        return ok({ message });
      }

      case 'log_pestering': {
        if (args.action === 'sent') markSent(args.entry_id);
        else markSkipped(args.entry_id);
        return ok({ logged: true, entry_id: args.entry_id, action: args.action });
      }

      case 'add_deal_outcome': {
        const outcome = db.insertDealOutcome({
          client_id: args.client_id,
          outcome: args.outcome,
          monthly_value: args.monthly_value || null,
          close_time_days: args.close_time_days || null,
          loss_reason: args.loss_reason || null,
          what_worked: args.what_worked || null,
          what_failed: args.what_failed || null,
          notes: args.notes || null
        });
        return ok({ recorded: true, outcome });
      }

      case 'get_deal_patterns': {
        const patterns = getDealPatterns();
        return ok(patterns);
      }

      case 'get_insights': {
        const insights = getTopInsights(args.limit || 20);
        const filtered = args.category ? insights.filter(i => i.category === args.category) : insights;
        return ok({ count: filtered.length, insights: filtered });
      }

      case 'calculate_roi': {
        const roi = calculateROI({
          practice_area: args.practice_area || null,
          avg_case_value: args.avg_case_value || null,
          current_cases: args.current_cases || null,
          desired_cases: args.desired_cases || null,
          current_spend: args.current_spend || null
        });
        return ok(roi);
      }

      case 'detect_gaps': {
        const gaps = await detectGaps();
        return ok(gaps);
      }

      case 'generate_brief': {
        const brief = await generateBrief();
        return ok({ brief });
      }

      case 'get_content_queue': {
        const allContent = readJSON('content.json');
        const pending = allContent.filter(c => c.status === 'review').slice(0, args.limit || 20);
        return ok({ count: pending.length, posts: pending.map(c => ({
          id: c.id,
          title: c.trigger_title,
          source: c.trigger_source,
          linkedin_preview: (c.formats?.linkedin?.content || '').slice(0, 200),
          generated_at: c.generated_at
        }))});
      }

      case 'get_recent_meetings': {
        const meetings = db.getMeetings({ limit: args.limit || 10, type: args.type || undefined });
        return ok({ count: meetings.length, meetings: meetings.map(m => ({
          id: m.id, title: m.title, date: m.date, type: m.meeting_type,
          client: m.client_name, sentiment: m.sentiment,
          summary: m.summary
        }))});
      }

      case 'generate_proposal': {
        const result = await generateProposal(args.meeting_id);
        return ok({ proposal_id: result.id, title: result.title, monthly_value: result.monthly_value, status: result.status });
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

// ── Start ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[mcp] Pipeline server running');
}

main().catch(err => { console.error(err); process.exit(1); });
