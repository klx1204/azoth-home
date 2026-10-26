#!/usr/bin/env python3
"""Static checks for dist/ after scripts/build.py.

Fails when an anchor disappeared, a referenced local asset is missing, or the
upstream DOM contract that the injected editor relies on has changed.

    python scripts/smoke.py
"""

from __future__ import annotations

import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
APP = DIST / "home" / "app.html"

REQUIRED_IDS = [
    "homeBox", "savBox", "homePrev", "homeNext", "savPrev", "savNext",
    "saveBtn", "summary", "detail", "file", "importMonBtn", "exportHomeBtn",
]

INJECTED = [
    "../extras/home-editor.css",
    "../extras/mon-codec.js",
    "../extras/home-editor.js",
]

BRIDGE_MARK = "window.AzothHomeInternal"
IIFE_TAIL = "})().catch("

errors: list[str] = []


def check(condition: bool, message: str) -> None:
    if not condition:
        errors.append(message)


class AssetCollector(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.refs: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        for name, value in attrs:
            if name in {"src", "href"} and value:
                self.refs.append(value)


def main() -> int:
    if not APP.is_file():
        print("smoke failed: dist/home/app.html is missing; run scripts/build.py", file=sys.stderr)
        return 1

    html = APP.read_text(encoding="utf-8")

    for expected in INJECTED:
        check(expected in html, f"missing injected asset reference: {expected}")

    check(html.count(BRIDGE_MARK) == 1, f"expected exactly one {BRIDGE_MARK}")
    bridge_at = html.find(BRIDGE_MARK)
    tail_at = html.rfind(IIFE_TAIL)
    check(0 <= bridge_at < tail_at, "bridge is not inside the upstream IIFE (injection point moved)")

    for element_id in REQUIRED_IDS:
        check(f'id="{element_id}"' in html, f"upstream DOM id #{element_id} disappeared")

    collector = AssetCollector()
    collector.feed(html)
    for ref in collector.refs:
        parsed = urlparse(ref)
        if parsed.scheme or parsed.netloc or ref.startswith("#") or ref.startswith("data:"):
            continue
        target = (APP.parent / parsed.path).resolve()
        check(target.is_file(), f"referenced asset not found: {ref} -> {target}")

    data_path = DIST / "home" / "home-game-data.json"
    check(data_path.is_file(), "home-game-data.json is missing")
    if data_path.is_file():
        try:
            data = json.loads(data_path.read_text(encoding="utf-8"))
            for key in ("species", "moves", "items", "charmap"):
                check(key in data and isinstance(data[key], dict), f"game data is missing {key}")
        except ValueError as error:
            errors.append(f"home-game-data.json is not valid JSON: {error}")

    icon = DIST / "pokemon" / "icons" / "0001.png"
    check(icon.is_file(), "pokemon icons were not mirrored")
    sprite = DIST / "pokemon" / "sprites" / "0001.png"
    check(sprite.is_file(), "pokemon sprites were not mirrored")

    for name in ("standalone.css", "pixel-images.css"):
        check((DIST / "stylesheets" / name).is_file(), f"stylesheets/{name} is missing")
    check((DIST / "javascripts" / "pixel-images.js").is_file(), "javascripts/pixel-images.js is missing")
    check((DIST / "play" / "native-save.js").is_file(), "play/native-save.js is missing")
    check((DIST / "extras" / "mon-codec.js").is_file(), "extras/mon-codec.js is missing")
    check((DIST / "index.html").is_file(), "dist/index.html landing page is missing")
    check((DIST / "home" / "index.html").is_file(), "dist/home/index.html redirect page is missing")

    if errors:
        print("smoke failed:", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1

    print(f"smoke ok: {APP.relative_to(ROOT)} ({len(collector.refs)} asset refs, {len(REQUIRED_IDS)} ids)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
