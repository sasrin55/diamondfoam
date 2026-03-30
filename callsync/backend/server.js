require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');

const {
  getDb, insertCall, updateCallTranscript, updateCallSummary,
  getCall, logSync, getLastSync, serializeCall
} = require('./database');

const app = express();
const PORT = process.env.PORT || 3001;

// Ensure uploads directory exists
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, '../frontend')));

// Routes
app.use('/api/calls', require('./routes/calls'));
app.use('/api/stats', require('./routes/stats'));
app.use('/api/intellicon', require('./routes/intellicon'));
app.use('/api/issues', require('./routes/issues'));

// ── Pipeline ─────────────────────────────────────────────────────────────────

async function processCall(callId) {
  const { runTranscription, runSummarisation } = require('./routes/calls');
  const call = getCall(callId);
  if (!call) { console.log(`[Pipeline] Call ${callId} not found`); return null; }
  if (!call.audio_file_path) {
    console.log(`[Pipeline] Call ${callId} has no audio file, skipping`);
    return call;
  }

  console.log(`[Pipeline] Processing call ${callId}...`);

  try {
    console.log(`[Pipeline] Transcribing call ${callId}...`);
    const transcript = await runTranscription(call.audio_file_path);
    updateCallTranscript(callId, transcript);
    console.log(`[Pipeline] Transcript saved for call ${callId}`);

    console.log(`[Pipeline] Summarising call ${callId}...`);
    const analysis = await runSummarisation(transcript, {
      agentName: call.employee_name,
      direction: call.direction,
      duration: call.duration_seconds
    });

    updateCallSummary(
      callId,
      analysis.summary,
      analysis.topics,
      analysis.action_items,
      analysis.flagged,
      analysis.flag_reason
    );
    console.log(`[Pipeline] Summary saved for call ${callId}`);

    return getCall(callId);
  } catch (err) {
    console.error(`[Pipeline] Error processing call ${callId}:`, err.message);
    getDb().prepare("UPDATE calls SET sync_status = 'error' WHERE id = ?").run(callId);
    throw err;
  }
}

// ── Intellicon Sync ──────────────────────────────────────────────────────────

let intelliconClient = null;

async function runIntelliconSync() {
  if (!process.env.INTELLICON_EMAIL || !process.env.INTELLICON_PASSWORD) {
    console.log('[Sync] Intellicon credentials not configured, skipping sync');
    return { synced: 0, skipped: 0, failed: 0, status: 'not_configured' };
  }

  console.log('[Sync] Starting Intellicon sync...');
  const IntelliconClient = require('./intellicon');
  const client = new IntelliconClient();

  const loginResult = await client.login();
  if (!loginResult.success) {
    const result = { synced: 0, skipped: 0, failed: 0, status: 'login_failed', error: loginResult.error };
    logSync(result);
    return result;
  }

  let synced = 0, skipped = 0, failed = 0;

  try {
    const calls = await client.fetchAllCalls(7);
    console.log(`[Sync] Processing ${calls.length} calls...`);

    for (const rawCall of calls) {
      const interactionId = rawCall.interactionId || rawCall.interaction_id || rawCall.id;
      if (!interactionId) { skipped++; continue; }

      // Skip if already in DB
      const existing = getDb()
        .prepare('SELECT id FROM calls WHERE interaction_id = ?')
        .get(String(interactionId));

      if (existing) { skipped++; continue; }

      try {
        // Normalise call fields
        const callData = {
          interaction_id: String(interactionId),
          employee_name: rawCall.agentName || rawCall.agent_name || null,
          agent_id: rawCall.agentId || rawCall.agent_id || null,
          cli: rawCall.cli || rawCall.callerNumber || rawCall.from || null,
          did: rawCall.did || rawCall.to || null,
          direction: rawCall.direction || 'Inbound',
          queue_name: rawCall.queueName || rawCall.queue_name || null,
          duration_seconds: parseInt(rawCall.duration || rawCall.totalDuration || rawCall.billDuration || 0),
          recorded_at: rawCall.createdAt || rawCall.created_at || rawCall.startTime || new Date().toISOString(),
          sync_status: 'synced'
        };

        const id = insertCall(callData);
        if (!id) { skipped++; continue; }

        // Download recording
        const filePath = await client.downloadRecording(rawCall, UPLOADS_DIR);
        if (filePath) {
          getDb().prepare('UPDATE calls SET audio_file_path = ? WHERE id = ?').run(filePath, id);
          // Run AI pipeline in background
          processCall(id).catch(err => {
            console.error(`[Sync] Pipeline failed for call ${id}:`, err.message);
          });
        }

        synced++;
      } catch (err) {
        console.error(`[Sync] Failed to process call ${interactionId}:`, err.message);
        failed++;
      }
    }
  } catch (err) {
    console.error('[Sync] Error during sync:', err.message);
    const result = { synced, skipped, failed, status: 'error', error: err.message };
    logSync(result);
    return result;
  }

  const result = { synced, skipped, failed, status: 'ok' };
  logSync(result);
  console.log(`[Sync] Done. Synced: ${synced}, Skipped: ${skipped}, Failed: ${failed}`);
  return result;
}

