# RepoLens: Everything You Have to Know

## 1. Project Overview
RepoLens is a powerful, locally-hosted Chrome and Firefox browser extension designed to let developers chat directly with any GitHub repository using Retrieval-Augmented Generation (RAG). By injecting a sleek chat panel into GitHub pages, RepoLens brings AI-driven codebase understanding exactly where developers already spend their time.

---

## 2. Changelog & Project Evolution

### What was wrong with what we had?
- **Amateurish UI (Vibe-coded):** The original design used generic purple gradients, glowing hover effects, and text-based symbols (`</>`). It felt like a consumer landing page rather than a serious, native developer tool.
- **Obstructive Autocomplete Bug:** The autocomplete suggestions were presented as a vertical list. Crucially, due to a bug in `panel.js`, the suggestions would default to showing the full list of "curious questions" even when the input box was completely empty or when a user finished a sentence, completely obscuring the chat history.
- **Rigid AI (No Fallback):** The RAG system prompt was rigidly hardcoded. If a user asked a general question (e.g., "Who are the competitors for this project?", "What does this framework do?"), the AI would stubbornly refuse to answer, citing it wasn't in the codebase chunks, creating a jarring UX.
- **Iconography & CSP Blocks:** The official extension icon was missing from the trigger button and the chat headers. Furthermore, because of GitHub's strict Content Security Policy (CSP), Chrome blocked the local extension images from loading inside the GitHub DOM, resulting in broken image icons.
- **Static Indexing:** The system lacked a mechanism to manually trigger a re-index if a user realized the repository had been updated since their last session.

### What was changed & added?
- **WhatsApp-Style Chat UI:** Completely revamped the chat interface in `panel.css`. We implemented a row-reverse flexbox layout with distinct user and assistant chat bubbles. We used asymmetrical border radii (`12px 12px 2px 12px` for the user and `12px 12px 12px 2px` for the assistant) and specific GitHub-native dark theme backgrounds (`#1f3244` and `#161b22`). Profile picture avatars (`icon32.png`) were also introduced.
- **Smart Autocomplete Fix (Pill Bubbles):** Refactored `panel.js` (`updateAutocomplete()` logic) and CSS. Suggestions are now horizontal, scrollable pill bubbles. Most importantly, the JavaScript was patched to explicitly check if `queryTerms.length === 0`; if true, the entire suggestion container is completely hidden (`display: none`), preventing any UI blockage.
- **General Knowledge Fallback:** Updated the backend system prompt (`rag.py` and `Schema.md`). We added explicit instructions allowing the Gemini LLM to fall back to its general programming knowledge if the codebase chunks lack the context. The prompt forces the AI to clearly state when it is doing this and to omit file citations.
- **Manifest & Branding Patch:** Added `"icons/*"` to the `web_accessible_resources` array in `manifest.json`. This crucial fix bypassed GitHub's CSP, allowing our local extension assets to load natively on the webpage. We systematically replaced all gradients and text-logos with the official `icon32.png` asset.
- **Manual Re-indexing:** Added logic allowing users to manually trigger a re-index of the repository via a dedicated button in the corner.

### Why it was changed
- **Aesthetics & Trust:** Developers trust tools that look native and professional. By removing "vibe-coded" gradients and meticulously matching GitHub's dark mode, the extension feels like a premium, built-in feature.
- **User Experience (UX):** Fixing the autocomplete bug was critical. An AI tool must not get in the user's way. The new horizontal pills are helpful but remain strictly contextual.
- **Smarter Interactions:** Stonewalling a user just because a question wasn't explicitly in the code creates a poor experience. The fallback mechanism makes the AI feel like a competent pair-programmer rather than just a rigid search engine.

### Pros, Cons, and Disadvantages
- **Pros:** 
  - Drastically improved visual appeal and native integration feel.
  - Much smarter and more flexible AI interactions.
  - Non-obstructive UI elements ensure the chat history is always readable.
  - Solved critical CSP and image-loading bugs.
- **Cons & Disadvantages:**
  - **Hallucination Risk:** By allowing general knowledge fallback, there is a slight risk that the AI might confuse its general knowledge with specific, nuanced implementations within the actual codebase, potentially misleading the developer.
  - **DOM Weight:** Adding avatars, images, and flex layouts slightly increases the memory and DOM weight on the GitHub page compared to the original pure text approach.

---

## 3. Comprehensive File Documentation

Below is a detailed breakdown of every foundational file that dictates how RepoLens operates, including previously omitted architectural documents.

### 📄 README.md
**Purpose:** The entry point for the repository. It is designed to be highly attractive and engaging.
**Details:**
- Features a centered, emoji-rich hero banner with Shields.io badges (Python, FastAPI, Gemini, Chrome Extensions).
- Clearly explains **Why RepoLens exists** (to prevent context-switching to IDEs).
- Highlights core features like Seamless Integration, Smart RAG Indexing, WhatsApp-style Chat, Smart Autocomplete, and General Knowledge Fallback.
- Contains the full installation guide, separating the Local Backend (Python virtual environment) setup from the Browser Extension loading steps.
- Provides a clean ASCII-style architecture tree map of the system.

