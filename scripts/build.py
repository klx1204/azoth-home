#!/usr/bin/env python3
"""Assemble ``dist/`` from the upstream mirror plus local extras.

The upstream files are never edited in place. Everything local is added at
build time through three anchors:

    </head>          -> stylesheet link
    </body>          -> script tags (after upstream's own scripts)
    })().catch(      -> the bridge, injected inside upstream's IIFE scope

Each anchor must appear exactly once (the IIFE anchor uses the last match).
A missing anchor fails the build instead of silently shipping a broken page.
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UPSTREAM = ROOT / "upstream"
SRC = ROOT / "src"
DIST = ROOT / "dist"

APP = "home/app.html"
HEAD_ANCHOR = "</head>"
BODY_ANCHOR = "</body>"
IIFE_ANCHOR = "})().catch("

STYLES = ["extras/home-editor.css"]
SCRIPTS = ["extras/mon-codec.js", "extras/home-editor.js"]


def fail(message: str) -> None:
    print(f"build failed: {message}", file=sys.stderr)
    raise SystemExit(1)


def tree_hash(path: Path) -> str:
    digest = hashlib.sha256()
    for file in sorted(p for p in path.rglob("*") if p.is_file()):
        digest.update(file.relative_to(path).as_posix().encode("utf-8"))
        digest.update(file.read_bytes())
    return digest.hexdigest()[:10]


def inject(html: str, version: str) -> str:
    if html.count(HEAD_ANCHOR) != 1:
        fail(f"expected exactly one {HEAD_ANCHOR!r} in {APP}")
    if html.count(BODY_ANCHOR) != 1:
        fail(f"expected exactly one {BODY_ANCHOR!r} in {APP}")

    head = "".join(
        f'  <link rel="stylesheet" href="../{path}?v={version}">\n' for path in STYLES
    )
    html = html.replace(HEAD_ANCHOR, head + HEAD_ANCHOR, 1)

    body = "".join(
        f'  <script src="../{path}?v={version}"></script>\n' for path in SCRIPTS
    )
    html = html.replace(BODY_ANCHOR, body + BODY_ANCHOR, 1)

    index = html.rfind(IIFE_ANCHOR)
    if index < 0:
        fail(f"cannot find the IIFE tail {IIFE_ANCHOR!r}; upstream structure changed")
    bridge = (SRC / "bridge.js").read_text(encoding="utf-8").rstrip() + "\n\n"
    html = html[:index] + bridge + html[index:]
    return html


def write_landing(target: Path) -> None:
    target.write_text(
        """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>宝可梦水银 HOME</title>
<meta http-equiv="refresh" content="0; url=home/app.html">
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font-family: "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
         background: #f5f7f7; color: #243332; }
  a { color: #195e54; font-size: 18px; }
  p { color: #586967; font-size: 14px; }
</style>
</head>
<body>
<main>
  <p>正在打开水银 HOME…</p>
  <p><a href="home/app.html">如果没有自动跳转，点这里</a></p>
</main>
</body>
</html>
""",
        encoding="utf-8",
    )


def write_home_index(target: Path) -> None:
    """GitHub Pages serves directory URLs from index.html, not app.html."""
    target.write_text(
        """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>宝可梦水银 HOME</title>
<meta http-equiv="refresh" content="0; url=app.html">
</head>
<body>
<p><a href="app.html">正在打开水银 HOME…</a></p>
</body>
</html>
""",
        encoding="utf-8",
    )



def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--keep", action="store_true", help="reuse dist/ instead of rebuilding")
    args = parser.parse_args()

    if not (UPSTREAM / "home").is_dir():
        fail("upstream/home is missing; run scripts/sync_upstream.py first")

    if DIST.exists() and not args.keep:
        shutil.rmtree(DIST)
    DIST.mkdir(parents=True, exist_ok=True)

    shutil.copytree(UPSTREAM, DIST, dirs_exist_ok=True)
    shutil.copytree(SRC / "extras", DIST / "extras", dirs_exist_ok=True)

    version = tree_hash(SRC / "extras") + "-" + tree_hash(UPSTREAM / "home")[:4]
    app = DIST / APP
    app.write_text(inject(app.read_text(encoding="utf-8"), version), encoding="utf-8")

    write_landing(DIST / "index.html")
    write_home_index(DIST / "home" / "index.html")

    files = sum(1 for p in DIST.rglob("*") if p.is_file())
    size = sum(p.stat().st_size for p in DIST.rglob("*") if p.is_file())
    print(f"built dist/ -> {files} files, {size / 1024 / 1024:.2f} MB, extras v={version}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
