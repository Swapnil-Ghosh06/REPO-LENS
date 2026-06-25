# RepoLens — Implementation Plan

**Version:** 2.0
**Tool:** Antigravity (AI coding agent)
**Approach:** One module per prompt. One phase at a time. Test before advancing.

---

## AI Workflow

For every phase:

```
1. Read the prompt below carefully before pasting it into Antigravity
2. Paste the Context Primer first (see Rules.md Rule 2), then the prompt
3. Read the generated code before running it
4. Run it. If it errors → paste the full error + the file into a new Antigravity chat
5. Once the test command passes → move to the next phase
6. Do NOT refactor yet. Get it working first.
```

**Never ask the AI to "build everything." One module. One prompt. One test.**

---

## Model Selection

| Phase | Model |
|---|---|
| 0 — Setup | Terminal only |
| 1 — crawler.py | Sonnet 4.6 |
| 2 — parser.py | Sonnet 4.6 (continue same chat as Phase 1) |
| 3A — embedder.py | Sonnet 4.6 (new chat) |
| 3B — vectorstore.py | Sonnet 4.6 (continue same chat) |
| 4 — rag.py | Sonnet 4.6 Thinking (continue same chat) |
| 5 — main.py | Sonnet 4.6 (new chat) |
| 6 — Extension shell | Sonnet 4.6 (new chat) |
| 7A — panel.html + panel.css | Sonnet 4.6 Thinking (new chat) |
| 7B — panel.js | Sonnet 4.6 Thinking (continue same chat) |
| 8 — Integration test | Debug errors with Opus 4.6 Thinking |

**When context fills up:** New chat + paste context primer + paste current file state + describe what's next.

---

## Phase 0 — Setup

No AI needed. Do this in your terminal.

```bash
# Create project structure
mkdir -p repolens/backend
mkdir -p repolens/extension/panel
mkdir -p repolens/extension/lib
mkdir -p repolens/extension/icons

# Set up backend
cd repolens/backend
python -m venv venv
source venv/bin/activate           # Windows: venv\Scripts\activate

pip install fastapi uvicorn gitpython chromadb google-generativeai python-dotenv tree-sitter-languages

# Create .env file
echo "GEMINI_API_KEY=your_key_here" > .env

# Pin dependencies immediately
pip freeze > requirements.txt

# Verify imports
python -c "import fastapi, chromadb, google.generativeai, tree_sitter_languages; print('All good')"
```

Get your free Gemini API key: https://aistudio.google.com/app/apikey

**Also test Gemini API access before Phase 3:**
```python
import google.generativeai as genai
from dotenv import load_dotenv
import os
load_dotenv()
genai.configure(api_key=os.getenv("GEMINI_API_KEY"))
result = genai.embed_content(model="models/text-embedding-004", content="test", task_type="RETRIEVAL_QUERY")
print(len(result["embedding"]))   # Must print 768
```

**Done when:** Both verify commands output the expected result.

---

## Phase 1 — Repo Crawler

**File:** `backend/crawler.py`
**Dependency:** GitPython
**Chat:** New chat

### Prompt

```
CONTEXT: I'm building RepoLens — a Chrome/Firefox browser extension that lets developers
chat with any GitHub repository using RAG. This is the first backend module.

BUILD: backend/crawler.py

Function signature:
  crawl_repo(repo_url: str, progress_callback=None) -> list[dict]

Requirements:
- Use GitPython to clone the repo to /tmp/repolens/{repo_name}
  where repo_name is the "owner__repo" portion (replace / with __)
- If the directory already exists, skip cloning and use existing
- Do NOT delete the repo after crawling
- Walk all files recursively
- Include ONLY these extensions: .py .js .ts .jsx .tsx .java .go .rs .cpp .c .cs .rb .php .swift .kt .md
- Skip these directories entirely: node_modules .git dist build __pycache__ .venv venv .next out vendor .idea .vscode coverage target
- Skip any single file over 100KB
- For each valid file return a dict:
  { "file_path": absolute_path_string, "relative_path": path_relative_to_repo_root, "language": str, "raw_content": str }
- Encoding: try utf-8 first, fallback to latin-1, if both fail skip the file silently
- If progress_callback is provided, call it after each file:
  progress_callback(files_done: int, total_files: int, current_file: str)
- Return the list of file dicts

Language map (extension → language):
.py=python, .js=javascript, .ts=typescript, .jsx=javascript, .tsx=typescript,
.java=java, .go=go, .rs=rust, .cpp=cpp, .c=c, .cs=csharp, .rb=ruby,
.php=php, .swift=swift, .kt=kotlin, .md=markdown

No argparse. No __main__. Pure module only. Add a module docstring.
```

### Test

