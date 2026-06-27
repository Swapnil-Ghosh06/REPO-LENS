/**
 * background.js — RepoLens Service Worker
 */

importScripts('lib/idb.js');

// ─── Service Worker Keepalive ─────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("rl-keepalive", { periodInMinutes: 0.4 });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("rl-keepalive", { periodInMinutes: 0.4 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "rl-keepalive") return;
});

// ─── API KEYS HELPER ──────────────────────────────────────────────────────────
const PROXY_URL = "https://repolens-proxy.swapnil-repolens.workers.dev";

async function getKeys() {
  // Keys are now securely managed by the Cloudflare Proxy.
  // We return a stub so existing functions don't break if they still call it.
  return {};
}

// ─── PART 2 — COSINE SIMILARITY ───────────────────────────────────────────────
function cosineSimilarity(vecA, vecB) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot   += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ─── PART 3 — GITHUB CRAWLER ──────────────────────────────────────────────────
const SUPPORTED_EXTENSIONS = [".py", ".js", ".ts", ".jsx", ".tsx", ".java", ".go", ".rs", ".cpp", ".c", ".cs", ".rb", ".php", ".swift", ".kt", ".md"];
const SKIP_DIRS = ["node_modules", ".git", "dist", "build", "__pycache__", ".venv", "venv", ".next", "out", "vendor", ".idea", ".vscode", "coverage", "target", "tests", "test", "__tests__", "spec", "docs"];
const LANGUAGE_MAP = {
  ".py": "python", ".js": "javascript", ".ts": "typescript", ".jsx": "javascript", ".tsx": "typescript",
  ".java": "java", ".go": "go", ".rs": "rust", ".cpp": "cpp", ".c": "c", ".cs": "csharp",
  ".rb": "ruby", ".php": "php", ".swift": "swift", ".kt": "kotlin", ".md": "markdown"
};

async function crawlRepo(repoUrl, progressCallback) {
  const [owner, repo] = repoUrl.replace("https://github.com/", "").split("/");
  
  // Get auth token if available
  const tokenObj = await new Promise(resolve => chrome.storage.local.get('GITHUB_TOKEN', resolve));
  const headers = { 'Accept': 'application/vnd.github+json' };
  if (tokenObj.GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${tokenObj.GITHUB_TOKEN}`;
  }

  // 1-2. Get file tree
  const treeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`, { headers });
  if (!treeRes.ok) {
    if (treeRes.status === 404) {
      throw new Error("Repo: Private (Please configure GITHUB_TOKEN to index)");
    }
    throw new Error(`GitHub API error: ${treeRes.status}`);
  }
  const treeData = await treeRes.json();

  // 3-4. Filter files
  const validFiles = treeData.tree.filter(item => {
    if (item.type !== "blob") return false;
    if (item.size > 100 * 1024) return false; // skip > 100KB

    const parts = item.path.split('/');
    if (parts.some(p => SKIP_DIRS.includes(p))) return false;
    
    const extMatch = item.path.match(/\.[^.]+$/);
    if (!extMatch) return false;
    if (!SUPPORTED_EXTENSIONS.includes(extMatch[0])) return false;
    
    const lowerPath = item.path.toLowerCase();
    if (lowerPath.includes(".test.") || lowerPath.includes(".spec.") || lowerPath.includes(".min.")) return false;

    return true;
  });

  // 5. Cap at 800
  if (validFiles.length > 800) {
    const err = new Error("Too many files");
    err.type = "too_large"; // used by UI
    throw err;
  }

  const results = [];
  let done = 0;
  const total = validFiles.length;

  // 6. Fetch raw content in parallel (concurrency 5)
  const concurrency = 5;
  for (let i = 0; i < validFiles.length; i += concurrency) {
    const batch = validFiles.slice(i, i + concurrency);
    const promises = batch.map(async (file) => {
      const rawRes = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${file.path}`);
      if (!rawRes.ok) return null;
      const content = await rawRes.text();
      
      const ext = file.path.match(/\.[^.]+$/)[0];
      const language = LANGUAGE_MAP[ext] || "unknown";
      
      results.push({ relative_path: file.path, language, raw_content: content });
      
      done++;
      // 7. Call progressCallback
      progressCallback(done, total, file.path);
    });
    await Promise.all(promises);
  }

  return results;
}

// ─── PART 4 — CODE CHUNKER ────────────────────────────────────────────────────
function chunkFiles(files) {
  const chunks = [];
  
  for (const file of files) {
    const lines = file.raw_content.split('\n');
    const windowSize = 60;
    const overlap = 10;
    const step = windowSize - overlap;

    if (lines.length === 0) continue;

    let chunkIndex = 1;
    for (let i = 0; i < lines.length; i += step) {
      const startLine = i + 1;
      const endLine = Math.min(i + windowSize, lines.length);
      const content = lines.slice(i, endLine).join('\n');
      
      chunks.push({
        chunk_id: `${file.relative_path}::${startLine}`,
        relative_path: file.relative_path,
        language: file.language,
        chunk_type: "fallback",
        name: `chunk_${chunkIndex++}`,
        start_line: startLine,
        end_line: endLine,
        content: content
      });

      if (endLine === lines.length) break;
    }
  }
  return chunks;
}

// ─── PART 5 — EMBEDDING ENGINE ────────────────────────────────────────────────
let _geminiDeadUntil = 0;

function geminiIsDead() { return Date.now() < _geminiDeadUntil; }
function killGeminiFor60Min() {
  _geminiDeadUntil = Date.now() + 60 * 60 * 1000;
  console.warn('[CIRCUIT BREAKER] Gemini killed for 60 min. Switching to Cohere.');
}

async function embedWithGemini(texts, taskType) {
  const res = await fetch(`${PROXY_URL}/gemini-embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: texts.map(text => ({
        model: "models/text-embedding-004",
        content: { parts: [{ text }] },
        taskType
      }))
    })
  });
  
  if (res.status === 429) throw new Error("GEMINI_RATE_LIMIT");
  const data = await res.json();
  if (data.error && data.error.status === "RESOURCE_EXHAUSTED") throw new Error("GEMINI_RATE_LIMIT");
  if (!res.ok) throw new Error(`Gemini Error: ${data.error?.message || res.status}`);
  
  return data.embeddings.map(e => e.values);
}

