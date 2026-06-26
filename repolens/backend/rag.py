"""
rag.py - RepoLens RAG (Retrieval-Augmented Generation) module.

Provides stream_answer(), a generator that:
  1. Embeds the user question (always via Gemini text-embedding-004)
  2. Retrieves top-k relevant code chunks from ChromaDB
  3. Builds a grounded prompt
  4. Streams the LLM response as Server-Sent Events (SSE)
     - Primary LLM:  Google Gemini 2.5 Flash
     - Fallback LLM: Groq Llama-3.3-70B (triggered on 429 / RESOURCE_EXHAUSTED)

SSE event sequence:
  event: token   -> {"text": "..."}
  event: sources -> {"sources": [...]}
  event: done    -> {}
  event: error   -> {"message": "..."}
"""

import json
import os
from typing import Generator

from dotenv import load_dotenv
from google import genai
# pyrefly: ignore [missing-import]
from groq import Groq

from embedder import embed_query
from vectorstore import query_chunks, get_provider

load_dotenv()

# ── Groq clients (initialised once at import time) ────────────────────────────
_groq_clients = []
for k, v in os.environ.items():
    if k.startswith("GROQ_API_KEY") and v.strip():
        _groq_clients.append(Groq(api_key=v.strip()))

# ── Shared system prompt builder ──────────────────────────────────────────────

def _build_system_prompt(repo_name: str, num_chunks: int) -> str:
    return (
        f"You are RepoLens, a code assistant for the repository: {repo_name}.\n"
        f"You have been given {num_chunks} relevant code chunks retrieved from this codebase.\n"
        "Rules:\n"
        "- Base your answer primarily on the provided chunks.\n"
        "- If the provided chunks do NOT contain enough information to answer the question, you may use your general programming knowledge to answer, but you MUST clearly state that your answer is based on general knowledge and not the specific codebase.\n"
        "- Do NOT cite sources (e.g. no [filename:line_number]) in your text. Provide a clear, plain-English explanation.\n"
        "- Use markdown formatting. Use fenced code blocks for code.\n"
        "- Be technically precise. Your audience is experienced developers."
    )

def _build_user_message(question: str, results: list) -> str:
    user_message = f"Question: {question}\n\nCode chunks:\n"
    for i, r in enumerate(results, start=1):
        meta = r["metadata"]
        user_message += (
            f"--- CHUNK {i} ---\n"
            f"File: {meta['relative_path']} "
            f"(lines {meta['start_line']}-{meta['end_line']})\n"
            f"Type: {meta['chunk_type']} | Name: {meta['name']}\n\n"
            f"{r['document']}\n\n"
        )
    return user_message

def _build_sources(results: list) -> list:
    return [
        {
            "github_url": f"https://github.com/{r['metadata']['repo_name']}/blob/main/{r['metadata']['relative_path']}#L{r['metadata']['start_line']}",
            "relative_path": r["metadata"]["relative_path"],
            "line": r["metadata"]["start_line"],
            "chunk_type": r["metadata"]["chunk_type"],
            "name": r["metadata"]["name"],
        }
        for r in results
    ]


# ── Provider: Gemini ──────────────────────────────────────────────────────────

def _stream_gemini(system_prompt: str, user_message: str) -> Generator[str, None, None]:
    """Yields SSE token events using Gemini 2.5 Flash. Raises on 429."""
    client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
    full_prompt = system_prompt + "\n\n" + user_message
    response = client.models.generate_content_stream(
        model="gemini-2.5-flash",
        contents=full_prompt,
    )
    for chunk in response:
        if chunk.text:
            yield f"event: token\ndata: {json.dumps({'text': chunk.text})}\n\n"


# ── Provider: Groq ────────────────────────────────────────────────────────────

