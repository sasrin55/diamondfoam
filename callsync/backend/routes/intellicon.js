const express = require('express');
const router = express.Router();
const { getDb, insertCall, getLastSync, getRecentSyncs, logSync } = require('../database');

// GET /api/intellicon/test
// Tests login + one page fetch — returns full debug info
router.get('/test', async (req, res) => {
  try {
    const IntelliconClient = require('../intellicon');
    const client = new IntelliconClient();
    const result = await client.testConnection();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// POST /api/intellicon/sync
router.post('/sync', async (req, res) => {
  if (!process.env.INTELLICON_EMAIL || !process.env.INTELLICON_PASSWORD || !process.env.INTELLICON_BASE_URL) {
    return res.status(400).json({
      error: 'Intellicon not configured. Set INTELLICON_BASE_URL, INTELLICON_EMAIL, INTELLICON_PASSWORD in Railway Variables.'
    });
  }

  try {
    const IntelliconClient = require('../intellicon');
    const client = new IntelliconClient();

    // Login
    const loginResult = await client.login();
    if (!loginResult.success) {
      return res.status(401).json({ error: `Login failed: ${loginResult.error}`, details: loginResult.details });
    }

    // Fetch calls
    const { calls: rawCalls, firstRawSample } = await client.fetchAllCalls(7);

    if (rawCalls.length === 0) {
      logSync({ synced: 0, skipped: 0, failed: 0, status: 'ok' });
      return res.json({
        synced: 0, skipped: 0, failed: 0,
        message: 'Login OK but no calls returned. Check Railway logs for raw response.',
        rawSample: firstRawSample
      });
    }

    const db = getDb();
    let synced = 0, skipped = 0, failed = 0;

    const UPLOADS_DIR = require('path').join(__dirname, '../uploads');

    for (const rawCall of rawCalls) {
      const interactionId = rawCall.interactionId || rawCall.interaction_id || rawCall.id || rawCall._id || rawCall.callId;
      if (!interactionId) { skipped++; continue; }

      const existing = db.prepare('SELECT id FROM calls WHERE interaction_id = ?').get(String(interactionId));
      if (existing) { skipped++; continue; }

      try {
        const callData = client.normalizeCall(rawCall);
        const id = insertCall(callData);
        if (!id) { skipped++; continue; }

        // Download recording in background — don't block sync response
        const { processCall } = require('../server');
        client.downloadRecording(rawCall, UPLOADS_DIR).then(filePath => {
          if (filePath) {
            db.prepare('UPDATE calls SET audio_file_path = ? WHERE id = ?').run(filePath, id);
            processCall(id).catch(err => console.error(`[Sync] Pipeline error for ${id}:`, err.message));
          }
        }).catch(err => console.error(`[Sync] Recording download error:`, err.message));

        synced++;
      } catch (err) {
        console.error(`[Sync] Error inserting call:`, err.message);
        failed++;
      }
    }

    const result = { synced, skipped, failed, status: 'ok', rawSample: firstRawSample };
    logSync(result);
    res.json(result);

  } catch (err) {
    console.error('[Sync] Fatal error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/intellicon/status
router.get('/status', (req, res) => {
  try {
    const lastSync = getLastSync();
    const recentSyncs = getRecentSyncs(5);

    let wsConnected = false;
    try {
      const { intelliconClient } = require('../server');
      wsConnected = intelliconClient ? intelliconClient.isWsConnected() : false;
    } catch (_) {}

    res.json({
      wsConnected,
      lastSync: lastSync || null,
      recentSyncs,
      configured: !!(process.env.INTELLICON_EMAIL && process.env.INTELLICON_PASSWORD && process.env.INTELLICON_BASE_URL)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
