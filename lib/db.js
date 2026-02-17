const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'knowledge.db');

let _db = null;

function getDb() {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
  }
  return _db;
}

function initDb() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS meetings (
      id INTEGER PRIMARY KEY,
      fireflies_id TEXT UNIQUE,
      title TEXT NOT NULL,
      date TEXT NOT NULL,
      duration_minutes INTEGER,
      client_name TEXT,
      client_email TEXT,
      meeting_type TEXT,
      transcript TEXT,
      summary TEXT,
      sentiment TEXT,
      classification TEXT,
      extracted_data TEXT,
      coaching_notes TEXT,
      raw_response TEXT,
      processed_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      firm_name TEXT,
      phone TEXT,
      practice_areas TEXT,
      source TEXT,
      status TEXT DEFAULT 'prospect',
      notes TEXT,
      first_seen TEXT,
      last_seen TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS proposals (
      id INTEGER PRIMARY KEY,
      meeting_id INTEGER REFERENCES meetings(id),
      client_id INTEGER REFERENCES clients(id),
      title TEXT,
      content TEXT,
      services TEXT,
      monthly_value REAL,
      status TEXT DEFAULT 'draft',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS actions (
      id INTEGER PRIMARY KEY,
      meeting_id INTEGER REFERENCES meetings(id),
      client_id INTEGER REFERENCES clients(id),
      description TEXT NOT NULL,
      owner TEXT,
      due_date TEXT,
      status TEXT DEFAULT 'open',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS content_atoms (
      id INTEGER PRIMARY KEY,
      meeting_id INTEGER REFERENCES meetings(id),
      type TEXT,
      content TEXT NOT NULL,
      tags TEXT,
      used_in TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS patterns (
      id INTEGER PRIMARY KEY,
      type TEXT,
      description TEXT NOT NULL,
      frequency INTEGER DEFAULT 1,
      meeting_ids TEXT,
      first_seen TEXT,
      last_seen TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS external_events (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      event_type TEXT,
      client_name TEXT,
      client_email TEXT,
      data TEXT,
      processed INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS inspirations (
      id INTEGER PRIMARY KEY,
      source TEXT,
      content TEXT NOT NULL,
      tags TEXT,
      used INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY,
      output_id TEXT NOT NULL,
      output_type TEXT NOT NULL,
      rating INTEGER NOT NULL,
      comment TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS health_snapshots (
      id INTEGER PRIMARY KEY,
      client_id INTEGER NOT NULL,
      health_status TEXT NOT NULL,
      days_since_contact INTEGER,
      proposal_pending INTEGER DEFAULT 0,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (client_id) REFERENCES clients(id)
    );

    CREATE TABLE IF NOT EXISTS style_guides (
      id INTEGER PRIMARY KEY,
      category TEXT NOT NULL,
      guide_text TEXT NOT NULL,
      based_on_count INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS briefs (
      id INTEGER PRIMARY KEY,
      client_id INTEGER,
      meeting_id INTEGER,
      brief_text TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      context_used TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  return db;
}

// --- Meetings ---

function insertMeeting(data) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO meetings (fireflies_id, title, date, duration_minutes, client_name, client_email,
      meeting_type, transcript, summary, sentiment, classification, extracted_data, coaching_notes,
      raw_response, processed_at)
    VALUES (@fireflies_id, @title, @date, @duration_minutes, @client_name, @client_email,
      @meeting_type, @transcript, @summary, @sentiment, @classification, @extracted_data,
      @coaching_notes, @raw_response, @processed_at)
  `);
  const result = stmt.run({
    fireflies_id: data.fireflies_id || null,
    title: data.title,
    date: data.date,
    duration_minutes: data.duration_minutes || null,
    client_name: data.client_name || null,
    client_email: data.client_email || null,
    meeting_type: data.meeting_type || 'unknown',
    transcript: data.transcript || null,
    summary: data.summary || null,
    sentiment: data.sentiment || null,
    classification: data.classification ? JSON.stringify(data.classification) : null,
    extracted_data: data.extracted_data ? JSON.stringify(data.extracted_data) : null,
    coaching_notes: data.coaching_notes ? JSON.stringify(data.coaching_notes) : null,
    raw_response: data.raw_response ? JSON.stringify(data.raw_response) : null,
    processed_at: data.processed_at || null
  });
  return getMeeting(result.lastInsertRowid);
}

function getMeeting(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM meetings WHERE id = ?').get(id);
  return row ? parseMeetingRow(row) : null;
}

function getMeetings({ limit = 50, offset = 0, type, client, from, to } = {}) {
  const db = getDb();
  let sql = 'SELECT * FROM meetings WHERE 1=1';
  const params = [];

  if (type) { sql += ' AND meeting_type = ?'; params.push(type); }
  if (client) { sql += ' AND (client_name LIKE ? OR client_email LIKE ?)'; params.push(`%${client}%`, `%${client}%`); }
  if (from) { sql += ' AND date >= ?'; params.push(from); }
  if (to) { sql += ' AND date <= ?'; params.push(to); }

  sql += ' ORDER BY date DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return db.prepare(sql).all(...params).map(parseMeetingRow);
}

function updateMeeting(id, fields) {
  const db = getDb();
  const allowed = ['title', 'client_name', 'client_email', 'meeting_type', 'transcript',
    'summary', 'sentiment', 'classification', 'extracted_data', 'coaching_notes', 'processed_at'];
  const sets = [];
  const params = [];

  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      const val = fields[key];
      params.push(typeof val === 'object' && val !== null ? JSON.stringify(val) : val);
    }
  }

  if (sets.length === 0) return getMeeting(id);

  params.push(id);
  db.prepare(`UPDATE meetings SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getMeeting(id);
}

function searchMeetings(query) {
  const db = getDb();
  const like = `%${query}%`;
  return db.prepare(`
    SELECT * FROM meetings WHERE title LIKE ? OR transcript LIKE ? OR summary LIKE ?
    ORDER BY date DESC LIMIT 50
  `).all(like, like, like).map(parseMeetingRow);
}

function parseMeetingRow(row) {
  if (!row) return null;
  return {
    ...row,
    classification: row.classification ? JSON.parse(row.classification) : null,
    extracted_data: row.extracted_data ? JSON.parse(row.extracted_data) : null,
    coaching_notes: row.coaching_notes ? JSON.parse(row.coaching_notes) : null,
    raw_response: row.raw_response ? JSON.parse(row.raw_response) : null
  };
}

// --- Clients ---

function insertClient(data) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO clients (name, email, firm_name, phone, practice_areas, source, status, notes, first_seen, last_seen)
    VALUES (@name, @email, @firm_name, @phone, @practice_areas, @source, @status, @notes, @first_seen, @last_seen)
  `);
  const result = stmt.run({
    name: data.name,
    email: data.email || null,
    firm_name: data.firm_name || null,
    phone: data.phone || null,
    practice_areas: data.practice_areas ? JSON.stringify(data.practice_areas) : null,
    source: data.source || 'manual',
    status: data.status || 'prospect',
    notes: data.notes || null,
    first_seen: data.first_seen || new Date().toISOString(),
    last_seen: data.last_seen || new Date().toISOString()
  });
  return getClient(result.lastInsertRowid);
}

function getClient(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
  return row ? parseClientRow(row) : null;
}

function getClients({ limit = 100, offset = 0, status, search } = {}) {
  const db = getDb();
  let sql = 'SELECT * FROM clients WHERE 1=1';
  const params = [];

  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (search) { sql += ' AND (name LIKE ? OR email LIKE ? OR firm_name LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }

  sql += ' ORDER BY last_seen DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return db.prepare(sql).all(...params).map(parseClientRow);
}

function upsertClient(email, data) {
  const db = getDb();

  // Try to find existing client by email first, then by name
  let existing = null;
  if (email) {
    existing = db.prepare('SELECT * FROM clients WHERE email = ?').get(email);
  }
  if (!existing && data.name) {
    existing = db.prepare('SELECT * FROM clients WHERE name = ? COLLATE NOCASE').get(data.name);
  }
  if (existing) {
    const sets = [];
    const params = [];
    if (data.name && data.name !== existing.name) { sets.push('name = ?'); params.push(data.name); }
    if (email && !existing.email) { sets.push('email = ?'); params.push(email); }
    if (data.firm_name && !existing.firm_name) { sets.push('firm_name = ?'); params.push(data.firm_name); }
    if (data.phone && !existing.phone) { sets.push('phone = ?'); params.push(data.phone); }
    if (data.practice_areas?.length > 0 && (!existing.practice_areas || existing.practice_areas === '[]')) {
      sets.push('practice_areas = ?'); params.push(JSON.stringify(data.practice_areas));
    }
    sets.push('last_seen = ?'); params.push(new Date().toISOString());

    if (sets.length > 0) {
      params.push(existing.id);
      db.prepare(`UPDATE clients SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    }
    return getClient(existing.id);
  }

  return insertClient({ ...data, email });
}

function parseClientRow(row) {
  if (!row) return null;
  return {
    ...row,
    practice_areas: row.practice_areas ? JSON.parse(row.practice_areas) : []
  };
}

// --- Actions ---

function insertAction(data) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO actions (meeting_id, client_id, description, owner, due_date, status)
    VALUES (@meeting_id, @client_id, @description, @owner, @due_date, @status)
  `);
  const result = stmt.run({
    meeting_id: data.meeting_id || null,
    client_id: data.client_id || null,
    description: data.description,
    owner: data.owner || null,
    due_date: data.due_date || null,
    status: data.status || 'open'
  });
  return db.prepare('SELECT * FROM actions WHERE id = ?').get(result.lastInsertRowid);
}

function getActions({ meeting_id, client_id, status, limit = 100 } = {}) {
  const db = getDb();
  let sql = 'SELECT * FROM actions WHERE 1=1';
  const params = [];

  if (meeting_id) { sql += ' AND meeting_id = ?'; params.push(meeting_id); }
  if (client_id) { sql += ' AND client_id = ?'; params.push(client_id); }
  if (status) { sql += ' AND status = ?'; params.push(status); }

  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params);
}

function updateAction(id, fields) {
  const db = getDb();
  const sets = [];
  const params = [];

  if (fields.status) { sets.push('status = ?'); params.push(fields.status); }
  if (fields.description) { sets.push('description = ?'); params.push(fields.description); }
  if (fields.due_date !== undefined) { sets.push('due_date = ?'); params.push(fields.due_date); }

  if (sets.length === 0) return;

  params.push(id);
  db.prepare(`UPDATE actions SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return db.prepare('SELECT * FROM actions WHERE id = ?').get(id);
}

// --- Content Atoms ---

function insertAtom(data) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO content_atoms (meeting_id, type, content, tags, used_in)
    VALUES (@meeting_id, @type, @content, @tags, @used_in)
  `);
  const result = stmt.run({
    meeting_id: data.meeting_id || null,
    type: data.type || null,
    content: data.content,
    tags: data.tags ? JSON.stringify(data.tags) : null,
    used_in: data.used_in ? JSON.stringify(data.used_in) : null
  });
  return db.prepare('SELECT * FROM content_atoms WHERE id = ?').get(result.lastInsertRowid);
}

function getAtoms({ meeting_id, type, limit = 100 } = {}) {
  const db = getDb();
  let sql = 'SELECT * FROM content_atoms WHERE 1=1';
  const params = [];

  if (meeting_id) { sql += ' AND meeting_id = ?'; params.push(meeting_id); }
  if (type) { sql += ' AND type = ?'; params.push(type); }

  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params).map(row => ({
    ...row,
    tags: row.tags ? JSON.parse(row.tags) : [],
    used_in: row.used_in ? JSON.parse(row.used_in) : []
  }));
}

// --- Patterns ---

function insertPattern(data) {
  const db = getDb();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO patterns (type, description, frequency, meeting_ids, first_seen, last_seen)
    VALUES (@type, @description, @frequency, @meeting_ids, @first_seen, @last_seen)
  `);
  const result = stmt.run({
    type: data.type,
    description: data.description,
    frequency: data.frequency || 1,
    meeting_ids: JSON.stringify(data.meeting_ids || []),
    first_seen: data.first_seen || now,
    last_seen: data.last_seen || now
  });
  return db.prepare('SELECT * FROM patterns WHERE id = ?').get(result.lastInsertRowid);
}

function upsertPattern(type, description, meetingId) {
  const db = getDb();
  const existing = db.prepare(
    'SELECT * FROM patterns WHERE type = ? AND description = ?'
  ).get(type, description);

  if (existing) {
    const ids = JSON.parse(existing.meeting_ids || '[]');
    if (!ids.includes(meetingId)) ids.push(meetingId);
    db.prepare(`
      UPDATE patterns SET frequency = ?, meeting_ids = ?, last_seen = datetime('now')
      WHERE id = ?
    `).run(ids.length, JSON.stringify(ids), existing.id);
    return db.prepare('SELECT * FROM patterns WHERE id = ?').get(existing.id);
  }

  return insertPattern({
    type,
    description,
    frequency: 1,
    meeting_ids: meetingId ? [meetingId] : []
  });
}

function getPatterns({ type, limit = 100 } = {}) {
  const db = getDb();
  let sql = 'SELECT * FROM patterns WHERE 1=1';
  const params = [];

  if (type) { sql += ' AND type = ?'; params.push(type); }

  sql += ' ORDER BY frequency DESC, last_seen DESC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params).map(row => ({
    ...row,
    meeting_ids: row.meeting_ids ? JSON.parse(row.meeting_ids) : []
  }));
}

