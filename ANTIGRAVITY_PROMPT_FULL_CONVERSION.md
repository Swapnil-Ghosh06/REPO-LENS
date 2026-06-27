# RepoLens — Full Conversion Prompt for Antigravity
# Python Backend → Serverless Chrome Extension (No Terminal, No Backend)

---

## CONTEXT — What this project is

RepoLens is a Chrome extension that lets users chat with any GitHub repository using AI. Currently it requires a Python FastAPI backend running on localhost:8000. The goal of this task is to eliminate the backend entirely so the extension works standalone — no terminal, no server, ever.

---

## WHAT YOU ARE BUILDING

Convert RepoLens from a Python-backend architecture to a fully self-contained Chrome extension (Manifest V3). All logic currently in Python must be rewritten in JavaScript and run inside the extension's background service worker.

The extension already exists at `repolens/extension/`. You are rewriting and adding to it. You are NOT creating a new project.

---

## FILES YOU WILL MODIFY OR CREATE

### Files to REWRITE completely:
- `repolens/extension/background.js` — this becomes the entire backend (crawler + embedder + RAG + storage)
- `repolens/extension/manifest.json` — add host_permissions for all APIs

### Files to LEAVE UNCHANGED:
- `repolens/extension/panel/panel.js` — but you MUST update the 3 places where it calls localhost:8000 (see below)
- `repolens/extension/panel/panel.html` — do not touch
- `repolens/extension/panel/panel.css` — do not touch
- `repolens/extension/content.js` — do not touch
- All icon files — do not touch

### New file to CREATE:
- `repolens/extension/lib/idb.js` — a minimal IndexedDB wrapper (see spec below)

---

## API KEYS — STORAGE & RETRIEVAL

The user stores their API keys in `chrome.storage.local` under these exact keys:
```
GEMINI_API_KEY
GROQ_API_KEY
GROQ_API_KEY_2       ← secondary Groq account (different rate limit pool)
COHERE_API_KEY
```

Keys are saved via a settings UI (you do not need to build the settings UI — just read from storage). Load them at the start of every operation like this:

```javascript
async function getKeys() {
  return new Promise(resolve => {
    chrome.storage.local.get(
      ['GEMINI_API_KEY', 'GROQ_API_KEY', 'GROQ_API_KEY_2', 'COHERE_API_KEY'],
      resolve
    );
  });
}
```

---

## MANIFEST.JSON — REQUIRED CHANGES

Replace the existing `host_permissions` array with:

```json
"host_permissions": [
  "https://github.com/*",
  "https://api.github.com/*",
  "https://generativelanguage.googleapis.com/*",
  "https://api.groq.com/*",
  "https://api.cohere.com/*",
  "https://raw.githubusercontent.com/*"
]
```

Remove these (no longer needed — localhost backend is gone):
```json
"http://localhost:8000/*",
"http://127.0.0.1:8000/*"
```

Add `"unlimitedStorage"` to permissions array (IndexedDB for vector storage needs this):
```json
"permissions": [
  "activeTab",
  "storage",
  "scripting",
  "alarms",
  "unlimitedStorage"
]
```

---

## PART 1 — idb.js (NEW FILE: repolens/extension/lib/idb.js)

Create a minimal IndexedDB wrapper that background.js will import. It must expose these functions:

```javascript
// Opens (or upgrades) the RepoLens database
async function openDB()

// Store an array of chunk objects for a repo
// Each chunk: { chunk_id, repo_url, embedding: Float32Array, document: string, metadata: object }
async function storeChunks(repoUrl, chunks)

// Delete all chunks for a repo (called before re-indexing)
async function deleteChunks(repoUrl)

// Return all chunks for a repo as an array
async function getChunks(repoUrl)

// Store provider used for a repo ("gemini" or "cohere")
async function setProvider(repoUrl, provider)

// Get provider for a repo (returns "gemini" by default)
async function getProvider(repoUrl)

// Check if a repo has any stored chunks
async function isIndexed(repoUrl)
```

Database schema:
- DB name: `"RepoLensDB"`, version: `1`
- Object store: `"chunks"`, keyPath: `"chunk_id"`, with index `"by_repo"` on `"repo_url"` (non-unique)
- Object store: `"meta"`, keyPath: `"key"` — used for storing provider per repo (key = `"provider::" + repoUrl`)

---

## PART 2 — COSINE SIMILARITY (in background.js)

Add this utility function. It will be used during RAG retrieval:

