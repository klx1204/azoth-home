import assert from "node:assert/strict";
import { test } from "node:test";
import "../src/extras/mon-codec.js";

// The codec is an IIFE that assigns globalThis.AzothMonCodec (which is what the
// browser loads too), so importing it is enough.
const codec = globalThis.AzothMonCodec;

/* A minimal charmap so nickname tests do not depend on the 1.4 MB game data.
   Two bytes per char keeps the encoder's longest-match path honest. */
const charmap = {
  "00": "A",
  "01": "B",
  "02": "测",
  "03": "试",
  "0100": "A", // longer alias for the same char must not win
};

function baseRaw() {
  const raw = new Uint8Array(codec.SIZE);
  raw[0] = 0x12; // personality
  raw[1] = 0x34;
  raw[4] = 0x56; // otId
  raw[50] = 0x07; // pokerus / unused byte we must not touch
  raw[51] = 0x2a; // met location byte we must not touch
  return raw;
}

test("apply only touches the requested fields", () => {
  const before = baseRaw();
  const after = codec.apply(before, {
    species: 25,
    heldItem: 13,
    exp: 125,
    moves: [33, 45, 0, 0],
  });

  assert.equal(after.length, 58);
  assert.equal(codec.read(after).species, 25);
  assert.equal(codec.read(after).heldItem, 13);
  assert.equal(codec.read(after).exp, 125);
  assert.deepEqual(codec.read(after).moves, [33, 45, 0, 0]);

  // bytes outside every patched field stay identical
  const touched = new Set([28, 29, 30, 31, 32, 33, 34, 35, 39, 40, 41, 42, 43]);
  for (let i = 0; i < 58; i++) {
    if (touched.has(i)) continue;
    assert.equal(after[i], before[i], `byte ${i} changed unexpectedly`);
  }
});

test("moves pack and unpack across the 10-bit boundary", () => {
  const raw = codec.apply(baseRaw(), { moves: [1023, 512, 1, 0] });
  assert.deepEqual(codec.read(raw).moves, [1023, 512, 1, 0]);
  assert.throws(() => codec.apply(baseRaw(), { moves: [1024] }), /10 bit/);
});

test("IV word preserves the hidden-ability bit unless asked", () => {
  const ivs = { hp: 31, atk: 30, def: 29, spe: 28, spa: 27, spd: 26 };
  const hidden = codec.apply(baseRaw(), { ivs, hiddenAbility: true });
  const parsed = codec.read(hidden);
  assert.deepEqual(parsed.ivs, ivs);
  assert.equal(parsed.hiddenAbility, true);

  const plain = codec.apply(hidden, { ivs });
  assert.equal(codec.read(plain).hiddenAbility, true, "bit 31 must survive an IV-only patch");

  const cleared = codec.apply(hidden, { ivs, hiddenAbility: false });
  assert.equal(codec.read(cleared).hiddenAbility, false);
  assert.deepEqual(codec.read(cleared).ivs, ivs);
});

test("IV values are clamped and ordered hp/atk/def/spe/spa/spd", () => {
  const word = codec.wordFromIvs({ hp: 1, atk: 2, def: 3, spe: 4, spa: 5, spd: 6 }, false);
  assert.equal(word, 1 | (2 << 5) | (3 << 10) | (4 << 15) | (5 << 20) | (6 << 25));
  assert.deepEqual(codec.ivsFromWord(word), { hp: 1, atk: 2, def: 3, spe: 4, spa: 5, spd: 6 });
});

test("nickname encoding picks the shortest sequence and terminates with 0xFF", () => {
  const raw = codec.apply(baseRaw(), { nickname: "AB测" }, { charmap });
  assert.equal(codec.decodeNickname(raw, charmap), "AB测");

  const bytes = raw.slice(8, 18);
  assert.deepEqual(Array.from(bytes.slice(0, 3)), [0x00, 0x01, 0x02]);
  assert.equal(bytes[3], 0xff);
  assert.ok(bytes.slice(3).every((value) => value === 0xff), "tail must be padded with 0xFF");
});

test("nickname stops before overflowing the 10-byte field", () => {
  const long = "A".repeat(20);
  const raw = codec.apply(baseRaw(), { nickname: long }, { charmap });
  assert.equal(codec.nicknameBytes(long, charmap), 9);
  assert.equal(codec.decodeNickname(raw, charmap), "A".repeat(9));
});

test("level and experience round-trip through the growth table", () => {
  // fast growth: table[i] = i^3
  const gameData = {
    species: { "25": { growthRate: 0 } },
    experienceTables: [Array.from({ length: 101 }, (_, i) => i * i * i)],
  };
  assert.equal(codec.expForLevel(gameData, 25, 50), 125000);
  assert.equal(codec.levelForExp(gameData, 25, 125000), 50);
  assert.equal(codec.levelForExp(gameData, 25, 124999), 49);
});

test("invalid raw sizes and empty species are rejected", () => {
  assert.throws(() => codec.apply(new Uint8Array(57), {}), /58/);
  assert.throws(() => codec.apply(baseRaw(), { species: 0 }), /物种/);
});
