# MPA Maritime Intelligence Platform v8
## AI-Powered Vessel Tracking · Gemini + Claude LLM · BigQuery · React

---

## What's New in v8 (AI Upgrade)

### 🤖 AI / LLM Layer (New)
| Feature | Endpoint | Model |
|---------|----------|-------|
| Maritime AI Chat | `POST /api/ai/chat` | Gemini 2.0 Flash → Claude Sonnet fallback |
| Document Summarizer | `POST /api/ai/summarize` | Gemini 2.0 Flash |
| Email Drafter | `POST /api/ai/draft-email` | Gemini 2.0 Flash |
| Fuel Optimizer | `POST /api/ai/analyze-fuel` | Gemini 2.0 Flash |
| ETA Predictor | `POST /api/ai/predict-arrival` | Gemini 2.0 Flash |
| Fleet Insights | `POST /api/ai/fleet-insights` | Gemini 2.0 Flash |
| Gemini Contact Enrichment | `POST /api/gemini/enrich` | Gemini 2.0 Flash |
| Gemini Port Agents | `GET /api/gemini/port-agents` | Gemini 2.0 Flash |
| Gemini Company Intel | `POST /api/gemini/company` | Gemini 2.0 Flash |

### New Frontend Components
- **`AIChatPanel.jsx`** — Full AI chat with vessel context, quick prompts, email drafter, doc analyzer
- **`AIFleetIntelligence.jsx`** — ML predictions, fleet analytics, fuel scoring, port congestion forecast
- Floating AI action buttons (✦ Chat, ⚡ Fleet Intel)
- TopBar AI buttons: AI CHAT + AI FLEET

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   FRONTEND (React)                   │
│  MapView · TopBar · VesselPanel · VesselDetailPanel  │
│  AIChatPanel · AIFleetIntelligence · ContactFinder  │
└────────────────────┬────────────────────────────────┘
                     │ REST API
