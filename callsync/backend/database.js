const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'callsync.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function addColumnIfMissing(table, column, definition) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (_) {
    // Column already exists — ignore
  }
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      interaction_id TEXT UNIQUE,
      employee_name TEXT,
      agent_id TEXT,
      distributor_name TEXT,
      cli TEXT,
      did TEXT,
      direction TEXT,
      queue_name TEXT,
      duration_seconds INTEGER DEFAULT 0,
      recorded_at TEXT,
      audio_file_path TEXT,
      transcript TEXT,
      summary TEXT,
      topics TEXT DEFAULT '[]',
      action_items TEXT DEFAULT '[]',
      flagged INTEGER DEFAULT 0,
      flag_reason TEXT,
      sync_status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      synced_at TEXT DEFAULT (datetime('now')),
      calls_synced INTEGER DEFAULT 0,
      calls_skipped INTEGER DEFAULT 0,
      calls_failed INTEGER DEFAULT 0,
      status TEXT
    );

    CREATE TABLE IF NOT EXISTS issue_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      resolution TEXT,
      status TEXT DEFAULT 'open' CHECK(status IN ('open', 'in_progress', 'resolved')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS call_issue_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      call_id INTEGER NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
      issue_type_id INTEGER NOT NULL REFERENCES issue_types(id) ON DELETE CASCADE,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Migrate existing calls table if columns are missing
  const newCols = [
    ['interaction_id', 'TEXT'],
    ['agent_id', 'TEXT'],
    ['cli', 'TEXT'],
    ['did', 'TEXT'],
    ['queue_name', 'TEXT'],
    ['sync_status', "TEXT DEFAULT 'pending'"],
    ['customer_name', 'TEXT'],
    ['order_number', 'TEXT'],
  ];
  for (const [col, def] of newCols) {
    addColumnIfMissing('calls', col, def);
  }
}

// ── Helper functions ──────────────────────────────────────────────────────────

function parseJson(val, fallback = []) {
  if (Array.isArray(val)) return val;
  try { return JSON.parse(val) || fallback; } catch { return fallback; }
}

function serializeCall(row) {
  if (!row) return null;
  return {
    ...row,
    topics: parseJson(row.topics),
    action_items: parseJson(row.action_items),
    flagged: row.flagged === 1 || row.flagged === true
  };
}

function insertCall(call) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO calls
      (interaction_id, employee_name, agent_id, distributor_name, cli, did,
       direction, queue_name, duration_seconds, recorded_at, audio_file_path, sync_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    call.interaction_id || null,
    call.employee_name || call.agentName || null,
    call.agent_id || call.agentId || null,
    call.distributor_name || null,
    call.cli || null,
    call.did || null,
    call.direction || 'Inbound',
    call.queue_name || call.queueName || null,
    parseInt(call.duration_seconds || call.duration || call.totalDuration || 0),
    call.recorded_at || call.createdAt || new Date().toISOString(),
    call.audio_file_path || null,
    call.sync_status || 'pending'
  );
  return result.lastInsertRowid;
}

function updateCallTranscript(id, transcript) {
  getDb().prepare('UPDATE calls SET transcript = ? WHERE id = ?').run(transcript, id);
}

function updateCallSummary(id, summary, topics, actionItems, flagged, flagReason, customerName, orderNumber) {
  getDb().prepare(`
    UPDATE calls SET summary = ?, topics = ?, action_items = ?,
    flagged = ?, flag_reason = ?, customer_name = ?, order_number = ?,
    sync_status = 'complete'
    WHERE id = ?
  `).run(
    summary,
    JSON.stringify(topics || []),
    JSON.stringify(actionItems || []),
    flagged ? 1 : 0,
    flagReason || null,
    customerName || null,
    orderNumber || null,
    id
  );
}

function getCall(id) {
  return serializeCall(getDb().prepare('SELECT * FROM calls WHERE id = ?').get(id));
}

