/**
 * background.js — RepoLens Service Worker
 *
 * Handles all chrome.storage reads/writes on behalf of the extension.
 * Panel.js must never access chrome.storage directly; all I/O is routed here
 * via chrome.runtime.sendMessage (per Rule 7 in Rules.md).
 */

// ─── Service Worker Keepalive ─────────────────────────────────────────────────
// Chrome MV3 terminates idle service workers after ~30 seconds.
// chrome.alarms wakes the worker every ~24 seconds for <10ms — near-zero RAM.
// This is the official Google-recommended keepalive pattern for MV3 extensions.
// The worker is NOT kept permanently in RAM — it sleeps between alarm ticks.

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("rl-keepalive", { periodInMinutes: 0.4 }); // ~24 seconds
});

chrome.runtime.onStartup.addListener(() => {
  // Alarms don't survive Chrome restarts — recreate on every startup
  chrome.alarms.create("rl-keepalive", { periodInMinutes: 0.4 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  // No-op handler — the act of responding keeps the service worker alive.
  // Do NOT add logic here; this must stay empty to avoid CPU overhead.
  if (alarm.name !== "rl-keepalive") return;
});

// ─── Storage Message Router ───────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    // ─── Repo index status ───────────────────────────────────────────────────

    case "GET_REPO_STATUS": {
      chrome.storage.local.get("indexed_repos", (result) => {
        const repos = result.indexed_repos || {};
        sendResponse(repos[message.repo_url] || null);
      });
      return true; // keep channel open for async sendResponse
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

    // ─── Per-repo chat history (session-scoped, cleared on browser close) ────

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

    default:
      // Unknown message type — do not keep channel open
      return false;
  }
});
