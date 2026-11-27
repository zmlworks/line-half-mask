// Playwright Firefox で、通し番号・各行ちょうど半分・入れ替え・3本指タップを確認し、画面を撮る。
// 使い方: node tests/test.mjs
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { execFileSync } from "child_process";
import os from "os";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) candidates.push(process.env.PLAYWRIGHT_MODULE);
  candidates.push("playwright");
  candidates.push("/workspace/ff-tools/node_modules/playwright/index.js");
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
const contentJs = fs.readFileSync(path.join(srcDir, "enhance.js"), "utf8") + "\n" +
  fs.readFileSync(path.join(srcDir, "content.js"), "utf8");
fs.mkdirSync(shotDir, { recursive: true });

const TOL = 1.25;
const results = [];
let failed = 0;

function check(name, cond, info) {
  const pass = !!cond;
  results.push({ name, pass, info: info === undefined ? null : info });
  if (!pass) failed += 1;
  const mark = pass ? "OK" : "FAIL";
  const extra = info === undefined ? "" : "  " + JSON.stringify(info);
  console.log(`${mark}  ${name}${extra}`);
}

function startServer() {
  const mime = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
  };
  const server = http.createServer((req, res) => {
    const raw = decodeURIComponent((req.url || "/").split("?")[0]);
    const rel = raw === "/" ? "/tests/sample.html" : raw;
    const file = path.normalize(path.join(root, rel.replace(/^\/+/, "")));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": mime[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/tests/sample.html` });
    });
  });
}

function mid(line) {
  return (line.top + line.bottom) / 2;
}

function coverTopForIndex(index, parity) {
  const odd = (index % 2) === 0;
  return odd ? parity === 1 : parity === 0;
}

function expectedMasks(lines, parity, viewport, ratio = 50) {
  const out = [];
  const vw = viewport || { left: 0, top: 0, right: Infinity, bottom: Infinity };
  const frac = ratio / 100;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = line.bottom - line.top;
    const coverTop = coverTopForIndex(i, parity);
    const rawTop = coverTop ? line.top : line.top + h * (1 - frac);
    const rawBottom = coverTop ? line.top + h * frac : line.bottom;
    const top = Math.max(rawTop, vw.top);
    const bottom = Math.min(rawBottom, vw.bottom);
    const left = Math.max(line.left, vw.left);
    const right = Math.min(line.right, vw.right);
    if (bottom - top < 0.5 || right - left < 0.5) continue;
    out.push({ top, bottom, left, right, index: i, coverTop });
  }
  return out;
}

function fixedMasks(lines, part, viewport, ratio = 50) {
  const out = [];
  const vw = viewport || { left: 0, top: 0, right: Infinity, bottom: Infinity };
  const frac = ratio / 100;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = line.bottom - line.top;
    const rawTop = part === "bottom" ? line.top + h * (1 - frac) : line.top;
    const rawBottom = part === "top" ? line.top + h * frac : line.bottom;
    const top = Math.max(rawTop, vw.top);
    const bottom = Math.min(rawBottom, vw.bottom);
    const left = Math.max(line.left, vw.left);
    const right = Math.min(line.right, vw.right);
    if (bottom - top < 0.5 || right - left < 0.5) continue;
    out.push({ top, bottom, left, right, index: i });
  }
  return out;
}
function matchMasks(actual, expected) {
  if (actual.length !== expected.length) {
    return { ok: false, reason: "count", actual: actual.length, expected: expected.length };
  }
  const leftover = actual.slice();
  const diffs = [];
  for (const exp of expected) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < leftover.length; i++) {
      const d = Math.abs(leftover[i].top - exp.top) + Math.abs(leftover[i].bottom - exp.bottom);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const got = leftover.splice(best, 1)[0];
    const dt = Math.abs(got.top - exp.top);
    const db = Math.abs(got.bottom - exp.bottom);
    const dl = Math.abs(got.left - exp.left);
    const dr = Math.abs(got.right - exp.right);
    diffs.push({ dt, db, dl, dr });
    if (dt > TOL || db > TOL || dl > TOL || dr > TOL) {
      return { ok: false, reason: "geometry", exp, got, diffs: { dt, db, dl, dr } };
    }
  }
  const max = diffs.reduce((m, d) => Math.max(m, d.dt, d.db, d.dl, d.dr), 0);
  return { ok: true, maxDelta: max };
}

const measureFn = () => {
  function sameLine(a, b) {
    const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    const minH = Math.min(a.bottom - a.top, b.bottom - b.top);
    return minH > 0 && overlap > minH * 0.5;
  }
  function linesOf(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        return n.nodeValue && n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    const range = document.createRange();
    const rects = [];
    let n;
    while ((n = walker.nextNode())) {
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) {
        if (r.width > 0 && r.height > 0) {
          rects.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
        }
      }
    }
    rects.sort((a, b) => a.top - b.top || a.left - b.left);
    const lines = [];
    for (const r of rects) {
      const last = lines[lines.length - 1];
      if (last && sameLine(last, r)) {
        last.top = Math.min(last.top, r.top);
        last.bottom = Math.max(last.bottom, r.bottom);
        last.left = Math.min(last.left, r.left);
        last.right = Math.max(last.right, r.right);
      } else {
        lines.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
      }
    }
    return lines;
  }
  const ids = ["h1", "p-one", "p-ja", "p-en", "p-mix", "li1"];
  const blocks = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    blocks[id] = el ? linesOf(el) : [];
  }
  return {
    font: getComputedStyle(document.getElementById("p-ja")).fontFamily,
    viewport: { left: 0, top: 0, right: innerWidth, bottom: innerHeight },
    all: linesOf(document.body),
    blocks,
  };
};


function readCanvasCoverage(page, expected, lines) {
  return page.evaluate(({ expected, lines }) => {
    const canvas = document.getElementById("line-half-mask-root");
    if (!canvas || canvas.tagName !== "CANVAS") {
      return { ok: false, reason: "no-canvas" };
    }
    const dpr = window.devicePixelRatio || 1;
    const shown = canvas.getBoundingClientRect().width;
    const local = canvas.offsetWidth || innerWidth;
    const scale = (shown > 0 && local > 0) ? shown / local : 1;
    const ctx = canvas.getContext("2d");
    const isPainted = (r, g, b, a) => a > 20 && (
      (r < 40 && g < 40 && b < 40) ||
      (r > 215 && g > 215 && b > 215)
    );
    const sample = (left, top, right, bottom, inset) => {
      const l = Math.max(0, Math.floor((left + inset) / scale * dpr));
      const t = Math.max(0, Math.floor((top + inset) / scale * dpr));
      const rgt = Math.min(canvas.width, Math.ceil((right - inset) / scale * dpr));
      const bm = Math.min(canvas.height, Math.ceil((bottom - inset) / scale * dpr));
      const w = rgt - l;
      const h = bm - t;
      if (w < 1 || h < 1) return { painted: 0, total: 0, frac: 1 };
      const data = ctx.getImageData(l, t, w, h).data;
      let painted = 0;
      const total = w * h;
      for (let i = 0; i < data.length; i += 4) {
        if (isPainted(data[i], data[i + 1], data[i + 2], data[i + 3])) painted += 1;
      }
      return { painted, total, frac: painted / total };
    };
    const insides = expected.map((m) => {
      const s = sample(m.left, m.top, m.right, m.bottom, 1);
      return { index: m.index, frac: s.frac, painted: s.painted, total: s.total };
    });
    const outsides = [];
    for (const m of expected) {
      const line = lines[m.index];
      if (!line) continue;
      let top, bottom;
      if (m.coverTop) {
        top = m.bottom;
        bottom = line.bottom;
      } else {
        top = line.top;
        bottom = m.top;
      }
      if (bottom - top < 3) continue;
      const s = sample(line.left, top, line.right, bottom, 1);
      outsides.push({ index: m.index, frac: s.frac, painted: s.painted, total: s.total });
    }
    const minIn = insides.length ? Math.min(...insides.map((s) => s.frac)) : 0;
    const maxOut = outsides.length ? Math.max(...outsides.map((s) => s.frac)) : 0;
    return {
      ok: insides.length === expected.length && insides.every((s) => s.frac >= 0.95) && maxOut <= 0.05,
      minIn,
      maxOut,
      nIn: insides.length,
      nOut: outsides.length,
      nExpected: expected.length,
      badIn: insides.filter((s) => s.frac < 0.95).slice(0, 8),
      badOut: outsides.filter((s) => s.frac > 0.05).slice(0, 8),
    };
  }, { expected, lines });
}

function readMasks(page) {
  return page.evaluate(() => {
    if (!window.__lineHalfMask) return [];
    return window.__lineHalfMask.collect().map((m) => ({
      top: m.top,
      bottom: m.top + m.height,
      left: m.left,
      right: m.left + m.width,
      width: m.width,
      height: m.height,
    }));
  });
}

async function playGesture(page, events) {
  return page.evaluate(async (events) => {
    if (typeof Touch !== "function" || typeof TouchEvent !== "function") {
      return { supported: false };
    }
    const down = new Map();
    const make = (p, target) => new Touch({
      identifier: p.id,
      target,
      clientX: p.x,
      clientY: p.y,
      pageX: p.x,
      pageY: p.y,
      screenX: p.x,
      screenY: p.y,
      radiusX: 2,
      radiusY: 2,
      rotationAngle: 0,
      force: 1,
    });
    for (const ev of events) {
      if (ev.delayMs) await new Promise((r) => setTimeout(r, ev.delayMs));
      const changed = ev.points;
      const target = document.elementFromPoint(changed[0].x, changed[0].y) || document.body;
      if (ev.type === "start" || ev.type === "move") {
        for (const p of changed) down.set(p.id, p);
      }
      if (ev.type === "end" || ev.type === "cancel") {
        for (const p of changed) down.delete(p.id);
      }
      const remaining = [...down.values()];
      const type = "touch" + ev.type;
      const list = (pts) => pts.map((p) => make(p, target));
      target.dispatchEvent(new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        touches: list(remaining),
        targetTouches: list(remaining),
        changedTouches: list(changed),
      }));
    }
    return { supported: true };
  }, events);
}

async function openPage(browser, url, viewport) {
  const page = await browser.newPage({ viewport, hasTouch: true });
  await page.goto(url, { waitUntil: "load" });
  await page.addScriptTag({ content: contentJs });
  await page.waitForFunction(() => window.__lineHalfMask);
  return page;
}


