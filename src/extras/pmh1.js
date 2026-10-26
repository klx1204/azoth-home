/* Project Azoth (PMH1) data layer for the editor.

   Wraps window.AZOTH_DATA (src/data/pmh1-data.js, taken from the standalone
   showdown-pmh1 converter) and adds the pieces the HOME editor needs:

     - name lookups in English and Chinese
     - PID search so nature / gender / shiny / ability slot can all be chosen
     - readMon(raw) / buildMon(options, templateRaw) for the 58-byte format

   buildMon patches a template mon, so OT name, language, tera type and every
   other byte we do not manage stay exactly as the template had them.
*/
(function (global) {
  "use strict";

  const D = global.AZOTH_DATA;
  if (!D) throw new Error("AZOTH_DATA 未加载");

  const toId = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
  const hexToBytes = (hex) => {
    const out = [];
    for (let i = 0; i < hex.length; i += 2) out.push(Number.parseInt(hex.slice(i, i + 2), 16));
    return out;
  };

  const decodeTokens = Object.entries(D.chars)
    .map(([ch, hex]) => ({ ch, bytes: hexToBytes(hex) }))
    .sort((a, b) => b.bytes.length - a.bytes.length);

  function decodeText(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length && bytes[i] !== 0xff;) {
      const token = decodeTokens.find((t) =>
        i + t.bytes.length <= bytes.length && t.bytes.every((b, j) => bytes[i + j] === b));
      if (!token) { i += 1; continue; }
      out += token.ch;
      i += token.bytes.length;
    }
    return out;
  }

  function encodeText(text, capacity, truncate = true) {
    const bytes = [];
    for (const ch of String(text ?? "")) {
      const hex = D.chars[ch];
      if (!hex) continue;
      const piece = hexToBytes(hex);
      if (bytes.length + piece.length > capacity) {
        if (truncate) break;
        throw new Error(`「${ch}」超出 ${capacity} 字节`);
      }
      bytes.push(...piece);
    }
    const out = new Uint8Array(capacity).fill(0xff);
    out.set(bytes);
    return out;
  }

  // ---------- name indexes ----------
  const speciesByEn = new Map();
  const speciesByZh = new Map();
  for (const [id, row] of Object.entries(D.species)) {
    if (row[0] && !speciesByEn.has(toId(row[0]))) speciesByEn.set(toId(row[0]), Number(id));
    if (row[1] && !speciesByZh.has(row[1])) speciesByZh.set(row[1], Number(id));
  }
  for (const [alias, id] of Object.entries(D.speciesAlias || {})) {
    const key = toId(alias);
    if (key && !speciesByEn.has(key)) speciesByEn.set(key, id);
  }

  const moveIndex = new Map();
  const moveList = [];
  for (const [id, row] of Object.entries(D.moves)) {
    const number = Number(id);
    if (!number) continue;
    const en = (row[0] || []).find(Boolean) || "";
    const zh = row[1] || "";
    for (const key of row[0] || []) {
      const normalized = toId(key);
      if (normalized && !moveIndex.has(normalized)) moveIndex.set(normalized, number);
    }
    if (zh && !moveIndex.has(zh)) moveIndex.set(zh, number);
    moveList.push({ id: number, zh, en });
  }

  const itemIndex = new Map();
  for (const [id, row] of Object.entries(D.items)) {
    const number = Number(id);
    if (!number) continue;
    if (row[0]) itemIndex.set(toId(row[0]), number);
    if (row[1] && !itemIndex.has(row[1])) itemIndex.set(row[1], number);
  }

  const abilityIndex = new Map();
  for (const [id, row] of Object.entries(D.abilities)) {
    const number = Number(id);
    if (!number) continue;
    if (row[0]) abilityIndex.set(toId(row[0]), number);
    if (row[1] && !abilityIndex.has(row[1])) abilityIndex.set(row[1], number);
  }

  const natureIndex = new Map();
  D.natures.forEach(([en, zh], index) => {
    natureIndex.set(toId(en), index);
    if (zh) natureIndex.set(zh, index);
  });

  const ballIndex = new Map();
  for (const [id, en, zh] of D.balls) {
    ballIndex.set(toId(en), id);
    if (zh) ballIndex.set(zh, id);
  }

  function lookup(index, raw) {
    const text = String(raw ?? "").trim();
    if (!text) return null;
    if (/^#?\d+$/.test(text)) {
      const id = Number(text.replace("#", ""));
      return Number.isInteger(id) ? id : null;
    }
    if (index.has(text)) return index.get(text);
    const normalized = toId(text);
    return normalized && index.has(normalized) ? index.get(normalized) : null;
  }

  function lookupSpecies(raw) {
    const text = String(raw ?? "").trim();
    if (!text) return null;
    if (/^#?\d+$/.test(text)) {
      const id = Number(text.replace("#", ""));
      return D.species[id] ? id : null;
    }
    if (speciesByZh.has(text)) return speciesByZh.get(text);
    const normalized = toId(text);
    return normalized && speciesByEn.has(normalized) ? speciesByEn.get(normalized) : null;
  }

  // ---------- derived traits ----------
  function genderOf(pid, ratio) {
    if (ratio === 255) return 2;
    if (ratio === 254) return 1;
    return (pid & 0xff) < ratio ? 1 : 0;
  }

  function shinyValue(pid, tid, sid) {
    return (((pid & 0xffff) ^ (pid >>> 16) ^ tid ^ sid) >>> 0);
  }

  function genderChoices(ratio) {
    if (ratio === 255) return [[2, "无性别"]];
    if (ratio === 254) return [[1, "雌"]];
    if (ratio === 0) return [[0, "雄"]];
    return [[0, "雄"], [1, "雌"]];
  }

  /* Find a PID that satisfies nature, gender, ability slot and shininess for the
     given trainer ids. Slot 2 means hidden ability (IV bit 31), so the PID only
     has to satisfy the other constraints. */
  function searchPid(opt) {
    const { nature, gender, slot, shiny, tid, sid, genderRatio, hasSecondAbility } = opt;
    const trainerXor = (tid ^ sid) & 0xffff;
    const slotOk = (low) => slot === 2 || !hasSecondAbility || (low & 1) === slot;
    const genderOk = (low) => {
      if (gender === 2) return true;
      return ((low & 0xff) < genderRatio ? 1 : 0) === gender;
    };

    if (shiny) {
      for (let low = 1; low < 65536; low++) {
        if (!slotOk(low) || !genderOk(low)) continue;
        for (let x = 0; x < 16; x++) {
          const high = (trainerXor ^ low ^ x) & 0xffff;
          const pid = (((high << 16) | low) >>> 0);
          if (pid % 25 !== nature) continue;
          return pid;
        }
      }
      return null;
    }

    for (let low = 1; low < 65536; low++) {
      if (!slotOk(low) || !genderOk(low)) continue;
      const base = (((nature - low) * 16) % 25 + 25) % 25;
      for (let high = base; high < 65536; high += 25) {
        const pid = (((high << 16) | low) >>> 0);
        if (shinyValue(pid, tid, sid) < 16) continue;
        return pid;
      }
    }
    return null;
  }

  // ---------- 58-byte mon ----------
  function u16(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8);
  }

  function u32(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  }

  function readMon(raw) {
    const bytes = Uint8Array.from(raw);
    const dv = new DataView(bytes.buffer);
    const pid = dv.getUint32(0, true);
    const otId = dv.getUint32(4, true);
    const species = dv.getUint16(28, true);
    const ivWord = dv.getUint32(54, true);
    const row = D.species[species];
    const evs = {};
    ["hp", "atk", "def", "spe", "spa", "spd"].forEach((key, index) => { evs[key] = bytes[44 + index]; });
    return {
      pid,
      otId,
      species,
      nickname: decodeText(bytes.slice(8, 18)),
      otName: decodeText(bytes.slice(20, 27)),
      language: bytes[18],
      tera: (bytes[19] >> 3) & 0x1f,
      ball: bytes[38],
      friendship: bytes[37],
      exp: dv.getUint32(32, true),
      heldItem: dv.getUint16(30, true),
      moves: global.AzothMonCodec.unpackMoves(bytes, 39),
      abilitySlot: (ivWord & 0x80000000) ? 2 : (pid & 1),
      nature: pid % 25,
      gender: row ? genderOf(pid, row[6]) : 0,
      shiny: shinyValue(pid, otId & 0xffff, otId >>> 16) < 16,
      ivs: {
        hp: ivWord & 31,
        atk: (ivWord >>> 5) & 31,
        def: (ivWord >>> 10) & 31,
        spe: (ivWord >>> 15) & 31,
        spa: (ivWord >>> 20) & 31,
        spd: (ivWord >>> 25) & 31,
      },
      evs,
    };
  }

  function levelForExp(species, exp) {
    const growth = D.species[species]?.[2] ?? 0;
    const table = D.exp[growth] || [];
    let level = 1;
    for (let i = 0; i < table.length; i++) {
      if (exp >= table[i]) level = i + 1;
      else break;
    }
    return level;
  }

  function abilityOptions(species) {    const row = D.species[species];
    if (!row) return [];
    const [, , , a0, a1, hidden] = row;
    const out = [];
    const push = (slot, id) => {
      if (!id) return;
      if (out.some((item) => item.slot === slot && item.id === id)) return;
      out.push({ slot, id, name: D.abilities[id]?.[1] || `#${id}` });
    };
    push(0, a0);
    push(1, a1);
    push(2, hidden);
    return out;
  }

  function buildMon(opt, templateRaw, charmap) {
    const row = D.species[opt.species];
    if (!row) throw new Error(`找不到物种 #${opt.species}`);
    const [, zh, growth, a0, a1, hidden, genderRatio, baseFriendship] = row;

    const template = Uint8Array.from(templateRaw);
    const otId = u32(template, 4);
    const tid = otId & 0xffff;
    const sid = otId >>> 16;

    const abilityId = opt.abilityId ?? (opt.abilitySlot === 2 ? hidden : opt.abilitySlot === 1 ? a1 : a0);
    let slot;
    if (abilityId === hidden && hidden) slot = 2;
    else if (abilityId === a0) slot = 0;
    else if (a1 && abilityId === a1) slot = 1;
    else throw new Error("该物种没有这个特性");

    const gender = opt.gender ?? genderOf(opt.pid ?? u32(template, 0), genderRatio);
    const nature = opt.nature ?? 0;
    const shiny = Boolean(opt.shiny);

    // Keep the existing PID when it already satisfies every constraint, so
    // editing a move does not rewrite bytes (and the SAV diff stays minimal).
    const currentPid = u32(template, 0);
    const currentOk = (currentPid % 25) === nature
      && genderOf(currentPid, genderRatio) === gender
      && (slot === 2 || !a1 || (currentPid & 1) === slot)
      && (shinyValue(currentPid, tid, sid) < 16) === shiny;

    const pid = currentOk ? currentPid : searchPid({
      nature,
      gender,
      slot,
      shiny,
      tid,
      sid,
      genderRatio,
      hasSecondAbility: a1 !== 0,
    });
    if (pid == null) throw new Error("找不到同时满足性格、性别、特性和闪光的 PID，请调整其中一个条件");

    const level = Math.max(1, Math.min(100, opt.level ?? 100));
    const exp = opt.exp ?? (D.exp[growth]?.[level - 1] ?? 0);
    const moves = (opt.moves || []).slice(0, 4);
    const ivs = opt.ivs;
    const evs = opt.evs;

    const raw = global.AzothMonCodec.apply(template, {
      species: opt.species,
      exp,
      heldItem: opt.heldItem ?? 0,
      moves,
      ivs,
      evs,
      nickname: opt.nickname || zh,
      hiddenAbility: slot === 2,
    }, { charmap });

    const dv = new DataView(raw.buffer);
    dv.setUint32(0, pid, true);
    raw[37] = opt.friendship ?? baseFriendship ?? 70;
    raw[38] = opt.ball ?? template[38] ?? 4;
    return { raw, pid, slot, exp, nature, gender, shiny };
  }

  global.AzothPmh1 = Object.freeze({
    data: D,
    decodeText,
    encodeText,
    lookup,
    lookupSpecies,
    lookupItem: (name) => lookup(itemIndex, name),
    lookupMove: (name) => lookup(moveIndex, name),
    lookupAbility: (name) => lookup(abilityIndex, name),
    lookupNature: (name) => lookup(natureIndex, name),
    lookupBall: (name) => lookup(ballIndex, name),
    moveList,
    speciesName: (id) => D.species[id]?.[1] || `#${id}`,
    moveName: (id) => D.moves[id]?.[1] || `#${id}`,
    itemName: (id) => D.items[id]?.[1] || `#${id}`,
    abilityName: (id) => D.abilities[id]?.[1] || `#${id}`,
    natureName: (id) => D.natures[id]?.[1] || `#${id}`,
    ballName: (id) => D.balls.find((ball) => ball[0] === id)?.[2] || `#${id}`,
    abilityOptions,
    levelForExp,
    genderChoices,
    genderOf,
    shinyValue,
    searchPid,
    readMon,
    buildMon,
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