┌────────────────────▼────────────────────────────────┐
│                BACKEND (Node.js/Express)             │
│                                                      │
│  /api/vessels     → BigQuery AIS data               │
│  /api/ai/chat     → Gemini 2.0 Flash (LLM chat)    │
│  /api/ai/summarize→ Document AI analysis            │
│  /api/ai/draft-email → Maritime email drafter       │
│  /api/ai/analyze-fuel → Fuel optimization AI        │
│  /api/ai/fleet-insights → Fleet analytics AI        │
│  /api/gemini/*    → Gemini contact enrichment       │
│  /api/predict     → ML trajectory prediction        │
│  /api/fuel        → Fuel efficiency calculator      │
│  /api/weather     → BigQuery weather data           │
│  /api/contacts    → Equasis scraper + enrichment    │
│  /api/gis         → GIS/TSS maritime lanes          │
└──────┬──────────────────┬──────────────────┬────────┘
       │                  │                  │
┌──────▼──────┐  ┌────────▼──────┐  ┌───────▼──────┐
│  BigQuery   │  │  Gemini API   │  │ Anthropic API│
│  (AIS Data) │  │  (Primary LLM)│  │ (Fallback LLM│
│  MPA Dataset│  │  2.0 Flash    │  │ Claude Sonnet│
└─────────────┘  └───────────────┘  └──────────────┘
```

---

## Quick Start

### 1. Clone & Install
```bash
git clone <your-repo>
cd maritime-ai-platform

# Backend
cd backend && npm install

# Frontend
cd ../frontend && npm install
```

### 2. Configure Environment
```bash
# Backend
cp backend/.env.example backend/.env
# Edit backend/.env with your keys

# Frontend
cp frontend/.env.example frontend/.env
# Edit frontend/.env
```

### 3. Run Locally
```bash
# Terminal 1 — Backend
cd backend && npm run dev    # runs on :10000

# Terminal 2 — Frontend
cd frontend && npm start     # runs on :3000
```

---

## Deployment on Render

### Step 1: Push to GitHub
```bash
git init && git add . && git commit -m "v8 AI upgrade"
git remote add origin https://github.com/YOUR/repo.git
git push -u origin main
```

### Step 2: Create Render Services
1. Go to [render.com](https://render.com) → **New** → **Blueprint**
2. Connect your GitHub repo
3. Render auto-detects `render.yaml` and creates both services

### Step 3: Set Environment Variables
In Render Dashboard → **vessel-backend** → **Environment**:

| Key | Value | Required |
|-----|-------|----------|
| `GEMINI_API_KEY` | `AIza...` | ✅ Primary AI |
| `ANTHROPIC_API_KEY` | `sk-ant-...` | Optional (Claude fallback) |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | Full JSON string | ✅ BigQuery |
| `BIGQUERY_PROJECT_ID` | `your-project-id` | ✅ |
| `GOOGLE_MAPS_API_KEY` | `AIza...` | ✅ Maps |
| `EQUASIS_USER` | `email` | Optional (contact enrichment) |
| `EQUASIS_PASS` | `password` | Optional |

### Step 4: Get Free Gemini Key
1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. Click **Create API Key**
3. Copy and paste into Render's `GEMINI_API_KEY`
4. Free tier: **15 req/min, 1,500 req/day**

---

## AI Features Guide

### 💬 AI Chat (AIChatPanel)
- Click the **✦** floating button or **AI CHAT** in the topbar
- Select any vessel on the map for vessel-specific context
- Quick prompts: Fuel Analysis, Email Draft, Port Status, Weather Risk
- Automatic Gemini → Claude fallback if primary AI unavailable
- Full chat history maintained per session

### 📊 Fleet Intelligence (AIFleetIntelligence)
- Click **⚡** floating button or **AI FLEET** in topbar
- **AI Insights tab**: Gemini analyzes entire fleet, returns headline insight, concerns, opportunities
- **Analytics tab**: Real-time charts — vessel types, speed distribution, flag states
- **Fuel tab**: Efficiency score ring, daily savings estimate, route recommendations
- **ML Predict tab**: Delay risk prediction, port congestion forecast, XGBoost model info

### 📧 Email Drafter
- In AI Chat panel → **Email tab**
- Auto-fills selected vessel's name and IMO
- Three tones: Professional, Friendly, Urgent
- One-click copy to clipboard

### 📋 Document Analyzer
- In AI Chat panel → **Docs tab**
- Supports: Cargo Reports, Voyage Logs, Charter Contracts, Invoices, Bills of Lading
- Extracts: Summary, Risk Flags, Action Items
- Paste any maritime document text for instant AI analysis

### ⚡ Contact Enrichment (existing, enhanced)
- Click vessel → **CONTACTS** button in topbar
- Runs: Equasis scraper → MarineTraffic → VesselFinder → DDG/Bing search → Gemini AI boost
- Returns: owner, manager, email, phone, website with confidence score

---

## API Reference

### AI Chat
```
POST /api/ai/chat
Body: { message, history?, vesselData?, fleetStats? }
Response: { success, reply, provider }
```

### Document Summarizer
```
POST /api/ai/summarize
Body: { text, type: "cargo_report"|"voyage_log"|"contract"|"invoice"|"bol" }
Response: { success, parsed: { summary, key_details, action_items, risk_flags } }
```

### Email Drafter
```
POST /api/ai/draft-email
Body: { purpose, details?, tone?, vesselName?, imoNumber?, companyName?, portName? }
Response: { success, email: { subject, body } }
```

### Fuel Analysis
```
POST /api/ai/analyze-fuel
Body: { vesselData, routeData? }
Response: { success, analysis: { efficiency_score, fuel_savings_daily_tons, route_recommendations } }
```

### Fleet Insights
```
POST /api/ai/fleet-insights
Body: { stats, vessels[] }
Response: { success, insights: { headline_insight, top_concerns, opportunities } }
```

### AI Status
```
GET /api/ai/status
Response: { gemini: { configured, model }, claude: { configured, model } }
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React 18, Google Maps JS API |
| **Backend** | Node.js, Express 4 |
| **Database** | Google BigQuery (AIS data, weather, users) |
| **Primary AI** | Google Gemini 2.0 Flash |
| **Fallback AI** | Anthropic Claude Sonnet 4 |
| **Vessel Data** | BigQuery AIS feed, Equasis, MarineTraffic |
| **Deployment** | Render (auto-deploy from GitHub) |
| **Predictions** | Rule-based ML + LLM reasoning |

---

## File Structure (New Files in v8)

```
maritime-ai-platform/
├── backend/
│   ├── src/
│   │   ├── routes/
│   │   │   ├── ai_chat.js          ← NEW: LLM chat, summarize, email, fuel
│   │   │   ├── ai_contact.js       (existing: multi-step contact enrichment)
│   │   │   ├── gemini_contact.js   (existing: Gemini enrichment)
│   │   │   └── ...
│   │   └── server.js               ← UPDATED: registers /api/ai/chat routes
│   └── .env.example                ← NEW: all env var docs
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── AIChatPanel.jsx     ← NEW: AI chat + email + doc analyzer
│   │   │   ├── AIChatPanel.css     ← NEW
│   │   │   ├── AIFleetIntelligence.jsx ← NEW: ML dashboard
│   │   │   ├── AIFleetIntelligence.css ← NEW
│   │   │   └── TopBar.jsx          ← UPDATED: AI CHAT + AI FLEET buttons
│   │   ├── services/
│   │   │   └── api.js              ← UPDATED: AI helper functions added
│   │   ├── styles/
│   │   │   └── App.css             ← UPDATED: drawer + FAB styles
│   │   └── App.jsx                 ← UPDATED: AI panels integrated
│   └── .env.example                ← NEW
└── render.yaml                     ← UPDATED: AI env vars added
```
