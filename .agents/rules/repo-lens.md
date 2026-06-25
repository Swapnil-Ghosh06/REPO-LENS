---
trigger: always_on
---

# RepoLens — Rules

**Version:** 2.0
**For:** AI agents (Antigravity) and the developer building this project.

Read this file before writing any code. These rules exist because the mistakes they prevent have already been anticipated. Breaking them will cost you hours.

---

## Part 1 — AI Agent Rules (Antigravity)

These rules govern how the AI agent must behave when generating code for RepoLens.

---

### Rule 1: One file per prompt. One prompt per phase.

Never attempt to generate the entire backend or the entire extension in a single prompt. Each prompt in `ImplementationPlan.md` targets exactly one module. Follow that order.

**Wrong:**
> "Build the entire FastAPI backend with crawler, parser, embedder, vectorstore, and RAG."

**Right:**
> Paste the Phase 1 prompt → get crawler.py → test it → move to Phase 2.

---

### Rule 2: Always paste the context primer when starting a new chat.

When the model's context fills up or you start a new chat for a new phase, paste this at the very top before the prompt:

```
CONTEXT: I'm building RepoLens — a Chrome/Firefox browser extension that lets developers
chat with any GitHub repository using RAG (Retrieval-Augmented Generation).

Architecture:
- Backend: Python 3.11, FastAPI, ChromaDB, Gemini text-embedding-004, Gemini 1.5 Flash
- Extension: Chrome MV3, vanilla JS, no build step, panel injected into GitHub pages

Reference documents: PRD.md, TechStack.md, Schema.md, Design.md,
ExtensionFlow.md, ImplementationPlan.md, Rules.md

I am now working on: [PHASE NAME]
[Paste the prompt from ImplementationPlan.md]
```

Without this, the AI will generate code that conflicts with the architecture already established.

---

### Rule 3: Reference Schema.md as the single source of truth.

All data structures, API contracts, storage keys, and prompt templates are defined in `Schema.md`. If the AI generates code with different field names, different storage keys, or a different API response shape — correct it to match Schema.md before moving on.

Common drift points to watch:
- `chunk_id` format must be `f"{relative_path}::{start_line}"` — not `file_path + line`
- Storage message types must exactly match: `"GET_REPO_STATUS"`, `"SET_REPO_STATUS"`, etc.
- SSE event names must be: `token`, `sources`, `done`, `error` — not `message`, `data`, `complete`

---

### Rule 4: Reference Design.md for all panel UI.

When generating panel.html, panel.css, or panel.js, the prompt must explicitly reference Design.md. The AI must use:
- The exact hex color values from the color system table
- Inter for UI text, JetBrains Mono for code/paths
- The exact component specs (heights, paddings, border-radius values)

**If the generated CSS deviates from Design.md**, it is wrong. Do not accept it.

---

### Rule 5: No gradients, no glow, no animations except the approved ones.

The only approved animations are:
- Panel slide: `transform translateX`, `0.2s ease-out`
- Message fade-in: `opacity 0`, `animation fadeIn 0.15s ease forwards`
- Progress bar fill: `transition: width 0.3s ease-out`
- Streaming cursor blink: `animation: blink 0.8s step-end infinite`

Any other animation the AI adds must be removed. This is a developer tool, not a landing page.

---

### Rule 6: All Python exceptions must be caught at the module boundary.

Every backend module must handle its own errors and either return a safe value or raise a descriptive exception that `main.py` can catch. The AI must not write bare `except: pass` — errors must be logged or propagated.

**Wrong:**
```python
try:
    files = crawl_repo(url)
except:
    pass
```

**Right:**
```python
try:
    files = crawl_repo(url)
except Exception as e:
    job["status"] = "error"
    job["error"] = f"Crawl failed: {str(e)}"
    return
```

---

### Rule 7: No direct `chrome.storage` access from panel.js.

All storage reads and writes must go through `chrome.runtime.sendMessage` to `background.js`. Panel.js is injected into a GitHub page and may not always have full storage API access.

**Wrong (in panel.js):**
```javascript
chrome.storage.session.get("chat_history_...", callback)
```

**Right (in panel.js):**
```javascript
chrome.runtime.sendMessage({ type: "GET_CHAT_HISTORY", key: "chat_" + repo_url }, (response) => {
  const messages = response || [];
});
```

---

### Rule 8: Use `tree-sitter-languages`, not individual tree-sitter language packages.

```
pip install tree-sitter-languages
```

NOT:
```
pip install tree-sitter-python tree-sitter-javascript
```

Individual packages require a C compiler to build on Windows. `tree-sitter-languages` ships as a pre-built wheel for all platforms.

---

### Rule 9: The extension must not activate on non-repo GitHub pages.

The URL regex must exclude: `/issues`, `/pulls`, `/settings`, `/actions`, `/wiki`, `/security`, `/graphs`, `/pulse`, `/notifications`, and profile pages (`github.com/{user}` without a repo).

The regex is defined in `ExtensionFlow.md`. Do not modify it unless you understand the implications.

---

### Rule 10: ChromaDB metadata values must be primitive types only.

ChromaDB does not accept lists or dicts as metadata values. Every metadata field must be a `str`, `int`, or `float`.

