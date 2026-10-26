/* Pokémon Showdown text import.

   Adds an "导入 Showdown" button between the share-key button and the save
   button. Text is parsed as Showdown's export format; species / item / move
   names may be English or Chinese. Each parsed set is written into the first
   empty HOME slot.

   What is imported: species, held item, level, EVs, IVs, up to 4 moves, nickname.
   What is NOT imported: ability, nature, gender, shininess, Tera type. Those are
   derived from PID/OTID, which are copied from a template mon already in the
   boxes (so the new mon inherits the template's nature/gender/shininess).
*/
(function () {
  "use strict";

  const DIALOG = "azothShowdownDialog";
  const TEXT = "azothShowdownText";
  const ERROR = "azothShowdownError";
  const STAT_KEYS = ["hp", "atk", "def", "spa", "spd", "spe"];

  const bridge = () => window.AzothHomeInternal;
  const codec = () => window.AzothMonCodec;

  let moveNamesPromise = null;
  let indexes = null;

  function normalize(name) {
    return String(name ?? "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
  }

  function moveNames() {
    if (!moveNamesPromise) {
      moveNamesPromise = fetch("extras/data/moves-en.json")
        .then((response) => (response.ok ? response.json() : {}))
        .catch(() => ({}));
    }
    return moveNamesPromise;
  }

  function put(map, key, value) {
    const normalized = normalize(key);
    if (normalized && !map.has(normalized)) map.set(normalized, value);
  }

  async function buildIndexes() {
    if (indexes) return indexes;
    const game = bridge().gameData();
    const compat = bridge().compat();
    const englishMoves = await moveNames();

    const species = new Map();
    for (const [id, entry] of Object.entries(game.species || {})) {
      const number = Number(id);
      if (!number || !entry) continue;
      const macro = String(entry.macro || "").replace(/^SPECIES_/, "");
      if (macro) put(species, macro, number);
      if (entry.name) put(species, entry.name, number);
    }

    const moves = new Map();
    for (const [id, zh] of Object.entries(game.moves || {})) {
      const number = Number(id);
      if (!number) continue;
      if (zh) put(moves, zh, number);
      const en = englishMoves[id];
      if (en) put(moves, en, number);
    }

    const items = new Map();
    for (const [id, macro] of Object.entries(game.items || {})) {
      const number = Number(id);
      if (!number) continue;
      if (macro) put(items, macro, number);
      const zh = compat?.meta?.names?.items?.[id];
      if (zh) put(items, zh, number);
    }

    indexes = { species, moves, items };
    return indexes;
  }

  function statKey(name) {
    switch (name.toLowerCase()) {
      case "hp": return "hp";
      case "atk": return "atk";
      case "def": return "def";
      case "spa": case "spatk": case "satk": return "spa";
      case "spd": case "spdef": case "sdef": return "spd";
      case "spe": case "speed": return "spe";
      default: return null;
    }
  }

  function parseSpread(text) {
    const out = {};
    for (const part of text.split("/")) {
      const match = part.trim().match(/^(\d+)\s*([A-Za-z]+)$/);
      if (!match) continue;
      const key = statKey(match[2]);
      if (key) out[key] = Number(match[1]);
    }
    return out;
  }

  function parseOne(block) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return null;

    let head = lines[0];
    let itemName = "";
    const at = head.indexOf("@");
    if (at >= 0) {
      itemName = head.slice(at + 1).trim();
      head = head.slice(0, at).trim();
    }

    let nickname = "";
    const paren = head.match(/^(.*?)\s*\((.+)\)\s*$/);
    if (paren) {
      head = paren[1].trim();
      nickname = paren[2].trim();
    }
    if (!head) return null;

    const set = { speciesName: head, itemName, nickname, level: 100, moves: [], ivs: {}, evs: {} };
    for (const line of lines.slice(1)) {
      let match;
      if ((match = line.match(/^Level:\s*(\d+)/i))) set.level = Number(match[1]);
      else if ((match = line.match(/^EVs:\s*(.+)/i))) set.evs = parseSpread(match[1]);
      else if ((match = line.match(/^IVs:\s*(.+)/i))) set.ivs = parseSpread(match[1]);
      else if ((match = line.match(/^-\s*(.+)$/))) set.moves.push(match[1].trim());
    }
    return set;
  }

  function parseText(text) {
    return text.replace(/\r/g, "").split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean)
      .map(parseOne).filter(Boolean);
  }

  function templateMon() {
    const lengths = (mon) => mon && Array.isArray(mon.raw) && mon.raw.length === 58;
    for (const box of bridge().getHomeBoxes()) {
      for (const mon of box) if (lengths(mon)) return mon;
    }
    const sav = bridge().getSavBoxes();
    if (sav) {
      for (const box of sav) {
        for (const mon of box) if (lengths(mon)) return mon;
      }
    }
    return null;
  }

  function toRaw(set, index, template) {
    const game = bridge().gameData();
    const api = codec();

    const species = index.species.get(normalize(set.speciesName));
    if (!species) throw new Error(`找不到物种：${set.speciesName}`);

    const heldItem = set.itemName ? (index.items.get(normalize(set.itemName)) || 0) : 0;
    const moves = [];
    for (const name of set.moves.slice(0, 4)) {
      const move = index.moves.get(normalize(name));
      if (!move) throw new Error(`找不到招式：${name}`);
      moves.push(move);
    }

    const level = Math.max(1, Math.min(100, set.level || 100));
    const exp = api.expForLevel(game, species, level);
    if (exp == null) throw new Error("无法计算经验值");

    const ivs = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };
    for (const key of STAT_KEYS) if (set.ivs[key] != null) ivs[key] = Math.max(0, Math.min(31, set.ivs[key]));
    const evs = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
    for (const key of STAT_KEYS) if (set.evs[key] != null) evs[key] = Math.max(0, Math.min(255, set.evs[key]));
    if (STAT_KEYS.reduce((sum, key) => sum + evs[key], 0) > 510) throw new Error("努力值总和超过 510");

    const nickname = set.nickname || game.species[String(species)]?.name || "";
    return {
      raw: api.apply(template.raw, { species, exp, heldItem, moves, ivs, evs, nickname }, { charmap: bridge().charmap() }),
      name: nickname,
    };
  }

  function firstEmpty() {
    const boxes = bridge().getHomeBoxes();
    for (let box = 0; box < boxes.length; box++) {
      for (let slot = 0; slot < boxes[box].length; slot++) {
        if (!boxes[box][slot]) return { box, slot };
      }
    }
    return null;
  }

  function importText(text) {
    const sets = parseText(text);
    if (!sets.length) throw new Error("没有解析到宝可梦");

    const template = templateMon();
    if (!template) throw new Error("HOME 里没有可用的模板个体。请先读取存档，或先在 HOME 放一只宝可梦。");

    const indexesReady = indexes;
    const imported = [];
    const failed = [];
    for (const set of sets) {
      try {
        const built = toRaw(set, indexesReady, template);
        const target = firstEmpty();
        if (!target) throw new Error("HOME 箱子已满");
        bridge().replaceHomeMon(target.box, target.slot, built.raw);
        imported.push({ ...target, name: built.name });
      } catch (error) {
        failed.push(`${set.speciesName}：${error.message}`);
      }
    }

    if (imported.length) bridge().goHomeBox(imported[0].box);
    return { imported, failed };
  }

  function close() {
    document.getElementById(DIALOG)?.remove();
  }

  function open() {
    close();
    const dialog = document.createElement("dialog");
    dialog.id = DIALOG;
    dialog.className = "azoth-showdown";
    dialog.innerHTML = `
      <form method="dialog">
        <header>
          <div>
            <h2>导入 Showdown</h2>
            <p>把 Showdown 导出的文本粘进来，可一次多只（空行分隔）。</p>
          </div>
          <button type="button" class="azoth-editor-close" data-action="cancel" aria-label="关闭">×</button>
        </header>
        <textarea id="${TEXT}" rows="12" spellcheck="false" placeholder="Pikachu @ Light Ball
Level: 50
EVs: 252 SpA / 4 SpD / 252 Spe
IVs: 0 Atk
- Thunderbolt
- Surf
- Hidden Power Ice
- Volt Switch"></textarea>
        <p class="azoth-editor-note">
          识别物种、道具、等级、EVs、IVs、招式和昵称，名称支持中英文。
          特性、性格、性别、闪光不会导入——新个体沿用模板个体的 PID。
        </p>
        <p class="azoth-editor-error" id="${ERROR}" role="alert"></p>
        <footer>
          <button type="button" data-action="cancel">取消</button>
          <button type="button" data-action="import" class="primary">导入到 HOME</button>
        </footer>
      </form>`;
    document.body.appendChild(dialog);
    dialog.showModal();

    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) { dialog.close(); return; }
      const action = event.target.closest("[data-action]")?.dataset.action;
      if (action === "cancel") dialog.close();
      if (action !== "import") return;

      const errorNode = document.getElementById(ERROR);
      try {
        const result = importText(document.getElementById(TEXT).value);
        const parts = [];
        if (result.imported.length) parts.push(`已导入 ${result.imported.length} 只`);
        if (result.failed.length) parts.push(`${result.failed.length} 只失败：${result.failed.join("；")}`);
        bridge().notify(parts.join("；") + "。点“保存 HOME 和 SAV”写入存档。");
        if (!result.failed.length) dialog.close();
        else if (errorNode) errorNode.textContent = result.failed.join("；");
      } catch (error) {
        if (errorNode) errorNode.textContent = error.message;
      }
    });
    dialog.addEventListener("close", () => dialog.remove());
    dialog.querySelector("form").addEventListener("submit", (event) => event.preventDefault());
  }

  function addButton() {
    if (document.getElementById("azothShowdownBtn")) return;
    const anchor = document.getElementById("importMonBtn");
    if (!anchor) return;
    const button = document.createElement("button");
    button.type = "button";
    button.id = "azothShowdownBtn";
    button.className = "import-btn";
    button.textContent = "导入 Showdown";
    button.addEventListener("click", open);
    anchor.after(button);
  }

  async function boot() {
    const started = Date.now();
    while (!window.AzothHomeInternal) {
      if (Date.now() - started > 30000) throw new Error("bridge did not appear");
      await new Promise((done) => setTimeout(done, 50));
    }
    await (window.homeBrowserReady || Promise.resolve());
    await buildIndexes();
    addButton();
  }

  boot().catch((error) => console.error("[azoth-home] showdown import failed", error));
})();
