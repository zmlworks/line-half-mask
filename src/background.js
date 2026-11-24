// ショートカット（パソコン用）を、いまのタブの content.js へ伝える。
// ツールバーは popup.html で操作する（Android でも同じ）。
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
  const title = msg.on ? "行の半分マスク（オン）" : "行の半分マスク";
  api.action.setTitle({ tabId: sender.tab.id, title });
});
