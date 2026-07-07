# RepoLens — Schema

**Version:** 2.0

This file is the single source of truth for all API contracts, data structures, storage schemas, and prompt templates. If the AI agent or any module deviates from this, it is a bug.

---

## Backend API Contracts

### POST /index

**Request:**
```json
{
  "repo_url": "https://github.com/owner/repo"
}
```

**Success Response (202):**
```json
{
  "job_id": "a3f7c2b1",
  "status": "started",
  "repo_name": "owner/repo"
}
```

**Error Responses:**
```json
{ "error": "invalid_url", "message": "URL must be a valid GitHub repository URL starting with https://github.com/" }
{ "error": "already_indexing", "message": "This repo is currently being indexed.", "job_id": "a3f7c2b1" }
```

---

### GET /status/{job_id}

**Response — in progress:**
```json
{
  "job_id": "a3f7c2b1",
  "status": "indexing",
  "progress": 43,
  "files_processed": 91,
  "total_files": 214,
  "current_file": "src/auth/middleware.py",
  "elapsed_seconds": 62,
  "error": null
}
```

**Status values:** `"queued"` → `"cloning"` → `"parsing"` → `"indexing"` → `"done"` | `"error"`

**Response — done:**
```json
{
  "job_id": "a3f7c2b1",
  "status": "done",
  "progress": 100,
  "files_processed": 214,
  "total_files": 214,
  "elapsed_seconds": 147,
  "error": null
}
```

**Response — error:**
```json
{
  "job_id": "a3f7c2b1",
  "status": "error",
  "progress": 12,
  "files_processed": 25,
  "total_files": 214,
  "elapsed_seconds": 18,
  "error": "Could not clone repository. Check that the repo is public."
}
```

**404** if job_id not found.

---

### POST /query

**Request:**
```json
{
  "repo_url": "https://github.com/owner/repo",
  "question": "How does authentication work?"
}
```

**Response:** Server-Sent Events stream (`text/event-stream`).

```
event: token
data: {"text": "Authentication"}

event: token
data: {"text": " is handled"}

event: token
data: {"text": " in the middleware layer."}

event: sources
data: {
  "sources": [
    { "file": "src/auth/middleware.py", "line": 42, "chunk_type": "function", "name": "verify_token" },
    { "file": "src/auth/routes.py", "line": 88, "chunk_type": "function", "name": "login" }
  ]
}

event: done
data: {}
```

**Error (before stream starts, 400):**
```json
{ "error": "not_indexed", "message": "This repo has not been indexed yet. Call POST /index first." }
```

**Error mid-stream:**
```
event: error
data: {"message": "Gemini API rate limit exceeded. Try again in 60 seconds."}
```

---

### GET /health

**Response (200):**
```json
{
  "status": "ok",
  "version": "1.0.0"
}
```

---

## Backend Internal Data Structures

### File Dict (output of crawler.py)

```python
{
    "file_path": str,        # absolute path on disk: "/tmp/repolens/owner__repo/src/auth/middleware.py"
    "relative_path": str,    # relative to repo root: "src/auth/middleware.py"
    "language": str,         # "python" | "javascript" | "typescript" | "go" | etc.
    "raw_content": str       # full file text
}
```

### Chunk Dict (output of parser.py)

```python
{
    "chunk_id": str,         # f"{relative_path}::{start_line}" — e.g. "src/auth/middleware.py::42"
    "file_path": str,        # relative_path (NOT absolute)
    "language": str,
    "chunk_type": str,       # "function" | "class" | "module" | "fallback"
    "name": str,             # function/class name, or "chunk_0", "chunk_1" for fallback
    "start_line": int,       # 1-indexed
    "end_line": int,
    "content": str           # raw code text of this chunk
}
```

### Embedded Chunk Dict (output of embedder.py — chunk dict + two new fields)

```python
{
    # all fields from Chunk Dict above, plus:
    "context_string": str,   # the prefixed string that was sent to the embedding model
    "embedding": list[float] # 768-dimensional vector
}
```

### IndexJob Dict (in-memory, in main.py)

```python
{
    "job_id": str,
    "repo_url": str,
    "repo_name": str,              # "owner/repo"
    "status": str,                 # "queued"|"cloning"|"parsing"|"indexing"|"done"|"error"
    "progress": int,               # 0–100
    "files_processed": int,
    "total_files": int,
    "current_file": str,
    "elapsed_seconds": int,
    "error": str | None,
    "started_at": float            # time.time() — used to compute elapsed_seconds
}
```

---

## ChromaDB Collection Schema

**Collection name format:** `repolens_{sanitized_repo_name}`
- Sanitize: replace `/` with `__`, strip all non-alphanumeric characters except underscores
- Example: `github.com/tiangolo/fastapi` → `repolens_tiangolo__fastapi`

