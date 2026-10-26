/* In-page Pokemon editor for 水银 HOME.

   Runs outside upstream's closure. It talks to the page only through
   window.AzothHomeInternal (injected bridge) and window.AzothMonCodec, and it
   never replaces the upstream markup: it watches #detail and appends one extra
   action button.

   Supported: level, held item, 4 moves, IVs, EVs, nickname. Species, nature,
   gender, shininess and ability stay read-only (PID/OTID derived). Party
   members additionally lock level/IV/EV because their battle stats live in the
   save and would go stale.
*/
(function () {
  "use strict";

  const IDS = {
    dialog: "azothEditorDialog",
    nickname: "azothEditorNickname",
    level: "azothEditorLevel",
    item: "azothEditorItem",
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

  /* Items have a Chinese name in compat.meta.names.items and an English macro in
     gameData.items, so the option shows both and the filter matches either.
     Moves only ship Chinese names upstream; the id is appended so a numeric
     search still works. */
  function displayLabel(kind, id) {
    const key = String(id);
    if (kind === "items") {
      const zh = bridge().compat()?.meta?.names?.items?.[key];
      const en = bridge().gameData()?.items?.[key];
      if (zh && en && zh !== en) return `${zh}（${en}）`;
      return zh || en || `#${id}`;
    }
    if (kind === "moves") {
      const zh = bridge().gameData()?.moves?.[key];
      return zh ? `${zh}（#${id}）` : `#${id}`;
    }
    return `#${id}`;
  }

  function rowsFor(kind) {
    const cached = optionCache.get(kind);
    if (cached) return cached;
    const game = bridge().gameData();
    const rows = [];
    const table = kind === "items" ? game.items : game.moves;
    for (const id of Object.keys(table || {})) {
      const n = Number(id);
      if (!n) continue;
      rows.push([n, displayLabel(kind, n)]);
    }
    rows.sort((a, b) => a[0] - b[0]);
    optionCache.set(kind, rows);
    return rows;
  }

  function optionsFor(kind, selected, noneLabel) {
    const rows = rowsFor(kind);
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

  function statInputs(prefix, values, max, keys, disabled = false) {
    return keys.map((key) => `
      <label class="azoth-editor-stat">
        <span>${LABELS[key]}</span>
        <input type="number" min="0" max="${max}" step="1" data-key="${key}"
               id="${prefix}_${key}" value="${values[key] | 0}"${disabled ? " disabled" : ""}>
      </label>`).join("");
  }

  function closeEditor() {
    const dialog = el(IDS.dialog);
    if (dialog) dialog.remove();
  }

  function partyBar() {
    let bar = document.getElementById("azothPartyBar");
    if (bar) return bar;
    const main = document.querySelector("main.home-layout");
    if (!main || !main.parentNode) return null;
    bar = document.createElement("section");
    bar.id = "azothPartyBar";
    bar.className = "azoth-party";
    bar.hidden = true;
    bar.innerHTML = `
      <div class="azoth-party-head"><strong>队伍</strong><span id="azothPartyCount"></span></div>
      <div class="azoth-party-slots" id="azothPartySlots"></div>`;
    main.prepend(bar);
    return bar;
  }

  function renderParty() {
    const bar = partyBar();
    if (!bar) return;
    const bridgeApi = bridge();
    const party = bridgeApi.getParty ? bridgeApi.getParty() : null;
    if (!party || !party.length) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    const current = bridgeApi.getLastDetail();
    const active = current?.mon?.azothPartyIndex;
    const count = el("azothPartyCount");
    if (count) count.textContent = `${party.length} / 6`;

    const slots = el("azothPartySlots");
    if (!slots) return;
    slots.replaceChildren(...party.map((mon, index) => {
      const data = bridgeApi.compat().displaySpecies(mon);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "azoth-party-slot";
      if (mon.shiny) button.classList.add("shiny");
      if (index === active) button.classList.add("selected");
      const image = document.createElement("img");
      image.src = data.icon || data.front || "";
      image.alt = data.name || `Species ${mon.species}`;
      const level = document.createElement("span");
      level.className = "azoth-party-level";
      level.textContent = `Lv.${mon.level || "?"}`;
      const name = document.createElement("span");
      name.className = "azoth-party-name";
      name.textContent = data.name || `#${mon.species}`;
      button.append(image, level, name);
      button.title = `${data.name || ""} · HP ${mon.hp}/${mon.maxHp}`;
      button.addEventListener("click", () => {
        mon.azothPartyIndex = index;
        bridgeApi.showDetail(mon, "队伍");
        renderParty();
      });
      return button;
    }));
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
    const isParty = Number.isInteger(mon.azothPartyIndex);
    const lock = isParty ? " disabled" : "";

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
            <p>${isParty ? "队伍个体：等级、个体值、努力值锁定；点“保存 HOME 和 SAV”后写回存档。"
              : detail.label === "HOME" ? "HOME 个体：保存后立即写入浏览器本地。"
              : "SAV 个体：需再点顶部“保存 HOME 和 SAV”才写回存档。"}</p>
          </div>
          <button type="button" class="azoth-editor-close" data-action="cancel" aria-label="关闭">×</button>
        </header>

        <div class="azoth-editor-grid">
          <label class="azoth-editor-row">
            <span>等级</span>
            <input type="number" id="${IDS.level}" min="1" max="100" step="1" value="${level}"${lock}>
          </label>

          <label class="azoth-editor-row">
            <span>携带道具</span>
            <input type="search" id="azothEditorItemSearch" placeholder="搜索中文名或英文名…">
            <select id="${IDS.item}">${optionsFor("items", fields.heldItem, "（无）")}</select>
          </label>

          <label class="azoth-editor-row">
            <span>昵称</span>
            <input type="text" id="${IDS.nickname}" maxlength="12" value=""
                   placeholder="${escapeHtml(mon.nickname || "留空则保持原名")}">
            <small>留空不修改；最多 9 字节（约 4～5 个全角字）。</small>
          </label>

          <div class="azoth-editor-row">
            <span>招式 <small>支持中文名 / 编号搜索</small></span>
            <input type="search" id="${IDS.moveSearch}" placeholder="搜索招式…">
            ${moveSelects}
          </div>

          <div class="azoth-editor-row">
            <span>个体值 <small>0–31</small></span>
            <div class="azoth-editor-stats">${statInputs("azothEditorIv", fields.ivs, 31, IV_KEYS, isParty)}</div>
          </div>

          <div class="azoth-editor-row">
            <span>努力值 <small>0–255，总和 ≤ 510</small></span>
            <div class="azoth-editor-stats">${statInputs("azothEditorEv", fields.evs, 255, EV_KEYS, isParty)}</div>
          </div>

          <p class="azoth-editor-note">
            物种、性格、性别、闪光、特性由 PID / OTID / 个体值决定，这里不提供修改；当前值见详情面板。
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

    const itemSelect = el(IDS.item);
    const moveSelectsEls = [0, 1, 2, 3].map((i) => el(`azothEditorMove${i}`));

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

      const level = Number(el(IDS.level).value);
      const moves = [0, 1, 2, 3].map((i) => Number(el(`azothEditorMove${i}`).value) || 0);
      const ivs = readStats("azothEditorIv", IV_KEYS);
      const evs = readStats("azothEditorEv", EV_KEYS);
      const evTotal = EV_KEYS.reduce((sum, key) => sum + evs[key], 0);
      if (evTotal > 510) throw new Error(`努力值总和 ${evTotal} 超过 510`);

      const isParty = Number.isInteger(mon.azothPartyIndex);
      const patch = {
        heldItem: Number(el(IDS.item).value) || 0,
        moves,
      };
      if (!isParty) {
        if (!Number.isInteger(level) || level < 1 || level > 100) throw new Error("等级必须在 1–100 之间");
        const species = codecApi.read(mon.raw).species;
        const exp = codecApi.expForLevel(game, species, level);
        if (exp == null) throw new Error("无法用当前物种的经验表计算该等级");
        patch.exp = exp;
        patch.ivs = ivs;
        patch.evs = evs;
      }

      const nickname = el(IDS.nickname).value.trim();
      if (nickname && nickname !== (mon.nickname || "").trim()) {
        const used = codecApi.nicknameBytes(nickname, bridgeApi.charmap());
        if (used > 9) throw new Error("昵称过长，请缩短到 9 字节以内");
        patch.nickname = nickname;
      }

      const raw = codecApi.apply(mon.raw, patch, { charmap: bridgeApi.charmap() });

      if (isParty) {
        const next = bridgeApi.updatePartyMon(mon.azothPartyIndex, raw);
        next.azothPartyIndex = mon.azothPartyIndex;
        bridgeApi.showDetail(next, "队伍");
        renderParty();
        dialog.close();
        bridgeApi.notify(`队伍中的 ${bridgeApi.speciesName(next)} 已修改，点“保存 HOME 和 SAV”后写回存档。`);
        return;
      }

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

  function watchSavBox() {
    const savBox = document.getElementById("savBox");
    if (!savBox) return;
    new MutationObserver(() => renderParty()).observe(savBox, { childList: true });
    renderParty();
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
    watchSavBox();
    document.documentElement.dataset.azothHomeEditor = "1";
    console.info("[azoth-home] editor ready");
  }

  boot().catch((error) => console.error("[azoth-home] editor failed", error));
})();
