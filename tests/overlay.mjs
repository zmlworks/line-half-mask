// 統合した重ね描き（黒塗り／視覚増強 × 範囲）と、範囲を選ぶ窓の確認。スクリーンショットも作る。
// 使い方: node tests/overlay.mjs
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
const contentJs = fs.readFileSync(path.join(srcDir, "enhance.js"), "utf8") + "\n" + fs.readFileSync(path.join(srcDir, "content.js"), "utf8");

let failed = 0;
let total = 0;
function check(name, cond, info) {
  total += 1;
  const pass = !!cond;
  if (!pass) failed += 1;
  console.log(`${pass ? "OK  " : "FAIL"}  ${name}${info === undefined ? "" : "  " + JSON.stringify(info).slice(0, 600)}`);
}

function startServer() {
  const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
  const server = http.createServer((req, res) => {
    const file = path.normalize(path.join(root, decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\/+/, "")));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end("no"); return; }
    res.writeHead(200, { "Content-Type": mime[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}
const { server, base } = await startServer();
const browser = await firefox.launch();

// 拡張の API の代わり。保存された設定と、あとからの変更をページへ流す。
const storageStub = (initial) => `
  window.__store = ${JSON.stringify(initial)};
  window.__changeListeners = [];
  const api = {
    storage: {
      local: {
        get: async (keys) => { const o = {}; for (const k of keys) if (k in window.__store) o[k] = window.__store[k]; return o; },
        set: async (obj) => { Object.assign(window.__store, obj); },
      },
      onChanged: { addListener: (fn) => window.__changeListeners.push(fn) },
    },
    runtime: { sendMessage: () => Promise.resolve(), onMessage: { addListener() {} } },
  };
  window.browser = api; window.chrome = api;
  window.__fireChange = (changes) => window.__changeListeners.forEach((fn) => fn(changes, "local"));
`;

async function openPage(opts = {}) {
  const page = await browser.newPage({ viewport: opts.viewport || { width: 800, height: 640 } });
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  if (opts.stub) await page.addInitScript({ content: storageStub(opts.stub) });
  await page.goto(base + (opts.url || "/tests/sample.html"), { waitUntil: "load" });
  await page.addScriptTag({ content: contentJs });
  await page.waitForFunction(() => window.__lineHalfMask);
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.id = "probe";
    input.style.cssText = "position:absolute;left:600px;top:4px;width:120px";
    window.__keys = [];
    input.addEventListener("keydown", (e) => window.__keys.push(e.key));
    document.body.appendChild(input);
  });
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

const api = (page, fn, arg) => page.evaluate(fn, arg);
const state = (page) => page.evaluate(() => window.__lineHalfMask.getState());
const pickerInfo = (page) => page.evaluate(() => {
  const h = document.getElementById("line-half-mask-picker");
  if (!h) return null;
  const sr = h.shadowRoot;
  const r = sr.firstChild.getBoundingClientRect();
  return {
    labels: [...sr.querySelectorAll("button")].map((b) => b.textContent),
    checked: [...sr.querySelectorAll('[aria-checked="true"]')].map((b) => b.dataset.coverage),
    rect: { left: r.left, top: r.top, width: r.width, height: r.height },
    focused: sr.activeElement ? sr.activeElement.textContent : null,
    activeId: document.activeElement && document.activeElement.id,
  };
});
const readMasks = (page) => page.evaluate(() => window.__lineHalfMask.collect().map((m) => ({ left: m.left, top: m.top, width: m.width, height: m.height })));

// canvas を読んで、期待する四角の内側だけが塗られているかを調べる。
async function paintReport(page, rects) {
  return page.evaluate((rects) => {
    const c = document.getElementById("line-half-mask-root");
    const w = c.width, h = c.height;
    const d = c.getContext("2d").getImageData(0, 0, w, h).data;
    const dpr = w / innerWidth;
    let inside = 0, filled = 0, outside = 0, odd = 0;
    const near = (x, y, grow) => rects.some((r) => x >= r.left * dpr - grow && x < (r.left + r.width) * dpr + grow && y >= r.top * dpr - grow && y < (r.top + r.height) * dpr + grow);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const a = d[(y * w + x) * 4 + 3];
        if (a > 0 && !near(x, y, 1.5)) outside++;
        if (near(x, y, -1.5) ) { inside++; if (a >= 250) filled++; }
      }
    }
    return { inside, filled, outside, painted: rects.length > 0 };
  }, rects);
}

