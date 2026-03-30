const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const {
  getDb, insertCall, updateCallTranscript, updateCallSummary,
  getCall, getAllCalls, serializeCall
} = require('../database');

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

// POST /api/calls/upload
router.post('/upload', upload.single('audio'), async (req, res) => {
  try {
    const {
      employee_name, distributor_name, direction,
      duration_seconds, recorded_at, cli, did
    } = req.body;

    if (!direction) {
      return res.status(400).json({ error: 'direction is required' });
    }

    const validDirections = ['Inbound', 'Outbound', 'Missed'];
    if (!validDirections.includes(direction)) {
      return res.status(400).json({ error: 'direction must be Inbound, Outbound, or Missed' });
    }

    const audioFilePath = req.file ? req.file.path : null;

    const id = insertCall({
      employee_name: employee_name || null,
      distributor_name: distributor_name || null,
      direction,
      duration_seconds: parseInt(duration_seconds) || 0,
      recorded_at: recorded_at || new Date().toISOString(),
      audio_file_path: audioFilePath,
      cli: cli || null,
      did: did || null,
      sync_status: 'pending'
    });

    if (id) {
      // Update audio_file_path via raw update since insertCall doesn't set it
      if (audioFilePath) {
        getDb().prepare('UPDATE calls SET audio_file_path = ? WHERE id = ?').run(audioFilePath, id);
      }
    }

    const call = getCall(id);

    // Kick off pipeline async
    if (audioFilePath) {
      const { processCall } = require('../server');
      processCall(call.id).catch(err => {
        console.error(`Background pipeline failed for call ${call.id}:`, err.message);
      });
    }

    res.status(201).json(call);
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/calls/transcribe/:id
router.post('/transcribe/:id', async (req, res) => {
  try {
    const call = getCall(req.params.id);
    if (!call) return res.status(404).json({ error: 'Call not found' });
    if (!call.audio_file_path) return res.status(400).json({ error: 'No audio file for this call' });

    const transcript = await runTranscription(call.audio_file_path);
    updateCallTranscript(call.id, transcript);

    res.json({ id: call.id, transcript });
  } catch (err) {
    console.error('Transcribe error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/calls/summarise/:id
router.post('/summarise/:id', async (req, res) => {
  try {
    const call = getCall(req.params.id);
    if (!call) return res.status(404).json({ error: 'Call not found' });
    if (!call.transcript) return res.status(400).json({ error: 'No transcript. Transcribe first.' });

    const analysis = await runSummarisation(call.transcript, {
      agentName: call.employee_name,
      direction: call.direction,
      duration: call.duration_seconds
    });

    updateCallSummary(
      call.id,
      analysis.summary,
      analysis.topics,
      analysis.action_items,
      analysis.flagged,
      analysis.flag_reason
    );

    res.json(getCall(call.id));
  } catch (err) {
    console.error('Summarise error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/calls
router.get('/', (req, res) => {
  try {
    res.json(getAllCalls(req.query));
  } catch (err) {
    console.error('List calls error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/calls/:id
router.get('/:id', (req, res) => {
  try {
    const call = getCall(req.params.id);
    if (!call) return res.status(404).json({ error: 'Call not found' });
    res.json(call);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Internal helpers ──────────────────────────────────────────────────────────

async function runTranscription(filePath) {
  const Groq = require('groq-sdk');
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

  const transcription = await groq.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: 'whisper-large-v3',
    language: 'ur',
    response_format: 'text'
  });

  return typeof transcription === 'string' ? transcription : transcription.text;
}

async function runSummarisation(transcript, callMeta = {}) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `You are analysing a Pakistani B2B sales call.
Agent: ${callMeta.agentName || 'Unknown'}
Direction: ${callMeta.direction || 'Unknown'}
Duration: ${callMeta.duration || 0} seconds

Transcript:
${transcript}

Return ONLY a valid JSON object with these exact fields:
{
  "summary": "2-3 sentence summary in English",
  "topics": ["topic1", "topic2", "topic3"],
  "action_items": ["action1", "action2"],
  "flagged": true or false,
  "flag_reason": "reason if flagged, null if not"
}

Flag if: complaint, competitor mentioned, payment issue, delivery problem, angry customer, urgent follow-up needed.

Return only JSON. No markdown. No explanation.`
    }]
  });

  const raw = message.content[0].text.trim();
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  return JSON.parse(cleaned);
}

// POST /api/calls/import
// Bulk import raw Intellicon call objects sent from the browser bookmarklet
router.post('/import', async (req, res) => {
  try {
    const { calls: rawCalls } = req.body;
    if (!Array.isArray(rawCalls) || rawCalls.length === 0) {
      return res.status(400).json({ error: 'No calls provided' });
    }

    const db = getDb();
    let synced = 0, skipped = 0;
    const newCalls = [];

    for (const raw of rawCalls) {
      const interactionId = raw.interactionId || raw.interaction_id || raw.id || raw._id;
      if (!interactionId) { skipped++; continue; }

      const existing = db.prepare('SELECT id FROM calls WHERE interaction_id = ?').get(String(interactionId));
      if (existing) { skipped++; continue; }

      // Normalise fields
      const cli = raw.cli || raw.callerNumber || raw.caller || raw.from || raw.ani || null;
      const did = raw.did || raw.to || raw.dnis || null;
      const direction = (() => {
        const d = String(raw.direction || raw.callDirection || 'inbound').toLowerCase();
        if (d.includes('out')) return 'Outbound';
        if (d.includes('miss')) return 'Missed';
        return 'Inbound';
      })();
      const recordedAt = raw.createdAt || raw.created_at || raw.startTime || new Date().toISOString();

      // Build recording URL from confirmed pattern
      const date = new Date(recordedAt);
      const yyyy = date.getFullYear();
      const mm = String(date.getMonth() + 1).padStart(2, '0');
      const dd = String(date.getDate()).padStart(2, '0');
      const dirLower = direction.toLowerCase();
      const recordingUrl = raw.recordingUrl || raw.recording_url || raw.audioUrl ||
        `/intellicon/sounds/recording/${yyyy}/${mm}/${dd}/${dirLower}-${cli}-${interactionId}`;

      const stmt = db.prepare(`
        INSERT OR IGNORE INTO calls
          (interaction_id, employee_name, agent_id, distributor_name, cli, did,
           direction, queue_name, duration_seconds, recorded_at, sync_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'bookmarklet')
      `);

      const result = stmt.run(
        String(interactionId),
        raw.agentName || raw.agent_name || raw.agentFullName || null,
        raw.agentId || raw.agent_id || null,
        null,
        cli, did, direction,
        raw.queueName || raw.queue_name || null,
        parseInt(raw.duration || raw.totalDuration || raw.billDuration || 0),
        new Date(recordedAt).toISOString()
      );

      if (result.lastInsertRowid) {
        synced++;
        newCalls.push({ id: result.lastInsertRowid, interactionId: String(interactionId), recordingUrl });
      } else {
        skipped++;
      }
    }

    res.json({ synced, skipped, newCalls });
  } catch (err) {
    console.error('Import error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/calls/recording
// Receive a recording uploaded from the browser bookmarklet, then run AI pipeline
router.post('/recording', upload.single('audio'), async (req, res) => {
  try {
    const { interaction_id } = req.body;
    if (!interaction_id) return res.status(400).json({ error: 'interaction_id required' });
    if (!req.file) return res.status(400).json({ error: 'audio file required' });

    const db = getDb();
    const call = db.prepare('SELECT * FROM calls WHERE interaction_id = ?').get(interaction_id);
    if (!call) return res.status(404).json({ error: 'Call not found. Import metadata first.' });

    db.prepare('UPDATE calls SET audio_file_path = ? WHERE id = ?').run(req.file.path, call.id);

    // Run AI pipeline in background
    const { processCall } = require('../server');
    processCall(call.id).catch(err => {
      console.error(`[Bookmarklet] Pipeline failed for call ${call.id}:`, err.message);
    });

    res.json({ success: true, call_id: call.id, message: 'Recording received, AI processing started' });
  } catch (err) {
    console.error('Recording upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.runTranscription = runTranscription;
module.exports.runSummarisation = runSummarisation;
