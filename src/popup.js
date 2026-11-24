const api = typeof browser !== "undefined" ? browser : chrome;
const SH = globalThis.LineHalfMaskShortcuts;

const toggleBtn = document.getElementById("toggle");
const swapBtn = document.getElementById("swap");
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

function showState(state) {
  toggleBtn.textContent = state.on ? "オフにする" : "オンにする";
  toggleBtn.classList.toggle("on", !!state.on);
  status.className = "note";
  if (!state.on) status.textContent = "いま: オフ";
  else if (state.parity) status.textContent = "いま: オン（入れ替え）";
  else status.textContent = "いま: オン（通常）";
}

function showError() {
  status.className = "err";
  status.textContent = "このページでは使えません。タブを再読み込みしてください";
}

async function refresh() {
  showState(await send("state"));
}

toggleBtn.addEventListener("click", async () => {
  try {
    await send("toggle");
    await refresh();
  } catch (_) {
    showError();
  }
});

swapBtn.addEventListener("click", async () => {
  try {
    await send("swap");
    await refresh();
  } catch (_) {
    showError();
  }
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

refresh().catch(showError);
setupShortcuts();
loadRatio();