// Shortcut string rules (no browser required)
{
  const fn = new Function(
    "globalThis",
    fs.readFileSync(path.join(srcDir, "shortcuts.js"), "utf8") + "; return globalThis.LineHalfMaskShortcuts;"
  );
  const SH = fn({});
  const ev = (key, mods = {}) => ({
    key,
    ctrlKey: !!mods.ctrl,
    altKey: !!mods.alt,
    shiftKey: !!mods.shift,
    metaKey: !!mods.meta,
    code: mods.code || "",
  });
  check("default toggle shortcut is Alt+Shift+L", SH.DEFAULTS["toggle-mask"] === "Alt+Shift+L");
  check("default swap shortcut is Alt+Shift+K", SH.DEFAULTS["swap-parity"] === "Alt+Shift+K");
  check("Alt+Shift+L is valid", SH.isValidShortcut("Alt+Shift+L"));
  check("Alt+L is valid", SH.isValidShortcut("Alt+L"));
  check("Ctrl+Shift+F6 is valid", SH.isValidShortcut("Ctrl+Shift+F6"));
  check("Alt+Up is valid", SH.isValidShortcut("Alt+Up"));
  check("Shift+L alone is invalid", !SH.isValidShortcut("Shift+L"));
  check("L alone is invalid", !SH.isValidShortcut("L"));
  check("empty shortcut is invalid", !SH.isValidShortcut(""));
  check("three modifiers are invalid", !SH.isValidShortcut("Ctrl+Alt+Shift+L"));
  const a = SH.fromEvent(ev("l", { alt: true, shift: true }));
  check("fromEvent Alt+Shift+L", a.status === "ok" && a.shortcut === "Alt+Shift+L", a);
  const inc = SH.fromEvent(ev("Alt", { alt: true }));
  check("fromEvent modifier only is incomplete", inc.status === "incomplete", inc);
  const bad = SH.fromEvent(ev("l", { shift: true }));
  check("fromEvent Shift+L is invalid", bad.status === "invalid", bad);
  const tri = SH.fromEvent(ev("l", { ctrl: true, alt: true, shift: true }));
  check("fromEvent Ctrl+Alt+Shift+L is invalid", tri.status === "invalid", tri);
  const up = SH.fromEvent(ev("ArrowUp", { alt: true }));
  check("fromEvent Alt+ArrowUp becomes Alt+Up", up.status === "ok" && up.shortcut === "Alt+Up", up);
}

{
  const src = fs.readFileSync(path.join(srcDir, "background.js"), "utf8");
  function loadBg(browserObj) {
    const fn = new Function("browser", "chrome", src + "\nreturn true;");
    return fn(browserObj, browserObj);
  }
  const created = [];
  const clickHandlers = [];
  const sent = [];
  const installed = [];
  const startups = [];
  const cleared = [];
  const withMenus = {
    menus: {
      create(item) { created.push(item); return item.id; },
      removeAll() { cleared.push(true); return Promise.resolve(); },
      onClicked: { addListener(fn) { clickHandlers.push(fn); } },
    },
    tabs: {
      sendMessage(id, msg, options) { sent.push({ id, msg, options }); return Promise.resolve({ ok: true, selectionOn: true }); },
      query() { return Promise.resolve([]); },
    },
    commands: { onCommand: { addListener() {} } },
    runtime: {
      onMessage: { addListener() {} },
      onInstalled: { addListener(fn) { installed.push(fn); } },
      onStartup: { addListener(fn) { startups.push(fn); } },
    },
    action: { setTitle() {} },
  };
  let threw = false;
  try { loadBg(withMenus); } catch (err) { threw = err; }
  await Promise.resolve();
  check("background binds menus when the API exists", threw === false, threw && String(threw));
  const item = created.find((i) => i && i.id === "line-half-mask-selection");
  check(
    "the selection menu item is labeled 選択範囲に行マスク",
    !!(item && item.title === "選択範囲に行マスク" && Array.isArray(item.contexts) && item.contexts.includes("selection")),
    item || created
  );
  const train = created.find((i) => i && i.id === "line-half-mask-train");
  check(
    "the no-selection menu item is labeled 範囲を指定して視覚トレーニング and is not offered for a selection",
    !!(train && train.title === "範囲を指定して視覚トレーニング" && train.contexts.includes("page") && !train.contexts.includes("selection")),
    train || created
  );
  check("there are exactly two context menu items", created.length === 2, created);
  check("menus are cleared then recreated (stale items go away)", cleared.length >= 1 && created.length === 2, { cleared: cleared.length, created: created.length });
  check("onClicked is registered at top level (also has onInstalled/onStartup)", clickHandlers.length >= 1 && installed.length >= 1 && startups.length >= 1, { clicks: clickHandlers.length, installed: installed.length, startups: startups.length });
  await Promise.resolve(clickHandlers[0]({ menuItemId: "line-half-mask-selection", frameId: 3 }, { id: 9 }));
  check(
    "choosing the menu sends overlaySelection with a picker and without a fill (uses the current setting)",
    sent.some((s) => s.id === 9 && s.msg && s.msg.type === "overlaySelection" && s.msg.picker === true && s.msg.fill == null && s.options && s.options.frameId === 3),
    sent
  );

  sent.length = 0;
  await Promise.resolve(clickHandlers[0]({ menuItemId: "line-half-mask-train", frameId: 2 }, { id: 8 }));
  check(
    "choosing the training menu sends trainRect to that frame",
    sent.some((s) => s.id === 8 && s.msg && s.msg.type === "trainRect" && s.options && s.options.frameId === 2),
    sent
  );

  const injections = [];
  const sent2 = [];
  let failOnce = true;
  const withInject = {
    menus: { create(item) { return item.id; }, onClicked: { addListener(fn) { clickHandlers.push(fn); } } },
    tabs: {
      sendMessage: async (id, msg, options) => {
        if (failOnce) { failOnce = false; throw new Error("Could not establish connection. Receiving end does not exist."); }
        sent2.push({ id, msg, options });
        return { ok: true, selectionOn: true };
      },
      query() { return Promise.resolve([]); },
    },
    scripting: {
      executeScript: async (opts) => { injections.push(opts); },
    },
    commands: { onCommand: { addListener() {} } },
    runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
    action: { setTitle() {} },
  };
  const injectHandlers = [];
  withInject.menus.onClicked.addListener = (fn) => injectHandlers.push(fn);
  loadBg(withInject);
  const res = await Promise.resolve(injectHandlers[0]({ menuItemId: "line-half-mask-selection", frameId: 0 }, { id: 11 }));
  check(
    "when the content script is missing, the menu path injects it and retries overlaySelection",
    injections.length >= 1 && injections[0].files && injections[0].files.includes("content.js") && injections[0].target && injections[0].target.tabId === 11 && sent2.some((s) => s.msg && s.msg.type === "overlaySelection") && res && res.ok === true,
    { injections, sent2, res }
  );

  check(
    "injection loads enhance.js before content.js",
    !!(injections[0] && injections[0].files && injections[0].files[0] === "enhance.js" && injections[0].files[1] === "content.js"),
    injections[0]
  );

  let missingThrew = false;
  try {
    loadBg({
      tabs: { sendMessage() { return Promise.resolve(); }, query() { return Promise.resolve([]); } },
      commands: { onCommand: { addListener() {} } },
      runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
      action: { setTitle() {} },
    });
  } catch (err) { missingThrew = err; }
  check("background does nothing harmful when menus API is missing (Android)", missingThrew === false, missingThrew && String(missingThrew));
}

{
  const man = JSON.parse(fs.readFileSync(path.join(srcDir, "manifest.json"), "utf8"));
  check("manifest declares Android support and version 0.8.1", man.version === "0.8.1" && !!man.browser_specific_settings.gecko_android && Number(man.browser_specific_settings.gecko_android.strict_min_version) >= 142 && man.browser_specific_settings.gecko.id === "line.half.mask@kofu.com", man.browser_specific_settings);
  const bgSrc = fs.readFileSync(path.join(srcDir, "background.js"), "utf8");
  check("background guards commands, menus and scripting with feature checks", /api\.commands && api\.commands\.onCommand/.test(bgSrc) && /menusApi\(\)/.test(bgSrc) && /!api\.scripting \|\| !api\.scripting\.executeScript/.test(bgSrc));
}

const { server, url } = await startServer();
const browser = await firefox.launch({
  headless: true,
  firefoxUserPrefs: { "dom.w3c_touch_events.enabled": 2, "ui.prefersReducedMotion": 1 },
});

// ----- desktop geometry -----
const desk = { width: 800, height: 1600 };
const page = await openPage(browser, url, desk);

const before = await page.evaluate(measureFn);
check("Japanese font is available", /noto/i.test(before.font), before.font);
check("page has at least 8 visual lines", before.all.length >= 8, { lines: before.all.length });
check("h1 is a single first line", before.blocks.h1.length === 1, before.blocks.h1.length);
check("short paragraph is a single line", before.blocks["p-one"].length === 1, before.blocks["p-one"].length);

const h1 = before.blocks.h1[0];
const pOne = before.blocks["p-one"][0];
const firstGlobal = before.all[0];
const secondGlobal = before.all[1];
check(
  "global order starts with the heading then the short paragraph",
  Math.abs(firstGlobal.top - h1.top) <= TOL && Math.abs(secondGlobal.top - pOne.top) <= TOL,
  { first: firstGlobal.top, h1: h1.top, second: secondGlobal.top, pOne: pOne.top }
);

await page.screenshot({ path: path.join(shotDir, "desktop-off.png") });

await page.evaluate(() => window.__lineHalfMask.start());
await page.waitForTimeout(80);
const stateA = await page.evaluate(() => window.__lineHalfMask.getState());
check("start: on with parity 0", stateA.on === true && stateA.parity === 0, stateA);
check("default mask ratio is 50", stateA.ratio === 50, stateA);
await page.evaluate(() => window.__lineHalfMask.pause(true));
await page.waitForTimeout(50);
const overlayInfo = await page.evaluate(() => {
  const root = document.getElementById("line-half-mask-root");
  const cs = root ? getComputedStyle(root) : null;
  return {
    tag: root ? root.tagName : null,
    width: root ? root.width : 0,
    height: root ? root.height : 0,
    anim: cs ? cs.animationName : "",
  };
});
check("overlay is a canvas", overlayInfo.tag === "CANVAS" && overlayInfo.width > 0 && overlayInfo.height > 0, overlayInfo);
check("overlay canvas is not driven by a CSS animation", !overlayInfo.anim || overlayInfo.anim === "none", overlayInfo);
await page.screenshot({ path: path.join(shotDir, "desktop-normal.png") });


const measuredA = await page.evaluate(measureFn);
const expectedA = expectedMasks(measuredA.all, 0, measuredA.viewport);
const actualA = await readMasks(page);
const matchA = matchMasks(actualA, expectedA);
check("state A: one half-mask per visible line, aligned to midpoints", matchA.ok, matchA);
check(
  "state A masks every visual line (none skipped as a single-line paragraph)",
  actualA.length === measuredA.all.length,
  { masks: actualA.length, lines: measuredA.all.length }
);

function halfOf(line, coverTop) {
  return coverTop
    ? { top: line.top, bottom: mid(line) }
    : { top: mid(line), bottom: line.bottom };
}
function hasMask(actual, box) {
  return actual.some((m) =>
    Math.abs(m.top - box.top) <= TOL && Math.abs(m.bottom - box.bottom) <= TOL
  );
}

check(
  "state A: first line (heading) bottom half is masked, top half is not",
  hasMask(actualA, halfOf(measuredA.all[0], false)) &&
    !hasMask(actualA, halfOf(measuredA.all[0], true))
);
check(
  "state A: second line (short paragraph) top half is masked (parity continues)",
  hasMask(actualA, halfOf(measuredA.all[1], true))
);

