const express = require('express');
const router = express.Router();
const { getLastSync, getRecentSyncs } = require('../database');

// POST /api/intellicon/sync
router.post('/sync', async (req, res) => {
  try {
    const { runIntelliconSync, intelliconClient } = require('../server');
    const result = await runIntelliconSync();
    res.json(result);
  } catch (err) {
    console.error('Intellicon sync error:', err);
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
