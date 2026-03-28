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

module.exports = router;
module.exports.runTranscription = runTranscription;
module.exports.runSummarisation = runSummarisation;
