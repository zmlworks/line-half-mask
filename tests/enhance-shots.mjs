// 視覚増強の画面写真と GIF を作る（README 用）。使い方: node tests/enhance-shots.mjs
// GIF の合成には Python の Pillow を使う。
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { execFileSync } from "child_process";
import os from "os";

const require = createRequire(import.meta.url);
const { firefox } = (() => {
  for (const c of [process.env.PLAYWRIGHT_MODULE, "playwright", "/workspace/ff-tools/node_modules/playwright/index.js"].filter(Boolean)) {
    try { return require(c); } catch (_) {}
  }
  throw new Error("playwright not found");
})();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const srcDir = path.join(root, "src");
const shotDir = path.join(root, "screenshots");
fs.mkdirSync(shotDir, { recursive: true });
const contentJs = fs.readFileSync(path.join(srcDir, "enhance.js"), "utf8") + "\n" + fs.readFileSync(path.join(srcDir, "content.js"), "utf8");

const server = http.createServer((req, res) => {
  const file = path.normalize(path.join(root, decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\/+/, "")));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end("no"); return; }
  res.writeHead(200, { "Content-Type": file.endsWith(".html") ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await firefox.launch();
const page = await browser.newPage({ viewport: { width: 560, height: 560 } });
await page.goto(base + "/tests/sample.html", { waitUntil: "load" });
await page.addScriptTag({ content: contentJs });
await page.waitForFunction(() => window.__lineHalfMask);

// 本文の 2 段落目の途中から 3 行ぶんを、ドラッグ選択のように選ぶ。
await page.evaluate(() => {
  const el = document.getElementById("p-en");
  const node = el.firstChild;
  const range = document.createRange();
  range.setStart(node, 20);
  range.setEnd(node, 230);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  scrollTo(0, el.offsetTop - 110);
});
await page.waitForTimeout(100);
await page.evaluate(() => window.__lineHalfMask.enhanceSelection());

const shot = async (name, cfg, t) => {
  await page.evaluate(([cfg, t]) => { window.__lineHalfMask.setEnhance(cfg); window.__lineHalfMask.enhanceAt(t); }, [cfg, t]);
  await page.screenshot({ path: path.join(shotDir, name) });
};
await shot("enhance-bw.png", { speed: 0, width: 6, color: 0 }, 0);
await shot("enhance-color.png", { speed: 0, width: 8, color: 1, hueRate: 2 }, 0);
await shot("enhance-auto.png", { auto: true, color: 1, hueRate: 6 }, 40);
// 90 度（横縞）で、行をまたいで一つの場として続くことを見せる。
await shot("enhance-rotate.png", { speed: 0, width: 8, color: 0, rotate: true, rotSpeed: 45 }, 1);

// GIF: 色モード、回転（軸が動く）、流れ。20 コマ/秒で 6 秒。
const frames = fs.mkdtempSync(path.join(os.tmpdir(), "lhm-gif-"));
const cfg = { speed: 40, width: 8, color: 1, hueRate: 20, rotate: true, rotSpeed: 20, wander: true };
await page.evaluate((cfg) => window.__lineHalfMask.setEnhance(cfg), cfg);
const N = 60;
for (let i = 0; i < N; i++) {
  await page.evaluate((t) => window.__lineHalfMask.enhanceAt(t), i / 10);
  await page.screenshot({ path: path.join(frames, `f${String(i).padStart(3, "0")}.png`), clip: { x: 0, y: 60, width: 560, height: 360 } });
}
// ポップアップ（回転と色モードを開いた状態）
{
  const pop = await browser.newPage({ viewport: { width: 260, height: 1000 } });
  await pop.addInitScript({ content: `
    window.__storage = { enhance: { rotate: true, rotSpeed: 0.5, color: 1, hueRate: 2, speed: 3, width: 4 } };
    const api = {
      tabs: { query: async () => [{ id: 1 }], sendMessage: async () => ({ on: false, parity: 0, enhanceOn: false }) },
      storage: { local: {
        get: async (k) => (typeof k === "string" ? { [k]: window.__storage[k] } : Object.assign({}, window.__storage)),
        set: async (o) => { Object.assign(window.__storage, o); },
      } },
      runtime: { getPlatformInfo: async () => ({ os: "android" }) },
    };
    window.browser = api; window.chrome = api;` });
  await pop.goto(base + "/src/popup.html", { waitUntil: "load" });
  await pop.waitForTimeout(200);
  await pop.screenshot({ path: path.join(shotDir, "popup-enhance.png"), fullPage: true });
  await pop.close();
}

await browser.close();
server.close();
execFileSync("python3", ["-c", `
import glob, sys
from PIL import Image
files = sorted(glob.glob(${JSON.stringify(frames)} + "/f*.png"))
imgs = [Image.open(f).convert("RGB").quantize(colors=128, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE) for f in files]
imgs[0].save(${JSON.stringify(path.join(shotDir, "enhance-flow.gif"))}, save_all=True, append_images=imgs[1:], duration=100, loop=0, optimize=True)
`]);
fs.rmSync(frames, { recursive: true, force: true });
console.log("done");
