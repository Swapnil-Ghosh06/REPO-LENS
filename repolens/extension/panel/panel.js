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

const BACKEND = "http://127.0.0.1:8000";
const INDEX_CACHE_TTL = 86400; // 24 hours in seconds

/** @type {string} Populated on init from container dataset */
let repoUrl = "";
/** @type {string} e.g. "owner/repo" */
let repoName = "";
/** @type {boolean} Prevent concurrent sendQuestion calls */
let isSending = false;
/** @type {string|null} Tracks the active indexing job */
let currentJobId = null;
/** @type {string|null} Tracks the previous state before opening help */
let prevState = null;
/** @type {number|null} setInterval ID from startPolling() — declared here to prevent global leak */
let pollInterval = null;
/** @type {Function|null} Cleanup fn for the visibilitychange offline retry listener */
let offlineRetryCleanup = null;

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

  const triggerDot = document.getElementById("rl-trigger-dot");
  if (triggerDot) {
    triggerDot.style.background = DOT_COLORS[state] ?? DOT_COLORS.idle;
  }
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
 * @param {string} job_id
 */
function startPolling(job_id) {
  if (pollInterval) clearInterval(pollInterval);
  currentJobId = job_id;
  
  pollInterval = setInterval(async () => {
    try {
      const r = await fetch(
        `${BACKEND}/status/${currentJobId}`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (!r.ok) {
        if (r.status === 404) {
          clearInterval(pollInterval);
          try {
            const indexedResp = await fetch(
              `${BACKEND}/indexed?repo_url=${encodeURIComponent(repoUrl)}`,
              { signal: AbortSignal.timeout(5000) }
            );
            if (indexedResp.ok) {
              const data = await indexedResp.json();
              if (data.indexed) {
                chrome.runtime.sendMessage({
                  type:     "SET_REPO_STATUS",
                  repo_url: repoUrl,
                  data: {
                    indexed_at: Date.now() / 1000,
                    job_id:     currentJobId,
                    status:     "done",
                  },
                });
                showState("READY");
                updateStatusDot("ready");
              } else {
                showState("NOT_INDEXED");
                updateStatusDot("idle");
                const descEl = document.getElementById("rl-not-indexed-desc");
                if (descEl) {
                  descEl.textContent = "Server was restarted. Please re-index.";
                  descEl.style.color = "var(--error)";
                }
              }
            } else {
              showState("NOT_INDEXED");
              updateStatusDot("idle");
              const descEl = document.getElementById("rl-not-indexed-desc");
              if (descEl) {
                descEl.textContent = "Server was restarted. Please re-index.";
                descEl.style.color = "var(--error)";
              }
            }
          } catch {
            showState("NOT_INDEXED");
            updateStatusDot("idle");
            const descEl = document.getElementById("rl-not-indexed-desc");
            if (descEl) {
              descEl.textContent = "Server was restarted. Please re-index.";
              descEl.style.color = "var(--error)";
            }
          }
        }
        return;
      }

      const job = await r.json();

      // Update indexing label dynamically based on phase
      const labelEl = document.getElementById("rl-indexing-label");
      if (labelEl) {
        if (job.status === "cloning") labelEl.textContent = "Cloning repository...";
        else if (job.status === "parsing") labelEl.textContent = "Parsing files...";
        else if (job.status === "indexing") labelEl.textContent = "Generating embeddings...";
        else labelEl.textContent = "Indexing repository...";
      }

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

      // Secondary embedded counter
      const embeddedEl = document.getElementById("rl-embedded-count");
      if (embeddedEl) {
        embeddedEl.textContent = `${job.files_embedded ?? job.files_processed ?? 0} files embedded`;
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
      if (elapsedEl) {
        // Hide "0:00" initially so it doesn't look broken
        elapsedEl.style.opacity = elapsed < 3 ? "0" : "1";
        elapsedEl.textContent = `Elapsed: ${m}:${s}`;
      }

      // ── Terminal states ────────────────────────────────────────────────────

      if (job.status === "done") {
        clearInterval(pollInterval);
        try {
          chrome.runtime.sendMessage({
            type:     "SET_REPO_STATUS",
            repo_url: repoUrl,
            data: {
              indexed_at: Date.now() / 1000,
              job_id:     currentJobId,
              file_count: job.total_files,
              status:     "done",
            },
          });
        } catch (err) {
          console.warn("Could not save status to extension storage:", err);
        }
        showState("READY");
        updateStatusDot("ready");
        showEmptyHint(); // fresh index, chat history is empty

      } else if (job.status === "error" || job.status === "canceled") {
        clearInterval(pollInterval);
        if (fileEl) {
          if (job.status === "canceled") {
            fileEl.textContent = "Canceled by user.";
          } else if (job.error_type === "too_large") {
            fileEl.textContent = "This repo has too many files for RepoLens v1 (500 file limit). Try a smaller or more focused repository.";
          } else {
            fileEl.textContent = `Error: ${job.error ?? "Unknown error"}`;
          }
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

  // Faint timestamp below each message
  const now = new Date();
  const hh  = String(now.getHours()).padStart(2, "0");
  const mm  = String(now.getMinutes()).padStart(2, "0");
  const timeEl = document.createElement("span");
  timeEl.className = "rl-message-time";
  timeEl.textContent = `${hh}:${mm}`;
  div.appendChild(timeEl);

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
      chip.href = `https://github.com/${repoName}/blob/HEAD/${relativePath}${
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

function showEmptyHint() {
  const messages = document.getElementById("rl-messages");
  if (!messages) return;

  messages.innerHTML = "";

  const hintDiv = document.createElement("div");
  hintDiv.className = "rl-empty-hint";

  hintDiv.innerHTML = `
    <strong>Repository Indexing Complete!</strong>
    <p>A README tells you what a project does. RepoLens tells you <strong>how</strong> it does it, specific to your exact task.</p>
    <div style="padding: 12px; background: var(--bg-surface); border-radius: 8px; border: 1px solid var(--border-muted);">
      <p style="color: var(--accent); font-weight: 700; margin-bottom: 6px;">What to do next:</p>
      <p style="font-size: 14px; line-height: 1.5; color: var(--text-primary);">Start typing in the input bar below. Ask anything about the codebase. The AI will retrieve the most relevant logic and give you actionable answers.</p>
    </div>
    <p style="margin-top: 8px; font-weight: 700; color: var(--text-primary);">Try asking questions like:</p>
    <ul class="rl-help-list">
      <li><span class="rl-check">✓</span> "Where is the main entry point of the application?"</li>
      <li><span class="rl-check">✓</span> "How is authentication handled in this codebase?"</li>
      <li><span class="rl-check">✓</span> "Explain the directory structure and main modules."</li>
    </ul>
    <p style="margin-top: 8px; font-size: 14px;">Or click the <strong>Map</strong> button below to generate a plain-English architecture overview of the entire repository.</p>
  `;
  messages.appendChild(hintDiv);
}

function loadChatHistory() {
  chrome.runtime.sendMessage(
    { type: "GET_CHAT_HISTORY", key: `chat_${repoUrl}` },
    (messages) => {
      const msgs = messages || [];
      if (msgs.length === 0) {
        showEmptyHint();
      } else {
        const msgContainer = document.getElementById("rl-messages");
        if (msgContainer) msgContainer.innerHTML = "";
        msgs.forEach((msg) =>
          appendMessage(msg.role, msg.content, msg.sources)
        );
        scrollToBottom();
      }
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

  // Hide autocomplete dropdown on send
  document.getElementById("rl-autocomplete")?.classList.add("rl-autocomplete-hidden");

  // Clear any existing rate limit banner
  const existingBanner = document.querySelector(".rl-rate-limit-banner");
  if (existingBanner) existingBanner.remove();

  // Clear empty/welcome hint if it's currently showing
  const messagesDiv = document.getElementById("rl-messages");
  if (messagesDiv && messagesDiv.querySelector(".rl-empty-hint")) {
    messagesDiv.innerHTML = "";
  }

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
          if (data.message === "rate_limit") {
            if (assistantDiv) assistantDiv.remove();
            showRateLimitBanner(data.user_message);
          } else {
            assistantDiv.textContent = `Error: ${data.message ?? "Unknown error"}`;
            assistantDiv.style.color = "var(--error)";
          }
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
// OFFLINE RETRY — Page Visibility API (zero timers, zero background RAM)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registers a one-shot visibilitychange listener that re-runs
 * checkBackendAndRoute() the next time the user brings this tab into focus.
 * Zero polling overhead — fires only on user tab-switch action.
 */
function scheduleOfflineRetry() {
  // Cancel any previously registered listener to prevent stacking
  if (offlineRetryCleanup) { offlineRetryCleanup(); offlineRetryCleanup = null; }

  function onVisible() {
    if (document.visibilityState === "visible") {
      document.removeEventListener("visibilitychange", onVisible);
      offlineRetryCleanup = null;
      checkBackendAndRoute();
    }
  }

  document.addEventListener("visibilitychange", onVisible);
  offlineRetryCleanup = () => document.removeEventListener("visibilitychange", onVisible);
}

/**
 * Re-runnable health check + state routing.
 * Called by: init(), the refresh button, and scheduleOfflineRetry().
 * Does NOT re-bind DOM listeners — that is init()'s sole responsibility.
 */
async function checkBackendAndRoute() {
  // Cancel any pending offline retry before starting a fresh check
  if (offlineRetryCleanup) { offlineRetryCleanup(); offlineRetryCleanup = null; }

  // ── Health check ────────────────────────────────────────────────────────────
  try {
    const r = await fetch(`${BACKEND}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) throw new Error("unhealthy");
  } catch {
    showState("OFFLINE");
    updateStatusDot("offline");
    scheduleOfflineRetry(); // Re-check next time user focuses this tab — no timer
    return;
  }

  // ── Check storage for prior index ───────────────────────────────────────────
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
      const descEl = document.getElementById("rl-not-indexed-desc");
      if (descEl) {
        descEl.textContent = "This repository hasn't been indexed yet.";
        descEl.style.color = "";
      }
      if (repoUrl) fetchFileEstimate(repoUrl);
    }
  );
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

  // ── 2+3. Health check + state routing ──────────────────────────────────────
  await checkBackendAndRoute();

  // ── 4. Bind all DOM event listeners (called only once on mount) ─────────────
  bindListeners();
}

// ─────────────────────────────────────────────────────────────────────────────
// EVENT LISTENERS
// Called from init() AFTER panel.html has been injected into the DOM.
// Never call at module load time — the elements don't exist yet.
// ─────────────────────────────────────────────────────────────────────────────

function bindListeners() {
  /** Minimize button — slides the panel off-screen.
   *  The 'open' class is on #rl-panel-container (set by content.js),
   *  NOT on #rl-container (inner panel div).
   */
  document.getElementById("rl-minimize")?.addEventListener("click", () => {
    document.getElementById("rl-panel-container")?.classList.remove("open");
  });

  /** Terminate button — hide panel instead of terminating script */
  document.getElementById("rl-close")?.addEventListener("click", async () => {
    // If indexing, send cancel request
    if (currentJobId) {
       try {
           await fetch(`${BACKEND}/cancel`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ job_id: currentJobId })
           });
       } catch (err) {
           console.error("[RepoLens] Failed to cancel job:", err);
       }
    }
    // Just minimize instead of terminating
    document.getElementById("rl-panel-container")?.classList.remove("open");
  });

  /** Help toggle button */
  document.getElementById("rl-help-btn")?.addEventListener("click", () => {
    const overlay = document.getElementById("rl-help-overlay");
    if (overlay) {
      overlay.classList.add("open");
    }
  });

  /** Help close button */
  document.getElementById("rl-help-close")?.addEventListener("click", () => {
    const overlay = document.getElementById("rl-help-overlay");
    if (overlay) {
      overlay.classList.remove("open");
    }
  });

  /** Help maximize toggle */
  document.getElementById("rl-help-maximize")?.addEventListener("click", () => {
    const overlay = document.getElementById("rl-help-overlay");
    if (overlay) {
      overlay.classList.toggle("maximized");
    }
  });

  /**
   * Refresh button — re-runs health check + state routing from any panel state.
   * Does NOT re-bind listeners (calls checkBackendAndRoute, not init).
   * Spins the icon for 0.6s as visual feedback.
   */
  document.getElementById("rl-refresh-btn")?.addEventListener("click", async () => {
    const btn = document.getElementById("rl-refresh-btn");
    if (btn) { btn.classList.add("rl-spinning"); btn.disabled = true; }
    // Stop any active indexing poll before re-checking
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    await checkBackendAndRoute();
    setTimeout(() => {
      if (btn) { btn.classList.remove("rl-spinning"); btn.disabled = false; }
    }, 600);
  });

  /** Copy command button (OFFLINE state) — SVG icon, show checkmark briefly */
  document.getElementById("rl-copy-cmd")?.addEventListener("click", async function () {
    const btn = this;
    const originalHTML = btn.innerHTML;
    try {
      await navigator.clipboard.writeText("uvicorn main:app --reload");
      btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 8l4 4 6-7" stroke="var(--success)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      setTimeout(() => { btn.innerHTML = originalHTML; }, 2000);
    } catch {
      // Clipboard API unavailable — silently ignore
    }
  });

  /** Index Repository button (NOT_INDEXED state) */
  document.getElementById("rl-index-btn")?.addEventListener("click", async () => {
    if (!repoUrl) return;

    const descEl = document.getElementById("rl-not-indexed-desc");
    if (descEl) {
      descEl.textContent = "This repository hasn't been indexed yet.";
      descEl.style.color = "";
    }

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
    document.getElementById("rl-autocomplete")?.classList.add("rl-autocomplete-hidden");
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
      input.style.height = "";
      document.getElementById("rl-autocomplete")?.classList.add("rl-autocomplete-hidden");
      sendQuestion(q);
    }
  });

  /** Textarea auto-grow — adjusts height to content, capped by max-height in CSS */
  document.getElementById("rl-input")?.addEventListener("input", function () {
    this.style.height = "";
    this.style.height = Math.min(this.scrollHeight, 100) + "px";
  });

  // ─── Custom Resizer Logic ───
  const container = document.getElementById("rl-container");
  
  function setupResizer(id, direction) {
    const resizer = document.getElementById(id);
    if (!resizer) return;
    
    let isResizing = false;
    let startX = 0, startY = 0;
    let startWidth = 0, startHeight = 0;

    resizer.addEventListener("mousedown", (e) => {
      isResizing = true;
      startX = e.clientX;
      startY = e.clientY;
      startWidth = parseInt(window.getComputedStyle(container).width, 10);
      startHeight = parseInt(window.getComputedStyle(container).height, 10);
      document.body.style.userSelect = "none";
      e.stopPropagation();
    });

    document.addEventListener("mousemove", (e) => {
      if (!isResizing) return;
      if (direction === "left" || direction === "corner") {
        const newWidth = startWidth + (startX - e.clientX);
        if (newWidth >= 320) container.style.width = newWidth + "px";
      }
      if (direction === "bottom" || direction === "corner") {
        const newHeight = startHeight + (e.clientY - startY);
        if (newHeight >= 400) container.style.height = newHeight + "px";
      }
    });

    document.addEventListener("mouseup", () => {
      if (isResizing) {
        isResizing = false;
        document.body.style.userSelect = "";
      }
    });
  }

  setupResizer("rl-resizer-left", "left");
  setupResizer("rl-resizer-bottom", "bottom");
  setupResizer("rl-resizer-corner", "corner");

  // Autocomplete bindings
  const inputEl = document.getElementById("rl-input");
  inputEl?.addEventListener("input", updateAutocomplete);
  inputEl?.addEventListener("focus", updateAutocomplete);

  // Click outside listener (only bind once)
  document.addEventListener("click", (e) => {
    const container = document.getElementById("rl-autocomplete");
    const input = document.getElementById("rl-input");
    if (container && !container.contains(e.target) && e.target !== input) {
      container.classList.add("rl-autocomplete-hidden");
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTOCOMPLETE & WORD PREDICTIONS
// ─────────────────────────────────────────────────────────────────────────────

const CURIOUS_QUESTIONS = [
  "Why is this project helpful?",
  "What makes this project different?",
  "What is the developer trying to achieve?",
  "Is there any other project in the market like this?",
  "Who is the strongest competitor for this project?",
  "What is the core technology stack used here?",
  "How does the main entry point or routing work?",
  "Are there any known issues or limitations?",
  "How do I get started with installing and running it?",
  "What is the project's folder structure?",
  "How is error handling and logging done?",
  "What are the configuration parameters in this project?"
];

const TYPO_MAP = {
  "hepl": "helpful",
  "heplful": "helpful",
  "hlp": "helpful",
  "hlpful": "helpful",
  "dif": "different",
  "diferent": "different",
  "diffrent": "different",
  "achiv": "achieve",
  "acheve": "achieve",
  "achieve": "achieve",
  "comp": "competitor",
  "compettr": "competitor",
  "competiter": "competitor",
  "mrket": "market",
  "arch": "architecture",
  "architecure": "architecture",
  "archtecture": "architecture",
  "tech": "technology",
  "technolgy": "technology",
  "db": "database",
  "datbase": "database",
  "auth": "authentication",
  "authentcation": "authentication",
  "install": "installation",
  "instalation": "installation",
  "config": "configuration",
  "configration": "configuration",
  "perf": "performance",
  "performence": "performance",
  "deploy": "deployment",
  "deploment": "deployment",
  "struct": "structure",
  "stucture": "structure",
  "feat": "features",
  "featur": "features",
  "dev": "developer",
  "developper": "developer",
  "proj": "project",
  "progect": "project",
  "code": "codebase",
  "codbase": "codebase",
  "repo": "repository",
  "repositry": "repository"
};

function updateAutocomplete() {
  const input = document.getElementById("rl-input");
  const container = document.getElementById("rl-autocomplete");
  const predictionsDiv = document.getElementById("rl-autocomplete-predictions");
  const questionsDiv = document.getElementById("rl-autocomplete-questions");
  
  if (!input || !container || !predictionsDiv || !questionsDiv) return;

  const text = input.value;
  const trimmed = text.trim();

  // If input is empty, show all curious questions as starting suggestions, but no word predictions!
  if (!trimmed) {
    predictionsDiv.innerHTML = "";
    predictionsDiv.style.display = "none";
    
    questionsDiv.innerHTML = "";
    CURIOUS_QUESTIONS.forEach(q => {
      const btn = document.createElement("button");
      btn.className = "rl-question-item";
      btn.textContent = q;
      btn.addEventListener("click", () => {
        input.value = q;
        container.classList.add("rl-autocomplete-hidden");
        input.focus();
        // Adjust height
        input.style.height = "";
        input.style.height = Math.min(input.scrollHeight, 100) + "px";
      });
      questionsDiv.appendChild(btn);
    });
    
    container.classList.remove("rl-autocomplete-hidden");
    return;
  }

  // 1. Word Predictions & Typo Fixing
  // Find the last word the user is currently typing
  const words = text.split(/\s+/);
  const lastWordRaw = words[words.length - 1] || "";
  const lastWord = lastWordRaw.toLowerCase().replace(/[^a-z]/g, "");

  let predictions = [];

  if (lastWord.length >= 2) {
    // Check if it matches a typo key
    if (TYPO_MAP[lastWord]) {
      predictions.push(TYPO_MAP[lastWord]);
    }
    // Check prefix match in our vocabulary
    const vocabulary = Object.values(TYPO_MAP);
    for (const vocabWord of vocabulary) {
      if (vocabWord.startsWith(lastWord) && vocabWord !== lastWord && !predictions.includes(vocabWord)) {
        predictions.push(vocabWord);
      }
    }
  }

  // Populate prediction pills
  predictionsDiv.innerHTML = "";
  if (predictions.length > 0) {
    predictionsDiv.style.display = "flex";
    predictions.slice(0, 3).forEach(pred => {
      const pill = document.createElement("button");
      pill.className = "rl-pred-pill";
      pill.textContent = pred;
      pill.addEventListener("click", () => {
        // Replace the last word with the predicted word
        words[words.length - 1] = pred;
        input.value = words.join(" ") + " ";
        container.classList.add("rl-autocomplete-hidden");
        input.focus();
        updateAutocomplete(); // Recalculate
      });
      predictionsDiv.appendChild(pill);
    });
  } else {
    predictionsDiv.style.display = "none";
  }

  // 2. Matching Curious Questions
  // Filter questions that contain the words typed so far (case-insensitive)
  const queryTerms = trimmed.toLowerCase().split(/\s+/).filter(t => t.length > 1);
  let matchingQuestions = [];
  
  if (queryTerms.length === 0) {
    matchingQuestions = CURIOUS_QUESTIONS;
  } else {
    matchingQuestions = CURIOUS_QUESTIONS.filter(q => {
      const qLower = q.toLowerCase();
      // Match if all terms are contained in the question
      return queryTerms.every(term => qLower.includes(term));
    });
  }

  questionsDiv.innerHTML = "";
  if (matchingQuestions.length > 0) {
    matchingQuestions.slice(0, 5).forEach(q => {
      const btn = document.createElement("button");
      btn.className = "rl-question-item";
      btn.textContent = q;
      btn.addEventListener("click", () => {
        input.value = q;
        container.classList.add("rl-autocomplete-hidden");
        input.focus();
        // Adjust height
        input.style.height = "";
        input.style.height = Math.min(input.scrollHeight, 100) + "px";
      });
      questionsDiv.appendChild(btn);
    });
  } else {
    // If no exact match from curious questions, just show a subset of default questions
    CURIOUS_QUESTIONS.slice(0, 3).forEach(q => {
      const btn = document.createElement("button");
      btn.className = "rl-question-item";
      btn.textContent = q;
      btn.addEventListener("click", () => {
        input.value = q;
        container.classList.add("rl-autocomplete-hidden");
        input.focus();
        input.style.height = "";
        input.style.height = Math.min(input.scrollHeight, 100) + "px";
      });
      questionsDiv.appendChild(btn);
    });
  }

  container.classList.remove("rl-autocomplete-hidden");
}

// ─────────────────────────────────────────────────────────────────────────────
// BOOTSTRAP
// ─────────────────────────────────────────────────────────────────────────────

window.addEventListener("rl:mount-panel", init);

function showRateLimitBanner(userMessage) {
  const existing = document.querySelector(".rl-rate-limit-banner");
  if (existing) existing.remove();

  const banner = document.createElement("div");
  banner.className = "rl-rate-limit-banner";

  const msgSpan = document.createElement("span");
  msgSpan.textContent = userMessage || "Gemini daily limit reached.";
  banner.appendChild(msgSpan);

  const upgradeLink = document.createElement("a");
  upgradeLink.textContent = "Upgrade on Google AI Studio";
  upgradeLink.href = "https://aistudio.google.com/";
  upgradeLink.target = "_blank";
  upgradeLink.rel = "noopener noreferrer";

  upgradeLink.addEventListener("click", (e) => {
    e.preventDefault();
    window.open("https://aistudio.google.com/", "_blank");
  });

  banner.appendChild(upgradeLink);

  const container = document.getElementById("rl-container");
  if (container) {
    container.appendChild(banner);
  }
}
