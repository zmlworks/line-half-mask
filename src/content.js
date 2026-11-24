// 行の半分マスク: ページ全体の視覚行を上から通しで番号づけし、各行の半分を塗る。
// 通常 (parity=0): 奇数行の下半分と偶数行の上半分。
// 入れ替え (parity=1): その逆（1行目の上半分も含む）。
(() => {
  const api = typeof browser !== "undefined" ? browser : typeof chrome !== "undefined" ? chrome : null;
  const ROOT_ID = "line-half-mask-root";
  const COLOR = "#000";
  const Z = "2147483647";
  const TAP_MOVE = 40;
  const TAP_MS = 600;
  const TWO_TAP_MS = 500;
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT",
    "OPTION", "SVG", "CANVAS", "VIDEO", "AUDIO", "IMG", "RT", "RP"
  ]);

  let on = false;
  let parity = 0;
  let root = null;
  let scheduled = false;
  let mo = null;
  let updating = false;
  let tap = null;
  let lastTwoTapAt = 0;

  function reportState() {
    if (!api || !api.runtime || !api.runtime.sendMessage) return;
    try { api.runtime.sendMessage({ type: "state", on, parity }); } catch (_) {}
  }

  function toggle() {
    if (on) stop();
    else start();
  }

  function swap() {
    parity = parity ? 0 : 1;
    if (on) update();
    reportState();
  }

  const touchOpts = { capture: true, passive: true };

  function start() {
    if (on) return;
    on = true;
    ensureRoot();
    update();
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule, { capture: true, passive: true });
    for (const target of [window, document]) {
      target.addEventListener("touchstart", onTouchStart, touchOpts);
      target.addEventListener("touchmove", onTouchMove, touchOpts);
      target.addEventListener("touchend", onTouchEnd, touchOpts);
      target.addEventListener("touchcancel", onTouchCancel, touchOpts);
    }
    mo = new MutationObserver(onMutations);
    mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    reportState();
  }

  function stop() {
    on = false;
    tap = null;
    window.removeEventListener("scroll", schedule, { capture: true });
    window.removeEventListener("resize", schedule, { capture: true });
    lastTwoTapAt = 0;
    for (const target of [window, document]) {
      target.removeEventListener("touchstart", onTouchStart, touchOpts);
      target.removeEventListener("touchmove", onTouchMove, touchOpts);
      target.removeEventListener("touchend", onTouchEnd, touchOpts);
      target.removeEventListener("touchcancel", onTouchCancel, touchOpts);
    }
    if (mo) { mo.disconnect(); mo = null; }
    if (root) { root.remove(); root = null; }
    reportState();
  }

  function rememberTouches(e) {
    if (!tap) tap = { t0: performance.now(), pts: new Map(), max: 0, ok: true };
    const add = (t) => {
      if (!tap.pts.has(t.identifier)) {
        tap.pts.set(t.identifier, { x: t.clientX, y: t.clientY });
      }
    };
    if (e.changedTouches) for (const t of e.changedTouches) add(t);
    if (e.touches) for (const t of e.touches) add(t);
    const n = e.touches ? e.touches.length : 0;
    if (n > tap.max) tap.max = n;
    if (n > 3) tap.ok = false;
  }

  function onTouchStart(e) {
    rememberTouches(e);
    if (movedTooFar(e)) tap.ok = false;
  }

  function movedTooFar(e) {
    if (!tap || !tap.pts) return false;
    const seen = new Set();
    const check = (touchList) => {
      if (!touchList) return false;
      for (const t of touchList) {
        if (seen.has(t.identifier)) continue;
        seen.add(t.identifier);
        const p = tap.pts.get(t.identifier);
        if (!p) continue;
        const dx = t.clientX - p.x;
        const dy = t.clientY - p.y;
        if (dx * dx + dy * dy > TAP_MOVE * TAP_MOVE) return true;
      }
      return false;
    };
    return check(e.touches) || check(e.changedTouches);
  }

  function onTouchMove(e) {
    if (!tap) return;
    rememberTouches(e);
    if (movedTooFar(e)) tap.ok = false;
  }

  function onTouchEnd(e) {
    endTouches(e);
  }

  // 端末の3本指スクリーンショットなどで touchcancel になることがあるので、
  // 指がすべて離れたときと同じ扱いにする。
  function onTouchCancel(e) {
    endTouches(e);
  }

  function endTouches(e) {
    if (!tap) return;
    rememberTouches(e);
    if (movedTooFar(e)) tap.ok = false;
    if (e.touches && e.touches.length > 0) return;
    const dur = performance.now() - tap.t0;
    const max = tap.max;
    const ok = on && tap.ok && dur <= TAP_MS;
    tap = null;
    if (!ok) {
      if (max !== 2) lastTwoTapAt = 0;
      return;
    }
    if (max === 3) {
      lastTwoTapAt = 0;
      swap();
      return;
    }
    if (max === 2) {
      const now = performance.now();
      if (lastTwoTapAt && now - lastTwoTapAt <= TWO_TAP_MS) {
        lastTwoTapAt = 0;
        swap();
      } else {
        lastTwoTapAt = now;
      }
      return;
    }
    lastTwoTapAt = 0;
  }

  function onMutations(mutations) {
    if (updating) return;
    for (const m of mutations) {
      if (root && (m.target === root || (m.target.nodeType === 1 && root.contains(m.target)))) continue;
      schedule();
      return;
    }
  }

  function schedule() {
    if (!on || scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (on) update();
    });
  }

  function ensureRoot() {
    if (root && root.isConnected) return;
    root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement("div");
      root.id = ROOT_ID;
      root.setAttribute("aria-hidden", "true");
    }
    root.style.cssText =
      "position:fixed;inset:0;width:100%;height:100%;overflow:hidden;" +
      "pointer-events:none;z-index:" + Z + ";margin:0;padding:0;border:none;";
    (document.documentElement || document.body).appendChild(root);
  }

  function isSkippedElement(el) {
    if (!el || el === root || (root && root.contains(el))) return true;
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.id === ROOT_ID) return true;
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") return true;
    const wm = st.writingMode || "";
    if (wm.indexOf("vertical") !== -1) return true;
    return false;
  }

  function ancestorClip(el) {
    const clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const st = getComputedStyle(e);
      if (st.overflowX === "visible" && st.overflowY === "visible") continue;
      const cr = e.getBoundingClientRect();
      clip.left = Math.max(clip.left, cr.left);
      clip.top = Math.max(clip.top, cr.top);
      clip.right = Math.min(clip.right, cr.right);
      clip.bottom = Math.min(clip.bottom, cr.bottom);
    }
    return clip;
  }

  function sameLine(a, b) {
    const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    const minH = Math.min(a.bottom - a.top, b.bottom - b.top);
    return minH > 0 && overlap > minH * 0.5;
  }

  function clusterLines(rects) {
    const items = rects
      .filter((r) => r.width > 0 && r.height > 0)
      .sort((a, b) => a.top - b.top || a.left - b.left);
    const lines = [];
    for (const r of items) {
      const last = lines[lines.length - 1];
      if (last && sameLine(last, r)) {
        last.top = Math.min(last.top, r.top);
        last.bottom = Math.max(last.bottom, r.bottom);
        last.left = Math.min(last.left, r.left);
        last.right = Math.max(last.right, r.right);
      } else {
        lines.push({
          top: r.top,
          bottom: r.bottom,
          left: r.left,
          right: r.right,
          el: r.el || null
        });
      }
    }
    return lines;
  }

  function collectTextNodes(from, out) {
    const walker = document.createTreeWalker(from, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === 1) {
          if (isSkippedElement(n)) return NodeFilter.FILTER_REJECT;
          if (n.shadowRoot) collectTextNodes(n.shadowRoot, out);
          return NodeFilter.FILTER_SKIP;
        }
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while ((n = walker.nextNode())) out.push(n);
  }

  function collectLines() {
    if (!document.body) return [];
    const nodes = [];
    collectTextNodes(document.body, nodes);
    const rects = [];
    const range = document.createRange();
    for (const node of nodes) {
      if (root && node.parentElement && root.contains(node.parentElement)) continue;
      range.selectNodeContents(node);
      let list;
      try { list = range.getClientRects(); } catch (_) { continue; }
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (r.width <= 0 || r.height <= 0) continue;
        rects.push({
          top: r.top,
          bottom: r.bottom,
          left: r.left,
          right: r.right,
          width: r.width,
          height: r.height,
          el: node.parentElement
        });
      }
    }
    return clusterLines(rects);
  }

  // coverTop: true ならその行の上半分、false なら下半分。
  // 通常は奇数行（0始まりで偶数 index）が下、偶数行が上。入れ替えで逆。
  function coverTopForIndex(index) {
    const odd = (index % 2) === 0;
    return odd ? parity === 1 : parity === 0;
  }

  function collect() {
    const lines = collectLines();
    const masks = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const mid = (line.top + line.bottom) / 2;
      const coverTop = coverTopForIndex(i);
      const top = coverTop ? line.top : mid;
      const bottom = coverTop ? mid : line.bottom;
      const clip = ancestorClip(line.el);
      const t = Math.max(top, clip.top);
      const bm = Math.min(bottom, clip.bottom);
      const l = Math.max(line.left, clip.left);
      const rgt = Math.min(line.right, clip.right);
      if (bm - t < 0.5 || rgt - l < 0.5) continue;
      masks.push({ top: t, left: l, height: bm - t, width: rgt - l, index: i, coverTop });
    }
    return masks;
  }

  function update() {
    if (!on) return;
    updating = true;
    try {
      ensureRoot();
      const masks = collect();
      root.textContent = "";
      for (const m of masks) {
        const el = document.createElement("div");
        el.style.cssText =
          "position:absolute;background:" + COLOR + ";pointer-events:none;margin:0;padding:0;border:none;" +
          "top:" + m.top + "px;left:" + m.left + "px;width:" + m.width + "px;height:" + m.height + "px;";
        root.appendChild(el);
      }
    } finally {
      updating = false;
    }
  }

  if (api && api.runtime && api.runtime.onMessage) {
    api.runtime.onMessage.addListener((msg) => {
      if (!msg || !msg.type) return;
      if (msg.type === "toggle") toggle();
      else if (msg.type === "swap") swap();
      else if (msg.type === "state") return Promise.resolve({ on, parity });
    });
  }

  // テストと一時的な確認用。ページ側から操作できる。
  globalThis.__lineHalfMask = {
    toggle,
    swap,
    start,
    stop,
    update,
    getState() { return { on, parity }; },
    collect,
    collectLines,
  };
})();
