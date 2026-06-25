"""
crawler.py — RepoLens repository crawler.

Clones a GitHub repository (or reuses an existing local clone) and walks all
source-code / documentation files, returning a list of structured dicts ready
for chunking and RAG ingestion.

Public API
----------
    crawl_repo(repo_url, progress_callback=None) -> list[dict]

Each returned dict has the shape::

    {
        "file_path":     str,   # absolute path on disk
        "relative_path": str,   # path relative to repo root (POSIX separators)
        "language":      str,   # e.g. "python", "typescript"
        "raw_content":   str,   # decoded file text
    }
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Callable, Optional

import git  # GitPython

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: Root directory where all repos are cloned.
CLONE_BASE_DIR = Path(tempfile.gettempdir()) / "repolens"

#: Maximum file size (bytes) to include. Files larger than this are skipped.
MAX_FILE_BYTES = 100 * 1024  # 100 KB

#: File extensions that are eligible for indexing.
SUPPORTED_EXTENSIONS: frozenset[str] = frozenset(
    {
        ".py",
        ".js",
        ".ts",
        ".jsx",
        ".tsx",
        ".java",
        ".go",
        ".rs",
        ".cpp",
        ".c",
        ".cs",
        ".rb",
        ".php",
        ".swift",
        ".kt",
        ".md",
    }
)

#: Directory names that should be skipped entirely during the walk.
SKIP_DIRS: frozenset[str] = frozenset(
    {
        "node_modules",
        ".git",
        "dist",
        "build",
        "__pycache__",
        ".venv",
        "venv",
        ".next",
        "out",
        "vendor",
        ".idea",
        ".vscode",
        "coverage",
        "target",
    }
)

#: Maps a file extension to a canonical language label.
LANGUAGE_MAP: dict[str, str] = {
    ".py": "python",
    ".js": "javascript",
    ".ts": "typescript",
    ".jsx": "javascript",
    ".tsx": "typescript",
    ".java": "java",
    ".go": "go",
    ".rs": "rust",
    ".cpp": "cpp",
    ".c": "c",
    ".cs": "csharp",
    ".rb": "ruby",
    ".php": "php",
    ".swift": "swift",
    ".kt": "kotlin",
    ".md": "markdown",
}


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _repo_name_from_url(repo_url: str) -> str:
    """Derive a filesystem-safe directory name from a GitHub URL.

    Converts the ``owner/repo`` path segment to ``owner__repo``.

    Examples
    --------
    >>> _repo_name_from_url("https://github.com/torvalds/linux")
    'torvalds__linux'
    >>> _repo_name_from_url("https://github.com/torvalds/linux.git")
    'torvalds__linux'
    """
    # Strip trailing slash and optional ".git" suffix
    clean = repo_url.rstrip("/")
    if clean.endswith(".git"):
        clean = clean[:-4]

    # Take the last two path segments: owner and repo
    parts = clean.rstrip("/").split("/")
    owner, repo = parts[-2], parts[-1]
    return f"{owner}__{repo}"


def _clone_or_reuse(repo_url: str, local_dir: Path) -> None:
    """Clone *repo_url* into *local_dir*, or skip if it already exists."""
    if local_dir.exists():
        return

    CLONE_BASE_DIR.mkdir(parents=True, exist_ok=True)
    git.Repo.clone_from(repo_url, str(local_dir))


def _read_file(path: Path) -> Optional[str]:
    """Return the text content of *path*, trying UTF-8 then latin-1.

    Returns ``None`` if both encodings fail.
    """
    for encoding in ("utf-8", "latin-1"):
        try:
            return path.read_text(encoding=encoding)
        except (UnicodeDecodeError, ValueError):
            continue
    return None


def _collect_candidate_files(repo_root: Path) -> list[Path]:
    """Walk *repo_root* and return paths that pass extension / directory / size filters."""
    candidates: list[Path] = []

    for dirpath, dirnames, filenames in os.walk(repo_root):
        # Prune unwanted directories in-place so os.walk doesn't descend into them.
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]

        for filename in filenames:
            file_path = Path(dirpath) / filename
            suffix = file_path.suffix.lower()

            if suffix not in SUPPORTED_EXTENSIONS:
                continue

            try:
                if file_path.stat().st_size > MAX_FILE_BYTES:
                    continue
            except OSError:
                # Broken symlink or permission error — skip silently.
                continue

            candidates.append(file_path)

    return candidates


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def crawl_repo(
    repo_url: str,
    progress_callback: Optional[Callable[[int, int, str], None]] = None,
) -> list[dict]:
    """Clone (or reuse) a GitHub repository and crawl its source files.

    Parameters
    ----------
    repo_url:
        Full URL of the GitHub repository, e.g.
        ``"https://github.com/owner/repo"`` or
        ``"https://github.com/owner/repo.git"``.
    progress_callback:
        Optional callable invoked after each file is processed.
        Signature: ``progress_callback(files_done: int, total_files: int, current_file: str)``.

    Returns
    -------
    list[dict]
        One dict per successfully read file with keys:
        ``file_path``, ``relative_path``, ``language``, ``raw_content``.
    """
    repo_name = _repo_name_from_url(repo_url)
    local_dir = CLONE_BASE_DIR / repo_name

    # Step 1 — ensure the repo is available locally.
    _clone_or_reuse(repo_url, local_dir)

    # Step 2 — collect all candidate files (filtered by extension / dir / size).
    candidates = _collect_candidate_files(local_dir)
    total_files = len(candidates)

    # Step 3 — read each file and build result dicts.
    results: list[dict] = []

    for idx, file_path in enumerate(candidates, start=1):
        raw_content = _read_file(file_path)

        if raw_content is None:
            # Both encodings failed — skip silently.
            if progress_callback is not None:
                progress_callback(idx, total_files, str(file_path))
            continue

        suffix = file_path.suffix.lower()
        language = LANGUAGE_MAP.get(suffix, "unknown")

        # Compute a POSIX-style relative path from the repo root.
        try:
            relative_path = file_path.relative_to(local_dir).as_posix()
        except ValueError:
            relative_path = str(file_path)

        results.append(
            {
                "file_path": str(file_path),
                "relative_path": relative_path,
                "language": language,
                "raw_content": raw_content,
            }
        )

        if progress_callback is not None:
            progress_callback(idx, total_files, str(file_path))

    return results