// ── WebSocket Real-Time Listener ─────────────────────────────────────────────

async function startIntelliconListener() {
  if (!process.env.INTELLICON_EMAIL || !process.env.INTELLICON_PASSWORD) {
    console.log('[WS] Intellicon credentials not set, skipping WebSocket connection');
    return;
  }

  const IntelliconClient = require('./intellicon');
  intelliconClient = new IntelliconClient();

  const loginResult = await intelliconClient.login();
  if (!loginResult.success) {
    console.log('[WS] Login failed, WebSocket not started');
    return;
  }

  intelliconClient.connectWebSocket(async (eventData) => {
    console.log('[WS] Call complete event received');
    // Wait 10 seconds for recording to be ready
    setTimeout(async () => {
      try {
        const interactionId = eventData.interactionId || eventData.interaction_id || eventData.id;
        if (!interactionId) return;

        const existing = getDb()
          .prepare('SELECT id FROM calls WHERE interaction_id = ?')
          .get(String(interactionId));

        if (existing) {
          console.log(`[WS] Call ${interactionId} already in DB`);
          return;
        }

        const callData = {
          interaction_id: String(interactionId),
          employee_name: eventData.agentName || null,
          agent_id: eventData.agentId || null,
          cli: eventData.cli || null,
          did: eventData.did || null,
          direction: eventData.direction || 'Inbound',
          queue_name: eventData.queueName || null,
          duration_seconds: parseInt(eventData.duration || eventData.totalDuration || 0),
          recorded_at: eventData.createdAt || new Date().toISOString(),
          sync_status: 'realtime'
        };

        const id = insertCall(callData);
        if (id) {
          const filePath = await intelliconClient.downloadRecording(eventData, UPLOADS_DIR);
          if (filePath) {
            getDb().prepare('UPDATE calls SET audio_file_path = ? WHERE id = ?').run(filePath, id);
            await processCall(id);
            console.log(`[WS] Real-time: processed call ${id}`);
          }
        }
      } catch (err) {
        console.error('[WS] Error processing real-time call:', err.message);
      }
    }, 10000);
  });
}

// ── Seed Endpoint ─────────────────────────────────────────────────────────────

