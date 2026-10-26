import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");
const OUT = process.env.SHOT_DIR ?? join(ROOT, "dist");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png" };

const server = createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, "http://local").pathname);
  if (path.endsWith("/")) path += "index.html";
  const file = normalize(join(DIST, path));
  if (!file.startsWith(DIST + sep)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404).end("nf"); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
await page.goto(`${base}/`, { waitUntil: "load" });
await page.waitForFunction(() => document.documentElement.dataset.azothHomeEditor === "1", null, { timeout: 30000 });
await page.screenshot({ path: join(OUT, "shot-1-home.png") });

if (process.env.AZOTH_TEST_SAV) {
  await page.setInputFiles("#file", process.env.AZOTH_TEST_SAV);
  await page.waitForFunction(() => (window.AzothHomeInternal.getParty()?.length ?? 0) > 0, null, { timeout: 15000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(OUT, "shot-2-party.png") });

  await page.click(".azoth-party-slot");
  await page.waitForSelector("#azothEditBtn", { timeout: 5000 });
  await page.click("#azothEditBtn");
  await page.waitForSelector("#azothEditorDialog[open]", { timeout: 5000 });
  await page.screenshot({ path: join(OUT, "shot-3-editor.png") });
  await page.keyboard.press("Escape");

  await page.click("#azothShowdownBtn");
  await page.waitForSelector("#azothShowdownDialog[open]", { timeout: 5000 });
  await page.fill("#azothShowdownText", "Pikachu @ Light Ball\nLevel: 50\n- Thunderbolt\n- Surf");
  await page.screenshot({ path: join(OUT, "shot-4-showdown.png") });
}

await browser.close();
server.close();
console.log("shots written to", OUT);
