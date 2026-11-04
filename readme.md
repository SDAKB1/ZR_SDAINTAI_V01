# SDAINTAI Platform — v0.0.4

SAP CAP-based AI Connectivity Platform with integrated Brain AI system powered by LangChain and LangGraph.

## Project Layout

File or Folder | Purpose
---------|----------
`app/` | UI frontends (BTP Cockpit, AICONX console, admin apps)
`db/` | Domain models — including `brain-schema.cds` for Brain AI entities
`srv/` | CAP service handlers — including `brain-service.cds/.js`
`srv/ai/` | Brain AI modules (LangGraph pipeline, vector store, config)
`mtar/` | Pre-built `.mtar` deployment archives
`readme.md` | This guide

## Brain AI System

The Brain AI system (`BrainService`) is a self-learning event capture and analysis engine built on top of LangChain and LangGraph.

### Architecture

```
captureEvent()
    │
    ▼
LocalVectorStore          ← deterministic 128-dim embeddings (no API key needed)
    │
    ▼
LangGraph Pipeline
  [classify node] → classifies event into category (frontend_interaction | backend_call | ...)
  [insight node]  → generates structured insight (optimization | bug | pattern | warning)
    │
    ▼
BrainEvent (CDS entity)   ← stored in CAP DB
BrainInsight (CDS entity) ← stored in CAP DB
```

### Brain AI Files

| File | Role |
|---|---|
| `db/brain-schema.cds` | CDS entities: BrainEvent, BrainInsight, BrainSession, BrainConfig |
| `srv/brain-service.cds` | OData service definition with 6 actions |
| `srv/brain-service.js` | Service handler — LangGraph pipeline + all action implementations |
| `srv/ai/brainConfig.js` | Master key verification, brain on/off state (persisted to `.brain-state.json`) |
| `srv/ai/vectorStore.js` | Local cosine-similarity vector store (persisted to `.brain-vectors.json`) |

### Brain Service Actions

| Action | Description |
|---|---|
| `toggleBrain(key, enabled)` | Activate or deactivate the brain (requires master key) |
| `captureEvent(key, ...)` | Capture an event, embed it, run LangGraph analysis inline |
| `runAnalysis(key)` | Batch-process all unprocessed events and generate insights |
| `getBrainStatus(key)` | Dashboard: event count, insight count, vector count, coherence score |
| `exportBrain(key)` | Export full brain state as a base64 `.sdab` archive |
| `importBrain(key, data)` | Merge a `.sdab` archive back into the brain |

### Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `BRAIN_MASTER_KEY` | `SDA-BRAIN-SDAINTAI-2025` | Gate key for all Brain actions |
| `ANTHROPIC_API_KEY` | _(none)_ | Required for LangGraph LLM nodes; falls back to rule-based if absent |

### LangChain / LangGraph Packages

```json
"@langchain/anthropic": "^1.5.1",
"@langchain/core":      "^1.2.1",
"@langchain/langgraph": "^1.4.5",
"langchain":            "^1.5.2"
```

The LangGraph pipeline uses `claude-haiku-4-5-20251001` for fast, low-cost event classification and insight generation. If the Anthropic API key is not present, a deterministic rule-based classifier takes over automatically.

## Running Locally

```bash
cds watch
# Brain service available at: /odata/v4/brain/
```

## Deployment

Pre-built archives are in `mtar/`. Deploy with:

```bash
cf deploy mtar/SDAINTAI_0.0.4.mtar
```

Or build from source:

```bash
mbt build -t mtar/
```

## Learn More

- [SAP CAP Documentation](https://cap.cloud.sap)
- [LangChain JS](https://js.langchain.com)
- [LangGraph JS](https://langchain-ai.github.io/langgraphjs/)

## ZR_SDAINTAI_V01 — scope of this repo

This repo is a scoped-down copy of SDAINTAI focused on one page:
`app/aiconx/webapp/btp_cockpit.html` and its variant
`btp_cockpit_ZR_SDAINTAI_V01.html` (plus `btp_app.js` / `btp_style.css` /
`btp_lumi.css`, shared by both). It does not carry the BW Cockpit or the
other standalone apps from the main SDAINTAI repo.

## Developer workflow: one branch + one local Docker preview per developer

Each developer works on their own branch and previews their own changes
in their own local Docker container — nobody's build or `cf` deploy can
ever touch anyone else's work or the shared production route
(`sdaintai.cfapps.us10.hana.ondemand.com`, which is already at its CF
route quota, so new per-developer CF routes aren't available right now).

1. Clone the repo and create your own branch:
   ```bash
   git clone https://github.com/SDAKB1/ZR_SDAINTAI_V01.git
   cd ZR_SDAINTAI_V01
   git checkout -b <yourname>/<short-feature-name>
   ```
2. Make your changes under `app/aiconx/webapp/` (e.g. edit
   `btp_cockpit_ZR_SDAINTAI_V01.html`, `btp_app.js`, `btp_style.css`).
3. Preview locally with Docker — no CF route, no quota, fully isolated:
   ```bash
   docker compose -f docker-compose.dev.yml up --build dev1
   ```
   Open `http://localhost:8081/btp_cockpit_ZR_SDAINTAI_V01.html`.

   `docker-compose.dev.yml` has one service block per developer
   (`dev1` on port 8081, `dev2` on port 8082, ...). If you're the next
   developer, copy the commented `dev3` block, give it your own name/port,
   and use that instead of `dev1`/`dev2` — don't reuse someone else's block.
4. Commit and push your branch, then open a PR into `main` when ready:
   ```bash
   git push -u origin <yourname>/<short-feature-name>
   ```
5. Only merge to `main` — and only run a real `cf deploy` /
   `mbt build -t mtar/` — when the change is actually meant to ship. The
   local Docker container is for preview only; it's a separate thing from
   the `containerize.yaml` / `chart/` (Helm) / `Jenkinsfile` setup already
   in this repo, which is the real build-and-deploy pipeline for
   Kubernetes/CF, not a per-developer sandbox.
