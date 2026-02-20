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

    CREATE TABLE IF NOT EXISTS learned_insights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      insight TEXT NOT NULL,
      source TEXT,
      source_id TEXT,
      confidence REAL DEFAULT 0.5,
      frequency INTEGER DEFAULT 1,
      first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
      confirmed_by TEXT,
      status TEXT DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS team_inputs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question TEXT NOT NULL,
      answer TEXT,
      asked_by TEXT DEFAULT 'system',
      answered_by TEXT,
      category TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      applied_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS deal_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER REFERENCES clients(id),
      proposal_id INTEGER REFERENCES proposals(id),
      outcome TEXT NOT NULL,
      monthly_value REAL,
      close_time_days INTEGER,
      loss_reason TEXT,
      what_worked TEXT,
      what_failed TEXT,
      practice_area TEXT,
      source_channel TEXT,
      speed_to_lead_minutes INTEGER,
      proposal_delay_days REAL,
      recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pestering_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER REFERENCES clients(id),
      stage TEXT NOT NULL,
      channel TEXT NOT NULL,
      message_type TEXT,
      content TEXT,
      status TEXT DEFAULT 'pending',
      scheduled_for DATETIME,
      sent_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS error_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      error_type TEXT,
      message TEXT NOT NULL,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Indexes for common queries
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_meetings_date ON meetings(date);
    CREATE INDEX IF NOT EXISTS idx_meetings_client_name ON meetings(client_name);
    CREATE INDEX IF NOT EXISTS idx_meetings_type ON meetings(meeting_type);
    CREATE INDEX IF NOT EXISTS idx_meetings_fireflies_id ON meetings(fireflies_id);
    CREATE INDEX IF NOT EXISTS idx_clients_email ON clients(email);
    CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status);
    CREATE INDEX IF NOT EXISTS idx_actions_meeting_id ON actions(meeting_id);
    CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status);
    CREATE INDEX IF NOT EXISTS idx_content_atoms_meeting_id ON content_atoms(meeting_id);
    CREATE INDEX IF NOT EXISTS idx_content_atoms_type ON content_atoms(type);
    CREATE INDEX IF NOT EXISTS idx_external_events_source ON external_events(source);
    CREATE INDEX IF NOT EXISTS idx_external_events_processed ON external_events(processed);
    CREATE INDEX IF NOT EXISTS idx_patterns_type ON patterns(type);
    CREATE INDEX IF NOT EXISTS idx_pestering_log_client_id ON pestering_log(client_id);
    CREATE INDEX IF NOT EXISTS idx_pestering_log_status ON pestering_log(status);
    CREATE INDEX IF NOT EXISTS idx_deal_outcomes_client_id ON deal_outcomes(client_id);
    CREATE INDEX IF NOT EXISTS idx_briefs_created ON briefs(created_at);
    CREATE INDEX IF NOT EXISTS idx_error_log_source ON error_log(source);
    CREATE INDEX IF NOT EXISTS idx_error_log_created ON error_log(created_at);
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

// --- Proposals ---

function insertProposal(data) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO proposals (meeting_id, client_id, title, content, services, monthly_value, status)
    VALUES (@meeting_id, @client_id, @title, @content, @services, @monthly_value, @status)
  `);
  const result = stmt.run({
    meeting_id: data.meeting_id || null,
    client_id: data.client_id || null,
    title: data.title || 'Untitled Proposal',
    content: data.content || '',
    services: data.services ? JSON.stringify(data.services) : null,
    monthly_value: data.monthly_value || 0,
    status: data.status || 'draft'
  });
  return getProposal(result.lastInsertRowid);
}

function getProposal(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM proposals WHERE id = ?').get(id);
  return row ? parseProposalRow(row) : null;
}

function getProposals({ client_id, status, limit = 100 } = {}) {
  const db = getDb();
  let sql = 'SELECT * FROM proposals WHERE 1=1';
  const params = [];
  if (client_id) { sql += ' AND client_id = ?'; params.push(client_id); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params).map(parseProposalRow);
}

function updateProposal(id, fields) {
  const db = getDb();
  const sets = [];
  const params = [];
  if (fields.title !== undefined) { sets.push('title = ?'); params.push(fields.title); }
  if (fields.content !== undefined) { sets.push('content = ?'); params.push(fields.content); }
  if (fields.status !== undefined) { sets.push('status = ?'); params.push(fields.status); }
  if (fields.monthly_value !== undefined) { sets.push('monthly_value = ?'); params.push(fields.monthly_value); }
  if (sets.length === 0) return getProposal(id);
  params.push(id);
  db.prepare(`UPDATE proposals SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getProposal(id);
}

