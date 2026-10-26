/* azoth-home bridge.

   Injected by scripts/build.py immediately before the upstream IIFE closes, so
   this is the only local file that runs inside upstream's closure. Keep it
   small: everything else lives in src/extras/ and goes through this object.

   Contract (version 1) — all getters return live references, do not mutate them
   outside of the update helpers.
*/
let azothLastDetail = null;
const AZOTH_PARTY_OFFSET = 0x3c;
const AZOTH_PARTY_SIZE = 100;
const azothUpstreamShowDetail = showDetail;
showDetail = function (mon, label) {
  azothLastDetail = mon ? { mon, label } : null;
  return azothUpstreamShowDetail(mon, label);
};

window.AzothHomeInternal = Object.freeze({
  version: 1,

  constants: Object.freeze({
    BOX_MON_SIZE,
    BOX_CAPACITY,
    HOME_BOXES,
    HOME_KEY,
    STORAGE_BOXES,
  }),

  compat: () => compat,
  gameData: () => gameData,
  charmap: () => (gameData ? gameData.charmap : null),

  getHomeBoxes: () => homeBoxes,
  getHomeBoxIndex: () => homeBoxIndex,
  getSavBoxes: () => (currentSave ? currentSave.boxes : null),
  getSavBoxIndex: () => savBoxIndex,
  getSave: () => currentSave,
  getBuffer: () => currentSaveBuffer,

  getLastDetail: () => azothLastDetail,
  getSelectedRef: () => (selectedRef ? { ...selectedRef } : null),

  /* Party lives in SaveBlock1 at 0x3C: six 100-byte records, the first 58 bytes
     of each reusing the box-mon layout. Only the FC (58-byte) format is
     supported; the decomp format keeps party data elsewhere. */
  getParty() {
    if (!currentSave || currentSave.format !== "fc" || !currentSlot) return null;
    const section = currentSlot.sections && currentSlot.sections[1];
    if (!section) return null;
    const view = new DataView(section.buffer, section.byteOffset, section.byteLength);
    const party = [];
    for (let index = 0; index < 6; index++) {
      const at = AZOTH_PARTY_OFFSET + index * AZOTH_PARTY_SIZE;
      const mon = parseBoxMonCfru(section.slice(at, at + BOX_MON_SIZE));
      if (!mon || !mon.species) break;
      party.push({
        ...mon,
        partyIndex: index,
        level: section[at + 0x50] || mon.level,
        hp: u16(view, at + 0x52),
        maxHp: u16(view, at + 0x54),
      });
    }
    return party;
  },

  /* Party edits are restricted to fields that do not feed the battle stats:
     species, EXP, IVs, EVs, PID and OTID must stay identical, otherwise the
     stored level/HP would disagree with the game's calculations. */
  updatePartyMon(index, raw) {
    if (!currentSave || currentSave.format !== "fc" || !currentSlot) {
      throw new Error("当前存档不支持队伍编辑（仅水银 FC 格式）");
    }
    const section = currentSlot.sections && currentSlot.sections[1];
    if (!section) throw new Error("找不到存档的队伍区");
    if (!Number.isInteger(index) || index < 0 || index >= 6) throw new Error("队伍槽位无效");

    const at = AZOTH_PARTY_OFFSET + index * AZOTH_PARTY_SIZE;
    const before = parseBoxMonCfru(section.slice(at, at + BOX_MON_SIZE));
    if (!before || !before.species) throw new Error("该队伍槽位没有宝可梦");
    const after = parseBoxMonCfru(raw);
    if (!after || !after.species) throw new Error("编码结果无效，未写入");

    const locked = ["species", "exp", "personality", "otId"];
    for (const key of locked) {
      if (before[key] !== after[key]) throw new Error("队伍中的个体不能修改物种、等级或 PID");
    }
    for (const key of ["hp", "atk", "def", "spe", "spa", "spd"]) {
      if (before.ivs[key] !== after.ivs[key]) throw new Error("队伍中的个体不能修改个体值");
      if (before.evs[key] !== after.evs[key]) throw new Error("队伍中的个体不能修改努力值");
    }

    section.set(Uint8Array.from(raw).slice(0, BOX_MON_SIZE), at);
    return { ...after, partyIndex: index };
  },

  parseMon: (raw) => parseBoxMonCfru(raw),
  cloneMon: (mon) => cloneMon(mon),
  isSupportedSpecies: (mon) => isSupportedSpecies(mon),
  speciesName: (mon) => getSpeciesName(mon),
  showDetail: (mon, label) => showDetail(mon, label),

  /* Replace a mon by object identity (as handed to showDetail). Returns the new
     mon. HOME edits are persisted to localStorage immediately; SAV edits live in
     memory until the user saves the SAV. */
  updateMon(target, raw) {
    const next = parseBoxMonCfru(raw);
    if (!next || !next.species) throw new Error("编码结果无效，未写入");

    for (let box = 0; box < homeBoxes.length; box++) {
      const slots = homeBoxes[box];
      for (let slot = 0; slot < slots.length; slot++) {
        if (slots[slot] !== target) continue;
        slots[slot] = cloneMon(next);
        renderHomeBox();
        saveHomeBoxes(homeBoxes);
        return slots[slot];
      }
    }

    if (currentSave) {
      for (let box = 0; box < currentSave.boxes.length; box++) {
        const list = currentSave.boxes[box];
        for (let i = 0; i < list.length; i++) {
          if (list[i] !== target) continue;
          list[i] = { ...next, box, slot: list[i].slot };
          renderSavBox();
          return list[i];
        }
      }
    }

    throw new Error("找不到该个体，请重新点击格子后再编辑");
  },

  replaceHomeMon(box, slot, raw) {
    if (!Array.isArray(homeBoxes[box]) || slot < 0 || slot >= BOX_CAPACITY) {
      throw new Error("HOME 槽位不存在");
    }
    const mon = parseBoxMonCfru(raw);
    if (!mon || !mon.species) throw new Error("编码结果无效，未写入");
    homeBoxes[box][slot] = cloneMon(mon);
    renderHomeBox();
    saveHomeBoxes(homeBoxes);
    return homeBoxes[box][slot];
  },

  replaceSavMon(box, slot, raw) {
    if (!currentSave || !Array.isArray(currentSave.boxes[box])) {
      throw new Error("尚未读取 SAV");
    }
    const list = currentSave.boxes[box];
    const index = list.findIndex((mon) => mon.slot === slot);
    if (index < 0) throw new Error("该 SAV 槽位没有宝可梦");
    const mon = parseBoxMonCfru(raw);
    if (!mon || !mon.species) throw new Error("编码结果无效，未写入");
    list[index] = { ...mon, box, slot };
    renderSavBox();
    return list[index];
  },

  goHomeBox(index) {
    homeBoxIndex = Math.max(0, Math.min(HOME_BOXES - 1, index | 0));
    renderHomeBox();
  },

  goSavBox(index) {
    const count = currentSave ? currentSave.boxes.length : STORAGE_BOXES;
    savBoxIndex = Math.max(0, Math.min(count - 1, index | 0));
    renderSavBox();
  },

  notify(text) {
    $("summary").textContent = text;
  },
});
