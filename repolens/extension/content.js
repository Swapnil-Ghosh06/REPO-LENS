/**
 * content.js — RepoLens Content Script
 *
 * Injects the trigger button and panel container into valid GitHub repo pages.
 * Handles GitHub's Turbo/SPA navigation to update or remove the panel on
 * route changes.
 *
 * Rules followed:
 *   - No direct chrome.storage access (Rule 7) — all storage goes via background.js
 *   - URL regex excludes non-repo pages (Rule 9)
 *   - Injects button/panel only once (idempotent)
 */

// ─── URL validation ──────────────────────────────────────────────────────────

/**
 * Matches GitHub repo root and all sub-paths EXCEPT:
 * issues, pulls, settings, actions, wiki, security, graphs, pulse, notifications
 *
 * Capture groups:
 *   [1] owner
 *   [2] repo
 *   [3] optional sub-path (undefined for repo root)
 */
const REPO_REGEX =
  /^https:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)(\/(?!issues|pulls|settings|actions|wiki|security|graphs|pulse|notifications).*)?$/;

/** Returns { owner, repo, repoUrl } if the URL is a valid repo page, else null. */
function parseRepoUrl(url) {
  // Strip query parameters and hash fragments to prevent matching failure
  const cleanUrl = url.split(/[?#]/)[0];
  const match = cleanUrl.match(REPO_REGEX);
  if (!match) return null;
  const owner = match[1];
  const repo = match[2];
  return { owner, repo, repoUrl: `https://github.com/${owner}/${repo}` };
}

// ─── Injection ───────────────────────────────────────────────────────────────

/** Creates and appends the floating trigger button to document.body. */
function injectTriggerButton() {
  const btn = document.createElement("div");
  btn.id = "rl-trigger";
  btn.textContent = "</>";
  btn.title = "Open RepoLens";
  document.body.appendChild(btn);
  return btn;
}

/** Creates and appends the panel container to document.body. */
function injectPanelContainer(repoUrl) {
  const container = document.createElement("div");
  container.id = "rl-panel-container";
  container.setAttribute("data-repo-url", repoUrl);
  document.body.appendChild(container);
  return container;
}

/** Injects the panel CSS link into <head> (idempotent — checks for existing link). */
function injectPanelCSS() {
  if (document.getElementById("rl-panel-css")) return;
  const link = document.createElement("link");
  link.id = "rl-panel-css";
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("panel/panel.css");
  document.head.appendChild(link);
}

// ─── Panel loading ───────────────────────────────────────────────────────────

let panelMounted = false;

/**
 * Fetches panel.html, inserts it into the container, then loads panel.js.
 * Called only the first time the trigger is clicked.
 */
async function mountPanel(container) {
  try {
    const htmlUrl = chrome.runtime.getURL("panel/panel.html");
    const response = await fetch(htmlUrl);
    const html = await response.text();
    container.innerHTML = html;

    // Load panel.js — it bootstraps all panel logic once inserted
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("panel/panel.js");
    document.head.appendChild(script);

    panelMounted = true;
  } catch (err) {
    console.error("[RepoLens] Failed to mount panel:", err);
  }
}

// ─── Main setup ──────────────────────────────────────────────────────────────

/** Full setup for a valid repo page. Idempotent — skips if already injected. */
function setupPanel(repoUrl) {
  // Guard: only inject once per page lifecycle
  if (document.getElementById("rl-trigger")) return;

  injectPanelCSS();

  const trigger = injectTriggerButton();
  const container = injectPanelContainer(repoUrl);

  trigger.addEventListener("click", async () => {
    if (panelMounted) {
      // Toggle visibility for subsequent clicks
      container.classList.toggle("open");
    } else {
      await mountPanel(container);
      container.classList.add("open");
    }
  });
}

/** Removes the trigger button and panel container from the DOM. */
function teardownPanel() {
  document.getElementById("rl-trigger")?.remove();
  document.getElementById("rl-panel-container")?.remove();
  panelMounted = false;
}

// ─── SPA navigation (GitHub uses Turbo) ─────────────────────────────────────

/** Re-evaluates the current URL and sets up or tears down accordingly. */
function recheckURL() {
  const parsed = parseRepoUrl(window.location.href);

  if (!parsed) {
    // Navigated away from a repo page
    teardownPanel();
    return;
  }

  const existingContainer = document.getElementById("rl-panel-container");

  if (!existingContainer) {
    // First visit to a repo page in this SPA session
    setupPanel(parsed.repoUrl);
    return;
  }

  const currentRepoUrl = existingContainer.getAttribute("data-repo-url");
  if (currentRepoUrl !== parsed.repoUrl) {
    // User navigated to a different repo — update the data attribute and notify panel
    existingContainer.setAttribute("data-repo-url", parsed.repoUrl);
    existingContainer.dispatchEvent(
      new CustomEvent("rl:repo-changed", {
        detail: { repoUrl: parsed.repoUrl },
        bubbles: true,
      })
    );
  }
}

// ─── Entrypoint ──────────────────────────────────────────────────────────────

(function init() {
  const parsed = parseRepoUrl(window.location.href);
  if (!parsed) return; // Not a repo page — do nothing

  setupPanel(parsed.repoUrl);

  // GitHub uses Turbo for SPA navigation; also handle manual back/forward
  document.addEventListener("turbo:load", recheckURL);
  window.addEventListener("popstate", recheckURL);
})();
