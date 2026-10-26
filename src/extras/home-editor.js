/* In-page Pokemon editor for 水银 HOME.

   Runs outside upstream's closure. It talks to the page only through
   window.AzothHomeInternal (injected bridge) and window.AzothMonCodec, and it
   never replaces the upstream markup: it watches #detail and appends one extra
   action button.

   Supported: species, level, held item, 4 moves, IVs, EVs, nickname, hidden
   ability slot. PID-derived traits (nature, gender, shininess) stay read-only
   because changing them means rewriting PID/OTID.
*/
(function () {
  "use strict";

  const IDS = {
    dialog: "azothEditorDialog",
    nickname: "azothEditorNickname",
    level: "azothEditorLevel",
    species: "azothEditorSpecies",
    item: "azothEditorItem",
    hidden: "azothEditorHidden",
    moveSearch: "azothEditorMoveSearch",
    error: "azothEditorError",
  };

  const IV_KEYS = ["hp", "atk", "def", "spe", "spa", "spd"];
  const EV_KEYS = ["hp", "atk", "def", "spe", "spa", "spd"];
  const LABELS = { hp: "HP", atk: "攻击", def: "防御", spe: "速度", spa: "特攻", spd: "特防" };
  const MOVE_SLOTS = 4;

  let optionCache = new Map();

  const bridge = () => window.AzothHomeInternal;
  const codec = () => window.AzothMonCodec;

  function el(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[char]));
  }

  function notify(text) {
    bridge().notify(text);
  }

  function rowsFor(kind, game) {
    const cached = optionCache.get(kind);
    if (cached) return cached;
    const rows = [];
    if (kind === "species") {
      for (const [id, entry] of Object.entries(game.species || {})) {
        const n = Number(id);
        if (!n || !entry) continue;
        rows.push([n, entry.name || `#${n}`]);
      }
    } else {
      for (const [id, name] of Object.entries(game[kind] || {})) {
        const n = Number(id);
        if (!n) continue;
        rows.push([n, name || `#${n}`]);
      }
    }
    rows.sort((a, b) => a[0] - b[0]);
    optionCache.set(kind, rows);
    return rows;
  }

  function optionsFor(kind, selected, noneLabel) {
    const game = bridge().gameData();
    const rows = rowsFor(kind, game);
    const parts = [];
    if (noneLabel != null) {
      parts.push(`<option value="0"${selected ? "" : " selected"}>${escapeHtml(noneLabel)}</option>`);
    }
    for (const [id, name] of rows) {
      parts.push(`<option value="${id}"${id === selected ? " selected" : ""}>${escapeHtml(name)}</option>`);
    }
    return parts.join("");
  }

  function filterSelect(select, query) {
    const needle = query.trim().toLowerCase();
    for (const option of select.options) {
      if (option.value === "0") continue;
      option.hidden = Boolean(needle) && !option.textContent.toLowerCase().includes(needle);
    }
  }

  function statInputs(prefix, values, max, keys) {
    return keys.map((key) => `
      <label class="azoth-editor-stat">
        <span>${LABELS[key]}</span>
        <input type="number" min="0" max="${max}" step="1" data-key="${key}"
               id="${prefix}_${key}" value="${values[key] | 0}">
      </label>`).join("");
  }

  function closeEditor() {
    const dialog = el(IDS.dialog);
    if (dialog) dialog.remove();
  }

  function openEditor() {
    const bridgeApi = bridge();
    const detail = bridgeApi.getLastDetail();
    if (!detail) {
      notify("请先点击盒子里的宝可梦，再点“编辑”。");
      return;
    }
    const mon = detail.mon;
    if (mon.format === "decomp") {
      notify("新版对战塔个体（61 字节）暂不支持编辑，请先移入 HOME 后再编辑。");
      return;
    }
    if (!window.AzothMonCodec) {
      notify("编辑器未加载，请刷新页面重试。");
      return;
    }

    closeEditor();

    const game = bridgeApi.gameData();
    const fields = codec().read(mon.raw);
    const level = codec().levelForExp(game, fields.species, fields.exp) || mon.level || 1;
    const name = bridgeApi.compat().displayName("species", fields.species, mon) || `#${fields.species}`;

    const moves = [0, 1, 2, 3].map((i) => fields.moves[i] || 0);
    const moveSelects = moves.map((move, i) => `
      <label class="azoth-editor-row">
        <span>招式 ${i + 1}</span>
        <select id="azothEditorMove${i}" data-slot="${i}">
          ${optionsFor("moves", move, "（空）")}
        </select>
      </label>`).join("");

    const dialog = document.createElement("dialog");
    dialog.id = IDS.dialog;
    dialog.className = "azoth-editor";
    dialog.innerHTML = `
      <form method="dialog" autocomplete="off">
        <header>
          <div>
            <h2>编辑 · ${escapeHtml(name)}</h2>
            <p>${detail.label === "HOME" ? "HOME 个体：保存后立即写入浏览器本地。" : "SAV 个体：需再点顶部“保存 HOME 和 SAV”才写回存档。"}</p>
          </div>
          <button type="button" class="azoth-editor-close" data-action="cancel" aria-label="关闭">×</button>
        </header>

        <div class="azoth-editor-grid">
          <label class="azoth-editor-row">
            <span>物种</span>
            <input type="search" id="azothEditorSpeciesSearch" placeholder="搜索物种…">
            <select id="${IDS.species}">${optionsFor("species", fields.species, null)}</select>
          </label>

          <label class="azoth-editor-row">
            <span>等级</span>
            <input type="number" id="${IDS.level}" min="1" max="100" step="1" value="${level}">
          </label>

          <label class="azoth-editor-row">
            <span>携带道具</span>
            <input type="search" id="azothEditorItemSearch" placeholder="搜索道具…">
            <select id="${IDS.item}">${optionsFor("items", fields.heldItem, "（无）")}</select>
          </label>

          <label class="azoth-editor-row">
            <span>昵称</span>
            <input type="text" id="${IDS.nickname}" maxlength="12" value="${escapeHtml(mon.nickname || "")}"
                   placeholder="留空则不修改">
            <small>最多 9 字节（约 4～5 个全角字），超出会被截断。</small>
          </label>

          <div class="azoth-editor-row">
            <span>招式</span>
            <input type="search" id="${IDS.moveSearch}" placeholder="搜索招式…">
            ${moveSelects}
          </div>

          <div class="azoth-editor-row">
            <span>个体值 <small>0–31</small></span>
            <div class="azoth-editor-stats">${statInputs("azothEditorIv", fields.ivs, 31, IV_KEYS)}</div>
          </div>

          <div class="azoth-editor-row">
            <span>努力值 <small>0–255，总和 ≤ 510</small></span>
            <div class="azoth-editor-stats">${statInputs("azothEditorEv", fields.evs, 255, EV_KEYS)}</div>
          </div>

          <label class="azoth-editor-check">
            <input type="checkbox" id="${IDS.hidden}"${fields.hiddenAbility ? " checked" : ""}>
            <span>梦特槽（写入 IV 字的最高位）</span>
          </label>

          <p class="azoth-editor-note">
            性格、性别、闪光由 PID / OTID 决定，这里只读。特性槽切换请用上方“梦特槽”，
            普通两槽的互换需要重算 PID，暂不提供。
          </p>
          <p class="azoth-editor-error" id="${IDS.error}" role="alert"></p>
        </div>

        <footer>
          <button type="button" data-action="cancel">取消</button>
          <button type="button" data-action="save" class="primary">保存修改</button>
        </footer>
      </form>`;

    document.body.appendChild(dialog);
    dialog.showModal();

    const speciesSelect = el(IDS.species);
    const itemSelect = el(IDS.item);
    const moveSelectsEls = [0, 1, 2, 3].map((i) => el(`azothEditorMove${i}`));

    el("azothEditorSpeciesSearch").addEventListener("input", (event) => {
      filterSelect(speciesSelect, event.target.value);
    });
    el("azothEditorItemSearch").addEventListener("input", (event) => {
      filterSelect(itemSelect, event.target.value);
    });
    el(IDS.moveSearch).addEventListener("input", (event) => {
      for (const select of moveSelectsEls) filterSelect(select, event.target.value);
    });

    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
      const action = event.target.closest("[data-action]")?.dataset.action;
      if (action === "cancel") dialog.close();
      if (action === "save") save(dialog, mon, detail);
    });
    dialog.addEventListener("close", () => dialog.remove());
    dialog.querySelector("form").addEventListener("submit", (event) => event.preventDefault());
  }

  function readStats(prefix, keys) {
    const values = {};
    for (const key of keys) {
      const input = el(`${prefix}_${key}`);
      const value = Number(input.value);
      if (!Number.isInteger(value)) throw new Error(`${LABELS[key]} 的数值无效`);
      if (value < Number(input.min) || value > Number(input.max)) {
        throw new Error(`${LABELS[key]} 必须在 ${input.min}–${input.max} 之间`);
      }
      values[key] = value;
    }
    return values;
  }

  function save(dialog, mon, detail) {
    const errorNode = el(IDS.error);
    try {
      const bridgeApi = bridge();
      const codecApi = codec();
      const game = bridgeApi.gameData();

      const species = Number(el(IDS.species).value);
      const level = Number(el(IDS.level).value);
      if (!Number.isInteger(level) || level < 1 || level > 100) throw new Error("等级必须在 1–100 之间");

      const exp = codecApi.expForLevel(game, species, level);
      if (exp == null) throw new Error("无法用当前物种的经验表计算该等级，请检查物种");

      const moves = [0, 1, 2, 3].map((i) => Number(el(`azothEditorMove${i}`).value) || 0);
      const ivs = readStats("azothEditorIv", IV_KEYS);
      const evs = readStats("azothEditorEv", EV_KEYS);
      const evTotal = EV_KEYS.reduce((sum, key) => sum + evs[key], 0);
      if (evTotal > 510) throw new Error(`努力值总和 ${evTotal} 超过 510`);

      const patch = {
        species,
        heldItem: Number(el(IDS.item).value) || 0,
        exp,
        moves,
        ivs,
        evs,
        hiddenAbility: el(IDS.hidden).checked,
      };

      const nickname = el(IDS.nickname).value.trim();
      if (nickname) {
        const used = codecApi.nicknameBytes(nickname, bridgeApi.charmap());
        if (used > 9) throw new Error("昵称过长，请缩短到 9 字节以内");
        patch.nickname = nickname;
      }

      const raw = codecApi.apply(mon.raw, patch, { charmap: bridgeApi.charmap() });
      const next = bridgeApi.updateMon(mon, raw);
      bridgeApi.showDetail(next, detail.label);
      dialog.close();

      const scope = detail.label === "HOME" ? "HOME 已保存" : "SAV 待保存";
      bridgeApi.notify(`已修改 ${bridgeApi.speciesName(next)}（Lv.${level}）。${scope}；SAV 请点“保存 HOME 和 SAV”后生效。`);
    } catch (error) {
      if (errorNode) errorNode.textContent = error.message;
    }
  }

  function editButton() {
    const button = document.createElement("button");
    button.type = "button";
    button.id = "azothEditBtn";
    button.className = "azoth-edit-btn";
    button.textContent = "编辑这只宝可梦";
    button.addEventListener("click", openEditor);
    return button;
  }

  function injectInto(detail) {
    if (!detail.querySelector(".detail-body")) return;
    if (detail.querySelector("#azothEditBtn")) return;
    const actions = detail.querySelector(".detail-actions");
    if (!actions) return;
    const current = bridge().getLastDetail();
    if (!current) return;
    actions.appendChild(editButton());
  }

  function watchDetail() {
    const detail = document.getElementById("detail");
    if (!detail) return;
    new MutationObserver(() => injectInto(detail)).observe(detail, { childList: true, subtree: true });
    injectInto(detail);
  }

  async function waitForBridge(timeout = 30000) {
    const started = Date.now();
    while (!window.AzothHomeInternal) {
      if (Date.now() - started > timeout) throw new Error("bridge did not appear");
      await new Promise((done) => setTimeout(done, 50));
    }
    return window.AzothHomeInternal;
  }

  async function boot() {
    await waitForBridge();
    await (window.homeBrowserReady || Promise.resolve());
    watchDetail();
    document.documentElement.dataset.azothHomeEditor = "1";
    console.info("[azoth-home] editor ready");
  }

  boot().catch((error) => console.error("[azoth-home] editor failed", error));
})();