### 📄 PRD.md (Product Requirements Document)
**Purpose:** Outlines the core features, constraints, and success criteria for the product.
**Details:**
- **F1:** Automatic URL parsing (only activates on valid repo pages).
- **F2:** Floating Trigger Button (using the official logo).
- **F3:** Sliding Chat Panel (380px wide, native GitHub dark mode).
- **F4:** Repo Indexing with Progress (estimates files, progress bar).
- **F5 & F5.1:** RAG-Powered Q&A with Fallback & Smart Autocomplete (WhatsApp-style bubbles, pill suggestions).
- **F6:** Cited Answers (inline chips that open exact files/lines on GitHub).
- **Constraints:** Must be completely free (Free tier Gemini, ChromaDB), local privacy, no React overhead.

### 📄 Design.md
**Purpose:** The absolute source of truth for the visual UI.
**Details:**
- Enforces strict anti-patterns: No gradients, no glows, no frosted glass, no oversized paddings.
- Enforces exact Hex colors matching GitHub's dark theme (e.g., `--bg-primary: #0d1117`).
- Enforces typography: `Inter` for UI, `JetBrains Mono` for code and paths.
- Details the exact CSS requirements for the WhatsApp-style chat bubbles (including specific border-radii) and horizontal pill lists for autocomplete.
- Defines the 4 distinct UI states: `OFFLINE`, `NOT_INDEXED`, `INDEXING`, and `READY`.

### 📄 Rules.md
**Purpose:** Defines the strict rules for both the AI agent (Antigravity) and the human developer.
**Details:**
- **AI Rules:** 
  - One file per prompt.
  - Always paste the context primer when starting a new chat.
  - Reference `Schema.md` and `Design.md` as absolute sources of truth.
  - **Rule 6.1:** Explicitly allows general knowledge fallback in the RAG prompt.
  - **Rule 11:** Mandates the use of `AbortSignal.timeout()` for all backend fetch calls in the extension to prevent panel hangs.
- **Developer Rules:**
  - Never run code without reading it.
  - Test each phase in isolation before moving on.
  - The design is a constraint, not a suggestion.

### 📄 Schema.md
**Purpose:** The technical contract defining APIs, storage, and prompts.
**Details:**
- **Endpoints:** Defines exact JSON requests/responses for `/index` (POST), `/status/{job_id}` (GET), `/query` (POST with SSE stream), and `/health`.
- **Data Structures:** Dictates how `crawler.py`, `parser.py`, and `embedder.py` structure their dictionaries (e.g., adding `context_string` and `embedding`).
- **ChromaDB:** Defines the sanitized collection names (`repolens_owner__repo`) and enforces that metadata must only be primitives (strings, ints, floats).
- **Storage:** Defines `chrome.storage.local` (for indexed repo metadata) and `chrome.storage.session` (for chat history).
- **Prompt Template:** Shows the exact string injected into the Gemini model, including the rules to fall back to general knowledge if chunks are insufficient, and to omit file citations when doing so.

### 📄 TechStack.md
**Purpose:** Justifies the choice of every technology in the stack to keep the project lightweight and free.
**Details:**
- **Extension Layer:** Manifest V3, Vanilla JS + CSS (no React/Webpack overhead), `marked.js` and `highlight.js` (vendored).
- **Backend Layer:** Python 3.11, FastAPI (for native SSE streaming), Uvicorn.
- **RAG Stack:** `tree-sitter-languages` for AST parsing, `ChromaDB` for local persistence, `Gemini text-embedding-004` and `Gemini 1.5 Flash`.
- **Exclusions:** Explicitly details why LangChain, pgvector, and OpenAI were NOT used (to avoid abstraction overhead, database maintenance, and costs).

### 📄 USER_MANUAL.md
**Purpose:** A guide for the end-user on how to install, use, and troubleshoot RepoLens.
**Details:**
- Step-by-step terminal commands to spin up the backend on Windows and macOS/Linux.
- Steps to load the unpacked extension in Chrome.
- **Usage Guide:** Explains how to trigger the index and interact with the Smart Autocomplete and General Knowledge Fallback.
- **"What Makes a Good Question":** Teaches users to ask specific architectural or locational questions rather than broad, vague ones.
- **Troubleshooting:** Addresses common errors like `Failed to fetch` (backend off), ChromaDB `InvalidCollectionException` (invalid URL chars), and Gemini chunking issues.

### 📄 ImplementationPlan.md
**Purpose:** The rigid, phase-by-phase playbook used to generate the codebase without AI hallucinations.
**Details:**
- Defines 8 distinct phases (Setup, Crawler, Parser, Embedder, Vector Store, RAG Engine, FastAPI Backend, Extension Shell, Panel HTML/JS).
- Each phase includes the exact prompt to feed the AI, the dependencies required, the exact function signatures, and the test command to verify the phase works before moving to the next one.
- Instructs when to use different AI models (e.g., Sonnet 4.6 vs Opus 4.6) depending on the complexity of the module.

### 📄 ExtensionFlow.md
**Purpose:** Maps the architecture and message passing lifecycle of the Chrome extension.
**Details:**
- Documents the strict separation of concerns between `content.js` (DOM injection), `panel.js` (UI state machine), and `background.js` (secure storage access).
- Details the specific regular expressions used to ensure the extension only injects on valid GitHub repository paths, avoiding issue trackers or profile pages.

### 📄 Tracker.md
**Purpose:** A high-level project management document tracking build progress.
**Details:**
- Used during active development to log which phases of the `ImplementationPlan.md` were successfully completed, tested, and integrated.
