#!/usr/bin/env python3
"""Build src/data/moves-en.json from PokeAPI's moves.csv.

The move ids in Project Azoth match the national move ids for the shared range
(1 = Pound, 33 = Tackle, 85 = Thunderbolt), so the identifier column can be used
as the English name. Custom moves past the official list simply have no English
name and stay searchable by Chinese name / id.

    python scripts/fetch_move_names.py [--csv PATH]
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src" / "data" / "moves-en.json"
URL = "https://cdn.jsdelivr.net/gh/PokeAPI/pokeapi@master/data/v2/csv/moves.csv"

SPOT_CHECKS = {1: "pound", 33: "tackle", 85: "thunderbolt", 89: "earthquake", 94: "psychic"}


def load_csv(path: Path | None) -> str:
    if path:
        return path.read_text(encoding="utf-8")
    request = urllib.request.Request(URL, headers={"User-Agent": "azoth-home-build"})
    with urllib.request.urlopen(request, timeout=45) as response:
        return response.read().decode("utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", type=Path, help="use a local moves.csv instead of downloading")
    args = parser.parse_args()

    text = load_csv(args.csv)
    reader = csv.DictReader(io.StringIO(text))
    names: dict[str, str] = {}
    for row in reader:
        try:
            move_id = int(row["id"])
        except (KeyError, TypeError, ValueError):
            continue
        identifier = (row.get("identifier") or "").strip()
        if move_id and identifier:
            names[str(move_id)] = identifier

    for move_id, expected in SPOT_CHECKS.items():
        actual = names.get(str(move_id))
        if actual != expected:
            print(f"spot check failed: move {move_id} is {actual!r}, expected {expected!r}", file=sys.stderr)
            return 1

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(names, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)} ({len(names)} moves, {OUT.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
