#!/usr/bin/env python3
"""Inspect a 128 KiB Pokemon Mercury save and locate the party block.

The party layout is not documented in azoth-wiki, so this script scans
SaveBlock1 for a run of 100-byte records whose first 58 bytes look like the
known box-mon layout (species @28, item @30, exp @32).

    python scripts/analyze_sav.py "<save.sav>"
"""

from __future__ import annotations

import struct
import sys
from pathlib import Path

SECTOR = 0x1000
SECTOR_DATA = 0xFF0
SLOT_SECTORS = 14
SIGNATURE = 0x08012025
SECTION_SIZES = [
    0xF24,
    0xFF0, 0xFF0, 0xFF0, 0xD98,
    0xFF0, 0xFF0, 0xFF0, 0xFF0, 0xFF0, 0xFF0, 0xFF0, 0xFF0, 0x450,
]
BOX_MON = 58
PARTY_MON = 100


def checksum(data: bytes) -> int:
    total = 0
    for i in range(0, len(data), 4):
        total = (total + struct.unpack_from("<I", data.ljust(i + 4, b"\0"), i)[0]) & 0xFFFFFFFF
    return ((total >> 16) + (total & 0xFFFF)) & 0xFFFF


def read_slot(buf: bytes, base: int):
    sections: dict[int, bytes] = {}
    counter = None
    for i in range(SLOT_SECTORS):
        off = (base + i) * SECTOR
        if off + SECTOR > len(buf):
            return None
        section_id = struct.unpack_from("<H", buf, off + 0xFF4)[0]
        stored = struct.unpack_from("<H", buf, off + 0xFF6)[0]
        signature = struct.unpack_from("<I", buf, off + 0xFF8)[0]
        section_counter = struct.unpack_from("<I", buf, off + 0xFFC)[0]
        if signature != SIGNATURE or section_id >= SLOT_SECTORS or section_id in sections:
            return None
        if counter is not None and counter != section_counter:
            return None
        data = buf[off:off + SECTION_SIZES[section_id]]
        if checksum(data) != stored:
            return None
        sections[section_id] = data
        counter = section_counter
    return {"sections": sections, "counter": counter, "base": base}


def concat(sections: dict[int, bytes], ids: list[int]) -> bytes:
    return b"".join(sections.get(i, bytes(SECTOR_DATA)) for i in ids)


def decode_text(raw: bytes) -> str:
    # Only used for eyeballing; the real charmap lives in home-game-data.json.
    return "".join(chr(b) if 32 <= b < 127 else "." for b in raw)


def load_game_data():
    import json
    path = Path(__file__).resolve().parent.parent / "upstream" / "home" / "home-game-data.json"
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def exp_level(game, species: int, exp: int) -> int | None:
    if not game:
        return None
    entry = game["species"].get(str(species))
    if not entry:
        return None
    table = game["experienceTables"][entry.get("growthRate", 0)]
    level = 1
    for i in range(1, len(table)):
        if exp >= table[i]:
            level = i
        else:
            break
    return level


def plausible_mon(chunk: bytes, species_max: int, item_max: int, game=None) -> bool:
    if len(chunk) < BOX_MON:
        return False
    species = struct.unpack_from("<H", chunk, 28)[0]
    item = struct.unpack_from("<H", chunk, 30)[0]
    exp = struct.unpack_from("<I", chunk, 32)[0]
    if not (1 <= species <= species_max) or item > item_max or exp >= 2_000_000:
        return False

    bits = int.from_bytes(chunk[39:44], "little")
    moves = [(bits >> (i * 10)) & 0x3FF for i in range(4)]
    if any(move > 950 for move in moves):
        return False

    evs = list(chunk[44:50])
    if sum(evs) > 510:
        return False

    if game is not None:
        level = exp_level(game, species, exp)
        if level is None or not 1 <= level <= 100:
            return False
        if exp and exp < game["experienceTables"][game["species"][str(species)].get("growthRate", 0)][1]:
            return False
    return True


def scan_party(save_block1: bytes, species_max: int, item_max: int, game=None, window: int = 0x1000):
    hits = []
    for offset in range(1, min(window, len(save_block1) - PARTY_MON * 2)):
        count = save_block1[offset - 1]
        if not 1 <= count <= 6:
            continue
        run = 0
        for slot in range(count):
            chunk = save_block1[offset + slot * PARTY_MON: offset + (slot + 1) * PARTY_MON]
            if plausible_mon(chunk, species_max, item_max, game):
                run += 1
            else:
                break
        if run == count:
            hits.append((offset, run, count))
    return hits


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    path = Path(sys.argv[1])
    buf = path.read_bytes()
    print(f"file: {path.name} ({len(buf)} bytes)")

    slots = [read_slot(buf, 0), read_slot(buf, SLOT_SECTORS)]
    valid = [slot for slot in slots if slot]
    if not valid:
        print("no valid save slot found")
        return 1
    for slot in valid:
        print(f"slot base {slot['base']} counter {slot['counter']} sections {sorted(slot['sections'])}")
    slot = max(valid, key=lambda item: item["counter"])
    print(f"picked slot base {slot['base']} counter {slot['counter']}")

    save_block1 = concat(slot["sections"], [1, 2, 3, 4])
    print(f"saveBlock1: {len(save_block1)} bytes")
    print("head 0x00-0x60:", save_block1[:0x60].hex(" "))
    print("text 0x00-0x60:", decode_text(save_block1[:0x60]))

    game = load_game_data()
    hits = scan_party(save_block1, 1584, 946, game)
    print(f"\nparty candidates: {len(hits)}")
    for offset, run, count in hits[:12]:
        print(f"  offset 0x{offset:04x} count={count}")

    if not hits:
        return 0

    offset, run, count = max(hits, key=lambda item: item[1])
    print(f"\nbest: offset 0x{offset:04x}, {count} members")
    for slot_index in range(6):
        chunk = save_block1[offset + slot_index * PARTY_MON: offset + (slot_index + 1) * PARTY_MON]
        if not plausible_mon(chunk, 1584, 946, game):
            print(f"  slot {slot_index}: empty/invalid")
            continue
        species, item = struct.unpack_from("<H", chunk, 28)[0], struct.unpack_from("<H", chunk, 30)[0]
        exp = struct.unpack_from("<I", chunk, 32)[0]
        bits = int.from_bytes(chunk[39:44], "little")
        moves = [(bits >> (i * 10)) & 0x3FF for i in range(4)]
        print(f"  slot {slot_index}: species={species} item={item} exp={exp} level={exp_level(game, species, exp)} moves={moves}")
        print(f"            battle bytes 58..99: {chunk[58:100].hex(' ')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
