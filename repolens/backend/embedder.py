"""
embedder.py - RepoLens embedding module with Dynamic Batching & Fallbacks.

Features:
- Dynamic Size Limits (prevents Payload Too Large)
- Token Tracker (prevents 1M TPM limits)
- Divide and Conquer (isolates bad files instead of failing batches)
- Cohere Plan B (falls back to Cohere if Gemini is exhausted)
"""

import os
import time
import json
from google import genai
from google.genai import types

# Global circuit breaker for Gemini limits (1 hour)
_GEMINI_DEAD_UNTIL = 0

def build_context_string(chunk: dict, repo_name: str) -> str:
    """Build the context string prefixed to the code chunk before embedding."""
    header = (
        f"File: {chunk['relative_path']}\n"
        f"Language: {chunk['language']}\n"
        f"Type: {chunk['chunk_type']}\n"
        f"Name: {chunk['name']}\n"
        f"Lines: {chunk['start_line']}-{chunk['end_line']}\n"
        f"Repo: {repo_name}\n\n"
    )
    max_content_len = max(0, 8000 - len(header))
    content = chunk['content'][:max_content_len]
    return header + content

def _execute_gemini_batch_with_divide_and_conquer(client, batch: list) -> list:
    """Recursively processes a batch. If it fails, slices it in half to isolate bad chunks."""
    if not batch:
        return []
        
    contexts = [ctx for _, ctx in batch]
    
    try:
        result = client.models.embed_content(
            model="models/gemini-embedding-001",
            contents=contexts,
            config=types.EmbedContentConfig(task_type="RETRIEVAL_DOCUMENT"),
        )
        # Success! Map embeddings back to chunks
        embedded = []
        for i, (chunk, ctx) in enumerate(batch):
            vector = result.embeddings[i].values
            embedded.append({
                **chunk,
                "context_string": ctx,
                "embedding": list(vector)
            })
        return embedded
    except Exception as exc:
        err_str = str(exc).upper()
        # If it's a hard rate limit, we should raise it to trigger the Plan B or sleep.
        if "429" in err_str or "RESOURCE_EXHAUSTED" in err_str or "QUOTA" in err_str:
            raise RuntimeError("GEMINI_RATE_LIMIT")
            
        # If it's a generic payload/validation error, divide and conquer!
        if len(batch) == 1:
            chunk = batch[0][0]
            print(f"[WARNING] Skipping bad chunk '{chunk.get('name')}' after isolating it: {exc}")
            return []
            
        print(f"[DIVIDE & CONQUER] Batch of {len(batch)} failed. Slicing in half to isolate bad file...")
        mid = len(batch) // 2
        left_batch = batch[:mid]
        right_batch = batch[mid:]
        
        # Add slight delay to prevent hammering during recursion
        time.sleep(1)
        left_embedded = _execute_gemini_batch_with_divide_and_conquer(client, left_batch)
        time.sleep(1)
        right_embedded = _execute_gemini_batch_with_divide_and_conquer(client, right_batch)
        
        return left_embedded + right_embedded

def _embed_chunks_gemini(chunks: list[dict], repo_name: str, progress_callback) -> list[dict]:
    """Embed chunks using Gemini with Token Tracking and Dynamic Batching."""
    client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
    embedded_chunks = []
    
    MAX_PAYLOAD_CHARS = 40000
    MAX_TOKENS_PER_MIN = 800000
    TOKENS_PER_CHAR = 0.25 # Approx 4 chars per token
    
    # 1. Dynamic Batching
    batches = []
    current_batch = []
    current_chars = 0
    for chunk in chunks:
        ctx = build_context_string(chunk, repo_name)
        char_len = len(ctx)
        
        if char_len > MAX_PAYLOAD_CHARS:
            print(f"[WARNING] Chunk '{chunk.get('name')}' is too large ({char_len} chars). Skipping.")
            continue
            
        if current_chars + char_len > MAX_PAYLOAD_CHARS or len(current_batch) >= 100:
            batches.append(current_batch)
            current_batch = []
            current_chars = 0
            
        current_batch.append((chunk, ctx))
        current_chars += char_len
        
    if current_batch:
        batches.append(current_batch)
        
    # 2. Token Tracker & Execution
    tokens_this_minute = 0
    minute_start_time = time.time()
    chunks_processed = 0
    total_chunks = len(chunks)
    
    for batch_index, batch in enumerate(batches):
        batch_tokens = sum(len(ctx) * TOKENS_PER_CHAR for _, ctx in batch)
        
        now = time.time()
        if now - minute_start_time > 60:
            tokens_this_minute = 0
            minute_start_time = now
            
        if tokens_this_minute + batch_tokens > MAX_TOKENS_PER_MIN:
            sleep_time = max(0.0, 60.0 - (now - minute_start_time))
            print(f"[TOKEN TRACKER] Nearing 1M TPM. Pausing for {sleep_time:.1f}s...")
            time.sleep(sleep_time)
            tokens_this_minute = 0
            minute_start_time = time.time()
            
        print(f"Embedding batch {batch_index + 1}/{len(batches)} (Gemini)...")
        
        # Retry loop for Rate Limits specifically
        retry_count = 0
        while retry_count < 2:
            try:
                embedded_batch = _execute_gemini_batch_with_divide_and_conquer(client, batch)
                embedded_chunks.extend(embedded_batch)
                break
            except RuntimeError as e:
                if "GEMINI_RATE_LIMIT" in str(e):
                    retry_count += 1
                    if retry_count < 2:
                        backoff = 15 * retry_count
                        print(f"[RATE LIMIT] Gemini exhausted. Backing off for {backoff}s (Retry {retry_count}/2)...")
                        time.sleep(backoff)
                    else:
                        raise RuntimeError("GEMINI_EXHAUSTED_FATAL")
                else:
                    raise e
        
        tokens_this_minute += batch_tokens
        chunks_processed += len(batch)
        
        if progress_callback:
            progress_callback(min(chunks_processed, total_chunks), total_chunks)
            
        time.sleep(1.0) # Base tiny delay to smooth RPM
        
    return embedded_chunks