```python
from crawler import crawl_repo
files = crawl_repo("https://github.com/tiangolo/fastapi")
print(f"Found {len(files)} files")
print(files[0]['relative_path'], files[0]['language'])
print(files[0]['raw_content'][:100])
```

Expected: 100–300 files, first file has relative path and content.

---

## Phase 2 — Code Chunker

**File:** `backend/parser.py`
**Dependency:** tree-sitter-languages
**Chat:** Continue from Phase 1

### Prompt

```
CONTEXT: RepoLens backend. crawler.py is done and returns file dicts:
{ file_path: str, relative_path: str, language: str, raw_content: str }

BUILD: backend/parser.py

Function signature:
  chunk_files(files: list[dict]) -> list[dict]

Import:
  from tree_sitter_languages import get_language, get_parser

For Python, JavaScript, TypeScript, Java, Go:
  Use tree-sitter to parse the AST and extract functions and classes as individual chunks.
  
  Node types by language:
    Python: "function_definition", "class_definition"
    JS/TS:  "function_declaration", "method_definition", "class_declaration"
    Java:   "method_declaration", "class_declaration"
    Go:     "function_declaration", "method_declaration"

  Each extracted node becomes one chunk.

For all other languages, or if tree-sitter parsing fails for any file:
  Use sliding window fallback:
  - Window: 60 lines
  - Overlap: 10 lines
  - chunk_type = "fallback"
  - name = "chunk_0", "chunk_1", etc.

Each chunk dict must contain:
  chunk_id:    str  → f"{relative_path}::{start_line}"
  file_path:   str  → relative_path (NOT absolute path)
  language:    str
  chunk_type:  str  → "function" | "class" | "module" | "fallback"
  name:        str  → function/class name, or "chunk_N" for fallback
  start_line:  int  → 1-indexed
  end_line:    int
  content:     str  → raw code text of this chunk only

Additional rules:
- If any single chunk is over 150 lines, split it in half
- Wrap all tree-sitter logic in try/except — a bad file must not crash the whole process, fall back to sliding window
- Process all files in the list and return a FLAT list of all chunks combined

No argparse. No __main__. Pure module only. Add a module docstring.
```

### Test

```python
from crawler import crawl_repo
from parser import chunk_files
files = crawl_repo("https://github.com/tiangolo/fastapi")
chunks = chunk_files(files)
print(f"{len(chunks)} chunks from {len(files)} files")
print(chunks[0])
ast_chunks = [c for c in chunks if c['chunk_type'] != 'fallback']
print(f"AST chunks: {len(ast_chunks)}, fallback: {len(chunks) - len(ast_chunks)}")
```

Expected: Thousands of chunks, mix of AST and fallback types.

---

## Phase 3A — Embedder

**File:** `backend/embedder.py`
**Dependency:** google-generativeai, python-dotenv
**Chat:** New chat

### Prompt

```
CONTEXT: RepoLens backend. I'm building the embedding module. parser.py produces chunk dicts:
{ chunk_id, file_path, language, chunk_type, name, start_line, end_line, content }

BUILD: backend/embedder.py

Dependencies: google-generativeai, python-dotenv, time, os

Function 1: build_context_string(chunk: dict) -> str
  Returns this exact format (for embedding — gives the model rich context):
  "File: {file_path}\nLanguage: {language}\nType: {chunk_type}\nName: {name}\nLines: {start_line}-{end_line}\n\n{content}"

Function 2: embed_chunks(chunks: list[dict], progress_callback=None) -> list[dict]
  - Load GEMINI_API_KEY from .env using python-dotenv
  - Configure genai with the key
  - For each chunk: call build_context_string(), then truncate to 8000 characters max
  - Batch into groups of 20
  - For each batch:
    result = genai.embed_content(
      model="models/text-embedding-004",
      content=[context_strings in this batch],
      task_type="RETRIEVAL_DOCUMENT"
    )
    The result["embedding"] is a list of embedding vectors, one per item in the batch.
  - Sleep 1 second between batches (rate limit protection)
  - Add two fields to each chunk: "context_string" (str) and "embedding" (list[float])
  - If progress_callback provided: call it(done, total) after each batch
  - Return the list of chunks with the new fields added

Function 3: embed_query(question: str) -> list[float]
  - Embed a single string with task_type="RETRIEVAL_QUERY"
  - Return the embedding vector as list[float]
  - Do NOT wrap in a list — return the vector directly

No argparse. No __main__. Pure module. Add module docstring.
```

### Test

