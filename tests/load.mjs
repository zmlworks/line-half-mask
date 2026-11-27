// 負荷の計測（合否は付けず、数字を出す）。長い記事のページで、使っていないとき・動かしているときの
// フレームあたりの時間を測る。使い方: node tests/load.mjs
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
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(root, "src/enhance.js"), "utf8") + "\n" + fs.readFileSync(path.join(root, "src/content.js"), "utf8");
const chat = fs.readFileSync(path.join(root, "tests/chat-scroll.html"), "utf8");

const heavy = `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;font:16px/1.6 sans-serif}
#thread{height:100%;overflow:auto;padding:16px 24px}
p{margin:0 0 12px;max-width:640px}
</style></head><body><div id="thread">${Array.from({ length: 1500 }, (_, i) =>
  `<p>段落${i}。これは長い記事の一部です。行の半分マスクの負荷を測るために、同じような文を何度も繰り返します。スクロールしても位置が合うかを確かめます。<b>太字</b>と<code>code</code>も混ぜます。</p>`).join("")}</div></body></html>`;
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(req.url.startsWith("/chat") ? chat : heavy);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await firefox.launch();

const counter = `
  window.__raf = { calls: 0, cbMs: 0, max: 0 };
  const orig = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => orig((t) => {
    const s = performance.now();
    window.__raf.calls++;
    try { cb(t); } finally { const d = performance.now() - s; window.__raf.cbMs += d; if (d > window.__raf.max) window.__raf.max = d; }
  });
`;
const reset = () => { window.__raf.calls = 0; window.__raf.cbMs = 0; window.__raf.max = 0; };
const read = () => ({ frames: window.__raf.calls, avgMs: +(window.__raf.cbMs / Math.max(1, window.__raf.calls)).toFixed(4), maxMs: +window.__raf.max.toFixed(2) });

async function run(label, url, fn) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.addInitScript(counter);
  await page.goto(base + url, { waitUntil: "load" });
  const evalMs = await page.evaluate((code) => { const t = performance.now(); (0, eval)(code); return performance.now() - t; }, src);
  await page.waitForFunction(() => window.__lineHalfMask);
  const out = await fn(page, evalMs);
  console.log(label.padEnd(58), JSON.stringify(out));
  await page.close();
}
const select = (page, idx) => page.evaluate((idx) => {
  const p = document.querySelectorAll("p")[idx];
  const range = document.createRange(); range.selectNodeContents(p);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}, idx);
const measure = async (page, ms = 3000) => {
  await page.waitForTimeout(500);
  await page.evaluate(reset);
  await page.waitForTimeout(ms);
  return page.evaluate(read);
};

await run("inactive: script eval cost, rAF in 3 s, selectionchange", "/", async (page, evalMs) => {
  await page.waitForTimeout(3000);
  const idle = await page.evaluate(() => window.__raf.calls);
  const sc = await page.evaluate(() => {
    const p = document.querySelector("p");
    const range = document.createRange(); range.selectNodeContents(p);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    const N = 2000; const t0 = performance.now();
    for (let i = 0; i < N; i++) document.dispatchEvent(new Event("selectionchange"));
    return +(((performance.now() - t0) / N) * 1000).toFixed(1);
  });
  return { evalMs: +evalMs.toFixed(2), rafCallsIn3s: idle, selectionchangeMicrosecondsPerEvent: sc };
});

for (const fill of ["black", "enhance"]) {
  await run(`page-wide ${fill}, static (polling only)`, "/", async (page) => {
    await page.evaluate((fill) => { const a = window.__lineHalfMask; a.setFill(fill); a.setEnhance({ speed: 0 }); a.start(); }, fill);
    return measure(page);
  });
  await run(`page-wide ${fill}, animating`, "/", async (page) => {
    await page.evaluate((fill) => { const a = window.__lineHalfMask; a.setFill(fill); a.start(); }, fill);
    return measure(page);
  });
  await run(`selection ${fill} (full), static (polling only)`, "/", async (page) => {
    await select(page, 3);
    await page.evaluate((fill) => { const a = window.__lineHalfMask; a.setEnhance({ speed: 0 }); a.overlaySelection({ fill }); }, fill);
    return measure(page);
  });
  await run(`selection ${fill} (full), animating`, "/", async (page) => {
    await select(page, 3);
    await page.evaluate((fill) => window.__lineHalfMask.overlaySelection({ fill }), fill);
    return measure(page);
  });
}

await run("update() cost on the 1500-paragraph page (ms, mean of 20)", "/", async (page) => {
  const pageWide = await page.evaluate(() => { const a = window.__lineHalfMask; a.start(); const t = performance.now(); for (let i = 0; i < 20; i++) a.update(); return +((performance.now() - t) / 20).toFixed(2); });
  const lines = await page.evaluate(() => window.__lineHalfMask.collectLines().length);
  await page.evaluate(() => window.__lineHalfMask.stop());
  await select(page, 3);
  const selection = await page.evaluate(() => { const a = window.__lineHalfMask; a.overlaySelection(); const t = performance.now(); for (let i = 0; i < 20; i++) a.update(); return +((performance.now() - t) / 20).toFixed(2); });
  return { pageWideUpdateMs: pageWide, selectionUpdateMs: selection, linesOnPage: lines };
});

await run("chat repro (shadow thread): selection enhance, animating", "/chat?mode=shadow", async (page) => {
  await page.evaluate(() => {
    const root = document.getElementById("shadow-host") ? document.getElementById("shadow-host").shadowRoot : document;
    const p = root.querySelector("p");
    const range = document.createRange(); range.selectNodeContents(p);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    window.__lineHalfMask.overlaySelection({ fill: "enhance" });
  });
  return measure(page);
});

await browser.close(); server.close();