// --- External Events ---

function insertEvent(data) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO external_events (source, event_type, client_name, client_email, data, processed)
    VALUES (@source, @event_type, @client_name, @client_email, @data, @processed)
  `);
  const result = stmt.run({
    source: data.source,
    event_type: data.event_type || null,
    client_name: data.client_name || null,
    client_email: data.client_email || null,
    data: data.data ? JSON.stringify(data.data) : null,
    processed: data.processed || 0
  });
  return db.prepare('SELECT * FROM external_events WHERE id = ?').get(result.lastInsertRowid);
}

function getEvents({ source, limit = 100, processed } = {}) {
  const db = getDb();
  let sql = 'SELECT * FROM external_events WHERE 1=1';
  const params = [];

  if (source) { sql += ' AND source = ?'; params.push(source); }
  if (processed !== undefined) { sql += ' AND processed = ?'; params.push(processed ? 1 : 0); }

  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params).map(row => ({
    ...row,
    data: row.data ? JSON.parse(row.data) : null
  }));
}

// --- Feedback ---

function insertFeedback(data) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO feedback (output_id, output_type, rating, comment)
    VALUES (@output_id, @output_type, @rating, @comment)
  `);
  const result = stmt.run({
    output_id: data.output_id,
    output_type: data.output_type,
    rating: data.rating,
    comment: data.comment || null
  });
  return db.prepare('SELECT * FROM feedback WHERE id = ?').get(result.lastInsertRowid);
}

