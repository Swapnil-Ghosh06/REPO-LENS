/**
 * panel.js — RepoLens Panel State Machine & Chat Controller
 *
 * Injected into the GitHub page via panel.html (loaded inside the
 * #rl-container div that content.js injects into every repo page).
 *
 * Rules this file follows (from Rules.md):
 *   Rule 7:  All storage I/O goes through chrome.runtime.sendMessage → background.js.
 *            No direct chrome.storage access here.
 *   Rule 11: Every fetch() to localhost:8000 uses AbortSignal.timeout().
 *   Rule 12: SSE stream parsed correctly — guard with `if (chunk.text)` equivalent
 *            in the SSE event loop.
 */

"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const BACKEND = "http://localhost:8000";
const INDEX_CACHE_TTL = 86400; // 24 hours in seconds

/** @type {string} Populated on init from container dataset */
let repoUrl = "";
/** @type {string} e.g. "owner/repo" */
let repoName = "";
/** @type {boolean} Prevent concurrent sendQuestion calls */
let isSending = false;

// ─────────────────────────────────────────────────────────────────────────────
// STATE MACHINE
// ─────────────────────────────────────────────────────────────────────────────

const STATE_IDS = {
  OFFLINE:     "state-offline",
  NOT_INDEXED: "state-not-indexed",
  INDEXING:    "state-indexing",
  READY:       "state-ready",
};

/**
 * Hides all state divs then makes the requested one visible.
 * The CSS sibling rule `#state-ready.active ~ #rl-input-bar { display:flex }`
 * automatically shows/hides the input bar.
 *
 * @param {"OFFLINE"|"NOT_INDEXED"|"INDEXING"|"READY"} stateName
 */
function showState(stateName) {
  for (const id of Object.values(STATE_IDS)) {
    const el = document.getElementById(id);
    if (el) el.classList.remove("active");
  }
  const target = document.getElementById(STATE_IDS[stateName]);
  if (target) target.classList.add("active");
}

// ─────────────────────────────────────────────────────────────────────────────
// STATUS DOT
// ─────────────────────────────────────────────────────────────────────────────

const DOT_COLORS = {
  idle:     "#484f58",
  indexing: "#d29922",
  ready:    "#3fb950",
  offline:  "#f85149",
};

/**
 * @param {"idle"|"indexing"|"ready"|"offline"} state
 */