// ---------- 範囲 × 塗り ----------
const COVERAGES = ["full", "top", "bottom", "off"];
for (const fill of ["black", "enhance"]) {
  const page = await openPage();
  await selectPara(page);
  await page.evaluate((fill) => { window.__lineHalfMask.overlaySelection({ fill }); window.__lineHalfMask.setEnhance({ speed: 0, width: 6, color: 0 }); }, fill);
  const lines = await page.evaluate(() => window.__lineHalfMask.collectSelectionLines().map((l) => ({ top: l.top, bottom: l.bottom, left: l.left, right: l.right })));
  for (const cov of COVERAGES) {
    await page.evaluate(([cov]) => { const a = window.__lineHalfMask; a.setSelCoverage(cov); a.pause(true); if (a.fxInfo()) a.showAt(1); }, [cov]);
    await page.waitForTimeout(30);
    const masks = await readMasks(page);
    const rep = await paintReport(page, masks);
    const canvases = await page.evaluate(() => document.querySelectorAll("canvas[id^=line-half-mask]").length);
    const heightOk = masks.every((m, i) => {
      const lh = lines[i].bottom - lines[i].top;
      return cov === "full" ? Math.abs(m.height - lh) < 1 : Math.abs(m.height - lh * 0.5) < 1;
    });
    const sideOk = masks.every((m, i) => {
      if (cov === "top") return Math.abs(m.top - lines[i].top) < 1;
      if (cov === "bottom") return Math.abs(m.top + m.height - lines[i].bottom) < 1;
      return true;
    });
    if (cov === "off") {
      check(`${fill} × off: nothing is painted and nothing is left over`, masks.length === 0 && rep.outside === 0, rep);
    } else {
      check(`${fill} × ${cov}: ${lines.length} lines, geometry matches, interior fully painted, nothing outside`,
        masks.length === lines.length && heightOk && sideOk && rep.inside > 5000 && rep.filled / rep.inside > 0.985 && rep.outside === 0 && canvases === 1,
        { n: masks.length, lines: lines.length, heightOk, sideOk, rep, canvases });
    }
    await page.screenshot({ path: path.join(shotDir, `overlay-${fill}-${cov}.png`), clip: { x: 0, y: 120, width: 800, height: 400 } });
  }
  await page.close();
}

// ---------- ページ全体で視覚増強の塗り（同じ仕組みで動く） ----------
{
  const page = await openPage();
  await page.evaluate(() => { const a = window.__lineHalfMask; a.setFill("enhance"); a.setEnhance({ speed: 0, width: 6 }); a.start(); a.pause(true); a.showAt(0.5); });
  const info = await page.evaluate(() => JSON.parse(JSON.stringify(window.__lineHalfMask.fxInfo())));
  const all = await page.evaluate(() => window.__lineHalfMask.collect().length);
  const canvases = await page.evaluate(() => [...document.querySelectorAll("canvas")].map((c) => c.id));
  const img = await page.evaluate(() => {
    const c = document.getElementById("line-half-mask-root");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let opaque = 0, odd = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue;
      opaque++;
      const v = (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 0) || (d[i] === 255 && d[i + 1] === 255 && d[i + 2] === 255);
      if (!v) odd++;
    }
    return { opaque, odd, w: c.width, h: c.height };
  });
  check("page-wide mask with the enhance fill: field is the whole viewport, one window per half line, crisp black/white pixels",
    info.ax === 0 && info.ay === 0 && info.box.w === img.w && info.box.h === img.h && info.rects.length === all && all > 10 && img.opaque > 20000 && img.odd === 0 && canvases.join() === "line-half-mask-root",
    { box: info.box, img, all, canvases });
  await page.screenshot({ path: path.join(shotDir, "overlay-enhance-pagewide.png") });
  const swapped = await page.evaluate(() => { const a = window.__lineHalfMask; const before = a.collect().map((m) => m.coverTop).join(); a.swap(); return { before, after: a.collect().map((m) => m.coverTop).join() }; });
  check("page-wide parity swap still alternates halves with the enhance fill", swapped.before !== swapped.after && /true/.test(swapped.before) && /false/.test(swapped.before), swapped);
  await page.evaluate(() => window.__lineHalfMask.stop());
  check("stopping removes the canvas", await page.evaluate(() => !document.getElementById("line-half-mask-root")));
  await page.close();
}

