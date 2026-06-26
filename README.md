<div align="center">
  <img src="repolens/extension/icons/icon128.png" alt="RepoLens Logo" width="120" />

  # 🔍 RepoLens

  **Chat with any GitHub repository. Without leaving GitHub.**

  [![Python Version](https://img.shields.io/badge/Python-3.11+-blue.svg?logo=python&logoColor=white)](https://python.org)
  [![FastAPI](https://img.shields.io/badge/FastAPI-0.115+-009688.svg?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com)
  [![Gemini](https://img.shields.io/badge/AI-Gemini_1.5_Flash-4285F4.svg?logo=google&logoColor=white)](https://aistudio.google.com/)
  [![Extension](https://img.shields.io/badge/Chrome_Extension-Manifest_V3-4CAF50.svg?logo=google-chrome&logoColor=white)](https://developer.chrome.com/)

  *A lightning-fast, locally-hosted RAG (Retrieval-Augmented Generation) extension that turns any GitHub repository into an interactive AI chat.*

</div>

---

## ✨ Why RepoLens?

Cursor and Copilot do this inside an IDE. Nobody does it cleanly **inside GitHub itself** — where developers already spend enormous time reviewing PRs, reading issues, and exploring unfamiliar repos. **RepoLens lives where the code already is.**

No more cloning massive repositories just to figure out how they work. No more `grep`-ing through thousands of files to trace a single function call.

### 🆚 RepoLens vs. GitHub Copilot (The Ecosystem)

While GitHub Copilot is an incredible **AI Pair Programmer** designed for writing code in your IDE, **RepoLens** is a **GitHub Explorer with AI Chat** designed for *understanding* code right in your browser. They complement each other perfectly:

- **Different Tools for Different Jobs**: Copilot generates and refactors code locally. RepoLens helps you explore, onboard, and understand unfamiliar open-source projects without leaving the GitHub web UI.
- **The "Free Tier" Advantage**: RepoLens brings powerful, repo-level RAG directly to GitHub for free (using your own API key). You don't need a premium Enterprise subscription just to ask questions about a repository online.
- **Frictionless Experience**: No cloning, no opening an IDE, and no switching tabs to ChatGPT or Claude. You stay right where the code is.
- **Privacy First**: The vector database runs 100% locally on your machine. You control your data.

---

## 🚀 Features

- **💬 Seamless GitHub Integration**: Injects a sleek chat panel directly into GitHub's UI.
- **📚 Smart RAG Indexing**: Uses AST parsing (tree-sitter) and vector embeddings (ChromaDB) to understand the codebase structure in minutes.
- **🎯 Exact Citations**: Every answer provides clickable file and line citations, jumping you instantly to the relevant code.
- **💬 WhatsApp-Style Chat**: Beautiful, familiar chat UI featuring user and assistant avatars.
- **✨ Intelligent Autocomplete**: Non-obstructive horizontal pill bubbles suggest word completions and "curious questions" as you type, disappearing when not needed.
- **🧠 General Knowledge Fallback**: If the repo doesn't have the answer, the AI intelligently falls back to general programming knowledge.
- **🔒 Privacy First**: Your vector database runs **100% locally**. The only data leaving your machine goes directly to the Gemini API.

---

## 🛠️ The Stack

| Layer | Technology | Why we chose it |
|:---|:---|:---|
| **Extension** | `Chrome MV3` / `Vanilla JS` | Zero build steps. Lightweight and incredibly fast. |
| **Backend** | `FastAPI` / `Uvicorn` | Native async support and seamless Server-Sent Events (SSE) streaming. |
| **Code Parsing** | `tree-sitter-languages` | High-accuracy AST-level chunking. |
| **Embeddings** | `Gemini text-embedding-004` | 768-dim vectors on a generous free tier. |
| **LLM** | `Gemini 1.5 Flash` | Blazing fast reasoning for coding queries. |
| **Vector DB** | `ChromaDB` | Simple, persistent, and entirely local. |

---

## 📦 Installation & Setup

### 1. Clone the repository

```bash
git clone https://github.com/Swapnil-Ghosh06/REPO-LENS.git
cd REPO-LENS
```

### 2. Spin up the Local Backend

The backend does the heavy lifting (parsing, embedding, and LLM querying).

```bash
cd backend
python -m venv venv

# Windows
.\venv\Scripts\activate
# macOS/Linux
source venv/bin/activate

pip install -r requirements.txt
```

Create a `.env` file in the `backend/` directory with your free Gemini API key:
```env
GEMINI_API_KEY=your_gemini_api_key_here
```

Start the FastAPI server:
```bash
uvicorn main:app --reload --port 8000
```
> 🎉 *You should see `Application startup complete.`*

### 3. Load the Browser Extension

1. Open Chrome (or Brave/Edge) and navigate to `chrome://extensions`
2. Toggle **Developer mode** on (top right corner).
3. Click **Load unpacked**.
4. Select the `extension/` folder from this repo.

### 4. Start Chatting

1. Go to any public GitHub repository (e.g., `https://github.com/tiangolo/fastapi`).
2. Click the floating **RepoLens icon** in the bottom-right corner.
3. Click **Index Repository** (takes 1–3 minutes).
4. Ask a question!

> **Try asking:** *"How does authentication work?"* or *"Where is the database connection set up?"*

---

## 🏗️ Architecture

```text
Browser (GitHub Page)
├── content.js          🔍 detects repo URL, mounts trigger button
├── panel.js            💬 state machine, SSE stream, WhatsApp UI
└── background.js       💾 session storage management

Local Backend (localhost:8000)
├── crawler.py          🕷️ clones repo, walks files
├── parser.py           🌳 tree-sitter AST chunking
├── embedder.py         🧠 Gemini text-embedding-004
├── vectorstore.py      🗄️ ChromaDB local persistence
├── rag.py              🤖 query + stream answer
└── main.py             🚀 FastAPI entrypoint
```

---

## 📚 Documentation

Dive deeper into the architecture and design decisions:

| Document | Purpose |
|:---|:---|
| 📖 [**USER_MANUAL.md**](./USER_MANUAL.md) | How to use RepoLens effectively |
| 📋 [**PRD.md**](./PRD.md) | Problem statement, features, and success criteria |
| 🎨 [**Design.md**](./Design.md) | Visual design system, component specs, and CSS rules |
| 🏗️ [**Schema.md**](./Schema.md) | API contracts, data structures, and ChromaDB schema |
| ⚙️ [**TechStack.md**](./TechStack.md) | Detailed rationale for our technology choices |
| 🧠 [**Rules.md**](./Rules.md) | Strict AI agent rules and coding standards |

<br/>
<div align="center">
  <i>Built with ❤️ for developers who hate context-switching.</i>
</div>
