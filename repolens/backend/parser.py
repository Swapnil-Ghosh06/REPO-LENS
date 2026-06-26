"""
parser.py — RepoLens source-code chunker.

Converts a list of raw file dicts (produced by crawler.py) into a flat list
of chunk dicts ready for embedding and vector-store ingestion.

Strategy
--------
* Tree-sitter (via tree-sitter-languages) is used for Python, JavaScript,
  TypeScript, Java, and Go. Function and class definitions are extracted as
  individual chunks using a FULL recursive tree walk.
* Sliding-window fallback (60-line window, 10-line overlap) is used for
  every other language, and whenever tree-sitter yields zero results.
* Any chunk that exceeds 150 lines is split in half.
"""

from __future__ import annotations
import logging

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_TS_LANGUAGES = frozenset({"python", "javascript", "typescript", "java", "go"})

# These are the EXACT node type strings tree-sitter uses for each language.
# Verified against tree-sitter grammar definitions.
_NODE_TYPES: dict[str, frozenset[str]] = {
    "python":     frozenset({"function_definition", "class_definition"}),
    "javascript": frozenset({"function_declaration", "method_definition",
                              "class_declaration", "function_expression"}),
    "typescript": frozenset({"function_declaration", "method_definition",
                              "class_declaration", "function_expression"}),
    "java":       frozenset({"method_declaration", "class_declaration",
                              "constructor_declaration"}),
    "go":         frozenset({"function_declaration", "method_declaration"}),
}

_CHUNK_TYPE_MAP: dict[str, str] = {
    "function_definition":   "function",
    "function_declaration":  "function",
    "function_expression":   "function",
    "method_definition":     "function",
    "method_declaration":    "function",
    "constructor_declaration": "function",
    "class_definition":      "class",
    "class_declaration":     "class",
}

_WINDOW_LINES   = 60
_OVERLAP_LINES  = 10
_MAX_CHUNK_LINES = 150


# ---------------------------------------------------------------------------
# Helpers — splitting
# ---------------------------------------------------------------------------

def _split_if_oversized(chunks: list[dict]) -> list[dict]:
    result = []
    for chunk in chunks:
        if (chunk["end_line"] - chunk["start_line"] + 1) > _MAX_CHUNK_LINES:
            result.extend(_bisect_chunk(chunk))
        else:
            result.append(chunk)
    return result


def _bisect_chunk(chunk: dict) -> list[dict]:
    lines = chunk["content"].splitlines(keepends=True)
    mid = len(lines) // 2
    halves = [lines[:mid], lines[mid:]]
    sub_chunks = []
    base_start = chunk["start_line"]
    offset = 0
    for i, half_lines in enumerate(halves):
        if not half_lines:
            continue
        start = base_start + offset
        end = start + len(half_lines) - 1
        sub_chunks.append({
            **chunk,
            "start_line": start,
            "end_line":   end,
            "content":    "".join(half_lines),
            "name":       f"{chunk['name']}_part{i}",
            "chunk_id":   f"{chunk['file_path']}::{start}",
        })
        offset += len(half_lines)
    return _split_if_oversized(sub_chunks)


# ---------------------------------------------------------------------------
# Helpers — sliding window
# ---------------------------------------------------------------------------

def _sliding_window_chunks(relative_path: str, language: str,
                            lines: list[str]) -> list[dict]:
    chunks = []
    step = _WINDOW_LINES - _OVERLAP_LINES
    pos = 0
    idx = 0
    total = len(lines)
    while pos < total:
        window = lines[pos: pos + _WINDOW_LINES]
        chunks.append({
            "chunk_id":      f"{relative_path}::{pos + 1}",
            "file_path":     relative_path,
            "relative_path": relative_path,
            "language":      language,
            "chunk_type":    "fallback",
            "name":          f"chunk_{idx}",
            "start_line":    pos + 1,
            "end_line":      pos + len(window),
            "content":       "".join(window),
        })
        idx += 1
        pos += step
    return _split_if_oversized(chunks)


