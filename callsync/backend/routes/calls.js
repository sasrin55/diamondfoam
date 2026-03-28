const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../database');

// Multer storage config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ts = Date.now();
    const ext = path.extname(file.originalname);
    cb(null, `call_${ts}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowed = ['.mp3', '.wav', '.m4a', '.ogg', '.webm'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) cb(null, true);
  else cb(new Error('Only audio files (mp3, wav, m4a, ogg, webm) are allowed'));
};

const upload = multer({ storage, fileFilter, limits: { fileSize: 100 * 1024 * 1024 } });

// Helper: parse JSON fields safely
function parseJsonField(val, fallback = []) {
  if (Array.isArray(val)) return val;
  try { return JSON.parse(val) || fallback; } catch { return fallback; }
}

// Helper: serialize a row for API response
function serializeCall(row) {
  if (!row) return null;
  return {
    ...row,
    topics: parseJsonField(row.topics),
    action_items: parseJsonField(row.action_items),
    flagged: row.flagged === 1 || row.flagged === true
  };
}

// POST /api/calls/upload
router.post('/upload', upload.single('audio'), async (req, res) => {
  try {
    const { employee_name, distributor_name, direction, duration_seconds, recorded_at } = req.body;

    if (!employee_name || !distributor_name || !direction) {
      return res.status(400).json({ error: 'employee_name, distributor_name, and direction are required' });
    }

    const validDirections = ['Inbound', 'Outbound', 'Missed'];
    if (!validDirections.includes(direction)) {
      return res.status(400).json({ error: 'direction must be Inbound, Outbound, or Missed' });
    }

    const db = getDb();
    const audioFilePath = req.file ? req.file.path : null;

    const stmt = db.prepare(`
      INSERT INTO calls (employee_name, distributor_name, direction, duration_seconds, recorded_at, audio_file_path)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      employee_name,
      distributor_name,
      direction,
      parseInt(duration_seconds) || 0,
      recorded_at || new Date().toISOString(),
      audioFilePath
    );

    const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(result.lastInsertRowid);

    // Kick off transcription + summarisation async (non-blocking)
    if (audioFilePath) {
      transcribeAndSummarise(call.id).catch(err => {
        console.error(`Background processing failed for call ${call.id}:`, err.message);
      });
    }

    res.status(201).json(serializeCall(call));
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/calls/transcribe/:id
router.post('/transcribe/:id', async (req, res) => {
  try {
    const db = getDb();
    const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(req.params.id);
    if (!call) return res.status(404).json({ error: 'Call not found' });
    if (!call.audio_file_path) return res.status(400).json({ error: 'No audio file for this call' });

    const transcript = await runTranscription(call.audio_file_path);
    db.prepare('UPDATE calls SET transcript = ? WHERE id = ?').run(transcript, call.id);

    res.json({ id: call.id, transcript });
  } catch (err) {
    console.error('Transcribe error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/calls/summarise/:id
router.post('/summarise/:id', async (req, res) => {
  try {
    const db = getDb();
    const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(req.params.id);
    if (!call) return res.status(404).json({ error: 'Call not found' });
    if (!call.transcript) return res.status(400).json({ error: 'No transcript available. Transcribe first.' });

    const analysis = await runSummarisation(call.transcript);

    db.prepare(`
      UPDATE calls SET summary = ?, topics = ?, action_items = ?, flagged = ?, flag_reason = ?
      WHERE id = ?
    `).run(
      analysis.summary,
      JSON.stringify(analysis.topics || []),
      JSON.stringify(analysis.action_items || []),
      analysis.flagged ? 1 : 0,
      analysis.flag_reason || null,
      call.id
    );

    const updated = db.prepare('SELECT * FROM calls WHERE id = ?').get(call.id);
    res.json(serializeCall(updated));
  } catch (err) {
    console.error('Summarise error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/calls
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const { employee, direction, flagged, search } = req.query;

    let query = 'SELECT * FROM calls WHERE 1=1';
    const params = [];

    if (employee) {
      query += ' AND employee_name = ?';
      params.push(employee);
    }
    if (direction) {
      query += ' AND direction = ?';
      params.push(direction);
    }
    if (flagged === 'true' || flagged === '1') {
      query += ' AND flagged = 1';
    }
    if (search) {
      query += ' AND (employee_name LIKE ? OR distributor_name LIKE ? OR transcript LIKE ? OR summary LIKE ?)';
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }

    query += ' ORDER BY created_at DESC';

    const rows = db.prepare(query).all(...params);
    res.json(rows.map(serializeCall));
  } catch (err) {
    console.error('List calls error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/calls/:id
router.get('/:id', (req, res) => {
  try {
    const db = getDb();
    const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(req.params.id);
    if (!call) return res.status(404).json({ error: 'Call not found' });
    res.json(serializeCall(call));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Internal helpers

async function transcribeAndSummarise(callId) {
  const db = getDb();
  const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(callId);
  if (!call || !call.audio_file_path) return;

  const transcript = await runTranscription(call.audio_file_path);
  db.prepare('UPDATE calls SET transcript = ? WHERE id = ?').run(transcript, callId);

  const analysis = await runSummarisation(transcript);
  db.prepare(`
    UPDATE calls SET summary = ?, topics = ?, action_items = ?, flagged = ?, flag_reason = ?
    WHERE id = ?
  `).run(
    analysis.summary,
    JSON.stringify(analysis.topics || []),
    JSON.stringify(analysis.action_items || []),
    analysis.flagged ? 1 : 0,
    analysis.flag_reason || null,
    callId
  );
}

async function runTranscription(filePath) {
  const Groq = require('groq-sdk');
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

  const transcription = await groq.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: 'whisper-large-v3',
    language: 'ur'
  });

  return transcription.text;
}

async function runSummarisation(transcript) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `You are analysing a Pakistani B2B sales call between an employee and a distributor.

Transcript: ${transcript}

Return a JSON object with exactly these fields:
{
  "summary": "2-3 sentence summary in English",
  "topics": ["topic1", "topic2"],
  "action_items": ["action1", "action2"],
  "flagged": true/false,
  "flag_reason": "reason if flagged, else null"
}

Flag the call if: complaint raised, competitor mentioned, payment issue, delivery problem, or urgent follow-up needed.

Return only valid JSON, no other text.`
    }]
  });

  const raw = message.content[0].text.trim();
  // Strip markdown code fences if present
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  return JSON.parse(cleaned);
}

module.exports = router;
