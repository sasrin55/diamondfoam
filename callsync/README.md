# CallSync — Call Intelligence Dashboard

AI-powered call analytics for Pakistani B2B sales teams. Transcribes Urdu/English calls via Groq Whisper, then summarises with Claude Haiku to extract topics, action items, and flag urgent issues.

## Quick Start

### 1. Install dependencies
```bash
cd callsync
npm install express better-sqlite3 multer cors dotenv groq-sdk @anthropic-ai/sdk
```

### 2. Configure environment
```bash
cp .env.example .env
```
Edit `.env` and add your API keys:
```
GROQ_API_KEY=your_groq_key_here
ANTHROPIC_API_KEY=your_anthropic_key_here
PORT=3001
```

Get your keys:
- **Groq**: https://console.groq.com — free tier available
- **Anthropic**: https://console.anthropic.com

### 3. Start the server
```bash
node backend/server.js
```

### 4. Open the frontend
```
http://localhost:3001
```
(The Express server serves the frontend automatically.)

### 5. Load demo data
Visit in your browser or curl:
```
http://localhost:3001/api/seed
```
This inserts 20 realistic Pakistani B2B sales calls with summaries, topics, and action items.

### 6. Upload a real call recording
- Go to the **Upload** tab
- Drag and drop an MP3/WAV/M4A file
- Fill in employee and distributor names
- Click **Upload & Analyse**
- Groq Whisper transcribes the audio (Urdu supported)
- Claude Haiku generates summary, topics, and action items

---

## Features

| Feature | Details |
|---|---|
| Transcription | Groq Whisper Large v3 — Urdu + English |
| Summarisation | Claude Haiku 4.5 — JSON structured output |
| Flag detection | Complaints, competitor mentions, payment issues |
| Dashboard | Stats cards, CSS bar charts, recent calls |
| Call Log | Filter by employee, direction, flagged; inline expand |
| Upload | Drag & drop audio, instant AI analysis |
| Settings | Intellicon API, Nayatel SIP, PKR cost calculator |

## API Endpoints

| Method | Path | Description |
|---|---|---|
| POST | /api/calls/upload | Upload audio + metadata |
| POST | /api/calls/transcribe/:id | Transcribe audio via Groq |
| POST | /api/calls/summarise/:id | Summarise transcript via Claude |
| GET | /api/calls | List all calls (with filters) |
| GET | /api/calls/:id | Get single call |
| GET | /api/stats | Dashboard statistics |
| GET | /api/seed | Insert 20 demo calls |

### Query filters for GET /api/calls
- `?employee=Usman+Khan`
- `?direction=Inbound`
- `?flagged=true`
- `?search=complaint`

## Project Structure
```
callsync/
  backend/
    server.js          # Express server + seed endpoint
    database.js        # SQLite schema init
    routes/
      calls.js         # Upload, transcribe, summarise, list
      stats.js         # Aggregated statistics
    uploads/           # Stored audio files
  frontend/
    index.html         # Single-file React app (CDN)
  .env.example
  package.json
  README.md
```

## Cost Estimate

| Service | Model | Est. per call |
|---|---|---|
| Transcription | Groq Whisper Large v3 | ~$0.001 |
| Summarisation | Claude Haiku 4.5 | ~$0.003 |
| **Total** | | **~$0.004** |

1,000 calls/month ≈ **$4 USD (≈ PKR 1,100)**

## Future Integrations (Settings tab)
- **Intellicon**: Add `INTELLICON_API_KEY` to `.env` for automatic call log pull
- **Nayatel SIP**: Add SIP credentials to `.env` for live call recording ingestion