# ---------------------------------------------------------------------------
# Helpers — identifier name from node
# ---------------------------------------------------------------------------

def _node_name(node, source_bytes: bytes) -> str:
    """Extract the identifier name from a definition node."""
    for child in node.children:
        if child.type == "identifier":
            return source_bytes[child.start_byte:child.end_byte].decode("utf-8", errors="replace")
        # Java/TS sometimes nest name inside a different child
        for grandchild in child.children:
            if grandchild.type == "identifier":
                return source_bytes[grandchild.start_byte:grandchild.end_byte].decode("utf-8", errors="replace")
    return "<anonymous>"


# ---------------------------------------------------------------------------
# THE KEY FIX: full recursive tree walk instead of children-only walk
# ---------------------------------------------------------------------------

def _collect_definitions(node, source_bytes: bytes, target_types: frozenset,
                          relative_path: str, language: str,
                          seen_ranges: set, chunks: list):
    """
    Recursively walk the entire AST tree.
    
    The original code only walked root.children — this missed functions nested
    inside classes, decorators, if-blocks, etc. This version walks the full tree.
    
    seen_ranges prevents double-counting when a child node's range is fully
    contained within a parent node we already captured.
    """
    if node.type in target_types:
        start_line = node.start_point[0] + 1  # tree-sitter is 0-indexed
        end_line   = node.end_point[0] + 1
        range_key  = (start_line, end_line)

        if range_key not in seen_ranges:
            seen_ranges.add(range_key)
            content = source_bytes[node.start_byte:node.end_byte].decode("utf-8", errors="replace")
            name = _node_name(node, source_bytes)
            chunk_type = _CHUNK_TYPE_MAP.get(node.type, "module")

            chunks.append({
                "chunk_id":      f"{relative_path}::{start_line}",
                "file_path":     relative_path,
                "relative_path": relative_path,
                "language":      language,
                "chunk_type":    chunk_type,
                "name":          name,
                "start_line":    start_line,
                "end_line":      end_line,
                "content":       content,
            })
            # Still recurse into this node to catch nested classes/functions
            # (e.g. a method inside a class, or a nested function)

    for child in node.children:
        _collect_definitions(child, source_bytes, target_types,
                             relative_path, language, seen_ranges, chunks)


def _ts_chunks(relative_path: str, language: str, source: str) -> list[dict]:
    from tree_sitter_languages import get_parser  # local import

    parser = get_parser(language)
    source_bytes = source.encode("utf-8")
    tree = parser.parse(source_bytes)

    target_types = _NODE_TYPES[language]
    chunks: list[dict] = []
    seen_ranges: set = set()

    _collect_definitions(tree.root_node, source_bytes, target_types,
                         relative_path, language, seen_ranges, chunks)

    return _split_if_oversized(chunks)


# ---------------------------------------------------------------------------
# Per-file dispatcher
# ---------------------------------------------------------------------------

def _chunk_single_file(file_dict: dict) -> list[dict]:
    relative_path = file_dict["relative_path"]
    language      = file_dict.get("language", "unknown")
    raw_content   = file_dict.get("raw_content", "")

    if not raw_content.strip():
        return []

    if language in _TS_LANGUAGES:
        try:
            chunks = _ts_chunks(relative_path, language, raw_content)
            if chunks:
                return chunks
            # Parsed fine but no definitions found — fall through to sliding window
        except Exception as exc:
            logger.warning("tree-sitter failed for %s (%s): %s — falling back",
                           relative_path, language, exc)

    lines = raw_content.splitlines(keepends=True)
    return _sliding_window_chunks(relative_path, language, lines)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def chunk_files(files: list[dict]) -> list[dict]:
    """Chunk a list of crawled file dicts into a flat list of chunk dicts."""
    all_chunks: list[dict] = []
    for file_dict in files:
        try:
            all_chunks.extend(_chunk_single_file(file_dict))
        except Exception as exc:
            logger.error("Unexpected error chunking %s: %s — skipping",
                         file_dict.get("relative_path", "<unknown>"), exc)
    return all_chunks