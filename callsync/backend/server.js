require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express = require('express');
const cors = require('cors');
const path = require('path');
const { getDb } = require('./database');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve uploaded audio files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Serve frontend
app.use(express.static(path.join(__dirname, '../frontend')));

// Routes
app.use('/api/calls', require('./routes/calls'));
app.use('/api/stats', require('./routes/stats'));
app.use('/api/issues', require('./routes/issues'));

// Seed endpoint — 20 realistic dummy calls
app.get('/api/seed', (req, res) => {
  try {
    const db = getDb();
    const existing = db.prepare('SELECT COUNT(*) AS c FROM calls').get();
    if (existing.c > 0) {
      return res.json({ message: `Database already has ${existing.c} calls. Seed skipped.` });
    }

    const employees = ['Usman Khan', 'Sara Ahmed', 'Bilal Tariq', 'Nadia Hussain', 'Kamran Ali'];
    const distributors = [
      'Ahmed Textile Mills', 'Bilal Foam Traders', 'City Furniture Store',
      'Dawood & Sons', 'Eagle Distributors', 'Farooq Interiors',
      'Gulf Home Furnishings', 'Hussain Mattress Co'
    ];
    const directions = ['Inbound', 'Outbound', 'Missed'];

    const seedData = [
      {
        employee_name: 'Usman Khan', distributor_name: 'Ahmed Textile Mills',
        direction: 'Outbound', duration_seconds: 342,
        recorded_at: '2026-03-20T09:15:00Z',
        transcript: 'Usman called to confirm the latest foam sheet order of 500 units. The distributor requested a 5% discount for bulk purchase. Pricing was discussed and a deal was reached at PKR 1,200 per unit. Delivery scheduled for Friday.',
        summary: 'Usman confirmed a bulk foam order of 500 units with Ahmed Textile Mills at PKR 1,200/unit after negotiating a discount. Delivery is scheduled for Friday this week.',
        topics: JSON.stringify(['Order confirmed', 'Pricing discussed', 'Bulk discount']),
        action_items: JSON.stringify(['Send invoice by EOD', 'Coordinate Friday delivery with logistics']),
        flagged: 0, flag_reason: null
      },
      {
        employee_name: 'Sara Ahmed', distributor_name: 'Bilal Foam Traders',
        direction: 'Inbound', duration_seconds: 187,
        recorded_at: '2026-03-20T10:30:00Z',
        transcript: 'Bilal Foam Traders called to complain about a delayed shipment from last week. The delivery was supposed to arrive Monday but still has not come. They are threatening to cancel future orders if this continues.',
        summary: 'Bilal Foam Traders raised a serious delivery complaint regarding a shipment delayed by over a week. They warned of potential order cancellation if the issue is not resolved immediately.',
        topics: JSON.stringify(['Delivery issue', 'Complaint raised', 'Urgent follow-up needed']),
        action_items: JSON.stringify(['Escalate to logistics team immediately', 'Call back with delivery ETA within 2 hours', 'Offer compensation discount on next order']),
        flagged: 1, flag_reason: 'Delivery complaint and cancellation threat'
      },
      {
        employee_name: 'Bilal Tariq', distributor_name: 'City Furniture Store',
        direction: 'Outbound', duration_seconds: 456,
        recorded_at: '2026-03-20T11:00:00Z',
        transcript: 'Bilal followed up on a pending quotation for premium foam mattresses. City Furniture Store is interested in 200 units for their new showroom. They mentioned that Master Foam has offered a better price. Bilal explained the quality difference and offered a small discount.',
        summary: 'Bilal followed up on a mattress quotation with City Furniture Store who are considering 200 units for a new showroom. A competitor price was mentioned and Bilal countered with a quality pitch and discount offer.',
        topics: JSON.stringify(['Quotation follow-up', 'Competitor mentioned', 'Large deal', 'Pricing discussed']),
        action_items: JSON.stringify(['Send revised quote by tomorrow morning', 'Prepare quality comparison sheet vs Master Foam']),
        flagged: 1, flag_reason: 'Competitor mentioned: Master Foam'
      },
      {
        employee_name: 'Nadia Hussain', distributor_name: 'Dawood & Sons',
        direction: 'Inbound', duration_seconds: 523,
        recorded_at: '2026-03-21T09:00:00Z',
        transcript: 'Dawood and Sons placed a new order for 300 pieces of HR foam. They also asked about new product catalog and requested samples for two new foam densities. Payment will be done via bank transfer within 3 days.',
        summary: 'Dawood & Sons placed a new order of 300 HR foam pieces and requested product samples for two new densities. Payment via bank transfer expected within 3 days.',
        topics: JSON.stringify(['New order', 'Sample request', 'Payment terms']),
        action_items: JSON.stringify(['Process order in system', 'Send foam density samples by courier', 'Follow up on payment after 3 days']),
        flagged: 0, flag_reason: null
      },
      {
        employee_name: 'Kamran Ali', distributor_name: 'Eagle Distributors',
        direction: 'Outbound', duration_seconds: 234,
        recorded_at: '2026-03-21T10:15:00Z',
        transcript: 'Kamran called Eagle Distributors to check on overdue payment. Invoice from February is still pending at PKR 450,000. The distributor said there are cash flow issues and requested a 2 week extension.',
        summary: 'Kamran followed up on a PKR 450,000 overdue invoice from February. Eagle Distributors cited cash flow issues and requested a 2-week payment extension.',
        topics: JSON.stringify(['Payment issue', 'Overdue invoice', 'Payment extension requested']),
        action_items: JSON.stringify(['Escalate to accounts team', 'Get formal payment commitment in writing', 'Review credit limit for this distributor']),
        flagged: 1, flag_reason: 'Overdue payment PKR 450,000 - 2 week extension requested'
      },
      {
        employee_name: 'Usman Khan', distributor_name: 'Farooq Interiors',
        direction: 'Outbound', duration_seconds: 612,
        recorded_at: '2026-03-21T11:30:00Z',
        transcript: 'Long call with Farooq Interiors discussing a new interior design project. They need custom foam cushions for 50 sofas. Specifications discussed: high density, red fabric cover, 18x18 inch size. This could be a large deal worth PKR 2 million.',
        summary: 'Usman discussed a major custom foam cushion order with Farooq Interiors for 50 sofas, including specifications for size, density, and fabric. The deal is potentially worth PKR 2 million.',
        topics: JSON.stringify(['Large deal', 'Custom order', 'Pricing discussed', 'Specifications discussed']),
        action_items: JSON.stringify(['Send custom order form', 'Get fabric samples approved', 'Prepare quote for PKR 2M order', 'Schedule factory visit']),
        flagged: 0, flag_reason: null
      },
      {
        employee_name: 'Sara Ahmed', distributor_name: 'Gulf Home Furnishings',
        direction: 'Inbound', duration_seconds: 145,
        recorded_at: '2026-03-21T14:00:00Z',
        transcript: 'Gulf Home Furnishings called asking about product availability for rebonded foam. Confirmed 200 cubic feet in stock. Price PKR 85 per cubic foot discussed. Small order placed.',
        summary: 'Gulf Home Furnishings enquired about rebonded foam availability and placed a small order for 200 cubic feet at PKR 85 per cubic foot.',
        topics: JSON.stringify(['Stock availability', 'Order confirmed', 'Pricing discussed']),
        action_items: JSON.stringify(['Confirm stock with warehouse', 'Send proforma invoice']),
        flagged: 0, flag_reason: null
      },
      {
        employee_name: 'Bilal Tariq', distributor_name: 'Hussain Mattress Co',
        direction: 'Outbound', duration_seconds: 389,
        recorded_at: '2026-03-22T09:30:00Z',
        transcript: 'Bilal called Hussain Mattress Co to introduce the new spring mattress line. Distributor was very interested and asked about pricing and minimum order quantities. They want to meet in person to see product samples next week.',
        summary: 'Bilal introduced the new spring mattress line to Hussain Mattress Co who showed strong interest. A meeting has been requested for next week to review product samples and finalise terms.',
        topics: JSON.stringify(['New product introduction', 'Meeting scheduled', 'Minimum order quantity']),
        action_items: JSON.stringify(['Schedule meeting for next week', 'Prepare spring mattress samples', 'Send product catalog and price list']),
        flagged: 0, flag_reason: null
      },
      {
        employee_name: 'Nadia Hussain', distributor_name: 'Ahmed Textile Mills',
        direction: 'Inbound', duration_seconds: 78,
        recorded_at: '2026-03-22T10:00:00Z',
        transcript: 'Short call. Ahmed Textile Mills called to confirm delivery address change for upcoming shipment. New address noted.',
        summary: 'Ahmed Textile Mills called to update the delivery address for an upcoming shipment. The new address has been recorded.',
        topics: JSON.stringify(['Delivery update', 'Address change']),
        action_items: JSON.stringify(['Update delivery address in system', 'Notify logistics team']),
        flagged: 0, flag_reason: null
      },
      {
        employee_name: 'Kamran Ali', distributor_name: 'Bilal Foam Traders',
        direction: 'Outbound', duration_seconds: 267,
        recorded_at: '2026-03-22T11:00:00Z',
        transcript: 'Kamran called to follow up on the complaint raised earlier about the delayed shipment. Informed them the delivery will happen tomorrow morning. Apologised and offered 3% discount on next order as goodwill gesture.',
        summary: 'Kamran followed up on the earlier delivery complaint, confirmed delivery for tomorrow morning, and offered a 3% goodwill discount on the next order to resolve the issue.',
        topics: JSON.stringify(['Complaint resolution', 'Delivery confirmed', 'Goodwill discount offered']),
        action_items: JSON.stringify(['Confirm with driver for morning delivery', 'Apply 3% discount on next invoice']),
        flagged: 0, flag_reason: null
      },
      {
        employee_name: 'Usman Khan', distributor_name: 'Dawood & Sons',
        direction: 'Missed', duration_seconds: 0,
        recorded_at: '2026-03-22T13:00:00Z',
        transcript: null,
        summary: null,
        topics: JSON.stringify([]),
        action_items: JSON.stringify(['Call back Dawood & Sons']),
        flagged: 0, flag_reason: null
      },
      {
        employee_name: 'Sara Ahmed', distributor_name: 'Eagle Distributors',
        direction: 'Outbound', duration_seconds: 434,
        recorded_at: '2026-03-23T09:00:00Z',
        transcript: 'Sara called Eagle Distributors to discuss new season product range. Presented new latex foam line. Distributor placed a trial order of 50 pieces to test market response. Price agreed at PKR 3,500 per piece.',
        summary: 'Sara presented the new latex foam range to Eagle Distributors who placed a trial order of 50 pieces at PKR 3,500 each to gauge market response.',
        topics: JSON.stringify(['New product', 'Trial order', 'Pricing discussed']),
        action_items: JSON.stringify(['Process trial order', 'Schedule follow-up after 2 weeks to get feedback']),
        flagged: 0, flag_reason: null
      },
      {
        employee_name: 'Bilal Tariq', distributor_name: 'Farooq Interiors',
        direction: 'Inbound', duration_seconds: 556,
        recorded_at: '2026-03-23T10:30:00Z',
        transcript: 'Farooq Interiors called urgently. The foam cushions received yesterday have defects — some pieces are not uniform in size. They have a customer event tomorrow and need replacements urgently. Threatening to return the whole order.',
        summary: 'Farooq Interiors reported urgent quality defects in yesterday\'s foam cushion delivery with a critical customer event tomorrow. They are threatening to return the entire order and require immediate replacements.',
        topics: JSON.stringify(['Quality complaint', 'Urgent follow-up needed', 'Return threatened', 'Complaint raised']),
        action_items: JSON.stringify(['Contact QC team immediately', 'Arrange urgent replacement dispatch today', 'Send senior team member to visit distributor', 'Document quality issue for root cause analysis']),
        flagged: 1, flag_reason: 'Urgent quality complaint with return threat before customer event'
      },
      {
        employee_name: 'Nadia Hussain', distributor_name: 'City Furniture Store',
        direction: 'Outbound', duration_seconds: 321,
        recorded_at: '2026-03-23T12:00:00Z',
        transcript: 'Nadia called City Furniture Store to follow up on the pending quotation. The store has decided to place the order with DiamondFoam. 200 units confirmed. Payment 50% advance, 50% on delivery. Delivery in 10 days.',
        summary: 'City Furniture Store confirmed the 200-unit mattress order with 50% advance payment. Delivery is expected within 10 days.',
        topics: JSON.stringify(['Order confirmed', 'Large deal', 'Payment terms', 'Delivery timeline']),
        action_items: JSON.stringify(['Raise advance invoice for 50%', 'Schedule production for 200 units', 'Confirm delivery in 10 days']),
        flagged: 0, flag_reason: null
      },
      {
        employee_name: 'Kamran Ali', distributor_name: 'Gulf Home Furnishings',
        direction: 'Inbound', duration_seconds: 198,
        recorded_at: '2026-03-24T09:15:00Z',
        transcript: 'Gulf Home Furnishings called to reorder rebonded foam. Same specs as last order. 400 cubic feet this time. They mentioned they are also looking at Metro Foam for some products.',
        summary: 'Gulf Home Furnishings placed a repeat order for 400 cubic feet of rebonded foam and casually mentioned considering Metro Foam as an alternative supplier.',
        topics: JSON.stringify(['Repeat order', 'Competitor mentioned', 'Stock availability']),
        action_items: JSON.stringify(['Process repeat order', 'Follow up to understand Metro Foam consideration', 'Offer loyalty incentive']),
        flagged: 1, flag_reason: 'Competitor Metro Foam mentioned'
      },
      {
        employee_name: 'Usman Khan', distributor_name: 'Hussain Mattress Co',
        direction: 'Outbound', duration_seconds: 487,
        recorded_at: '2026-03-24T10:30:00Z',
        transcript: 'Follow up call after last week\'s product introduction meeting. Hussain Mattress Co has reviewed the spring mattress samples and is very impressed. Ready to place an initial order of 100 units. Will scale up if market response is good.',
        summary: 'Following a product introduction meeting, Hussain Mattress Co has approved the spring mattress samples and confirmed an initial order of 100 units with plans to scale up based on market performance.',
        topics: JSON.stringify(['Order confirmed', 'New product', 'Scaling potential']),
        action_items: JSON.stringify(['Raise order for 100 spring mattresses', 'Plan capacity for potential scale-up', 'Schedule delivery within 2 weeks']),
        flagged: 0, flag_reason: null
      },
      {
        employee_name: 'Sara Ahmed', distributor_name: 'Dawood & Sons',
        direction: 'Outbound', duration_seconds: 143,
        recorded_at: '2026-03-24T11:00:00Z',
        transcript: 'Quick call to confirm payment receipt of PKR 320,000 from Dawood and Sons for the HR foam order. Payment confirmed. Receipt to be sent by email.',
        summary: 'Payment of PKR 320,000 from Dawood & Sons for the HR foam order has been confirmed. Email receipt to be sent.',
        topics: JSON.stringify(['Payment confirmed', 'Order update']),
        action_items: JSON.stringify(['Send payment receipt via email']),
        flagged: 0, flag_reason: null
      },
      {
        employee_name: 'Bilal Tariq', distributor_name: 'Ahmed Textile Mills',
        direction: 'Inbound', duration_seconds: 667,
        recorded_at: '2026-03-25T09:00:00Z',
        transcript: 'Long planning call with Ahmed Textile Mills for Q2 requirements. They need 2,000 foam sheets over the next 3 months. Discussed special pricing for volume commitment. Agreed on PKR 1,100 per sheet for the contract. Contract to be signed this week.',
        summary: 'Ahmed Textile Mills committed to a Q2 contract for 2,000 foam sheets at PKR 1,100 each — a significant volume deal secured over a 3-month period. Contract signing expected this week.',
        topics: JSON.stringify(['Large deal', 'Contract discussion', 'Volume pricing', 'Q2 planning']),
        action_items: JSON.stringify(['Prepare and send contract document', 'Confirm production capacity for 2000 sheets', 'Schedule contract signing meeting']),
        flagged: 0, flag_reason: null
      },
      {
        employee_name: 'Nadia Hussain', distributor_name: 'Eagle Distributors',
        direction: 'Missed', duration_seconds: 0,
        recorded_at: '2026-03-25T14:00:00Z',
        transcript: null,
        summary: null,
        topics: JSON.stringify([]),
        action_items: JSON.stringify(['Call back Eagle Distributors — may be about overdue payment']),
        flagged: 1, flag_reason: 'Missed call from distributor with pending payment issue'
      },
      {
        employee_name: 'Kamran Ali', distributor_name: 'Farooq Interiors',
        direction: 'Outbound', duration_seconds: 378,
        recorded_at: '2026-03-26T10:00:00Z',
        transcript: 'Kamran called to follow up after the quality complaint. Replacement cushions were delivered and Farooq Interiors is satisfied. They confirmed the customer event went well. Relationship salvaged. They will continue ordering.',
        summary: 'The quality complaint from Farooq Interiors has been fully resolved with replacement cushions delivered on time. The customer event was successful and they have confirmed continued business.',
        topics: JSON.stringify(['Complaint resolution', 'Relationship management', 'Order retention']),
        action_items: JSON.stringify(['Document resolution in CRM', 'Send satisfaction follow-up email', 'Offer priority service for next order']),
        flagged: 0, flag_reason: null
      }
    ];

    const stmt = db.prepare(`
      INSERT INTO calls
        (employee_name, distributor_name, direction, duration_seconds, recorded_at,
         audio_file_path, transcript, summary, topics, action_items, flagged, flag_reason)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((rows) => {
      for (const row of rows) {
        stmt.run(
          row.employee_name, row.distributor_name, row.direction,
          row.duration_seconds, row.recorded_at, row.transcript,
          row.summary, row.topics, row.action_items, row.flagged, row.flag_reason
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

// Init DB on startup
getDb();

app.listen(PORT, () => {
  console.log(`CallSync server running at http://localhost:${PORT}`);
  console.log(`Seed demo data: http://localhost:${PORT}/api/seed`);
  console.log(`Open frontend: http://localhost:${PORT}`);
});
