const api = typeof browser !== "undefined" ? browser : chrome;
const SH = globalThis.LineHalfMaskShortcuts;
const EN = globalThis.LineHalfMaskEnhance;

const status = document.getElementById("status");
const shortcutsBox = document.getElementById("shortcuts");
const shortcutMsg = document.getElementById("shortcut-msg");
const shortcutInputs = {
  "toggle-mask": document.getElementById("shortcut-toggle"),
  "swap-parity": document.getElementById("shortcut-swap"),
};
const shortcutReset = document.getElementById("shortcut-reset");

const currentShortcuts = {};

async function currentTabId() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  return tabs[0] && tabs[0].id;
}

async function send(type, extra) {
  const id = await currentTabId();
  if (!id) throw new Error("no tab");
  const msg = Object.assign({ type }, extra || {});
  return api.tabs.sendMessage(id, msg);
}

function clampRatio(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 50;
  if (n < 50) return 50;
  if (n > 90) return 90;
  return n;
}

const KEY_COVERAGE = { ArrowLeft: "full", ArrowRight: "off", ArrowUp: "top", ArrowDown: "bottom" };

function choice(name) {
  const el = document.querySelector('input[name="' + name + '"]:checked');
  return el ? el.value : "";
}

function setChoice(name, value) {
  for (const el of document.querySelectorAll('input[name="' + name + '"]')) {
    el.checked = el.value === value;
  }
}

function showFill(fill) {
  setChoice("fill", fill);
  document.getElementById("enhance-panel").hidden = fill !== "enhance";
}

function showCoverage(v) {
  for (const b of document.querySelectorAll(".pad [data-coverage]")) {
    const on = b.dataset.coverage === v;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", on ? "true" : "false");
  }
}

const COVERAGE_LABELS = { full: "オン", off: "オフ", top: "上半分", bottom: "下半分" };

// 十字の点灯と状態の一行。対象は、選択範囲（長方形の指定も）があればそれ、なければページ全体。
function showState(state) {
  const shown = state.shown || "off";
  showCoverage(shown);
  status.className = "note";
  if (state.selectionOn) status.textContent = "いま: " + (state.rect ? "指定した範囲" : "選択範囲") + "（" + COVERAGE_LABELS[shown] + "）";
  else if (state.on) status.textContent = "いま: ページ全体（" + COVERAGE_LABELS[shown] + "）";
  else status.textContent = "いま: オフ";
}

function showError() {
  status.className = "err";
  status.textContent = "このページでは使えません。タブを再読み込みしてください";
}

async function refresh() {
  showState(await send("state"));
}

// 塗りは storage に保存する。ページ側が変更を見て、出ている重ねにもすぐ反映する。
async function saveFill() {
  const fill = choice("fill");
  showFill(fill);
  try {
    if (api.storage && api.storage.local) await api.storage.local.set({ fill });
  } catch (_) {}
}

for (const el of document.querySelectorAll('input[name="fill"]')) {
  el.addEventListener("change", saveFill);
}

async function loadChoices() {
  let res = null;
  try {
    if (api.storage && api.storage.local) res = await api.storage.local.get(["fill"]);
  } catch (_) {}
  showFill(res && res.fill === "enhance" ? "enhance" : "black");
}

// 十字: 効く先はページ側が決める（選択範囲があればそれ、なければページ全体）。
async function applyCoverage(cov) {
  try {
    if (cov !== "off" && api.storage && api.storage.local) await api.storage.local.set({ coverage: cov });
  } catch (_) {}
  try {
    showState(await send("applyCoverage", { coverage: cov }));
  } catch (_) {
    showError();
  }
}

for (const b of document.querySelectorAll(".pad [data-coverage]")) {
  b.addEventListener("click", () => applyCoverage(b.dataset.coverage));
}

// 開いたときから矢印キーで範囲を選ぶ。文字・数値・スライダーにフォーカスがあるときは渡す。
function typingIn(el) {
  if (!el) return false;
  if (el.tagName === "TEXTAREA" || el.isContentEditable) return true;
  if (el.tagName !== "INPUT") return false;
  return /^(text|number|range|password|search|email|url|tel)$/.test(el.type || "text");
}

