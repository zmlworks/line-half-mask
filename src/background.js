// ショートカット（パソコン用）を、いまのタブの content.js へ伝える。
// ツールバーは popup.html で操作する（Android でも同じ）。
// 選択範囲のコンテキストメニューは menus API があるときだけ（パソコン向け）。
// Firefox の MV3 背景はイベントページなので、メニュー作成と onClicked は
// 毎回の起動時（トップレベル）で登録する。remove して非同期に作り直すと欠けることがある。
const api = typeof browser !== "undefined" ? browser : chrome;
const MENU_ID = "line-half-mask-selection";
const ENHANCE_MENU_ID = "line-half-mask-enhance";
// メニュー項目と、content.js へ送るメッセージの対応。
const MENU_ITEMS = [
  { id: MENU_ID, title: "選択範囲だけマスク", type: "maskSelection" },
  { id: ENHANCE_MENU_ID, title: "選択範囲に視覚増強", type: "enhanceSelection" },
];

function menusApi() {
  return (api && (api.menus || api.contextMenus)) || null;
}

async function send(tabId, type, opts) {
  const options = opts && opts.frameId != null ? { frameId: opts.frameId } : {};
  try {
    return await api.tabs.sendMessage(tabId, { type }, options);
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

async function sendMaskSelection(tabId, frameId, type) {
  if (!tabId) return { ok: false, reason: "no-tab" };
  if (!type) type = "maskSelection";
  const opts = frameId != null ? { frameId } : {};
  let res = await send(tabId, type, opts);
  // 受信側がいるなら、選択が空で ok:false でも再注入しない（二重起動を避ける）。
  if (res) return res;
  const injected = await injectContent(tabId, frameId);
  if (injected) res = await send(tabId, type, opts);
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
    const title = msg.on || msg.selectionOn || msg.enhanceOn ? "行の半分マスク（オン）" : "行の半分マスク";
    api.action.setTitle({ tabId: sender.tab.id, title });
    return;
  }
  // テストと、メニューと同じ経路を辿るためのフック。
  if (msg.type === "debugMenuClick") {
    const tabId = msg.tabId != null ? msg.tabId : (sender.tab && sender.tab.id);
    const frameId = msg.frameId != null ? msg.frameId : sender.frameId;
    return sendMaskSelection(tabId, frameId, msg.action);
  }
});

function ensureMenu() {
  const menus = menusApi();
  if (!menus || !menus.create) return;
  for (const item of MENU_ITEMS) {
    try {
      const created = menus.create({ id: item.id, title: item.title, contexts: ["selection"] });
      if (created && typeof created.then === "function") {
        created.catch(() => {});
      }
    } catch (_) {
      // 同じ id が既にある場合など。項目自体は残る。
    }
  }
}

function onMenuClick(info, tab) {
  const item = info && MENU_ITEMS.find((m) => m.id === info.menuItemId);
  if (!item) return;
  const tabId = (tab && tab.id) != null ? tab.id : info.tabId;
  const frameId = info.frameId;
  return sendMaskSelection(tabId, frameId, item.type);
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

// テストからメニュー経路と同じ sendMaskSelection を呼べるようにする。
globalThis.__lineHalfMaskBg = { MENU_ID, ENHANCE_MENU_ID, sendMaskSelection, onMenuClick };
