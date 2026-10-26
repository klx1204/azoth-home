#!/usr/bin/env python3
"""Assemble ``dist/`` from the upstream mirror plus local extras.

Layout: the app is served from the site root, so ``https://<user>.github.io/
azoth-home/`` opens HOME directly (no redirect page).

    dist/
      index.html            upstream home/app.html, rewritten for the root
      home-game-data.json   ../pokemon/ -> pokemon/
      item_icons/ pokemon/ stylesheets/ javascripts/ play/ extras/
      home/index.html       redirect for old /home/ links

Upstream files are never edited in place. Everything local is added at build
time through three anchors:

    </head>          -> stylesheet link
    </body>          -> script tags (after upstream's own scripts)
    })().catch(      -> the bridge, injected inside upstream's IIFE scope
"""

from __future__ import annotations

import argparse
import hashlib
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UPSTREAM = ROOT / "upstream"
SRC = ROOT / "src"
DIST = ROOT / "dist"

APP = "index.html"
HEAD_ANCHOR = "</head>"
BODY_ANCHOR = "</body>"
IIFE_ANCHOR = "})().catch("

STYLES = ["extras/home-editor.css"]
SCRIPTS = ["extras/mon-codec.js", "extras/showdown.js", "extras/home-editor.js"]

SHARED_DIRS = ("pokemon", "stylesheets", "javascripts", "play")

URL_REWRITES = {
    "../stylesheets/": "stylesheets/",
    "../javascripts/": "javascripts/",
    "../play/": "play/",
}

DATA_REWRITES = {
    '"../pokemon/': '"pokemon/',
}

DEFAULT_PROFILE = [
    ('<option value="fc">', '<option value="fc" selected>'),
    ('<option value="tower" selected>', '<option value="tower">'),
    ('let currentBrowserProfile = "tower";', 'let currentBrowserProfile = "fc";'),
]


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
        fail(f"expected exactly one {HEAD_ANCHOR!r} in upstream app.html")
    if html.count(BODY_ANCHOR) != 1:
        fail(f"expected exactly one {BODY_ANCHOR!r} in upstream app.html")

    head = "".join(f'  <link rel="stylesheet" href="{path}?v={version}">\n' for path in STYLES)
    html = html.replace(HEAD_ANCHOR, head + HEAD_ANCHOR, 1)

    body = "".join(f'  <script src="{path}?v={version}"></script>\n' for path in SCRIPTS)
    html = html.replace(BODY_ANCHOR, body + BODY_ANCHOR, 1)

    index = html.rfind(IIFE_ANCHOR)
    if index < 0:
        fail(f"cannot find the IIFE tail {IIFE_ANCHOR!r}; upstream structure changed")
    bridge = (SRC / "bridge.js").read_text(encoding="utf-8").rstrip() + "\n\n"
    return html[:index] + bridge + html[index:]


def rewrite_root(html: str) -> str:
    for old, new in URL_REWRITES.items():
        html = html.replace(old, new)
    return html


def apply_default_profile(html: str) -> str:
    for old, new in DEFAULT_PROFILE:
        if html.count(old) != 1:
            fail(f"expected exactly one {old!r} in upstream app.html")
        html = html.replace(old, new, 1)
    return html


def copy_home(target: Path) -> None:
    for item in (UPSTREAM / "home").iterdir():
        destination = target / item.name
        if item.is_dir():
            shutil.copytree(item, destination)
        else:
            shutil.copy2(item, destination)


def write_legacy_redirect(target: Path) -> None:
    target.write_text(
        """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>宝可梦水银 HOME</title>
<meta http-equiv="refresh" content="0; url=../">
</head>
<body>
<p><a href="../">水银 HOME 已移到站点首页</a></p>
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

    copy_home(DIST)
    for name in SHARED_DIRS:
        shutil.copytree(UPSTREAM / name, DIST / name)
    shutil.copytree(SRC / "extras", DIST / "extras")
    shutil.copytree(SRC / "data", DIST / "extras" / "data")

    data_file = DIST / "home-game-data.json"
    data = data_file.read_text(encoding="utf-8")
    for old, new in DATA_REWRITES.items():
        data = data.replace(old, new)
    if '"../pokemon/' in data:
        fail("some pokemon paths were not rewritten in home-game-data.json")
    data_file.write_text(data, encoding="utf-8")

    version = tree_hash(SRC) + "-" + tree_hash(UPSTREAM / "home")[:4]
    upstream_app = (DIST / "app.html").read_text(encoding="utf-8")
    html = rewrite_root(apply_default_profile(upstream_app))
    (DIST / APP).write_text(inject(html, version), encoding="utf-8")
    (DIST / "app.html").unlink()

    (DIST / "home").mkdir(exist_ok=True)
    write_legacy_redirect(DIST / "home" / "index.html")

    files = sum(1 for p in DIST.rglob("*") if p.is_file())
    size = sum(p.stat().st_size for p in DIST.rglob("*") if p.is_file())
    print(f"built dist/ -> {files} files, {size / 1024 / 1024:.2f} MB, extras v={version}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