async function embedWithCohere(texts, inputType) {
  const res = await fetch(`${PROXY_URL}/cohere-embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      texts,
      model: "embed-english-v3.0",
      input_type: inputType,
      embedding_types: ["float"]
    })
  });
  
  const data = await res.json();
  if (!res.ok) throw new Error(`Cohere Error: ${data.message || res.status}`);
  return data.embeddings.float;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function _embedChunksGemini(chunks, repoName, progressCallback) {
  let done = 0;
  const total = chunks.length;
  
  for (let i = 0; i < chunks.length; i += 100) {
    const batchChunks = chunks.slice(i, i + 100);
    const texts = [];
    
    for (const chunk of batchChunks) {
      const contextStr = `File: ${chunk.relative_path}\nLanguage: ${chunk.language}\nType: ${chunk.chunk_type}\nName: ${chunk.name}\nLines: ${chunk.start_line}-${chunk.end_line}\nRepo: ${repoName}\n\n${chunk.content}`;
      chunk.context_string = contextStr.slice(0, 8000);
      texts.push(chunk.context_string);
    }
    
    try {
      const vecs = await embedWithGemini(texts, "RETRIEVAL_DOCUMENT");
      batchChunks.forEach((c, idx) => { c.embedding = vecs[idx]; c.provider = "gemini"; });
    } catch (e) {
      if (e.message.includes("GEMINI_RATE_LIMIT")) {
        console.warn('Gemini 429 hit. Retrying once after 15s...');
        await sleep(15000);
        try {
          const vecs = await embedWithGemini(texts, "RETRIEVAL_DOCUMENT");
          batchChunks.forEach((c, idx) => { c.embedding = vecs[idx]; c.provider = "gemini"; });
        } catch(e2) {
          throw new Error("GEMINI_RATE_LIMIT");
        }
      } else {
        throw e;
      }
    }
    
    done += batchChunks.length;
    progressCallback(done, total);
    await sleep(1000);
  }
  return chunks;
}

async function _embedChunksCohere(chunks, repoName, progressCallback) {
  let done = 0;
  const total = chunks.length;
  
  for (let i = 0; i < chunks.length; i += 90) {
    const batchChunks = chunks.slice(i, i + 90);
    const texts = [];
    
    for (const chunk of batchChunks) {
      const contextStr = `File: ${chunk.relative_path}\nLanguage: ${chunk.language}\nType: ${chunk.chunk_type}\nName: ${chunk.name}\nLines: ${chunk.start_line}-${chunk.end_line}\nRepo: ${repoName}\n\n${chunk.content}`;
      chunk.context_string = contextStr.slice(0, 8000);
      texts.push(chunk.context_string);
    }
    
    try {
      const vecs = await embedWithCohere(texts, "search_document");
      batchChunks.forEach((c, idx) => { c.embedding = vecs[idx]; c.provider = "cohere"; });
    } catch (e) {
      console.warn("Cohere batch failed, skipping:", e);
    }
    
    done += batchChunks.length;
    progressCallback(done, total);
    await sleep(500);
  }
  return chunks.filter(c => c.embedding); // return only successfully embedded
}

async function embedChunks(chunks, repoName, progressCallback) {
  if (geminiIsDead()) {
    return await _embedChunksCohere(chunks, repoName, progressCallback);
  }
  
  try {
    return await _embedChunksGemini(chunks, repoName, progressCallback);
  } catch (e) {
    console.warn(`[PLAN B] Gemini failed (${e.message}). Switching to Cohere...`);
    killGeminiFor60Min();
    return await _embedChunksCohere(chunks, repoName, progressCallback);
  }
}

async function embedQuery(question, provider) {
  if (provider === "cohere") {
    const vecs = await embedWithCohere([question], "search_query");
    return vecs[0];
  }
  
  if (geminiIsDead()) {
    throw new Error("GEMINI_RATE_LIMIT: Circuit breaker active. Repo was indexed with Gemini. Please wait and retry.");
  }
  
  try {
    const vecs = await embedWithGemini([question], "RETRIEVAL_QUERY");
    return vecs[0];
  } catch (e) {
    console.warn(`[PLAN B] Gemini failed for query (${e.message}). Switching to Cohere...`);
    killGeminiFor60Min();
    const vecs = await embedWithCohere([question], "search_query");
    return vecs[0];
  }
}

// ─── PART 6 — RAG ENGINE ──────────────────────────────────────────────────────

async function tryGroq(systemPrompt, userMessage, onToken, keyIndex = 1) {
  try {
    const res = await fetch(`${PROXY_URL}/groq-chat-${keyIndex}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
        stream: true,
        temperature: 0.2,
        max_tokens: 4096
      })
    });
    
    if (!res.ok) return false;
    
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop();
      
      for (const event of events) {
        if (!event.startsWith("data: ")) continue;
        const dataStr = event.replace("data: ", "").trim();
        if (dataStr === "[DONE]") continue;
        try {
          const data = JSON.parse(dataStr);
          if (data.choices[0].delta.content) {
            onToken(data.choices[0].delta.content);
          }
        } catch (e) {}
      }
    }
    return true;
  } catch (e) {
    return false;
  }
}