```python
from embedder import build_context_string, embed_chunks, embed_query

# Test with 3 dummy chunks
dummy_chunks = [
    {"chunk_id": "test.py::1", "file_path": "test.py", "language": "python",
     "chunk_type": "function", "name": "hello", "start_line": 1, "end_line": 5,
     "content": "def hello():\n    return 'world'"},
    {"chunk_id": "test.py::6", "file_path": "test.py", "language": "python",
     "chunk_type": "function", "name": "add", "start_line": 6, "end_line": 8,
     "content": "def add(a, b):\n    return a + b"},
    {"chunk_id": "auth.py::1", "file_path": "auth.py", "language": "python",
     "chunk_type": "function", "name": "login", "start_line": 1, "end_line": 10,
     "content": "def login(user, password):\n    pass"}
]

embedded = embed_chunks(dummy_chunks)
print(f"Embedded {len(embedded)} chunks")
print(f"Embedding dim: {len(embedded[0]['embedding'])}")  # Should be 768

qvec = embed_query("how does authentication work")
print(f"Query vector dim: {len(qvec)}")  # Should be 768
```

---

## Phase 3B — Vector Store

**File:** `backend/vectorstore.py`
**Dependency:** chromadb
**Chat:** Continue from Phase 3A

### Prompt

```
CONTEXT: RepoLens backend. embedder.py is done. It adds "context_string" and "embedding"
fields to each chunk dict. ChromaDB stores and queries these.

BUILD: backend/vectorstore.py

Dependencies: chromadb

Setup at module level:
  import chromadb
  client = chromadb.PersistentClient(path="./chroma_data")

Helper function: _collection_name(repo_url: str) -> str
  - Extract "owner/repo" from any github.com URL
  - Replace "/" with "__"
  - Remove all characters that are NOT alphanumeric or underscore
  - Prepend "repolens_"
  - Example: "https://github.com/tiangolo/fastapi" → "repolens_tiangolo__fastapi"

Function: store_chunks(repo_url: str, chunks: list[dict])
  - Get collection name from _collection_name(repo_url)
  - If collection already exists: delete it first (clean re-index)
  - Create new collection
  - Add chunks in batches of 100 to avoid memory issues:
    collection.add(
      ids=[chunk["chunk_id"]],
      embeddings=[chunk["embedding"]],
      documents=[chunk["context_string"]],
      metadatas=[{
        "chunk_id": chunk["chunk_id"],
        "repo_url": repo_url,
        "repo_name": extracted "owner/repo" string,
        "file_path": chunk["file_path"],
        "language": chunk["language"],
        "chunk_type": chunk["chunk_type"],
        "name": chunk["name"],
        "start_line": chunk["start_line"],
        "end_line": chunk["end_line"]
      }]
    )
  CRITICAL: All metadata values must be str, int, or float — no lists or dicts.

Function: query_chunks(repo_url: str, query_embedding: list[float], top_k: int = 8) -> list[dict]
  - Get collection by name
  - results = collection.query(query_embeddings=[query_embedding], n_results=top_k)
  - Return list of dicts: [{"document": str, "metadata": dict, "distance": float}]
  - Extract from results["documents"][0], results["metadatas"][0], results["distances"][0]

Function: is_indexed(repo_url: str) -> bool
  - Try to get the collection and check collection.count() > 0
  - Return False if collection doesn't exist (catch exception) or is empty

No argparse. No __main__. Pure module.
```

### Test

```python
from embedder import embed_chunks, embed_query
from vectorstore import store_chunks, query_chunks, is_indexed

TEST_URL = "https://github.com/test/repo"

dummy = [
    {"chunk_id": "auth.py::1", "file_path": "auth.py", "language": "python",
     "chunk_type": "function", "name": "verify_token", "start_line": 1, "end_line": 10,
     "content": "def verify_token(token):\n    return jwt.decode(token, SECRET)"}
]
embedded = embed_chunks(dummy)
store_chunks(TEST_URL, embedded)
print("Stored:", is_indexed(TEST_URL))  # True

qvec = embed_query("how does token verification work")
results = query_chunks(TEST_URL, qvec, top_k=1)
print("Result:", results[0]["metadata"]["name"])  # verify_token
```

---

## Phase 4 — RAG Engine

**File:** `backend/rag.py`
**Dependencies:** embedder.py, vectorstore.py, google-generativeai
**Chat:** Continue from Phase 3B

### Prompt

