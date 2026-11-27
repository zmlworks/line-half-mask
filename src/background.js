// ショートカット（パソコン用）を、いまのタブの content.js へ伝える。
// ツールバーは popup.html で操作する（Android でも同じ）。
// コンテキストメニューは menus API があるときだけ（パソコン向け）。
// 選択しているとき「選択範囲に行マスク」、何も選んでいないとき「範囲を指定して視覚トレーニング」。
// Firefox の MV3 背景はイベントページなので、メニュー作成と onClicked は
// 毎回の起動時（トップレベル）で登録する。
const api = typeof browser !== "undefined" ? browser : chrome;
const MENU_ID = "line-half-mask-selection";
const MENU_TITLE = "選択範囲に行マスク";
const TRAIN_ID = "line-half-mask-train";
const TRAIN_TITLE = "範囲を指定して視覚トレーニング";

function menusApi() {
  return (api && (api.menus || api.contextMenus)) || null;
}

async function send(tabId, message, opts) {
  const options = opts && opts.frameId != null ? { frameId: opts.frameId } : {};
  try {
    return await api.tabs.sendMessage(tabId, typeof message === "string" ? { type: message } : message, options);
  } catch (_) {
    return null;
  }
}

async function injectContent(tabId, frameId) {
  if (!api.scripting || !api.scripting.executeScript) return false;
  const target = { tabId };
  if (frameId != null) target.frameIds = [frameId];
  try {
    await api.scripting.executeScript({ target, files: ["enhance.js", "content.js"] });
    return true;
  } catch (_) {
    return false;
  }
}

// メニューから: いま選んでいる塗りで選択範囲に重ね、範囲を選ぶ十字の窓を出す。
function sendOverlay(tabId, frameId, opts) {
  const message = { type: "overlaySelection", picker: true };
  if (opts && opts.fill) message.fill = opts.fill;
  return sendToContent(tabId, frameId, message);
}

// メニューから: ドラッグで長方形を指定して、そこに視覚増強を出す。
function sendTrain(tabId, frameId) {
  return sendToContent(tabId, frameId, { type: "trainRect" });
}

async function sendToContent(tabId, frameId, message) {
  if (!tabId) return { ok: false, reason: "no-tab" };
  const sendOpts = frameId != null ? { frameId } : {};
  let res = await send(tabId, message, sendOpts);
  // 受信側がいるなら、選択が空で ok:false でも再注入しない（二重起動を避ける）。
  if (res) return res;
  const injected = await injectContent(tabId, frameId);
  if (injected) res = await send(tabId, message, sendOpts);
  return res || { ok: false, reason: "no-content-script" };
}

async function activeTabId() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  return tabs[0] && tabs[0].id;
}

if (api.commands && api.commands.onCommand) {
  api.commands.onCommand.addListener(async (command) => {
    const id = await activeTabId();
    if (!id) return;
    if (command === "toggle-mask") send(id, "toggle");
    else if (command === "swap-parity") send(id, "swap");
  });
}

api.runtime.onMessage.addListener((msg, sender) => {
  if (!msg) return;
  if (msg.type === "state") {
    if (!sender.tab || !sender.tab.id) return;
    const title = msg.on || msg.selectionOn ? "行の半分マスク（オン）" : "行の半分マスク";
    api.action.setTitle({ tabId: sender.tab.id, title });
    return;
  }
  // テストと、メニューと同じ経路を辿るためのフック。
  if (msg.type === "debugMenuClick") {
    const tabId = msg.tabId != null ? msg.tabId : (sender.tab && sender.tab.id);
    const frameId = msg.frameId != null ? msg.frameId : sender.frameId;
    if (msg.action === "train") return sendTrain(tabId, frameId);
    return sendOverlay(tabId, frameId, { fill: msg.fill });
  }
});

function ensureMenu() {
  const menus = menusApi();
  if (!menus || !menus.create) return;
  const add = () => {
    for (const item of [
      { id: MENU_ID, title: MENU_TITLE, contexts: ["selection"] },
      { id: TRAIN_ID, title: TRAIN_TITLE, contexts: ["page", "frame", "link", "image", "video", "audio"] },
    ]) {
      try {
        const created = menus.create(item);
        if (created && typeof created.then === "function") created.catch(() => {});
      } catch (_) {}
    }
  };
  try {
    if (!menus.removeAll) { add(); return; }
    const r = menus.removeAll();
    if (r && typeof r.then === "function") r.then(add, add);
    else add();
  } catch (_) {
    add();
  }
}

function onMenuClick(info, tab) {
  if (!info) return;
  const tabId = (tab && tab.id) != null ? tab.id : info.tabId;
  const frameId = info.frameId;
  if (info.menuItemId === MENU_ID) return sendOverlay(tabId, frameId);
  if (info.menuItemId === TRAIN_ID) return sendTrain(tabId, frameId);
}

function bindMenus() {
  const menus = menusApi();
  if (!menus || !menus.onClicked) return;
  menus.onClicked.addListener(onMenuClick);
  ensureMenu();
}

bindMenus();
if (api.runtime && api.runtime.onInstalled) {
  api.runtime.onInstalled.addListener(() => { ensureMenu(); });
}
if (api.runtime && api.runtime.onStartup) {
  api.runtime.onStartup.addListener(() => { ensureMenu(); });
}

// テストからメニュー経路と同じ sendOverlay を呼べるようにする。
globalThis.__lineHalfMaskBg = { MENU_ID, MENU_TITLE, TRAIN_ID, TRAIN_TITLE, sendOverlay, sendTrain, onMenuClick };
