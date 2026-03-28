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

module.exports = router;