function getFeedback({ output_type, limit = 100 } = {}) {
  const db = getDb();
  let sql = 'SELECT * FROM feedback WHERE 1=1';
  const params = [];
  if (output_type) { sql += ' AND output_type = ?'; params.push(output_type); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}

// --- Health Snapshots ---

function insertHealthSnapshot(data) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO health_snapshots (client_id, health_status, days_since_contact, proposal_pending, notes)
    VALUES (@client_id, @health_status, @days_since_contact, @proposal_pending, @notes)
  `);
  const result = stmt.run({
    client_id: data.client_id,
    health_status: data.health_status,
    days_since_contact: data.days_since_contact || 0,
    proposal_pending: data.proposal_pending || 0,
    notes: data.notes || null
  });
  return db.prepare('SELECT * FROM health_snapshots WHERE id = ?').get(result.lastInsertRowid);
}

function getLatestHealth(clientId) {
  const db = getDb();
  return db.prepare('SELECT * FROM health_snapshots WHERE client_id = ? ORDER BY created_at DESC LIMIT 1').get(clientId);
}

// --- Chat Messages ---

function insertChatMessage(data) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO chat_messages (role, content, context_used)
    VALUES (@role, @content, @context_used)
  `);
  const result = stmt.run({
    role: data.role,
    content: data.content,
    context_used: data.context_used || null
  });
  return db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(result.lastInsertRowid);
}

