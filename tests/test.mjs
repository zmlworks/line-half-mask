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
const contentJs = fs.readFileSync(path.join(srcDir, "content.js"), "utf8");
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

{
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reduced = await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  check("prefers-reduced-motion is set (pref and emulateMedia)", reduced === true, { reduced });
  const region = (await readMasks(page))[0];
  const clip = {
    x: Math.max(0, Math.floor(region.left + 2)),
    y: Math.max(0, Math.floor(region.top + 1)),
    width: Math.max(8, Math.min(160, Math.floor(region.width - 4))),
    height: Math.max(4, Math.min(24, Math.floor(region.height - 2))),
  };
  await page.evaluate(() => window.__lineHalfMask.pause(false));
  await page.waitForTimeout(40);
  const shotA = await page.screenshot({ clip, type: "png" });
  await page.waitForTimeout(350);
  const shotB = await page.screenshot({ clip, type: "png" });
  const same = shotA.equals(shotB);
  check("stripe flow moves under prefers-reduced-motion (pixels differ after 350ms)", same === false, { bytesA: shotA.length, bytesB: shotB.length, same });
}

await page.evaluate(() => window.__lineHalfMask.pause(true));
await page.waitForTimeout(50);
const stripeInfo = await page.evaluate(() => {
  const root = document.getElementById("line-half-mask-root");
  const cs = root ? getComputedStyle(root) : null;
  return {
    tag: root ? root.tagName : null,
    width: root ? root.width : 0,
    height: root ? root.height : 0,
    anim: cs ? cs.animationName : "",
    flowPaused: window.__lineHalfMask.getState().flowPaused,
  };
});
check("stripe overlay is a canvas", stripeInfo.tag === "CANVAS" && stripeInfo.width > 0 && stripeInfo.height > 0, stripeInfo);
check("stripe canvas is not driven by a CSS animation", !stripeInfo.anim || stripeInfo.anim === "none", stripeInfo);
check("flow is paused by stopping the frame loop", stripeInfo.flowPaused === true, stripeInfo);
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
    "paused mask region contains both black and white stripe pixels",
    counts.black > 10 && counts.white > 10,
    counts
  );
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


