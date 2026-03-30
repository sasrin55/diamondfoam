const express = require('express');
const router = express.Router();
const { getStats } = require('../database');

// GET /api/stats
router.get('/', (req, res) => {
  try {
    res.json(getStats());
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats/processing
// Lightweight breakdown of AI pipeline status for the bookmarklet
router.get('/processing', (req, res) => {
  try {
    const { getDb } = require('../database');
    const row = getDb().prepare(`
      SELECT
        COUNT(*)                                                        AS total,
        COUNT(CASE WHEN summary  IS NOT NULL AND summary  != '' THEN 1 END) AS summarised,
        COUNT(CASE WHEN transcript IS NOT NULL AND transcript != '' THEN 1 END) AS transcribed,
        COUNT(CASE WHEN audio_file_path IS NOT NULL AND (summary IS NULL OR summary = '') THEN 1 END) AS processing,
        COUNT(CASE WHEN audio_file_path IS NULL THEN 1 END)            AS no_audio
      FROM calls
    `).get();
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