```
CONTEXT: RepoLens backend. embedder.py and vectorstore.py are done.
embed_query() returns a list[float]. query_chunks() returns top-k chunk results.

BUILD: backend/rag.py

Dependencies: google.generativeai, json, os, dotenv

Function: stream_answer(repo_url: str, question: str) -> Generator[str, None, None]
  This is a Python generator that yields SSE-formatted strings.

Steps inside the generator:
1. Extract repo_name = repo_url.replace("https://github.com/", "")

2. Embed the question:
   query_vec = embed_query(question)

3. Retrieve top 8 chunks:
   results = query_chunks(repo_url, query_vec, top_k=8)

4. Build the system prompt string:
   system_prompt = f"""You are RepoLens, a code assistant for the repository: {repo_name}.
You have been given {len(results)} relevant code chunks retrieved from this codebase.
Rules:
- Answer using ONLY the provided chunks. Never invent code.
- Always cite sources as [filename:line_number] inline in your answer.
- If the answer spans multiple files, cite each relevant file.
- Use markdown formatting. Use fenced code blocks for code.
- Be technically precise. Your audience is experienced developers.
- If the chunks don't contain enough to answer, say so clearly. Do not guess."""

5. Build the user message:
   Start with "Question: {question}\n\nCode chunks:\n"
   For each result (numbered 1 to N):
     Append: "--- CHUNK {N} ---\nFile: {metadata.file_path} (lines {metadata.start_line}–{metadata.end_line})\nType: {metadata.chunk_type} | Name: {metadata.name}\n\n{document}\n\n"

6. Call Gemini Flash with streaming:
   genai.configure(api_key=os.getenv("GEMINI_API_KEY"))
   model = genai.GenerativeModel("gemini-1.5-flash")
   response = model.generate_content(
     [system_prompt + "\n\n" + user_message],
     stream=True
   )
   for chunk in response:
     if chunk.text:
       yield f"event: token\ndata: {json.dumps({'text': chunk.text})}\n\n"

7. After streaming completes, build sources list:
   sources = [
     {
       "file": r["metadata"]["file_path"],
       "line": r["metadata"]["start_line"],
       "chunk_type": r["metadata"]["chunk_type"],
       "name": r["metadata"]["name"]
     }
     for r in results
   ]
   yield f"event: sources\ndata: {json.dumps({'sources': sources})}\n\n"
   yield "event: done\ndata: {}\n\n"

8. Wrap the entire generator body in try/except Exception as e:
   yield f"event: error\ndata: {json.dumps({'message': str(e)})}\n\n"

Load dotenv at the top of the module. No argparse. No __main__. Pure module.
```

### Test

```python
import sys
sys.path.insert(0, '.')
from rag import stream_answer

# Only works if you have an indexed repo from Phase 3 test
for event in stream_answer("https://github.com/test/repo", "how does verify_token work"):
    print(event, end='', flush=True)
```

---

## Phase 5 — FastAPI Backend

**File:** `backend/main.py`
**Dependencies:** fastapi, uvicorn, all prior modules
**Chat:** New chat

### Prompt

```
CONTEXT: RepoLens backend. All modules are done:
- crawler.py: crawl_repo(repo_url, progress_callback=None) -> list[dict]
- parser.py: chunk_files(files) -> list[dict]
- embedder.py: embed_chunks(chunks, progress_callback=None) -> list[dict]
- vectorstore.py: store_chunks(repo_url, chunks), is_indexed(repo_url) -> bool
- rag.py: stream_answer(repo_url, question) -> Generator[str, None, None]

BUILD: backend/main.py

Imports needed: fastapi, uvicorn, starlette.responses.StreamingResponse,
fastapi.middleware.cors.CORSMiddleware, threading, uuid, time, json, os
from dotenv import load_dotenv

On startup:
  load_dotenv()

CORS:
  app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
  (Wildcard required — Chrome extension origin is unpredictable during development)

In-memory job store:
  jobs: dict[str, dict] = {}  (job_id → job dict as described in Schema.md)

Job dict fields: job_id, repo_url, repo_name, status, progress, files_processed,
total_files, current_file, elapsed_seconds, error (None or str), started_at (float)

--- ENDPOINT 1: POST /index ---
Body: { repo_url: str }
- Validate: must start with "https://github.com/"
  If not: return 400 {"error": "invalid_url", "message": "..."}
- Check for duplicate: if any job in jobs has same repo_url and status in ["cloning", "parsing", "indexing"]
  Return 409 {"error": "already_indexing", "message": "...", "job_id": existing_job_id}
- Extract repo_name = repo_url.replace("https://github.com/", "")
- Create job_id = uuid.uuid4().hex[:8]
- Create job dict with status="queued", all counts at 0
- Start background threading.Thread(target=run_index_job, args=(job_id,), daemon=True).start()
- Return 202 {"job_id": job_id, "status": "started", "repo_name": repo_name}

Background function run_index_job(job_id):
  job = jobs[job_id]
  try:
    # Update elapsed_seconds every second using a timer thread
    start = time.time()
    def update_elapsed():
      while job["status"] not in ["done", "error"]:
        job["elapsed_seconds"] = int(time.time() - start)
        time.sleep(1)
    threading.Thread(target=update_elapsed, daemon=True).start()

    job["status"] = "cloning"
    
    def file_progress(done, total, current):
      job["files_processed"] = done
      job["total_files"] = total
      job["current_file"] = current
      job["progress"] = int((done / total) * 50) if total > 0 else 0  # first 50% is crawling
    
    files = crawl_repo(job["repo_url"], progress_callback=file_progress)
    
    job["status"] = "parsing"
    chunks = chunk_files(files)
    
    job["status"] = "indexing"
    total_chunks = len(chunks)
    
    def embed_progress(done, total):
      job["files_processed"] = done
      job["total_files"] = total
      job["progress"] = 50 + int((done / total) * 50) if total > 0 else 50  # second 50% is embedding
    
    embedded = embed_chunks(chunks, progress_callback=embed_progress)
    store_chunks(job["repo_url"], embedded)
    
    job["status"] = "done"
    job["progress"] = 100
  except Exception as e:
    job["status"] = "error"
    job["error"] = str(e)

--- ENDPOINT 2: GET /status/{job_id} ---
- Return jobs[job_id] as JSON
- 404 if not found: {"error": "not_found", "message": "Job not found"}

--- ENDPOINT 3: POST /query ---
Body: { repo_url: str, question: str }
- Check is_indexed(repo_url). If not: return 400 {"error": "not_indexed", "message": "..."}
- Return StreamingResponse(
    stream_answer(repo_url, question),
    media_type="text/event-stream",
    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
  )

--- ENDPOINT 4: GET /health ---
Return {"status": "ok", "version": "1.0.0"}

Run with: uvicorn main:app --reload --port 8000
```

