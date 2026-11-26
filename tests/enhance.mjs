// 視覚増強（選択範囲に斜め縞）の確認。計算、ページ上の描画、ポップアップを調べる。
// 使い方: node tests/enhance.mjs
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
const shotDir = path.join(root, "screenshots");
fs.mkdirSync(shotDir, { recursive: true });
const enhanceJs = fs.readFileSync(path.join(srcDir, "enhance.js"), "utf8");
const contentJs = enhanceJs + "\n" + fs.readFileSync(path.join(srcDir, "content.js"), "utf8");

let failed = 0;
let total = 0;
function check(name, cond, info) {
  total += 1;
  const pass = !!cond;
  if (!pass) failed += 1;
  console.log(`${pass ? "OK  " : "FAIL"}  ${name}${info === undefined ? "" : "  " + JSON.stringify(info).slice(0, 700)}`);
}

// ---------- 計算（ブラウザなし） ----------
await import(path.join(srcDir, "enhance.js"));
const E = globalThis.LineHalfMaskEnhance;
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

{
  // Android アプリ（視覚増強器 0.6.0）の Java 実装で、同じシードの値を出して控えたもの。
  const golden = [
    { t: 0, flow: 4.9149947, rot: -4.5445185, hue: 336.5304, px: 138.93222, py: 139.78122 },
    { t: 5, flow: 18.029488, rot: -4.442335, hue: 348.3186, px: 116.40318, py: 115.54922 },
    { t: 37.5, flow: 0.09901929, rot: -3.2160547, hue: 396.5375, px: 181.74303, py: 113.791725 },
    { t: 100, flow: -19.078012, rot: 4.5076137, hue: 525.3724, px: 156.7474, py: 74.79169 },
  ];
  const ok = golden.every((g) => {
    const [px, py] = E.pivotAt(g.t, 400, 200, 1);
    return near(E.flowSpeed(g.t, 1), g.flow, 1e-3) && near(E.rotSpeed(g.t, 1), g.rot, 1e-3) &&
      near(E.hueDeg(g.t, 1, 2), g.hue, 1e-2) && near(px, g.px, 1e-2) && near(py, g.py, 1e-2);
  });
  check("random drift, hue and pivot match the Android app's Java values (seed 1)", ok);

  const d = E.defaults();
  check("defaults follow the app: 3 px/s, 1 px, 8 px auto width, 0.5 °/s, 1×, 2 °/s hue",
    d.speed === 3 && d.width === 1 && d.autoWidth === 8 && d.rotSpeed === 0.5 && d.dist === 1 && d.hueRate === 2 &&
    d.auto === false && d.rotate === false && d.color === 0, d);

  const S = E.scales;
  check("slider scales: squared speed, cubic rotation and hue, log distance", S.speedFromProgress(1000) === 300 &&
    S.speedFromProgress(500) === 75 && near(S.rotFromProgress(1000), 90) && near(S.rotFromProgress(500), 11.25) &&
    near(S.distFromProgress(0), 0.1) && near(S.distFromProgress(1000), 5) && near(S.hueRateFromProgress(1000), 36),
    [S.speedFromProgress(500), S.rotFromProgress(500)]);
  check("slider scales round-trip", [0, 3, 75, 300].every((v) => S.speedFromProgress(S.progressFromSpeed(v)) === v) &&
    near(S.rotFromProgress(S.progressFromRot(0.5)), 0.5, 0.01) && near(S.distFromProgress(S.progressFromDist(1)), 1, 0.01) &&
    near(S.hueRateFromProgress(S.progressFromHueRate(2)), 2, 0.05));

  const n = E.normalize({ speed: 9999, width: 0, autoWidth: 1000, dir: -5, rotSpeed: -3, dist: 100, hueRate: 99, color: 7, auto: "yes", wander: 1 });
  check("normalize clamps and fixes types", n.speed === 300 && n.width === 1 && n.autoWidth === 64 && n.dir === -1 &&
    n.rotSpeed === 0 && n.dist === 5 && n.hueRate === 36 && n.color === 0 && n.auto === false && n.wander === false, n);
  const L = E.labels;
  check("labels in Japanese like the app", L.rot(0.5) === "30 °/分" && L.rot(30) === "30 °/秒" && L.rot(0) === "0 °/秒" &&
    L.hueRate(2) === "3 分で一周" && L.hueRate(36) === "10 秒で一周" && L.hueRate(0) === "固定" && L.dist(1) === "1×" &&
    L.autoHint(1) === "速さ -20〜20 px/秒、回転 -5〜5 °/秒", [L.rot(0.5), L.hueRate(2), L.autoHint(1)]);

  const pa = E.createMotion(Object.assign(E.defaults(), { speed: 10, width: 8 }), 1, 400, 300).pose;
  const p0 = pa(0), p1 = pa(1);
  check("manual forward flow moves offset by -speed (stripes go toward +normal, down-right)",
    near(p0.offset, 0) && near(p1.offset, 6) && near(p1.angle, Math.PI / 4), [p0, p1]);
  const rev = E.createMotion(Object.assign(E.defaults(), { speed: 10, width: 8, dir: -1 }), 1, 400, 300).pose;
  check("reverse flow moves offset by +speed", near(rev(1).offset, 10));
  const rot = E.createMotion(Object.assign(E.defaults(), { rotate: true, rotSpeed: 90, speed: 0 }), 1, 400, 300).pose;
  const ccw = E.createMotion(Object.assign(E.defaults(), { rotate: true, rotSpeed: 90, rotDir: -1, speed: 0 }), 1, 400, 300).pose;
  check("rotation is clockwise by default and reversible", near(rot(1).angle, Math.PI / 4 + Math.PI / 2) && near(ccw(1).angle, Math.PI / 4 - Math.PI / 2),
    [rot(0).angle, ccw(0).angle]);
  const rot2 = E.createMotion(Object.assign(E.defaults(), { rotate: true, rotSpeed: 90, speed: 0 }), 1, 400, 300).pose;
  const c = rot2(0.7);
  check("rotation without wander keeps the pivot at the region centre", near(c.px, 200) && near(c.py, 150), c);

  // 軸が動いても、縞が跳ねない（領域の隅の位相が 1/60 秒で 1 px 以上動かない）。
  const wm = E.createMotion(Object.assign(E.defaults(), { rotate: true, rotSpeed: 1, wander: true, speed: 0, width: 8 }), 7, 400, 300);
  let maxStep = 0, last = null, moved = 0;
  for (let i = 0; i <= 60 * 120; i++) {
    const p = wm.pose(i / 60);
    const ph = (0 - p.px) * Math.cos(p.angle) + (0 - p.py) * Math.sin(p.angle) + p.offset;
    const w = 16;
    if (last !== null) {
      let d = ((ph - last) % w + w) % w;
      if (d > w / 2) d -= w;
      maxStep = Math.max(maxStep, Math.abs(d));
    }
    last = ph;
    moved = Math.max(moved, Math.hypot(p.px - 200, p.py - 150));
  }
  check("wandering pivot moves and does not make the stripes jump", maxStep < 1 && moved > 20, { maxStep, moved });

  const am = (seed) => E.createMotion(Object.assign(E.defaults(), { auto: true }), seed, 400, 300);
  const a1 = am(3), a2 = am(3);
  const q1 = a1.pose(10), q2 = a2.pose(10);
  const q3 = a1.pose(120);
  check("auto mode is deterministic for a seed, uses width 8, rotates and wanders",
    q1.offset === q2.offset && q1.angle === q2.angle && q1.width === 8 && q3.angle !== q1.angle && q3.px !== q1.px, { q1, q3 });
  let flowMax = -1e9, flowMin = 1e9;
  for (let t = 0; t < 600; t += 0.5) { const f = E.flowSpeed(t, 5); flowMax = Math.max(flowMax, f); flowMin = Math.min(flowMin, f); }
  check("auto flow speed stays within ±20 px/s and reaches near the ends", flowMax <= 20 && flowMin >= -20 && flowMax > 15 && flowMin < -15, { flowMax, flowMin });

  // 点サンプリング: Java の StripePattern.color と同じ位相・帯の式
  const pose = { angle: 0.6, offset: 3.3, px: 20, py: 10, width: 5 };
  const w = 40, h = 30, x0 = 7, y0 = -4;
  const buf = new Uint32Array(w * h);
  E.fillBands(buf, w, h, x0, y0, pose, E.BLACK, E.WHITE);
  let bad = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ph = (x0 + x - pose.px) * Math.cos(pose.angle) + (y0 + y - pose.py) * Math.sin(pose.angle) + pose.offset;
      const band = Math.floor((ph + 1e-3) / pose.width);
      const want = (band & 1) === 0 ? E.BLACK : E.WHITE;
      if (buf[y * w + x] !== want) bad++;
    }
  }
  check("fillBands equals the app's point-sampled phase formula on every pixel", bad === 0, { bad });
  const black = E.colorAtHue(0), cyan = E.colorAtHue(180);
  check("colour mode uses pure HSV colours and their complement", black === 0xFF0000FF && cyan === 0xFFFFFF00 && E.colorAtHue(120) === 0xFF00FF00,
    [black.toString(16), cyan.toString(16)]);
}