{
  const region = actualA[0];
  const clip = {
    x: Math.max(0, Math.floor(region.left + 2)),
    y: Math.max(0, Math.floor(region.top + 1)),
    width: Math.max(8, Math.min(160, Math.floor(region.width - 4))),
    height: Math.max(4, Math.min(24, Math.floor(region.height - 2))),
  };
  const buf = await page.screenshot({ clip, type: "png" });
  const counts = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let black = 0, white = 0, other = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r < 40 && g < 40 && b < 40) black += 1;
      else if (r > 215 && g > 215 && b > 215) white += 1;
      else other += 1;
    }
    return { black, white, other, total: data.length / 4, w: c.width, h: c.height };
  }, buf.toString("base64"));
  check(
    "black mask is solid: every pixel in the region is pure black, none white",
    counts.black === counts.total && counts.white === 0 && counts.other === 0,
    counts
  );
}

{
  await page.evaluate(() => window.__lineHalfMask.pause(false));
  const a = await page.evaluate(() => window.__lineHalfMask.getState().paintCount);
  await page.waitForTimeout(700);
  const b = await page.evaluate(() => window.__lineHalfMask.getState().paintCount);
  check("black repaints only on position changes (no frame loop repaint while idle)", a === b, { a, b });
  await page.evaluate(() => window.__lineHalfMask.pause(true));
}

{
  const measured50 = await page.evaluate(measureFn);
  const expected50 = expectedMasks(measured50.all, 0, measured50.viewport, 50);
  const cover50 = await readCanvasCoverage(page, expected50, measured50.all);
  check("canvas pixels cover expected bands at ratio 50 (>=95% inside, ~0 outside)", cover50.ok, cover50);
  await page.screenshot({ path: path.join(shotDir, "desktop-ratio-50.png"), fullPage: false });
}

{
  const clamps = await page.evaluate(() => {
    const c = window.__lineHalfMask.clampRatio;
    return { lo: c(40), hi: c(99), nan: c("x"), mid: c(60.4), d: c(50) };
  });
  check("ratio input is clamped to 50-90 integers", clamps.lo === 50 && clamps.hi === 90 && clamps.nan === 50 && clamps.mid === 60 && clamps.d === 50, clamps);

  await page.evaluate(() => window.__lineHalfMask.setRatio(60));
  await page.waitForTimeout(40);
  const st60 = await page.evaluate(() => window.__lineHalfMask.getState());
  check("setRatio 60 is stored and applied", st60.ratio === 60, st60);
  const measured60 = await page.evaluate(measureFn);
  const expected60 = expectedMasks(measured60.all, 0, measured60.viewport, 60);
  const actual60 = await readMasks(page);
  const match60 = matchMasks(actual60, expected60);
  check("ratio 60 masks align to 60 percent from the masked side", match60.ok, match60);
  const line0 = measured60.all[0];
  const h0 = line0.bottom - line0.top;
  const oddBottom = actual60.find((m) => Math.abs(m.left - line0.left) <= 1.25 && Math.abs(m.bottom - line0.bottom) <= 1.25);
  check(
    "ratio 60: first (odd) line is masked from 40 percent down",
    oddBottom && Math.abs(oddBottom.top - (line0.top + h0 * 0.4)) <= 1.25,
    oddBottom && { top: oddBottom.top, expect: line0.top + h0 * 0.4, h: h0 }
  );
  const cover60 = await readCanvasCoverage(page, expected60, measured60.all);
  check("canvas pixels cover expected bands at ratio 60 (>=95% inside, ~0 outside)", cover60.ok, cover60);
  await page.screenshot({ path: path.join(shotDir, "desktop-ratio-60.png"), fullPage: false });

  await page.evaluate(() => window.__lineHalfMask.setRatio(51));
  await page.waitForTimeout(40);
  const measured51 = await page.evaluate(measureFn);
  const line = measured51.all[0];
  const h = line.bottom - line.top;
  const bottomStart = line.top + h * 0.49;
  const topEnd = line.top + h * 0.51;
  const overlap = topEnd - bottomStart;
  check("ratio 51 leaves a 2 percent center hidden in both modes", Math.abs(overlap - h * 0.02) < 0.2, { overlap, expect: h * 0.02, h });
  const actual51a = await readMasks(page);
  const oddA = actual51a.find((m) => Math.abs(m.bottom - line.bottom) <= 1.25 && Math.abs(m.left - line.left) <= 1.25);
  check("ratio 51 normal: odd line mask starts at 49 percent", oddA && Math.abs(oddA.top - bottomStart) <= 1.25, oddA && { top: oddA.top, expect: bottomStart });
  await page.evaluate(() => { window.__lineHalfMask.swap(); window.__lineHalfMask.pause(true); });
  await page.waitForTimeout(40);
  const actual51b = await readMasks(page);
  const oddB = actual51b.find((m) => Math.abs(m.top - line.top) <= 1.25 && Math.abs(m.left - line.left) <= 1.25);
  check("ratio 51 swapped: odd line mask ends at 51 percent", oddB && Math.abs(oddB.bottom - topEnd) <= 1.25, oddB && { bottom: oddB.bottom, expect: topEnd });
  await page.evaluate(() => {
    window.__lineHalfMask.swap();
    window.__lineHalfMask.setRatio(50);
    window.__lineHalfMask.pause(true);
  });
  await page.waitForTimeout(40);
}

await page.evaluate(() => window.__lineHalfMask.swap());
await page.waitForTimeout(80);
const stateB = await page.evaluate(() => window.__lineHalfMask.getState());
check("swap: still on with parity 1", stateB.on === true && stateB.parity === 1, stateB);
await page.screenshot({ path: path.join(shotDir, "desktop-flipped.png") });

const measuredB = await page.evaluate(measureFn);
const expectedB = expectedMasks(measuredB.all, 1, measuredB.viewport);
const actualB = await readMasks(page);
const matchB = matchMasks(actualB, expectedB);
check("state B: one half-mask per visible line, aligned to midpoints", matchB.ok, matchB);
check(
  "state B: first line top half is masked",
  hasMask(actualB, halfOf(measuredB.all[0], true)) &&
    !hasMask(actualB, halfOf(measuredB.all[0], false))
);
check(
  "state B: second line bottom half is masked",
  hasMask(actualB, halfOf(measuredB.all[1], false))
);

await page.evaluate(() => window.__lineHalfMask.swap());
await page.waitForTimeout(60);
const stateA2 = await page.evaluate(() => window.__lineHalfMask.getState());
check("second swap returns to parity 0", stateA2.on === true && stateA2.parity === 0, stateA2);

{
  await page.evaluate(() => {
    window.scrollTo(0, 280);
    window.__lineHalfMask.update();
    window.__lineHalfMask.pause(true);
  });
  await page.waitForTimeout(80);
  const measuredScroll = await page.evaluate(measureFn);
  const expectedScroll = expectedMasks(measuredScroll.all, 0, measuredScroll.viewport, 50);
  const coverScroll = await readCanvasCoverage(page, expectedScroll, measuredScroll.all);
  check("canvas pixels cover expected bands after scrolling", coverScroll.ok && expectedScroll.length >= 4, coverScroll);
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    window.__lineHalfMask.update();
    window.__lineHalfMask.pause(true);
  });
  await page.waitForTimeout(40);

  await page.setViewportSize({ width: 640, height: 900 });
  await page.evaluate(() => {
    window.__lineHalfMask.update();
    window.__lineHalfMask.pause(true);
  });
  await page.waitForTimeout(80);
  const measuredResize = await page.evaluate(measureFn);
  const expectedResize = expectedMasks(measuredResize.all, 0, measuredResize.viewport, 50);
  const coverResize = await readCanvasCoverage(page, expectedResize, measuredResize.all);
  check("canvas pixels cover expected bands after resizing", coverResize.ok && expectedResize.length >= 4, coverResize);
  await page.setViewportSize({ width: 800, height: 1600 });
  await page.evaluate(() => {
    window.__lineHalfMask.update();
    window.__lineHalfMask.pause(true);
  });
  await page.waitForTimeout(40);
}

// Touch gestures (including staggered fingers, like a real device)
const cx = 400;
const cy = 200;
const p1 = { id: 1, x: cx, y: cy };
const p2 = { id: 2, x: cx + 24, y: cy + 4 };
const p3 = { id: 3, x: cx - 8, y: cy + 20 };
const moved = (p, dx, dy) => ({ id: p.id, x: p.x + dx, y: p.y + dy });

function staggeredTap(points, endType = "end") {
  const events = [];
  points.forEach((p, i) => {
    events.push({ type: "start", points: [p], delayMs: i === 0 ? 0 : 30 });
  });
  points.forEach((p, i) => {
    events.push({ type: endType, points: [p], delayMs: i === 0 ? 40 : 20 });
  });
  return events;
}

const touchA = await playGesture(page, staggeredTap([p1, p2, p3]));
check("Touch events are available in Firefox", touchA.supported !== false, touchA);
if (touchA.supported) {
  await page.waitForTimeout(40);
  const afterStaggered = await page.evaluate(() => window.__lineHalfMask.getState());
  check("staggered 3-finger tap swaps parity", afterStaggered.parity === 1, afterStaggered);

  await playGesture(page, staggeredTap([p1, p2]));
  await page.waitForTimeout(40);
  const afterTwo = await page.evaluate(() => window.__lineHalfMask.getState());
  check("single 2-finger tap does not swap", afterTwo.parity === 1, afterTwo);

  await playGesture(page, [
    { type: "start", points: [p1] },
    { type: "start", points: [p2], delayMs: 30 },
    { type: "start", points: [p3], delayMs: 30 },
    { type: "move", points: [moved(p1, 0, 55), moved(p2, 0, 55), moved(p3, 0, 55)], delayMs: 20 },
    { type: "end", points: [moved(p1, 0, 55), moved(p2, 0, 55), moved(p3, 0, 55)], delayMs: 20 },
  ]);
  await page.waitForTimeout(40);
  const afterMove = await page.evaluate(() => window.__lineHalfMask.getState());
  check("staggered 3-finger swipe does not swap", afterMove.parity === 1, afterMove);

  await playGesture(page, [
    { type: "start", points: [p1] },
    { type: "start", points: [p2], delayMs: 30 },
    { type: "start", points: [p3], delayMs: 30 },
    { type: "end", points: [p1, p2, p3], delayMs: 700 },
  ]);
  await page.waitForTimeout(40);
  const afterHold = await page.evaluate(() => window.__lineHalfMask.getState());
  check("staggered 3-finger long press does not swap", afterHold.parity === 1, afterHold);

  await playGesture(page, staggeredTap([p1, p2, p3], "cancel"));
  await page.waitForTimeout(40);
  const afterCancel = await page.evaluate(() => window.__lineHalfMask.getState());
  check("staggered 3-finger tap ending in touchcancel still swaps", afterCancel.parity === 0, afterCancel);

  await playGesture(page, [
    { type: "start", points: [p1] },
    { type: "start", points: [p2], delayMs: 30 },
    { type: "start", points: [p3], delayMs: 30 },
    { type: "move", points: [moved(p1, 0, 55), moved(p2, 0, 55), moved(p3, 0, 55)], delayMs: 20 },
    { type: "cancel", points: [moved(p1, 0, 55), moved(p2, 0, 55), moved(p3, 0, 55)], delayMs: 20 },
  ]);
  await page.waitForTimeout(40);
  const afterCancelMove = await page.evaluate(() => window.__lineHalfMask.getState());
  check("3-finger swipe ending in touchcancel does not swap", afterCancelMove.parity === 0, afterCancelMove);

  await playGesture(page, [
    ...staggeredTap([p1, p2]),
    ...staggeredTap([p1, p2]).map((ev, i) => i === 0 ? { ...ev, delayMs: 200 } : ev),
  ]);
  await page.waitForTimeout(40);
  const afterDoubleTwo = await page.evaluate(() => window.__lineHalfMask.getState());
  check("2-finger double-tap swaps parity", afterDoubleTwo.parity === 1, afterDoubleTwo);

  await playGesture(page, [
    { type: "start", points: [p1, p2, p3] },
    { type: "end", points: [p1, p2, p3], delayMs: 40 },
  ]);
  await page.waitForTimeout(40);
  const afterSimul = await page.evaluate(() => window.__lineHalfMask.getState());
  check("simultaneous 3-finger tap still swaps", afterSimul.parity === 0, afterSimul);
}


