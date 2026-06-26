"""
embedder.py - RepoLens embedding module.

Takes a list of parsed code chunks and produces dense vector embeddings
using the Gemini gemini-embedding-001 model (3072 dimensions) via google-genai.

Chunks are processed in batches of 20 with a configurable sleep between batches
to respect Gemini API rate limits. Each input chunk dict is returned with an
additional "embedding" key holding a list[float] and "context_string" holding the
formatted string sent to the embedding model.

Usage:
    from embedder import embed_chunks, embed_query
    embedded = embed_chunks(chunks, repo_name="my-repo")
    query_vec = embed_query("how does authentication work")
"""

import os
import time

from google import genai
from google.genai import types


def build_context_string(chunk: dict, repo_name: str) -> str:
    """Build the context string prefixed to the code chunk before embedding.

    Provides location and purpose metadata in a structured header.
    Truncates content to 8000 characters max as per the spec.
    """
    header = (
        f"File: {chunk['relative_path']}\n"
        f"Language: {chunk['language']}\n"
        f"Type: {chunk['chunk_type']}\n"
        f"Name: {chunk['name']}\n"
        f"Lines: {chunk['start_line']}-{chunk['end_line']}\n"
        f"Repo: {repo_name}\n\n"
    )
    # Truncate content so header + content doesn't exceed 8000 limit
    max_content_len = max(0, 8000 - len(header))
    content = chunk['content'][:max_content_len]
    return header + content


def embed_chunks(chunks: list[dict], repo_name: str, progress_callback=None, job_id: str = None) -> list[dict]:
    """Embed a list of parsed code chunks using Gemini gemini-embedding-001.

    Args:
        chunks:            List of chunk dicts produced by parser.chunk_files().
        repo_name:         Human-readable repository name (e.g. "owner/repo").
        progress_callback: Optional callable(done, total) to report batch progress.

    Returns:
        A list of dicts. Every successfully embedded chunk contains all
        original fields plus "embedding" (list[float], 3072 dims) and
        "context_string" (str). Failed chunks are skipped with a warning.
    """
    client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

    batch_size = 20
    total_batches = (len(chunks) + batch_size - 1) // batch_size
    embedded_chunks: list[dict] = []
    
    rate_limit_delay = float(os.getenv("RATE_LIMIT_DELAY", "1.0"))

    for batch_index in range(total_batches):
        start = batch_index * batch_size
        end = start + batch_size
        batch = chunks[start:end]

        # Prepare context strings
        batch_contexts = [build_context_string(c, repo_name) for c in batch]
        
        retry_count = 0
        batch_success = False

        while retry_count <= 3:
            if retry_count > 0:
                print(f"Embedding batch {batch_index + 1}/{total_batches} (Retry {retry_count}/3)...")
            else:
                print(f"Embedding batch {batch_index + 1}/{total_batches}...")

            try:
                # Batch embedding API call
                result = client.models.embed_content(
                    model="models/gemini-embedding-001",
                    contents=batch_contexts,
                    config=types.EmbedContentConfig(task_type="RETRIEVAL_DOCUMENT"),
                )
                
                # Map results back to chunks
                for i, chunk in enumerate(batch):
                    vector = result.embeddings[i].values
                    embedded_chunks.append({
                        **chunk,
                        "context_string": batch_contexts[i],
                        "embedding": list(vector)
                    })
                batch_success = True
                break
            except Exception as exc:
                err_str = str(exc).upper()
                if "429" in err_str or "RESOURCE_EXHAUSTED" in err_str or "QUOTA" in err_str:
                    if retry_count < 3:
                        retry_count += 1
                        print(f"[RATE LIMIT] Waiting 60s before retry {retry_count}/3...")
                        time.sleep(60)
                    else:
                        print(f"[WARNING] Batch {batch_index + 1} failed after 3 retries due to rate limits. Skipping.")
                        retry_count = 4
                        break
                else:
                    # Fall back to single embedding calls if the batch fails with non-429
                    print(f"[WARNING] Batch {batch_index + 1} embedding failed: {exc}. Retrying items individually...")
                    break
        
        # If batch failed with non-429, try individually
        if not batch_success and retry_count < 3:
            for i, chunk in enumerate(batch):
                ctx_str = batch_contexts[i]
                item_retry = 0
                
                while item_retry < 5:
                    try:
                        result = client.models.embed_content(
                            model="models/gemini-embedding-001",
                            contents=ctx_str,
                            config=types.EmbedContentConfig(task_type="RETRIEVAL_DOCUMENT"),
                        )
                        vector = result.embeddings[0].values
                        embedded_chunks.append({
                            **chunk,
                            "context_string": ctx_str,
                            "embedding": list(vector)
                        })
                        break
                    except Exception as item_exc:
                        item_err = str(item_exc).upper()
                        if "429" in item_err or "RESOURCE_EXHAUSTED" in item_err or "QUOTA" in item_err:
                            item_retry += 1
                            if item_retry < 5:
                                delay = min(2 ** item_retry, 60)
                                print(f"[WARNING] Rate limit hit on chunk '{chunk.get('name', '?')}'. Backing off for {delay} seconds...")
                                time.sleep(delay)
                            else:
                                print(f"[WARNING] Chunk '{chunk.get('name', '?')}' failed after 5 rate-limit retries: {item_exc}")
                        else:
                            print(
                                f"[WARNING] Failed to embed chunk '{chunk.get('name', '?')}'"
                                f" in {chunk.get('relative_path', '?')}: {item_exc}"
                            )
                            break

        if progress_callback:
            try:
                if progress_callback(min(end, len(chunks)), len(chunks)) is False:
                    break
            except Exception as cb_exc:
                print(f"[WARNING] Progress callback failed: {cb_exc}")

        # Sleep between batches to respect rate limits; skip after the last batch
        if batch_index < total_batches - 1:
            time.sleep(rate_limit_delay)

    # Identify un-embedded chunks (e.g. due to 429 rate limits or other failures)
    embedded_ids = {c["chunk_id"] for c in embedded_chunks if "chunk_id" in c}
    failed_chunk_ids = [c["chunk_id"] for c in chunks if "chunk_id" in c and c["chunk_id"] not in embedded_ids]

    if failed_chunk_ids and job_id:
        import json
        failed_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), f"failed_chunks_{job_id}.json")
        try:
            with open(failed_file, "w") as f:
                json.dump(failed_chunk_ids, f)
            print(f"[INFO] Saved {len(failed_chunk_ids)} failed chunk IDs to {failed_file}")
        except Exception as e:
            print(f"[WARNING] Failed to write failed chunks file: {e}")

    return embedded_chunks


def embed_query(question: str) -> list[float]:
    """Embed a single query string for vector search using RETRIEVAL_QUERY.

    Args:
        question: The user query string.

    Returns:
        A list of floats representing the query embedding vector (3072 dims).
    """
    client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
    result = client.models.embed_content(
        model="models/gemini-embedding-001",
        contents=question,
        config=types.EmbedContentConfig(task_type="RETRIEVAL_QUERY"),
    )
    return list(result.embeddings[0].values)
