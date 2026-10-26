#!/usr/bin/env python3
"""Mirror the upstream HOME subset into ``upstream/``.

Only these paths are copied, because ``docs/home/app.html`` reaches outside its
own directory:

    docs/home                        -> upstream/home
    docs/pokemon/icons               -> upstream/pokemon/icons
    docs/pokemon/sprites             -> upstream/pokemon/sprites
    docs/stylesheets/standalone.css  -> upstream/stylesheets/
    docs/stylesheets/pixel-images.css
    docs/javascripts/pixel-images.js -> upstream/javascripts/
    docs/play/native-save.js         -> upstream/play/

Usage:
    python scripts/sync_upstream.py --from-local ../azoth-wiki
    python scripts/sync_upstream.py                  # sparse clone from GitHub
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UPSTREAM = ROOT / "upstream"
LOCK = ROOT / "upstream.lock.json"
DEFAULT_REPO = "https://github.com/Sum-Light/azoth-wiki.git"
DEFAULT_BRANCH = "main"

SPARSE_PATHS = [
    "docs/home",
    "docs/pokemon/icons",
    "docs/pokemon/sprites",
    "docs/stylesheets",
    "docs/javascripts",
    "docs/play/native-save.js",
]

# (source relative to a docs/ root, destination relative to upstream/)
COPIES = [
    ("home", "home"),
    ("pokemon/icons", "pokemon/icons"),
    ("pokemon/sprites", "pokemon/sprites"),
    ("stylesheets/standalone.css", "stylesheets/standalone.css"),
    ("stylesheets/pixel-images.css", "stylesheets/pixel-images.css"),
    ("javascripts/pixel-images.js", "javascripts/pixel-images.js"),
    ("play/native-save.js", "play/native-save.js"),
]


def run(cmd: list[str], cwd: Path | None = None) -> str:
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8")
    if result.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)}\n{result.stderr.strip()}")
    return result.stdout.strip()


def local_head(repo: Path) -> str:
    return run(["git", "-C", str(repo), "rev-parse", "HEAD"])


def remote_head(repo: str, branch: str) -> str:
    out = run(["git", "ls-remote", repo, f"refs/heads/{branch}"])
    if not out:
        raise RuntimeError(f"cannot resolve {repo} refs/heads/{branch}")
    return out.split()[0]


def sparse_clone(repo: str, branch: str, target: Path) -> None:
    run([
        "git", "clone", "--filter=blob:none", "--sparse", "--depth=1",
        "--branch", branch, repo, str(target),
    ])
    run(["git", "-C", str(target), "sparse-checkout", "set", *SPARSE_PATHS])


def mirror(docs: Path, commit: str, source: str) -> None:
    missing = [src for src, _ in COPIES if not (docs / src).exists()]
    if missing:
        raise RuntimeError("upstream is missing: " + ", ".join(missing))

    if UPSTREAM.exists():
        shutil.rmtree(UPSTREAM)
    UPSTREAM.mkdir(parents=True)

    for src, dst in COPIES:
        s, d = docs / src, UPSTREAM / dst
        d.parent.mkdir(parents=True, exist_ok=True)
        if s.is_dir():
            shutil.copytree(s, d)
        else:
            shutil.copy2(s, d)

    files = sum(1 for p in UPSTREAM.rglob("*") if p.is_file())
    size = sum(p.stat().st_size for p in UPSTREAM.rglob("*") if p.is_file())
    LOCK.write_text(json.dumps({
        "repo": source,
        "commit": commit,
        "synced_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "files": files,
        "bytes": size,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"upstream {commit[:10]} -> {files} files, {size / 1024 / 1024:.2f} MB")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--from-local", type=Path, help="existing azoth-wiki checkout")
    parser.add_argument("--repo", default=DEFAULT_REPO)
    parser.add_argument("--branch", default=DEFAULT_BRANCH)
    parser.add_argument("--force", action="store_true", help="mirror even if the commit is unchanged")
    args = parser.parse_args()

    if args.from_local:
        repo = args.from_local.resolve()
        docs = repo / "docs"
        if not docs.is_dir():
            raise SystemExit(f"{docs} does not look like an azoth-wiki checkout")
        commit = local_head(repo)
        source = str(repo)
        if not args.force and LOCK.exists():
            try:
                if json.loads(LOCK.read_text(encoding="utf-8")).get("commit") == commit:
                    print(f"upstream already at {commit[:10]}, nothing to do")
                    return 0
            except (ValueError, KeyError):
                pass
        mirror(docs, commit, source)
        return 0

    if not args.force and LOCK.exists():
        try:
            if json.loads(LOCK.read_text(encoding="utf-8")).get("commit") == remote_head(args.repo, args.branch):
                print("upstream unchanged, nothing to do")
                return 0
        except (ValueError, KeyError, RuntimeError):
            pass

    with tempfile.TemporaryDirectory(prefix="azoth-upstream-") as tmp:
        target = Path(tmp) / "repo"
        sparse_clone(args.repo, args.branch, target)
        mirror(target / "docs", local_head(target), args.repo)
    return 0


if __name__ == "__main__":
    sys.exit(main())