// ブラウザのズームでも範囲が合う
{
  for (const zoom of [1, 1.25, 1.5]) {
    await page.evaluate((z) => {
      document.documentElement.style.zoom = String(z);
      window.__lineHalfMask.update();
      window.__lineHalfMask.pause(true);
    }, zoom);
    await page.waitForTimeout(80);
    const measuredZ = await page.evaluate(measureFn);
    const expectedZ = expectedMasks(measuredZ.all, 0, measuredZ.viewport, 50);
    const coverZ = await readCanvasCoverage(page, expectedZ, measuredZ.all);
    check("canvas pixels cover expected bands at zoom " + zoom, coverZ.ok && expectedZ.length >= 4, coverZ);
  }
  await page.evaluate(() => {
    document.documentElement.style.zoom = "1";
    window.__lineHalfMask.update();
    window.__lineHalfMask.pause(true);
  });
  await page.waitForTimeout(50);
}

{
  await page.evaluate(() => {
    window.__lineHalfMask.pause(true);
    const el = document.getElementById("p-ja");
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    window.__lineHalfMask.overlaySelection();
    window.__lineHalfMask.pause(true);
  });
  await page.waitForTimeout(40);
  const selMeasured = await page.evaluate(measureFn);
  const jaLines = selMeasured.blocks["p-ja"];
  const selState = await page.evaluate(() => window.__lineHalfMask.getState());
  const selCleared = await page.evaluate(() => ({
    text: getSelection() ? getSelection().toString() : "no-sel",
    count: getSelection() ? getSelection().rangeCount : -1,
  }));
  check("starting selection mode clears the page selection highlight", selCleared.text === "" && selCleared.count === 0 && selState.selectionOn === true, { selCleared, on: selState.selectionOn });
  const selMasks = await readMasks(page);
  const selMatch = matchMasks(selMasks, fixedMasks(jaLines, "full", selMeasured.viewport, 50));
  check("selection overlay is on and leaves page-wide armed", selState.selectionOn === true && selState.on === true && selState.coverage === "full" && selState.fill === "black", selState);
  check("selection overlay covers only the selected paragraph's lines", selMasks.length === jaLines.length && selMasks.length < selMeasured.all.length, { masks: selMasks.length, ja: jaLines.length, all: selMeasured.all.length });
  check("default coverage is the whole line for every selected line", selMatch.ok, selMatch);
  await page.screenshot({ path: path.join(shotDir, "desktop-selection.png"), fullPage: false });

  // 上半分・下半分は、選んだ全行の同じ側に固定される（ページ全体の奇偶とは違う）。
  for (const part of ["bottom", "top"]) {
    await page.evaluate((p) => window.__lineHalfMask.setSelCoverage(p), part);
    const got = await readMasks(page);
    const m = matchMasks(got, fixedMasks(jaLines, part, selMeasured.viewport, 50));
    check("coverage " + part + ": that half of every selected line, none of the other", m.ok && jaLines.length >= 3 && got.every((g) => g.height < (jaLines[0].bottom - jaLines[0].top) * 0.6), m);
  }
  await page.evaluate(() => window.__lineHalfMask.setSelCoverage("off"));
  const offMasks = await readMasks(page);
  const offState = await page.evaluate(() => window.__lineHalfMask.getState());
  check("coverage off paints nothing but keeps the overlay armed", offMasks.length === 0 && offState.selectionOn === true && offState.coverage === "off", { n: offMasks.length, offState });
  const offCanvas = await page.evaluate(() => !!document.getElementById("line-half-mask-root"));
  check("coverage off removes the canvas", offCanvas === false, { offCanvas });
  await page.evaluate(() => { const a = window.__lineHalfMask; a.setSelCoverage("top"); a.swap(); });
  const swapped = await readMasks(page);
  check("swap on a selection flips top and bottom", matchMasks(swapped, fixedMasks(jaLines, "bottom", selMeasured.viewport, 50)).ok);
  await page.evaluate(() => window.__lineHalfMask.setSelCoverage("full"));

  const currentSelMasks = await readMasks(page);
  const inside = currentSelMasks[0];
  await page.evaluate(() => window.__lineHalfMask.pause(true));
  await page.mouse.click(inside.left + inside.width / 2, inside.top + inside.height / 2);
  await page.waitForTimeout(40);
  const stillOn = await page.evaluate(() => window.__lineHalfMask.getState());
  check("clicking inside a selected line keeps the mode on", stillOn.selectionOn === true, stillOn);

  await page.mouse.click(16, 16);
  await page.waitForTimeout(40);
  const afterOut = await page.evaluate(() => ({
    state: window.__lineHalfMask.getState(),
    masks: window.__lineHalfMask.collect().length,
  }));
  const pageMasks = await readMasks(page);
  check("clicking outside the selection masks ends the mode", afterOut.state.selectionOn === false, afterOut);
  check("ending selection mode restores page-wide masks when they were on", afterOut.state.on === true && pageMasks.length === selMeasured.all.length, { on: afterOut.state.on, masks: pageMasks.length, all: selMeasured.all.length });

  // タッチ（Android）: 外側のタップで終わり、スクロール相当の動きや内側のタップでは終わらない。
  await page.evaluate(() => {
    const el = document.getElementById("p-ja");
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    window.__lineHalfMask.overlaySelection();
    window.__lineHalfMask.pause(true);
  });
  await page.waitForTimeout(40);
  const touchProbe = await playGesture(page, [{ type: "start", points: [{ id: 1, x: 16, y: 16 }] }]);
  if (touchProbe.supported === false) {
    check("touch tap-outside test needs Touch events", false, touchProbe);
  } else {
    await playGesture(page, [{ type: "end", points: [{ id: 1, x: 16, y: 150 }], delayMs: 20 }]);
    const afterSwipe = await page.evaluate(() => window.__lineHalfMask.getState().selectionOn);
    check("a touch swipe (scroll) outside does not end selection mode", afterSwipe === true, afterSwipe);
    const mk = (await readMasks(page))[0];
    const ix = mk.left + mk.width / 2, iy = mk.top + mk.height / 2;
    await playGesture(page, [
      { type: "start", points: [{ id: 1, x: ix, y: iy }] },
      { type: "end", points: [{ id: 1, x: ix, y: iy }], delayMs: 30 },
    ]);
    const afterInside = await page.evaluate(() => window.__lineHalfMask.getState().selectionOn);
    check("a touch tap inside the mask keeps selection mode", afterInside === true, afterInside);
    await playGesture(page, [
      { type: "start", points: [{ id: 1, x: 16, y: 16 }] },
      { type: "end", points: [{ id: 1, x: 16, y: 16 }], delayMs: 30 },
    ]);
    const afterTapOut = await page.evaluate(() => window.__lineHalfMask.getState().selectionOn);
    check("a touch tap outside the mask ends selection mode (Android)", afterTapOut === false, afterTapOut);
  }

  // 古い選択は使わない（ポップアップから押したとき、ずっと前の選択を塗らない）。
  const stale = await page.evaluate(() => {
    const api = window.__lineHalfMask;
    const el = document.getElementById("p-ja");
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    api.captureSelection();
    sel.removeAllRanges();
    const fresh = api.overlaySelection();
    api.endSelection();
    const realNow = Date.now;
    Date.now = () => realNow() + 61000;
    const old = api.overlaySelection();
    Date.now = realNow;
    return { fresh, old };
  });
  check("a captured selection is used when fresh and ignored after 60 seconds", stale.fresh === true && stale.old === false, stale);

  const firstJa = jaLines[0];
  await page.evaluate(() => {
    const el = document.getElementById("p-ja");
    const text = el.firstChild;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 4);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    window.__lineHalfMask.overlaySelection();
    window.__lineHalfMask.pause(true);
  });
  await page.waitForTimeout(40);
  const partMasks = await readMasks(page);
  const part = partMasks[0];
  check(
    "partial selection masks only the selected horizontal extent, not the full line box",
    !!(part && partMasks.length === 1 && part.width < firstJa.right - firstJa.left - 8 && Math.abs(part.left - firstJa.left) <= 2),
    part && { width: part.width, lineWidth: firstJa.right - firstJa.left, left: part.left, lineLeft: firstJa.left, n: partMasks.length }
  );
  await page.evaluate(() => window.__lineHalfMask.endSelection());

  const lost = await page.evaluate(() => {
    const el = document.getElementById("p-ja");
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 80, clientY: 200 }));
    sel.removeAllRanges();
    const ok = window.__lineHalfMask.overlaySelection();
    window.__lineHalfMask.pause(true);
    return { ok, state: window.__lineHalfMask.getState(), masks: window.__lineHalfMask.collect().length };
  });
  check(
    "contextmenu captures the range so overlaySelection still works after the selection is cleared",
    lost.ok === true && lost.state.selectionOn === true && lost.masks >= 2,
    lost
  );
  await page.screenshot({ path: path.join(shotDir, "desktop-selection.png"), fullPage: false });
  await page.evaluate(() => window.__lineHalfMask.endSelection());

}

await page.evaluate(() => window.__lineHalfMask.toggle());
await page.waitForTimeout(60);
const off = await page.evaluate(() => ({
  state: window.__lineHalfMask.getState(),
  root: !!document.getElementById("line-half-mask-root"),
}));
check("toggle off removes overlay", off.state.on === false && off.root === false && off.state.selectionOn === false, off);
await page.close();


