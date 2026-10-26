/* Browser smoke test for the built site.

   Serves dist/ over http (fetch + IndexedDB + Web Locks need a secure origin),
   then drives the page through the injected bridge:

     1. editor boots, bridge + codec exposed
     2. a synthetic 58-byte mon renders (sprite actually loads)
     3. the edit button appears on the detail panel
     4. changing the level re-encodes raw bytes and re-renders

   PW_CHANNEL=msedge (default on Windows) or set PW_CHANNEL=none in CI to use
   Playwright's bundled Chromium.
*/
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".bin": "application/octet-stream",
  ".sav": "application/octet-stream",
};

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}

function serve() {
  const server = createServer(async (request, response) => {
    let path = decodeURIComponent(new URL(request.url, "http://local").pathname);
    if (path.endsWith("/")) path += "index.html";
    const file = normalize(join(DIST, path));
    if (!file.startsWith(DIST + sep)) {
      response.writeHead(403).end("forbidden");
      return;
    }
    try {
      const body = await readFile(file);
      response.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404).end("not found");
    }
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server)));
}

const channel = process.env.PW_CHANNEL ?? "msedge";
const launchOptions = channel === "none" ? {} : { channel };

const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(launchOptions);
const context = await browser.newContext();
const page = await context.newPage();

const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() !== "error") return;
  const url = message.location()?.url ?? "";
  if (/favicon/i.test(url) || /favicon/i.test(message.text())) return;
  consoleErrors.push(`${message.text()} @ ${url}`);
});
page.on("pageerror", (error) => consoleErrors.push(String(error)));

try {
  await page.goto(`${base}/home/`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(
    () => document.documentElement.dataset.azothHomeEditor === "1",
    null,
    { timeout: 30000 },
  );

  const initial = await page.evaluate(() => ({
    bridge: window.AzothHomeInternal?.version,
    codec: Boolean(window.AzothMonCodec),
    boxCount: window.AzothHomeInternal?.getHomeBoxes()?.length,
    ids: ["homeBox", "savBox", "saveBtn", "summary", "detail", "file"]
      .filter((id) => !document.getElementById(id)),
  }));
  check(initial.bridge === 1, `bridge version is ${initial.bridge}`);
  check(initial.codec, "AzothMonCodec is missing");
  check(initial.boxCount === 25, `expected 25 HOME boxes, got ${initial.boxCount}`);
  check(initial.ids.length === 0, `missing DOM ids: ${initial.ids.join(", ")}`);

  await page.evaluate(() => {
    const b = window.AzothHomeInternal;
    const codec = window.AzothMonCodec;
    const charmap = b.charmap();
    let raw = new Uint8Array(codec.SIZE);
    raw = codec.apply(raw, {
      species: 1,
      exp: 0,
      heldItem: 13,
      moves: [33, 0, 0, 0],
      ivs: { hp: 31, atk: 31, def: 31, spe: 31, spa: 31, spd: 31 },
      evs: { hp: 0, atk: 0, def: 0, spe: 0, spa: 0, spd: 0 },
      nickname: "测试",
    }, { charmap });
    const mon = b.parseMon(raw);
    if (!mon || mon.species !== 1) throw new Error("synthetic mon failed to parse");
    b.getHomeBoxes()[0][0] = b.cloneMon(mon);
    b.goHomeBox(0);
    b.showDetail(b.getHomeBoxes()[0][0], "HOME");
  });

  await page.waitForSelector("#azothEditBtn", { timeout: 8000 });
  const iconOk = await page.evaluate(async () => {
    const image = document.querySelector("#homeBox img.mon-icon");
    if (!image) return false;
    if (!image.complete) await new Promise((done) => {
      image.addEventListener("load", done, { once: true });
      image.addEventListener("error", done, { once: true });
    });
    return image.naturalWidth > 0;
  });
  check(iconOk, "sprite did not load from the mirrored pokemon icons");

  await page.click("#azothEditBtn");
  await page.waitForSelector("#azothEditorDialog[open]", { timeout: 5000 });

  const form = await page.evaluate(() => ({
    level: document.getElementById("azothEditorLevel").value,
    species: document.getElementById("azothEditorSpecies").value,
    ivHp: document.getElementById("azothEditorIv_hp").value,
    optionCount: document.getElementById("azothEditorMove0").options.length,
  }));
  check(form.species === "1", `species field shows ${form.species}`);
  check(form.ivHp === "31", `hp IV field shows ${form.ivHp}`);
  check(form.optionCount > 900, `move list only has ${form.optionCount} options`);

  await page.fill("#azothEditorLevel", "50");
  await page.click('.azoth-editor button[data-action="save"]');
  await page.waitForFunction(() => !document.getElementById("azothEditorDialog"), null, { timeout: 5000 });

  const after = await page.evaluate(() => {
    const mon = window.AzothHomeInternal.getHomeBoxes()[0][0];
    return {
      level: mon.level,
      species: mon.species,
      moves: mon.moves,
      ivs: mon.ivs,
      nickname: mon.nickname,
      rawLength: mon.raw.length,
    };
  });
  check(after.level === 50, `level after save is ${after.level}`);
  check(after.species === 1, `species changed unexpectedly to ${after.species}`);
  check(after.moves[0] === 33, `move 1 changed unexpectedly to ${after.moves[0]}`);
  check(after.ivs.hp === 31, `hp IV changed unexpectedly to ${after.ivs.hp}`);
  check(after.nickname === "测试", `nickname is ${JSON.stringify(after.nickname)}`);
  check(after.rawLength === 58, `raw length is ${after.rawLength}`);

  const realErrors = consoleErrors.filter((text) => !/favicon/i.test(text));
  check(realErrors.length === 0, `console errors: ${realErrors.join(" | ")}`);
} finally {
  await context.close();
  await browser.close();
  server.close();
}

if (failures.length) {
  console.error("browser smoke failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("browser smoke ok: editor booted, mon rendered, edit round-trip passed");