// Zoom stills (paused) and a short flow demo (unpaused)
{
  await page.evaluate(() => {
    window.__lineHalfMask.pause(true);
    window.__lineHalfMask.update();
  });
  await page.waitForTimeout(50);
  const clipBox = await page.evaluate(() => {
    const lines = window.__lineHalfMask.collect();
    const a = lines[2] || lines[0];
    const b = lines[6] || lines[Math.min(lines.length - 1, 4)];
    const left = Math.max(0, Math.floor(Math.min(a.left, b.left)));
    const top = Math.max(0, Math.floor(a.top));
    const right = Math.min(innerWidth, Math.ceil(Math.max(a.left + a.width, b.left + b.width)));
    const bottom = Math.min(innerHeight, Math.ceil(b.top + b.height));
    return { x: left, y: top, width: Math.max(8, right - left), height: Math.max(8, bottom - top) };
  });
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
    const tag = String(zoom).replace(".", "p");
    await page.screenshot({ path: path.join(shotDir, "stripes-zoom-" + tag + ".png") });
    const zclip = {
      x: clipBox.x * zoom,
      y: clipBox.y * zoom,
      width: clipBox.width * zoom,
      height: clipBox.height * zoom,
    };
    // Playwright clip is in CSS pixels of the viewport, not pre-zoom layout.
    // After CSS zoom, coordinates in screenshots are typically still viewport CSS pixels.
    try {
      const vp = page.viewportSize();
      const clip = {
        x: Math.max(0, Math.round(clipBox.x)),
        y: Math.max(0, Math.round(clipBox.y)),
        width: Math.min(vp.width, Math.round(clipBox.width)),
        height: Math.min(vp.height, Math.round(clipBox.height)),
      };
      await page.screenshot({ path: path.join(shotDir, "stripes-closeup-" + tag + ".png"), clip });
    } catch (err) {
      check("close-up at zoom " + zoom + " captured", false, String(err));
    }
  }
  await page.evaluate(() => {
    document.documentElement.style.zoom = "1";
    window.__lineHalfMask.update();
    window.__lineHalfMask.pause(true);
  });
  await page.waitForTimeout(50);
  check("zoom stills written", fs.existsSync(path.join(shotDir, "stripes-closeup-1.png")) && fs.existsSync(path.join(shotDir, "stripes-closeup-1p25.png")) && fs.existsSync(path.join(shotDir, "stripes-closeup-1p5.png")));

  const frameDir = path.join(os.tmpdir(), "line-half-mask-frames");
  fs.rmSync(frameDir, { recursive: true, force: true });
  fs.mkdirSync(frameDir, { recursive: true });
  await page.evaluate(() => {
    window.__lineHalfMask.pause(false);
    window.__lineHalfMask.update();
  });
  await page.waitForTimeout(40);
  const flowClip = {
    x: Math.max(0, Math.round(clipBox.x)),
    y: Math.max(0, Math.round(clipBox.y)),
    width: Math.round(clipBox.width),
    height: Math.round(clipBox.height),
  };
  const frameCount = 30;
  const frameDelayMs = 67;
  for (let i = 0; i < frameCount; i++) {
    await page.screenshot({ path: path.join(frameDir, "frame-" + String(i).padStart(3, "0") + ".png"), clip: flowClip });
    if (i + 1 < frameCount) await page.waitForTimeout(frameDelayMs);
  }
  await page.evaluate(() => window.__lineHalfMask.pause(true));
  const gifPath = path.join(shotDir, "stripes-flow.gif");
  const webpPath = path.join(shotDir, "stripes-flow.webp");
  try {
    execFileSync("ffmpeg", [
      "-y", "-framerate", "15", "-i", path.join(frameDir, "frame-%03d.png"),
      "-loop", "0",
      "-lavfi", "split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=3",
      gifPath,
    ], { stdio: "pipe" });
    check("flow GIF written", fs.existsSync(gifPath) && fs.statSync(gifPath).size > 1000, { bytes: fs.existsSync(gifPath) ? fs.statSync(gifPath).size : 0 });
  } catch (err) {
    check("flow GIF written", false, (err.stderr && err.stderr.toString()) || String(err));
  }
  try {
    execFileSync("ffmpeg", [
      "-y", "-framerate", "15", "-i", path.join(frameDir, "frame-%03d.png"),
      "-loop", "0", "-c:v", "libwebp", "-lossless", "0", "-q:v", "70",
      "-quality", "70", webpPath,
    ], { stdio: "pipe" });
    check("flow WebP written", fs.existsSync(webpPath) && fs.statSync(webpPath).size > 500, { bytes: fs.existsSync(webpPath) ? fs.statSync(webpPath).size : 0 });
  } catch (err) {
    check("flow WebP written", false, (err.stderr && err.stderr.toString()) || String(err));
  }
  fs.rmSync(frameDir, { recursive: true, force: true });
}

await page.evaluate(() => window.__lineHalfMask.toggle());
await page.waitForTimeout(60);
const off = await page.evaluate(() => ({
  state: window.__lineHalfMask.getState(),
  root: !!document.getElementById("line-half-mask-root"),
}));
check("toggle off removes overlay", off.state.on === false && off.root === false, off);
await page.close();

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
      const api = {
        tabs: {
          query: async () => [{ id: 1 }],
          sendMessage: async (_id, msg) => {
            window.__messages.push(msg);
            if (msg && msg.type === "setRatio") window.__storage.ratio = msg.ratio;
            return { on: false, parity: 0, ratio: window.__storage.ratio };
          },
        },
        storage: {
          local: {
            get: async () => ({ ratio: window.__storage.ratio }),
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
  const popupPage = await browser.newPage({ viewport: { width: 320, height: 520 } });
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
  await popupPage.screenshot({ path: path.join(shotDir, "popup-shortcuts.png") });

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

  const androidPage = await browser.newPage({ viewport: { width: 320, height: 400 } });
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
  await androidPage.close();
}

await browser.close();
server.close();

const summary = path.join(shotDir, "results.json");
fs.writeFileSync(summary, JSON.stringify({ failed, results }, null, 2));
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