// ---------- ページ上（Playwright Firefox） ----------
function startServer() {
  const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png" };
  const server = http.createServer((req, res) => {
    const raw = decodeURIComponent((req.url || "/").split("?")[0]);
    const file = path.normalize(path.join(root, raw.replace(/^\/+/, "")));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end("no"); return; }
    res.writeHead(200, { "Content-Type": mime[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}
const { server, base } = await startServer();
const browser = await firefox.launch();

async function openPage(viewport = { width: 800, height: 900 }, url = "/tests/sample.html") {
  const page = await browser.newPage({ viewport, hasTouch: true });
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  await page.goto(base + url, { waitUntil: "load" });
  await page.addScriptTag({ content: contentJs });
  await page.waitForFunction(() => window.__lineHalfMask);
  return page;
}

const selectPara = (page, id = "p-ja") => page.evaluate((id) => {
  const el = document.getElementById(id);
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  return true;
}, id);

// canvas の画素をまとめて読む。
const readCanvas = (page) => page.evaluate(() => {
  const c = document.getElementById("line-half-mask-enhance");
  if (!c) return null;
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  return { w: c.width, h: c.height, data: Array.from(d) };
});

function pixelAt(img, x, y) {
  const i = (y * img.w + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

// アプリと同じ式で、期待する色を返す（dpr 1）。
function expectedColor(info, x, y, c0, c1) {
  const p = info.pose;
  const ph = (x - info.ax - p.px) * Math.cos(p.angle) + (y - info.ay - p.py) * Math.sin(p.angle) + p.offset;
  const band = Math.floor((ph + 1e-3) / p.width);
  return (band & 1) === 0 ? c0 : c1;
}

const setCfg = (page, cfg) => page.evaluate((cfg) => window.__lineHalfMask.setEnhance(cfg), cfg);

{
  const page = await openPage();
  await selectPara(page);
  const started = await page.evaluate(() => {
    const ok = window.__lineHalfMask.enhanceSelection();
    return { ok, sel: getSelection().toString().length, state: window.__lineHalfMask.getState().enhanceOn };
  });
  check("enhanceSelection starts on a selection and clears the page highlight", started.ok === true && started.sel === 0 && started.state === true, started);
  const canvasInfo = await page.evaluate(() => {
    const c = document.getElementById("line-half-mask-enhance");
    const cs = getComputedStyle(c);
    return { pe: cs.pointerEvents, pos: cs.position, z: cs.zIndex, n: document.querySelectorAll("#line-half-mask-enhance").length, aria: c.getAttribute("aria-hidden") };
  });
  check("overlay is one fixed canvas with pointer-events none and top z-index", canvasInfo.pe === "none" && canvasInfo.pos === "fixed" && canvasInfo.z === "2147483647" && canvasInfo.n === 1 && canvasInfo.aria === "true", canvasInfo);

  await page.evaluate(() => window.__lineHalfMask.enhanceAt(0));
  let info = await page.evaluate(() => JSON.parse(JSON.stringify(window.__lineHalfMask.enhanceInfo())));
  let img = await readCanvas(page);
  let inside = 0, outside = 0, wrongInside = 0, wrongOutside = 0, odd = 0;
  const inRects = (x, y) => info.rects.some((r) => x >= Math.round(r.left) && x < Math.round(r.left + r.width) && y >= Math.round(r.top) && y < Math.round(r.top + r.height));
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const px = pixelAt(img, x, y);
      if (inRects(x, y)) {
        inside++;
        const want = expectedColor(info, x, y, 0, 255);
        if (px[3] !== 255 || px[0] !== want || px[1] !== want || px[2] !== want) wrongInside++;
        if (!(px[0] === 0 || px[0] === 255)) odd++;
      } else {
        outside++;
        if (px[3] !== 0) wrongOutside++;
      }
    }
  }
  check("every pixel of the selected lines is the app's black or white; outside stays transparent",
    inside > 100000 && wrongInside === 0 && wrongOutside === 0 && odd === 0, { inside, outside, wrongInside, wrongOutside, rects: info.rects.length });
  check("one rect per selected line (7 lines of 本文) matching the text boxes", info.rects.length === 7 && info.rects.every((r) => r.height > 30 && r.width > 500), info.rects);
  const hit = await page.evaluate((r) => {
    const el = document.elementFromPoint(r.left + 40, r.top + r.height / 2);
    return { tag: el && el.tagName, id: el && el.id };
  }, info.rects[2]);
  check("the stripes do not take clicks: the paragraph is under the pointer", hit.id === "p-ja", hit);

  // 動き: 開始から 1 秒後に、縞がアプリと同じだけ進んでいる。
  await setCfg(page, { speed: 10, width: 8 });
  await page.evaluate(() => window.__lineHalfMask.enhanceAt(1));
  info = await page.evaluate(() => JSON.parse(JSON.stringify(window.__lineHalfMask.enhanceInfo())));
  img = await readCanvas(page);
  let bad = 0;
  const r0 = info.rects[1];
  for (let y = Math.round(r0.top); y < Math.round(r0.top + r0.height); y += 3) {
    for (let x = Math.round(r0.left); x < Math.round(r0.left + r0.width); x += 3) {
      if (pixelAt(img, x, y)[0] !== expectedColor(info, x, y, 0, 255)) bad++;
    }
  }
  check("at 10 px/s with 8 px stripes, t = 1 s has offset 6 and matches the formula", near(info.pose.offset, 6) && info.pose.width === 8 && bad === 0, { offset: info.pose.offset, bad });

  // 実時間でも動く（rAF）。速さ 100 px/s で 0.4 秒後に画素が変わる。
  await setCfg(page, { speed: 100, width: 8 });
  const h1 = await page.evaluate(() => {
    const c = document.getElementById("line-half-mask-enhance");
    const d = c.getContext("2d").getImageData(60, 190, 80, 8).data;
    let s = ""; for (let i = 0; i < d.length; i += 4) s += d[i] ? "1" : "0"; return s;
  });
  await page.waitForTimeout(400);
  const h2 = await page.evaluate(() => {
    const c = document.getElementById("line-half-mask-enhance");
    const d = c.getContext("2d").getImageData(60, 190, 80, 8).data;
    let s = ""; for (let i = 0; i < d.length; i += 4) s += d[i] ? "1" : "0"; return s;
  });
  check("stripes move in real time", h1 !== h2 && h1.length === h2.length, { same: h1 === h2 });

  // 速さ 0 なら描き直さず、画素が変わらない。
  await setCfg(page, { speed: 0, width: 8 });
  const s1 = await readCanvas(page);
  await page.waitForTimeout(400);
  const s2 = await readCanvas(page);
  check("speed 0 leaves the picture still", s1.data.length === s2.data.length && s1.data.every((v, i) => v === s2.data[i]));

  // 色モード: 2 色だけで、色相が 180 度違う。
  await setCfg(page, { color: 1, hueRate: 2, speed: 0, width: 4 });
  await page.evaluate(() => window.__lineHalfMask.enhanceAt(0));
  info = await page.evaluate(() => JSON.parse(JSON.stringify(window.__lineHalfMask.enhanceInfo())));
  img = await readCanvas(page);
  const colors = new Map();
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] === 0) continue;
    const k = img.data[i] + "," + img.data[i + 1] + "," + img.data[i + 2];
    colors.set(k, (colors.get(k) || 0) + 1);
  }
  const keys = [...colors.keys()];
  const hexOf = (u) => [u & 255, (u >> 8) & 255, (u >> 16) & 255].join(",");
  const h = info.pose.hue;
  const wantA = hexOf(E.colorAtHue(h)), wantB = hexOf(E.colorAtHue(h + 180));
  check("colour mode paints exactly the complementary HSV pair for the current hue", keys.length === 2 && keys.includes(wantA) && keys.includes(wantB) && typeof h === "number", { keys, wantA, wantB, h });

  // 自動モード
  await setCfg(page, { auto: true, color: 0 });
  await page.evaluate(() => window.__lineHalfMask.enhanceAt(25));
  info = await page.evaluate(() => JSON.parse(JSON.stringify(window.__lineHalfMask.enhanceInfo())));
  check("auto mode: 8 px stripes, rotated away from 45 degrees, pivot wanders", info.pose.width === 8 && Math.abs(info.pose.angle - Math.PI / 4) > 0.01 && info.pose.rotating === true, info.pose);

  // 回転（時計回り 90°/s）
  await setCfg(page, { auto: false, rotate: true, rotSpeed: 90, speed: 0, width: 8 });
  await page.evaluate(() => window.__lineHalfMask.enhanceAt(0.5));
  info = await page.evaluate(() => JSON.parse(JSON.stringify(window.__lineHalfMask.enhanceInfo())));
  check("rotation: 90 °/s clockwise gives 45 + 45 degrees at 0.5 s", near(info.pose.angle, Math.PI / 2, 1e-6), info.pose);

  // 終わり方: 範囲の中のクリックでは続き、Esc で終わる
  await page.mouse.move(info.rects[2].left + 50, info.rects[2].top + 10);
  await page.mouse.down();
  await page.mouse.up();
  const stay = await page.evaluate(() => window.__lineHalfMask.getState().enhanceOn);
  check("a click inside the enhanced lines keeps the effect", stay === true);
  await page.keyboard.press("Escape");
  const afterEsc = await page.evaluate(() => ({ on: window.__lineHalfMask.getState().enhanceOn, canvas: !!document.getElementById("line-half-mask-enhance") }));
  check("Esc ends the effect and removes the canvas", afterEsc.on === false && afterEsc.canvas === false, afterEsc);

  await selectPara(page);
  await page.evaluate(() => window.__lineHalfMask.enhanceSelection());
  await page.mouse.click(790, 880);
  const afterOut = await page.evaluate(() => ({ on: window.__lineHalfMask.getState().enhanceOn, canvas: !!document.getElementById("line-half-mask-enhance") }));
  check("a click outside the enhanced lines ends the effect", afterOut.on === false && afterOut.canvas === false, afterOut);

  // タッチ: 範囲の外のタップで終わる
  await selectPara(page);
  await page.evaluate(() => window.__lineHalfMask.enhanceSelection());
  await page.evaluate(() => {
    const fire = (type, x, y) => {
      const t = new Touch({ identifier: 1, target: document.body, clientX: x, clientY: y });
      document.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === "touchend" ? [] : [t], changedTouches: [t], targetTouches: [] }));
    };
    fire("touchstart", 700, 850); fire("touchend", 700, 850);
  });
  const afterTap = await page.evaluate(() => window.__lineHalfMask.getState().enhanceOn);
  check("a tap outside the enhanced lines ends the effect (touch)", afterTap === false, afterTap);

  // 背面と排他: マスクを始めると視覚増強は終わる
  await selectPara(page);
  await page.evaluate(() => window.__lineHalfMask.enhanceSelection());
  await selectPara(page, "p-en");
  const both = await page.evaluate(() => {
    window.__lineHalfMask.maskSelection();
    const s = window.__lineHalfMask.getState();
    return { enh: s.enhanceOn, sel: s.selectionOn, enhCanvas: !!document.getElementById("line-half-mask-enhance") };
  });
  check("starting the half mask on a selection replaces the enhance effect", both.enh === false && both.sel === true && both.enhCanvas === false, both);
  await selectPara(page);
  const swapped = await page.evaluate(() => {
    window.__lineHalfMask.enhanceSelection();
    const s = window.__lineHalfMask.getState();
    return { enh: s.enhanceOn, sel: s.selectionOn };
  });
  check("starting enhance replaces the selection mask", swapped.enh === true && swapped.sel === false, swapped);
  const noSel = await page.evaluate(() => {
    window.__lineHalfMask.endEnhance();
    getSelection().removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
    return window.__lineHalfMask.enhanceSelection();
  });
  check("with the selection gone, the remembered one (within 60 s) is used", noSel === true);
  await page.close();
}

