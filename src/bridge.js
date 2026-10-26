/* azoth-home bridge.

   Injected by scripts/build.py immediately before the upstream IIFE closes, so
   this is the only local file that runs inside upstream's closure. Keep it
   small: everything else lives in src/extras/ and goes through this object.

   Contract (version 1) — all getters return live references, do not mutate them
   outside of the update helpers.
*/
let azothLastDetail = null;
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