### Test

```bash
# In one terminal: start the backend
cd backend && uvicorn main:app --reload

# In another terminal:
curl http://localhost:8000/health

curl -X POST http://localhost:8000/index \
  -H "Content-Type: application/json" \
  -d '{"repo_url": "https://github.com/tiangolo/fastapi"}'
# Note the job_id

curl http://localhost:8000/status/JOBID_HERE
# Watch progress update every few seconds

# After status is "done":
curl -X POST http://localhost:8000/query \
  -H "Content-Type: application/json" \
  -d '{"repo_url": "https://github.com/tiangolo/fastapi", "question": "How does dependency injection work?"}'
```

---

## Phase 6 — Extension Shell

**Files:** `extension/manifest.json`, `extension/background.js`, `extension/content.js`
**Chat:** New chat

### Prompt

```
CONTEXT: I'm building RepoLens — a browser extension that injects a chat panel into GitHub
pages. The panel communicates with a local FastAPI backend at localhost:8000.

BUILD: Three files — extension/manifest.json, extension/background.js, extension/content.js

--- manifest.json ---
{
  "manifest_version": 3,
  "name": "RepoLens",
  "version": "1.0.0",
  "description": "Chat with any GitHub repository using AI",
  "permissions": ["activeTab", "storage", "scripting"],
  "host_permissions": ["https://github.com/*", "http://localhost:8000/*"],
  "content_scripts": [{
    "matches": ["https://github.com/*/*"],
    "js": ["lib/browser-polyfill.min.js", "content.js"],
    "run_at": "document_idle"
  }],
  "background": { "service_worker": "background.js" },
  "browser_specific_settings": {
    "gecko": { "id": "repolens@extension", "strict_min_version": "109.0" }
  }
}

--- background.js ---
Listen for chrome.runtime.onMessage. Handle these message types:

"GET_REPO_STATUS": { repo_url: string }
  Read chrome.storage.local key "indexed_repos", return entry for repo_url or null.
  sendResponse(data.indexed_repos?.[message.repo_url] || null)

"SET_REPO_STATUS": { repo_url: string, data: object }
  Read current "indexed_repos" from storage, add/update entry for repo_url, write back.
  sendResponse({ ok: true })

"GET_CHAT_HISTORY": { key: string }
  Read chrome.storage.session[key], return array or [].
  sendResponse(result || [])

"SET_CHAT_HISTORY": { key: string, messages: array }
  Write to chrome.storage.session: { [key]: messages }
  sendResponse({ ok: true })

IMPORTANT: Return true from the onMessage listener to support async sendResponse.

--- content.js ---
On page load:
1. Check if URL matches valid GitHub repo:
   const repoRegex = /^https:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)(\/(?!issues|pulls|settings|actions|wiki|security|graphs|pulse|notifications).*)?$/
   
2. If no match: do nothing.

3. If match:
   a. Extract owner and repo from regex groups
   b. const repoUrl = `https://github.com/${owner}/${repo}`
   
   c. Inject trigger button:
      Create div id="rl-trigger" with text "</>"
      Append to document.body
   
   d. Inject panel container:
      Create div id="rl-panel-container"
      Set attribute: data-repo-url = repoUrl
      Append to document.body
   
   e. Load panel CSS:
      Create link element, rel="stylesheet"
      href = chrome.runtime.getURL("panel/panel.css")
      Append to document.head
   
   f. On trigger button click:
      If panel is already mounted: toggle visibility class "open"
      If panel not yet mounted:
        Fetch panel HTML: fetch(chrome.runtime.getURL("panel/panel.html"))
        Set innerHTML of #rl-panel-container to the HTML
        Load panel JS: create script element, src = chrome.runtime.getURL("panel/panel.js"), append to document.head
        Add class "open" to #rl-panel-container

