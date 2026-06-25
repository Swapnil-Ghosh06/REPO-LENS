# RepoLens — Tech Stack

**Version:** 2.0
**Constraint:** Free tier only. No paid APIs. No cloud infrastructure.

---

## Overview

RepoLens splits into two parts: a **browser extension** (Chrome-first, Firefox-compatible) and a **local Python backend**. The extension injects into GitHub pages. The backend runs on the user's machine and handles all heavy processing.

---

## Extension Layer

| Component | Technology | Version | Why |
|---|---|---|---|
| Extension framework | Manifest V3 | Chrome 88+ / Firefox 109+ | Industry standard for both browsers |
| Firefox compatibility | webextension-polyfill (Mozilla) | latest | Bridges `chrome.*` API to `browser.*` for Firefox |
| UI framework | Vanilla JS + CSS | — | No React overhead for a panel this size. No build step. |
| Markdown rendering | marked.js | 4.x (vendored) | Renders LLM markdown in the chat, no CDN dependency at runtime |
| Code highlighting | highlight.js | 11.x (vendored) | Syntax highlights code blocks in answers |
| Font: UI text | Inter | Google Fonts | Clean, readable, used by Linear, Vercel, Notion |
| Font: Code + paths | JetBrains Mono | Google Fonts | Professional monospace. Not vibe-coded. |

**Note on vendored libraries:** Both `marked.js` and `highlight.js` are downloaded and placed in `extension/lib/`. Chrome extensions cannot load from CDNs by default without modifying CSP.

---

## Backend Layer

| Component | Technology | Version | Why |
|---|---|---|---|
| Language | Python | 3.11+ | f-strings, match statements, better typing |
| Web framework | FastAPI | 0.115+ | Async, native SSE streaming, clean DX |
| ASGI server | Uvicorn | 0.30+ | Fast, works with FastAPI, `--reload` for dev |
| Repo cloning | GitPython | 3.1+ | Python-native Git operations, well-maintained |
| Code parsing | tree-sitter-languages | 1.10+ | Pre-built wheel — no C compiler needed on Windows. Bundles all language parsers. |
| Embedding model | Gemini text-embedding-004 | — | 768-dim vectors, free tier (1,500 RPM), high quality |
| LLM | Gemini 1.5 Flash | — | 15 RPM / 1M TPD free, streaming support, fast |
| Vector DB | ChromaDB | 0.5+ | 100% local, no signup, persistent client, good Python API |
| Gemini SDK | google-generativeai | 0.8+ | Official Gemini Python SDK |
| Config | python-dotenv | 1.0+ | `.env` file for API key management |

---

## AI Agent Layer (Antigravity)

| Stage | How to use Antigravity |
|---|---|
| Module generation | Paste the prompt from `ImplementationPlan.md` exactly |
| Debugging | Paste full error traceback + the relevant file. Ask for root cause. |
| Refactoring | Only after the module works. Ask to improve one function at a time. |
| Panel UI | Reference Design.md in your prompt. Generate HTML/CSS/JS separately. |
| Test writing | After each phase passes integration test, ask for pytest tests. |

**Rule:** Antigravity generates a first draft. Read it. Understand it. Then run it. Never blindly accept and run generated code.

---

## Runtime Versions

| Runtime | Minimum Version |
|---|---|
| Python | 3.11 |
| Chrome | 88 (Manifest V3 support) |
| Firefox | 109 (Manifest V3 support) |
| Node.js | Not required at runtime (only if using build tooling) |

---

## Free Tier Limits — Know These Before You Build

| Service | Free Limit | Risk | Mitigation |
|---|---|---|---|
| Gemini 1.5 Flash | 15 RPM, 1M tokens/day | Could hit RPM on fast Q&A | Add 1s delay between requests in panel.js if needed |
| Gemini text-embedding-004 | 1,500 RPM | Almost impossible to hit | Batch in groups of 20 with 1s sleep |
| ChromaDB | Local only, no limit | None | Full control |
| GitHub REST API | 60 req/hour unauthenticated | Easy to hit during testing | Cache repo metadata in `chrome.storage.local` |

---

## What Is NOT Being Used and Why

| Tool | Why Excluded |
|---|---|
| OpenAI API | Paid |
| Pinecone / Weaviate | Paid cloud vector DBs |
| LangChain | Abstraction overhead; we build RAG directly so every step is understood and debuggable |
| React | Overkill for a panel this size; adds build tooling complexity with no benefit |
| pgvector | Requires PostgreSQL running locally; ChromaDB is simpler for single-user |
| tree-sitter (individual packages) | `pip install tree-sitter-python` etc. fail on Windows without a C compiler. Use `tree-sitter-languages` instead — it's a pre-built wheel. |
| Webpack / Vite / any bundler | No build step for the extension. What you write is what gets loaded. |

---

## Model Selection Guide for Antigravity

When working in Antigravity, use the right model for each task. Using a heavy model for simple code is wasteful; using a weak model for complex logic causes errors.

| Task | Model to Use | Reason |
|---|---|---|
| crawler.py, parser.py | Sonnet 4.6 | Straightforward file I/O and tree-sitter API |
| embedder.py, vectorstore.py | Sonnet 4.6 | SDK calls and ChromaDB API are well-documented |
| rag.py | Sonnet 4.6 (Thinking) | SSE generator + streaming Gemini API is subtle |
| main.py (FastAPI) | Sonnet 4.6 | FastAPI patterns are well-known |
| Extension shell (Phase 6) | Sonnet 4.6 | MV3 manifest is well-documented |
| Panel UI (Phase 7) | Sonnet 4.6 (Thinking) | Most complex — state machine + SSE + CSS in one |
| Debugging hard errors | Opus 4.6 (Thinking) | When Sonnet can't figure it out, escalate |
| Token/context limit hit | Start a new chat | Paste the context primer + relevant file + new prompt |

### What to do when the model hits its context/token limit

1. Start a fresh chat in Antigravity
2. Paste this context primer at the top:

```
CONTEXT: I'm building RepoLens — a Chrome/Firefox browser extension that lets developers
chat with any GitHub repository using RAG. The backend is FastAPI + ChromaDB + Gemini.
The extension is Chrome MV3, vanilla JS, no build step.

Project documents: PRD.md, TechStack.md, Schema.md, Design.md, ExtensionFlow.md,
ImplementationPlan.md, Rules.md

I was working on [PHASE NAME — e.g. "rag.py, Phase 4"].
Here is the current state of that file: [paste file]
Here is the error / next step: [describe it]
```

3. Continue from where you left off. The model will have all the context it needs.
