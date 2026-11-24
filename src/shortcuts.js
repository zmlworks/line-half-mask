// ショートカット文字列の作成と、Firefox が受け付ける形式かの確認。
(() => {
  const PRIMARY = new Set(["Ctrl", "Alt", "Command", "MacCtrl"]);
  const KEY_BY_EVENT = {
    " ": "Space",
    Spacebar: "Space",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    ",": "Comma",
    ".": "Period",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    Insert: "Insert",
    Delete: "Delete",
    MediaTrackNext: "MediaNextTrack",
    MediaTrackPrevious: "MediaPrevTrack",
    MediaPlayPause: "MediaPlayPause",
    MediaStop: "MediaStop",
  };
  const MEDIA = new Set(["MediaNextTrack", "MediaPrevTrack", "MediaPlayPause", "MediaStop"]);
  const SPECIAL = new Set([
    "Space", "Comma", "Period", "Home", "End", "PageUp", "PageDown",
    "Insert", "Delete", "Up", "Down", "Left", "Right",
    ...MEDIA,
  ]);

  const DEFAULTS = {
    "toggle-mask": "Alt+Shift+L",
    "swap-parity": "Alt+Shift+K",
  };

  function isMac() {
    if (typeof navigator === "undefined") return false;
    const plat = navigator.platform || "";
    const ua = navigator.userAgent || "";
    return /Mac/i.test(plat) || /Mac OS/i.test(ua);
  }

  function keyName(e) {
    if (!e || !e.key) return null;
    if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") {
      return null;
    }
    if (/^F([1-9]|1[0-2])$/.test(e.key)) return e.key;
    if (e.key.length === 1 && /[A-Za-z]/.test(e.key)) return e.key.toUpperCase();
    if (e.key.length === 1 && /[0-9]/.test(e.key)) return e.key;
    if (KEY_BY_EVENT[e.key]) return KEY_BY_EVENT[e.key];
    if (e.code === "Comma") return "Comma";
    if (e.code === "Period") return "Period";
    return null;
  }

  function modifierNames(e) {
    const mods = [];
    if (isMac()) {
      if (e.metaKey) mods.push("Command");
      if (e.ctrlKey) mods.push("MacCtrl");
    } else if (e.ctrlKey) {
      mods.push("Ctrl");
    }
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");
    return mods;
  }

  function isValidKey(key) {
    if (!key) return false;
    if (/^F([1-9]|1[0-2])$/.test(key)) return true;
    if (/^[A-Z]$/.test(key)) return true;
    if (/^[0-9]$/.test(key)) return true;
    return SPECIAL.has(key);
  }

  function isValidShortcut(shortcut) {
    if (typeof shortcut !== "string" || !shortcut) return false;
    const parts = shortcut.split("+");
    if (parts.length === 1 && MEDIA.has(parts[0]) && isValidKey(parts[0])) return true;
    if (parts.length < 2 || parts.length > 3) return false;
    const key = parts[parts.length - 1];
    const mods = parts.slice(0, -1);
    if (!isValidKey(key)) return false;
    const seen = new Set();
    let primary = 0;
    for (const m of mods) {
      if (seen.has(m)) return false;
      seen.add(m);
      if (PRIMARY.has(m)) primary += 1;
      else if (m !== "Shift") return false;
    }
    return primary >= 1;
  }

  // 修飾キーだけの途中入力なら incomplete。
  // キーはあるが形式外なら invalid。使えるなら shortcut を返す。
  function fromEvent(e) {
    const key = keyName(e);
    if (!key) return { status: "incomplete" };
    const mods = modifierNames(e);
    if (MEDIA.has(key) && mods.length === 0) {
      return { status: "ok", shortcut: key };
    }
    const shortcut = mods.concat(key).join("+");
    if (!isValidShortcut(shortcut)) return { status: "invalid", shortcut };
    return { status: "ok", shortcut };
  }

  globalThis.LineHalfMaskShortcuts = {
    DEFAULTS,
    isValidShortcut,
    fromEvent,
  };
})();