// 設定の変更が、動いている最中の効果に反映される
{
  const page = await openPage();
  await selectPara(page);
  await page.evaluate(() => window.__lineHalfMask.enhanceSelection());
  await setCfg(page, { speed: 0, width: 3, color: 1 });
  const cfg = await page.evaluate(() => window.__lineHalfMask.enhanceInfo().cfg);
  check("live settings update the running effect", cfg.width === 3 && cfg.color === 1 && cfg.speed === 0, cfg);
  await page.close();
}

// 選択がなければ何も始まらない
{
  const page = await openPage();
  const r = await page.evaluate(() => ({ ok: window.__lineHalfMask.enhanceSelection(), canvas: !!document.getElementById("line-half-mask-enhance") }));
  check("without any selection nothing starts", r.ok === false && r.canvas === false, r);
  await page.close();
}

// スクロールについてくる
{
  const page = await openPage({ width: 800, height: 420 });
  await selectPara(page, "p-ja");
  await page.evaluate(() => { window.__lineHalfMask.enhanceSelection(); window.__lineHalfMask.setEnhance({ speed: 0, width: 4 }); window.__lineHalfMask.enhanceAt(0); });
  const before = await page.evaluate(() => JSON.parse(JSON.stringify(window.__lineHalfMask.enhanceInfo())));
  const imgBefore = await readCanvas(page);
  await page.evaluate(() => scrollBy(0, 50));
  await page.waitForTimeout(250);
  const after = await page.evaluate(() => JSON.parse(JSON.stringify(window.__lineHalfMask.enhanceInfo())));
  const imgAfter = await readCanvas(page);
  const r = before.rects[0], r2 = after.rects[0];
  let same = true;
  for (let y = 0; y < Math.round(r.height); y += 1) {
    for (let x = 0; x < Math.round(r.width); x += 2) {
      const a = pixelAt(imgBefore, Math.round(r.left) + x, Math.round(r.top) + y);
      const b = pixelAt(imgAfter, Math.round(r2.left) + x, Math.round(r2.top) + y);
      if (a[0] !== b[0] || a[3] !== b[3]) same = false;
    }
  }
  check("scrolling moves the rects and the stripes stay fixed to the text (first line identical)",
    near(r.top - r2.top, 50, 1.01) && same, { moved: r.top - r2.top, same });
  await page.close();
}