function updateStatusDot(state) {
  const dot = document.getElementById("rl-status-dot");
  if (dot) dot.style.background = DOT_COLORS[state] ?? DOT_COLORS.idle;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCROLL
// ─────────────────────────────────────────────────────────────────────────────

function scrollToBottom() {
  const m = document.getElementById("rl-messages");
  if (m) m.scrollTop = m.scrollHeight;
}

// ─────────────────────────────────────────────────────────────────────────────
// FILE ESTIMATE (GitHub API)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calls the public GitHub API to get a rough repo size, then estimates
 * the file count and minutes to index it.
 *
 * @param {string} url — full repo URL (https://github.com/owner/repo)
 */
async function fetchFileEstimate(url) {
  try {
    const [owner, repo] = url.replace("https://github.com/", "").split("/");
    const r = await fetch(
      `https://api.github.com/repos/${owner}/${repo}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!r.ok) return;
    const { size } = await r.json(); // size is in KB
    const fileCount = Math.min(Math.round(size / 10), 1000);
    const minutes   = Math.max(1, Math.round(fileCount / 100));
    const el = document.getElementById("rl-file-estimate");
    if (el) el.textContent = `~${fileCount} files · est. ${minutes} min`;
  } catch {
    // Silently ignore — the placeholder "~? files · est. ? min" stays in place
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INDEXING — POLLING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Polls /status/{jobId} every 1.5 s and updates the INDEXING state UI.
 * On "done": persists status via background.js, then transitions to READY.
 * On "error": shows error inline, then reverts to NOT_INDEXED after 3 s.
 *
 * @param {string} jobId
 */
function startPolling(jobId) {
  const interval = setInterval(async () => {
    try {
      const r = await fetch(
        `${BACKEND}/status/${jobId}`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (!r.ok) return; // transient — keep polling

      const job = await r.json();

      // Update progress bar
      const fillEl = document.getElementById("rl-progress-fill");
      if (fillEl) fillEl.style.width = `${job.progress ?? 0}%`;

      // Update stats row
      const pctEl = document.getElementById("rl-progress-pct");
      if (pctEl) pctEl.textContent = `${job.progress ?? 0}%`;

      const countEl = document.getElementById("rl-files-count");
      if (countEl) {
        countEl.textContent =
          `${job.files_processed ?? 0} / ${job.total_files ?? "?"} files`;
      }

      // Current file ticker
      const fileEl = document.getElementById("rl-current-file");
      if (fileEl) {
        fileEl.textContent = `↳ ${job.current_file ?? ""}`;
        fileEl.style.color = ""; // reset any error color
      }

      // Elapsed time
      const elapsed   = job.elapsed_seconds ?? 0;
      const m         = Math.floor(elapsed / 60);
      const s         = String(elapsed % 60).padStart(2, "0");
      const elapsedEl = document.getElementById("rl-elapsed");
      if (elapsedEl) elapsedEl.textContent = `Elapsed: ${m}:${s}`;

      // ── Terminal states ────────────────────────────────────────────────────

      if (job.status === "done") {
        clearInterval(interval);
        chrome.runtime.sendMessage({
          type:     "SET_REPO_STATUS",
          repo_url: repoUrl,
          data: {
            indexed_at: Date.now() / 1000,
            job_id:     jobId,
            file_count: job.total_files,
            status:     "done",
          },
        });
        showState("READY");
        updateStatusDot("ready");
        // No loadChatHistory() — fresh index, chat history is empty

      } else if (job.status === "error") {
        clearInterval(interval);
        if (fileEl) {
          fileEl.textContent  = `Error: ${job.error ?? "Unknown error"}`;
          fileEl.style.color  = "var(--error)";
        }
        setTimeout(() => {
          showState("NOT_INDEXED");
          updateStatusDot("idle");
        }, 3000);
      }

    } catch {
      // Network hiccup — keep polling without crashing
    }
  }, 1500);
}

// ─────────────────────────────────────────────────────────────────────────────
// CHAT — MESSAGE RENDERING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates and appends a message element to #rl-messages.
 * Used both for real-time appends and for history replay.
 *
 * @param {"user"|"assistant"} role
 * @param {string}             content  — raw text for user, markdown for assistant
 * @param {Array}              sources  — citation objects [{file, line}, ...]
 * @returns {HTMLElement}      the created element (for streaming updates)
 */
function appendMessage(role, content, sources = []) {
  const messages = document.getElementById("rl-messages");
  if (!messages) return null;

  const div = document.createElement("div");
  div.classList.add("rl-message", `rl-message-${role}`);

  if (role === "user") {
    div.textContent = content;
  } else {
    // Render markdown; marked and hljs are loaded via defer scripts
    try {
      div.innerHTML = marked.parse(content);
      div.querySelectorAll("pre code").forEach((el) => hljs.highlightElement(el));
    } catch {
      div.textContent = content;
    }
    // Render citations if provided (for history replay)
    if (sources && sources.length > 0) {
      renderCitations(sources, div, messages);
    }
  }

  messages.appendChild(div);
  return div;
}

/**
 * Appends a row of citation chips after the given assistant message div.
 * Each chip links to the exact line on GitHub.
 *
 * @param {Array}       sources     — [{file: string, line: number}, ...]
 * @param {HTMLElement} msgDiv      — the assistant message element
 * @param {HTMLElement} [container] — defaults to #rl-messages
 */
function renderCitations(sources, msgDiv, container) {
  if (!sources || sources.length === 0) return;
  const parent = container || document.getElementById("rl-messages");
  if (!parent) return;

  // ── 1. Group by file (relative_path), collecting line numbers per file ──────
  const fileMap = new Map(); // relative_path → { github_url, lines: Set<number> }

  for (const src of sources) {
    const key = src.relative_path || src.file || "unknown";
    if (!fileMap.has(key)) {
      fileMap.set(key, {
        github_url: src.github_url || null,
        relative_path: key,
        lines: new Set(),
      });
    }
    if (src.line) fileMap.get(key).lines.add(Number(src.line));
  }

  // ── 2. Build the citations row ───────────────────────────────────────────────
  const row = document.createElement("div");
  row.classList.add("rl-citations");

  // "N sources" label
  const label = document.createElement("span");
  label.className = "rl-citations-label";
  label.textContent = `${fileMap.size} source${fileMap.size !== 1 ? "s" : ""}`;
  row.appendChild(label);

  // ── 3. One chip per unique file ──────────────────────────────────────────────
  for (const [relativePath, info] of fileMap) {
    const chip = document.createElement("a");
    chip.className = "rl-citation-chip";
    chip.rel = "noopener noreferrer";

    // Tooltip — full relative path
    chip.title = relativePath;

    // Basename, truncated to 30 chars with ellipsis
    const basename = relativePath.split("/").pop() || relativePath;
    const displayName =
      basename.length > 30 ? basename.slice(0, 27) + "\u2026" : basename;

    // Line numbers — sorted, comma-separated
    const sortedLines = [...info.lines].sort((a, b) => a - b);
    const lineLabel = sortedLines.length > 0 ? `:${sortedLines.join(",")}` : "";

    chip.textContent = displayName + lineLabel;

    // Link — prefer backend-provided github_url; fall back to first line anchor
    if (info.github_url) {
      // github_url from backend already includes #L{line}; strip fragment and
      // re-add first line so grouped chips still land on the right spot
      const baseUrl = info.github_url.split("#")[0];
      chip.href = sortedLines.length > 0 ? `${baseUrl}#L${sortedLines[0]}` : baseUrl;
    } else {
      // Fallback: reconstruct from repoName if backend didn't provide github_url
      chip.href = `https://github.com/${repoName}/blob/main/${relativePath}${
        sortedLines.length > 0 ? `#L${sortedLines[0]}` : ""
      }`;
    }

    // Open in new tab via window.open (avoids extension CSP issues with href navigation)
    chip.addEventListener("click", (e) => {
      e.preventDefault();
      window.open(chip.href, "_blank");
    });

    row.appendChild(chip);
  }

  // ── 4. Insert immediately after the assistant message div ───────────────────
  if (msgDiv && msgDiv.nextSibling) {
    parent.insertBefore(row, msgDiv.nextSibling);
  } else {
    parent.appendChild(row);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHAT — STORAGE
// ─────────────────────────────────────────────────────────────────────────────

function loadChatHistory() {
  chrome.runtime.sendMessage(
    { type: "GET_CHAT_HISTORY", key: `chat_${repoUrl}` },
    (messages) => {
      (messages || []).forEach((msg) =>
        appendMessage(msg.role, msg.content, msg.sources)
      );
      scrollToBottom();
    }
  );
}

function saveToHistory(url, question, answer, sources) {
  chrome.runtime.sendMessage(
    { type: "GET_CHAT_HISTORY", key: `chat_${url}` },
    (existing) => {
      const messages = existing || [];
      messages.push({ role: "user",      content: question, timestamp: Date.now() });
      messages.push({ role: "assistant", content: answer, sources, timestamp: Date.now() });
      chrome.runtime.sendMessage({
        type:     "SET_CHAT_HISTORY",
        key:      `chat_${url}`,
        messages,
      });
    }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CHAT — SEND QUESTION (SSE streaming)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sends a question to the backend, streams the SSE response token-by-token,
 * renders markdown progressively, and persists the exchange to history.
 *
 * SSE event types (from Schema.md): token | sources | done | error
 *
 * @param {string} question
 */
async function sendQuestion(question) {
  if (isSending) return;
  isSending = true;

  const sendBtn = document.getElementById("rl-send");
  const input   = document.getElementById("rl-input");

  if (sendBtn) sendBtn.disabled = true;
  if (input)   input.disabled  = true;

  // ── Optimistic user bubble ────────────────────────────────────────────────
  appendMessage("user", question);
  scrollToBottom();

  // ── Assistant placeholder (will be updated in-place via streaming) ────────
  const messages    = document.getElementById("rl-messages");
  const assistantDiv = document.createElement("div");
  assistantDiv.classList.add("rl-message", "rl-message-assistant");
  // Blinking cursor while we wait for the first token
  const cursor = document.createElement("span");
  cursor.classList.add("rl-cursor");
  assistantDiv.appendChild(cursor);
  if (messages) messages.appendChild(assistantDiv);
  scrollToBottom();

  let fullText = "";
  let sources  = [];

  try {
    const response = await fetch(`${BACKEND}/query`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ repo_url: repoUrl, question }),
      signal:  AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // ── SSE ReadableStream parsing ─────────────────────────────────────────
    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer    = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by double newline
      const events = buffer.split("\n\n");
      buffer = events.pop(); // keep the last incomplete chunk

      for (const event of events) {
        const trimmed   = event.trim();
        if (!trimmed) continue;

        const lines     = trimmed.split("\n");
        const eventType = lines
          .find((l) => l.startsWith("event:"))
          ?.replace("event:", "")
          .trim();
        const dataLine  = lines
          .find((l) => l.startsWith("data:"))
          ?.replace("data:", "")
          .trim();

        if (!dataLine) continue;

        let data;
        try {
          data = JSON.parse(dataLine);
        } catch {
          continue; // malformed JSON — skip this event
        }

        if (eventType === "token") {
          // Guard: only process if data.text is a non-empty string (Rule 12 equivalent)
          if (typeof data.text === "string" && data.text) {
            fullText += data.text;
            try {
              assistantDiv.innerHTML = marked.parse(fullText);
              assistantDiv.querySelectorAll("pre code").forEach((el) =>
                hljs.highlightElement(el)
              );
            } catch {
              assistantDiv.textContent = fullText;
            }
            scrollToBottom();
          }

        } else if (eventType === "sources") {
          sources = data.sources ?? [];

        } else if (eventType === "done") {
          renderCitations(sources, assistantDiv);
          saveToHistory(repoUrl, question, fullText, sources);

        } else if (eventType === "error") {
          assistantDiv.textContent = `Error: ${data.message ?? "Unknown error"}`;
          assistantDiv.style.color = "var(--error)";
        }
      }
    }

  } catch (err) {
    // Remove the blinking cursor if it's still there
    assistantDiv.innerHTML = "";
    const errMsg = err.name === "TimeoutError"
      ? "Request timed out after 60 s. The backend may be overloaded."
      : `Error: ${err.message}`;
    assistantDiv.textContent = errMsg;
    assistantDiv.style.color = "var(--error)";
    scrollToBottom();
  } finally {
    isSending = false;
    if (sendBtn) sendBtn.disabled = false;
    if (input) {
      input.disabled = false;
      input.focus();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────

async function init() {
  // ── 1. Resolve identity from container dataset ─────────────────────────────
  // content.js sets data-repo-url on #rl-panel-container (outer wrapper).
  // #rl-container (inner, from panel.html) does NOT have it.
  const outerContainer = document.getElementById("rl-panel-container");
  const container = document.getElementById("rl-container");
  if (!container) return;

  repoUrl  = outerContainer?.dataset?.repoUrl ?? "";
  repoName = repoUrl.replace("https://github.com/", "");

  // Propagate to inner container for any child components that may need it
  if (container) container.dataset.repoUrl = repoUrl;

  const repoNameEl    = document.getElementById("rl-repo-name");
  const repoDisplayEl = document.getElementById("rl-repo-display");
  if (repoNameEl)    repoNameEl.textContent    = repoName;
  if (repoDisplayEl) repoDisplayEl.textContent = repoName;

  // ── 2. Health check ────────────────────────────────────────────────────────
  try {
    const r = await fetch(`${BACKEND}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) throw new Error("unhealthy");
  } catch {
    showState("OFFLINE");
    updateStatusDot("offline");
    return;
  }

  // ── 3. Check storage for prior index ──────────────────────────────────────
  chrome.runtime.sendMessage(
    { type: "GET_REPO_STATUS", repo_url: repoUrl },
    (entry) => {
      if (entry && entry.status === "done") {
        const age = Date.now() / 1000 - (entry.indexed_at ?? 0);
        if (age < INDEX_CACHE_TTL) {
          showState("READY");
          updateStatusDot("ready");
          loadChatHistory();
          return;
        }
      }
      // No valid cached entry — prompt to index
      showState("NOT_INDEXED");
      updateStatusDot("idle");
      if (repoUrl) fetchFileEstimate(repoUrl);
    }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// EVENT LISTENERS
// ─────────────────────────────────────────────────────────────────────────────

/** Close button — slides the panel off-screen.
 *  The 'open' class is on #rl-panel-container (set by content.js),
 *  NOT on #rl-container (inner panel div).
 */
document.getElementById("rl-close")?.addEventListener("click", () => {
  document.getElementById("rl-panel-container")?.classList.remove("open");
});

/** Copy command button (OFFLINE state) */
document.getElementById("rl-copy-cmd")?.addEventListener("click", async function () {
  try {
    await navigator.clipboard.writeText("uvicorn main:app --reload");
    this.textContent = "Copied!";
    setTimeout(() => { this.textContent = "Copy command"; }, 2000);
  } catch {
    // Clipboard API unavailable (e.g. insecure context) — silently ignore
  }
});

/** Index Repository button (NOT_INDEXED state) */
document.getElementById("rl-index-btn")?.addEventListener("click", async () => {
  if (!repoUrl) return;

  try {
    const r = await fetch(`${BACKEND}/index`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ repo_url: repoUrl }),
      signal:  AbortSignal.timeout(10000),
    });

    if (!r.ok) throw new Error(`HTTP ${r.status}`);

    const { job_id } = await r.json();
    showState("INDEXING");
    updateStatusDot("indexing");
    startPolling(job_id);

  } catch (err) {
    // Backend call failed — fall back to OFFLINE
    showState("OFFLINE");
    updateStatusDot("offline");
  }
});

/** Map Repo button (READY state footer) */
document.getElementById("rl-map-btn")?.addEventListener("click", () => {
  // Bypass empty-input check — call sendQuestion directly
  sendQuestion(
    "Give me a plain-English architecture overview of this repository. " +
    "Explain what each top-level folder does, where the main entry points are, " +
    "and how data flows through the system."
  );
});

/** Send button */
document.getElementById("rl-send")?.addEventListener("click", () => {
  const input = document.getElementById("rl-input");
  const q     = input?.value.trim();
  if (!q) return;
  input.value = "";
  sendQuestion(q);
});

/** Textarea — Enter = send, Shift+Enter = newline */
document.getElementById("rl-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    const input = /** @type {HTMLTextAreaElement} */ (e.currentTarget);
    const q     = input.value.trim();
    if (!q) return;
    input.value = "";
    sendQuestion(q);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// BOOTSTRAP
// ─────────────────────────────────────────────────────────────────────────────

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  // DOM is already ready (e.g. panel injected dynamically after parse)
  init();
}
