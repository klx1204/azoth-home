/* In-page Pokemon editor for 水银 HOME.

   Runs outside upstream's closure. It talks to the page through
   window.AzothHomeInternal (bridge), window.AzothMonCodec and window.AzothPmh1
   (data + PID search + 58-byte writer), and never replaces upstream markup.

   Box mons: level, nature, gender, shiny, ability, ball, item, 4 moves, IVs, EVs,
   nickname. Party mons lock level / nature / gender / shiny / IV / EV because the
   saved battle stats would go stale; ability (PID slot), ball, item, moves and
   nickname remain editable.
*/
(function () {
  "use strict";

  const IDS = {
    dialog: "azothEditorDialog",
    nickname: "azothEditorNickname",
    level: "azothEditorLevel",
    nature: "azothEditorNature",
    gender: "azothEditorGender",
    shiny: "azothEditorShiny",
    ability: "azothEditorAbility",
    ball: "azothEditorBall",
    item: "azothEditorItem",
    moveSearch: "azothEditorMoveSearch",
    error: "azothEditorError",
  };

  const IV_KEYS = ["hp", "atk", "def", "spe", "spa", "spd"];
  const EV_KEYS = ["hp", "atk", "def", "spe", "spa", "spd"];
  const LABELS = { hp: "HP", atk: "攻击", def: "防御", spe: "速度", spa: "特攻", spd: "特防" };
  const NATURE_EFFECT = [
    "无修正", "+攻-防", "+攻-速", "+攻-特攻", "+攻-特防",
    "+防-攻", "无修正", "+防-速", "+防-特攻", "+防-特防",
    "+速-攻", "+速-防", "无修正", "+速-特攻", "+速-特防",
    "+特攻-攻", "+特攻-防", "+特攻-速", "无修正", "+特攻-特防",
    "+特防-攻", "+特防-防", "+特防-速", "+特防-特攻", "无修正",
  ];

  let pickerCache = new Map();

  const bridge = () => window.AzothHomeInternal;
  const codec = () => window.AzothMonCodec;
  const pmh1 = () => window.AzothPmh1;

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

  // ---------- search picker ----------
  function pickerItems(kind) {
    if (pickerCache.has(kind)) return pickerCache.get(kind);
    const api = pmh1();
    let items;
    if (kind === "moves") {
      items = api.moveList.filter((move) => move.id).map((move) => ({
        id: move.id,
        label: move.en ? `${move.zh}（${move.en}）` : `${move.zh}（#${move.id}）`,
        hint: `#${move.id}`,
        search: `${move.zh} ${move.en} ${move.id}`.toLowerCase(),
      }));
    } else {
      items = Object.entries(api.data.items)
        .filter(([id]) => Number(id))
        .map(([id, row]) => ({
          id: Number(id),
          label: row[1] ? `${row[1]}（${row[0]}）` : String(row[0]),
          hint: "",
          search: `${row[1] || ""} ${row[0] || ""} ${id}`.toLowerCase(),
        }));
    }
    pickerCache.set(kind, items);
    return items;
  }

  function searchItems(items, query) {
    const text = query.trim();
    if (!text) return [];
    const lower = text.toLowerCase();
    const numeric = /^\d+$/.test(text) ? Number(text) : null;
    const out = [];
    for (const item of items) {
      if (numeric !== null && item.id === numeric) { out.push(item); continue; }
      if (item.label.includes(text)) { out.push(item); continue; }
      if (item.search.includes(lower)) out.push(item);
      if (out.length >= 30) break;
    }
    return out.slice(0, 30);
  }

  function pickerField(id, label, items, selectedId, placeholder) {
    const selected = items.find((item) => item.id === selectedId);
    const dataId = selected ? ` data-id="${selected.id}"` : "";
    return `
      <label class="azoth-editor-row azoth-picker" data-picker="${id}">
        <span>${label}</span>
        <input type="text" id="${id}" autocomplete="off" spellcheck="false"${dataId}
               value="${escapeHtml(selected ? selected.label : "")}"
               placeholder="${escapeHtml(placeholder || "搜索…")}">
        <div class="azoth-picker-menu" hidden></div>
      </label>`;
  }

  function bindPicker(field) {
    const input = field.querySelector("input");
    const menu = field.querySelector(".azoth-picker-menu");
    const items = pickerItems(field.dataset.picker.startsWith("azothEditorMove") ? "moves" : "items");
    let current = [];

    const close = () => { menu.hidden = true; };
    const choose = (item) => {
      input.value = item.label;
      input.dataset.id = String(item.id);
      close();
    };
    const render = (list) => {
      current = list;
      menu.innerHTML = list.length
        ? list.map((item, index) => {
          const hint = item.hint ? `<small>${escapeHtml(item.hint)}</small>` : "";
          return `<button type="button" data-index="${index}"><span>${escapeHtml(item.label)}</span>${hint}</button>`;
        }).join("")
        : `<div class="azoth-picker-empty">没有匹配项</div>`;
      menu.hidden = false;

      // Phones: expand inline under the input. A fixed popover drifts once the
      // soft keyboard resizes the viewport.
      if (window.matchMedia("(max-width: 640px)").matches) {
        menu.style.position = "";
        menu.style.left = "";
        menu.style.top = "";
        menu.style.width = "";
        requestAnimationFrame(() => menu.scrollIntoView({ block: "nearest" }));
        return;
      }

      const rect = input.getBoundingClientRect();
      menu.style.position = "fixed";
      menu.style.left = `${rect.left}px`;
      menu.style.width = `${rect.width}px`;
      const height = menu.offsetHeight;
      const openUp = rect.bottom + height + 12 > window.innerHeight && rect.top > height + 12;
      menu.style.top = openUp ? `${rect.top - height - 4}px` : `${rect.bottom + 4}px`;
    };

    input.addEventListener("input", () => {
      delete input.dataset.id;
      if (!input.value.trim()) { close(); return; }
      render(searchItems(items, input.value));
    });
    input.addEventListener("focus", () => {
      if (input.value.trim()) render(searchItems(items, input.value));
    });
    input.addEventListener("blur", () => setTimeout(close, 200));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close();
      if (event.key === "Enter" && current[0]) {
        event.preventDefault();
        choose(current[0]);
      }
    });
    menu.addEventListener("mousedown", (event) => event.preventDefault());
    menu.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-index]");
      if (!button) return;
      const item = current[Number(button.dataset.index)];
      if (item) choose(item);
    });
  }

  function pickerValue(id) {
    const input = el(id);
    if (!input) return 0;
    if (input.dataset.id != null) return Number(input.dataset.id);
    const text = input.value.trim();
    if (!text) return 0;
    const api = pmh1();
    return (id.includes("Move") ? api.lookupMove(text) : api.lookupItem(text)) ?? null;
  }

  // ---------- shared bits ----------
  function statInputs(prefix, values, max, keys, disabled = false) {
    return keys.map((key) => `
      <label class="azoth-editor-stat">
        <span>${LABELS[key]}</span>
        <input type="number" min="0" max="${max}" step="1" data-key="${key}"
               id="${prefix}_${key}" value="${values[key] | 0}"${disabled ? " disabled" : ""}>
      </label>`).join("");
  }

  function closeEditor() {
    el(IDS.dialog)?.remove();
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
      const info = pmh1().readMon(mon.raw);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "azoth-party-slot";
      if (info.shiny) button.classList.add("shiny");
      if (index === active) button.classList.add("selected");
      const image = document.createElement("img");
      image.src = `pokemon/icons/${String(mon.species).padStart(4, "0")}.png`;
      image.alt = pmh1().speciesName(mon.species);
      const level = document.createElement("span");
      level.className = "azoth-party-level";
      level.textContent = `Lv.${mon.level || "?"}`;
      const name = document.createElement("span");
      name.className = "azoth-party-name";
      name.textContent = pmh1().speciesName(mon.species);
      button.append(image, level, name);
      button.title = `${pmh1().speciesName(mon.species)} · HP ${mon.hp}/${mon.maxHp}`;
      button.addEventListener("click", () => {
        mon.azothPartyIndex = index;
        bridgeApi.showDetail(mon, "队伍");
        renderParty();
      });
      return button;
    }));
  }

  // ---------- editor ----------
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
    if (!window.AzothPmh1 || !window.AzothMonCodec) {
      notify("编辑器数据未加载，请刷新页面重试。");
      return;
    }

    closeEditor();

    const api = pmh1();
    const info = api.readMon(mon.raw);
    const speciesRow = api.data.species[info.species] || [];
    const genderRatio = speciesRow[6] ?? 127;
    const originalLevel = api.levelForExp(info.species, info.exp);
    const isParty = Number.isInteger(mon.azothPartyIndex);
    const lock = isParty ? " disabled" : "";
    const nicknameHint = info.nickname ? `留空不修改（当前：${info.nickname}）` : "留空不修改";

    const natureOptions = api.data.natures.map(([en, zh], index) =>
      `<option value="${index}"${index === info.nature ? " selected" : ""}>${escapeHtml(zh)}（${escapeHtml(en)}）${NATURE_EFFECT[index]}</option>`
    ).join("");

    const genderOptions = api.genderChoices(genderRatio).map(([value, label]) =>
      `<option value="${value}"${value === info.gender ? " selected" : ""}>${label}</option>`
    ).join("");

    const abilityOptions = api.abilityOptions(info.species).map((option) => {
      const label = option.slot === 2 ? `${option.name}（梦特）` : `${option.name}（普通 ${option.slot + 1}）`;
      return `<option value="${option.id}"${option.id === (info.abilitySlot === 2 ? speciesRow[5] : info.abilitySlot === 1 ? speciesRow[4] : speciesRow[3]) ? " selected" : ""}>${escapeHtml(label)}</option>`;
    }).join("");

    const ballOptions = api.data.balls.map(([id, en, zh]) =>
      `<option value="${id}"${id === info.ball ? " selected" : ""}>${escapeHtml(zh)}（${escapeHtml(en)}）</option>`
    ).join("");

    const moveFields = [0, 1, 2, 3].map((index) =>
      pickerField(`azothEditorMove${index}`, `招式 ${index + 1}`, pickerItems("moves"), info.moves?.[index] || 0, index === 0 ? "必填" : "可留空")
    ).join("");

    const dialog = document.createElement("dialog");
    dialog.id = IDS.dialog;
    dialog.className = "azoth-editor";
    dialog.innerHTML = `
      <form method="dialog" autocomplete="off">
        <header>
          <div>
            <h2>编辑 · ${escapeHtml(api.speciesName(info.species))}</h2>
            <p>${isParty
              ? "队伍个体：等级、性格、性别、闪光、个体值、努力值锁定；其余可改。"
              : detail.label === "HOME"
                ? "HOME 个体：保存后立即写入浏览器本地。"
                : "SAV 个体：需再点顶部“保存 HOME 和 SAV”才写回存档。"}</p>
          </div>
          <button type="button" class="azoth-editor-close" data-action="cancel" aria-label="关闭">×</button>
        </header>

        <div class="azoth-editor-grid">
          <div class="azoth-editor-two">
            <label class="azoth-editor-row">
              <span>等级</span>
              <input type="number" id="${IDS.level}" min="1" max="100" step="1" value="${originalLevel}"${lock}>
            </label>
            <label class="azoth-editor-row">
              <span>性格</span>
              <select id="${IDS.nature}"${lock}>${natureOptions}</select>
            </label>
          </div>

          <div class="azoth-editor-two">
            <label class="azoth-editor-row">
              <span>性别</span>
              <select id="${IDS.gender}"${lock}>${genderOptions}</select>
            </label>
            <label class="azoth-editor-check">
              <input type="checkbox" id="${IDS.shiny}"${info.shiny ? " checked" : ""}${lock}>
              <span>闪光</span>
            </label>
          </div>

          <div class="azoth-editor-two">
            <label class="azoth-editor-row">
              <span>特性</span>
              <select id="${IDS.ability}">${abilityOptions}</select>
            </label>
            <label class="azoth-editor-row">
              <span>球种</span>
              <select id="${IDS.ball}">${ballOptions}</select>
            </label>
          </div>

          ${pickerField(IDS.item, "携带道具", pickerItems("items"), info.heldItem || 0, "搜索中文名或英文名…")}

          <div class="azoth-editor-row">
            <span>招式 <small>支持中文名 / 英文名 / 编号</small></span>
            ${moveFields}
          </div>

          <div class="azoth-editor-row">
            <span>个体值 <small>0–31</small></span>
            <div class="azoth-editor-stats">${statInputs("azothEditorIv", info.ivs, 31, IV_KEYS, isParty)}</div>
          </div>

          <div class="azoth-editor-row">
            <span>努力值 <small>0–255，总和 ≤ 510</small></span>
            <div class="azoth-editor-stats">${statInputs("azothEditorEv", info.evs, 255, EV_KEYS, isParty)}</div>
          </div>

          <label class="azoth-editor-row">
            <span>昵称</span>
            <input type="text" id="${IDS.nickname}" maxlength="12" value=""
                   placeholder="${escapeHtml(nicknameHint)}">
            <small>留空不修改；最多 9 字节（约 4～5 个全角字）。</small>
          </label>

          <p class="azoth-editor-note">
            物种不可修改。性格、性别、闪光、特性通过重新搜索 PID 实现，会保留训练家信息；
            个别组合可能无解，会提示调整条件。
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

    for (const field of dialog.querySelectorAll(".azoth-picker")) bindPicker(field);

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
      if (!Number.isInteger(value) || value < Number(input.min) || value > Number(input.max)) {
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
      const api = pmh1();
      const info = api.readMon(mon.raw);
      const isParty = Number.isInteger(mon.azothPartyIndex);

      const level = Number(el(IDS.level).value);
      if (!Number.isInteger(level) || level < 1 || level > 100) throw new Error("等级必须在 1–100 之间");

      const heldItem = pickerValue(IDS.item);
      if (heldItem == null) throw new Error("道具名称无法识别，请从下拉列表中选择");
      const moves = [0, 1, 2, 3].map((index) => {
        const value = pickerValue(`azothEditorMove${index}`);
        if (value == null) throw new Error(`招式 ${index + 1} 无法识别，请从下拉列表中选择`);
        return value;
      });

      const ivs = isParty ? info.ivs : readStats("azothEditorIv", IV_KEYS);
      const evs = isParty ? info.evs : readStats("azothEditorEv", EV_KEYS);
      const evTotal = EV_KEYS.reduce((sum, key) => sum + evs[key], 0);
      if (evTotal > 510) throw new Error(`努力值总和 ${evTotal} 超过 510`);

      const option = {
        species: info.species,
        level: isParty ? api.levelForExp(info.species, info.exp) : level,
        nature: isParty ? info.nature : Number(el(IDS.nature).value),
        gender: isParty ? info.gender : Number(el(IDS.gender).value),
        shiny: isParty ? info.shiny : el(IDS.shiny).checked,
        abilityId: Number(el(IDS.ability).value),
        ball: Number(el(IDS.ball).value),
        heldItem,
        moves,
        ivs,
        evs,
        nickname: el(IDS.nickname).value.trim() || info.nickname,
      };

      // Keep the original EXP so an untouched level never rewrites bytes.
      if (isParty || option.level === api.levelForExp(info.species, info.exp)) option.exp = info.exp;

      const built = api.buildMon(option, mon.raw, bridgeApi.charmap());
      dialog.close();

      if (isParty) {
        const next = bridgeApi.updatePartyMon(mon.azothPartyIndex, built.raw);
        next.azothPartyIndex = mon.azothPartyIndex;
        bridgeApi.showDetail(next, "队伍");
        renderParty();
        bridgeApi.notify(`队伍中的 ${api.speciesName(info.species)} 已修改，点“保存 HOME 和 SAV”后写回存档。`);
        return;
      }

      const next = bridgeApi.updateMon(mon, built.raw);
      bridgeApi.showDetail(next, detail.label);
      const scope = detail.label === "HOME" ? "HOME 已保存" : "SAV 待保存";
      bridgeApi.notify(`已修改 ${api.speciesName(info.species)}（Lv.${option.level}）。${scope}；SAV 请点“保存 HOME 和 SAV”后生效。`);
    } catch (error) {
      if (errorNode) errorNode.textContent = error.message;
    }
  }

  // ---------- injection ----------
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
    if (!bridge().getLastDetail()) return;
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