**Wrong:**
```python
metadata = { "tags": ["auth", "middleware"] }  # list — will throw
```

**Right:**
```python
metadata = { "chunk_type": "function", "start_line": 42 }
```

---

### Rule 11: Always use `AbortSignal.timeout()` for backend fetch calls in the extension.

Every `fetch()` call to `localhost:8000` must include a timeout. If the backend is slow or unreachable, the panel must not hang.

```javascript
// Health check
fetch("http://localhost:8000/health", { signal: AbortSignal.timeout(3000) })

// Query
fetch("http://localhost:8000/query", { signal: AbortSignal.timeout(60000), ... })
```

---

### Rule 12: The Gemini streaming API must be used correctly.

```python
model = genai.GenerativeModel("gemini-1.5-flash")
response = model.generate_content(contents, stream=True)
for chunk in response:
    if chunk.text:
        yield f"event: token\ndata: {json.dumps({'text': chunk.text})}\n\n"
```

Do NOT use `chunk.candidates[0].content.parts[0].text` — it breaks on empty chunks. Always guard with `if chunk.text`.

---

### Rule 13: Batch Gemini embedding calls with a 1-second sleep between batches.

```python
for i in range(0, len(chunks), 20):
    batch = chunks[i:i+20]
    # embed batch
    time.sleep(1)
```

Without the sleep, you will hit Gemini's rate limit on large repos (500+ files).

---

### Rule 14: When the AI context fills up — the recovery procedure.

Signs that context is filling up:
- The AI starts ignoring constraints you gave it earlier
- The AI regenerates files from scratch instead of editing
- The AI contradicts itself about the architecture
- Responses become shorter and less accurate

**Recovery steps:**
1. Stop. Do not try to push more into the same chat.
2. Open a new chat.
3. Paste the context primer (Rule 2).
4. Paste the current state of the file you were working on.
5. Describe exactly what you need next.
6. Use **Sonnet 4.6 (Thinking)** if the problem involves complex logic.
7. Use **Opus 4.6 (Thinking)** if Sonnet keeps getting it wrong.

---

## Part 2 — Developer Rules

These rules govern how you (the human) build this project.

---

### Rule D1: Never run code you haven't read.

Read every file the AI generates before running it. Look for:
- Hardcoded paths that assume a specific OS
- Import statements for packages not in `requirements.txt`
- API calls that differ from the Schema.md contract
- Missing error handling

---

### Rule D2: Test each phase in isolation before moving to the next.

Every phase has a test command in `ImplementationPlan.md`. Run it. If it fails, fix it before continuing. Do not move to Phase 3 with a broken Phase 2 — the issues compound.

---

### Rule D3: Pin your dependencies immediately.

After `pip install`, run:
```bash
pip freeze > requirements.txt
```

Do this before writing a single line of code. `chromadb` and `google-generativeai` have breaking changes between minor versions.

---

### Rule D4: Test Gemini API access before Phase 3.

Run this first:
```python
import google.generativeai as genai
genai.configure(api_key="YOUR_KEY")
result = genai.embed_content(model="models/text-embedding-004", content="test", task_type="RETRIEVAL_QUERY")
print(len(result["embedding"]))  # Should print 768
```

If this fails, fix it before building embedder.py.

---

### Rule D5: Keep the extension manifest minimal.

Only request the permissions you actually use. The current list is: `activeTab`, `storage`, `scripting`. Do not add permissions the AI suggests unless you understand why they're needed — Chrome Web Store reviewers flag excessive permissions.

---

### Rule D6: The design is a constraint, not a suggestion.

The Design.md spec exists because vibe-coded extensions look amateurish and don't get GitHub stars. If the AI generates a gradient, a glowing shadow, or a bouncing icon — reject it. The spec is the spec.

---

### Rule D7: Document what broke and how you fixed it.

Keep a running `DEVLOG.md` or comments in `Tracker.md`. When something breaks in a non-obvious way, write down the root cause and the fix. This saves you hours when you encounter the same issue again. It also makes the project's README more useful to others.

---

## Part 3 — What to Do When Things Break

| Symptom | Likely Cause | Fix |
|---|---|---|
| `tree-sitter` install fails | Missing C compiler on Windows | Use `pip install tree-sitter-languages` instead |
| ChromaDB `InvalidCollectionException` | Collection name has invalid chars | Use `_collection_name()` helper from vectorstore.py |
| Gemini `ResourceExhausted` error | Rate limit hit | Add `time.sleep(1)` between embedding batches |
| Extension button doesn't appear | URL regex not matching | Open DevTools console on the GitHub page, check for content.js errors |
| Panel CSS broken / GitHub CSS leaking | Style conflict | Add `all: initial` to `#rl-container` or use Shadow DOM |
| SSE stream hangs forever | Missing `done` event or fetch not consuming stream | Check rag.py is yielding `event: done\ndata: {}\n\n` at the end |
| `chrome.storage.session` is undefined | Accessed from content script | Route all session storage through background.js via sendMessage |
| CORS error in panel | FastAPI CORS middleware missing | Ensure `allow_origins=["*"]` in main.py during development |
| Gemini streaming returns empty text | Accessing wrong field on chunk | Use `if chunk.text:` not `chunk.candidates[0]...` |