// ---------- 範囲を選ぶ窓 ----------
{
  const page = await openPage();
  await page.evaluate(() => document.getElementById("probe").focus());
  await selectPara(page);
  await page.evaluate(() => { const a = window.__lineHalfMask; a.overlaySelection({ fill: "black", picker: true }); a.pause(true); });
  await page.waitForTimeout(40);
  let p = await pickerInfo(page);
  const boxes = await readMasks(page);
  const lastBottom = Math.max(...boxes.map((b) => b.top + b.height));
  check("picker opens with 行全体 selected; labels are 行全体 オフ 上半分 下半分",
    p && p.labels.join() === "行全体,オフ,上半分,下半分" && p.checked.join() === "full", p);
  check("picker sits just below the last selected line and inside the viewport",
    p && p.rect.top >= lastBottom && p.rect.top - lastBottom < 24 && p.rect.left >= 0 && p.rect.left + p.rect.width <= 800 && p.rect.top + p.rect.height <= 640, { rect: p && p.rect, lastBottom });
  check("opening the picker does not move focus (the input in the page keeps it)", p && p.activeId === "probe" && p.focused === null, p);
  await page.screenshot({ path: path.join(shotDir, "picker-open.png"), clip: { x: 0, y: 120, width: 800, height: 520 } });

  // 矢印キー: 2×2 の並び（行全体 オフ / 上半分 下半分）の上下左右
  const press = async (k) => { await page.keyboard.press(k); await page.waitForTimeout(30); return (await pickerInfo(page)).checked.join(); };
  const order = [];
  order.push(await press("ArrowDown"));  // 行全体 → 上半分
  order.push(await press("ArrowRight")); // 上半分 → 下半分
  order.push(await press("ArrowUp"));    // 下半分 → オフ
  order.push(await press("ArrowLeft"));  // オフ → 行全体
  check("arrow keys move through the 2×2 grid (↓ top, → bottom, ↑ off, ← full)", order.join() === "top,bottom,off,full", order);
  const edge = [await press("ArrowUp"), await press("ArrowLeft"), await press("ArrowRight"), await press("ArrowRight")];
  check("arrow keys stop at the grid edge (no wrap)", edge.join() === "full,full,off,off", edge);
  await press("ArrowLeft");
  // 実際の描画が追従する（ライブプレビュー）
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(30);
  let m = await readMasks(page);
  const lines = await page.evaluate(() => window.__lineHalfMask.collectSelectionLines().map((l) => ({ top: l.top, bottom: l.bottom })));
  check("live preview: ↓ immediately paints only the top half of every line", m.length === lines.length && m.every((x, i) => Math.abs(x.top - lines[i].top) < 1 && Math.abs(x.height - (lines[i].bottom - lines[i].top) / 2) < 1), { n: m.length });
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(30);
  m = await readMasks(page);
  check("live preview: → immediately paints only the bottom half of every line", m.length === lines.length && m.every((x, i) => Math.abs(x.top + x.height - lines[i].bottom) < 1 && Math.abs(x.height - (lines[i].bottom - lines[i].top) / 2) < 1), { n: m.length });
  await page.screenshot({ path: path.join(shotDir, "picker-bottom.png"), clip: { x: 0, y: 120, width: 800, height: 520 } });
  check("arrow keys are consumed while the picker is open (the page's input saw none)", (await page.evaluate(() => window.__keys.length)) === 0, await page.evaluate(() => window.__keys));
  await page.keyboard.press("a");
  check("other keys still reach the page while the picker is open", (await page.evaluate(() => document.getElementById("probe").value)) === "a");

  // マウス: ボタンを押すと切り替わり、フォーカスもページの選択も動かない
  await page.evaluate(() => { document.getElementById("probe").focus(); });
  const btn = async (v) => page.evaluate((v) => {
    const b = document.getElementById("line-half-mask-picker").shadowRoot.querySelector(`[data-coverage="${v}"]`);
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, v);
  let pt = await btn("off");
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(30);
  p = await pickerInfo(page);
  check("clicking オフ selects it, paints nothing, and keeps the picker and the overlay", p && p.checked.join() === "off" && (await readMasks(page)).length === 0 && (await state(page)).selectionOn === true, p && p.checked);
  check("clicking a picker button keeps focus on the page's input", p && p.activeId === "probe" && p.focused === null, p);
  pt = await btn("top");
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(30);
  m = await readMasks(page);
  check("clicking 上半分 paints the top halves", m.length === lines.length && m.every((x, i) => Math.abs(x.top - lines[i].top) < 1 && x.height < 30), { n: m.length });
  pt = await btn("full");
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(30);

  // スクロールに付いてくる
  const before = (await pickerInfo(page)).rect;
  await page.mouse.wheel(0, 40);
  await page.waitForTimeout(200);
  const afterScroll = (await pickerInfo(page)).rect;
  check("the picker follows the lines when the page scrolls", Math.abs((before.top - afterScroll.top) - 40) < 2, { before, afterScroll });
  await page.mouse.wheel(0, -40);
  await page.waitForTimeout(150);

  // Enter で窓だけ閉じ、重ねは残る。次の Esc で重ねも終わる
  await page.keyboard.press("Enter");
  await page.waitForTimeout(30);
  check("Enter closes the picker and keeps the overlay and the choice", (await pickerInfo(page)) === null && (await state(page)).selectionOn === true && (await state(page)).coverage === "full");
  await page.keyboard.press("ArrowDown");
  check("with the picker closed, arrow keys go back to the page", (await page.evaluate(() => window.__keys.slice(-1)[0])) === "ArrowDown");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(30);
  const ended = await page.evaluate(() => ({
    sel: window.__lineHalfMask.getState().selectionOn,
    canvas: !!document.getElementById("line-half-mask-root"),
    picker: !!document.getElementById("line-half-mask-picker"),
  }));
  check("Esc (picker closed) ends the overlay and removes the canvas", ended.sel === false && !ended.canvas && !ended.picker, ended);
  // 後始末: キーを奪わない
  const after = await page.evaluate(() => {
    const ev = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    const notPrevented = window.dispatchEvent(ev);
    const ev2 = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    return { notPrevented, esc: window.dispatchEvent(ev2) };
  });
  check("after the overlay ends no key handler is left behind", after.notPrevented && after.esc, after);
  await page.close();
}

{
  // Esc で窓を閉じる→もう一度 Esc で終わる。窓の外のクリックで両方終わる。
  const page = await openPage();
  await selectPara(page);
  await page.evaluate(() => window.__lineHalfMask.overlaySelection({ fill: "enhance", picker: true }));
  await page.waitForTimeout(30);
  await page.keyboard.press("Escape");
  const a = await page.evaluate(() => ({ picker: !!document.getElementById("line-half-mask-picker"), sel: window.__lineHalfMask.getState().selectionOn }));
  check("Esc closes only the picker first", a.picker === false && a.sel === true, a);
  await selectPara(page);
  await page.evaluate(() => window.__lineHalfMask.overlaySelection({ fill: "black", picker: true }));
  await page.waitForTimeout(30);
  await page.mouse.click(780, 600);
  await page.waitForTimeout(30);
  const b = await page.evaluate(() => ({ picker: !!document.getElementById("line-half-mask-picker"), sel: window.__lineHalfMask.getState().selectionOn, canvas: !!document.getElementById("line-half-mask-root") }));
  check("clicking outside the lines ends the overlay and removes the picker and canvas", !b.picker && !b.sel && !b.canvas, b);
  // 選択行の中のクリックは窓だけ閉じて重ねは続く
  await selectPara(page);
  await page.evaluate(() => window.__lineHalfMask.overlaySelection({ fill: "black", picker: true }));
  const first = (await readMasks(page))[0];
  await page.mouse.click(first.left + 20, first.top + first.height / 2);
  await page.waitForTimeout(30);
  const c = await page.evaluate(() => ({ picker: !!document.getElementById("line-half-mask-picker"), sel: window.__lineHalfMask.getState().selectionOn }));
  check("clicking inside a selected line closes the picker and keeps the overlay", !c.picker && c.sel, c);
  await page.close();
}

{
  // 画面の下の方で選んだときは、窓を行の上に出す。
  const page = await openPage({ viewport: { width: 800, height: 640 } });
  await selectPara(page, "p-mix");
  await page.evaluate(() => { document.getElementById("p-mix").scrollIntoView({ block: "end" }); });
  await page.waitForTimeout(100);
  await page.evaluate(() => window.__lineHalfMask.overlaySelection({ fill: "black", picker: true }));
  await page.waitForTimeout(60);
  const p = await pickerInfo(page);
  const boxes = await readMasks(page);
  const firstTop = Math.min(...boxes.map((b) => b.top)), lastBottom = Math.max(...boxes.map((b) => b.top + b.height));
  check("near the bottom of the viewport the picker stays fully visible", p && p.rect.top >= 0 && p.rect.top + p.rect.height <= 640 && p.rect.left >= 0 && p.rect.left + p.rect.width <= 800, { rect: p && p.rect, firstTop, lastBottom });
  await page.screenshot({ path: path.join(shotDir, "picker-bottom-edge.png") });
  await page.close();
}

// ---------- 保存された設定（拡張の storage）に従う ----------
{
  const page = await openPage({ stub: { fill: "enhance", coverage: "top" } });
  await page.waitForTimeout(100);
  await selectPara(page);
  await page.evaluate(() => window.__lineHalfMask.overlaySelection());
  let s = await state(page);
  check("stored fill and coverage are the defaults for a new overlay", s.fill === "enhance" && s.coverage === "top" && s.selectionOn, s);
  await page.evaluate(() => window.__fireChange({ coverage: { newValue: "bottom" } }));
  s = await state(page);
  check("changing the stored coverage updates the running overlay at once", s.coverage === "bottom", s);
  await page.evaluate(() => window.__fireChange({ fill: { newValue: "black" } }));
  s = await state(page);
  check("changing the stored fill switches the running overlay's fill", s.fill === "black" && !(await page.evaluate(() => window.__lineHalfMask.fxInfo())), s);
  await page.evaluate(() => window.__fireChange({ coverage: { newValue: "nonsense" } }));
  s = await state(page);
  check("an unknown coverage value falls back to 行全体", s.coverage === "full", s);
  await page.close();
}

{
  // 古い保存値（キーが無い）でもそのまま動く: 既定は 黒塗り / 行全体。
  const page = await openPage({ stub: { ratio: 50 } });
  await page.waitForTimeout(100);
  await selectPara(page);
  await page.evaluate(() => window.__lineHalfMask.overlaySelection());
  const s = await state(page);
  check("with no stored fill or coverage the defaults are 黒塗り and 行全体", s.fill === "black" && s.coverage === "full", s);
  await page.close();
}

// ---------- 何もしていないページへの負荷 ----------
// 比べる相手は、何もしないスクリプトを同じ手順で読み込んだページ（Playwright 自身の観測者を除くため）。
{
  const counters = `
    window.__raf = 0; window.__timers = 0; window.__mo = 0; window.__lis = 0;
    const orig = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => { window.__raf++; return orig(cb); };
    const si = window.setInterval.bind(window); window.setInterval = (...a) => { window.__timers++; return si(...a); };
    const OM = window.MutationObserver; window.MutationObserver = class extends OM { constructor(cb) { super(cb); window.__mo++; } };
    for (const t of [window, document]) { const o = t.addEventListener.bind(t); t.addEventListener = (type, ...r) => { if (type !== "selectionchange" && type !== "contextmenu") window.__lis++; return o(type, ...r); }; }
  `;
  async function idleCounts(script) {
    const page = await browser.newPage({ viewport: { width: 800, height: 640 } });
    await page.addInitScript({ content: counters });
    await page.goto(base + "/tests/sample.html", { waitUntil: "load" });
    await page.addScriptTag({ content: script });
    await page.waitForFunction(() => window.__lineHalfMask);
    await page.waitForTimeout(1500);
    const r = await page.evaluate(() => ({ raf: window.__raf, timers: window.__timers, mo: window.__mo, lis: window.__lis }));
    return { page, r };
  }
  const control = await idleCounts("window.__lineHalfMask = {};");
  await control.page.close();
  const real = await idleCounts(contentJs);
  const idle = real.r;
  check("a page with the add-on loaded but unused adds no rAF loop, timers, observers or scroll/resize/key/mouse listeners (same as an empty script)",
    idle.raf === control.r.raf && idle.timers === 0 && idle.mo === control.r.mo && idle.lis === control.r.lis, { idle, control: control.r });
  const page = real.page;
  await selectPara(page);
  await page.evaluate(() => window.__lineHalfMask.overlaySelection({ fill: "black", picker: true }));
  await page.waitForTimeout(100);
  await page.evaluate(() => window.__lineHalfMask.endSelection());
  await page.waitForTimeout(200);
  const r0 = await page.evaluate(() => window.__raf);
  await page.waitForTimeout(800);
  const r1 = await page.evaluate(() => window.__raf);
  check("after an overlay ends, the rAF loop is gone again", r1 === r0, { r0, r1 });
  await page.close();
}

await browser.close();
server.close();
console.log(`\n${total - failed}/${total} passed`);
if (failed) process.exit(1);