// ----- ポップアップの十字（ページ全体・選択範囲）と、範囲を指定した視覚トレーニング -----
{
  const dpage = await openPage(browser, url, { width: 800, height: 700 });
  const api = (fn, arg) => dpage.evaluate(fn, arg);
  const st = () => dpage.evaluate(() => window.__lineHalfMask.getState());
  const apply = async (v) => { await dpage.evaluate((c) => window.__lineHalfMask.applyCoverage(c), v); await dpage.waitForTimeout(60); };
  const sample = await dpage.evaluate(measureFn);

  // 何も選んでいない: ページ全体
  await apply("full");
  let state = await st();
  check("D-pad ← with no selection turns the whole page on as 全行", state.on === true && state.pageFull === true && state.shown === "full" && state.selectionOn === false, state);
  check("page-wide オン masks every visible line completely", matchMasks(await readMasks(dpage), fixedMasks(sample.all, "full", sample.viewport)).ok);
  await apply("top");
  state = await st();
  check("D-pad ↑ on the page: alternating, first line's top half masked", state.on && !state.pageFull && state.parity === 1 && state.shown === "top", state);
  check("page-wide ↑ matches the alternating masks starting with the top half", matchMasks(await readMasks(dpage), expectedMasks(sample.all, 1, sample.viewport)).ok);
  await dpage.evaluate(() => window.__lineHalfMask.pause(true));
  await dpage.screenshot({ path: path.join(shotDir, "desktop-black-top.png"), clip: { x: 0, y: 0, width: 800, height: 640 } });
  await apply("bottom");
  state = await st();
  check("D-pad ↓ on the page: alternating, first line's bottom half masked", state.on && !state.pageFull && state.parity === 0 && state.shown === "bottom", state);
  check("page-wide ↓ matches the alternating masks starting with the bottom half", matchMasks(await readMasks(dpage), expectedMasks(sample.all, 0, sample.viewport)).ok);
  await dpage.evaluate(() => window.__lineHalfMask.pause(true));
  await dpage.screenshot({ path: path.join(shotDir, "desktop-black-bottom.png"), clip: { x: 0, y: 0, width: 800, height: 640 } });
  await apply("off");
  state = await st();
  check("D-pad → turns the page off and removes the canvas", state.on === false && state.shown === "off" && (await dpage.evaluate(() => !document.getElementById("line-half-mask-root"))), state);

  // 選択あり: 選択範囲に効く。ページ全体は触らない。
  await dpage.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("p-ja"));
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await apply("top");
  state = await st();
  const ja = (await dpage.evaluate(measureFn)).blocks["p-ja"];
  check("D-pad ↑ with a selection overlays the selection only", state.selectionOn && state.shown === "top" && state.on === false, state);
  check("selection ↑ masks the top half of each selected line", matchMasks(await readMasks(dpage), fixedMasks(ja, "top", sample.viewport)).ok);
  await apply("full");
  check("D-pad ← changes the running selection overlay to 全行", (await st()).shown === "full" && matchMasks(await readMasks(dpage), fixedMasks(ja, "full", sample.viewport)).ok);
  await apply("off");
  state = await st();
  check("D-pad → ends the selection overlay and leaves the page off", state.selectionOn === false && state.on === false && state.shown === "off", state);

  // 範囲を指定して視覚トレーニング
  await dpage.evaluate(() => { getSelection().removeAllRanges(); });
  await dpage.evaluate(() => { window.__mousedowns = 0; document.addEventListener("mousedown", () => { window.__mousedowns += 1; }); });
  const layerInfo = () => dpage.evaluate(() => {
    const l = document.getElementById("line-half-mask-capture");
    if (!l) return null;
    const r = l.getBoundingClientRect();
    return { cursor: getComputedStyle(l).cursor, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight, pos: getComputedStyle(l).position };
  });
  const rootGone = () => dpage.evaluate(() => !document.getElementById("line-half-mask-root"));
  const rectState = () => dpage.evaluate(() => {
    const a = window.__lineHalfMask;
    const m = a.collect();
    return { state: a.getState(), masks: m.map((r) => ({ left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height })), fx: !!a.fxInfo() };
  });

  await dpage.evaluate(() => window.__lineHalfMask.trainRect());
  const layer = await layerInfo();
  check("rect mode: a transparent full-viewport capture layer with a crosshair cursor appears", layer && layer.cursor === "crosshair" && layer.pos === "fixed" && layer.w === layer.vw && layer.h === layer.vh, layer);
  check("rect mode: nothing is drawn before the drag", (await st()).selectionOn === false && (await rootGone()));
  await dpage.mouse.move(120, 160);
  await dpage.mouse.down();
  await dpage.mouse.move(300, 300, { steps: 4 });
  await dpage.mouse.move(520, 420, { steps: 4 });
  const band = await dpage.evaluate(() => {
    const l = document.getElementById("line-half-mask-capture");
    const b = l && l.firstElementChild;
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { display: getComputedStyle(b).display, left: r.left, top: r.top, w: r.width, h: r.height };
  });
  check("rect mode: a rubber band follows the drag", band && band.display === "block" && Math.abs(band.left - 120) <= 2 && Math.abs(band.top - 160) <= 2 && Math.abs(band.w - 400) <= 3 && Math.abs(band.h - 260) <= 3, band);
  await dpage.screenshot({ path: path.join(shotDir, "desktop-train-drag.png"), clip: { x: 0, y: 0, width: 800, height: 640 } });
  await dpage.mouse.up();
  await dpage.waitForTimeout(80);
  check("rect mode: the capture layer is removed after the drag", (await layerInfo()) === null && (await st()).dragging === false);
  let rs = await rectState();
  const m0 = rs.masks[0];
  check("rect mode: one overlay at the dragged rectangle, always 視覚増強 (fill setting is 黒塗り)",
    rs.state.selectionOn && rs.state.rect && rs.state.fill === "black" && rs.fx && rs.masks.length === 1 &&
      Math.abs(m0.left - 120) <= 1 && Math.abs(m0.top - 160) <= 1 && Math.abs(m0.right - 520) <= 1 && Math.abs(m0.bottom - 420) <= 1, rs);
  const pix = await dpage.evaluate(() => {
    const c = document.getElementById("line-half-mask-root");
    const dpr = window.devicePixelRatio || 1;
    const ctx = c.getContext("2d");
    const count = (x, y, w, h) => {
      const d = ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), Math.round(w * dpr), Math.round(h * dpr)).data;
      let black = 0, white = 0, clear = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 20) clear += 1;
        else if (d[i] < 40 && d[i + 1] < 40 && d[i + 2] < 40) black += 1;
        else if (d[i] > 215 && d[i + 1] > 215 && d[i + 2] > 215) white += 1;
      }
      return { black, white, clear, total: d.length / 4 };
    };
    return { inside: count(124, 164, 392, 252), outsideAbove: count(0, 0, 800, 156), outsideRight: count(526, 0, 270, 640), outsideLeft: count(0, 0, 116, 640) };
  });
  check("rect mode: inside the rectangle has crisp black and white stripes", pix.inside.black > pix.inside.total * 0.3 && pix.inside.white > pix.inside.total * 0.3 && pix.inside.clear === 0, pix.inside);
  check("rect mode: nothing is drawn outside the rectangle", pix.outsideAbove.clear === pix.outsideAbove.total && pix.outsideRight.clear === pix.outsideRight.total && pix.outsideLeft.clear === pix.outsideLeft.total, pix);
  const through = await dpage.evaluate(() => {
    const e = document.elementFromPoint(300, 300);
    return { id: e && e.id, tag: e && e.tagName, pe: getComputedStyle(document.getElementById("line-half-mask-root")).pointerEvents };
  });
  check("rect mode: the stripes do not block the page (pointer-events none)", through.pe === "none" && through.id !== "line-half-mask-root", through);
  await dpage.screenshot({ path: path.join(shotDir, "desktop-train-rect.png"), clip: { x: 0, y: 0, width: 800, height: 640 } });
  // ページに付いてスクロールする
  await dpage.evaluate(() => { window.scrollTo(0, 100); });
  await dpage.waitForTimeout(120);
  rs = await rectState();
  check("rect mode: the rectangle is anchored to the page and scrolls with it", rs.masks.length === 1 && Math.abs(rs.masks[0].top - 60) <= 1 && Math.abs(rs.masks[0].bottom - 320) <= 1, rs.masks);
  await dpage.evaluate(() => { window.scrollTo(0, 0); });
  await dpage.waitForTimeout(100);
  // 中のクリックでは終わらない。外のクリックで終わり、そのクリックはページにも届く。
  const downsBefore = await dpage.evaluate(() => window.__mousedowns);
  await dpage.mouse.click(300, 300);
  await dpage.waitForTimeout(60);
  check("rect mode: a click inside keeps the rectangle", (await st()).selectionOn === true);
  await dpage.mouse.click(700, 600);
  await dpage.waitForTimeout(80);
  const afterOut = await st();
  const downsAfter = await dpage.evaluate(() => window.__mousedowns);
  check("rect mode: a click elsewhere ends it, removes the canvas, and still reaches the page", afterOut.selectionOn === false && (await rootGone()) && downsAfter === downsBefore + 2, { afterOut, downsBefore, downsAfter });

  // 小さなドラッグ・Esc
  await dpage.evaluate(() => window.__lineHalfMask.trainRect());
  await dpage.mouse.move(200, 200);
  await dpage.mouse.down();
  await dpage.mouse.move(203, 202);
  await dpage.mouse.up();
  await dpage.waitForTimeout(60);
  check("rect mode: a tiny drag cancels (no overlay, layer removed)", (await st()).selectionOn === false && (await layerInfo()) === null && (await rootGone()));
  await dpage.evaluate(() => window.__lineHalfMask.trainRect());
  await dpage.keyboard.press("Escape");
  await dpage.waitForTimeout(40);
  check("rect mode: Esc before dragging cancels", (await st()).dragging === false && (await layerInfo()) === null && (await rootGone()));
  await dpage.evaluate(() => window.__lineHalfMask.trainRect());
  await dpage.mouse.move(150, 150);
  await dpage.mouse.down();
  await dpage.mouse.move(400, 300, { steps: 3 });
  await dpage.keyboard.press("Escape");
  await dpage.mouse.up();
  await dpage.waitForTimeout(60);
  check("rect mode: Esc during the drag cancels", (await st()).selectionOn === false && (await layerInfo()) === null && (await rootGone()));
  await dpage.evaluate(() => window.__lineHalfMask.startRect({ left: 100, top: 100, width: 200, height: 120 }));
  await dpage.waitForTimeout(60);
  check("rect overlay is up before Esc", (await st()).rect === true);
  await apply("top");
  rs = await rectState();
  check("D-pad ↑ on a rectangle masks its top half (50 percent)", rs.state.rect && rs.state.shown === "top" && rs.masks.length === 1 && Math.abs(rs.masks[0].top - 100) <= 1 && Math.abs((rs.masks[0].bottom - rs.masks[0].top) - 60) <= 1, rs.masks);
  await apply("full");
  await dpage.keyboard.press("Escape");
  await dpage.waitForTimeout(60);
  check("rect mode: Esc ends the stripes", (await st()).selectionOn === false && (await rootGone()));

  // 範囲の指定と選択範囲は同時に出ない。ページ全体のマスクは終われば戻る。
  await dpage.evaluate(() => window.__lineHalfMask.start());
  await dpage.waitForTimeout(60);
  await dpage.evaluate(() => window.__lineHalfMask.startRect({ left: 100, top: 100, width: 300, height: 200 }));
  await dpage.waitForTimeout(60);
  rs = await rectState();
  check("a rectangle hides the page-wide mask while it is shown", rs.state.rect && rs.state.on && rs.masks.length === 1, rs);
  await dpage.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("p-ja"));
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    window.__lineHalfMask.overlaySelection();
  });
  await dpage.waitForTimeout(60);
  state = await st();
  check("starting a selection overlay replaces the rectangle", state.selectionOn && state.rect === false, state);
  await dpage.evaluate(() => { getSelection().removeAllRanges(); window.__lineHalfMask.trainRect(); });
  await dpage.mouse.move(100, 100);
  await dpage.mouse.down();
  await dpage.mouse.move(380, 260, { steps: 3 });
  await dpage.mouse.up();
  await dpage.waitForTimeout(80);
  state = await st();
  check("dragging a rectangle replaces the selection overlay", state.selectionOn && state.rect === true, state);
  await dpage.mouse.click(700, 650);
  await dpage.waitForTimeout(80);
  rs = await rectState();
  const back = await dpage.evaluate(measureFn);
  check("ending the rectangle brings the page-wide mask back", rs.state.on && !rs.state.selectionOn && matchMasks(await readMasks(dpage), expectedMasks(back.all, rs.state.parity, back.viewport)).ok, { on: rs.state.on, n: rs.masks.length });
  await dpage.close();
}

