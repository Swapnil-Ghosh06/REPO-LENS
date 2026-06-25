"""
RepoLens — FastAPI Backend
Endpoints: POST /index, GET /status/{job_id}, POST /query, GET /health
"""

import threading
import uuid
import time
import json
import os

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.responses import StreamingResponse
from pydantic import BaseModel

from crawler import crawl_repo
from parser import chunk_files
from embedder import embed_chunks
from vectorstore import store_chunks, is_indexed
from rag import stream_answer

# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

load_dotenv()

app = FastAPI(title="RepoLens API", version="1.0.0")

# ---------------------------------------------------------------------------
# CORS — wildcard required: Chrome extension origin is unpredictable in dev
# ---------------------------------------------------------------------------

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# In-memory job store
# job_id → {
#   job_id, repo_url, repo_name, status, progress, files_processed,
#   total_files, current_file, elapsed_seconds, error, started_at
# }
# ---------------------------------------------------------------------------

jobs: dict[str, dict] = {}

# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------


class IndexRequest(BaseModel):
    repo_url: str


class QueryRequest(BaseModel):
    repo_url: str
    question: str


# ---------------------------------------------------------------------------
# Background indexing job
# ---------------------------------------------------------------------------


def run_index_job(job_id: str) -> None:
    job = jobs[job_id]
    try:
        # ── elapsed-seconds ticker ──────────────────────────────────────────
        start = time.time()

        def update_elapsed() -> None:
            while job["status"] not in ("done", "error"):
                job["elapsed_seconds"] = int(time.time() - start)
                time.sleep(1)

        threading.Thread(target=update_elapsed, daemon=True).start()

        # ── Phase 1: crawling (0 → 50 %) ───────────────────────────────────
        job["status"] = "cloning"

        def file_progress(done: int, total: int, current: str) -> None:
            job["files_processed"] = done
            job["total_files"] = total
            job["current_file"] = current
            job["progress"] = int((done / total) * 50) if total > 0 else 0

        files = crawl_repo(job["repo_url"], progress_callback=file_progress)

        # ── Phase 2: parsing ────────────────────────────────────────────────
        job["status"] = "parsing"
        chunks = chunk_files(files)

        # ── Phase 3: embedding + storing (50 → 100 %) ──────────────────────
        job["status"] = "indexing"

        def embed_progress(done: int, total: int) -> None:
            job["files_processed"] = done
            job["total_files"] = total
            job["progress"] = 50 + int((done / total) * 50) if total > 0 else 50

        embedded = embed_chunks(chunks, repo_name=job["repo_name"], progress_callback=embed_progress)
        store_chunks(job["repo_url"], embedded)

        job["status"] = "done"
        job["progress"] = 100

    except Exception as exc:
        job["status"] = "error"
        job["error"] = str(exc)


# ---------------------------------------------------------------------------
# ENDPOINT 1 — POST /index
# ---------------------------------------------------------------------------


@app.post("/index", status_code=202)
async def index_repo(request: IndexRequest):
    repo_url = request.repo_url.strip()

    # Validate URL
    if not repo_url.startswith("https://github.com/"):
        return JSONResponse(
            status_code=400,
            content={
                "error": "invalid_url",
                "message": "URL must start with https://github.com/",
            },
        )

    # Duplicate-in-progress guard
    active_statuses = {"cloning", "parsing", "indexing", "queued"}
    for existing_job in jobs.values():
        if (
            existing_job["repo_url"] == repo_url
            and existing_job["status"] in active_statuses
        ):
            return JSONResponse(
                status_code=409,
                content={
                    "error": "already_indexing",
                    "message": f"'{repo_url}' is already being indexed.",
                    "job_id": existing_job["job_id"],
                },
            )

    repo_name = repo_url.replace("https://github.com/", "")
    job_id = uuid.uuid4().hex[:8]

    jobs[job_id] = {
        "job_id": job_id,
        "repo_url": repo_url,
        "repo_name": repo_name,
        "status": "queued",
        "progress": 0,
        "files_processed": 0,
        "total_files": 0,
        "current_file": "",
        "elapsed_seconds": 0,
        "error": None,
        "started_at": time.time(),
    }

    threading.Thread(target=run_index_job, args=(job_id,), daemon=True).start()

    return JSONResponse(
        status_code=202,
        content={"job_id": job_id, "status": "started", "repo_name": repo_name},
    )


# ---------------------------------------------------------------------------
# ENDPOINT 2 — GET /status/{job_id}
# ---------------------------------------------------------------------------


@app.get("/status/{job_id}")
async def get_status(job_id: str):
    job = jobs.get(job_id)
    if job is None:
        return JSONResponse(
            status_code=404,
            content={"error": "not_found", "message": "Job not found"},
        )
    return JSONResponse(content=job)


# ---------------------------------------------------------------------------
# ENDPOINT 3 — POST /query
# ---------------------------------------------------------------------------


@app.post("/query")
async def query_repo(request: QueryRequest):
    repo_url = request.repo_url.strip()
    question = request.question.strip()

    if not is_indexed(repo_url):
        return JSONResponse(
            status_code=400,
            content={
                "error": "not_indexed",
                "message": f"Repository '{repo_url}' has not been indexed yet.",
            },
        )

    return StreamingResponse(
        stream_answer(repo_url, question),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------------------
# ENDPOINT 4 — GET /health
# ---------------------------------------------------------------------------


@app.get("/health")
async def health():
    return {"status": "ok", "version": "1.0.0"}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
