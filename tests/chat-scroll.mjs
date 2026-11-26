// 会話画面のような、文書ではなく内側の欄だけが動くページで、行の半分マスクが行に付いてくることを確認する。
// 使い方: node tests/chat-scroll.mjs
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) candidates.push(process.env.PLAYWRIGHT_MODULE);
  candidates.push("playwright", "/workspace/ff-tools/node_modules/playwright/index.js");
  let last;
  for (const c of candidates) {
    try { return require(c); } catch (err) { last = err; }
  }
  throw last || new Error("playwright not found");
}
const { firefox } = loadPlaywright();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const srcDir = path.join(root, "src");
const contentJs = fs.readFileSync(path.join(srcDir, "enhance.js"), "utf8") + "\n" +
  fs.readFileSync(path.join(srcDir, "content.js"), "utf8");

let failed = 0, total = 0;
function check(name, cond, info) {
  total += 1;
  const pass = !!cond;
  if (!pass) failed += 1;
  console.log(`${pass ? "OK  " : "FAIL"}  ${name}${info === undefined ? "" : "  " + JSON.stringify(info).slice(0, 500)}`);
}

function startServer() {
  const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
  const server = http.createServer((req, res) => {
    const file = path.normalize(path.join(root, decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\/+/, "")));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end("no"); return;
    }
    res.writeHead(200, { "Content-Type": mime[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

const measure = () => {
  const canvas = document.getElementById("line-half-mask-root");
  if (!canvas) return { bad: -1, visible: 0, hasCanvas: false };
  const lines = window.__lineHalfMask.collectLines();
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const cr = canvas.getBoundingClientRect();
  const alphaAt = (x, y) => {
    const px = Math.round((x - cr.left) * dpr), py = Math.round((y - cr.top) * dpr);
    if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return -1;
    return ctx.getImageData(px, py, 1, 1).data[3];
  };
  let bad = 0, visible = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], h = l.bottom - l.top, mid = (l.left + l.right) / 2;
    const yTop = l.top + h * 0.25, yBot = l.top + h * 0.75;
    if (yTop < 56 || yBot > innerHeight - 4) continue;
    visible++;
    const aTop = alphaAt(mid, yTop), aBot = alphaAt(mid, yBot);
    const coverTop = (i % 2) === 1;
    const ok = coverTop ? (aTop > 128 && aBot < 128) : (aTop < 128 && aBot > 128);
    if (!ok) bad++;
  }
  return { bad, visible, hasCanvas: true, canvasTop: cr.top };
};

const { server, base } = await startServer();
const browser = await firefox.launch();

async function openChat(mode) {
  const page = await browser.newPage({ viewport: { width: 800, height: 700 } });
  const q = mode ? ("?mode=" + mode) : "";
  await page.goto(base + "/tests/chat-scroll.html" + q, { waitUntil: "load" });
  await page.addScriptTag({ content: contentJs });
  await page.waitForFunction(() => window.__lineHalfMask);
  await page.evaluate(() => { window.__lineHalfMask.start(); window.__lineHalfMask.pause(true); });
  await page.waitForTimeout(80);
  return page;
}

function thread() {
  const host = document.getElementById("shadow-host");
  if (host && host.shadowRoot) return host.shadowRoot.getElementById("thread");
  return document.getElementById("thread");
}

{
  const page = await openChat("");
  const before = await page.evaluate(measure);
  await page.evaluate(() => { const t = document.getElementById("thread"); t.scrollTop = 180; });
  await page.waitForTimeout(250);
  const after = await page.evaluate(measure);
  check("plain inner overflow: halves stay on the text after scrolling the thread",
    before.bad === 0 && after.bad === 0 && after.visible > 8, { before, after });
  await page.close();
}

{
  const page = await openChat("shadow");
  const before = await page.evaluate(measure);
  await page.evaluate(() => {
    const t = document.getElementById("shadow-host").shadowRoot.getElementById("thread");
    t.scrollTop = 180;
  });
  await page.waitForTimeout(250);
  const after = await page.evaluate(measure);
  check("shadow-dom thread: halves stay on the text after an inner scroll that does not reach window",
    before.bad === 0 && after.bad === 0 && after.visible > 8, { before, after });
  await page.close();
}

{
  const page = await openChat("transform");
  const before = await page.evaluate(measure);
  await page.evaluate(() => { document.getElementById("mover").style.transform = "translateY(-180px)"; });
  await page.waitForTimeout(250);
  const after = await page.evaluate(measure);
  check("transform-only movement (no scroll event): halves follow the text",
    before.bad === 0 && after.bad === 0 && after.visible > 8, { before, after });
  await page.close();
}

{
  const page = await openChat("html-cb");
  const before = await page.evaluate(measure);
  check("html transform containing block: stripes are painted in the canvas's own coordinates",
    before.bad === 0 && before.visible > 8 && before.canvasTop === 24, before);
  await page.evaluate(() => { const t = document.getElementById("thread"); t.scrollTop = 180; });
  await page.waitForTimeout(250);
  const after = await page.evaluate(measure);
  check("html transform containing block still aligns after the thread scrolls",
    after.bad === 0 && after.visible > 8 && after.canvasTop === 24, after);
  await page.close();
}

// 視覚増強も、同じ内側スクロール（Shadow DOM）で選択範囲に付いてくる。
{
  const page = await openChat("shadow");
  await page.evaluate(() => window.__lineHalfMask.stop());
  const started = await page.evaluate(() => {
    const thread = document.getElementById("shadow-host").shadowRoot.getElementById("thread");
    const bubbles = thread.querySelectorAll(".bubble");
    const p = bubbles[1].querySelector("p");
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    const ok = window.__lineHalfMask.enhanceSelection();
    window.__lineHalfMask.setEnhance({ speed: 0, width: 8 });
    return { ok, n: (window.__lineHalfMask.enhanceInfo() || {}).rects.length };
  });
  check("enhance starts on text inside the shadow thread", started.ok && started.n > 0, started);
  const before = await page.evaluate(() => JSON.parse(JSON.stringify(window.__lineHalfMask.enhanceInfo())));
  await page.evaluate(() => {
    document.getElementById("shadow-host").shadowRoot.getElementById("thread").scrollTop = 80;
  });
  await page.waitForTimeout(250);
  const after = await page.evaluate(() => JSON.parse(JSON.stringify(window.__lineHalfMask.enhanceInfo())));
  const moved = before.rects[0] && after.rects[0] && Math.abs((before.rects[0].top - after.rects[0].top) - 80) < 2;
  check("enhance follows a shadow-dom inner scroll (shared box moves with the text)",
    moved && after.box.h === before.box.h, { beforeTop: before.rects[0] && before.rects[0].top, afterTop: after.rects[0] && after.rects[0].top, h: after.box && after.box.h });
  await page.close();
}

await browser.close();
server.close();
console.log(`\n${total - failed}/${total} passed`);
if (failed) process.exit(1);
