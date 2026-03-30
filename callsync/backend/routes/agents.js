const express = require('express');
const router = express.Router();
const { getDb } = require('../database');

// GET /api/agents/issues
// Returns all agents with their issue breakdown
router.get('/issues', (req, res) => {
  try {
    const db = getDb();

    const agents = db.prepare(`
      SELECT
        c.employee_name AS agent_name,
        COUNT(DISTINCT c.id) AS total_calls,
        COUNT(DISTINCT cil.issue_type_id) AS issue_type_count
      FROM calls c
      LEFT JOIN call_issue_links cil ON cil.call_id = c.id
      WHERE c.employee_name IS NOT NULL
      GROUP BY c.employee_name
      ORDER BY issue_type_count DESC, total_calls DESC
    `).all();

    const getIssues = db.prepare(`
      SELECT it.id, it.name, it.status, COUNT(*) AS call_count
      FROM call_issue_links cil
      JOIN calls c ON c.id = cil.call_id
      JOIN issue_types it ON it.id = cil.issue_type_id
      WHERE c.employee_name = ?
      GROUP BY it.id
      ORDER BY call_count DESC
    `);

    const result = agents.map(agent => ({
      ...agent,
      issues: getIssues.all(agent.agent_name)
    }));

    res.json(result);
  } catch (err) {
    console.error('Agents issues error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
