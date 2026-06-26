# RepoLens — Product Requirements Document

**Version:** 2.0
**Status:** Active
**Last Updated:** 2026-06-25

---

## 1. Problem Statement

Every developer who lands on an unfamiliar GitHub repository faces the same problem: understanding it takes days, not minutes. A repo might have 300 files across 12 folders, sparse documentation, and zero onboarding context. You clone it, open an IDE, and start reading — file by file, manually tracing call chains.

The tools that exist today solve this *inside* an IDE (Cursor, Copilot) or as a separate product you context-switch into (Sourcegraph, Phind). Nobody has solved it *where the repository already lives* — on GitHub itself, while you're reading the README, browsing issues, or reviewing a PR.

**The friction is context-switching. RepoLens eliminates it.**

RepoLens is a browser extension that lives on top of GitHub. When you're on any public repository, you can open a chat panel, index the repo in 1–3 minutes, and ask natural language questions about the codebase — with answers that cite exact file names and line numbers.

---

## 2. Target Users

### Primary
**Developers joining a new codebase.** Engineers assigned to a repo they've never touched. They need to understand architecture, locate specific logic, and answer "where does X happen?" without hours of grep-ing.

### Secondary
**Open source contributors.** Developers evaluating whether to contribute — trying to understand how a project works before opening an issue or PR.

### Tertiary
**Technical reviewers.** Engineers reviewing unfamiliar code during pull requests or due diligence, who need fast orientation without cloning the repo locally.

---

## 3. Core Features

### F1 — GitHub Page Detection
Automatically detects when the user is on a valid GitHub repository page. Activates only on `github.com/{owner}/{repo}` and its sub-paths. Does NOT activate on issues, pulls, settings, actions, wiki, or profile pages.

### F2 — Floating Trigger Button
A minimal 40×40px button in the bottom-right corner of GitHub repo pages. One click opens the RepoLens panel. The icon is the official RepoLens extension logo. It looks like a developer tool.

### F3 — Sliding Chat Panel
A 380px-wide panel slides in from the right. It does not cover the main content. It can be dismissed and reopened without losing session state. Dark theme that matches GitHub's dark mode exactly — it feels like a native GitHub feature.

### F4 — Repo Indexing with Progress
First open on a new repo: panel shows repo name, estimated file count, and an "Index Repository" button. On click: a progress bar shows files processed, current file path, and percentage. Backend clones the repo, parses code with tree-sitter, embeds with Gemini, and stores in ChromaDB. Takes 1–3 minutes for a ~200 file repo.

### F5 — RAG-Powered Q&A with Fallback
After indexing, users ask free-form questions in natural language. Questions can be architectural ("How does auth work?"), locational ("Where is the DB connection set up?"), or investigative ("What happens when a user submits a form?"). Answers stream in real time in WhatsApp-style chat bubbles (with user and assistant avatars). If the codebase does not contain the answer (e.g. asking for general programming knowledge or competitor comparisons), RepoLens can fall back to general knowledge while explicitly stating it is doing so.

### F5.1 — Smart Autocomplete & Suggestions
As the user types, RepoLens offers intelligent inline word predictions and a horizontal scrolling list of "Curious Questions" (e.g., "Why is it helpful?", "What makes it different?"). These suggestions appear as non-obstructive pill bubbles above the input bar and hide automatically when the input is empty or a sentence is completed, ensuring the chat history is never blocked.

### F6 — Cited Answers
Every answer includes file citations as clickable chips: `auth/middleware.py:42`. Clicking opens that exact file on GitHub in a new tab, at the correct line.

### F7 — Repo Architecture Overview
A "Map This Repo" button sends a fixed architecture question and returns a plain-English summary: what each top-level folder does, where the entry points are, and how data flows.

### F8 — Session Memory
Chat history is retained per-repo within the browser session via `chrome.storage.session` (routed through the background service worker). Closing and reopening the panel does not lose the conversation.

### F9 — Index Caching
If a repo was indexed within the last 24 hours, the backend skips re-indexing and opens directly to READY state. The cached timestamp is stored in `chrome.storage.local`.

### F10 — Backend Offline State
If the local backend is unreachable on panel open, a dedicated state shows the exact command to start it: `uvicorn main:app --reload`, with a one-click copy button.

---

## 4. Out of Scope — v1

- Private repository support (requires GitHub OAuth token flow)
- Firefox packaging — Chrome first; Firefox port after Chrome is stable
- Cloud hosting of the backend — v1 is localhost only
- Multi-repo cross-search
- Saving or exporting chat history
- Settings panel or preferences UI
- Dark/light mode toggle (dark only)

---

## 5. Success Criteria

| Metric | Target |
|---|---|
| Time to first answer (new repo) | < 3 minutes (index + first response) |
| Answer cites correct file | ≥ 85% of factual questions |
| Index cache hit rate | ≥ 60% of sessions reuse prior index |
| Panel open/close responsiveness | < 100ms |
| Install-to-working time | < 5 minutes including backend setup |
| UI design quality | Zero vibe-coded elements — passes design review checklist |
| Backend error recovery | All errors surface human-readable messages in the panel |

---

## 6. Technical Constraints

- **Free tier only.** No paid API keys. Gemini Flash (free) + Gemini text-embedding-004 (free) + ChromaDB (local).
- **Localhost backend.** Backend runs on the user's machine at `localhost:8000`. Extension communicates with it via fetch.
- **Public repos only (v1).** GitHub REST API is used without auth. Private repos require token support (v2).
- **Chrome first.** Manifest V3 with `webextension-polyfill` for Firefox compatibility, but Chrome is the primary target.
- **No LangChain.** RAG chain is implemented directly so the builder understands every step.

---

## 7. User Journey — Happy Path

```
1. User lands on github.com/some-org/some-repo
2. Sees the RepoLens </>  button in the bottom-right corner
3. Clicks it — panel slides in from the right
4. Panel shows: "This repo hasn't been indexed. ~214 files. Est. 2 min."
5. User clicks "Index Repository"
6. Progress bar fills over 2 minutes. Current file ticks by.
7. Panel transitions to chat interface
8. User types: "How does authentication work?"
9. Answer streams in with markdown formatting
10. Three citation chips appear below: auth/middleware.py:42, auth/routes.py:88, config/settings.py:12
11. User clicks a chip → GitHub opens that file at that line
12. User asks 3 more questions. History stays in the panel.
13. User navigates to another page, comes back. Panel reopens in READY state.
```