```javascript
function cosineSimilarity(vecA, vecB) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot   += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

---

## PART 3 — GITHUB CRAWLER (in background.js)

Replaces `crawler.py`. Uses the GitHub Contents API — no git clone needed.

### Supported extensions (same as Python):
`.py .js .ts .jsx .tsx .java .go .rs .cpp .c .cs .rb .php .swift .kt .md`

### Skip directories (same as Python):
`node_modules .git dist build __pycache__ .venv venv .next out vendor .idea .vscode coverage target`

### Language map (same as Python):
`.py→python .js→javascript .ts→typescript .jsx→javascript .tsx→typescript .java→java .go→go .rs→rust .cpp→cpp .c→c .cs→csharp .rb→ruby .php→php .swift→swift .kt→kotlin .md→markdown`

### Implementation:

```javascript
async function crawlRepo(repoUrl, progressCallback) {
  // 1. Extract owner/repo from URL
  // 2. Use GitHub API: GET /repos/{owner}/{repo}/git/trees/HEAD?recursive=1
  //    This returns the FULL file tree in one request — much faster than recursive ls
  // 3. Filter files by supported extension and skip dirs
  // 4. Skip files > 100KB (check size field in tree response)
  // 5. Cap at 500 files — throw Error if exceeded
  // 6. For each file, fetch raw content: GET https://raw.githubusercontent.com/{owner}/{repo}/HEAD/{path}
  //    Fetch in parallel with concurrency limit of 5 at a time
  // 7. Call progressCallback(done, total, currentFile) after each file
  // 8. Return array of: { relative_path, language, raw_content }
}
```

GitHub API calls must include header: `Accept: application/vnd.github+json`
If the user has a GitHub token stored as `GITHUB_TOKEN` in chrome.storage.local, include it as `Authorization: Bearer {token}` — but do NOT require it. Anonymous requests work for public repos.

---

## PART 4 — CODE CHUNKER (in background.js)

Replaces `parser.py`. JavaScript cannot use tree-sitter (native binary). Use the sliding window fallback for ALL languages — this is fine because tree-sitter was only a minor improvement for Python/JS/TS/Java/Go anyway.

```javascript
function chunkFiles(files) {
  // For each file, apply sliding window chunking:
  // Window: 60 lines, Overlap: 10 lines, Step: 50 lines
  // Max chunk size: 150 lines — bisect if exceeded
  // Returns flat array of chunk objects:
  // { chunk_id, relative_path, language, chunk_type: "fallback",
  //   name: "chunk_N", start_line, end_line, content }
  // chunk_id = relative_path + "::" + start_line
}
```

---

## PART 5 — EMBEDDING ENGINE (in background.js)

Replaces `embedder.py`. This is the most critical section. Implement EXACTLY as described.

### Circuit breaker:
```javascript
let _geminiDeadUntil = 0; // epoch ms; 0 = not tripped