async function tryGeminiLLM(systemPrompt, userMessage, onToken) {
  try {
    const res = await fetch(`${PROXY_URL}/gemini-chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: systemPrompt + "\n\n" + userMessage }] }]
      })
    });
    
    if (!res.ok) return false;
    
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop();
      
      for (const event of events) {
        if (!event.startsWith("data: ")) continue;
        const dataStr = event.replace("data: ", "").trim();
        try {
          const data = JSON.parse(dataStr);
          const parts = data?.candidates?.[0]?.content?.parts;
          if (parts && parts.length > 0 && parts[0].text) {
            onToken(parts[0].text);
          }
        } catch (e) {}
      }
    }
    return true;
  } catch (e) {
    return false;
  }
}

async function streamFromLLM(systemPrompt, userMessage, onToken) {
  // Try Groq primary
  let ok = await tryGroq(systemPrompt, userMessage, onToken, 1);
  if (ok) return true;
  
  // Try Groq secondary
  console.warn('[LLM] Groq primary failed. Trying secondary Groq key...');
  ok = await tryGroq(systemPrompt, userMessage, onToken, 2);
  if (ok) return true;
  
  // Try Gemini fallback
  console.warn('[LLM] Both Groq keys failed. Falling back to Gemini...');
  return await tryGeminiLLM(systemPrompt, userMessage, onToken);
}

async function* ragStreamAnswer(repoUrl, question) {
  const provider = await getProvider(repoUrl);
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
  
  const allChunks = await getChunks(repoUrl);
  if (!allChunks.length) {
    yield `event: error\ndata: ${JSON.stringify({ message: "no_results", user_message: "No chunks found. Please re-index this repository." })}\n\n`;
    return;
  }
  
  const scored = allChunks
    .map(chunk => ({ ...chunk, score: cosineSimilarity(queryVec, chunk.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  
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
  
  const tokens = [];
  const onToken = (text) => tokens.push(text);
  
  const success = await streamFromLLM(systemPrompt, userMessage, onToken);
  
  if (!success) {
    yield `event: error\ndata: ${JSON.stringify({
      message: "rate_limit",
      user_message: "All AI providers are currently rate-limited. Please wait a minute and try again."
    })}\n\n`;
    return;
  }
  
  for (const text of tokens) {
    yield `event: token\ndata: ${JSON.stringify({ text })}\n\n`;
  }
  
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

// ─── PART 7 — MESSAGE ROUTER ──────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
  
    // ── KEEP ALL EXISTING HANDLERS ────────────────────────────────────────────
    case "GET_REPO_STATUS": {
      chrome.storage.local.get("indexed_repos", (result) => {
        const repos = result.indexed_repos || {};
        sendResponse(repos[message.repo_url] || null);
      });
      return true;
    }
    case "SET_REPO_STATUS": {
      chrome.storage.local.get("indexed_repos", (result) => {
        const repos = result.indexed_repos || {};
        repos[message.repo_url] = message.data;
        chrome.storage.local.set({ indexed_repos: repos }, () => {
          sendResponse({ ok: true });
        });
      });
      return true;
    }
    case "GET_CHAT_HISTORY": {
      chrome.storage.session.get(message.key, (result) => {
        sendResponse(result[message.key] || []);
      });
      return true;
    }
    case "SET_CHAT_HISTORY": {
      chrome.storage.session.set({ [message.key]: message.messages }, () => {
        sendResponse({ ok: true });
      });
      return true;
    }
    
    // ── NEW: Settings ─────────────────────────────────────────────────────────
    case "GET_KEYS": {
      chrome.storage.local.get(
        ['GEMINI_API_KEY', 'GROQ_API_KEY', 'GROQ_API_KEY_2', 'COHERE_API_KEY'],
        (keys) => sendResponse(keys)
      );
      return true;
    }
    case "SAVE_KEYS": {
      chrome.storage.local.set(message.keys, () => sendResponse({ ok: true }));
      return true;
    }
    
    // ── NEW: Health check (replaces GET /health) ─────────────────────────────
    case "HEALTH_CHECK": {
      // The proxy handles keys, so we just assume health is OK
      sendResponse({ status: "ok", proxy_mode: true });
      return true;
    }
    
    // ── NEW: Check if repo is indexed ─────────────────────────────────────────
    case "IS_INDEXED": {
      isIndexed(message.repo_url).then(result => sendResponse({ indexed: result }));
      return true;
    }
    
    // ── NEW: Start indexing job ───────────────────────────────────────────────
    case "START_INDEX": {
      (async () => {
        const jobId = Math.random().toString(36).slice(2, 10);
        sendResponse({ job_id: jobId, status: "started" });
        
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
          
          const files = await crawlRepo(message.repo_url, (done, total, current) => {
            setJob({ status: "cloning", progress: Math.floor((done/total)*50), files_processed: done, total_files: total, current_file: current, elapsed_seconds: Math.floor((Date.now()-startTime)/1000), error: null });
          });
          
          await setJob({ status: "parsing", progress: 50, files_processed: files.length, total_files: files.length, current_file: "", elapsed_seconds: Math.floor((Date.now()-startTime)/1000), error: null });
          const chunks = chunkFiles(files);
          
          await setJob({ status: "indexing", progress: 50, files_processed: 0, total_files: chunks.length, current_file: "", elapsed_seconds: Math.floor((Date.now()-startTime)/1000), error: null });
          
          const embedded = await embedChunks(chunks, message.repo_url.replace("https://github.com/",""), (done, total) => {
            setJob({ status: "indexing", progress: 50 + Math.floor((done/total)*50), files_processed: done, total_files: total, current_file: "", elapsed_seconds: Math.floor((Date.now()-startTime)/1000), error: null });
          });
          
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
          await chrome.storage.local.set({ [`job_${jobId}`]: { status: "error", error: err.message, error_type: err.type, progress: 0, files_processed: 0, total_files: 0, current_file: "", elapsed_seconds: 0 } });
        }
      })();
      return true;
    }
    
    // ── NEW: Poll job status ──────────────────────────────────────────────────
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
    
    // ── NEW: RAG query ────────────────────────────────────────────────────────
    case "RAG_QUERY": {
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