document.addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  if (typingIn(e.target) || typingIn(document.activeElement)) return;
  const cov = KEY_COVERAGE[e.key];
  if (!cov) return;
  e.preventDefault();
  applyCoverage(cov);
});

function setShortcutMsg(text, isError) {
  shortcutMsg.textContent = text || "";
  shortcutMsg.className = isError ? "err" : "note";
}

function fillInputs() {
  for (const name of Object.keys(shortcutInputs)) {
    const input = shortcutInputs[name];
    if (input !== document.activeElement) {
      input.value = currentShortcuts[name] || "";
    }
  }
}

async function loadShortcuts() {
  const list = await api.commands.getAll();
  for (const cmd of list) {
    if (shortcutInputs[cmd.name]) {
      currentShortcuts[cmd.name] = cmd.shortcut || "";
    }
  }
  fillInputs();
}

async function saveShortcut(name, shortcut) {
  for (const other of Object.keys(shortcutInputs)) {
    if (other !== name && shortcut && currentShortcuts[other] === shortcut) {
      setShortcutMsg("ほかの機能で使われています", true);
      fillInputs();
      return;
    }
  }
  try {
    await api.commands.update({ name, shortcut });
    currentShortcuts[name] = shortcut;
    fillInputs();
    setShortcutMsg("");
  } catch (_) {
    setShortcutMsg("この組み合わせは使えません", true);
    fillInputs();
  }
}

function bindShortcutInput(name, input) {
  input.addEventListener("focus", () => {
    input.placeholder = "キーを押してください";
    input.value = "";
    setShortcutMsg("");
  });
  input.addEventListener("blur", () => {
    input.placeholder = "";
    fillInputs();
  });
  input.addEventListener("keydown", async (e) => {
    if (e.key === "Tab") return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      input.blur();
      return;
    }
    const result = SH.fromEvent(e);
    if (result.status === "incomplete") return;
    if (result.status !== "ok") {
      setShortcutMsg("この組み合わせは使えません", true);
      return;
    }
    await saveShortcut(name, result.shortcut);
    input.blur();
  });
}

shortcutReset.addEventListener("click", async () => {
  try {
    for (const name of Object.keys(shortcutInputs)) {
      await api.commands.reset(name);
    }
    setShortcutMsg("");
    await loadShortcuts();
  } catch (_) {
    setShortcutMsg("既定に戻せませんでした", true);
  }
});

async function setupShortcuts() {
  let android = false;
  try {
    if (api.runtime && api.runtime.getPlatformInfo) {
      const info = await api.runtime.getPlatformInfo();
      android = info.os === "android";
    }
  } catch (_) {}
  const available = !android && api.commands && api.commands.getAll && api.commands.update && api.commands.reset;
  if (!available) return;
  document.body.classList.add("has-shortcuts");
  shortcutsBox.hidden = false;
  bindShortcutInput("toggle-mask", shortcutInputs["toggle-mask"]);
  bindShortcutInput("swap-parity", shortcutInputs["swap-parity"]);
  try {
    await loadShortcuts();
  } catch (_) {
    shortcutsBox.hidden = true;
    document.body.classList.remove("has-shortcuts");
  }
}

const ratioInput = document.getElementById("ratio");

async function loadRatio() {
  let v = 50;
  try {
    if (api.storage && api.storage.local) {
      const res = await api.storage.local.get("ratio");
      if (res && res.ratio != null) v = clampRatio(res.ratio);
    }
  } catch (_) {}
  ratioInput.value = String(v);
}

async function commitRatio() {
  const v = clampRatio(ratioInput.value);
  ratioInput.value = String(v);
  try {
    if (api.storage && api.storage.local) await api.storage.local.set({ ratio: v });
  } catch (_) {}
  try {
    await send("setRatio", { ratio: v });
  } catch (_) {}
}

ratioInput.addEventListener("change", commitRatio);
ratioInput.addEventListener("blur", commitRatio);
ratioInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    commitRatio();
    ratioInput.blur();
  }
});

