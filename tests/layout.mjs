// 段組み・横並び・見出しなど、実在のサイトに多い構造で行の分け方が正しいことを確認する。
// 使い方: node tests/layout.mjs
import fs from "fs";
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
const html = fs.readFileSync(path.join(__dirname, "layout.html"), "utf8");

let failed = 0, total = 0;
function check(name, cond, info) {
  total += 1;
  const pass = !!cond;
  if (!pass) failed += 1;
  console.log(`${pass ? "OK  " : "FAIL"}  ${name}${info === undefined ? "" : "  " + JSON.stringify(info).slice(0, 500)}`);
}

const browser = await firefox.launch();
const page = await (await browser.newContext({ viewport: { width: 1024, height: 700 } })).newPage();
await page.setContent(html);
await page.addScriptTag({ content: contentJs });

const info = await page.evaluate(() => {
  const a = window.__lineHalfMask;
  a.setFill("black"); a.setCoverage && a.setCoverage("full");
  const lines = a.collectLines();
  const inside = (id) => document.getElementById(id).getBoundingClientRect();
  const within = (l, r) => (l.left + l.right) / 2 >= r.left && (l.left + l.right) / 2 <= r.right && (l.top + l.bottom) / 2 >= r.top && (l.top + l.bottom) / 2 <= r.bottom;
  const linesIn = (id) => lines.filter((l) => within(l, inside(id)));
  const main = inside("main"), side = inside("side");
  return {
    total: lines.length,
    crossColumn: lines.filter((l) => l.left < main.right && l.right > side.left).length,
    title: linesIn("title").length,
    para: linesIn("para").length,
    paraRows: linesIn("para").map((l) => l.row),
    times: linesIn("times").map((l) => ({ row: l.row, l: Math.round(l.left) })),
    tags: linesIn("tags").length,
    srp: linesIn("srp").length,
    side: lines.filter((l) => l.left >= side.left - 1).map((l) => ({ top: Math.round(l.top), bottom: Math.round(l.bottom), row: l.row })),
    rows: lines.map((l) => l.row),
  };
});

check("no line spans from the main column into the sidebar", info.crossColumn === 0, info.crossColumn);
check("big heading is one line", info.title === 1, info.title);
check("paragraph wraps into several lines, one per visual line", info.para >= 2, info.para);
check("time and link in a flex row are two boxes sharing one row number",
  info.times.length === 8 && [0, 2, 4, 6].every((i) => info.times[i].row === info.times[i + 1].row && info.times[i].l < info.times[i + 1].l), info.times);
check("row numbers of successive flex rows differ by one",
  [0, 2, 4].every((i) => info.times[i + 2].row === info.times[i].row + 1), info.times);
check("inline-block pills on one line stay one line", info.tags === 1, info.tags);
check("screen-reader-only text does not take a line", info.srp === 2 || info.srp === 1, info.srp);
check("sidebar thumbnail rows give separate lines (wrapped title lines, then date) that do not overlap",
  info.side.length === 6 && info.side.every((l, i) => i === 0 || i === 3 || l.top >= info.side[i - 1].bottom - 2), info.side);
check("row numbers never decrease", info.rows.every((r, i) => i === 0 || r >= info.rows[i - 1]), info.rows);

// 実際にマスクを出して、同じ段の隣の行と重ならないことも確かめる。
const masks = await page.evaluate(() => {
  const a = window.__lineHalfMask;
  a.setFill("black"); a.start(); a.pause(true); a.update();
  return a.collect().map((m) => ({ top: m.top, bottom: m.top + m.height, left: m.left, right: m.left + m.width }));
});
let overlap = 0;
for (let i = 0; i < masks.length; i++) for (let j = i + 1; j < masks.length; j++) {
  const a = masks[i], b = masks[j];
  if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2) overlap += 1;
}
check("no two masks overlap on the multi-column page", masks.length > 0 && overlap === 0, { masks: masks.length, overlap });

await browser.close();
console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