4. Handle GitHub SPA navigation:
   document.addEventListener("turbo:load", recheckURL)  (GitHub uses Turbo)
   window.addEventListener("popstate", recheckURL)
   
   recheckURL():
     If new URL no longer matches repo pattern: remove trigger and panel from DOM
     If URL changes to a different repo: update data-repo-url, dispatch "rl:repo-changed" event

Only inject button and panel once — check if #rl-trigger already exists.
```

### Test

1. Load the extension: `chrome://extensions` → Enable Developer Mode → Load Unpacked → select `extension/` folder
2. Navigate to `https://github.com/tiangolo/fastapi`
3. Verify: `</>` button appears in bottom-right corner
4. Open DevTools console — check for any errors
5. Navigate to `github.com/tiangolo` (profile page) — button should NOT appear
6. Navigate to `github.com/tiangolo/fastapi/issues` — button should NOT appear

---

## Phase 7A — Panel HTML + CSS

**Files:** `extension/panel/panel.html`, `extension/panel/panel.css`
**Chat:** New chat

### Prompt

```
CONTEXT: RepoLens browser extension. The panel is injected into GitHub pages as a
380px fixed sidebar. It has 4 states: OFFLINE, NOT_INDEXED, INDEXING, READY.

CRITICAL DESIGN RULES (from Design.md):
- Colors: --bg-primary: #0d1117, --bg-surface: #161b22, --bg-hover: #1c2128,
  --border: #30363d, --text-primary: #e6edf3, --text-secondary: #8b949e,
  --text-muted: #484f58, --accent: #58a6ff, --success: #3fb950, --warning: #d29922,
  --error: #f85149, --code-bg: #1c2128
- Fonts: Inter for UI, JetBrains Mono for code/paths/percentages
- NO gradients. NO box-shadows on the panel. NO glow effects.
- Panel: position fixed, right 0, top 0, width 380px, 100vh. Border-left: 1px solid #30363d.
- Panel starts with transform: translateX(100%). JS adds class "open" to slide it in.

BUILD: panel/panel.html and panel/panel.css

panel.html:
Container: div id="rl-container" (the panel itself, all: initial to isolate from GitHub CSS)

HEADER (always visible, 48px):
  - Left: span id="rl-status-dot" (8px circle) + "RepoLens " (gray 12px) + span id="rl-repo-name" (white 13px, truncated)
  - Right: button id="rl-close" with "×"

STATE DIVS (only one visible at a time, controlled by class "active"):
  id="state-offline":
    ⚠ icon (#d29922), "Backend not running" heading (14px 600 #e6edf3)
    "Start the RepoLens backend to use this extension." (12px #8b949e)
    Code block: <code>uvicorn main:app --reload</code> styled with bg #1c2128 border #30363d
    Button id="rl-copy-cmd": "Copy command" (12px #58a6ff, no background)

  id="state-not-indexed":
    p id="rl-repo-display" (15px 600 #e6edf3)
    p: "This repository hasn't been indexed yet." (12px #8b949e)
    p id="rl-file-estimate": "~? files · est. ? min" (JetBrains Mono 11px #8b949e)
    button id="rl-index-btn": "Index Repository" (full width, height 36px, bg #238636, white text)

  id="state-indexing":
    p: "Indexing repository..." (13px #8b949e)
    div id="rl-progress-track" (height 4px bg #30363d border-radius 2px) containing
      div id="rl-progress-fill" (height 100%, bg #58a6ff, transition width 0.3s)
    div.stats-row:
      span id="rl-files-count" left (JetBrains Mono 11px #8b949e)
      span id="rl-progress-pct" right (Inter 12px 600 #e6edf3)
    p id="rl-current-file" (JetBrains Mono 11px #484f58, overflow ellipsis, prepend "↳ ")
    p id="rl-elapsed" (JetBrains Mono 11px #484f58)

  id="state-ready":
    div id="rl-messages" (flex column, overflow-y auto, fills remaining height)
    button id="rl-map-btn": "Map Repo" (small, subtle — border 1px solid #30363d, bg transparent, #8b949e text, 11px)

INPUT BAR (56px, flex-shrink 0, only visible when state-ready is active):
  div id="rl-input-bar":
    textarea id="rl-input" placeholder="Ask about this codebase..."
    button id="rl-send" (→ arrow SVG, 16px)

Load scripts at bottom: panel/panel.js (defer)
Load from lib: lib/marked.min.js, lib/highlight.min.js

panel.css:
- Define all --color CSS variables at :root
- Panel: all: initial on #rl-container to isolate from GitHub CSS
- Then apply all design spec styles
- Scrollbar: scrollbar-width thin, scrollbar-color #30363d transparent
- No animations except: fadeIn for messages (0.15s), progress bar transition, panel slide
- Input bar only visible when #state-ready is active (use CSS: #state-ready.active ~ #rl-input-bar { display: flex; })
```

