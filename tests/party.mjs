/* End-to-end party test against a real save.

   AZOTH_TEST_SAV=/path/to/save.sav node tests/party.mjs

   Uploads the save, edits the first party member's move, saves the SAV through
   upstream's own button, then re-uploads the downloaded file and checks that the
   edit survived a full parse/write round-trip. The original file is never
   modified.
*/
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

const SAV = process.env.AZOTH_TEST_SAV;
if (!SAV) {
  console.log("party test skipped (AZOTH_TEST_SAV not set)");
  process.exit(0);
}

const ROOT = resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}

const server = createServer(async (request, response) => {
  let path = decodeURIComponent(new URL(request.url, "http://local").pathname);
  if (path.endsWith("/")) path += "index.html";
  const file = normalize(join(DIST, path));
  if (!file.startsWith(DIST + sep)) { response.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    response.end(body);
  } catch { response.writeHead(404).end("not found"); }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${server.address().port}`;

const channel = process.env.PW_CHANNEL ?? "msedge";
const browser = await chromium.launch(channel === "none" ? {} : { channel });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() !== "error") return;
  const url = message.location()?.url ?? "";
  if (/favicon/i.test(url) || /favicon/i.test(message.text())) return;
  consoleErrors.push(`${message.text()} @ ${url}`);
});
page.on("pageerror", (error) => consoleErrors.push(String(error)));

async function openHome() {
  await page.goto(`${base}/home/app.html`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => document.documentElement.dataset.azothHomeEditor === "1", null, { timeout: 30000 });
}

try {
  await openHome();
  await page.setInputFiles("#file", SAV);
  await page.waitForFunction(() => (window.AzothHomeInternal.getParty()?.length ?? 0) > 0, null, { timeout: 15000 });

  const before = await page.evaluate(() => {
    const party = window.AzothHomeInternal.getParty();
    return party.map((mon) => ({
      species: mon.species, level: mon.level, moves: mon.moves, item: mon.heldItem, nickname: mon.nickname,
    }));
  });
  check(before.length > 0, "party is empty");

  await page.click(".azoth-party-slot");
  await page.waitForSelector("#azothEditBtn", { timeout: 5000 });
  await page.click("#azothEditBtn");
  await page.waitForSelector("#azothEditorDialog[open]", { timeout: 5000 });

  const locks = await page.evaluate(() => ({
    level: document.getElementById("azothEditorLevel").disabled,
    species: document.getElementById("azothEditorSpeciesSearch").disabled,
    iv: document.getElementById("azothEditorIv_hp").disabled,
    ev: document.getElementById("azothEditorEv_hp").disabled,
  }));
  check(locks.level && locks.species && locks.iv && locks.ev, `party fields not locked: ${JSON.stringify(locks)}`);

  const target = await page.evaluate(() => {
    const select = document.getElementById("azothEditorMove0");
    const current = Number(select.value);
    const pick = [...select.options].map((option) => Number(option.value)).find((value) => value && value !== current);
    return { current, pick };
  });
  check(target.pick != null, "no alternative move to pick");
  await page.selectOption("#azothEditorMove0", String(target.pick));
  await page.click('.azoth-editor button[data-action="save"]');
  await page.waitForFunction(() => !document.getElementById("azothEditorDialog"), null, { timeout: 5000 });

  const edited = await page.evaluate(() => {
    const mon = window.AzothHomeInternal.getParty()[0];
    return { moves: mon.moves, rawLength: mon.raw.length };
  });
  check(edited.moves[0] === target.pick, `move not updated: ${edited.moves[0]} != ${target.pick}`);
  check(edited.rawLength === 58, `raw length ${edited.rawLength}`);

  const downloadPromise = page.waitForEvent("download", { timeout: 15000 });
  await page.click("#saveBtn");
  const download = await downloadPromise;
  const outPath = join(ROOT, "dist", "__party-test.sav");
  await download.saveAs(outPath);
  const saved = await readFile(outPath);
  check(saved.length === 131072, `saved file is ${saved.length} bytes`);
  await page.waitForTimeout(800);

  // Re-upload the file upstream just produced and confirm the edit survived.
  await openHome();
  await page.setInputFiles("#file", outPath);
  await page.waitForFunction(() => (window.AzothHomeInternal.getParty()?.length ?? 0) > 0, null, { timeout: 15000 });
  const after = await page.evaluate(() => {
    const party = window.AzothHomeInternal.getParty();
    return party.map((mon) => ({
      species: mon.species, level: mon.level, moves: mon.moves, item: mon.heldItem, nickname: mon.nickname,
    }));
  });
  check(after.length === before.length, `party count changed ${before.length} -> ${after.length}`);
  check(after[0].moves[0] === target.pick, `reloaded move is ${after[0].moves[0]}, expected ${target.pick}`);
  for (let i = 1; i < before.length; i++) {
    check(
      JSON.stringify(before[i]) === JSON.stringify(after[i]),
      `party slot ${i} changed unexpectedly: ${JSON.stringify(before[i])} -> ${JSON.stringify(after[i])}`,
    );
  }
  check(after[0].species === before[0].species, "species changed");
  check(after[0].level === before[0].level, "level changed");

  const realErrors = consoleErrors.filter((text) => !/favicon/i.test(text));
  check(realErrors.length === 0, `console errors: ${realErrors.join(" | ")}`);
} finally {
  await context.close();
  await browser.close();
  server.close();
}

if (failures.length) {
  console.error("party test failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("party test ok: 6 slots loaded, locked fields enforced, move edit survived SAV write + reload");
