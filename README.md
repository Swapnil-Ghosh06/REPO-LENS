# RepoLens

**Chat with any GitHub repository. Without leaving GitHub.**

RepoLens is a browser extension that lets you ask natural language questions about any public GitHub codebase — directly on GitHub, with answers that cite exact file names and line numbers.

---

## What it does

You're on a GitHub repo. You open RepoLens. You ask a question.

```
"How does authentication work?"
"Where is the database connection set up?"
"What happens when a user submits a form?"
```

RepoLens indexes the codebase using RAG (Retrieval-Augmented Generation), retrieves the most relevant code chunks, and streams an answer — with citations you can click to jump to the exact file and line on GitHub.

---

## Why it exists

Cursor and Copilot do this inside an IDE. Nobody does it cleanly inside GitHub itself — where developers already spend enormous time reviewing PRs, reading issues, and exploring unfamiliar repos. RepoLens lives where the code already is.

---

## Stack

| Layer | Technology |
|---|---|
| Extension | Chrome/Firefox Manifest V3, Vanilla JS |
| Backend | Python 3.11+, FastAPI, Uvicorn |
| Repo cloning | GitPython |
| Code parsing | tree-sitter-languages (AST-level chunking) |
| Embeddings | Gemini text-embedding-004 (free tier) |
| LLM | Gemini 1.5 Flash (free tier) |
| Vector DB | ChromaDB (local persistence) |
| Markdown | marked.js |
| Code highlighting | highlight.js |

**Everything runs locally. No data leaves your machine except API calls to Gemini.**

---

## Requirements

- Python 3.11+
- Google Gemini API key (free at [aistudio.google.com](https://aistudio.google.com/app/apikey))
- Chrome (primary) or Firefox 109+
- Git installed on your machine

---

## Installation

### 1. Clone the repo

```bash
git clone https://github.com/yourusername/repolens
cd repolens
```

### 2. Set up the backend

```bash
cd backend
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

Create a `.env` file in the `backend/` directory:

```
GEMINI_API_KEY=your_key_here
```

Start the backend:

```bash
uvicorn main:app --reload --port 8000
```

You should see: `Application startup complete.`

### 3. Load the extension

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder from this repo

The RepoLens icon will appear in your extensions bar.

### 4. Use it

1. Navigate to any public GitHub repository
2. Click the `</>` button in the bottom-right corner
3. Click **Index Repository**
4. Wait 1–3 minutes for indexing
5. Ask anything

---

## Architecture

```
Browser (GitHub Page)
├── content.js          detects repo URL, mounts panel
├── panel.js            state machine, SSE stream, chat UI
└── background.js       storage management (chrome.storage)

Local Backend (localhost:8000)
├── crawler.py          clones repo, walks files
├── parser.py           tree-sitter AST chunking
├── embedder.py         Gemini text-embedding-004
├── vectorstore.py      ChromaDB local persistence
├── rag.py              query + stream answer
└── main.py             FastAPI: /index /status /query /health
```

---

## Limitations (v1)

- Public repositories only (no GitHub auth)
- Backend must run locally — no cloud hosting yet
- Chrome primary; Firefox compatible but not the focus
- Index is per-machine; not shared across devices

---

## Project documents

| Document | Purpose |
|---|---|
| `PRD.md` | Problem statement, features, success criteria |
| `TechStack.md` | Full tech stack with rationale |
| `Schema.md` | API contracts, data structures, ChromaDB schema |
| `Design.md` | Visual design system, component specs |
| `ExtensionFlow.md` | Extension architecture and data flows |
| `ImplementationPlan.md` | Phase-by-phase build plan with prompts |
| `Rules.md` | AI agent rules and coding standards |
| `Tracker.md` | Build progress tracker |

---

## License

MIT