### Test

Open `panel.html` directly in a browser. Manually add class "active" to each state div and verify the visual matches Design.md.

---

## Phase 7B — Panel JavaScript

**File:** `extension/panel/panel.js`
**Chat:** Continue from Phase 7A

### Prompt

```
CONTEXT: RepoLens panel. panel.html and panel.css are complete. background.js handles
storage via chrome.runtime.sendMessage. Backend is at http://localhost:8000.

BUILD: panel/panel.js

State machine: exactly 4 states: OFFLINE, NOT_INDEXED, INDEXING, READY
showState(stateName): hides all state divs, shows the one matching stateName by adding class "active".

On init (DOMContentLoaded or immediate if DOM already ready):
1. const container = document.getElementById("rl-container")
   const repoUrl = container.dataset.repoUrl
   const repoName = repoUrl.replace("https://github.com/", "")
   document.getElementById("rl-repo-name").textContent = repoName
   document.getElementById("rl-repo-display").textContent = repoName

2. Health check:
   try {
     const r = await fetch("http://localhost:8000/health", { signal: AbortSignal.timeout(3000) })
     if (!r.ok) throw new Error("unhealthy")
   } catch {
     showState("OFFLINE")
     updateStatusDot("offline")
     return
   }

3. Check storage:
   chrome.runtime.sendMessage({ type: "GET_REPO_STATUS", repo_url: repoUrl }, (entry) => {
     if (entry && entry.status === "done") {
       const age = Date.now() / 1000 - entry.indexed_at
       if (age < 86400) {  // 24 hours
         showState("READY")
         updateStatusDot("ready")
         loadChatHistory()
         return
       }
     }
     showState("NOT_INDEXED")
     updateStatusDot("idle")
     fetchFileEstimate(repoUrl)
   })

fetchFileEstimate(repoUrl):
  Extract owner/repo, call https://api.github.com/repos/{owner}/{repo}
  Use response.size (KB) to estimate file count: Math.round(size / 10) capped at 1000
  Estimate minutes: Math.max(1, Math.round(fileCount / 100))
  Update #rl-file-estimate text

"Index Repository" button click:
  const r = await fetch("http://localhost:8000/index", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ repo_url: repoUrl })
  })
  const { job_id } = await r.json()
  showState("INDEXING")
  updateStatusDot("indexing")
  startPolling(job_id)

startPolling(jobId):
  const interval = setInterval(async () => {
    const r = await fetch(`http://localhost:8000/status/${jobId}`)
    const job = await r.json()
    
    document.getElementById("rl-progress-fill").style.width = job.progress + "%"
    document.getElementById("rl-progress-pct").textContent = job.progress + "%"
    document.getElementById("rl-files-count").textContent = `${job.files_processed} / ${job.total_files} files`
    document.getElementById("rl-current-file").textContent = "↳ " + job.current_file
    const m = Math.floor(job.elapsed_seconds / 60)
    const s = String(job.elapsed_seconds % 60).padStart(2, "0")
    document.getElementById("rl-elapsed").textContent = `Elapsed: ${m}:${s}`
    
    if (job.status === "done") {
      clearInterval(interval)
      chrome.runtime.sendMessage({
        type: "SET_REPO_STATUS",
        repo_url: repoUrl,
        data: { indexed_at: Date.now() / 1000, job_id: jobId, file_count: job.total_files, status: "done" }
      })
      showState("READY")
      updateStatusDot("ready")
    } else if (job.status === "error") {
      clearInterval(interval)
      document.getElementById("rl-current-file").textContent = "Error: " + job.error
      document.getElementById("rl-current-file").style.color = "var(--error)"
      setTimeout(() => { showState("NOT_INDEXED"); updateStatusDot("idle") }, 3000)
    }
  }, 1500)