const enh = {
  auto: document.getElementById("enh-auto"),
  autoPanel: document.getElementById("enh-auto-panel"),
  manualPanel: document.getElementById("enh-manual-panel"),
  dist: document.getElementById("enh-dist"),
  distV: document.getElementById("enh-dist-v"),
  hint: document.getElementById("enh-hint"),
  speed: document.getElementById("enh-speed"),
  speedV: document.getElementById("enh-speed-v"),
  rotate: document.getElementById("enh-rotate"),
  rotPanel: document.getElementById("enh-rot-panel"),
  rot: document.getElementById("enh-rot"),
  rotV: document.getElementById("enh-rot-v"),
  wander: document.getElementById("enh-wander"),
  width: document.getElementById("enh-width"),
  widthV: document.getElementById("enh-width-v"),
  colorPanel: document.getElementById("enh-color-panel"),
  hue: document.getElementById("enh-hue"),
  hueV: document.getElementById("enh-hue-v"),
};
let enhCfg = EN.defaults();

function radioValue(name) {
  const el = document.querySelector('input[name="' + name + '"]:checked');
  return el ? Number(el.value) : 1;
}

function setRadio(name, value) {
  for (const el of document.querySelectorAll('input[name="' + name + '"]')) {
    el.checked = Number(el.value) === value;
  }
}

function showEnhance() {
  const c = enhCfg;
  const S = EN.scales;
  enh.auto.checked = c.auto;
  enh.autoPanel.hidden = !c.auto;
  enh.manualPanel.hidden = c.auto;
  enh.rotPanel.hidden = !c.rotate;
  enh.colorPanel.hidden = c.color !== 1;
  enh.dist.value = String(S.progressFromDist(c.dist));
  enh.distV.textContent = "変化の大きさ " + EN.labels.dist(c.dist);
  enh.hint.textContent = EN.labels.autoHint(c.dist);
  enh.speed.value = String(S.progressFromSpeed(c.speed));
  enh.speedV.textContent = "速さ " + c.speed + " px/秒";
  setRadio("enh-dir", c.dir);
  enh.rotate.checked = c.rotate;
  enh.rot.value = String(S.progressFromRot(c.rotSpeed));
  enh.rotV.textContent = "回転の速さ " + EN.labels.rot(c.rotSpeed);
  setRadio("enh-rotdir", c.rotDir);
  enh.wander.checked = c.wander;
  const w = c.auto ? c.autoWidth : c.width;
  enh.width.value = String(w);
  enh.widthV.textContent = "縞の幅 " + w + " px";
  setRadio("enh-color", c.color);
  enh.hue.value = String(S.progressFromHueRate(c.hueRate));
  enh.hueV.textContent = "色の変化の速さ " + EN.labels.hueRate(c.hueRate);
}

async function commitEnhance() {
  const S = EN.scales;
  const auto = enh.auto.checked;
  const w = Number(enh.width.value);
  enhCfg = EN.normalize({
    auto,
    speed: S.speedFromProgress(Number(enh.speed.value)),
    width: auto ? enhCfg.width : w,
    autoWidth: auto ? w : enhCfg.autoWidth,
    dir: radioValue("enh-dir"),
    rotate: enh.rotate.checked,
    rotSpeed: S.rotFromProgress(Number(enh.rot.value)),
    rotDir: radioValue("enh-rotdir"),
    wander: enh.wander.checked,
    dist: S.distFromProgress(Number(enh.dist.value)),
    color: radioValue("enh-color"),
    hueRate: S.hueRateFromProgress(Number(enh.hue.value)),
  });
  showEnhance();
  try {
    if (api.storage && api.storage.local) await api.storage.local.set({ enhance: enhCfg });
  } catch (_) {}
}

async function loadEnhance() {
  try {
    if (api.storage && api.storage.local) {
      const res = await api.storage.local.get("enhance");
      if (res && res.enhance != null) enhCfg = EN.normalize(res.enhance);
    }
  } catch (_) {}
  showEnhance();
}

// 自動のオンオフで幅の欄が別の値に切り替わるので、先に切り替えてから保存する。
enh.auto.addEventListener("change", () => {
  enhCfg = EN.normalize(Object.assign({}, enhCfg, { auto: enh.auto.checked }));
  showEnhance();
  commitEnhance();
});
for (const el of document.querySelectorAll(".enh input, #enh-rotate, #enh-wander, input[name^='enh-']")) {
  if (el === enh.auto) continue;
  el.addEventListener(el.type === "range" ? "input" : "change", commitEnhance);
}

refresh().catch(showError);
setupShortcuts();
loadChoices();
loadRatio();
loadEnhance();