// 長い選択でも、見えている行だけを描く
{
  const page = await openPage({ width: 800, height: 300 });
  await page.evaluate(() => scrollTo(0, document.getElementById("p-en").offsetTop - 20));
  await selectPara(page, "p-en");
  const r = await page.evaluate(() => {
    window.__lineHalfMask.enhanceSelection();
    const c = document.getElementById("line-half-mask-enhance");
    const rects = window.__lineHalfMask.enhanceInfo().rects;
    return { h: c.height, n: rects.length, minTop: Math.min(...rects.map((x) => x.top)), maxBottom: Math.max(...rects.map((x) => x.top + x.height)) };
  });
  check("long selections are drawn only inside the viewport", r.h === 300 && r.n > 0 && r.minTop >= 0 && r.maxBottom <= 300, r);
  await page.close();
}

// 描画の負荷: ページ全体を選んで 50 万画素を塗っても 1 フレームが短い
{
  const page = await openPage({ width: 1280, height: 900 });
  const t = await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.body);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    window.__lineHalfMask.enhanceSelection();
    window.__lineHalfMask.setEnhance({ speed: 0, width: 1 });
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) window.__lineHalfMask.enhanceAt(i * 0.1);
    const rects = window.__lineHalfMask.enhanceInfo().rects;
    return { ms: (performance.now() - t0) / 20, area: rects.reduce((a, r) => a + r.width * r.height, 0) };
  });
  check("painting over 500,000 pixels takes under 25 ms per frame", t.area > 500000 && t.ms < 25, t);
  await page.close();
}