// ----- mobile-width screenshots and a geometry check -----
const mobile = { width: 360, height: 1800 };
const mpage = await openPage(browser, url, mobile);
await mpage.screenshot({ path: path.join(shotDir, "mobile-off.png") });
await mpage.evaluate(() => window.__lineHalfMask.start());
await mpage.waitForTimeout(80);
await mpage.evaluate(() => window.__lineHalfMask.pause(true));
await mpage.screenshot({ path: path.join(shotDir, "mobile-normal.png") });
const mA = await mpage.evaluate(measureFn);
const mActualA = await readMasks(mpage);
const mMatchA = matchMasks(mActualA, expectedMasks(mA.all, 0, mA.viewport));
check("mobile width state A midpoints", mMatchA.ok, mMatchA);
check(
  "mobile width: first line bottom half masked in normal state",
  hasMask(mActualA, halfOf(mA.all[0], false)),
  { lines: mA.all.length }
);

await mpage.evaluate(() => window.__lineHalfMask.swap());
await mpage.waitForTimeout(80);
await mpage.evaluate(() => window.__lineHalfMask.pause(true));
await mpage.screenshot({ path: path.join(shotDir, "mobile-flipped.png") });
const mB = await mpage.evaluate(measureFn);
const mActualB = await readMasks(mpage);
const mMatchB = matchMasks(mActualB, expectedMasks(mB.all, 1, mB.viewport));
check("mobile width state B midpoints", mMatchB.ok, mMatchB);
check(
  "mobile width: first line top half is masked when flipped",
  hasMask(mActualB, halfOf(mB.all[0], true))
);
await mpage.close();


// Popup: shortcut fields on desktop, hidden on Android; key capture and reset
{
  const stub = (os, store) => ({
    content: `
      window.__commandStore = ${JSON.stringify(store)};
      window.__commandUpdates = [];
      window.__commandResets = [];
      window.__storage = { ratio: 50 };
      window.__storageSets = [];
      window.__messages = [];
      window.__page = { on: false, selectionOn: false, rect: false, shown: "off" };
      const api = {
        tabs: {
          query: async () => [{ id: 1 }],
          sendMessage: async (_id, msg) => {
            window.__messages.push(msg);
            if (msg && msg.type === "setRatio") window.__storage.ratio = msg.ratio;
            const pg = window.__page;
            if (msg && msg.type === "applyCoverage") {
              if (msg.coverage === "off") { pg.on = false; pg.selectionOn = false; pg.shown = "off"; }
              else {
                if (!pg.selectionOn && window.__hasSelection) pg.selectionOn = true;
                if (!pg.selectionOn) pg.on = true;
                pg.shown = msg.coverage;
              }
            }
            return { on: pg.on, parity: 0, selectionOn: pg.selectionOn, rect: pg.rect, shown: pg.shown, ratio: window.__storage.ratio };
          },
        },
        storage: {
          local: {
            get: async (keys) => {
              if (!keys) return Object.assign({}, window.__storage);
              if (typeof keys === "string") return { [keys]: window.__storage[keys] };
              if (Array.isArray(keys)) {
                const out = {};
                for (const k of keys) out[k] = window.__storage[k];
                return out;
              }
              return Object.assign({}, window.__storage);
            },
            set: async (obj) => { Object.assign(window.__storage, obj); window.__storageSets.push(obj); },
          },
        },
        runtime: { getPlatformInfo: async () => ({ os: ${JSON.stringify(os)} }) },
        commands: {
          getAll: async () => Object.keys(window.__commandStore).map((name) => ({
            name, shortcut: window.__commandStore[name]
          })),
          update: async (cmd) => {
            const used = Object.entries(window.__commandStore).some(([n, s]) => n !== cmd.name && s === cmd.shortcut);
            if (used) throw new Error("in use");
            window.__commandStore[cmd.name] = cmd.shortcut;
            window.__commandUpdates.push(cmd);
          },
          reset: async (name) => {
            const defaults = { "toggle-mask": "Alt+Shift+L", "swap-parity": "Alt+Shift+K" };
            window.__commandStore[name] = defaults[name];
            window.__commandResets.push(name);
          },
        },
      };
      window.browser = api;
      window.chrome = api;
    `
  });

  const store = { "toggle-mask": "Alt+Shift+L", "swap-parity": "Alt+Shift+K" };
  const popupPage = await browser.newPage({ viewport: { width: 320, height: 820 } });
  await popupPage.addInitScript(stub("linux", store));
  await popupPage.goto(url.replace("/tests/sample.html", "/src/popup.html"), { waitUntil: "load" });
  await popupPage.waitForTimeout(120);
  const desktopUi = await popupPage.evaluate(() => ({
    hidden: document.getElementById("shortcuts").hidden,
    hasClass: document.body.classList.contains("has-shortcuts"),
    toggle: document.getElementById("shortcut-toggle").value,
    swap: document.getElementById("shortcut-swap").value,
  }));
  check("desktop popup shows shortcut settings", desktopUi.hidden === false && desktopUi.hasClass, desktopUi);
  check("desktop popup shows default shortcuts", desktopUi.toggle === "Alt+Shift+L" && desktopUi.swap === "Alt+Shift+K", desktopUi);
  const ratioStart = await popupPage.evaluate(() => document.getElementById("ratio").value);
  check("desktop popup shows the ratio field at 50", ratioStart === "50", ratioStart);
  await popupPage.fill("#ratio", "60");
  await popupPage.evaluate(() => document.getElementById("ratio").blur());
  await popupPage.waitForTimeout(80);
  const ratioSaved = await popupPage.evaluate(() => ({
    value: document.getElementById("ratio").value,
    storage: window.__storage.ratio,
    sets: window.__storageSets,
    messages: window.__messages.filter((m) => m && m.type === "setRatio"),
  }));
  check("popup saves ratio 60 to storage and the tab", ratioSaved.value === "60" && ratioSaved.storage === 60 && ratioSaved.messages.some((m) => m.ratio === 60), ratioSaved);
  await popupPage.fill("#ratio", "40");
  await popupPage.evaluate(() => document.getElementById("ratio").blur());
  await popupPage.waitForTimeout(80);
  const ratioClamped = await popupPage.evaluate(() => ({
    value: document.getElementById("ratio").value,
    storage: window.__storage.ratio,
  }));
  check("popup clamps ratio 40 up to 50", ratioClamped.value === "50" && ratioClamped.storage === 50, ratioClamped);
  await popupPage.fill("#ratio", "60");
  await popupPage.evaluate(() => document.getElementById("ratio").blur());
  await popupPage.waitForTimeout(80);
  const removedUi = await popupPage.evaluate(() => ({
    ids: ["toggle", "swap", "overlay-selection", "black-panel", "stripe-white", "stripe-black", "stripe-speed", "random-angle"].filter((id) => document.getElementById(id)),
    buttons: [...document.querySelectorAll("button")].map((b) => b.id || b.dataset.coverage),
  }));
  check("popup has no オンにする / 塗りを入れ替え / 選択範囲に重ねる buttons and no stripe settings", removedUi.ids.length === 0, removedUi);
  check("popup buttons are only the D-pad and the shortcut reset", removedUi.buttons.join() === "top,full,off,bottom,shortcut-reset", removedUi);
  await popupPage.screenshot({ path: path.join(shotDir, "popup-shortcuts.png"), fullPage: true });

  await popupPage.click("#shortcut-toggle");
  await popupPage.keyboard.down("Alt");
  await popupPage.keyboard.down("Shift");
  await popupPage.keyboard.press("Y");
  await popupPage.keyboard.up("Shift");
  await popupPage.keyboard.up("Alt");
  await popupPage.waitForTimeout(80);
  const afterSet = await popupPage.evaluate(() => ({
    store: window.__commandStore,
    updates: window.__commandUpdates,
    value: document.getElementById("shortcut-toggle").value,
  }));
  check(
    "key capture updates toggle shortcut via commands.update",
    afterSet.store["toggle-mask"] === "Alt+Shift+Y" &&
      afterSet.updates.some((u) => u.name === "toggle-mask" && u.shortcut === "Alt+Shift+Y") &&
      afterSet.value === "Alt+Shift+Y",
    afterSet
  );

  await popupPage.click("#shortcut-swap");
  await popupPage.keyboard.down("Alt");
  await popupPage.keyboard.down("Shift");
  await popupPage.keyboard.press("Y");
  await popupPage.keyboard.up("Shift");
  await popupPage.keyboard.up("Alt");
  await popupPage.waitForTimeout(80);
  const afterConflict = await popupPage.evaluate(() => ({
    store: window.__commandStore,
    msg: document.getElementById("shortcut-msg").textContent,
  }));
  check(
    "duplicate shortcut is rejected",
    afterConflict.store["swap-parity"] === "Alt+Shift+K" && afterConflict.msg === "ほかの機能で使われています",
    afterConflict
  );

  await popupPage.click("#shortcut-reset");
  await popupPage.waitForTimeout(80);
  const afterReset = await popupPage.evaluate(() => ({
    store: window.__commandStore,
    resets: window.__commandResets,
    toggle: document.getElementById("shortcut-toggle").value,
    swap: document.getElementById("shortcut-swap").value,
  }));
  check(
    "reset restores default shortcuts",
    afterReset.store["toggle-mask"] === "Alt+Shift+L" &&
      afterReset.toggle === "Alt+Shift+L" &&
      afterReset.swap === "Alt+Shift+K" &&
      afterReset.resets.includes("toggle-mask") &&
      afterReset.resets.includes("swap-parity"),
    afterReset
  );
  await popupPage.close();

  const androidPage = await browser.newPage({ viewport: { width: 320, height: 640 } });
  await androidPage.addInitScript(stub("android", store));
  await androidPage.goto(url.replace("/tests/sample.html", "/src/popup.html"), { waitUntil: "load" });
  await androidPage.waitForTimeout(120);
  const androidUi = await androidPage.evaluate(() => ({
    hidden: document.getElementById("shortcuts").hidden,
    hasClass: document.body.classList.contains("has-shortcuts"),
    ratio: document.getElementById("ratio") ? document.getElementById("ratio").value : null,
  }));
  check("Android popup hides shortcut settings", androidUi.hidden === true && androidUi.hasClass === false, androidUi);
  check("Android popup shows the ratio field", androidUi.ratio === "50", androidUi);
  const idlePad = await androidPage.evaluate(() => [...document.querySelectorAll(".pad [data-coverage]")].map((e) => e.dataset.dir + ":" + e.dataset.coverage + ":" + e.textContent + ":" + e.classList.contains("on") + ":" + e.tabIndex));
  check("Android popup: idle D-pad is 上半分/オン/オフ/下半分 with オフ highlighted",
    idlePad.join() === "up:top:上半分:false:-1,left:full:オン:false:-1,right:off:オフ:true:-1,down:bottom:下半分:false:-1", idlePad);
  const padState = () => androidPage.evaluate(() => ({
    on: [...document.querySelectorAll(".pad button.on")].map((b) => b.dataset.coverage).join(),
    status: document.getElementById("status").textContent,
    msgs: window.__messages.filter((m) => m && m.type === "applyCoverage").map((m) => m.coverage),
    stored: window.__storage.coverage,
    fill: window.__storage.fill,
    enhHidden: document.getElementById("enhance-panel").hidden,
  }));
  // 何も選んでいない: ページ全体
  await androidPage.evaluate(() => { window.__hasSelection = false; });
  await androidPage.click('.pad [data-coverage="top"]');
  await androidPage.waitForTimeout(60);
  let st = await padState();
  check("Android popup: ↑ with no selection sends applyCoverage top and targets the whole page",
    st.msgs.join() === "top" && st.on === "top" && st.status === "いま: ページ全体（上半分）" && st.stored === "top", st);
  await androidPage.click('.pad [data-coverage="bottom"]');
  await androidPage.waitForTimeout(60);
  st = await padState();
  check("Android popup: ↓ shows 下半分 for the whole page", st.on === "bottom" && st.status === "いま: ページ全体（下半分）", st);
  await androidPage.click('.pad [data-coverage="full"]');
  await androidPage.waitForTimeout(60);
  st = await padState();
  check("Android popup: ← shows オン for the whole page", st.on === "full" && st.status === "いま: ページ全体（オン）", st);
  await androidPage.click('.pad [data-coverage="off"]');
  await androidPage.waitForTimeout(60);
  st = await padState();
  check("Android popup: → turns everything off and keeps the last stored coverage",
    st.on === "off" && st.status === "いま: オフ" && st.stored === "full" && st.msgs.slice(-1)[0] === "off", st);
  // 選択あり: 選択範囲
  await androidPage.evaluate(() => { window.__hasSelection = true; });
  await androidPage.click('.pad [data-coverage="top"]');
  await androidPage.waitForTimeout(60);
  st = await padState();
  check("Android popup: with a selection the same ↑ targets the selection", st.on === "top" && st.status === "いま: 選択範囲（上半分）", st);
  await androidPage.click('input[name="fill"][value="enhance"]');
  await androidPage.waitForTimeout(60);
  st = await padState();
  check("Android popup: choosing 視覚増強 saves the fill and shows its settings", st.fill === "enhance" && st.enhHidden === false, st);
  await androidPage.click('.pad [data-coverage="off"]');
  await androidPage.waitForTimeout(60);

  // 矢印キーは開いたときから同じ操作。数値欄にフォーカスがあるときは渡す。
  await androidPage.keyboard.press("ArrowLeft");
  await androidPage.waitForTimeout(60);
  st = await padState();
  check("Android popup: ← key applies オン and saves coverage full", st.msgs.slice(-1)[0] === "full" && st.on === "full" && st.stored === "full", st);
  await androidPage.waitForTimeout(80);
  const beforeCount = await androidPage.evaluate(() => window.__messages.length);
  await androidPage.focus("#ratio");
  await androidPage.waitForTimeout(40);
  await androidPage.keyboard.press("ArrowUp");
  await androidPage.waitForTimeout(60);
  const blocked = await androidPage.evaluate((n) => ({
    extra: window.__messages.slice(n),
    value: document.getElementById("ratio").value,
    on: [...document.querySelectorAll(".pad button.on")].map((b) => b.dataset.coverage),
    active: document.activeElement && document.activeElement.id,
  }), beforeCount);
  check("Android popup: arrows are left to a focused number field",
    blocked.extra.every((m) => m.type === "setRatio") && blocked.value === "51" && blocked.on.join() === "full" && blocked.active === "ratio", blocked);
  await androidPage.click('input[name="fill"][value="black"]');
  await androidPage.screenshot({ path: path.join(shotDir, "popup-android.png"), fullPage: true });
  await androidPage.close();
}