**Document stored:** `chunk["context_string"]`

**Metadata stored per document:**
```json
{
  "chunk_id": "src/auth/middleware.py::42",
  "repo_url": "https://github.com/owner/repo",
  "repo_name": "owner/repo",
  "file_path": "src/auth/middleware.py",
  "language": "python",
  "chunk_type": "function",
  "name": "verify_token",
  "start_line": 42,
  "end_line": 67
}
```

**Query fields used from results:** `documents`, `metadatas`, `distances`

**Note:** ChromaDB metadata values must be strings, ints, or floats. No lists or dicts in metadata.

---

## Extension Storage Schema

### chrome.storage.local (persists across browser sessions)

```typescript
interface LocalStorage {
  indexed_repos: {
    [repo_url: string]: {
      indexed_at: number;       // Unix timestamp (seconds)
      job_id: string;
      file_count: number;
      status: "done" | "error";
      commit_sha?: string;      // GitHub commit hash when indexed
    }
  }
  repo_metadata: {
    [repo_url: string]: {
      estimated_files: number;  // from GitHub API size field
      fetched_at: number;       // Unix timestamp — cache for 24h
    }
  }
}
```

### chrome.storage.session (cleared on browser close).

All session storage is accessed via `chrome.runtime.sendMessage` to `background.js`. Content scripts do not access session storage directly.

```typescript
interface SessionStorage {
  [key: string]: ChatMessage[];  // key format: "chat_https://github.com/owner/repo"
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];            // only present on assistant messages
  timestamp: number;             // Unix timestamp (ms)
}

interface Source {
  file: string;                  // "src/auth/middleware.py"
  line: number;                  // 42
  chunk_type: string;            // "function"
  name: string;                  // "verify_token"
}
```

### Background service worker message types

```typescript
// All messages use chrome.runtime.sendMessage from panel.js

{ type: "GET_REPO_STATUS", repo_url: string }
// Response: IndexedRepoEntry | null

{ type: "SET_REPO_STATUS", repo_url: string, data: IndexedRepoEntry }
// Response: { ok: true }

{ type: "GET_CHAT_HISTORY", key: string }
// Response: ChatMessage[]  (empty array if not found)

{ type: "SET_CHAT_HISTORY", key: string, messages: ChatMessage[] }
// Response: { ok: true }
```

---

## Context String Format (Sent to Embedding Model)

Every chunk is prefixed before embedding. This prefix provides context so the embedding model understands the code's location and purpose:

```
File: src/auth/middleware.py
Language: python
Type: function
Name: verify_token
Lines: 42-67
Repo: owner/repo

def verify_token(token: str) -> Optional[User]:
    payload = jwt.decode(token, settings.SECRET_KEY, algorithms=["HS256"])
    user_id = payload.get("sub")
    ...
```

The `context_string` is what gets stored in ChromaDB as the document and what gets embedded. The raw `content` is also stored in the metadata for display purposes.

---

## RAG Prompt Template

### System prompt (sent to Gemini 1.5 Flash):

```
You are RepoLens, a code assistant for the repository: {repo_name}.

You have been given {N} relevant code chunks retrieved from this codebase.
Each chunk includes the file path, line numbers, and code content.

Rules:
- Base your answer primarily on the provided chunks.
- If the provided chunks do NOT contain enough information to answer the question, you may use your general programming knowledge to answer, but you MUST clearly state that your answer is based on general knowledge and not the specific codebase.
- Do NOT cite sources (e.g. no [filename:line_number]) in your text. Provide a clear, plain-English explanation.
- Use markdown formatting. Use fenced code blocks for code.
- Be technically precise. Your audience is experienced developers.
```

### User message format:

```
Question: {user_question}

Code chunks:
--- CHUNK 1 ---
File: src/auth/middleware.py (lines 42–67)
Type: function | Name: verify_token
Language: python

{chunk_content}

--- CHUNK 2 ---
File: src/auth/routes.py (lines 88–121)
Type: function | Name: login
Language: python

{chunk_content}

...
```

---

## Language Extension Map

```python
EXTENSION_MAP = {
    ".py":    "python",
    ".js":    "javascript",
    ".ts":    "typescript",
    ".jsx":   "javascript",
    ".tsx":   "typescript",
    ".java":  "java",
    ".go":    "go",
    ".rs":    "rust",
    ".cpp":   "cpp",
    ".c":     "c",
    ".cs":    "csharp",
    ".rb":    "ruby",
    ".php":   "php",
    ".swift": "swift",
    ".kt":    "kotlin",
    ".md":    "markdown"
}
```

## Directories to Skip

```python
SKIP_DIRS = {
    "node_modules", ".git", "dist", "build", "__pycache__",
    ".venv", "venv", ".next", "out", "vendor", ".idea",
    ".vscode", "coverage", ".nyc_output", "target"
}
```