// ---------- ポップアップ ----------
{
  const stubScript = (os) => `
    window.__storage = {};
    window.__sets = [];
    window.__messages = [];
    window.__enhanceOn = false;
    const api = {
      tabs: {
        query: async () => [{ id: 1 }],
        sendMessage: async (_id, msg) => {
          window.__messages.push(msg.type);
          if (msg.type === "enhanceSelection") { window.__enhanceOn = !!window.__hasSelection; return { ok: !!window.__hasSelection, enhanceOn: window.__enhanceOn }; }
          if (msg.type === "endEnhance") { window.__enhanceOn = false; return { enhanceOn: false }; }
          return { on: false, parity: 0, enhanceOn: window.__enhanceOn };
        },
      },
      storage: { local: {
        get: async (k) => (typeof k === "string" ? { [k]: window.__storage[k] } : Object.assign({}, window.__storage)),
        set: async (o) => { Object.assign(window.__storage, o); window.__sets.push(o); },
      } },
      runtime: { getPlatformInfo: async () => ({ os: ${JSON.stringify(os)} }) },
    };
    window.browser = api; window.chrome = api;
  `;
  for (const os of ["linux", "android"]) {
    const page = await browser.newPage({ viewport: { width: 320, height: 1500 } });
    await page.addInitScript({ content: stubScript(os) });
    await page.goto(base + "/src/popup.html", { waitUntil: "load" });
    await page.waitForTimeout(150);
    const ui = await page.evaluate(() => {
      const txt = (id) => document.getElementById(id).textContent;
      return {
        btn: document.getElementById("enhance-selection").textContent,
        speed: txt("enh-speed-v"), width: txt("enh-width-v"), rot: txt("enh-rot-v"), hue: txt("enh-hue-v"), dist: txt("enh-dist-v"), hint: txt("enh-hint"),
        autoPanelHidden: document.getElementById("enh-auto-panel").hidden,
        manualHidden: document.getElementById("enh-manual-panel").hidden,
        rotHidden: document.getElementById("enh-rot-panel").hidden,
        colorHidden: document.getElementById("enh-color-panel").hidden,
        dir: document.querySelector('input[name="enh-dir"]:checked').value,
        rotdir: document.querySelector('input[name="enh-rotdir"]:checked').value,
        color: document.querySelector('input[name="enh-color"]:checked').value,
        text: document.body.innerText,
      };
    });
    check(`popup (${os}): defaults shown like the app`, ui.btn === "選択範囲に視覚増強" && ui.speed === "速さ 3 px/秒" && ui.width === "縞の幅 1 px" &&
      ui.dist === "変化の大きさ 1×" && ui.autoPanelHidden && !ui.manualHidden && ui.rotHidden && ui.colorHidden && ui.dir === "1" && ui.rotdir === "1" && ui.color === "0", ui);
    check(`popup (${os}): no ellipses in the UI text`, !/[…]|\.\.\./.test(ui.text), null);

    await page.fill("#enh-width", "20").catch(() => {});
    await page.evaluate(() => {
      const el = document.getElementById("enh-width"); el.value = "20"; el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.evaluate(() => {
      const el = document.getElementById("enh-speed"); el.value = "1000"; el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.click("#enh-rotate");
    await page.evaluate(() => {
      const el = document.getElementById("enh-rot"); el.value = "1000"; el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.click('input[name="enh-rotdir"][value="-1"]');
    await page.click("#enh-wander");
    await page.click('input[name="enh-dir"][value="-1"]');
    await page.click('input[name="enh-color"][value="1"]');
    await page.evaluate(() => {
      const el = document.getElementById("enh-hue"); el.value = "1000"; el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForTimeout(100);
    const saved = await page.evaluate(() => window.__storage.enhance);
    check(`popup (${os}): settings are saved as one enhance object`,
      saved && saved.width === 20 && saved.speed === 300 && saved.rotate === true && saved.rotSpeed === 90 && saved.rotDir === -1 &&
      saved.wander === true && saved.dir === -1 && saved.color === 1 && saved.hueRate === 36 && saved.auto === false, saved);

    await page.click("#enh-auto");
    await page.evaluate(() => {
      const el = document.getElementById("enh-dist"); el.value = "1000"; el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForTimeout(100);
    const auto = await page.evaluate(() => ({
      s: window.__storage.enhance,
      manualHidden: document.getElementById("enh-manual-panel").hidden,
      autoHidden: document.getElementById("enh-auto-panel").hidden,
      width: document.getElementById("enh-width-v").textContent,
      dist: document.getElementById("enh-dist-v").textContent,
      hint: document.getElementById("enh-hint").textContent,
    }));
    check(`popup (${os}): auto mode swaps the panels, keeps a separate width (8) and the 5× hint`,
      auto.s.auto === true && auto.s.width === 20 && auto.s.autoWidth === 8 && auto.s.dist === 5 && auto.manualHidden && !auto.autoHidden &&
      auto.width === "縞の幅 8 px" && auto.dist === "変化の大きさ 5×" && auto.hint === "速さ -100〜100 px/秒、回転 -25〜25 °/秒", auto);

    // ボタン: 選択がなければ案内、あれば始めて「止める」に変わる
    const noSelMsg = await page.evaluate(async () => {
      window.__hasSelection = false;
      document.getElementById("enhance-selection").click();
      await new Promise((r) => setTimeout(r, 100));
      return document.getElementById("status").textContent;
    });
    const started = await page.evaluate(async () => {
      window.__hasSelection = true;
      document.getElementById("enhance-selection").click();
      await new Promise((r) => setTimeout(r, 100));
      return { label: document.getElementById("enhance-selection").textContent, status: document.getElementById("status").textContent };
    });
    const stopped = await page.evaluate(async () => {
      document.getElementById("enhance-selection").click();
      await new Promise((r) => setTimeout(r, 150));
      return { label: document.getElementById("enhance-selection").textContent, msgs: window.__messages.filter((m) => /nhance/.test(m)) };
    });
    check(`popup (${os}): the button asks for a selection, starts, then stops`,
      noSelMsg === "先にページの文字を選択してください" && started.label === "視覚増強を止める" && stopped.label === "選択範囲に視覚増強" &&
      stopped.msgs.join(",") === "enhanceSelection,enhanceSelection,endEnhance", { noSelMsg, started, stopped });
    await page.close();
  }

  // 保存済みの設定を開いたとき
  const page = await browser.newPage({ viewport: { width: 320, height: 1500 } });
  await page.addInitScript({ content: stubScript("linux") + `window.__storage.enhance = { auto: false, speed: 75, width: 5, rotate: true, rotSpeed: 0.5, color: 1, hueRate: 2 };` });
  await page.goto(base + "/src/popup.html", { waitUntil: "load" });
  await page.waitForTimeout(150);
  const loaded = await page.evaluate(() => ({
    speed: document.getElementById("enh-speed-v").textContent, rot: document.getElementById("enh-rot-v").textContent,
    hue: document.getElementById("enh-hue-v").textContent, rotHidden: document.getElementById("enh-rot-panel").hidden,
    colorHidden: document.getElementById("enh-color-panel").hidden, width: document.getElementById("enh-width-v").textContent,
  }));
  check("popup shows saved settings", loaded.speed === "速さ 75 px/秒" && loaded.rot === "回転の速さ 30 °/分" && loaded.hue === "色の変化の速さ 3 分で一周" &&
    !loaded.rotHidden && !loaded.colorHidden && loaded.width === "縞の幅 5 px", loaded);
  await page.close();
}

await browser.close();
server.close();
console.log(`\n${total - failed}/${total} passed`);
if (failed) process.exit(1);
