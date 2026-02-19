#!/usr/bin/env node
/**
 * API Connection Test Script
 *
 * Verifies GHL, Instantly, and Fireflies API connections.
 * Run: node scripts/test-connections.js
 */

// Load .env file
const path = require('path');
const fs = require('fs');
const envPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_BASE = 'https://services.leadconnectorhq.com';

const INSTANTLY_API_KEY = process.env.INSTANTLY_API_KEY;
const INSTANTLY_BASE = 'https://api.instantly.ai/api/v2';

const FIREFLIES_API_KEY = process.env.FIREFLIES_API_KEY || '';

let passed = 0, failed = 0, skipped = 0;

async function ghl(path) {
  const res = await fetch(`${GHL_BASE}${path}`, {
    headers: {
      'Authorization': `Bearer ${GHL_API_KEY}`,
      'Version': '2021-07-28',
      'Accept': 'application/json'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => '')}`);
  return res.json();
}

async function inst(path, opts = {}) {
  const res = await fetch(`${INSTANTLY_BASE}${path}`, {
    method: opts.method || 'GET',
    headers: {
      'Authorization': `Bearer ${INSTANTLY_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => '')}`);
  return res.json();
}

async function test(label, fn) {
  try {
    const result = await fn();
    console.log(`  ✅ ${label}`);
    if (result) console.log(`     ${result}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${label}`);
    console.log(`     Error: ${err.message.slice(0, 200)}`);
    failed++;
  }
}

function skip(label, reason) {
  console.log(`  ⚠️  ${label} — ${reason}`);
  skipped++;
}

async function main() {
  console.log('\n═══════════════════════════════════════');
  console.log('  Mortar Metrics — API Connection Test');
  console.log('═══════════════════════════════════════\n');

  // ── GHL ──
  console.log('🏢 GoHighLevel CRM');
  console.log('─────────────────────────────────────');

  await test('Get Pipelines', async () => {
    const data = await ghl(`/opportunities/pipelines?locationId=${GHL_LOCATION_ID}`);
    const pipelines = data.pipelines || [];
    if (pipelines.length === 0) return 'No pipelines found';
    return pipelines.map(p => {
      const stages = (p.stages || []).map(s => s.name).join(' → ');
      return `${p.name}: ${stages}`;
    }).join('\n     ');
  });

  await test('Get Opportunities (first pipeline)', async () => {
    const pData = await ghl(`/opportunities/pipelines?locationId=${GHL_LOCATION_ID}`);
    const pipelines = pData.pipelines || [];
    if (pipelines.length === 0) return 'No pipelines — skipping';
    const pid = pipelines[0].id;
    const data = await ghl(`/opportunities/search?location_id=${GHL_LOCATION_ID}&pipeline_id=${pid}&limit=10`);
    const opps = data.opportunities || [];
    if (opps.length === 0) return `Pipeline "${pipelines[0].name}": 0 deals`;
    return opps.map(o =>
      `${o.contact?.name || o.name || '?'} | ${o.pipelineStageName || '?'} | $${o.monetaryValue || 0} | ${o.status}`
    ).join('\n     ');
  });

  await test('Get Contacts (10)', async () => {
    const data = await ghl(`/contacts/?locationId=${GHL_LOCATION_ID}&limit=10`);
    const contacts = data.contacts || [];
    if (contacts.length === 0) return 'No contacts found';
    return contacts.map(c =>
      `${c.firstName || ''} ${c.lastName || ''} | ${c.email || 'no email'} | tags: ${(c.tags || []).join(', ') || 'none'}`
    ).join('\n     ');
  });

  await test('Get Calendars', async () => {
    const data = await ghl(`/calendars/?locationId=${GHL_LOCATION_ID}`);
    const cals = data.calendars || [];
    if (cals.length === 0) return 'No calendars found';
    return cals.map(c => c.name).join(', ');
  });

  await test('Get Users', async () => {
    const data = await ghl(`/users/?locationId=${GHL_LOCATION_ID}`);
    const users = data.users || [];
    if (users.length === 0) return 'No users found';
    return users.map(u => `${u.name} (${u.email}) — ${u.role}`).join('\n     ');
  });

  await test('Get Tags', async () => {
    const data = await ghl(`/locations/${GHL_LOCATION_ID}/tags`);
    const tags = data.tags || [];
    if (tags.length === 0) return 'No tags found';
    return tags.map(t => t.name || t).join(', ');
  });

  await test('Get Custom Fields', async () => {
    const data = await ghl(`/locations/${GHL_LOCATION_ID}/customFields`);
    const fields = data.customFields || [];
    if (fields.length === 0) return 'No custom fields';
    return fields.map(f => `${f.name} (${f.dataType})`).join(', ');
  });

  // ── Instantly ──
  console.log('\n📧 Instantly.ai Cold Email');
  console.log('─────────────────────────────────────');

  await test('Get Campaigns', async () => {
    const data = await inst('/campaigns?limit=20');
    const campaigns = data.items || data || [];
    if (!Array.isArray(campaigns) || campaigns.length === 0) return 'No campaigns found';
    const labels = ['draft', 'active', 'paused', 'completed'];
    return campaigns.map(c => `${c.name} [${labels[c.status] || c.status}]`).join('\n     ');
  });

  await test('Get Analytics Overview (30 days)', async () => {
    const now = new Date();
    const start = new Date(now - 30 * 86400000).toISOString().split('T')[0];
    const end = now.toISOString().split('T')[0];
    const data = await inst(`/campaigns/analytics/overview?start_date=${start}&end_date=${end}`);
    const sent = data.total_sent || data.sent || 0;
    const opened = data.total_opened || data.opened || 0;
    const replied = data.total_replied || data.replied || 0;
    const interested = data.total_interested || data.interested || 0;
    const meetings = data.total_meetings || data.meetings || 0;
    return `Sent: ${sent} | Opened: ${opened} | Replied: ${replied} | Interested: ${interested} | Meetings: ${meetings}`;
  });

  await test('Get Email Accounts', async () => {
    const data = await inst('/accounts?limit=50');
    const accounts = data.items || data || [];
    if (!Array.isArray(accounts)) return `Response: ${JSON.stringify(data).slice(0, 200)}`;
    const warmup = accounts.filter(a => a.warmup_enabled).length;
    return `${accounts.length} accounts (${warmup} with warmup enabled)`;
  });

  await test('Get Interested Leads', async () => {
    const data = await inst('/leads/list', { method: 'POST', body: { interest_value: 1, limit: 5 } });
    const leads = data.items || data || [];
    if (!Array.isArray(leads) || leads.length === 0) return 'No interested leads found';
    return leads.map(l =>
      `${l.first_name || ''} ${l.last_name || ''} <${l.email}> | ${l.company_name || 'no company'}`
    ).join('\n     ');
  });

  // ── Fireflies ──
  console.log('\n🎙️  Fireflies.ai Transcripts');
  console.log('─────────────────────────────────────');

  if (!FIREFLIES_API_KEY) {
    skip('Get Recent Transcripts', 'FIREFLIES_API_KEY not set');
  } else {
    await test('Get Recent Transcripts (5)', async () => {
      const query = `query { transcripts(limit: 5) { id title dateString duration } }`;
      const res = await fetch('https://api.fireflies.ai/graphql', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${FIREFLIES_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      if (data.errors) throw new Error(data.errors[0].message);
      const transcripts = data.data?.transcripts || [];
      if (transcripts.length === 0) return 'No transcripts found';
      return transcripts.map(t => `${t.title} (${t.dateString}) — ${t.duration}min`).join('\n     ');
    });
  }

  // ── Summary ──
  console.log('\n═══════════════════════════════════════');
  console.log(`  Results: ✅ ${passed} passed  ❌ ${failed} failed  ⚠️  ${skipped} skipped`);
  console.log('═══════════════════════════════════════');

  if (failed > 0) {
    console.log('\n⚡ Next steps:');
    console.log('  1. Check API keys in .env or hardcoded defaults');
    console.log('  2. Verify GHL Location ID is correct');
    console.log('  3. Check Instantly API key has V2 access');
    console.log('  4. Re-run: node scripts/test-connections.js');
  } else {
    console.log('\n🚀 All APIs connected! Next steps:');
    console.log('  1. Configure Claude Desktop MCP servers (see MANUAL-STEPS.md section 6)');
    console.log('  2. Open Claude Desktop → "What\'s the pipeline looking like?"');
    console.log('  3. Try: "Show me interested leads from Instantly"');
  }
  console.log('');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