Chat — sendQuestion(question):
  Disable send button, disable input
  Append user message div to #rl-messages
  Create assistant message div, append to #rl-messages
  let fullText = ""
  let sources = []
  
  const response = await fetch("http://localhost:8000/query", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ repo_url: repoUrl, question }),
    signal: AbortSignal.timeout(60000)
  })
  
  Parse SSE from response.body ReadableStream:
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const events = buffer.split("\n\n")
    buffer = events.pop()
    
    for (const event of events) {
      const lines = event.trim().split("\n")
      const eventType = lines.find(l => l.startsWith("event:"))?.replace("event:", "").trim()
      const dataLine = lines.find(l => l.startsWith("data:"))?.replace("data:", "").trim()
      if (!dataLine) continue
      const data = JSON.parse(dataLine)
      
      if (eventType === "token") {
        fullText += data.text
        assistantDiv.innerHTML = marked.parse(fullText)
        assistantDiv.querySelectorAll("pre code").forEach(el => hljs.highlightElement(el))
        scrollToBottom()
      } else if (eventType === "sources") {
        sources = data.sources
      } else if (eventType === "done") {
        renderCitations(sources, assistantDiv)
        saveToHistory(repoUrl, question, fullText, sources)
      } else if (eventType === "error") {
        assistantDiv.textContent = "Error: " + data.message
        assistantDiv.style.color = "var(--error)"
      }
    }
  }
  
  Enable send button, clear input

renderCitations(sources, parentDiv):
  Create div.rl-citations, append after parentDiv
  For each source: create <a> chip with text "filename:line"
  href = `https://github.com/${repoName}/blob/main/${source.file}#L${source.line}`
  target="_blank"

"Map Repo" button:
  sendQuestion("Give me a plain-English architecture overview of this repository. Explain what each top-level folder does, where the main entry points are, and how data flows through the system.")
  (This bypasses the empty-input check — call sendQuestion directly)

Send button / Enter key (Shift+Enter = newline):
  const q = input.value.trim()
  if (!q) return
  input.value = ""
  sendQuestion(q)

Close button:
  document.getElementById("rl-panel-container").classList.remove("open")

Copy command button (OFFLINE state):
  navigator.clipboard.writeText("uvicorn main:app --reload")
  button.textContent = "Copied!"
  setTimeout(() => button.textContent = "Copy command", 2000)

updateStatusDot(state):
  const dot = document.getElementById("rl-status-dot")
  dot.style.background = {
    "idle": "#484f58",
    "indexing": "#d29922",
    "ready": "#3fb950",
    "offline": "#f85149"
  }[state]

loadChatHistory():
  chrome.runtime.sendMessage({ type: "GET_CHAT_HISTORY", key: "chat_" + repoUrl }, (messages) => {
    (messages || []).forEach(msg => appendMessage(msg.role, msg.content, msg.sources))
    scrollToBottom()
  })

saveToHistory(repoUrl, question, answer, sources):
  chrome.runtime.sendMessage({ type: "GET_CHAT_HISTORY", key: "chat_" + repoUrl }, (existing) => {
    const messages = existing || []
    messages.push({ role: "user", content: question, timestamp: Date.now() })
    messages.push({ role: "assistant", content: answer, sources, timestamp: Date.now() })
    chrome.runtime.sendMessage({ type: "SET_CHAT_HISTORY", key: "chat_" + repoUrl, messages })
  })

scrollToBottom():
  const m = document.getElementById("rl-messages")
  m.scrollTop = m.scrollHeight
```

---

## Phase 8 — Integration Test

Full end-to-end test. Run this before any polish or GitHub publish.

```
1. Backend running: cd backend && uvicorn main:app --reload
2. Extension loaded in Chrome: chrome://extensions → Load unpacked → extension/
3. Navigate to: https://github.com/tiangolo/fastapi

Tests:
A. Button visible in bottom-right ✓
B. Click button → panel slides in ✓
C. Health check passes → NOT_INDEXED state shows ✓
D. File estimate appears ✓
E. Click "Index Repository" → INDEXING state, progress bar moves ✓
F. Wait for completion → READY state ✓
G. Ask: "How does dependency injection work?" → answer streams in ✓
H. Citation chips appear ✓
I. Click citation → correct GitHub file opens at correct line ✓
J. Ask 2 more questions → history maintained in panel ✓
K. Reload page → open panel → READY state immediately (cache hit) ✓
L. Chat history still visible ✓
M. Click "Map Repo" → architecture overview streams in ✓
N. Navigate to /issues page → button disappears ✓
O. Navigate back to repo → button reappears ✓

If anything fails: paste the error + the relevant file into Opus 4.6 Thinking chat.
```

---

## Build Order Summary

```
Phase 0: Setup → requirements.txt → Gemini API test
Phase 1: crawler.py → test with fastapi repo
Phase 2: parser.py → test chunk count and types
Phase 3A: embedder.py → test with 3 dummy chunks
Phase 3B: vectorstore.py → test store + query
Phase 4: rag.py → test stream_answer() in Python
Phase 5: main.py → test all 4 curl commands
Phase 6: Extension shell → test button injection in Chrome
Phase 7A: panel.html + panel.css → visual check in browser
Phase 7B: panel.js → connect to backend, full UI test
Phase 8: Full integration test
```

Estimated time: 2–4 focused sessions in Antigravity.
