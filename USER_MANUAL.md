# RepoLens User Manual

## 1. What is RepoLens
RepoLens is a Chrome and Firefox browser extension that enables developers to chat directly with any GitHub repository using Retrieval-Augmented Generation (RAG). It works by injecting an AI chat panel into GitHub pages, allowing you to ask codebase-specific questions backed by a local vector database and the Gemini API.

## 2. Requirements
- Python 3.12+
- Gemini API Key
- Google Chrome or Mozilla Firefox

## 3. Installation — Backend Setup

### Windows
```powershell
git clone https://github.com/Swapnil-Ghosh06/REPO-LENS.git
cd REPO-LENS/backend
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
# Set your Gemini API key
$env:GEMINI_API_KEY="your_api_key_here"
# Run the backend
uvicorn main:app --reload
```

### macOS/Linux
```bash
git clone https://github.com/Swapnil-Ghosh06/REPO-LENS.git
cd REPO-LENS/backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
# Set your Gemini API key
export GEMINI_API_KEY="your_api_key_here"
# Run the backend
uvicorn main:app --reload
```

## 4. Installation — Loading the Extension in Chrome
1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** in the top right corner.
3. Click **Load unpacked** in the top left corner.
4. Select the `extension` folder inside your cloned `REPO-LENS` directory.
5. The RepoLens extension icon should now appear in your browser toolbar.

## 5. Using RepoLens
1. Ensure your local backend is running (`uvicorn main:app --reload`).
2. Navigate to any public repository on GitHub.
3. You will see the RepoLens panel injected on the right side of the page (or click the extension icon to open it).
   [SCREENSHOT: RepoLens chat panel visible on a GitHub repository page]
4. The extension will automatically index the repository on your first query.
   [SCREENSHOT: Progress bar showing repository crawling and embedding status]
5. Type your question in the chat input and press Enter.
   [SCREENSHOT: Chat interface showing a question about the codebase and the AI's streaming response]

## 6. What Makes a Good Question

**Good:** "Where is the authentication middleware defined, and how does it handle expired tokens?"
**Bad:** "How does auth work?"
*(Why: The good question gives specific technical context and asks for a concrete mechanism.)*

**Good:** "What is the entry point for the vector indexing pipeline in `vectorstore.py`?"
**Bad:** "Explain the backend."
*(Why: The good question scopes the inquiry to a specific module and process, yielding a targeted response.)*

**Good:** "Give me an example of how to call the `crawl_repo` function with custom timeout settings based on the existing code."
**Bad:** "Write code for crawling."
*(Why: The good question asks the AI to ground its code generation in the actual codebase patterns rather than hallucinating generic code.)*

## 7. Limitations
- **500 File Cap:** Repositories exceeding 500 files are not fully indexed to prevent rate limits and memory issues.
- **Public Repos Only:** The extension cannot currently fetch code from private repositories.
- **Local Backend Required:** The extension relies on a local FastAPI backend; it will not work if the backend is not running.

## 8. Troubleshooting

**Error:** `Failed to fetch` or Panel Hangs Forever
- **Fix:** Your local backend is either not running or not listening on port 8000. Ensure you have run `uvicorn main:app --reload` in the `backend` directory.

**Error:** `chromadb.errors.InvalidCollectionException`
- **Fix:** The repository URL contains invalid characters for ChromaDB. Ensure your backend is using the `_collection_name()` sanitizer helper. If the error persists, delete the local `chroma_db` directory and restart the backend.

**Error:** Extension panel doesn't appear on GitHub pages
- **Fix:** Check if you are on a valid repo page. The extension does not activate on `/issues`, `/pulls`, `/settings`, or profile pages. Refresh the page or check the browser DevTools console for `content.js` errors.

**Error:** `tree-sitter` fails to install on Windows
- **Fix:** You are missing a C compiler. Install `tree-sitter-languages` instead of individual tree-sitter packages, as it provides pre-built wheels.

**Error:** Gemini API returns empty responses
- **Fix:** You may be hitting a chunking issue where the first chunk is empty. Ensure your streaming logic checks `if chunk.text:` rather than blindly accessing `chunk.candidates[0].content.parts[0].text`.

## 9. API Limits and What to Do When You Hit Them
You may encounter a `ResourceExhausted` (429) error from the Gemini API when indexing large repositories rapidly.

**What to do:**
1. **Pacing:** The backend is configured to batch embedding calls with a 1-second sleep between batches. If you still hit limits, increase the `time.sleep()` duration in the embedder logic.
2. **Retries:** The system includes exponential backoff for rate limits. Let the backend automatically retry the failed chunks.
3. **Wait:** If you exhaust your daily free tier quota for Gemini, you will need to wait until the quota resets or upgrade to a paid tier. Check your Google AI Studio dashboard for usage metrics.