def _stream_groq(system_prompt: str, user_message: str) -> Generator[str, None, None]:
    """Yields SSE token events using Groq. Falls back across multiple keys if rate limited."""
    if not _groq_clients:
        raise RuntimeError("Groq API key not configured.")

    for i, client in enumerate(_groq_clients):
        try:
            stream = client.chat.completions.create(
                model="llama-3.3-70b-versatile",
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user",   "content": user_message},
                ],
                stream=True,
                temperature=0.2,
                max_tokens=4096,
            )
            
            chunk_iterator = iter(stream)
            try:
                first_chunk = next(chunk_iterator)
            except StopIteration:
                return # Empty response
                
            # If we successfully get the first chunk, this key works!
            text = first_chunk.choices[0].delta.content or ""
            if text:
                yield f"event: token\ndata: {json.dumps({'text': text})}\n\n"
                
            for chunk in chunk_iterator:
                text = chunk.choices[0].delta.content or ""
                if text:
                    yield f"event: token\ndata: {json.dumps({'text': text})}\n\n"
                    
            # Successfully finished stream, exit so we don't use the next key
            return
            
        except Exception as e:
            err_str = str(e).upper()
            if "429" in err_str or "RATE_LIMIT" in err_str:
                print(f"[Fallback] Groq key {i+1} rate limited. Trying next key...")
                continue
            raise # Re-raise non-rate-limit errors
            
    # If we exhausted the loop, all keys failed
    raise RuntimeError("429: All Groq API keys are currently rate limited.")


# ── Public API ────────────────────────────────────────────────────────────────

def stream_answer(
    repo_url: str,
    question: str,
) -> Generator[str, None, None]:
    """Stream a RAG answer for a question about the given repository.

    Args:
        repo_url: Full GitHub URL of the indexed repository.
        question: Natural-language question from the user.

    Yields:
        SSE-formatted strings. Sequence: token* -> sources -> done.
        Yields a single error event if anything fails.

    Provider waterfall:
        Gemini 2.5 Flash  (primary)
        └─ on 429 / RESOURCE_EXHAUSTED → Groq Llama-3.3-70B (fallback)
           └─ on failure → SSE error event
    """
    try:
        # Step 1: derive repo name
        repo_name = repo_url.replace("https://github.com/", "")

        # Step 2: get the provider from the indexed collection and embed the query
        try:
            provider = get_provider(repo_url)
            query_vec = embed_query(question, provider=provider)
        except Exception as e:
            err_str = str(e).upper()
            if "GEMINI_RATE_LIMIT" in err_str or "429" in err_str or "RESOURCE_EXHAUSTED" in err_str:
                msg = json.dumps({
                    "message": "rate_limit",
                    "user_message": "Embedding rate limit reached. Please wait a minute and try again."
                })
                yield f"event: error\ndata: {msg}\n\n"
                return
            raise

        # Step 3: retrieve top-5 chunks
        results = query_chunks(repo_url, query_vec, top_k=5)

        # Step 4: build shared prompt pieces
        system_prompt = _build_system_prompt(repo_name, len(results))
        user_message  = _build_user_message(question, results)
        sources        = _build_sources(results)

        # Step 5: attempt Gemini, fall back to Groq on rate-limit errors
        used_fallback = False
        gemini_rate_limited = False

        try:
            gemini_gen = _stream_gemini(system_prompt, user_message)
            # Pre-fetch the first token to eagerly catch rate limits before yielding
            first_token = next(gemini_gen)
            yield first_token
            yield from gemini_gen
        except StopIteration:
            pass # No content generated
        except Exception as gemini_exc:
            err_str = str(gemini_exc).upper()
            if "429" in err_str or "RESOURCE_EXHAUSTED" in err_str:
                gemini_rate_limited = True
                if _groq_clients:
                    # Silently switch to Groq — user sees no interruption
                    used_fallback = True
                    yield from _stream_groq(system_prompt, user_message)
                else:
                    # No Groq key configured — surface rate-limit message
                    msg = json.dumps({
                        "message": "rate_limit",
                        "user_message": "Gemini daily limit reached. Add a GROQ_API_KEY to .env for automatic fallback."
                    })
                    yield f"event: error\ndata: {msg}\n\n"
                    return
            else:
                # Non-rate-limit Gemini error — re-raise so outer handler catches it
                raise

        # Step 6: emit sources then done
        yield f"event: sources\ndata: {json.dumps({'sources': sources})}\n\n"
        yield "event: done\ndata: {}\n\n"

    except Exception as exc:
        err_str = str(exc).upper()
        if "429" in err_str or "RESOURCE_EXHAUSTED" in err_str:
            msg = json.dumps({
                "message": "rate_limit",
                "user_message": "Both Gemini and Groq are rate limited. Please wait a minute and try again."
            })
            yield f"event: error\ndata: {msg}\n\n"
        else:
            yield f"event: error\ndata: {json.dumps({'message': str(exc)})}\n\n"