function getAllCalls(filters = {}) {
  const db = getDb();
  let query = 'SELECT * FROM calls WHERE 1=1';
  const params = [];

  if (filters.employee) { query += ' AND employee_name = ?'; params.push(filters.employee); }
  if (filters.direction) { query += ' AND direction = ?'; params.push(filters.direction); }
  if (filters.flagged === 'true' || filters.flagged === true) { query += ' AND flagged = 1'; }
  if (filters.search) {
    query += ' AND (employee_name LIKE ? OR distributor_name LIKE ? OR cli LIKE ? OR transcript LIKE ? OR summary LIKE ?)';
    const like = `%${filters.search}%`;
    params.push(like, like, like, like, like);
  }
  if (filters.date_from) { query += ' AND recorded_at >= ?'; params.push(filters.date_from); }
  if (filters.date_to)   { query += ' AND recorded_at <= ?'; params.push(filters.date_to + 'T23:59:59Z'); }

  query += ' ORDER BY recorded_at DESC';
  if (filters.limit) { query += ' LIMIT ?'; params.push(parseInt(filters.limit)); }
  if (filters.offset) { query += ' OFFSET ?'; params.push(parseInt(filters.offset)); }

  return db.prepare(query).all(...params).map(serializeCall);
}

function getStats() {
  const db = getDb();

  const totals = db.prepare(`
    SELECT
      COUNT(*) AS total_calls,
      ROUND(AVG(CASE WHEN duration_seconds > 0 THEN duration_seconds END), 0) AS avg_duration_seconds,
      COUNT(DISTINCT employee_name) AS total_employees,
      COUNT(DISTINCT COALESCE(cli, distributor_name)) AS total_distributors,
      SUM(flagged) AS flagged_calls,
      COUNT(CASE WHEN date(recorded_at) = date('now') THEN 1 END) AS calls_today
    FROM calls
  `).get();

  const callsByEmployee = db.prepare(`
    SELECT employee_name AS name, COUNT(*) AS count
    FROM calls WHERE employee_name IS NOT NULL
    GROUP BY employee_name ORDER BY count DESC
  `).all();

  const callsByDirection = db.prepare(`
    SELECT direction, COUNT(*) AS count
    FROM calls GROUP BY direction ORDER BY count DESC
  `).all();

  const topCallers = db.prepare(`
    SELECT COALESCE(cli, distributor_name) AS cli, COUNT(*) AS count
    FROM calls WHERE cli IS NOT NULL OR distributor_name IS NOT NULL
    GROUP BY COALESCE(cli, distributor_name) ORDER BY count DESC LIMIT 8
  `).all();

  const callsByDistributor = db.prepare(`
    SELECT distributor_name AS name, COUNT(*) AS count
    FROM calls WHERE distributor_name IS NOT NULL
    GROUP BY distributor_name ORDER BY count DESC LIMIT 8
  `).all();

  return {
    total_calls: totals.total_calls || 0,
    avg_duration_seconds: Math.round(totals.avg_duration_seconds || 0),
    total_employees: totals.total_employees || 0,
    total_distributors: totals.total_distributors || 0,
    flagged_calls: totals.flagged_calls || 0,
    calls_today: totals.calls_today || 0,
    calls_by_employee: callsByEmployee,
    calls_by_direction: callsByDirection,
    top_callers: topCallers,
    calls_by_distributor: callsByDistributor
  };
}

function logSync(result) {
  getDb().prepare(`
    INSERT INTO sync_log (calls_synced, calls_skipped, calls_failed, status)
    VALUES (?, ?, ?, ?)
  `).run(
    result.synced || 0,
    result.skipped || 0,
    result.failed || 0,
    result.status || 'ok'
  );
}

function getLastSync() {
  return getDb().prepare('SELECT * FROM sync_log ORDER BY synced_at DESC LIMIT 1').get();
}

function getRecentSyncs(limit = 5) {
  return getDb().prepare('SELECT * FROM sync_log ORDER BY synced_at DESC LIMIT ?').all(limit);
}

module.exports = {
  getDb, insertCall, updateCallTranscript, updateCallSummary,
  getCall, getAllCalls, getStats, logSync, getLastSync, getRecentSyncs,
  serializeCall
};