function getChatMessages({ limit = 50 } = {}) {
  const db = getDb();
  return db.prepare('SELECT * FROM chat_messages ORDER BY created_at DESC LIMIT ?').all(limit).reverse();
}

// --- Reprocess helpers ---

function clearDerivedData() {
  const db = getDb();
  db.exec(`
    DELETE FROM clients;
    DELETE FROM actions;
    DELETE FROM content_atoms;
    DELETE FROM patterns;
    UPDATE meetings SET
      client_name = NULL,
      client_email = NULL,
      meeting_type = NULL,
      summary = NULL,
      sentiment = NULL,
      classification = NULL,
      extracted_data = NULL,
      coaching_notes = NULL,
      processed_at = NULL;
  `);
  return { cleared: true };
}

function getUnprocessedMeetings() {
  const db = getDb();
  return db.prepare('SELECT * FROM meetings WHERE processed_at IS NULL ORDER BY date ASC').all().map(parseMeetingRow);
}

// --- Stats ---

function getStats() {
  const db = getDb();
  return {
    meetings: {
      total: db.prepare('SELECT COUNT(*) as c FROM meetings').get().c,
      processed: db.prepare('SELECT COUNT(*) as c FROM meetings WHERE processed_at IS NOT NULL').get().c,
      by_type: db.prepare(`
        SELECT meeting_type, COUNT(*) as count FROM meetings
        GROUP BY meeting_type ORDER BY count DESC
      `).all().reduce((acc, r) => { acc[r.meeting_type || 'unknown'] = r.count; return acc; }, {})
    },
    clients: {
      total: db.prepare('SELECT COUNT(*) as c FROM clients').get().c,
      by_status: db.prepare(`
        SELECT status, COUNT(*) as count FROM clients
        GROUP BY status ORDER BY count DESC
      `).all().reduce((acc, r) => { acc[r.status] = r.count; return acc; }, {})
    },
    actions: {
      total: db.prepare('SELECT COUNT(*) as c FROM actions').get().c,
      open: db.prepare("SELECT COUNT(*) as c FROM actions WHERE status = 'open'").get().c
    },
    atoms: db.prepare('SELECT COUNT(*) as c FROM content_atoms').get().c,
    patterns: db.prepare('SELECT COUNT(*) as c FROM patterns').get().c,
    events: db.prepare('SELECT COUNT(*) as c FROM external_events').get().c
  };
}

module.exports = {
  getDb, initDb,
  insertMeeting, getMeeting, getMeetings, updateMeeting, searchMeetings,
  insertClient, getClient, getClients, upsertClient,
  insertAction, getActions, updateAction,
  insertAtom, getAtoms,
  insertPattern, upsertPattern, getPatterns,
  insertEvent, getEvents,
  insertFeedback, getFeedback,
  insertHealthSnapshot, getLatestHealth,
  insertChatMessage, getChatMessages,
  clearDerivedData, getUnprocessedMeetings,
  getStats
};
