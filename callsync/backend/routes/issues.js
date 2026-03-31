const express = require('express');
const router = express.Router();
const { getDb } = require('../database');
const Anthropic = require('@anthropic-ai/sdk');

// In-memory job state — survives the HTTP timeout since it runs in the same Node process
const job = { running: false, error: null, result: null, startedAt: null };

async function runAnalysisJob() {
  const db = getDb();

  const calls = db.prepare(`
    SELECT id, employee_name, distributor_name, customer_name, order_number,
           transcript, summary, topics, flagged, flag_reason, recorded_at
    FROM calls
    WHERE (summary IS NOT NULL AND summary != '')
       OR (transcript IS NOT NULL AND transcript != '')
    ORDER BY recorded_at DESC
    LIMIT 50
  `).all();

  if (calls.length === 0) {
    throw new Error('No analysed calls found. Import calls with recordings first, then wait for AI processing to complete.');
  }

  const callList = calls.map(c => {
    const content = c.summary
      ? `Summary: ${c.summary}${c.topics ? `\nTopics: ${c.topics}` : ''}${c.flag_reason ? `\nFlagged: ${c.flag_reason}` : ''}`
      : c.transcript;
    const customer = c.customer_name || c.distributor_name || 'Unknown';
    const order = c.order_number ? ` | Order: ${c.order_number}` : '';
    return `Call ID ${c.id} (Agent: ${c.employee_name || 'Unknown'} | Customer: ${customer}${order}):\n${content}`;
  }).join('\n\n---\n\n');

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `You are analysing a set of Pakistani B2B sales call transcripts for a foam manufacturer.

Your task: identify recurring ISSUE CATEGORIES across these calls, then map each call to the relevant issue(s).

Focus on problems, complaints, and recurring patterns — not just topics. Examples of issue categories:
- Warranty / Quality Complaint
- Late or Failed Delivery
- Payment Dispute or Overdue Invoice
- Competitor Threat
- Pricing Disagreement
- Stock / Availability Problem

Calls to analyse:
${callList}

Return a JSON object with exactly this structure:
{
  "issue_types": [
    {
      "name": "Short category name (3-5 words)",
      "description": "One sentence explaining what this issue is",
      "suggested_resolution": "One sentence suggesting how to resolve this type of issue",
      "call_ids": [1, 2, 3],
      "details_per_call": {
        "1": "Customer: [name or Unknown] | Order: [number or N/A] | [1-2 sentence description of the specific issue in this call]",
        "2": "Customer: [name or Unknown] | Order: [number or N/A] | [description]"
      }
    }
  ]
}

Rules:
- Only create a category if it appears in at least 1 call
- A call can belong to multiple issue categories
- Keep category names concise and consistent
- Return only valid JSON, no other text`
    }]
  });

  const raw = message.content[0].text.trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude returned no valid JSON');
  const parsed = JSON.parse(jsonMatch[0]);

  db.prepare('DELETE FROM call_issue_links').run();
  db.prepare('DELETE FROM issue_types').run();

  const insertIssue = db.prepare(`INSERT INTO issue_types (name, description, resolution) VALUES (?, ?, ?)`);
  const insertLink  = db.prepare(`INSERT INTO call_issue_links (call_id, issue_type_id, details) VALUES (?, ?, ?)`);

  db.transaction(() => {
    for (const issue of parsed.issue_types) {
      const { lastInsertRowid: issueId } = insertIssue.run(issue.name, issue.description || null, issue.suggested_resolution || null);
      for (const callId of (issue.call_ids || [])) {
        const detail = (issue.details_per_call || {})[String(callId)] || null;
        try { insertLink.run(callId, issueId, detail); } catch (_) {}
      }
    }
  })();

  return { issue_count: parsed.issue_types.length, calls_analysed: calls.length };
}

// POST /api/issues/analyze — starts job in background, returns immediately
router.post('/analyze', (req, res) => {
  if (job.running) {
    return res.json({ status: 'running', startedAt: job.startedAt });
  }

  job.running = true;
  job.error   = null;
  job.result  = null;
  job.startedAt = new Date().toISOString();

  // Fire and forget — runs after response is sent
  runAnalysisJob()
    .then(result => { job.result = result; })
    .catch(err   => { job.error  = err.message; console.error('Issues analyze error:', err); })
    .finally(()  => { job.running = false; });

  res.json({ status: 'started', startedAt: job.startedAt });
});

// GET /api/issues/analyze/status — poll this to check job progress
router.get('/analyze/status', (req, res) => {
  if (job.running) return res.json({ status: 'running', startedAt: job.startedAt });
  if (job.error)   return res.json({ status: 'error',   error: job.error });
  if (job.result)  return res.json({ status: 'done',    ...job.result });
  res.json({ status: 'idle' });
});

// GET /api/issues
// Return all issue types with call counts and linked call summaries
router.get('/', (req, res) => {
  try {
    const db = getDb();

    const issues = db.prepare(`
      SELECT
        it.id, it.name, it.description, it.resolution, it.status,
        it.created_at, it.updated_at,
        COUNT(cil.id) AS call_count
      FROM issue_types it
      LEFT JOIN call_issue_links cil ON cil.issue_type_id = it.id
      GROUP BY it.id
      ORDER BY call_count DESC, it.created_at ASC
    `).all();

    // Linked calls with customer/order details
    const getLinks = db.prepare(`
      SELECT
        c.id, c.employee_name, c.distributor_name, c.recorded_at,
        c.direction, c.summary, c.flagged,
        c.customer_name, c.order_number,
        cil.details
      FROM call_issue_links cil
      JOIN calls c ON c.id = cil.call_id
      WHERE cil.issue_type_id = ?
      ORDER BY c.recorded_at DESC
    `);

    // Per-issue agent breakdown
    const getAgentBreakdown = db.prepare(`
      SELECT
        c.employee_name AS agent_name,
        COUNT(*) AS call_count,
        MAX(c.recorded_at) AS last_seen
      FROM call_issue_links cil
      JOIN calls c ON c.id = cil.call_id
      WHERE cil.issue_type_id = ? AND c.employee_name IS NOT NULL
      GROUP BY c.employee_name
      ORDER BY call_count DESC
    `);

    const result = issues.map(issue => ({
      ...issue,
      agents: getAgentBreakdown.all(issue.id),
      calls: getLinks.all(issue.id)
    }));

    res.json(result);
  } catch (err) {
    console.error('Issues GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/issues/:id
// Update resolution text and/or status
router.patch('/:id', (req, res) => {
  try {
    const db = getDb();
    const { resolution, status } = req.body;
    const { id } = req.params;

    const issue = db.prepare('SELECT id FROM issue_types WHERE id = ?').get(id);
    if (!issue) return res.status(404).json({ error: 'Issue not found' });

    const fields = [];
    const values = [];
    if (resolution !== undefined) { fields.push('resolution = ?'); values.push(resolution); }
    if (status !== undefined) { fields.push('status = ?'); values.push(status); }
    if (fields.length === 0) return res.status(400).json({ error: 'Nothing to update' });

    fields.push("updated_at = datetime('now')");
    values.push(id);

    db.prepare(`UPDATE issue_types SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    const updated = db.prepare('SELECT * FROM issue_types WHERE id = ?').get(id);
    res.json(updated);
  } catch (err) {
    console.error('Issues PATCH error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
