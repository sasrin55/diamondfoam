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

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_name TEXT NOT NULL,
      distributor_name TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('Inbound', 'Outbound', 'Missed')),
      duration_seconds INTEGER DEFAULT 0,
      recorded_at TEXT,
      audio_file_path TEXT,
      transcript TEXT,
      summary TEXT,
      topics TEXT DEFAULT '[]',
      action_items TEXT DEFAULT '[]',
      flagged INTEGER DEFAULT 0,
      flag_reason TEXT,
      created_at TEXT DEFAULT (datetime('now'))
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
}

module.exports = { getDb };