{
  const net = await import("net");
  const { spawn } = await import("child_process");
  const FF_BIN = firefox.executablePath();
  const port = 29211 + Math.floor(Math.random() * 200);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "lhm-mar-"));
  fs.writeFileSync(path.join(profile, "user.js"), [
    'user_pref("xpinstall.signatures.required", false);',
    'user_pref("extensions.autoDisableScopes", 0);',
    `user_pref("marionette.port", ${port});`,
    'user_pref("marionette.enabled", true);',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
    'user_pref("dom.w3c_touch_events.enabled", 2);',
  ].join("\n"));

  function Marionette(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.pending = new Map();
    this.id = 1;
    this.hello = new Promise((resolve) => { this._hello = resolve; });
    sock.on("data", (d) => this._onData(d));
  }
  Marionette.prototype._onData = function (d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (true) {
      const colon = this.buf.indexOf(0x3a);
      if (colon < 0) return;
      const len = parseInt(this.buf.slice(0, colon).toString(), 10);
      if (!Number.isFinite(len)) return;
      if (this.buf.length < colon + 1 + len) return;
      const json = this.buf.slice(colon + 1, colon + 1 + len).toString("utf8");
      this.buf = this.buf.slice(colon + 1 + len);
      const msg = JSON.parse(json);
      if (msg && !Array.isArray(msg) && this._hello) { this._hello(msg); this._hello = null; continue; }
      if (Array.isArray(msg)) {
        const [, mid, err, result] = msg;
        const pending = this.pending.get(mid);
        if (pending) {
          this.pending.delete(mid);
          if (err) pending.reject(Object.assign(new Error(err.message || JSON.stringify(err)), { err }));
          else pending.resolve(result);
        }
      }
    }
  };
  Marionette.prototype.send = function (name, parameters = {}) {
    const id = this.id++;
    const payload = JSON.stringify([0, id, name, parameters]);
    this.sock.write(Buffer.byteLength(payload, "utf8") + ":" + payload);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  };
  Marionette.prototype.val = function (r) { return r && Object.prototype.hasOwnProperty.call(r, "value") ? r.value : r; };

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  const child = spawn(FF_BIN, ["-marionette", "-remote-allow-system-access", "-headless", "-no-remote", "-profile", profile], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, MOZ_HEADLESS: "1" },
  });
  let ffLog = "";
  child.stdout.on("data", (d) => { ffLog += d.toString(); });
  child.stderr.on("data", (d) => { ffLog += d.toString(); });

  let menuPath = { loaded: false };
  try {
    let sock;
    for (let i = 0; i < 50; i++) {
      try {
        sock = await new Promise((resolve, reject) => {
          const s = net.connect({ host: "127.0.0.1", port }, () => resolve(s));
          s.once("error", reject);
        });
        break;
      } catch (_) { await sleep(200); }
    }
    if (!sock) throw new Error("marionette not listening: " + ffLog.slice(-500));
    const m = new Marionette(sock);
    await Promise.race([m.hello, sleep(4000).then(() => { throw new Error("no marionette hello"); })]);
    await m.send("WebDriver:NewSession", { capabilities: {} });
    const inst = await m.send("Addon:Install", { path: srcDir, temporary: true });
    menuPath.installed = m.val(inst);
    await m.send("WebDriver:SetWindowRect", { width: 800, height: 1600, x: 0, y: 0 });
    await m.send("WebDriver:SetTimeouts", { script: 20000, pageLoad: 20000, implicit: 0 });
    await m.send("WebDriver:Navigate", { url });
    await sleep(800);
    await m.send("Marionette:SetContext", { value: "content" });
    const prep = m.val(await m.send("WebDriver:ExecuteScript", {
      script: `const el = document.getElementById("p-ja");
        if (!el) return { ok: false, reason: "no-p-ja" };
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 80, clientY: 200 }));
        return { ok: true, selectionRemaining: getSelection().toString().length > 0, selectionLen: getSelection().toString().length };`,
      args: [],
    }));
    menuPath.prep = prep;
    // メニューと同じ経路（背景の debugMenuClick）を、拡張のページから呼んでページへ戻る。
    async function clickViaBackground(fill, action) {
      await m.send("Marionette:SetContext", { value: "chrome" });
      const opened = m.val(await m.send("WebDriver:ExecuteScript", {
        script: `const policy = WebExtensionPolicy.getByID("line.half.mask@kofu.com");
          const ext = policy.extension;
          const win = Services.wm.getMostRecentWindow("navigator:browser");
          const contentTab = win.gBrowser.selectedTab;
          const tabId = ext.tabManager.getWrapper(contentTab).id;
          const extUrl = "moz-extension://" + ext.uuid + "/popup.html";
          const newTab = win.gBrowser.addTab(extUrl, { triggeringPrincipal: ext.principal });
          win.gBrowser.selectedTab = newTab;
          win.__lhmContentTab = contentTab;
          return { tabId, extUrl };`,
        args: [],
      }));
      await sleep(700);
      let handles = m.val(await m.send("WebDriver:GetWindowHandles", {}));
      if (!Array.isArray(handles)) handles = handles ? [handles] : [];
      await m.send("Marionette:SetContext", { value: "content" });
      let popupUrl = null;
      for (const h of handles) {
        try {
          await m.send("WebDriver:SwitchToWindow", { handle: h, name: h });
          const loc = String(m.val(await m.send("WebDriver:GetCurrentURL", {})) || "");
          if (loc.startsWith("moz-extension://")) { popupUrl = loc; break; }
          if (!popupUrl) popupUrl = loc;
        } catch (e) { menuPath.switchErr = String(e && e.message || e); }
      }
      const sent = m.val(await m.send("WebDriver:ExecuteAsyncScript", {
        script: `const cb = arguments[arguments.length - 1];
          const tabId = arguments[0], fill = arguments[1], action = arguments[2];
          (async () => {
            const hasBrowser = typeof browser !== "undefined" && !!(browser.runtime && browser.runtime.sendMessage);
            let res = null, err = null;
            if (hasBrowser) {
              try { res = await browser.runtime.sendMessage({ type: "debugMenuClick", tabId, frameId: 0, fill, action }); }
              catch (e) { err = String(e && e.message || e); }
            }
            cb({ hasBrowser, href: location.href, res, err });
          })().catch((e) => cb({ err: String(e && e.message || e) }));`,
        args: [opened && opened.tabId, fill, action || null],
      }));
      await m.send("Marionette:SetContext", { value: "chrome" });
      await m.send("WebDriver:ExecuteScript", {
        script: `const win = Services.wm.getMostRecentWindow("navigator:browser");
          if (win.__lhmContentTab) win.gBrowser.selectedTab = win.__lhmContentTab;
          return true;`,
        args: [],
      });
      await sleep(300);
      await m.send("Marionette:SetContext", { value: "content" });
      for (const h of handles) {
        try {
          await m.send("WebDriver:SwitchToWindow", { handle: h, name: h });
          const loc = String(m.val(await m.send("WebDriver:GetCurrentURL", {})) || "");
          if (loc.includes("/tests/sample.html")) break;
        } catch (_) {}
      }
      return { opened, handles, popupUrl, sent };
    }
    const first = await clickViaBackground("black");
    menuPath.tabId = first.opened && first.opened.tabId;
    menuPath.handles = first.handles;
    menuPath.popupUrl = first.popupUrl;
    menuPath.sent = first.sent;
    menuPath.res = first.sent && first.sent.res;
    const after = m.val(await m.send("WebDriver:ExecuteScript", {
      script: `const root = document.getElementById("line-half-mask-root");
        return {
          href: location.href,
          hasRoot: !!root,
          tag: root && root.tagName,
          width: root && root.width,
          height: root && root.height,
          selectionRemaining: !!(getSelection() && getSelection().toString()),
          picker: !!document.getElementById("line-half-mask-picker"),
        };`,
      args: [],
    }));
    menuPath.after = after;
    // 窓の操作は、本物のアドオンの content script に届く keydown で確かめる。
    const pickerState = `const h = document.getElementById("line-half-mask-picker");
      return { picker: !!h, checked: h && h.shadowRoot ? [...h.shadowRoot.querySelectorAll('[aria-checked="true"]')].map((b) => b.dataset.coverage) : null,
        labels: h && h.shadowRoot ? [...h.shadowRoot.querySelectorAll("button")].map((b) => b.textContent) : null,
        root: !!document.getElementById("line-half-mask-root"), focus: document.activeElement && document.activeElement.id };`;
    const key = (k) => `window.dispatchEvent(new KeyboardEvent("keydown", { key: "${k}", bubbles: true, cancelable: true })); `;
    menuPath.pickerOpen = m.val(await m.send("WebDriver:ExecuteScript", { script: pickerState, args: [] }));
    {
      const shot = m.val(await m.send("WebDriver:TakeScreenshot", { full: false, hash: false }));
      if (typeof shot === "string" && shot.length > 100) fs.writeFileSync(path.join(shotDir, "desktop-picker-menu.png"), Buffer.from(shot, "base64"));
    }
    await m.send("WebDriver:ExecuteScript", { script: key("ArrowDown") + "return true;", args: [] });
    menuPath.pickerDown = m.val(await m.send("WebDriver:ExecuteScript", { script: pickerState, args: [] }));
    {
      const shot = m.val(await m.send("WebDriver:TakeScreenshot", { full: false, hash: false }));
      if (typeof shot === "string" && shot.length > 100) fs.writeFileSync(path.join(shotDir, "desktop-picker-menu-bottom.png"), Buffer.from(shot, "base64"));
    }
    await m.send("WebDriver:ExecuteScript", { script: key("ArrowRight") + "return true;", args: [] });
    menuPath.pickerRight = m.val(await m.send("WebDriver:ExecuteScript", { script: pickerState, args: [] }));
    await m.send("WebDriver:ExecuteScript", { script: key("ArrowUp") + "return true;", args: [] });
    menuPath.pickerUp = m.val(await m.send("WebDriver:ExecuteScript", { script: pickerState, args: [] }));
    await m.send("WebDriver:ExecuteScript", { script: key("ArrowLeft") + "return true;", args: [] });
    menuPath.pickerHome = m.val(await m.send("WebDriver:ExecuteScript", { script: pickerState, args: [] }));
    await m.send("WebDriver:ExecuteScript", { script: key("Escape") + "return true;", args: [] });
    menuPath.pickerClosed = m.val(await m.send("WebDriver:ExecuteScript", { script: pickerState, args: [] }));
    if (after && after.hasRoot && after.tag === "CANVAS") {
      const shot = m.val(await m.send("WebDriver:TakeScreenshot", { full: false, hash: false }));
      if (typeof shot === "string" && shot.length > 100) {
        fs.writeFileSync(path.join(shotDir, "desktop-selection-menu.png"), Buffer.from(shot, "base64"));
        menuPath.screenshot = true;
      }
    }
    // 視覚増強のメニュー項目も、同じ経路で。マスクを終えてから、もう一度選択して押す。
    await m.send("WebDriver:ExecuteScript", {
      script: `document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 5, clientY: 5 }));
        const el = document.getElementById("p-ja");
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 80, clientY: 200 }));
        return true;`,
      args: [],
    });
    const second = await clickViaBackground("enhance");
    menuPath.enhanceRes = second.sent && second.sent.res;
    menuPath.enhanceAfter = m.val(await m.send("WebDriver:ExecuteScript", {
      script: `const c = document.getElementById("line-half-mask-root");
        if (!c) return { hasCanvas: false };
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        let opaque = 0, odd = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] === 0) continue;
          opaque++;
          const v = d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 0 || d[i] === 255 && d[i + 1] === 255 && d[i + 2] === 255;
          if (!v) odd++;
        }
        return { hasCanvas: true, pe: getComputedStyle(c).pointerEvents, opaque, odd,
          selectionRemaining: !!(getSelection() && getSelection().toString()) };`,
      args: [],
    }));
    {
      const shot = m.val(await m.send("WebDriver:TakeScreenshot", { full: false, hash: false }));
      if (typeof shot === "string" && shot.length > 100) {
        fs.writeFileSync(path.join(shotDir, "desktop-enhance-menu.png"), Buffer.from(shot, "base64"));
        menuPath.enhanceScreenshot = true;
      }
    }
    // 何も選んでいないときのメニュー項目: 捕捉層が出て、ドラッグで視覚増強の長方形になる。
    await m.send("WebDriver:ExecuteScript", {
      script: `document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 5, clientY: 5 }));
        getSelection().removeAllRanges();
        return true;`,
      args: [],
    });
    const third = await clickViaBackground(null, "train");
    menuPath.trainRes = third.sent && third.sent.res;
    menuPath.trainLayer = m.val(await m.send("WebDriver:ExecuteScript", {
      script: `const l = document.getElementById("line-half-mask-capture");
        return { layer: !!l, cursor: l && getComputedStyle(l).cursor, root: !!document.getElementById("line-half-mask-root") };`,
      args: [],
    }));
    await m.send("WebDriver:ExecuteScript", {
      script: `const l = document.getElementById("line-half-mask-capture");
        const ev = (t, x, y) => new MouseEvent(t, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
        l.dispatchEvent(ev("mousedown", 120, 160));
        window.dispatchEvent(ev("mousemove", 300, 300));
        window.dispatchEvent(ev("mousemove", 520, 420));
        window.dispatchEvent(ev("mouseup", 520, 420));
        return true;`,
      args: [],
    });
    await sleep(150);
    menuPath.trainAfter = m.val(await m.send("WebDriver:ExecuteScript", {
      script: `const c = document.getElementById("line-half-mask-root");
        const out = { layer: !!document.getElementById("line-half-mask-capture"), hasCanvas: !!c };
        if (!c) return out;
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        let opaque = 0, odd = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] === 0) continue;
          opaque++;
          const v = d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 0 || d[i] === 255 && d[i + 1] === 255 && d[i + 2] === 255;
          if (!v) odd++;
        }
        return Object.assign(out, { opaque, odd, pe: getComputedStyle(c).pointerEvents });`,
      args: [],
    }));
    {
      const shot = m.val(await m.send("WebDriver:TakeScreenshot", { full: false, hash: false }));
      if (typeof shot === "string" && shot.length > 100) {
        fs.writeFileSync(path.join(shotDir, "desktop-train-menu.png"), Buffer.from(shot, "base64"));
        menuPath.trainScreenshot = true;
      }
    }
    try { await m.send("WebDriver:DeleteSession", {}); } catch (_) {}
    try { sock.end(); } catch (_) {}
  } catch (err) {
    menuPath = Object.assign(menuPath, { error: String(err && err.message || err), log: ffLog.slice(-800) });
  } finally {
    try { child.kill("SIGKILL"); } catch (_) {}
    await sleep(200);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  }
  check(
    "real add-on menu path: background debugMenuClick masks and then clears the page selection",
    !!(menuPath.installed === "line.half.mask@kofu.com" &&
      menuPath.prep && menuPath.prep.selectionRemaining === true &&
      menuPath.res && menuPath.res.ok === true && menuPath.res.selectionOn === true &&
      menuPath.after && menuPath.after.hasRoot && menuPath.after.tag === "CANVAS" &&
      menuPath.after.width > 0 && menuPath.after.selectionRemaining === false &&
      menuPath.screenshot),
    menuPath
  );
  check(
    "real add-on menu path: the D-pad opens with オン selected; arrows apply directly (↓ 下半分, → オフ and no canvas, ↑ 上半分, ← オン); Esc closes it and keeps the overlay",
    !!(menuPath.pickerOpen && menuPath.pickerOpen.picker && menuPath.pickerOpen.labels && menuPath.pickerOpen.labels.join() === "上半分,オン,オフ,下半分" &&
      menuPath.pickerOpen.checked.join() === "full" && !menuPath.pickerOpen.focus &&
      menuPath.pickerDown && menuPath.pickerDown.checked.join() === "bottom" &&
      menuPath.pickerRight && menuPath.pickerRight.checked.join() === "off" && menuPath.pickerRight.root === false &&
      menuPath.pickerUp && menuPath.pickerUp.checked.join() === "top" && menuPath.pickerUp.root === true &&
      menuPath.pickerHome && menuPath.pickerHome.checked.join() === "full" &&
      menuPath.pickerClosed && menuPath.pickerClosed.picker === false && menuPath.pickerClosed.root === true),
    { open: menuPath.pickerOpen, down: menuPath.pickerDown, right: menuPath.pickerRight, up: menuPath.pickerUp, home: menuPath.pickerHome, closed: menuPath.pickerClosed, error: menuPath.error }
  );
  check(
    "real add-on menu path: debugMenuClick with the enhance fill draws crisp black and white stripes and clears the selection",
    !!(menuPath.enhanceRes && menuPath.enhanceRes.ok === true && menuPath.enhanceRes.selectionOn === true && menuPath.enhanceRes.fill === "enhance" &&
      menuPath.enhanceAfter && menuPath.enhanceAfter.hasCanvas && menuPath.enhanceAfter.pe === "none" &&
      menuPath.enhanceAfter.opaque > 1000 && menuPath.enhanceAfter.odd === 0 &&
      menuPath.enhanceAfter.selectionRemaining === false && menuPath.enhanceScreenshot),
    { res: menuPath.enhanceRes, after: menuPath.enhanceAfter, shot: menuPath.enhanceScreenshot, error: menuPath.error }
  );
  check(
    "real add-on menu path: the 範囲を指定して視覚トレーニング item shows a crosshair capture layer, and a drag leaves crisp stripes with the layer removed",
    !!(menuPath.trainRes && menuPath.trainRes.ok === true &&
      menuPath.trainLayer && menuPath.trainLayer.layer && menuPath.trainLayer.cursor === "crosshair" && menuPath.trainLayer.root === false &&
      menuPath.trainAfter && menuPath.trainAfter.layer === false && menuPath.trainAfter.hasCanvas && menuPath.trainAfter.pe === "none" &&
      menuPath.trainAfter.opaque > 1000 && menuPath.trainAfter.odd === 0 && menuPath.trainScreenshot),
    { res: menuPath.trainRes, layer: menuPath.trainLayer, after: menuPath.trainAfter, error: menuPath.error }
  );
}

await browser.close();
server.close();
await browser.close();
server.close();
await browser.close();
server.close();

const summary = path.join(shotDir, "results.json");
fs.writeFileSync(summary, JSON.stringify({ failed, results }, null, 2));
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
