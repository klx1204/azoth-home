/* 58-byte CfrU box-mon field codec.

   Upstream's serializeBoxMon() only returns mon.raw, so editing a Pokemon means
   rebuilding those 58 bytes. apply() takes the original bytes and patches only
   the requested fields, leaving every other byte untouched.

   Field layout (little endian), verified against docs/home/app.html:
     0  personality u32      4  otId u32         8  nickname 10 bytes
     28 species u16         30  heldItem u16     32  exp u32
     37 friendship u8       39  moves 4 x 10 bit 44  evs hp/atk/def/spe/spa/spd
     54 iv word u32 (bit 31 = hidden ability slot)

   Loaded in the browser as window.AzothMonCodec, and requirable from Node for
   the round-trip tests.
*/
(function (global) {
  "use strict";

  const SIZE = 58;
  const NICKNAME_OFFSET = 8;
  const NICKNAME_LENGTH = 10;
  const MOVES_OFFSET = 39;
  const EV_OFFSET = 44;
  const IV_OFFSET = 54;
  const IV_KEYS = ["hp", "atk", "def", "spe", "spa", "spd"];
  const EV_KEYS = ["hp", "atk", "def", "spe", "spa", "spd"];
  const HIDDEN_BIT = 0x80000000;

  const charmapCache = new WeakMap();

  function assertRaw(raw) {
    if (!raw || raw.length !== SIZE) throw new Error(`需要 ${SIZE} 字节的个体数据`);
    return Uint8Array.from(raw);
  }

  function u16(out, offset, value) {
    out[offset] = value & 0xff;
    out[offset + 1] = (value >>> 8) & 0xff;
  }

  function u32(out, offset, value) {
    out[offset] = value & 0xff;
    out[offset + 1] = (value >>> 8) & 0xff;
    out[offset + 2] = (value >>> 16) & 0xff;
    out[offset + 3] = (value >>> 24) & 0xff;
  }

  function readU16(raw, offset) {
    return raw[offset] | (raw[offset + 1] << 8);
  }

  function readU32(raw, offset) {
    return (raw[offset] | (raw[offset + 1] << 8) | (raw[offset + 2] << 16) | (raw[offset + 3] << 24)) >>> 0;
  }

  /* charmap is { "hexbytes": "char" }. Prefer the shortest encoding per char. */
  function charset(charmap) {
    if (!charmap) throw new Error("缺少字符表，无法编码昵称");
    let map = charmapCache.get(charmap);
    if (map) return map;
    map = new Map();
    for (const [hex, char] of Object.entries(charmap)) {
      if (!hex || hex.length % 2) continue;
      const bytes = [];
      for (let i = 0; i < hex.length; i += 2) bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
      if (!bytes.length) continue;
      const previous = map.get(char);
      if (!previous || bytes.length < previous.length) map.set(char, bytes);
    }
    charmapCache.set(charmap, map);
    return map;
  }

  function encodeNickname(text, charmap, length = NICKNAME_LENGTH) {
    const map = charset(charmap);
    const out = new Uint8Array(length).fill(0xff);
    let at = 0;
    for (const char of Array.from(String(text ?? ""))) {
      const bytes = map.get(char);
      if (!bytes) continue;
      if (at + bytes.length > length - 1) break;
      for (let i = 0; i < bytes.length; i++) out[at + i] = bytes[i];
      at += bytes.length;
    }
    return out;
  }

  function decodeNickname(raw, charmap) {
    const map = new Map();
    for (const [hex, char] of Object.entries(charmap || {})) {
      map.set(hex.toLowerCase(), char);
    }
    let text = "";
    for (let at = NICKNAME_OFFSET; at < NICKNAME_OFFSET + NICKNAME_LENGTH;) {
      if (raw[at] === 0xff) break;
      let matched = false;
      for (let size = 3; size >= 1; size--) {
        if (at + size > NICKNAME_OFFSET + NICKNAME_LENGTH) continue;
        let hex = "";
        for (let i = 0; i < size; i++) hex += raw[at + i].toString(16).padStart(2, "0");
        if (map.has(hex)) {
          text += map.get(hex);
          at += size;
          matched = true;
          break;
        }
      }
      if (!matched) at += 1;
    }
    return text;
  }

  function unpackMoves(raw, offset = MOVES_OFFSET) {
    let bits = 0n;
    for (let i = 0; i < 5; i++) bits |= BigInt(raw[offset + i] || 0) << BigInt(i * 8);
    return [0, 1, 2, 3].map((i) => Number((bits >> BigInt(i * 10)) & 0x3ffn));
  }

  function packMoves(out, offset, moves) {
    let bits = 0n;
    for (let i = 0; i < 4; i++) bits |= BigInt((moves[i] | 0) & 0x3ff) << BigInt(i * 10);
    for (let i = 0; i < 5; i++) out[offset + i] = Number((bits >> BigInt(i * 8)) & 0xffn);
  }

  function wordFromIvs(ivs, hidden) {
    let word = 0;
    IV_KEYS.forEach((key, index) => {
      const value = Math.max(0, Math.min(31, ivs[key] | 0));
      word |= value << (index * 5);
    });
    if (hidden) word |= HIDDEN_BIT;
    return word >>> 0;
  }

  function ivsFromWord(word) {
    const ivs = {};
    IV_KEYS.forEach((key, index) => {
      ivs[key] = (word >>> (index * 5)) & 31;
    });
    return ivs;
  }

  function readEvs(raw) {
    const evs = {};
    EV_KEYS.forEach((key, index) => {
      evs[key] = raw[EV_OFFSET + index];
    });
    return evs;
  }

  /* Level -> total experience, using the species growth table. */
  function expForLevel(gameData, species, level) {
    const entry = gameData?.species?.[String(species)];
    const table = gameData?.experienceTables?.[entry?.growthRate ?? 0];
    if (!Array.isArray(table)) return null;
    const value = table[Math.max(1, Math.min(100, level | 0))];
    return Number.isFinite(value) ? value : null;
  }

  function levelForExp(gameData, species, exp) {
    const entry = gameData?.species?.[String(species)];
    const table = gameData?.experienceTables?.[entry?.growthRate ?? 0];
    if (!Array.isArray(table) || !table.length) return 0;
    let level = 1;
    for (let i = 1; i < table.length; i++) {
      if (exp >= table[i]) level = i;
      else break;
    }
    return level;
  }

  function read(raw) {
    const bytes = assertRaw(raw);
    const ivWord = readU32(bytes, IV_OFFSET);
    return {
      personality: readU32(bytes, 0),
      otId: readU32(bytes, 4),
      species: readU16(bytes, 28),
      heldItem: readU16(bytes, 30),
      exp: readU32(bytes, 32),
      friendship: bytes[37],
      moves: unpackMoves(bytes),
      evs: readEvs(bytes),
      ivs: ivsFromWord(ivWord),
      hiddenAbility: (ivWord & HIDDEN_BIT) !== 0,
    };
  }

  /* Patch only the fields present in `patch`. */
  function apply(raw, patch, options = {}) {
    const out = assertRaw(raw);

    if (patch.species !== undefined) {
      const species = patch.species | 0;
      if (species <= 0 || species > 0xffff) throw new Error("物种编号无效");
      u16(out, 28, species);
    }
    if (patch.heldItem !== undefined) {
      const item = patch.heldItem | 0;
      if (item < 0 || item > 0xffff) throw new Error("道具编号无效");
      u16(out, 30, item);
    }
    if (patch.exp !== undefined) {
      const exp = patch.exp >>> 0;
      if (exp > 0xffffffff) throw new Error("经验值无效");
      u32(out, 32, exp);
    }
    if (patch.friendship !== undefined) {
      out[37] = Math.max(0, Math.min(255, patch.friendship | 0));
    }
    if (patch.moves !== undefined) {
      if (!Array.isArray(patch.moves) || patch.moves.length > 4) throw new Error("招式必须是 4 个以内的数组");
      const moves = patch.moves.map((move) => {
        const id = move | 0;
        if (id < 0 || id > 0x3ff) throw new Error("招式编号超出 10 bit 范围");
        return id;
      });
      packMoves(out, MOVES_OFFSET, moves);
    }
    if (patch.evs !== undefined) {
      EV_KEYS.forEach((key, index) => {
        out[EV_OFFSET + index] = Math.max(0, Math.min(255, patch.evs[key] | 0));
      });
    }
    if (patch.ivs !== undefined) {
      const hidden = patch.hiddenAbility !== undefined
        ? Boolean(patch.hiddenAbility)
        : (readU32(out, IV_OFFSET) & HIDDEN_BIT) !== 0;
      u32(out, IV_OFFSET, wordFromIvs(patch.ivs, hidden));
    } else if (patch.hiddenAbility !== undefined) {
      const word = readU32(out, IV_OFFSET);
      u32(out, IV_OFFSET, patch.hiddenAbility ? (word | HIDDEN_BIT) >>> 0 : (word & ~HIDDEN_BIT) >>> 0);
    }
    if (patch.nickname !== undefined) {
      out.set(encodeNickname(patch.nickname, options.charmap ?? patch.charmap), NICKNAME_OFFSET);
    }
    return out;
  }

  function nicknameBytes(text, charmap) {
    const encoded = encodeNickname(text, charmap);
    let used = 0;
    while (used < encoded.length && encoded[used] !== 0xff) used++;
    return used;
  }

  const api = {
    SIZE,
    NICKNAME_LENGTH,
    IV_KEYS,
    EV_KEYS,
    HIDDEN_BIT,
    apply,
    read,
    packMoves,
    unpackMoves,
    wordFromIvs,
    ivsFromWord,
    encodeNickname,
    decodeNickname,
    nicknameBytes,
    expForLevel,
    levelForExp,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (global) global.AzothMonCodec = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
