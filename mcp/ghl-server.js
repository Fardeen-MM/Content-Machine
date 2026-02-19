#!/usr/bin/env node
/**
 * MCP Server: GoHighLevel CRM
 *
 * Gives Claude LIVE access to the entire GHL CRM — pipelines, opportunities,
 * contacts, conversations, calendars, tags, custom fields, users.
 *
 * 22 tools covering the full CRM surface area.
 *
 * Run: node mcp/ghl-server.js
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema
} = require('@modelcontextprotocol/sdk/types.js');

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const BASE_URL = 'https://services.leadconnectorhq.com';

async function ghl(path, opts = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: {
      'Authorization': `Bearer ${GHL_API_KEY}`,
      'Version': '2021-07-28',
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GHL ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.json();
}

// ── Tool definitions ──

const TOOLS = [
  // Pipelines & Opportunities
  {
    name: 'get_pipelines',
    description: 'Get all sales pipelines with their stages (names, IDs, positions). Use this first to understand the deal flow and get stage IDs for filtering opportunities.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_opportunities',
    description: 'Get opportunities (deals) from a pipeline. Returns contact name, email, phone, stage, status, monetary value, dates, assigned_to, tags. Use to see all deals in a pipeline or filter by stage/status.',
    inputSchema: {
      type: 'object',
      properties: {
        pipeline_id: { type: 'string', description: 'Pipeline ID (required — get from get_pipelines)' },
        stage_id: { type: 'string', description: 'Filter by stage ID' },
        status: { type: 'string', enum: ['open', 'won', 'lost', 'abandoned'], description: 'Filter by deal status' },
        query: { type: 'string', description: 'Search by contact name/email' },
        limit: { type: 'number', description: 'Max results (default 50)' }
      },
      required: ['pipeline_id']
    }
  },
  {
    name: 'get_opportunity',
    description: 'Get full details for a single opportunity/deal including custom fields, contact info, notes, and history. Use when you need the complete picture on a specific deal.',
    inputSchema: {
      type: 'object',
      properties: { opportunity_id: { type: 'string' } },
      required: ['opportunity_id']
    }
  },
  {
    name: 'update_opportunity_stage',
    description: 'Move an opportunity to a different pipeline stage and/or update its status (open/won/lost/abandoned). Use to advance deals through the pipeline.',
    inputSchema: {
      type: 'object',
      properties: {
        opportunity_id: { type: 'string' },
        stage_id: { type: 'string', description: 'New stage ID' },
        status: { type: 'string', enum: ['open', 'won', 'lost', 'abandoned'] }
      },
      required: ['opportunity_id', 'stage_id']
    }
  },
  {
    name: 'search_opportunities',
    description: 'Search for opportunities by contact name or email across pipelines. Use when looking for a specific deal or prospect.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text (name, email, phone)' },
        pipeline_id: { type: 'string', description: 'Limit to specific pipeline' }
      },
      required: ['query']
    }
  },

  // Contacts
  {
    name: 'get_contacts',
    description: 'Get contacts from GHL. Returns name, email, phone, company, tags, source, last activity. Paginated with startAfter cursor.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search contacts' },
        limit: { type: 'number', description: 'Max results (default 20)' },
        startAfter: { type: 'string', description: 'Pagination cursor (startAfterId from previous response)' }
      }
    }
  },
  {
    name: 'get_contact',
    description: 'Get full contact details including custom fields, DND settings, address, website, all tags, and source info. Use for deep-dive on a specific person.',
    inputSchema: {
      type: 'object',
      properties: { contact_id: { type: 'string' } },
      required: ['contact_id']
    }
  },
  {
    name: 'search_contacts',
    description: 'Search contacts by name, email, or phone number. Returns matching contacts with key details.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', description: 'Max results (default 20)' }
      },
      required: ['query']
    }
  },
  {
    name: 'get_contact_notes',
    description: 'Get all notes on a contact. Returns note body, date created, and user who added it. Use to see communication history and context.',
    inputSchema: {
      type: 'object',
      properties: { contact_id: { type: 'string' } },
      required: ['contact_id']
    }
  },
  {
    name: 'add_contact_note',
    description: 'Add a note to a contact in GHL. Use to log call outcomes, meeting notes, or follow-up reminders.',
    inputSchema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string' },
        body: { type: 'string', description: 'Note text' }
      },
      required: ['contact_id', 'body']
    }
  },
  {
    name: 'get_contact_tasks',
    description: 'Get all tasks assigned to a contact. Returns title, description, due date, status, and assigned user.',
    inputSchema: {
      type: 'object',
      properties: { contact_id: { type: 'string' } },
      required: ['contact_id']
    }
  },
  {
    name: 'create_task',
    description: 'Create a task on a contact in GHL. Use to assign follow-ups, call reminders, or action items to team members.',
    inputSchema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        dueDate: { type: 'string', description: 'ISO date (e.g. 2026-02-20)' },
        assignedTo: { type: 'string', description: 'User ID to assign to' }
      },
      required: ['contact_id', 'title']
    }
  },

  // Conversations
  {
    name: 'get_conversations',
    description: 'Get conversations for a contact — shows last message, date, type (SMS/Email/WhatsApp), and unread count. Use to see recent communication activity.',
    inputSchema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string' },
        limit: { type: 'number', description: 'Max results (default 20)' }
      },
      required: ['contact_id']
    }
  },
  {
    name: 'get_conversation_messages',
    description: 'Get messages in a conversation thread. Shows direction (inbound/outbound), type (SMS/Email/WhatsApp), message body, date, delivery status. Use to read actual message content.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string' },
        limit: { type: 'number', description: 'Max messages (default 20)' }
      },
      required: ['conversation_id']
    }
  },

  // Calendars
  {
    name: 'get_calendars',
    description: 'Get all calendars in the GHL location. Returns calendar names, IDs, and types.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_appointments',
    description: 'Get calendar appointments/events. Returns title, contact, start/end times, status (confirmed/showed/noshow/cancelled), notes. Defaults to last 30 + next 30 days.',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id: { type: 'string', description: 'Filter by calendar ID' },
        start_date: { type: 'string', description: 'Start date ISO (default: 30 days ago)' },
        end_date: { type: 'string', description: 'End date ISO (default: 30 days from now)' }
      }
    }
  },

  // Tags & Fields
  {
    name: 'get_tags',
    description: 'Get all tags in the GHL location. Tags are used to categorize contacts and trigger automations.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'add_contact_tag',
    description: 'Add tags to a contact. Tags trigger GHL automations and help segment the pipeline.',
    inputSchema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags to add' }
      },
      required: ['contact_id', 'tags']
    }
  },
  {
    name: 'get_custom_fields',
    description: 'Get all custom fields defined in the GHL location. Shows field names, types, and IDs — needed to interpret custom field values on contacts/opportunities.',
    inputSchema: { type: 'object', properties: {} }
  },

  // Users
  {
    name: 'get_users',
    description: 'Get all users/team members in the GHL location. Returns name, email, role. Use to find user IDs for task assignment.',
    inputSchema: { type: 'object', properties: {} }
  },

  // Aggregate
  {
    name: 'get_pipeline_summary',
    description: 'THE KEY TOOL: Get complete pipeline overview across ALL pipelines. For each pipeline, shows deals grouped by stage with counts and total value per stage, stale deals (days since updated), plus won/lost totals. This is the "daily whiteboard view" — gives Claude the full picture in one call. Use this first when asked about pipeline, deals, or business status.',
    inputSchema: { type: 'object', properties: {} }
  }
];

function createServer() {
  const server = new Server(
    { name: 'mortar-ghl', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'get_pipelines': {
        const data = await ghl(`/opportunities/pipelines?locationId=${GHL_LOCATION_ID}`);
        const pipelines = (data.pipelines || []).map(p => ({
          id: p.id, name: p.name,
          stages: (p.stages || []).map(s => ({ id: s.id, name: s.name, position: s.position }))
        }));
        return ok({ pipelines });
      }

      case 'get_opportunities': {
        const params = new URLSearchParams({
          location_id: GHL_LOCATION_ID,
          pipeline_id: args.pipeline_id,
          limit: String(args.limit || 50)
        });
        if (args.stage_id) params.set('pipeline_stage_id', args.stage_id);
        if (args.status) params.set('status', args.status);
        if (args.query) params.set('q', args.query);
        const data = await ghl(`/opportunities/search?${params}`);
        const opps = (data.opportunities || []).map(o => ({
          id: o.id, name: o.contact?.name || o.name,
          email: o.contact?.email, phone: o.contact?.phone,
          stage: o.pipelineStageId, stage_name: o.pipelineStageName || o.stageName,
          status: o.status, value: o.monetaryValue,
          created: o.createdAt, updated: o.updatedAt,
          assigned_to: o.assignedTo, tags: o.contact?.tags,
          source: o.source
        }));
        return ok({ count: opps.length, total: data.meta?.total, opportunities: opps });
      }

      case 'get_opportunity': {
        const data = await ghl(`/opportunities/${args.opportunity_id}`);
        const o = data.opportunity || data;
        return ok({
          id: o.id, name: o.contact?.name || o.name,
          email: o.contact?.email, phone: o.contact?.phone,
          pipeline_id: o.pipelineId, stage_id: o.pipelineStageId,
          status: o.status, value: o.monetaryValue,
          created: o.createdAt, updated: o.updatedAt,
          assigned_to: o.assignedTo, source: o.source,
          custom_fields: o.customFields,
          contact: o.contact
        });
      }

      case 'update_opportunity_stage': {
        const body = { stageId: args.stage_id };
        if (args.status) body.status = args.status;
        const data = await ghl(`/opportunities/${args.opportunity_id}`, {
          method: 'PUT', body
        });
        return ok({ updated: true, opportunity: data.opportunity || data });
      }

      case 'search_opportunities': {
        const params = new URLSearchParams({
          location_id: GHL_LOCATION_ID,
          q: args.query,
          limit: '50'
        });
        if (args.pipeline_id) params.set('pipeline_id', args.pipeline_id);
        const data = await ghl(`/opportunities/search?${params}`);
        const opps = (data.opportunities || []).map(o => ({
          id: o.id, name: o.contact?.name || o.name,
          email: o.contact?.email, stage_name: o.pipelineStageName || o.stageName,
          status: o.status, value: o.monetaryValue, updated: o.updatedAt
        }));
        return ok({ count: opps.length, opportunities: opps });
      }

      case 'get_contacts': {
        const params = new URLSearchParams({ locationId: GHL_LOCATION_ID, limit: String(args.limit || 20) });
        if (args.query) params.set('query', args.query);
        if (args.startAfter) params.set('startAfterId', args.startAfter);
        const data = await ghl(`/contacts/?${params}`);
        const contacts = (data.contacts || []).map(c => ({
          id: c.id, name: `${c.firstName || ''} ${c.lastName || ''}`.trim(),
          email: c.email, phone: c.phone, company: c.companyName,
          tags: c.tags, source: c.source, last_activity: c.lastActivity
        }));
        return ok({ count: contacts.length, startAfter: data.meta?.startAfterId, contacts });
      }

      case 'get_contact': {
        const data = await ghl(`/contacts/${args.contact_id}`);
        const c = data.contact || data;
        return ok({
          id: c.id, name: `${c.firstName || ''} ${c.lastName || ''}`.trim(),
          email: c.email, phone: c.phone, company: c.companyName,
          website: c.website, address: c.address1,
          city: c.city, state: c.state, postal: c.postalCode, country: c.country,
          tags: c.tags, source: c.source, dnd: c.dnd,
          custom_fields: c.customFields,
          created: c.dateAdded, last_activity: c.lastActivity
        });
      }

      case 'search_contacts': {
        const params = new URLSearchParams({
          locationId: GHL_LOCATION_ID,
          query: args.query,
          limit: String(args.limit || 20)
        });
        const data = await ghl(`/contacts/?${params}`);
        const contacts = (data.contacts || []).map(c => ({
          id: c.id, name: `${c.firstName || ''} ${c.lastName || ''}`.trim(),
          email: c.email, phone: c.phone, company: c.companyName, tags: c.tags
        }));
        return ok({ count: contacts.length, contacts });
      }

      case 'get_contact_notes': {
        const data = await ghl(`/contacts/${args.contact_id}/notes`);
        return ok({ notes: data.notes || [] });
      }

      case 'add_contact_note': {
        const data = await ghl(`/contacts/${args.contact_id}/notes`, {
          method: 'POST', body: { body: args.body }
        });
        return ok({ created: true, note: data.note || data });
      }

      case 'get_contact_tasks': {
        const data = await ghl(`/contacts/${args.contact_id}/tasks`);
        return ok({ tasks: data.tasks || [] });
      }

      case 'create_task': {
        const body = { title: args.title };
        if (args.description) body.description = args.description;
        if (args.dueDate) body.dueDate = args.dueDate;
        if (args.assignedTo) body.assignedTo = args.assignedTo;
        const data = await ghl(`/contacts/${args.contact_id}/tasks`, {
          method: 'POST', body
        });
        return ok({ created: true, task: data.task || data });
      }

      case 'get_conversations': {
        const params = new URLSearchParams({
          locationId: GHL_LOCATION_ID,
          contactId: args.contact_id,
          limit: String(args.limit || 20)
        });
        const data = await ghl(`/conversations/search?${params}`);
        const convos = (data.conversations || []).map(c => ({
          id: c.id, type: c.type, last_message: c.lastMessageBody,
          last_date: c.lastMessageDate, unread: c.unreadCount,
          contact_name: c.contactName
        }));
        return ok({ count: convos.length, conversations: convos });
      }

      case 'get_conversation_messages': {
        const params = new URLSearchParams({ limit: String(args.limit || 20) });
        const data = await ghl(`/conversations/${args.conversation_id}/messages?${params}`);
        const msgs = (data.messages || []).map(m => ({
          id: m.id, direction: m.direction, type: m.messageType || m.type,
          body: m.body, date: m.dateAdded, status: m.status
        }));
        return ok({ count: msgs.length, messages: msgs });
      }

      case 'get_calendars': {
        const data = await ghl(`/calendars/?locationId=${GHL_LOCATION_ID}`);
        const cals = (data.calendars || []).map(c => ({ id: c.id, name: c.name, type: c.calendarType }));
        return ok({ calendars: cals });
      }

      case 'get_appointments': {
        const now = new Date();
        const start = args.start_date || new Date(now - 30 * 86400000).toISOString();
        const end = args.end_date || new Date(now.getTime() + 30 * 86400000).toISOString();
        const params = new URLSearchParams({
          locationId: GHL_LOCATION_ID,
          startTime: start,
          endTime: end
        });
        if (args.calendar_id) params.set('calendarId', args.calendar_id);
        const data = await ghl(`/calendars/events?${params}`);
        const events = (data.events || []).map(e => ({
          id: e.id, title: e.title, contact_id: e.contactId,
          calendar_id: e.calendarId, start: e.startTime, end: e.endTime,
          status: e.appointmentStatus, notes: e.notes
        }));
        return ok({ count: events.length, appointments: events });
      }

      case 'get_tags': {
        const data = await ghl(`/locations/${GHL_LOCATION_ID}/tags`);
        return ok({ tags: data.tags || [] });
      }

      case 'add_contact_tag': {
        // Get existing tags first, then merge
        const existing = await ghl(`/contacts/${args.contact_id}`);
        const currentTags = (existing.contact || existing).tags || [];
        const merged = [...new Set([...currentTags, ...args.tags])];
        const data = await ghl(`/contacts/${args.contact_id}`, {
          method: 'PUT', body: { tags: merged }
        });
        return ok({ updated: true, tags: merged });
      }

      case 'get_custom_fields': {
        const data = await ghl(`/locations/${GHL_LOCATION_ID}/customFields`);
        const fields = (data.customFields || []).map(f => ({
          id: f.id, name: f.name, fieldKey: f.fieldKey, dataType: f.dataType
        }));
        return ok({ fields });
      }

      case 'get_users': {
        const data = await ghl(`/users/?locationId=${GHL_LOCATION_ID}`);
        const users = (data.users || []).map(u => ({
          id: u.id, name: u.name, email: u.email, role: u.role
        }));
        return ok({ users });
      }

      case 'get_pipeline_summary': {
        // Fetch all pipelines
        const pData = await ghl(`/opportunities/pipelines?locationId=${GHL_LOCATION_ID}`);
        const pipelines = pData.pipelines || [];
        const summary = [];

        for (const pipeline of pipelines) {
          const stages = pipeline.stages || [];
          const stageData = [];

          // Fetch open opportunities for this pipeline
          const openData = await ghl(`/opportunities/search?location_id=${GHL_LOCATION_ID}&pipeline_id=${pipeline.id}&status=open&limit=100`);
          const openOpps = openData.opportunities || [];

          // Group by stage
          const byStage = {};
          for (const opp of openOpps) {
            const sid = opp.pipelineStageId;
            if (!byStage[sid]) byStage[sid] = { count: 0, value: 0, deals: [] };
            byStage[sid].count++;
            byStage[sid].value += opp.monetaryValue || 0;
            const daysSince = opp.updatedAt ? Math.floor((Date.now() - new Date(opp.updatedAt).getTime()) / 86400000) : null;
            byStage[sid].deals.push({
              name: opp.contact?.name || opp.name,
              value: opp.monetaryValue,
              days_since_update: daysSince,
              stale: daysSince !== null && daysSince >= 5
            });
          }

          for (const stage of stages) {
            const sd = byStage[stage.id] || { count: 0, value: 0, deals: [] };
            const staleDeals = sd.deals.filter(d => d.stale);
            stageData.push({
              stage: stage.name, stage_id: stage.id,
              open_deals: sd.count, total_value: sd.value,
              stale_count: staleDeals.length,
              stale_deals: staleDeals.map(d => `${d.name} (${d.days_since_update}d)`)
            });
          }

          // Fetch won/lost counts
          const wonData = await ghl(`/opportunities/search?location_id=${GHL_LOCATION_ID}&pipeline_id=${pipeline.id}&status=won&limit=1`);
          const lostData = await ghl(`/opportunities/search?location_id=${GHL_LOCATION_ID}&pipeline_id=${pipeline.id}&status=lost&limit=1`);

          summary.push({
            pipeline: pipeline.name, pipeline_id: pipeline.id,
            total_open: openOpps.length,
            total_open_value: openOpps.reduce((s, o) => s + (o.monetaryValue || 0), 0),
            won_count: wonData.meta?.total || 0,
            lost_count: lostData.meta?.total || 0,
            stages: stageData
          });
        }

        return ok({ pipelines: summary });
      }

      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return err(error.message);
  }
});

  return server;
}

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function err(message) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

// Stdio mode when run directly
if (require.main === module) {
  if (!GHL_API_KEY || !GHL_LOCATION_ID) {
    console.error('[mcp] GHL_API_KEY and GHL_LOCATION_ID must be set');
    process.exit(1);
  }
  const server = createServer();
  const transport = new StdioServerTransport();
  server.connect(transport).then(() => console.error('[mcp] GHL server running (22 tools)'));
}

module.exports = { createServer };
