<div align="center">
  <img src="repolens/extension/icons/icon128.png" alt="RepoLens Logo" width="120" />

  # 🔍 RepoLens

  **Chat with any GitHub repository. Without leaving GitHub.**

  [![Chrome Extension](https://img.shields.io/badge/Chrome_Extension-Manifest_V3-4CAF50.svg?logo=google-chrome&logoColor=white)](https://developer.chrome.com/)
  [![Cloudflare Workers](https://img.shields.io/badge/Proxy-Cloudflare_Workers-F38020.svg?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
  [![Gemini](https://img.shields.io/badge/Embeddings-Gemini_text--embedding--004-4285F4.svg?logo=google&logoColor=white)](https://aistudio.google.com/)
  [![Groq](https://img.shields.io/badge/LLM-Groq_Llama_3.3_70B-F55036.svg?logo=meta&logoColor=white)](https://groq.com/)
  [![License](https://img.shields.io/badge/License-Proprietary-red.svg)](./LICENSE)

  *A zero-setup, fully serverless RAG extension that turns any GitHub repository into an interactive AI chat — right inside your browser.*

</div>

---

## ✨ What is RepoLens?

Cursor and Copilot bring AI into your IDE. **RepoLens brings it directly to GitHub** — where developers already spend enormous time reviewing PRs, reading issues, and exploring unfamiliar codebases.

No cloning. No setup. No IDE switching. Just open any GitHub repo, click **Index**, and start asking questions.

> *"A README tells you what a project does. RepoLens tells you **how** it does it.."*

---

## 🚀 Key Features

- **💬 Native GitHub Panel** — Injects a sleek, resizable chat panel directly into GitHub's UI. Drag it, resize it, minimize it.
- **⚡ Serverless Architecture** — Zero backend to run locally. All AI is powered by a secure Cloudflare Worker proxy. Install and go.
- **🎯 Exact Code Citations** — Every answer includes clickable file + line citations that jump you directly to the relevant code on GitHub.
- **🧠 Smart RAG Pipeline** — Crawls the GitHub tree, chunks files intelligently, creates vector embeddings, and uses cosine similarity to find the most relevant code chunks for your question.
- **🔁 Multi-Provider Fallback** — Uses Groq (Llama 3.3 70B) as the primary LLM, with automatic failover to a secondary Groq key, and then Gemini 1.5 Flash. Embedding falls back from Gemini to Cohere. You never hit a dead end.
- **✨ Intelligent Autocomplete** — Non-obstructive pill suggestions for "curious questions" as you type. Disappears when you don't need it.
- **🔄 Stale Index Detection** — Automatically compares the indexed commit SHA against the live repo head and warns you when the index is outdated.
- **🗺️ One-Click Repo Map** — Hit the **Map** button to get a plain-English architecture overview of the entire repository instantly.
- **💾 Persistent Chat History** — Chat history is saved per-repository for the session. Pick up right where you left off.
- **🚫 Zero Config for Users** — No API keys. No `.env` files. No Python. Just download, drag into Chrome, and go.

---

## 🏗️ Architecture

RepoLens is **100% serverless**. There is no local backend to run.. The extension talks directly to a Cloudflare Worker proxy which securely holds the API keys and routes requests to the AI providers..

```text
                  ┌───────────────────────────────────┐
                  │         GitHub Browser Tab         │
                  │                                    │
                  │  content.js  ──►  panel.js         │
                  │                     │              │
                  │              background.js         │
                  └──────────────────┬─────────────────┘
                                     │ HTTPS
                                     ▼
                  ┌───────────────────────────────────┐
                  │     Cloudflare Worker Proxy        │
                  │   (repolens-proxy.workers.dev)     │
                  │                                    │
                  │   /gemini-embed  →  Google AI      │
                  │   /cohere-embed  →  Cohere         │
                  │   /groq-chat-1   →  Groq (Key 1)  │
                  │   /groq-chat-2   →  Groq (Key 2)  │
                  │   /gemini-chat   →  Google AI      │
                  └───────────────────────────────────┘

Extension Files:
├── manifest.json          📋 Chrome MV3 manifest
├── content.js             🔍 Detects GitHub repo URLs, mounts the panel
├── background.js          🧠 RAG engine, crawler, embedder, LLM orchestration
├── lib/                   📦 Bundled dependencies (browser-polyfill, marked, highlight.js, idb)
└── panel/
    ├── panel.html         🖼️ Panel UI shell
    ├── panel.js           💬 State machine, chat streaming, UI logic
    └── panel.css          🎨 All styling (Design.md spec)

Proxy (Cloudflare Worker):
└── proxy/src/index.js     🛡️ Secure key vault & API router
```

---

## 🛠️ Tech Stack

| Layer | Technology | Why |
|:---|:---|:---|
| **Extension** | Chrome MV3 / Vanilla JS | Zero build steps. No bundler. Loads instantly. |
| **Proxy** | Cloudflare Workers | Edge-deployed in 300+ locations. Free tier is generous. |
| **Embeddings** | Gemini `text-embedding-004` | 768-dim vectors. Best free-tier quality. |
| **Embedding Fallback** | Cohere `embed-english-v3.0` | Automatic failover if Gemini rate-limits. |
| **LLM** | Groq `llama-3.3-70b-versatile` | Extremely fast inference. Free API. |
| **LLM Fallback** | Gemini `1.5 Flash` | Automatic failover if both Groq keys are exhausted. |
| **Vector Search** | In-memory cosine similarity | Stored in `chrome.storage.local`. No database needed. |
| **Code Chunking** | Sliding window (60-line, 10-line overlap) | Works on all languages without tree-sitter complexity. |

---

## 📦 Installation (For Users)

This extension is distributed as a ZIP file via GitHub Releases. No Chrome Web Store required.

### Step 1: Download
Go to the [Releases](https://github.com/Swapnil-Ghosh06/REPO-LENS/releases) page and download the latest `repolens-extension.zip`.

### Step 2: Unzip & Load into Chrome
1. Unzip the downloaded file.
2. Open Chrome and navigate to **`chrome://extensions`**
3. Toggle **Developer mode** on (top-right corner).
4. Click **Load unpacked**.
5. Select the `extension` folder from the unzipped contents..

### Step 3: Use It
1. Go to any public GitHub repository.
2. Click the **RepoLens icon** in the bottom-right corner of the page.
3. Click **Index Repository** and wait for it to finish (1–3 minutes depending on repo size).
4. Start chatting!

> **Try asking:** *"How does authentication work in this repo?"* or *"What is the main entry point of this application?"* or just click **Map** for an instant architecture overview.

---

## 🔧 Setup (For Developers)

Want to deploy your own proxy? Here is everything you need.

> ⚠️ **Note:** This project is source-available but proprietary. Deploying your own instance for personal use is permitted. Building a competing product or redistributing this code is not. See [LICENSE](./LICENSE) for full terms.

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+)
- A free [Cloudflare account](https://dash.cloudflare.com/sign-up)
- API keys from: [Google AI Studio](https://aistudio.google.com/app/apikey), [Groq Console](https://console.groq.com/keys) (×2 from different accounts for dual-key failover), [Cohere Dashboard](https://dashboard.cohere.com/api-keys)

### 1. Clone the Repository
```bash
git clone https://github.com/Swapnil-Ghosh06/REPO-LENS.git
cd REPO-LENS
```

### 2. Deploy the Cloudflare Proxy
```bash
cd repolens/proxy

# Install Wrangler CLI
npm install -g wrangler

# Log in to Cloudflare
wrangler login

# Securely store your API keys in Cloudflare's vault
wrangler secret put GEMINI_API_KEY
wrangler secret put GROQ_API_KEY
wrangler secret put GROQ_API_KEY_2
wrangler secret put COHERE_API_KEY

# Deploy the Worker
wrangler deploy
```
> Copy the deployed URL (e.g., `https://repolens-proxy.your-subdomain.workers.dev`).

### 3. Point the Extension to Your Proxy
Open `repolens/extension/background.js` and update line 21:
```javascript
// Before
const PROXY_URL = "https://repolens-proxy.YOUR_USERNAME.workers.dev";

// After — paste your URL here
const PROXY_URL = "https://repolens-proxy.your-subdomain.workers.dev";
```

### 4. Load the Extension
1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode**.
3. Click **Load unpacked** → select the `repolens/extension` folder.

### 5. GitHub Auto-Deploy (Optional)
You can connect Cloudflare Pages to your GitHub repo so that every push to the `repolens/proxy` folder automatically redeploys your Worker:
1. Go to **Cloudflare Dashboard → Workers & Pages → Create Application → Pages → Connect to Git**.
2. Select this repository and set the build directory to `repolens/proxy`.

---

## 🔒 Security Model

Your API keys are **never** stored in the extension code or distributed in the ZIP file. Here is how it works:

1. API keys live exclusively in **Cloudflare's encrypted secret vault**.
2. The extension sends requests to your **proxy URL** (not directly to the AI providers).
3. The proxy attaches the keys server-side, invisible to the end user.
4. CORS is configured to allow only `POST` and `OPTIONS` methods.

This means you can safely share the ZIP file publicly on GitHub. No one can extract your keys from it.

---

## 📋 Multi-Provider Fallback Chain

RepoLens is built to never fail silently. If one provider goes down or rate-limits, it falls through to the next:

```
Embedding:
  Gemini text-embedding-004
      ↓ (rate limited or error)
  Cohere embed-english-v3.0

LLM Chat:
  Groq Llama 3.3 70B (Key 1)
      ↓ (rate limited or error)
  Groq Llama 3.3 70B (Key 2)
      ↓ (rate limited or error)
  Gemini 1.5 Flash
```

---

## 📚 Documentation

| Document | Purpose |
|:---|:---|
| 📖 [**USER_MANUAL.md**](./USER_MANUAL.md) | How to use RepoLens effectively |
| 📋 [**PRD.md**](./PRD.md) | Problem statement, features, and success criteria |
| 🎨 [**Design.md**](./Design.md) | Visual design system, component specs, and CSS rules |
| 🏗️ [**Schema.md**](./Schema.md) | API contracts, data structures, and storage schema |
| ⚙️ [**TechStack.md**](./TechStack.md) | Detailed rationale for technology choices |
| 🧠 [**Rules.md**](./Rules.md) | Strict AI agent rules and coding standards |

---

## ⚖️ License

RepoLens is **source-available but proprietary software**, owned by Swapnil Ghosh.

- ✅ You **can** read the source code and use it for personal, non-commercial purposes.
- ❌ You **cannot** copy, redistribute, sell, or build a competing product with it.
- ❌ You **cannot** modify and publish the modified version without written permission.
- 📩 For commercial use or collaboration, reach out at **swaapnil.ghosh@gmail.com**

See the full [LICENSE](./LICENSE) for details.

---

## ⚠️ Limitations

-**Manual installation** - Manual installation is required 
- **Public repos only** — GitHub's raw API is used to fetch file content. Private repos require a GitHub Personal Access Token stored in `chrome.storage.local`.
- **800 file cap** — Repositories with more than 800 supported code files (after stripping out tests, minified files, and docs) are rejected to prevent runaway API costs and index bloat.
- **Rate limits** — The free tiers of Gemini, Groq, and Cohere have rate limits. The multi-provider fallback chain handles this gracefully, but very large repos may slow down during indexing.
- **Index freshness** — The index is stored in `chrome.storage.local` and expires after 7 days. The extension will automatically warn you when the live repo is ahead of your indexed commit.

---

<br/>
<div align="center">
  <i>Built with ❤️ for developers who hate context-switching.</i>
  <br/>
  <sub>⭐ Star this repo if RepoLens helped you understand a codebase faster!</sub>
</div>
