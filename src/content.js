// 行の半分マスク: ページ全体の視覚行を上から通しで番号づけし、各行の半分を塗る。
// 通常 (parity=0): 奇数行の下半分と偶数行の上半分。
// 入れ替え (parity=1): その逆（1行目の上半分も含む）。
(() => {
  const api = typeof browser !== "undefined" ? browser : typeof chrome !== "undefined" ? chrome : null;
  const ROOT_ID = "line-half-mask-root";
  const Z = "2147483647";
  // 45度の縞（黒1px＋白1px）。勾配方向 2px が1周期。約 3px/s。
  // 流れは canvas を毎フレーム描き直す。CSS アニメや clip-path 内の transform、
  // background-position は Firefox で再描画されないことがある。OS の動きを減らす設定も無視する。
  const STRIPE_PERIOD = 2;
  const STRIPE_SPEED = 3;
  const RATIO_MIN = 50;
  const RATIO_MAX = 90;
  const RATIO_DEFAULT = 50;
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
  let ratio = RATIO_DEFAULT;
  let flowRaf = 0;
  let flowT0 = 0;
  let flowPausedMs = 0;
  let flowPausedAt = 0;
  let flowPaused = false;
  let lastMasks = [];

  function clampRatio(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return RATIO_DEFAULT;
    if (n < RATIO_MIN) return RATIO_MIN;
    if (n > RATIO_MAX) return RATIO_MAX;
    return n;
  }

  function reportState() {
    if (!api || !api.runtime || !api.runtime.sendMessage) return;
    try { api.runtime.sendMessage({ type: "state", on, parity, ratio }); } catch (_) {}
  }

  function setRatio(v) {
    const next = clampRatio(v);
    if (next === ratio) return next;
    ratio = next;
    if (on) update();
    reportState();
    return ratio;
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
    startFlow();
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
    stopFlow();
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
    lastMasks = [];
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

  function sizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.max(1, innerWidth);
    const cssH = Math.max(1, innerHeight);
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (root.width !== w || root.height !== h) {
      root.width = w;
      root.height = h;
    }
    root.style.width = cssW + "px";
    root.style.height = cssH + "px";
    root.style.left = "0px";
    root.style.top = "0px";
  }

  function ensureRoot() {
    if (root && root.isConnected && root.tagName === "CANVAS") return;
    if (root) root.remove();
    root = document.getElementById(ROOT_ID);
    if (!root || root.tagName !== "CANVAS") {
      if (root) root.remove();
      root = document.createElement("canvas");
      root.id = ROOT_ID;
      root.setAttribute("aria-hidden", "true");
    }
    root.style.cssText =
      "position:fixed;left:0;top:0;right:auto;bottom:auto;" +
      "pointer-events:none;z-index:" + Z + ";margin:0;padding:0;border:none;";
    (document.documentElement || document.body).appendChild(root);
    sizeCanvas();
  }

  // getClientRects は CSS zoom 後の座標。canvas の描画面は zoom 前の
  // レイアウト座標なので、親の zoom で見た表示サイズとの比で割る。
  function clientScale() {
    if (!root) return 1;
    const shown = root.getBoundingClientRect().width;
    const local = root.offsetWidth || innerWidth;
    const s = shown / local;
    return s > 0 && Number.isFinite(s) ? s : 1;
  }

  function applyClips(masks) {
    lastMasks = masks;
    applyFlow(performance.now());
  }

  function drawStripes(c, d) {
    // 回転の中心は原点（ビューポート左上）なので、塗りの範囲は
    // 各マスクの幅・高さではなく、画面全体を覆う大きさにする。
    // 以前は pad = width+height だったため、斜めの塗りが途中で切れ、
    // 下の行ほど短く見え、ページ下部はほとんど塗られなかった。
    if (!lastMasks.length) return;
    const s = clientScale();
    c.save();
    c.imageSmoothingEnabled = false;
    c.beginPath();
    for (let i = 0; i < lastMasks.length; i++) {
      const m = lastMasks[i];
      if (m.width <= 0 || m.height <= 0) continue;
      c.rect(m.left / s, m.top / s, m.width / s, m.height / s);
    }
    c.clip();
    c.translate(d, d);
    c.rotate(-Math.PI / 4);
    const pad = innerWidth + innerHeight + 32;
    const x0 = -pad;
    const y0 = -pad;
    const w = pad * 2;
    const h = pad * 2;
    c.fillStyle = "#000";
    c.fillRect(x0, y0, w, h);
    c.fillStyle = "#fff";
    const yStart = Math.floor(y0 / STRIPE_PERIOD) * STRIPE_PERIOD + 1;
    for (let y = yStart; y < y0 + h; y += STRIPE_PERIOD) {
      c.fillRect(x0, y, w, 1);
    }
    c.restore();
  }

  function flowElapsed(now) {
    return Math.max(0, now - flowT0 - flowPausedMs);
  }

  function applyFlow(now) {
    if (!root) return;
    sizeCanvas();
    const dpr = window.devicePixelRatio || 1;
    const c = root.getContext("2d", { alpha: true });
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, innerWidth, innerHeight);
    if (!lastMasks.length) return;
    const along = (flowElapsed(now) / 1000) * STRIPE_SPEED;
    const d = ((along % STRIPE_PERIOD) + STRIPE_PERIOD) % STRIPE_PERIOD / Math.SQRT2;
    drawStripes(c, d);
  }

  function flowTick(now) {
    flowRaf = 0;
    if (!on || flowPaused) return;
    applyFlow(now);
    flowRaf = requestAnimationFrame(flowTick);
  }

  function startFlow() {
    if (!root) return;
    if (!flowT0) {
      flowT0 = performance.now();
      flowPausedMs = 0;
    }
    if (flowPaused) {
      flowPausedMs += performance.now() - flowPausedAt;
      flowPaused = false;
    }
    if (!flowRaf) flowRaf = requestAnimationFrame(flowTick);
  }

  function stopFlow() {
    if (flowRaf) {
      cancelAnimationFrame(flowRaf);
      flowRaf = 0;
    }
    flowT0 = 0;
    flowPausedMs = 0;
    flowPausedAt = 0;
    flowPaused = false;
  }

  function pause(paused) {
    if (paused) {
      if (flowPaused) return;
      flowPaused = true;
      flowPausedAt = performance.now();
      if (flowRaf) {
        cancelAnimationFrame(flowRaf);
        flowRaf = 0;
      }
      applyFlow(flowPausedAt);
      return;
    }
    if (!on) return;
    startFlow();
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
      const h = line.bottom - line.top;
      const frac = ratio / 100;
      const coverTop = coverTopForIndex(i);
      const top = coverTop ? line.top : line.top + h * (1 - frac);
      const bottom = coverTop ? line.top + h * frac : line.bottom;
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
      applyClips(collect());
    } finally {
      updating = false;
    }
  }

  if (api && api.runtime && api.runtime.onMessage) {
    api.runtime.onMessage.addListener((msg) => {
      if (!msg || !msg.type) return;
      if (msg.type === "toggle") toggle();
      else if (msg.type === "swap") swap();
      else if (msg.type === "setRatio") {
        setRatio(msg.ratio);
        return Promise.resolve({ on, parity, ratio });
      } else if (msg.type === "state") return Promise.resolve({ on, parity, ratio });
    });
  }

  // テストと一時的な確認用。ページ側から操作できる。
  globalThis.__lineHalfMask = {
    toggle,
    swap,
    start,
    stop,
    update,
    getState() { return { on, parity, ratio, flowPaused }; },
    collect,
    collectLines,
    pause,
    setRatio,
    clampRatio,
  };

  function bindStorage() {
    if (!api || !api.storage || !api.storage.local) return;
    try {
      api.storage.local.get("ratio").then((res) => {
        if (res && res.ratio != null) setRatio(res.ratio);
      }).catch(() => {});
    } catch (_) {}
    if (api.storage.onChanged) {
      api.storage.onChanged.addListener((changes, area) => {
        if (area && area !== "local") return;
        if (changes && Object.prototype.hasOwnProperty.call(changes, "ratio")) {
          setRatio(changes.ratio && changes.ratio.newValue);
        }
      });
    }
  }
  bindStorage();
})();