// Shows Railway's outbound IP — give this to your IT admin to whitelist
app.get('/api/myip', async (req, res) => {
  try {
    const axios = require('axios');
    const r = await axios.get('https://api.ipify.org?format=json', { timeout: 5000 });
    res.json({ outbound_ip: r.data.ip, note: 'Whitelist this IP on diamondgroup.contegris.com firewall' });
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.get('/api/seed', (req, res) => {
  try {
    const db = getDb();
    const existing = db.prepare('SELECT COUNT(*) AS c FROM calls').get();
    if (existing.c > 0) {
      return res.json({ message: `Database already has ${existing.c} calls. Seed skipped.` });
    }

    const seedData = [
      {
        employee_name: 'Usman Khan', distributor_name: 'Ahmed Textile Mills', cli: '03001234567',
        direction: 'Outbound', duration_seconds: 342, recorded_at: '2026-03-20T09:15:00Z',
        transcript: 'Usman called to confirm the latest foam sheet order of 500 units. The distributor requested a 5% discount for bulk purchase. Pricing was discussed and a deal was reached at PKR 1,200 per unit. Delivery scheduled for Friday.',
        summary: 'Usman confirmed a bulk foam order of 500 units with Ahmed Textile Mills at PKR 1,200/unit after negotiating a discount. Delivery is scheduled for Friday.',
        topics: JSON.stringify(['Order confirmed', 'Pricing discussed', 'Bulk discount']),
        action_items: JSON.stringify(['Send invoice by EOD', 'Coordinate Friday delivery']),
        flagged: 0, flag_reason: null, sync_status: 'complete'
      },
      {
        employee_name: 'Sara Ahmed', distributor_name: 'Bilal Foam Traders', cli: '03111234568',
        direction: 'Inbound', duration_seconds: 187, recorded_at: '2026-03-20T10:30:00Z',
        transcript: 'Bilal Foam Traders called to complain about a delayed shipment. They are threatening to cancel future orders if this continues.',
        summary: 'Bilal Foam Traders raised a serious delivery complaint regarding a shipment delayed by over a week. They warned of potential order cancellation.',
        topics: JSON.stringify(['Delivery issue', 'Complaint raised', 'Urgent follow-up needed']),
        action_items: JSON.stringify(['Escalate to logistics immediately', 'Call back with ETA within 2 hours']),
        flagged: 1, flag_reason: 'Delivery complaint and cancellation threat', sync_status: 'complete'
      },
      {
        employee_name: 'Bilal Tariq', distributor_name: 'City Furniture Store', cli: '03211234569',
        direction: 'Outbound', duration_seconds: 456, recorded_at: '2026-03-20T11:00:00Z',
        transcript: 'City Furniture Store is interested in 200 units for their new showroom. They mentioned that Master Foam has offered a better price.',
        summary: 'City Furniture Store considering 200 units for a new showroom. Competitor price mentioned and Bilal countered with a quality pitch.',
        topics: JSON.stringify(['Quotation follow-up', 'Competitor mentioned', 'Large deal']),
        action_items: JSON.stringify(['Send revised quote', 'Prepare quality comparison vs Master Foam']),
        flagged: 1, flag_reason: 'Competitor mentioned: Master Foam', sync_status: 'complete'
      },
      {
        employee_name: 'Nadia Hussain', distributor_name: 'Dawood & Sons', cli: '03001234570',
        direction: 'Inbound', duration_seconds: 523, recorded_at: '2026-03-21T09:00:00Z',
        transcript: 'Dawood and Sons placed a new order for 300 pieces of HR foam. Payment will be done via bank transfer within 3 days.',
        summary: 'Dawood & Sons placed a new order of 300 HR foam pieces. Payment via bank transfer expected within 3 days.',
        topics: JSON.stringify(['New order', 'Sample request', 'Payment terms']),
        action_items: JSON.stringify(['Process order', 'Send foam density samples', 'Follow up on payment']),
        flagged: 0, flag_reason: null, sync_status: 'complete'
      },
      {
        employee_name: 'Kamran Ali', distributor_name: 'Eagle Distributors', cli: '03111234571',
        direction: 'Outbound', duration_seconds: 234, recorded_at: '2026-03-21T10:15:00Z',
        transcript: 'Kamran called Eagle Distributors to check on overdue payment. Invoice from February is still pending at PKR 450,000. The distributor requested a 2 week extension.',
        summary: 'Kamran followed up on a PKR 450,000 overdue invoice from February. Eagle Distributors cited cash flow issues and requested a 2-week extension.',
        topics: JSON.stringify(['Payment issue', 'Overdue invoice', 'Extension requested']),
        action_items: JSON.stringify(['Escalate to accounts', 'Get written commitment']),
        flagged: 1, flag_reason: 'Overdue payment PKR 450,000', sync_status: 'complete'
      },
      {
        employee_name: 'Usman Khan', distributor_name: 'Farooq Interiors', cli: '03211234572',
        direction: 'Outbound', duration_seconds: 612, recorded_at: '2026-03-21T11:30:00Z',
        transcript: 'Long call discussing custom foam cushions for 50 sofas. High density, red fabric cover, 18x18 inch. This could be a large deal worth PKR 2 million.',
        summary: 'Usman discussed a major custom foam cushion order with Farooq Interiors for 50 sofas. Deal potentially worth PKR 2 million.',
        topics: JSON.stringify(['Large deal', 'Custom order', 'Pricing discussed']),
        action_items: JSON.stringify(['Send custom order form', 'Get fabric samples approved', 'Prepare PKR 2M quote']),
        flagged: 0, flag_reason: null, sync_status: 'complete'
      },
      {
        employee_name: 'Sara Ahmed', distributor_name: 'Gulf Home Furnishings', cli: '03001234573',
        direction: 'Inbound', duration_seconds: 145, recorded_at: '2026-03-21T14:00:00Z',
        transcript: 'Gulf Home Furnishings called asking about rebonded foam availability. 200 cubic feet confirmed in stock. PKR 85 per cubic foot.',
        summary: 'Gulf Home Furnishings enquired about rebonded foam and placed a small order for 200 cubic feet at PKR 85/cuft.',
        topics: JSON.stringify(['Stock availability', 'Order confirmed', 'Pricing']),
        action_items: JSON.stringify(['Confirm stock', 'Send proforma invoice']),
        flagged: 0, flag_reason: null, sync_status: 'complete'
      },
      {
        employee_name: 'Bilal Tariq', distributor_name: 'Hussain Mattress Co', cli: '03111234574',
        direction: 'Outbound', duration_seconds: 389, recorded_at: '2026-03-22T09:30:00Z',
        transcript: 'Bilal introduced the new spring mattress line. Distributor was very interested. They want to meet in person next week.',
        summary: 'Bilal introduced the new spring mattress line to Hussain Mattress Co. A meeting has been requested for next week.',
        topics: JSON.stringify(['New product introduction', 'Meeting scheduled']),
        action_items: JSON.stringify(['Schedule meeting', 'Prepare spring mattress samples']),
        flagged: 0, flag_reason: null, sync_status: 'complete'
      },
      {
        employee_name: 'Nadia Hussain', distributor_name: 'Ahmed Textile Mills', cli: '03001234567',
        direction: 'Inbound', duration_seconds: 78, recorded_at: '2026-03-22T10:00:00Z',
        transcript: 'Short call. Ahmed Textile Mills called to confirm delivery address change.',
        summary: 'Ahmed Textile Mills called to update the delivery address for an upcoming shipment.',
        topics: JSON.stringify(['Delivery update', 'Address change']),
        action_items: JSON.stringify(['Update address in system', 'Notify logistics']),
        flagged: 0, flag_reason: null, sync_status: 'complete'
      },
      {
        employee_name: 'Kamran Ali', distributor_name: 'Bilal Foam Traders', cli: '03111234568',
        direction: 'Outbound', duration_seconds: 267, recorded_at: '2026-03-22T11:00:00Z',
        transcript: 'Kamran called to follow up on the complaint. Informed them the delivery will happen tomorrow. Apologised and offered 3% discount.',
        summary: 'Kamran followed up on the earlier delivery complaint and offered a 3% goodwill discount.',
        topics: JSON.stringify(['Complaint resolution', 'Delivery confirmed', 'Goodwill discount']),
        action_items: JSON.stringify(['Confirm driver for morning delivery', 'Apply 3% discount on next invoice']),
        flagged: 0, flag_reason: null, sync_status: 'complete'
      },
      {
        employee_name: 'Usman Khan', distributor_name: 'Dawood & Sons', cli: '03001234570',
        direction: 'Missed', duration_seconds: 0, recorded_at: '2026-03-22T13:00:00Z',
        transcript: null, summary: null,
        topics: JSON.stringify([]),
        action_items: JSON.stringify(['Call back Dawood & Sons']),
        flagged: 0, flag_reason: null, sync_status: 'pending'
      },
      {
        employee_name: 'Sara Ahmed', distributor_name: 'Eagle Distributors', cli: '03111234571',
        direction: 'Outbound', duration_seconds: 434, recorded_at: '2026-03-23T09:00:00Z',
        transcript: 'Sara presented the new latex foam range. Distributor placed a trial order of 50 pieces at PKR 3,500 per piece.',
        summary: 'Sara presented the new latex foam range. Eagle Distributors placed a trial order of 50 pieces at PKR 3,500 each.',
        topics: JSON.stringify(['New product', 'Trial order', 'Pricing']),
        action_items: JSON.stringify(['Process trial order', 'Schedule follow-up in 2 weeks']),
        flagged: 0, flag_reason: null, sync_status: 'complete'
      },
      {
        employee_name: 'Bilal Tariq', distributor_name: 'Farooq Interiors', cli: '03211234572',
        direction: 'Inbound', duration_seconds: 556, recorded_at: '2026-03-23T10:30:00Z',
        transcript: 'Farooq Interiors called urgently. The foam cushions received have defects — not uniform in size. They have a customer event tomorrow and need replacements.',
        summary: 'Farooq Interiors reported urgent quality defects in yesterday\'s delivery. They are threatening to return the entire order.',
        topics: JSON.stringify(['Quality complaint', 'Urgent', 'Return threatened']),
        action_items: JSON.stringify(['Contact QC immediately', 'Arrange urgent replacement', 'Visit distributor']),
        flagged: 1, flag_reason: 'Urgent quality complaint with return threat', sync_status: 'complete'
      },
      {
        employee_name: 'Nadia Hussain', distributor_name: 'City Furniture Store', cli: '03211234569',
        direction: 'Outbound', duration_seconds: 321, recorded_at: '2026-03-23T12:00:00Z',
        transcript: 'City Furniture Store confirmed the 200-unit mattress order. Payment 50% advance, 50% on delivery. Delivery in 10 days.',
        summary: 'City Furniture Store confirmed the 200-unit mattress order with 50% advance payment. Delivery in 10 days.',
        topics: JSON.stringify(['Order confirmed', 'Large deal', 'Payment terms']),
        action_items: JSON.stringify(['Raise advance invoice', 'Schedule production', 'Confirm delivery']),
        flagged: 0, flag_reason: null, sync_status: 'complete'
      },
      {
        employee_name: 'Kamran Ali', distributor_name: 'Gulf Home Furnishings', cli: '03001234573',
        direction: 'Inbound', duration_seconds: 198, recorded_at: '2026-03-24T09:15:00Z',
        transcript: 'Gulf Home Furnishings called to reorder rebonded foam. 400 cubic feet. They mentioned they are also looking at Metro Foam.',
        summary: 'Gulf Home Furnishings placed a repeat order for 400 cubic feet of rebonded foam and mentioned considering Metro Foam.',
        topics: JSON.stringify(['Repeat order', 'Competitor mentioned']),
        action_items: JSON.stringify(['Process order', 'Follow up on Metro Foam consideration']),
        flagged: 1, flag_reason: 'Competitor Metro Foam mentioned', sync_status: 'complete'
      },
      {
        employee_name: 'Usman Khan', distributor_name: 'Hussain Mattress Co', cli: '03111234574',
        direction: 'Outbound', duration_seconds: 487, recorded_at: '2026-03-24T10:30:00Z',
        transcript: 'Hussain Mattress Co has reviewed the spring mattress samples. Ready to place an initial order of 100 units.',
        summary: 'Hussain Mattress Co approved spring mattress samples and confirmed an initial order of 100 units.',
        topics: JSON.stringify(['Order confirmed', 'New product', 'Scaling potential']),
        action_items: JSON.stringify(['Raise order for 100 mattresses', 'Plan capacity for scale-up']),
        flagged: 0, flag_reason: null, sync_status: 'complete'
      },
      {
        employee_name: 'Sara Ahmed', distributor_name: 'Dawood & Sons', cli: '03001234570',
        direction: 'Outbound', duration_seconds: 143, recorded_at: '2026-03-24T11:00:00Z',
        transcript: 'Quick call to confirm payment receipt of PKR 320,000 from Dawood and Sons.',
        summary: 'Payment of PKR 320,000 from Dawood & Sons confirmed. Email receipt to be sent.',
        topics: JSON.stringify(['Payment confirmed', 'Order update']),
        action_items: JSON.stringify(['Send payment receipt via email']),
        flagged: 0, flag_reason: null, sync_status: 'complete'
      },
      {
        employee_name: 'Bilal Tariq', distributor_name: 'Ahmed Textile Mills', cli: '03001234567',
        direction: 'Inbound', duration_seconds: 667, recorded_at: '2026-03-25T09:00:00Z',
        transcript: 'Long planning call for Q2 requirements. 2,000 foam sheets over 3 months. Agreed PKR 1,100 per sheet.',
        summary: 'Ahmed Textile Mills committed to a Q2 contract for 2,000 foam sheets at PKR 1,100 each.',
        topics: JSON.stringify(['Large deal', 'Contract discussion', 'Volume pricing']),
        action_items: JSON.stringify(['Prepare contract', 'Confirm production capacity', 'Schedule signing']),
        flagged: 0, flag_reason: null, sync_status: 'complete'
      },
      {
        employee_name: 'Nadia Hussain', distributor_name: 'Eagle Distributors', cli: '03111234571',
        direction: 'Missed', duration_seconds: 0, recorded_at: '2026-03-25T14:00:00Z',
        transcript: null, summary: null,
        topics: JSON.stringify([]),
        action_items: JSON.stringify(['Call back Eagle Distributors — may be about overdue payment']),
        flagged: 1, flag_reason: 'Missed call from distributor with pending payment issue', sync_status: 'pending'
      },
      {
        employee_name: 'Kamran Ali', distributor_name: 'Farooq Interiors', cli: '03211234572',
        direction: 'Outbound', duration_seconds: 378, recorded_at: '2026-03-26T10:00:00Z',
        transcript: 'Kamran called to follow up after the quality complaint. Replacement cushions delivered. Farooq Interiors satisfied.',
        summary: 'The quality complaint from Farooq Interiors has been fully resolved with replacement cushions delivered on time.',
        topics: JSON.stringify(['Complaint resolution', 'Relationship management', 'Order retention']),
        action_items: JSON.stringify(['Document resolution', 'Send satisfaction follow-up', 'Offer priority service']),
        flagged: 0, flag_reason: null, sync_status: 'complete'
      }
    ];

    const stmt = db.prepare(`
      INSERT INTO calls
        (employee_name, distributor_name, cli, direction, duration_seconds, recorded_at,
         audio_file_path, transcript, summary, topics, action_items, flagged, flag_reason, sync_status)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((rows) => {
      for (const row of rows) {
        stmt.run(
          row.employee_name, row.distributor_name, row.cli,
          row.direction, row.duration_seconds, row.recorded_at,
          row.transcript, row.summary, row.topics, row.action_items,
          row.flagged, row.flag_reason, row.sync_status
        );
      }
    });

    insertMany(seedData);
    res.json({ message: `Seeded ${seedData.length} calls successfully.` });
  } catch (err) {
    console.error('Seed error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Catch-all: serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ── Startup ───────────────────────────────────────────────────────────────────

getDb(); // Init DB and run migrations

app.listen(PORT, async () => {
  console.log(`CallSync server running at http://localhost:${PORT}`);
  console.log(`Seed demo data: http://localhost:${PORT}/api/seed`);

  // Initial Intellicon sync at startup
  if (process.env.INTELLICON_EMAIL && process.env.INTELLICON_PASSWORD) {
    setTimeout(async () => {
      try {
        await startIntelliconListener();
        await runIntelliconSync();
      } catch (err) {
        console.error('[Startup] Intellicon init failed:', err.message);
      }
    }, 3000);
  }

  // Cron: sync today's calls every 5 minutes, full 7-day sync once a day at midnight
  cron.schedule('*/5 * * * *', async () => {
    console.log('[Cron] Running 5-minute sync for today\'s calls...');
    try { await runIntelliconSync(1); } // 1 day = today only, fast
    catch (err) { console.error('[Cron] Sync failed:', err.message); }
  });

  cron.schedule('0 0 * * *', async () => {
    console.log('[Cron] Running nightly full sync (7 days)...');
    try { await runIntelliconSync(7); }
    catch (err) { console.error('[Cron] Full sync failed:', err.message); }
  });
});

// Export for use by routes
module.exports = { processCall, runIntelliconSync, intelliconClient };