function parseProposalRow(row) {
  if (!row) return null;
  return { ...row, services: row.services ? JSON.parse(row.services) : [] };
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

// --- Inspirations ---

function insertInspiration(data) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO inspirations (source, content, tags, used)
    VALUES (@source, @content, @tags, @used)
  `);
  const result = stmt.run({
    source: data.source || 'manual',
    content: data.content,
    tags: data.tags ? JSON.stringify(data.tags) : null,
    used: data.used || 0
  });
  return getInspiration(result.lastInsertRowid);
}

function getInspiration(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM inspirations WHERE id = ?').get(id);
  return row ? parseInspirationRow(row) : null;
}

function getInspirations({ limit = 100, used } = {}) {
  const db = getDb();
  let sql = 'SELECT * FROM inspirations WHERE 1=1';
  const params = [];
  if (used !== undefined) { sql += ' AND used = ?'; params.push(used ? 1 : 0); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params).map(parseInspirationRow);
}

function markInspirationUsed(id) {
  const db = getDb();
  db.prepare('UPDATE inspirations SET used = 1 WHERE id = ?').run(id);
  return getInspiration(id);
}

function deleteInspiration(id) {
  const db = getDb();
  db.prepare('DELETE FROM inspirations WHERE id = ?').run(id);
}

function parseInspirationRow(row) {
  if (!row) return null;
  return { ...row, tags: row.tags ? JSON.parse(row.tags) : [] };
}

// Auto-populate inspirations from high-value content atoms
function syncAtomsToInspirations() {
  const db = getDb();
  const atoms = db.prepare(`
    SELECT ca.* FROM content_atoms ca
    WHERE ca.type IN ('insight', 'success_story', 'quote')
    AND NOT EXISTS (
      SELECT 1 FROM inspirations i WHERE i.content = ca.content AND i.source = 'meeting'
    )
    ORDER BY ca.created_at DESC LIMIT 50
  `).all();

  let added = 0;
  for (const atom of atoms) {
    insertInspiration({
      source: 'meeting',
      content: atom.content,
      tags: atom.tags ? JSON.parse(atom.tags) : []
    });
    added++;
  }
  return added;
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

function getFeedback({ output_type, output_id, limit = 100 } = {}) {
  const db = getDb();
  let sql = 'SELECT * FROM feedback WHERE 1=1';
  const params = [];
  if (output_type) { sql += ' AND output_type = ?'; params.push(output_type); }
  if (output_id) { sql += ' AND output_id = ?'; params.push(output_id); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}

function getFeedbackSummary() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT output_type,
      COUNT(*) as total,
      SUM(CASE WHEN rating >= 4 THEN 1 ELSE 0 END) as positive,
      SUM(CASE WHEN rating <= 2 THEN 1 ELSE 0 END) as negative,
      ROUND(AVG(rating), 1) as avg_rating
    FROM feedback
    GROUP BY output_type
  `).all();
  return rows;
}

