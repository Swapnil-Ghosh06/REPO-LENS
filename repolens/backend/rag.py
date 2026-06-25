"""
rag.py - RepoLens RAG (Retrieval-Augmented Generation) module.

Provides stream_answer(), a generator that:
  1. Embeds the user question
  2. Retrieves top-k relevant code chunks from ChromaDB
  3. Builds a grounded prompt
  4. Streams the Gemini response as Server-Sent Events (SSE)

SSE event sequence:
  event: token   -> {"text": "..."}
  event: sources -> {"sources": [...]}
  event: done    -> {}
  event: error   -> {"message": "..."}

Usage:
    from rag import stream_answer
    for event in stream_answer(repo_url, question):
        print(event, end="", flush=True)
"""

import json
import os
from typing import Generator

from dotenv import load_dotenv
from google import genai
from google.genai import types

from embedder import embed_query
from vectorstore import query_chunks

load_dotenv()


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
    """
    try:
        # Step 1: derive repo name
        repo_name = repo_url.replace("https://github.com/", "")

        # Step 2: embed the question
        query_vec = embed_query(question)

        # Step 3: retrieve top-8 chunks
        results = query_chunks(repo_url, query_vec, top_k=8)

        # Step 4: build system prompt
        system_prompt = (
            f"You are RepoLens, a code assistant for the repository: {repo_name}.\n"
            f"You have been given {len(results)} relevant code chunks retrieved from this codebase.\n"
            "Rules:\n"
            "- Answer using ONLY the provided chunks. Never invent code.\n"
            "- Always cite sources as [filename:line_number] inline in your answer.\n"
            "- If the answer spans multiple files, cite each relevant file.\n"
            "- Use markdown formatting. Use fenced code blocks for code.\n"
            "- Be technically precise. Your audience is experienced developers.\n"
            "- If the chunks don't contain enough to answer, say so clearly. Do not guess."
        )

        # Step 5: build user message with all retrieved chunks
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

        # Step 6: call Gemini Flash with streaming
        client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
        full_prompt = system_prompt + "\n\n" + user_message

        response = client.models.generate_content_stream(
            model="gemini-2.5-flash",
            contents=full_prompt,
        )

        for chunk in response:
            if chunk.text:
                yield f"event: token\ndata: {json.dumps({'text': chunk.text})}\n\n"

        # Step 7: emit sources then done
        sources = [
            {
                "file": f"https://github.com/{r['metadata']['repo_name']}/blob/main/{r['metadata']['relative_path']}#L{r['metadata']['start_line']}",
                "line": r["metadata"]["start_line"],
                "chunk_type": r["metadata"]["chunk_type"],
                "name": r["metadata"]["name"],
            }
            for r in results
        ]
        yield f"event: sources\ndata: {json.dumps({'sources': sources})}\n\n"
        yield "event: done\ndata: {}\n\n"

    except Exception as exc:
        # Step 8: surface any error as an SSE error event
        yield f"event: error\ndata: {json.dumps({'message': str(exc)})}\n\n"
