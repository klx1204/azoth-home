/* Pokémon Showdown text import.

   Adds an "导入 Showdown" button between the share-key button and the save
   button. Each parsed set becomes a 58-byte mon written into the first empty
   HOME slot.

   Imported: species, nickname, held item, ability, level, nature, gender,
   shininess, ball, EVs, IVs, up to 4 moves.

   Everything is built on a template mon already in the boxes, so OT name, OTID,
   language and tera type are inherited from that template.
*/
(function () {
  "use strict";

  const DIALOG = "azothShowdownDialog";
  const TEXT = "azothShowdownText";
  const ERROR = "azothShowdownError";
  const STAT_KEYS = ["hp", "atk", "def", "spa", "spd", "spe"];

  const bridge = () => window.AzothHomeInternal;
  const pmh1 = () => window.AzothPmh1;

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

  function parseSet(block) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return null;

    let head = lines[0];
    let itemName = "";
    const at = head.indexOf("@");
    if (at >= 0) {
      itemName = head.slice(at + 1).trim();
      head = head.slice(0, at).trim();
    }

    let speciesName = head;
    let nickname = "";
    let gender = null;
    const paren = head.match(/^(.*?)\s*\((.+?)\)\s*$/);
    if (paren) {
      const inner = paren[2].trim();
      if (/^(m|male|雄|公)$/i.test(inner)) { speciesName = paren[1].trim(); gender = 0; }
      else if (/^(f|female|雌|母)$/i.test(inner)) { speciesName = paren[1].trim(); gender = 1; }
      else if (pmh1().lookupSpecies(inner)) { nickname = paren[1].trim(); speciesName = inner; }
      else { speciesName = paren[1].trim(); nickname = inner; }
    }
    if (!speciesName) return null;

    const set = {
      speciesName, itemName, nickname, gender,
      abilityName: "", natureName: "", ballName: "",
      level: 100, shiny: false, moves: [], ivs: {}, evs: {},
    };

    for (const line of lines.slice(1)) {
      let match;
      if (/Nature$/i.test(line) && !line.includes(":")) {
        set.natureName = line.replace(/\s*Nature$/i, "").trim();
      } else if ((match = line.match(/^Ability:\s*(.+)/i))) set.abilityName = match[1].trim();
      else if ((match = line.match(/^Level:\s*(\d+)/i))) set.level = Number(match[1]);
      else if ((match = line.match(/^Shiny:\s*(.+)/i))) set.shiny = /^(yes|true|1|是|闪光)$/i.test(match[1].trim());
      else if ((match = line.match(/^Gender:\s*(.+)/i))) {
        const value = match[1].trim();
        if (/^(m|male|雄|公)$/i.test(value)) set.gender = 0;
        else if (/^(f|female|雌|母)$/i.test(value)) set.gender = 1;
      } else if ((match = line.match(/^Ball:\s*(.+)/i))) set.ballName = match[1].trim();
      else if ((match = line.match(/^EVs:\s*(.+)/i))) set.evs = parseSpread(match[1]);
      else if ((match = line.match(/^IVs:\s*(.+)/i))) set.ivs = parseSpread(match[1]);
      else if ((match = line.match(/^-\s*(.+)$/))) set.moves.push(match[1].trim());
    }
    return set;
  }

  function parseText(text) {
    return text.replace(/\r/g, "").split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean)
      .map(parseSet).filter(Boolean);
  }

  function templateMon() {
    const ok = (mon) => mon && Array.isArray(mon.raw) && mon.raw.length === 58;
    for (const box of bridge().getHomeBoxes()) {
      for (const mon of box) if (ok(mon)) return mon;
    }
    const sav = bridge().getSavBoxes();
    if (sav) {
      for (const box of sav) {
        for (const mon of box) if (ok(mon)) return mon;
      }
    }
    return null;
  }

  function buildFromSet(set, template) {
    const api = pmh1();
    const species = api.lookupSpecies(set.speciesName);
    if (!species) throw new Error(`找不到物种：${set.speciesName}`);

    const row = api.data.species[species];
    const [en, zh, growth, a0, a1, hidden, genderRatio, baseFriendship] = row;

    let abilityId = a0;
    if (set.abilityName) {
      abilityId = api.lookupAbility(set.abilityName);
      if (abilityId == null) throw new Error(`找不到特性：${set.abilityName}`);
      if (![a0, a1, hidden].includes(abilityId)) throw new Error(`${zh} 没有特性「${set.abilityName}」`);
    }

    const nature = set.natureName ? api.lookupNature(set.natureName) : 0;
    if (nature == null) throw new Error(`找不到性格：${set.natureName}`);

    let gender = set.gender;
    if (gender == null) {
      if (genderRatio === 255) gender = 2;
      else if (genderRatio === 254) gender = 1;
      else if (genderRatio === 0) gender = 0;
      else gender = genderRatio >= 128 ? 1 : 0;
    }

    const ball = set.ballName ? api.lookupBall(set.ballName) : (template.raw ? template.raw[38] || 4 : 4);
    if (ball == null) throw new Error(`找不到球种：${set.ballName}`);

    const heldItem = set.itemName ? api.lookupItem(set.itemName) : 0;
    if (heldItem == null) throw new Error(`找不到道具：${set.itemName}`);

    const moves = set.moves.slice(0, 4).map((name) => {
      const id = api.lookupMove(name);
      if (id == null) throw new Error(`找不到招式：${name}`);
      return id;
    });

    const ivs = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };
    for (const key of STAT_KEYS) if (set.ivs[key] != null) ivs[key] = Math.max(0, Math.min(31, set.ivs[key]));
    const evs = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
    for (const key of STAT_KEYS) if (set.evs[key] != null) evs[key] = Math.max(0, Math.min(255, set.evs[key]));
    if (STAT_KEYS.reduce((sum, key) => sum + evs[key], 0) > 510) throw new Error("努力值总和超过 510");

    const nickname = set.nickname || (zh || "");
    const level = Math.max(1, Math.min(100, set.level || 100));

    const built = api.buildMon({
      species,
      level,
      nature,
      gender,
      shiny: set.shiny,
      abilityId,
      ball,
      heldItem,
      moves,
      ivs,
      evs,
      nickname,
      friendship: baseFriendship,
    }, template.raw, bridge().charmap());

    return { raw: built.raw, name: nickname || zh };
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

    const imported = [];
    const failed = [];
    for (const set of sets) {
      try {
        const built = buildFromSet(set, template);
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
Ability: Static
Level: 50
Timid Nature
Shiny: Yes
Gender: F
Ball: Great Ball
EVs: 252 SpA / 4 SpD / 252 Spe
IVs: 0 Atk
- Thunderbolt
- Surf
- Hidden Power Ice
- Volt Switch"></textarea>
        <p class="azoth-editor-note">
          识别物种、昵称、道具、特性、等级、性格、性别、闪光、球种、EVs、IVs 和招式，名称支持中英文。
          训练家信息（OT 名、表里 ID、语言）沿用模板个体。
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
    while (!window.AzothHomeInternal || !window.AzothPmh1) {
      if (Date.now() - started > 30000) throw new Error("editor modules did not appear");
      await new Promise((done) => setTimeout(done, 50));
    }
    await (window.homeBrowserReady || Promise.resolve());
    addButton();
  }

  boot().catch((error) => console.error("[azoth-home] showdown import failed", error));
})();
