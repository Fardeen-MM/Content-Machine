#!/usr/bin/env node
/**
 * MCP Server: Instantly.ai Cold Email
 *
 * Gives Claude LIVE access to Instantly — campaigns, leads, analytics,
 * email accounts, interested leads, block list.
 *
 * 15 tools covering the full cold email surface area.
 *
 * Run: node mcp/instantly-server.js
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema
} = require('@modelcontextprotocol/sdk/types.js');

const API_KEY = process.env.INSTANTLY_API_KEY;
if (!API_KEY) {
  console.error('[mcp] INSTANTLY_API_KEY must be set');
  process.exit(1);
}
const BASE = 'https://api.instantly.ai/api/v2';

async function inst(path, opts = {}) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Instantly ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.json();
}

const server = new Server(
  { name: 'mortar-instantly', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  // Campaigns
  {
    name: 'get_campaigns',
    description: 'Get all cold email campaigns. Returns name, status (0=draft, 1=active, 2=paused, 3=completed), daily limit, created/updated dates. Use to see what campaigns are running.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 20)' },
        status: { type: 'number', enum: [0, 1, 2, 3], description: '0=draft, 1=active, 2=paused, 3=completed' }
      }
    }
  },
  {
    name: 'get_campaign',
    description: 'Get full campaign details including email sequences (copy for each step), schedule, and settings. Use to review what emails are being sent.',
    inputSchema: {
      type: 'object',
      properties: { campaign_id: { type: 'string' } },
      required: ['campaign_id']
    }
  },
  {
    name: 'get_campaign_analytics',
    description: 'Get campaign performance analytics: sent, opened, replied, bounced, interested, meetings booked, deals closed. Filter by campaign or date range. Default last 30 days.',
    inputSchema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string', description: 'Filter by campaign ID' },
        start_date: { type: 'string', description: 'Start date YYYY-MM-DD (default 30 days ago)' },
        end_date: { type: 'string', description: 'End date YYYY-MM-DD (default today)' }
      }
    }
  },
  {
    name: 'get_campaign_analytics_overview',
    description: 'Get high-level totals across ALL campaigns: total sent, opens, replies, bounces, interested, meetings, closed. The email "dashboard" summary. Default last 30 days.',
    inputSchema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'Start date YYYY-MM-DD' },
        end_date: { type: 'string', description: 'End date YYYY-MM-DD' },
        campaign_status: { type: 'number', description: 'Filter by campaign status' }
      }
    }
  },
  {
    name: 'get_campaign_step_analytics',
    description: 'Get per-step (per-email-in-sequence) performance for a campaign. Shows which email in the sequence performs best. Use to optimize copy.',
    inputSchema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string' },
        start_date: { type: 'string' },
        end_date: { type: 'string' }
      },
      required: ['campaign_id']
    }
  },

  // Leads
  {
    name: 'get_leads',
    description: 'Get leads from campaigns. Returns email, name, company, interest status, custom variables. NOTE: Uses POST endpoint per Instantly API design.',
    inputSchema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string', description: 'Filter by campaign' },
        list_id: { type: 'string', description: 'Filter by list' },
        email: { type: 'string', description: 'Filter by exact email' },
        interest_value: { type: 'number', description: '1=interested, -1=not interested, 0=unknown' },
        limit: { type: 'number', description: 'Max results (default 20)' }
      }
    }
  },
  {
    name: 'get_lead',
    description: 'Get full details for a single lead by ID. Returns all fields including custom variables and campaign history.',
    inputSchema: {
      type: 'object',
      properties: { lead_id: { type: 'string' } },
      required: ['lead_id']
    }
  },
  {
    name: 'search_leads_by_email',
    description: 'Find which campaigns a lead (by email) is in, and get their status in each. Use to look up a specific person across all campaigns.',
    inputSchema: {
      type: 'object',
      properties: { email: { type: 'string' } },
      required: ['email']
    }
  },
  {
    name: 'get_interested_leads',
    description: 'CRITICAL TOOL: Get all leads marked as "interested" (replied positively). These are hot leads who want to talk. Filter by campaign or get all. Use this to find people ready for discovery calls.',
    inputSchema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string', description: 'Filter by campaign' },
        limit: { type: 'number', description: 'Max results (default 50)' }
      }
    }
  },
  {
    name: 'update_lead_interest',
    description: 'Update the interest status of a lead. Use to mark leads as interested (1), not interested (-1), or reset to unknown (0).',
    inputSchema: {
      type: 'object',
      properties: {
        lead_email: { type: 'string' },
        campaign_id: { type: 'string' },
        interest_value: { type: 'number', enum: [-1, 0, 1], description: '1=interested, -1=not interested, 0=unknown' }
      },
      required: ['lead_email', 'campaign_id', 'interest_value']
    }
  },

  // Email Accounts
  {
    name: 'get_email_accounts',
    description: 'Get all sending email accounts. Returns email address, daily limit, warmup status, provider. Use to monitor email infrastructure health.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max results (default 50)' } }
    }
  },
  {
    name: 'get_account_analytics',
    description: 'Get daily analytics for email accounts. Shows send volume, bounces, reputation indicators over time.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Filter by account ID' },
        start_date: { type: 'string' },
        end_date: { type: 'string' }
      }
    }
  },

  // Block List
  {
    name: 'get_block_list',
    description: 'Get blocked email addresses/domains. These are excluded from all campaigns.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max results (default 50)' } }
    }
  },

  // Aggregate
  {
    name: 'get_email_health_summary',
    description: 'THE KEY TOOL: Complete email operations dashboard in one call. Combines campaign analytics overview + account count + active campaigns + interested leads count. Returns: total sent, open rate, reply rate, bounce rate, interested leads, meetings booked, deals closed, active accounts, active campaigns. Use this first when asked about cold email performance.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Look-back period in days (default 30)' }
      }
    }
  }
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'get_campaigns': {
        const params = new URLSearchParams({ limit: String(args.limit || 20) });
        if (args.status !== undefined) params.set('status', String(args.status));
        const data = await inst(`/campaigns?${params}`);
        const campaigns = (data.items || data || []).map(c => ({
          id: c.id, name: c.name,
          status: c.status, status_label: ['draft', 'active', 'paused', 'completed'][c.status] || 'unknown',
          daily_limit: c.daily_limit, created: c.timestamp_created, updated: c.timestamp_updated
        }));
        return ok({ count: campaigns.length, campaigns });
      }

      case 'get_campaign': {
        const data = await inst(`/campaigns/${args.campaign_id}`);
        return ok(data);
      }

      case 'get_campaign_analytics': {
        const now = new Date();
        const params = new URLSearchParams({
          start_date: args.start_date || new Date(now - 30 * 86400000).toISOString().split('T')[0],
          end_date: args.end_date || now.toISOString().split('T')[0]
        });
        if (args.campaign_id) params.set('id', args.campaign_id);
        const data = await inst(`/campaigns/analytics?${params}`);
        return ok(data);
      }

      case 'get_campaign_analytics_overview': {
        const now = new Date();
        const params = new URLSearchParams({
          start_date: args.start_date || new Date(now - 30 * 86400000).toISOString().split('T')[0],
          end_date: args.end_date || now.toISOString().split('T')[0]
        });
        if (args.campaign_status !== undefined) params.set('campaign_status', String(args.campaign_status));
        const data = await inst(`/campaigns/analytics/overview?${params}`);
        return ok(data);
      }

      case 'get_campaign_step_analytics': {
        const now = new Date();
        const params = new URLSearchParams({ id: args.campaign_id });
        if (args.start_date) params.set('start_date', args.start_date);
        if (args.end_date) params.set('end_date', args.end_date);
        const data = await inst(`/campaigns/analytics/steps?${params}`);
        return ok(data);
      }

      case 'get_leads': {
        const body = { limit: args.limit || 20 };
        if (args.campaign_id) body.campaign_id = args.campaign_id;
        if (args.list_id) body.list_id = args.list_id;
        if (args.email) body.email = args.email;
        if (args.interest_value !== undefined) body.interest_value = args.interest_value;
        const data = await inst('/leads/list', { method: 'POST', body });
        const leads = (data.items || data || []).map(l => ({
          id: l.id, email: l.email,
          first_name: l.first_name, last_name: l.last_name,
          company: l.company_name, interest: l.interest_value,
          campaign: l.campaign_name || l.campaign_id
        }));
        return ok({ count: leads.length, leads });
      }

      case 'get_lead': {
        const data = await inst(`/leads/${args.lead_id}`);
        return ok(data);
      }

      case 'search_leads_by_email': {
        // Search which campaigns contain this email
        const data = await inst(`/campaigns/search-by-contact?search=${encodeURIComponent(args.email)}`);
        const campaigns = data.items || data || [];
        // For each campaign, try to get lead detail
        const results = [];
        for (const c of campaigns.slice(0, 5)) {
          try {
            const leadData = await inst('/leads/list', {
              method: 'POST',
              body: { campaign_id: c.id, email: args.email, limit: 1 }
            });
            const leads = leadData.items || leadData || [];
            if (leads.length > 0) {
              results.push({
                campaign_id: c.id, campaign_name: c.name,
                lead: leads[0]
              });
            }
          } catch (e) {
            results.push({ campaign_id: c.id, campaign_name: c.name, error: e.message });
          }
        }
        return ok({ email: args.email, found_in_campaigns: results.length, results });
      }

      case 'get_interested_leads': {
        const body = { interest_value: 1, limit: args.limit || 50 };
        if (args.campaign_id) body.campaign_id = args.campaign_id;
        const data = await inst('/leads/list', { method: 'POST', body });
        const leads = (data.items || data || []).map(l => ({
          id: l.id, email: l.email,
          first_name: l.first_name, last_name: l.last_name,
          company: l.company_name, campaign: l.campaign_name || l.campaign_id,
          interest: l.interest_value
        }));
        return ok({ count: leads.length, leads });
      }

      case 'update_lead_interest': {
        const data = await inst('/leads/update-interest-status', {
          method: 'POST',
          body: {
            lead_email: args.lead_email,
            campaign_id: args.campaign_id,
            interest_value: args.interest_value
          }
        });
        return ok({ updated: true, result: data });
      }

      case 'get_email_accounts': {
        const params = new URLSearchParams({ limit: String(args.limit || 50) });
        const data = await inst(`/accounts?${params}`);
        const accounts = (data.items || data || []).map(a => ({
          id: a.id, email: a.email, daily_limit: a.daily_limit,
          warmup_enabled: a.warmup_enabled, provider: a.provider,
          status: a.status
        }));
        return ok({ count: accounts.length, accounts });
      }

      case 'get_account_analytics': {
        const params = new URLSearchParams();
        if (args.account_id) params.set('account_id', args.account_id);
        if (args.start_date) params.set('start_date', args.start_date);
        if (args.end_date) params.set('end_date', args.end_date);
        const data = await inst(`/accounts/analytics/daily?${params}`);
        return ok(data);
      }

      case 'get_block_list': {
        const params = new URLSearchParams({ limit: String(args.limit || 50) });
        const data = await inst(`/block-list-entries?${params}`);
        return ok(data);
      }

      case 'get_email_health_summary': {
        const days = args.days || 30;
        const now = new Date();
        const startDate = new Date(now - days * 86400000).toISOString().split('T')[0];
        const endDate = now.toISOString().split('T')[0];

        // Fetch in parallel
        const [overview, campaigns, accounts, interested] = await Promise.all([
          inst(`/campaigns/analytics/overview?start_date=${startDate}&end_date=${endDate}`).catch(e => ({ error: e.message })),
          inst('/campaigns?limit=100').catch(e => ({ error: e.message })),
          inst('/accounts?limit=100').catch(e => ({ error: e.message })),
          inst('/leads/list', { method: 'POST', body: { interest_value: 1, limit: 1 } }).catch(e => ({ error: e.message }))
        ]);

        const campaignList = campaigns.items || campaigns || [];
        const accountList = accounts.items || accounts || [];
        const activeCampaigns = Array.isArray(campaignList) ? campaignList.filter(c => c.status === 1).length : 0;
        const totalAccounts = Array.isArray(accountList) ? accountList.length : 0;

        const sent = overview.total_sent || overview.sent || 0;
        const opened = overview.total_opened || overview.opened || 0;
        const replied = overview.total_replied || overview.replied || 0;
        const bounced = overview.total_bounced || overview.bounced || 0;

        return ok({
          period: `${startDate} to ${endDate}`,
          emails_sent: sent,
          open_rate: sent > 0 ? `${((opened / sent) * 100).toFixed(1)}%` : 'N/A',
          reply_rate: sent > 0 ? `${((replied / sent) * 100).toFixed(1)}%` : 'N/A',
          bounce_rate: sent > 0 ? `${((bounced / sent) * 100).toFixed(1)}%` : 'N/A',
          interested_leads: overview.total_interested || overview.interested || 0,
          meetings_booked: overview.total_meetings || overview.meetings || 0,
          deals_closed: overview.total_closed || overview.closed || 0,
          active_campaigns: activeCampaigns,
          total_campaigns: Array.isArray(campaignList) ? campaignList.length : 0,
          sending_accounts: totalAccounts,
          raw_overview: overview
        });
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
  console.error('[mcp] Instantly server running (15 tools)');
}

main().catch(err => { console.error(err); process.exit(1); });
