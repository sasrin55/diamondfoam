const express = require('express');
const router = express.Router();
const { getDb } = require('../database');

// GET /api/stats
router.get('/', (req, res) => {
  try {
    const db = getDb();

    const totals = db.prepare(`
      SELECT
        COUNT(*) AS total_calls,
        ROUND(AVG(duration_seconds), 0) AS avg_duration_seconds,
        COUNT(DISTINCT employee_name) AS total_employees,
        COUNT(DISTINCT distributor_name) AS total_distributors,
        SUM(flagged) AS flagged_calls
      FROM calls
    `).get();

    const callsByEmployee = db.prepare(`
      SELECT employee_name AS name, COUNT(*) AS count
      FROM calls
      GROUP BY employee_name
      ORDER BY count DESC
    `).all();

    const callsByDistributor = db.prepare(`
      SELECT distributor_name AS name, COUNT(*) AS count
      FROM calls
      GROUP BY distributor_name
      ORDER BY count DESC
      LIMIT 8
    `).all();

    const callsByDirection = db.prepare(`
      SELECT direction, COUNT(*) AS count
      FROM calls
      GROUP BY direction
      ORDER BY count DESC
    `).all();

    res.json({
      total_calls: totals.total_calls || 0,
      avg_duration_seconds: totals.avg_duration_seconds || 0,
      total_employees: totals.total_employees || 0,
      total_distributors: totals.total_distributors || 0,
      flagged_calls: totals.flagged_calls || 0,
      calls_by_employee: callsByEmployee,
      calls_by_distributor: callsByDistributor,
      calls_by_direction: callsByDirection
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
