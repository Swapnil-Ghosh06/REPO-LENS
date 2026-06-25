/**
 * background.js — RepoLens Service Worker
 *
 * Handles all chrome.storage reads/writes on behalf of the extension.
 * Panel.js must never access chrome.storage directly; all I/O is routed here
 * via chrome.runtime.sendMessage (per Rule 7 in Rules.md).
 */

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