function upsertStyleGuide(category, guideText, basedOnCount) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM style_guides WHERE category = ?').get(category);
  if (existing) {
    db.prepare(`UPDATE style_guides SET guide_text = ?, based_on_count = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(guideText, basedOnCount, existing.id);
    return db.prepare('SELECT * FROM style_guides WHERE id = ?').get(existing.id);
  }
  const result = db.prepare(`INSERT INTO style_guides (category, guide_text, based_on_count) VALUES (?, ?, ?)`)
    .run(category, guideText, basedOnCount);
  return db.prepare('SELECT * FROM style_guides WHERE id = ?').get(result.lastInsertRowid);
}

function getStyleGuides() {
  const db = getDb();
  return db.prepare('SELECT * FROM style_guides ORDER BY updated_at DESC').all();
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

function getHealthHistory(clientId, limit = 30) {
  const db = getDb();
  return db.prepare('SELECT * FROM health_snapshots WHERE client_id = ? ORDER BY created_at DESC LIMIT ?').all(clientId, limit);
}

// Compute health for a single client
function computeClientHealth(clientId) {
  const db = getDb();
  const client = getClient(clientId);
  if (!client) return null;

  const now = new Date();
  const daysSince = client.last_seen
    ? Math.floor((now - new Date(client.last_seen)) / 86400000)
    : 999;

  // Open actions for this client
  const openActions = db.prepare("SELECT COUNT(*) as c FROM actions WHERE client_id = ? AND status = 'open'").get(clientId)?.c || 0;

  // Pending proposals
  const pendingProposals = db.prepare("SELECT COUNT(*) as c FROM proposals WHERE client_id = ? AND status = 'draft'").get(clientId)?.c || 0;

  // Latest meeting sentiment
  const latestMeeting = db.prepare(`
    SELECT sentiment, coaching_notes FROM meetings
    WHERE client_name = ? OR client_email = ?
    ORDER BY date DESC LIMIT 1
  `).get(client.name, client.email || '');
  const sentiment = latestMeeting?.sentiment || 'neutral';
  const coachingNotes = latestMeeting?.coaching_notes ? JSON.parse(latestMeeting.coaching_notes) : null;
  const coachingScore = coachingNotes?.score || null;

  // Meeting count
  const meetingCount = db.prepare(`
    SELECT COUNT(*) as c FROM meetings
    WHERE client_name = ? OR client_email = ?
  `).get(client.name, client.email || '')?.c || 0;

  // Health scoring: 0-100
  let score = 100;

  // Days since last contact (biggest factor)
  if (daysSince >= 14) score -= 50;
  else if (daysSince >= 10) score -= 35;
  else if (daysSince >= 7) score -= 25;
  else if (daysSince >= 5) score -= 15;
  else if (daysSince >= 3) score -= 5;

  // Overdue actions
  if (openActions >= 3) score -= 15;
  else if (openActions >= 1) score -= 5;

  // Negative sentiment
  if (sentiment === 'negative') score -= 15;
  else if (sentiment === 'mixed') score -= 5;
  else if (sentiment === 'positive') score += 5;

  // Low coaching score
  if (coachingScore !== null && coachingScore < 50) score -= 10;

  // Pending proposals waiting
  if (pendingProposals > 0) score -= 10;

  // Only 1 meeting — still early
  if (meetingCount <= 1) score -= 5;

  score = Math.max(0, Math.min(100, score));

  // Health status
  let health_status;
  if (score >= 70) health_status = 'green';
  else if (score >= 40) health_status = 'yellow';
  else health_status = 'red';

  // Build notes
  const notes = [];
  if (daysSince >= 7) notes.push(`${daysSince} days since last contact`);
  if (openActions > 0) notes.push(`${openActions} open action${openActions > 1 ? 's' : ''}`);
  if (pendingProposals > 0) notes.push(`${pendingProposals} pending proposal${pendingProposals > 1 ? 's' : ''}`);
  if (sentiment === 'negative') notes.push('Last meeting sentiment was negative');
  if (coachingScore !== null && coachingScore < 50) notes.push(`Low coaching score: ${coachingScore}/100`);

  return {
    client_id: clientId,
    client_name: client.name,
    client_email: client.email,
    firm_name: client.firm_name,
    client_status: client.status,
    health_status,
    score,
    days_since_contact: daysSince,
    open_actions: openActions,
    proposal_pending: pendingProposals,
    meeting_count: meetingCount,
    sentiment,
    coaching_score: coachingScore,
    notes: notes.join('; ') || 'Healthy'
  };
}

// Run health check for all clients, snapshot results
function runHealthCheck() {
  const db = getDb();
  const clients = getClients({ limit: 500 });
  const results = [];

  for (const client of clients) {
    const health = computeClientHealth(client.id);
    if (!health) continue;

    // Insert snapshot
    insertHealthSnapshot({
      client_id: client.id,
      health_status: health.health_status,
      days_since_contact: health.days_since_contact,
      proposal_pending: health.proposal_pending,
      notes: health.notes
    });

    results.push(health);
  }

  // Sort: red first, then yellow, then green
  const order = { red: 0, yellow: 1, green: 2 };
  results.sort((a, b) => (order[a.health_status] || 3) - (order[b.health_status] || 3) || a.score - b.score);

  return results;
}

// Get health overview without snapshotting
function getHealthOverview() {
  const clients = getClients({ limit: 500 });
  const results = [];

  for (const client of clients) {
    const health = computeClientHealth(client.id);
    if (health) results.push(health);
  }

  const order = { red: 0, yellow: 1, green: 2 };
  results.sort((a, b) => (order[a.health_status] || 3) - (order[b.health_status] || 3) || a.score - b.score);

  const summary = {
    total: results.length,
    red: results.filter(r => r.health_status === 'red').length,
    yellow: results.filter(r => r.health_status === 'yellow').length,
    green: results.filter(r => r.health_status === 'green').length,
    avg_score: results.length > 0 ? Math.round(results.reduce((s, r) => s + r.score, 0) / results.length) : 0
  };

  return { summary, clients: results };
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
  // Delete in FK-safe order: children first, then parents
  db.exec(`
    DELETE FROM health_snapshots;
    DELETE FROM content_atoms;
    DELETE FROM actions;
    DELETE FROM patterns;
    DELETE FROM proposals;
    DELETE FROM clients;
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

// --- Learned Insights ---

function upsertInsight(category, insight, source, sourceId) {
  const d = getDb();
  const existing = d.prepare('SELECT * FROM learned_insights WHERE category = ? AND insight = ? AND status = ?').get(category, insight, 'active');
  if (existing) {
    d.prepare('UPDATE learned_insights SET frequency = frequency + 1, last_seen = CURRENT_TIMESTAMP, source = ?, source_id = ? WHERE id = ?')
      .run(source || existing.source, sourceId || existing.source_id, existing.id);
    return d.prepare('SELECT * FROM learned_insights WHERE id = ?').get(existing.id);
  }
  const r = d.prepare('INSERT INTO learned_insights (category, insight, source, source_id) VALUES (?, ?, ?, ?)').run(category, insight, source || null, sourceId || null);
  return d.prepare('SELECT * FROM learned_insights WHERE id = ?').get(r.lastInsertRowid);
}

function getInsights({ category, status = 'active', limit = 50 } = {}) {
  const d = getDb();
  let sql = 'SELECT * FROM learned_insights WHERE status = ?';
  const params = [status];
  if (category) { sql += ' AND category = ?'; params.push(category); }
  sql += ' ORDER BY (confidence * frequency) DESC LIMIT ?';
  params.push(limit);
  return d.prepare(sql).all(...params);
}

function updateInsight(id, fields) {
  const d = getDb();
  const sets = [];
  const params = [];
  if (fields.status) { sets.push('status = ?'); params.push(fields.status); }
  if (fields.confidence !== undefined) { sets.push('confidence = ?'); params.push(fields.confidence); }
  if (fields.confirmed_by) { sets.push('confirmed_by = ?'); params.push(fields.confirmed_by); }
  if (sets.length === 0) return;
  params.push(id);
  d.prepare(`UPDATE learned_insights SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

// --- Team Inputs ---

function insertTeamInput(data) {
  const d = getDb();
  const r = d.prepare('INSERT INTO team_inputs (question, answer, asked_by, answered_by, category) VALUES (?, ?, ?, ?, ?)')
    .run(data.question, data.answer || null, data.asked_by || 'system', data.answered_by || null, data.category || null);
  return d.prepare('SELECT * FROM team_inputs WHERE id = ?').get(r.lastInsertRowid);
}

function getTeamInputs({ category, limit = 50, unanswered } = {}) {
  const d = getDb();
  let sql = 'SELECT * FROM team_inputs WHERE 1=1';
  const params = [];
  if (category) { sql += ' AND category = ?'; params.push(category); }
  if (unanswered) { sql += ' AND answer IS NULL'; }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);
  return d.prepare(sql).all(...params);
}

function answerTeamInput(id, answer, answeredBy) {
  const d = getDb();
  d.prepare('UPDATE team_inputs SET answer = ?, answered_by = ?, applied_at = CURRENT_TIMESTAMP WHERE id = ?').run(answer, answeredBy || 'user', id);
  return d.prepare('SELECT * FROM team_inputs WHERE id = ?').get(id);
}

// --- Deal Outcomes ---

function insertDealOutcome(data) {
  const d = getDb();
  const r = d.prepare(`INSERT INTO deal_outcomes (client_id, proposal_id, outcome, monthly_value, close_time_days, loss_reason, what_worked, what_failed, practice_area, source_channel, speed_to_lead_minutes, proposal_delay_days)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(data.client_id || null, data.proposal_id || null, data.outcome, data.monthly_value || null, data.close_time_days || null, data.loss_reason || null, data.what_worked || null, data.what_failed || null, data.practice_area || null, data.source_channel || null, data.speed_to_lead_minutes || null, data.proposal_delay_days || null);
  return d.prepare('SELECT * FROM deal_outcomes WHERE id = ?').get(r.lastInsertRowid);
}

function getDealOutcomes({ outcome, limit = 100 } = {}) {
  const d = getDb();
  let sql = 'SELECT d.*, c.name as client_name, c.firm_name FROM deal_outcomes d LEFT JOIN clients c ON d.client_id = c.id WHERE 1=1';
  const params = [];
  if (outcome) { sql += ' AND d.outcome = ?'; params.push(outcome); }
  sql += ' ORDER BY d.recorded_at DESC LIMIT ?';
  params.push(limit);
  return d.prepare(sql).all(...params);
}

// --- Pestering Log ---

function insertPesterEntry(data) {
  const d = getDb();
  const r = d.prepare(`INSERT INTO pestering_log (client_id, stage, channel, message_type, content, status, scheduled_for)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(data.client_id, data.stage, data.channel, data.message_type || null, data.content || null, data.status || 'pending', data.scheduled_for || null);
  return d.prepare('SELECT * FROM pestering_log WHERE id = ?').get(r.lastInsertRowid);
}

function getPesterEntries({ client_id, status, due_before, limit = 100 } = {}) {
  const d = getDb();
  let sql = 'SELECT p.*, c.name as client_name, c.firm_name FROM pestering_log p LEFT JOIN clients c ON p.client_id = c.id WHERE 1=1';
  const params = [];
  if (client_id) { sql += ' AND p.client_id = ?'; params.push(client_id); }
  if (status) { sql += ' AND p.status = ?'; params.push(status); }
  if (due_before) { sql += ' AND p.scheduled_for <= ?'; params.push(due_before); }
  sql += ' ORDER BY p.scheduled_for ASC LIMIT ?';
  params.push(limit);
  return d.prepare(sql).all(...params);
}

function updatePesterEntry(id, fields) {
  const d = getDb();
  const sets = [];
  const params = [];
  if (fields.status) { sets.push('status = ?'); params.push(fields.status); }
  if (fields.sent_at) { sets.push('sent_at = ?'); params.push(fields.sent_at); }
  if (fields.content) { sets.push('content = ?'); params.push(fields.content); }
  if (sets.length === 0) return;
  params.push(id);
  d.prepare(`UPDATE pestering_log SET ${sets.join(', ')} WHERE id = ?`).run(...params);
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

// --- Error Log ---

function logError(source, errorType, message, details) {
  const db = getDb();
  db.prepare(`INSERT INTO error_log (source, error_type, message, details) VALUES (?, ?, ?, ?)`)
    .run(source, errorType || 'unknown', String(message).slice(0, 2000), details ? JSON.stringify(details).slice(0, 5000) : null);
}

function getErrors({ limit = 50, source } = {}) {
  const db = getDb();
  if (source) {
    return db.prepare('SELECT * FROM error_log WHERE source = ? ORDER BY created_at DESC LIMIT ?').all(source, limit);
  }
  return db.prepare('SELECT * FROM error_log ORDER BY created_at DESC LIMIT ?').all(limit);
}

function getErrorCounts() {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as c FROM error_log').get().c;
  const lastHour = db.prepare("SELECT COUNT(*) as c FROM error_log WHERE created_at > datetime('now', '-1 hour')").get().c;
  const last24h = db.prepare("SELECT COUNT(*) as c FROM error_log WHERE created_at > datetime('now', '-24 hours')").get().c;
  return { total, lastHour, last24h };
}

module.exports = {
  getDb, initDb,
  insertMeeting, getMeeting, getMeetings, updateMeeting, searchMeetings,
  insertClient, getClient, getClients, upsertClient,
  insertProposal, getProposal, getProposals, updateProposal,
  insertAction, getActions, updateAction,
  insertAtom, getAtoms,
  insertPattern, upsertPattern, getPatterns,
  insertInspiration, getInspiration, getInspirations, markInspirationUsed, deleteInspiration, syncAtomsToInspirations,
  insertEvent, getEvents,
  insertFeedback, getFeedback, getFeedbackSummary,
  upsertStyleGuide, getStyleGuides,
  insertHealthSnapshot, getLatestHealth, getHealthHistory,
  computeClientHealth, runHealthCheck, getHealthOverview,
  insertChatMessage, getChatMessages,
  upsertInsight, getInsights, updateInsight,
  insertTeamInput, getTeamInputs, answerTeamInput,
  insertDealOutcome, getDealOutcomes,
  insertPesterEntry, getPesterEntries, updatePesterEntry,
  clearDerivedData, getUnprocessedMeetings,
  logError, getErrors, getErrorCounts,
  getStats
};