function geminiIsDead() { return Date.now() < _geminiDeadUntil; }
function killGeminiFor60Min() {
  _geminiDeadUntil = Date.now() + 60 * 60 * 1000;
  console.warn('[CIRCUIT BREAKER] Gemini killed for 60 min. Switching to Cohere.');
}
```

### Gemini embedding function:
```javascript
async function embedWithGemini(texts, taskType, apiKey) {
  // POST https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents?key={apiKey}
  // Body: { requests: texts.map(text => ({ model: "models/gemini-embedding-001", content: { parts: [{ text }] }, taskType })) }
  // taskType is "RETRIEVAL_DOCUMENT" for indexing, "RETRIEVAL_QUERY" for querying
  // Returns: array of float arrays (one per text)
  // On 429 or RESOURCE_EXHAUSTED: throw new Error("GEMINI_RATE_LIMIT")
  // Gemini embedding-001 returns 3072-dimensional vectors
}
```

### Cohere embedding function:
```javascript
async function embedWithCohere(texts, inputType, apiKey) {
  // POST https://api.cohere.com/v2/embed
  // Headers: Authorization: Bearer {apiKey}, Content-Type: application/json
  // Body: { texts, model: "embed-english-v3.0", input_type: inputType, embedding_types: ["float"] }
  // inputType is "search_document" for indexing, "search_query" for querying
  // Returns: array of float arrays from response.embeddings.float
  // Cohere embed-english-v3.0 returns 1024-dimensional vectors
  // On any error: throw with descriptive message
}
```

### Main indexing embedder — FALLBACK CHAIN:
```javascript
async function embedChunks(chunks, repoName, progressCallback) {
  // Returns array of chunks with .embedding added, and .provider set to "gemini" or "cohere"
  
  const keys = await getKeys();
  
  // If circuit breaker tripped → go straight to Cohere
  if (geminiIsDead()) {
    return await _embedChunksCohere(chunks, repoName, progressCallback, keys.COHERE_API_KEY);
  }
  
  // Try Gemini first
  try {
    return await _embedChunksGemini(chunks, repoName, progressCallback, keys.GEMINI_API_KEY);
  } catch (e) {
    if (e.message.includes("GEMINI_RATE_LIMIT")) {
      console.warn('[PLAN B] Gemini exhausted. Switching to Cohere...');
      killGeminiFor60Min();
      return await _embedChunksCohere(chunks, repoName, progressCallback, keys.COHERE_API_KEY);
    }
    throw e;
  }
}
```

### _embedChunksGemini implementation:
- Build context string per chunk: `File: {relative_path}\nLanguage: {language}\nType: {chunk_type}\nName: {name}\nLines: {start_line}-{end_line}\nRepo: {repoName}\n\n{content}`
- Truncate content so total context string is under 8000 chars
- Batch in groups of 100 chunks maximum, and max 40,000 total chars per batch
- On 429 → retry once after 15s → if still 429 → throw Error("GEMINI_RATE_LIMIT")
- Between batches: wait 1 second
- Call progressCallback(done, total) after each batch
- Tag each chunk with provider: "gemini"

### _embedChunksCohere implementation:
- Same context string logic as Gemini
- Batch in groups of 90 (Cohere max is 96)
- inputType: "search_document"
- Wait 0.5s between batches
- Tag each chunk with provider: "cohere"
- On batch failure: log warning, skip batch (don't throw)

### Query embedding — MUST MATCH PROVIDER:
```javascript
async function embedQuery(question, provider) {
  // CRITICAL: must use the same provider that indexed the repo
  // Gemini and Cohere produce DIFFERENT dimensions (3072 vs 1024)
  // Mixing them in the same vector store causes wrong similarity scores
  
  const keys = await getKeys();
  
  if (provider === "cohere") {
    return await embedWithCohere([question], "search_query", keys.COHERE_API_KEY);
    // returns first vector
  }
  
  // provider === "gemini"
  if (geminiIsDead()) {
    throw new Error("GEMINI_RATE_LIMIT: Circuit breaker active. Repo was indexed with Gemini. Please wait and retry.");
  }
  
  try {
    const vecs = await embedWithGemini([question], "RETRIEVAL_QUERY", keys.GEMINI_API_KEY);
    return vecs[0];
  } catch (e) {
    if (e.message.includes("GEMINI_RATE_LIMIT")) throw e; // re-throw — caller handles it
    throw e;
  }
}
```

---

## PART 6 — RAG ENGINE (in background.js)

Replaces `rag.py`. Returns a ReadableStream that emits SSE-formatted strings.

### LLM fallback chain — GROQ PRIMARY → GROQ_2 SECONDARY → GEMINI FALLBACK:

```javascript
async function streamFromLLM(systemPrompt, userMessage, onToken) {
  // onToken(text) is called for each streamed token
  // Returns true if successful, false if all providers failed
  
  const keys = await getKeys();
  
  // Try Groq primary key first
  if (keys.GROQ_API_KEY) {
    const ok = await tryGroq(keys.GROQ_API_KEY, systemPrompt, userMessage, onToken);
    if (ok) return true;
  }
  
  // Try Groq secondary key (different account = separate rate limit)
  if (keys.GROQ_API_KEY_2) {
    console.warn('[LLM] Groq primary failed. Trying secondary Groq key...');
    const ok = await tryGroq(keys.GROQ_API_KEY_2, systemPrompt, userMessage, onToken);
    if (ok) return true;
  }
  
  // Final fallback: Gemini
  console.warn('[LLM] Both Groq keys failed. Falling back to Gemini...');
  if (keys.GEMINI_API_KEY) {
    return await tryGeminiLLM(keys.GEMINI_API_KEY, systemPrompt, userMessage, onToken);
  }
  
  return false;
}
```

### Groq streaming:
```javascript
async function tryGroq(apiKey, systemPrompt, userMessage, onToken) {
  // POST https://api.groq.com/openai/v1/chat/completions
  // Headers: Authorization: Bearer {apiKey}, Content-Type: application/json
  // Body: {
  //   model: "llama-3.3-70b-versatile",
  //   messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
  //   stream: true,
  //   temperature: 0.2,
  //   max_tokens: 4096
  // }
  // Parse the SSE stream: each "data: {...}" line → JSON.parse → choices[0].delta.content
  // Call onToken(text) for each token
  // On 429 or any error: return false (do not throw)
  // On success: return true
}
```

### Gemini LLM fallback:
```javascript
async function tryGeminiLLM(apiKey, systemPrompt, userMessage, onToken) {
  // POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key={apiKey}
  // Body: { contents: [{ role: "user", parts: [{ text: systemPrompt + "\n\n" + userMessage }] }] }
  // Parse SSE stream → candidates[0].content.parts[0].text
  // Call onToken(text) for each chunk
  // On 429: return false
  // On success: return true
}
```

### Main RAG function:
```javascript
async function* ragStreamAnswer(repoUrl, question) {
  // This is an async generator that yields SSE strings
  // Same SSE format as the old Python backend:
  //   event: token\ndata: {"text": "..."}\n\n
  //   event: sources\ndata: {"sources": [...]}\n\n
  //   event: done\ndata: {}\n\n
  //   event: error\ndata: {"message": "rate_limit", "user_message": "..."}\n\n
  
  // Step 1: get provider for this repo
  const provider = await getProvider(repoUrl);
  
  // Step 2: embed the query with the SAME provider used for indexing
  let queryVec;
  try {
    queryVec = await embedQuery(question, provider);
  } catch (e) {
    if (e.message.includes("GEMINI_RATE_LIMIT")) {
      yield `event: error\ndata: ${JSON.stringify({
        message: "rate_limit",
        user_message: "Gemini embedding is rate-limited. This repo was indexed with Gemini so we need Gemini to search it. Please wait a minute and try again."
      })}\n\n`;
      return;
    }
    yield `event: error\ndata: ${JSON.stringify({ message: String(e) })}\n\n`;
    return;
  }
  
  // Step 3: retrieve top 8 chunks from IndexedDB using cosine similarity
  const allChunks = await getChunks(repoUrl);
  if (!allChunks.length) {
    yield `event: error\ndata: ${JSON.stringify({ message: "no_results", user_message: "No chunks found. Please re-index this repository." })}\n\n`;
    return;
  }
  
  const scored = allChunks
    .map(chunk => ({ ...chunk, score: cosineSimilarity(queryVec, chunk.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  
  // Step 4: build prompt
  const repoName = repoUrl.replace("https://github.com/", "");
  const systemPrompt = `You are RepoLens, a code assistant for the repository: ${repoName}.
You have been given ${scored.length} relevant code chunks retrieved from this codebase.
Rules:
- Base your answer primarily on the provided chunks.
- If the chunks do NOT contain enough information, you may use general programming knowledge but MUST state this clearly.
- Do NOT cite sources inline. Provide clear, plain-English explanations.
- Use markdown formatting. Use fenced code blocks for code.
- Be technically precise. Your audience is experienced developers.`;

  let userMessage = `Question: ${question}\n\nCode chunks:\n`;
  for (let i = 0; i < scored.length; i++) {
    const m = scored[i].metadata;
    userMessage += `--- CHUNK ${i+1} ---\nFile: ${m.relative_path} (lines ${m.start_line}-${m.end_line})\nType: ${m.chunk_type} | Name: ${m.name}\n\n${scored[i].document}\n\n`;
  }
  
  // Step 5: stream LLM response
  const tokens = [];
  const onToken = (text) => {
    tokens.push(text);
  };
  
  // We need to yield tokens as they come — use a queue + generator pattern
  // Implementation: collect all tokens then yield (simpler, acceptable latency for extensions)
  // For true streaming: use a MessageChannel or port to send tokens back to panel.js
  
  const success = await streamFromLLM(systemPrompt, userMessage, onToken);
  
  if (!success) {
    yield `event: error\ndata: ${JSON.stringify({
      message: "rate_limit",
      user_message: "All AI providers are currently rate-limited. Please wait a minute and try again."
    })}\n\n`;
    return;
  }
  
  // Yield collected tokens
  for (const text of tokens) {
    yield `event: token\ndata: ${JSON.stringify({ text })}\n\n`;
  }
  
  // Step 6: build sources
  const sources = scored.map(chunk => ({
    github_url: `https://github.com/${repoName}/blob/main/${chunk.metadata.relative_path}#L${chunk.metadata.start_line}`,
    relative_path: chunk.metadata.relative_path,
    line: chunk.metadata.start_line,
    chunk_type: chunk.metadata.chunk_type,
    name: chunk.metadata.name,
  }));
  
  yield `event: sources\ndata: ${JSON.stringify({ sources })}\n\n`;
  yield `event: done\ndata: {}\n\n`;
}
```

---

## PART 7 — MESSAGE ROUTER (in background.js)

Replace the existing `chrome.runtime.onMessage` listener. Add new message types for the converted pipeline while keeping ALL existing storage message types intact:

```javascript
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
  
    // ── KEEP ALL EXISTING HANDLERS (copy them exactly) ──────────────────────
    case "GET_REPO_STATUS": { ... }   // keep as-is
    case "SET_REPO_STATUS": { ... }   // keep as-is
    case "GET_CHAT_HISTORY": { ... }  // keep as-is
    case "SET_CHAT_HISTORY": { ... }  // keep as-is
    
    // ── NEW: Settings — save API keys ────────────────────────────────────────
    case "SAVE_KEYS": {
      chrome.storage.local.set(message.keys, () => sendResponse({ ok: true }));
      return true;
    }
    
    // ── NEW: Health check (replaces GET /health) ─────────────────────────────
    case "HEALTH_CHECK": {
      chrome.storage.local.get(
        ['GEMINI_API_KEY', 'GROQ_API_KEY', 'GROQ_API_KEY_2', 'COHERE_API_KEY'],
        (keys) => sendResponse({
          status: "ok",
          gemini_key_set: !!keys.GEMINI_API_KEY,
          groq_key_set: !!keys.GROQ_API_KEY,
          groq_key_2_set: !!keys.GROQ_API_KEY_2,
          cohere_key_set: !!keys.COHERE_API_KEY,
        })
      );
      return true;
    }
    
    // ── NEW: Check if repo is indexed (replaces GET /indexed) ────────────────
    case "IS_INDEXED": {
      isIndexed(message.repo_url).then(result => sendResponse({ indexed: result }));
      return true;
    }
    
    // ── NEW: Start indexing job (replaces POST /index) ───────────────────────
    case "START_INDEX": {
      // Run async, report progress via SET_JOB_STATUS messages back to panel
      (async () => {
        const jobId = Math.random().toString(36).slice(2, 10);
        sendResponse({ job_id: jobId, status: "started" });
        
        // Store job state in chrome.storage.local
        const setJob = (data) => chrome.storage.local.set({ [`job_${jobId}`]: data });
        
        try {
          await setJob({ status: "cloning", progress: 0, files_processed: 0, total_files: 0, current_file: "", elapsed_seconds: 0, error: null });
          
          const startTime = Date.now();
          const ticker = setInterval(() => {
            chrome.storage.local.get(`job_${jobId}`, (r) => {
              const job = r[`job_${jobId}`] || {};
              if (!["done", "error", "canceled"].includes(job.status)) {
                job.elapsed_seconds = Math.floor((Date.now() - startTime) / 1000);
                chrome.storage.local.set({ [`job_${jobId}`]: job });
              } else {
                clearInterval(ticker);
              }
            });
          }, 1000);
          
          // Phase 1: crawl
          const files = await crawlRepo(message.repo_url, (done, total, current) => {
            setJob({ status: "cloning", progress: Math.floor((done/total)*50), files_processed: done, total_files: total, current_file: current, elapsed_seconds: Math.floor((Date.now()-startTime)/1000), error: null });
          });
          
          // Phase 2: chunk
          await setJob({ status: "parsing", progress: 50, files_processed: files.length, total_files: files.length, current_file: "", elapsed_seconds: Math.floor((Date.now()-startTime)/1000), error: null });
          const chunks = chunkFiles(files);
          
          // Phase 3: embed + store
          await setJob({ status: "indexing", progress: 50, files_processed: 0, total_files: chunks.length, current_file: "", elapsed_seconds: Math.floor((Date.now()-startTime)/1000), error: null });
          
          const embedded = await embedChunks(chunks, message.repo_url.replace("https://github.com/",""), (done, total) => {
            setJob({ status: "indexing", progress: 50 + Math.floor((done/total)*50), files_processed: done, total_files: total, current_file: "", elapsed_seconds: Math.floor((Date.now()-startTime)/1000), error: null });
          });
          
          // Store in IndexedDB
          await deleteChunks(message.repo_url);
          const provider = embedded[0]?.provider || "gemini";
          await setProvider(message.repo_url, provider);
          
          const storedChunks = embedded.map(chunk => ({
            chunk_id:  chunk.chunk_id,
            repo_url:  message.repo_url,
            embedding: chunk.embedding,
            document:  chunk.context_string || chunk.content,
            metadata: {
              relative_path: chunk.relative_path,
              language:      chunk.language,
              chunk_type:    chunk.chunk_type,
              name:          chunk.name,
              start_line:    chunk.start_line,
              end_line:      chunk.end_line,
              repo_name:     message.repo_url.replace("https://github.com/",""),
            }
          }));
          await storeChunks(message.repo_url, storedChunks);
          
          clearInterval(ticker);
          await setJob({ status: "done", progress: 100, files_processed: chunks.length, total_files: chunks.length, current_file: "", elapsed_seconds: Math.floor((Date.now()-startTime)/1000), error: null });
          
        } catch (err) {
          await chrome.storage.local.set({ [`job_${jobId}`]: { status: "error", error: err.message, progress: 0, files_processed: 0, total_files: 0, current_file: "", elapsed_seconds: 0 } });
        }
      })();
      return true;
    }
    
    // ── NEW: Poll job status (replaces GET /status/{job_id}) ─────────────────
    case "GET_JOB_STATUS": {
      chrome.storage.local.get(`job_${message.job_id}`, (r) => {
        sendResponse(r[`job_${message.job_id}`] || null);
      });
      return true;
    }
    
    // ── NEW: Cancel indexing job ──────────────────────────────────────────────
    case "CANCEL_JOB": {
      chrome.storage.local.get(`job_${message.job_id}`, (r) => {
        const job = r[`job_${message.job_id}`] || {};
        job.status = "canceled";
        job.error = "Canceled by user";
        chrome.storage.local.set({ [`job_${message.job_id}`]: job }, () => sendResponse({ ok: true }));
      });
      return true;
    }
    
    // ── NEW: RAG query (replaces POST /query) ─────────────────────────────────
    case "RAG_QUERY": {
      // Collect all SSE events then send back as array
      // True streaming to panel.js is done via a long-lived port connection
      (async () => {
        const events = [];
        for await (const event of ragStreamAnswer(message.repo_url, message.question)) {
          events.push(event);
        }
        sendResponse({ events });
      })();
      return true;
    }
    
    default:
      return false;
  }
});
```

---

## PART 8 — PANEL.JS CHANGES

panel.js currently talks to `localhost:8000` in 3 places. Replace each one with a `chrome.runtime.sendMessage` call:

### Change 1: `checkBackendAndRoute()` — replace the health check + /indexed check

**FIND this block (around line 743):**
```javascript
async function checkBackendAndRoute() {
  // ... 
  try {
    const r = await fetch(`${BACKEND}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) throw new Error("unhealthy");
  } catch {
    showState("OFFLINE");
    ...
    return;
  }
  // then checks storage for prior index
```

**REPLACE the health check fetch with:**
```javascript
async function checkBackendAndRoute() {
  if (offlineRetryCleanup) { offlineRetryCleanup(); offlineRetryCleanup = null; }

  // No backend to check — verify keys are set instead
  const health = await new Promise(resolve =>
    chrome.runtime.sendMessage({ type: "HEALTH_CHECK" }, resolve)
  );
  
  if (!health || !health.gemini_key_set) {
    showState("OFFLINE");
    updateStatusDot("offline");
    // Update the offline message to say "API keys not configured" instead of "start backend"
    const offlineMsg = document.getElementById("rl-offline-msg");
    if (offlineMsg) offlineMsg.textContent = "API keys not configured. Click the extension icon → Settings to add your keys.";
    return;
  }
  
  // Rest of the function stays the same (chrome.runtime.sendMessage for GET_REPO_STATUS etc.)
```

### Change 2: `rl-index-btn` click handler — replace POST /index

**FIND (around line 970):**
```javascript
const r = await fetch(`${BACKEND}/index`, {
  method:  "POST",
  headers: { "Content-Type": "application/json" },
  body:    JSON.stringify({ repo_url: repoUrl }),
  signal:  AbortSignal.timeout(10000),
});
if (!r.ok) throw new Error(`HTTP ${r.status}`);
const { job_id } = await r.json();
```

**REPLACE WITH:**
```javascript
const result = await new Promise(resolve =>
  chrome.runtime.sendMessage({ type: "START_INDEX", repo_url: repoUrl }, resolve)
);
if (!result || !result.job_id) throw new Error("Failed to start indexing");
const job_id = result.job_id;
```

### Change 3: `startPolling()` — replace GET /status/{job_id}

**FIND (around line 175):**
```javascript
const r = await fetch(
  `${BACKEND}/status/${currentJobId}`,
  { signal: AbortSignal.timeout(5000) }
);
if (!r.ok) { ... }
const job = await r.json();
```

**REPLACE WITH:**
```javascript
const job = await new Promise(resolve =>
  chrome.runtime.sendMessage({ type: "GET_JOB_STATUS", job_id: currentJobId }, resolve)
);
if (!job) {
  // Job not found — check if already indexed
  const indexed = await new Promise(resolve =>
    chrome.runtime.sendMessage({ type: "IS_INDEXED", repo_url: repoUrl }, resolve)
  );
  if (indexed?.indexed) {
    clearInterval(pollInterval);
    chrome.runtime.sendMessage({ type: "SET_REPO_STATUS", repo_url: repoUrl, data: { indexed_at: Date.now()/1000, status: "done" } });
    showState("READY");
    updateStatusDot("ready");
  }
  return;
}
// job object now has: status, progress, files_processed, total_files, current_file, elapsed_seconds, error
// rest of polling logic stays exactly the same
```

### Change 4: `sendQuestion()` — replace POST /query with streaming via port

**FIND (around line 611):**
```javascript
const response = await fetch(`${BACKEND}/query`, {
  method:  "POST",
  headers: { "Content-Type": "application/json" },
  body:    JSON.stringify({ repo_url: repoUrl, question }),
  signal:  AbortSignal.timeout(60000),
});
// ... SSE parsing loop
```

**REPLACE the entire fetch + SSE parsing block with:**
```javascript
// Send query to background.js and receive all SSE events at once
const result = await new Promise(resolve =>
  chrome.runtime.sendMessage({ type: "RAG_QUERY", repo_url: repoUrl, question }, resolve)
);

if (!result || !result.events) {
  throw new Error("No response from background worker");
}

// Process events (same logic as before, just from array instead of stream)
for (const event of result.events) {
  const trimmed = event.trim();
  if (!trimmed) continue;
  
  const lines = trimmed.split("\n");
  const eventType = lines.find(l => l.startsWith("event:"))?.replace("event:", "").trim();
  const dataLine  = lines.find(l => l.startsWith("data:"))?.replace("data:", "").trim();
  if (!dataLine) continue;
  
  let data;
  try { data = JSON.parse(dataLine); } catch { continue; }
  
  if (eventType === "token") {
    if (typeof data.text === "string" && data.text) {
      fullText += data.text;
      try {
        assistantDiv.innerHTML = marked.parse(fullText);
        assistantDiv.querySelectorAll("pre code").forEach(el => hljs.highlightElement(el));
      } catch { assistantDiv.textContent = fullText; }
      scrollToBottom();
    }
  } else if (eventType === "sources") {
    sources = data.sources ?? [];
  } else if (eventType === "done") {
    renderCitations(sources, assistantDiv);
    saveToHistory(repoUrl, question, fullText, sources);
  } else if (eventType === "error") {
    if (data.message === "rate_limit") {
      if (assistantDiv) assistantDiv.remove();
      showRateLimitBanner(data.user_message);
    } else {
      assistantDiv.textContent = `Error: ${data.message ?? "Unknown error"}`;
      assistantDiv.style.color = "var(--error)";
    }
  }
}
```

### Change 5: Cancel job in close button — replace POST /cancel

**FIND (around line 884):**
```javascript
await fetch(`${BACKEND}/cancel`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ job_id: currentJobId })
});
```

**REPLACE WITH:**
```javascript
await new Promise(resolve =>
  chrome.runtime.sendMessage({ type: "CANCEL_JOB", job_id: currentJobId }, resolve)
);
```

---

## PART 9 — SETTINGS UI (NEW — add to panel.html and panel.js)

Add a settings screen where the user enters their API keys. They are stored in `chrome.storage.local` and read by background.js.

### Add to panel.html, inside the main container, after the existing state divs:
```html
<div id="state-settings" class="rl-state">
  <div class="rl-settings-form">
    <h3>API Keys</h3>
    <p>Keys are stored locally in your browser. Never sent anywhere except directly to each API.</p>
    <label>Gemini API Key <span style="color:var(--error)">*</span>
      <input type="password" id="key-gemini" placeholder="AIza..." />
    </label>
    <label>Groq API Key <span style="color:var(--error)">*</span>
      <input type="password" id="key-groq" placeholder="gsk_..." />
    </label>
    <label>Groq API Key 2 (optional — secondary account for higher limits)
      <input type="password" id="key-groq2" placeholder="gsk_..." />
    </label>
    <label>Cohere API Key (embedding fallback when Gemini is rate-limited)
      <input type="password" id="key-cohere" placeholder="..." />
    </label>
    <button id="rl-save-keys-btn">Save Keys</button>
    <span id="rl-keys-saved" style="display:none; color:var(--success)">✓ Saved!</span>
    <button id="rl-settings-back-btn">← Back</button>
  </div>
</div>
```

### Add to panel.js bindListeners():
```javascript
// Settings button (add a gear icon button to the header)
document.getElementById("rl-settings-btn")?.addEventListener("click", () => {
  // Load existing keys into the form
  chrome.storage.local.get(['GEMINI_API_KEY','GROQ_API_KEY','GROQ_API_KEY_2','COHERE_API_KEY'], (keys) => {
    if (keys.GEMINI_API_KEY) document.getElementById("key-gemini").value = keys.GEMINI_API_KEY;
    if (keys.GROQ_API_KEY)   document.getElementById("key-groq").value   = keys.GROQ_API_KEY;
    if (keys.GROQ_API_KEY_2) document.getElementById("key-groq2").value  = keys.GROQ_API_KEY_2;
    if (keys.COHERE_API_KEY) document.getElementById("key-cohere").value = keys.COHERE_API_KEY;
  });
  showState("SETTINGS");
});

document.getElementById("rl-save-keys-btn")?.addEventListener("click", () => {
  const keys = {
    GEMINI_API_KEY: document.getElementById("key-gemini").value.trim(),
    GROQ_API_KEY:   document.getElementById("key-groq").value.trim(),
    GROQ_API_KEY_2: document.getElementById("key-groq2").value.trim(),
    COHERE_API_KEY: document.getElementById("key-cohere").value.trim(),
  };
  chrome.runtime.sendMessage({ type: "SAVE_KEYS", keys }, () => {
    const saved = document.getElementById("rl-keys-saved");
    if (saved) { saved.style.display = "inline"; setTimeout(() => saved.style.display = "none", 2000); }
  });
});

document.getElementById("rl-settings-back-btn")?.addEventListener("click", () => {
  checkBackendAndRoute(); // re-run routing after saving keys
});
```

Also add `"SETTINGS"` to the `STATE_IDS` object and `"state-settings"` to the state machine.

---

## PART 10 — UPDATE THE OFFLINE STATE UI

The existing OFFLINE state tells the user to run `uvicorn main:app --reload` in a terminal. This no longer applies. Update `panel.html`:

**Find the OFFLINE state div and replace its contents** with:
```html
<div id="state-offline" class="rl-state">
  <div class="rl-offline-content">
    <span class="rl-offline-icon">🔑</span>
    <p id="rl-offline-msg">API keys not configured. Add your keys to get started.</p>
    <button id="rl-go-to-settings-btn">Open Settings</button>
  </div>
</div>
```

Wire the button in `bindListeners()`:
```javascript
document.getElementById("rl-go-to-settings-btn")?.addEventListener("click", () => {
  showState("SETTINGS");
});
```

---

## IMPORTANT IMPLEMENTATION NOTES

1. **background.js is a service worker** — it cannot use `import` statements. All code (idb.js contents, cosine similarity, crawler, chunker, embedder, RAG, message router) must be in a single `background.js` file OR you use `importScripts('lib/idb.js')` at the top of background.js. Use `importScripts` for idb.js.

2. **IndexedDB in service workers** — works fine in Chrome MV3 service workers. Use it normally.

3. **Keepalive alarm** — keep the existing `rl-keepalive` alarm logic exactly as-is. It's still needed.

4. **The `const BACKEND = "http://127.0.0.1:8000"` constant in panel.js** — remove it or leave it unused. It is no longer referenced after your changes.

5. **Error handling on all fetch calls** — every API call must have try/catch. Network failures should return false or throw descriptive errors, never crash silently.

6. **Progress reporting during indexing** — the background.js job runner must write progress to `chrome.storage.local` so `startPolling()` in panel.js can read it via `GET_JOB_STATUS` messages.

7. **Do not break existing features** — chat history, stale index detection, citations, draggable panel, resizable panel, autocomplete, the Map button, help overlay, minimize/close buttons must all still work.

8. **`context_string` field** — when building the chunk objects to store in IndexedDB, the `document` field should be the full context string (File + Language + Type + Name + Lines header + content), not just raw content. This is what gets shown in the RAG prompt.

---

## DELIVERABLES

When done, these files should exist and work:
- `repolens/extension/manifest.json` — updated permissions
- `repolens/extension/lib/idb.js` — new IndexedDB wrapper
- `repolens/extension/background.js` — full rewrite with all pipeline logic
- `repolens/extension/panel/panel.js` — updated (5 changes above, everything else unchanged)
- `repolens/extension/panel/panel.html` — updated (settings state added, offline state updated)

The Python backend folder (`repolens/backend/`) can be left as-is or deleted — it is no longer used.

---

## TESTING AFTER BUILD

Load the extension in Chrome (`chrome://extensions` → Developer mode → Load unpacked → select `repolens/extension/`).

1. Open Settings → enter all 4 API keys → Save
2. Navigate to any public GitHub repo (e.g. `https://github.com/tiangolo/fastapi`)
3. Click Index Repository — watch progress bar move from 0% to 100%
4. Ask a question — verify streaming tokens appear and sources are shown
5. Close Chrome completely → reopen → navigate to same repo → verify it shows READY (index persisted in IndexedDB)
6. Ask another question — verify it works without re-indexing

---

## SUMMARY OF FALLBACK CHAINS (DO NOT CHANGE THESE)

```
EMBEDDING (indexing):
  Gemini gemini-embedding-001 (3072-dim)
    ↓ rate-limited (429)
  Cohere embed-english-v3.0 (1024-dim)
    ↓ if also fails
  throw error to user

EMBEDDING (querying):
  Must use SAME provider as indexing (stored in IndexedDB meta)
  If Gemini rate-limited at query time → SSE error event → user sees clear message

LLM (chat responses):
  Groq llama-3.3-70b-versatile (primary key)
    ↓ fails (429 / error)
  Groq llama-3.3-70b-versatile (secondary key GROQ_API_KEY_2)
    ↓ fails
  Gemini gemini-2.5-flash (fallback)
    ↓ fails
  SSE error event → user sees clear message
```