def _embed_chunks_cohere(chunks: list[dict], repo_name: str, progress_callback) -> list[dict]:
    """Fallback Plan B engine using Cohere Embed v3."""
    # pyrefly: ignore [missing-import]
    import cohere
    api_key = os.getenv("COHERE_API_KEY")
    if not api_key:
        raise ValueError("COHERE_API_KEY is not set. Cannot use Plan B fallback.")
        
    co = cohere.Client(api_key=api_key)
    embedded_chunks = []
    
    # Cohere batch max is usually 96
    batches = []
    current_batch = []
    for chunk in chunks:
        ctx = build_context_string(chunk, repo_name)
        if len(current_batch) >= 90:
            batches.append(current_batch)
            current_batch = []
        current_batch.append((chunk, ctx))
    if current_batch:
        batches.append(current_batch)
        
    chunks_processed = 0
    total_chunks = len(chunks)
    
    for batch_index, batch in enumerate(batches):
        print(f"Embedding batch {batch_index + 1}/{len(batches)} (Cohere Plan B)...")
        texts = [ctx for _, ctx in batch]
        
        try:
            response = co.embed(texts=texts, model="embed-english-v3.0", input_type="search_document")
            for i, (chunk, ctx) in enumerate(batch):
                embedded_chunks.append({
                    **chunk,
                    "context_string": ctx,
                    "embedding": response.embeddings[i],
                    "provider": "cohere"
                })
        except Exception as e:
            print(f"[WARNING] Cohere batch failed: {e}")
            
        chunks_processed += len(batch)
        if progress_callback:
            progress_callback(min(chunks_processed, total_chunks), total_chunks)
            
        time.sleep(0.5)
        
    return embedded_chunks

def embed_chunks(chunks: list[dict], repo_name: str, progress_callback=None, job_id: str = None) -> list[dict]:
    """Main entrypoint. Tries Gemini, falls back to Cohere if completely exhausted."""
    global _GEMINI_DEAD_UNTIL
    
    if time.time() < _GEMINI_DEAD_UNTIL:
        print("[CIRCUIT BREAKER] Gemini is in cool-down. Going straight to Cohere Plan B...")
        return _embed_chunks_cohere(chunks, repo_name, progress_callback)
    
    try:
        embedded = _embed_chunks_gemini(chunks, repo_name, progress_callback)
        # Tag provider so vectorstore knows
        for c in embedded:
            c["provider"] = "gemini"
    except Exception as e:
        err_str = str(e).upper()
        if "GEMINI_EXHAUSTED_FATAL" in err_str:
            print("[PLAN B] Gemini is completely exhausted. Switching to Cohere Plan B Engine...")
            _GEMINI_DEAD_UNTIL = time.time() + 3600  # Kill Gemini for 1 hour
            embedded = _embed_chunks_cohere(chunks, repo_name, progress_callback)
        else:
            raise e
            
    return embedded

def embed_query(question: str, provider: str = "gemini") -> list[float]:
    """Embed a query, using the matching provider that indexed the repo."""
    if provider == "cohere":
        # pyrefly: ignore [missing-import]
        import cohere
        co = cohere.Client(api_key=os.getenv("COHERE_API_KEY"))
        res = co.embed(texts=[question], model="embed-english-v3.0", input_type="search_query")
        return res.embeddings[0]
        
    # Default to Gemini
    client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
    result = client.models.embed_content(
        model="models/gemini-embedding-001",
        contents=question,
        config=types.EmbedContentConfig(task_type="RETRIEVAL_QUERY"),
    )
    return list(result.embeddings[0].values)
