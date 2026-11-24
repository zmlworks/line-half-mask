// ショートカット（パソコン用）を、いまのタブの content.js へ伝える。
// ツールバーは popup.html で操作する（Android でも同じ）。
// 選択範囲のコンテキストメニューは menus API があるときだけ（パソコン向け）。
const api = typeof browser !== "undefined" ? browser : chrome;

async function send(tabId, type) {
  try {
    await api.tabs.sendMessage(tabId, { type });
  } catch (_) {
    // コンテンツスクリプトが無いページ（about: や PDF ビューアなど）
  }
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
  if (!msg || msg.type !== "state" || !sender.tab || !sender.tab.id) return;
  const title = msg.on || msg.selectionOn ? "行の半分マスク（オン）" : "行の半分マスク";
  api.action.setTitle({ tabId: sender.tab.id, title });
});

function bindMenus() {
  const menus = (api && (api.menus || api.contextMenus)) || null;
  if (!menus || !menus.create || !menus.onClicked) return;
  const item = {
    id: "line-half-mask-selection",
    title: "選択範囲だけマスク",
    contexts: ["selection"],
  };
  try {
    if (menus.remove) {
      const removed = menus.remove(item.id);
      if (removed && typeof removed.then === "function") {
        removed.catch(() => {}).finally(() => { try { menus.create(item); } catch (_) {} });
        menus.onClicked.addListener(onMenuClick);
        return;
      }
    }
  } catch (_) {}
  try { menus.create(item); } catch (_) {}
  menus.onClicked.addListener(onMenuClick);
}

function onMenuClick(info, tab) {
  if (!info || info.menuItemId !== "line-half-mask-selection") return;
  const id = tab && tab.id;
  if (!id) return;
  send(id, "maskSelection");
}

bindMenus();
