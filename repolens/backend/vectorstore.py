"""
vectorstore.py - RepoLens ChromaDB vector store module.

Persists embedded code chunks to a local ChromaDB collection and
provides retrieval for RAG queries.

Usage:
    from vectorstore import store_chunks, query_chunks, is_indexed
    store_chunks(repo_url, embedded_chunks)
    results = query_chunks(repo_url, query_vector, top_k=8)
"""

import os
import re

import chromadb

# Absolute path so ChromaDB works regardless of where uvicorn is launched from
_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "chroma_data")
_client = chromadb.PersistentClient(path=_DB_PATH)


def _collection_name(repo_url: str) -> str:
    """Derive a valid ChromaDB collection name from a GitHub repo URL.

    Example:
        "https://github.com/tiangolo/fastapi" -> "repolens_tiangolo__fastapi"
    """
    # Extract "owner/repo" from URL
    match = re.search(r"github\.com/([^/]+/[^/]+?)(?:\.git)?$", repo_url.rstrip("/"))
    if match:
        owner_repo = match.group(1)  # e.g. "tiangolo/fastapi"
    else:
        # Fallback: sanitize the whole URL
        owner_repo = repo_url

    # Replace "/" with "__", then strip non-alphanumeric/underscore chars
    sanitized = owner_repo.replace("/", "__")
    sanitized = re.sub(r"[^a-zA-Z0-9_]", "", sanitized)
    return f"repolens_{sanitized}"


def _extract_repo_name(repo_url: str) -> str:
    """Extract "owner/repo" string from a GitHub URL."""
    match = re.search(r"github\.com/([^/]+/[^/]+?)(?:\.git)?$", repo_url.rstrip("/"))
    return match.group(1) if match else repo_url


def store_chunks(repo_url: str, chunks: list[dict]) -> None:
    """Store embedded chunks into a ChromaDB collection.

    If a collection for this repo already exists it is deleted first
    to ensure a clean re-index. Chunks are written in batches of 100.

    Args:
        repo_url: Full GitHub URL, e.g. "https://github.com/owner/repo".
        chunks:   List of embedded chunk dicts (output of embedder.embed_chunks).
                  Each dict must contain: chunk_id, embedding, context_string,
                  file_path, language, chunk_type, name, start_line, end_line.
    """
    col_name = _collection_name(repo_url)
    repo_name = _extract_repo_name(repo_url)

    # Delete existing collection if present for a clean re-index
    try:
        _client.delete_collection(col_name)
        print(f"[vectorstore] Deleted existing collection: {col_name}")
    except Exception:
        pass  # Collection did not exist - that is fine

    # Determine provider from chunks
    provider = chunks[0].get("provider", "gemini") if chunks else "gemini"

    collection = _client.create_collection(
        name=col_name,
        metadata={
            "hnsw:space": "cosine",
            "provider": provider
        },
    )

    batch_size = 100
    total = len(chunks)

    for i in range(0, total, batch_size):
        batch = chunks[i : i + batch_size]

        ids = [c["chunk_id"] for c in batch]
        embeddings = [c["embedding"] for c in batch]
        documents = [c["context_string"] for c in batch]
        metadatas = [
            {
                "chunk_id":  str(c["chunk_id"]),
                "repo_url":  str(repo_url),
                "repo_name": str(repo_name),
                "relative_path": str(c["relative_path"]),
                "language":  str(c["language"]),
                "chunk_type": str(c["chunk_type"]),
                "name":      str(c["name"]),
                "start_line": int(c["start_line"]),
                "end_line":   int(c["end_line"]),
            }
            for c in batch
        ]

        collection.add(
            ids=ids,
            embeddings=embeddings,
            documents=documents,
            metadatas=metadatas,
        )

        stored = min(i + batch_size, total)
        print(f"[vectorstore] Stored {stored}/{total} chunks...")

    print(f"[vectorstore] Done. {total} chunks stored in '{col_name}'.")


def query_chunks(
    repo_url: str,
    query_embedding: list[float],
    top_k: int = 8,
) -> list[dict]:
    """Retrieve the top-k most similar chunks for a query embedding.

    Args:
        repo_url:        Full GitHub URL of the indexed repository.
        query_embedding: The query vector from embedder.embed_query().
        top_k:           Number of results to return (default 8).

    Returns:
        List of dicts: [{"document": str, "metadata": dict, "distance": float}].
        Returns an empty list if the collection does not exist.
    """
    col_name = _collection_name(repo_url)

    try:
        collection = _client.get_collection(col_name)
    except Exception:
        return []

    results = collection.query(
        query_embeddings=[query_embedding],
        n_results=min(top_k, collection.count()),
    )

    docs = results["documents"][0]
    metas = results["metadatas"][0]
    distances = results["distances"][0]

    return [
        {"document": doc, "metadata": meta, "distance": dist}
        for doc, meta, dist in zip(docs, metas, distances)
    ]


def is_indexed(repo_url: str) -> bool:
    """Check whether a repository has been indexed and has stored chunks.

    Args:
        repo_url: Full GitHub URL of the repository.

    Returns:
        True if the collection exists and contains at least one chunk.
    """
    col_name = _collection_name(repo_url)
    try:
        collection = _client.get_collection(col_name)
        return collection.count() > 0
    except Exception:
        return False

def get_provider(repo_url: str) -> str:
    """Retrieve the embedding provider used for a repository's collection."""
    col_name = _collection_name(repo_url)
    try:
        collection = _client.get_collection(col_name)
        return collection.metadata.get("provider", "gemini") if collection.metadata else "gemini"
    except Exception:
        return "gemini"
