// 行の半分マスク: ページ全体の視覚行を上から通しで番号づけし、各行の半分を塗る。
// 通常 (parity=0): 奇数行の下半分と偶数行の上半分。
// 入れ替え (parity=1): その逆（1行目の上半分も含む）。
// もうひとつ、選択範囲に視覚増強（斜めの縞を流す）を重ねる機能がある。計算は enhance.js。
(() => {
  if (globalThis.__lineHalfMask) return;
  const api = typeof browser !== "undefined" ? browser : typeof chrome !== "undefined" ? chrome : null;
  const ROOT_ID = "line-half-mask-root";
  const ENH_ID = "line-half-mask-enhance";
  const ENH = globalThis.LineHalfMaskEnhance;
  const Z = "2147483647";
  // 既定は 45度の縞（白8px＋黒8px）、速さ約 30px/s。白と黒の幅と速さはポップアップで変えられる。
  // 流れは常に縞の法線方向。canvas を毎フレーム描き直す。OS の動きを減らす設定は無視する。
  const WIDTH_MIN = 1;
  const WIDTH_MAX = 16;
  const WIDTH_DEFAULT = 8;
  const SPEED_MIN = 0;
  const SPEED_MAX = 60;
  const SPEED_DEFAULT = 30;
  const DEFAULT_STRIPE_ANGLE = -Math.PI / 4;
  const DEFAULT_FLOW_SIGN = 1;
  const SEL_SWAP_MS = 3000;
  const CAPTURE_MS = 60000;
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
  let selectionOn = false;
  let selParity = 0;
  let selRanges = [];
  let selTimer = 0;
  let listenersBound = false;
  let touchBound = false;
  let clickBound = false;
  let fakeTimers = null;
  let capturedRanges = [];
  let capturedAt = 0;
  let stripeWhite = WIDTH_DEFAULT;
  let stripeBlack = WIDTH_DEFAULT;
  let stripeSpeed = SPEED_DEFAULT;
  let randomAngle = false;
  let stripeAngle = DEFAULT_STRIPE_ANGLE;
  let flowSign = DEFAULT_FLOW_SIGN;
  let enh = null;
  let enhCfg = ENH ? ENH.defaults() : null;

  function clampRatio(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return RATIO_DEFAULT;
    if (n < RATIO_MIN) return RATIO_MIN;
    if (n > RATIO_MAX) return RATIO_MAX;
    return n;
  }

  function clampWidth(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return WIDTH_DEFAULT;
    if (n < WIDTH_MIN) return WIDTH_MIN;
    if (n > WIDTH_MAX) return WIDTH_MAX;
    return n;
  }

  function clampSpeed(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return SPEED_DEFAULT;
    if (n < SPEED_MIN) return SPEED_MIN;
    if (n > SPEED_MAX) return SPEED_MAX;
    return n;
  }

  function toBool(v) { return v === true || v === "true" || v === 1 || v === "1"; }

  function stripePeriod() { return stripeWhite + stripeBlack; }

  function rollStripeStyle() {
    if (randomAngle) {
      stripeAngle = Math.random() * Math.PI;
      flowSign = Math.random() < 0.5 ? -1 : 1;
    } else {
      stripeAngle = DEFAULT_STRIPE_ANGLE;
      flowSign = DEFAULT_FLOW_SIGN;
    }
  }

  function applyStripePrefs(prefs, reroll) {
    if (!prefs) prefs = {};
    let changed = false;
    if (Object.prototype.hasOwnProperty.call(prefs, "stripeWhite")) {
      const w = clampWidth(prefs.stripeWhite);
      if (w !== stripeWhite) { stripeWhite = w; changed = true; }
    }
    if (Object.prototype.hasOwnProperty.call(prefs, "stripeBlack")) {
      const w = clampWidth(prefs.stripeBlack);
      if (w !== stripeBlack) { stripeBlack = w; changed = true; }
    }
    if (Object.prototype.hasOwnProperty.call(prefs, "stripeSpeed")) {
      const s = clampSpeed(prefs.stripeSpeed);
      if (s !== stripeSpeed) { stripeSpeed = s; changed = true; }
    }
    if (Object.prototype.hasOwnProperty.call(prefs, "randomAngle")) {
      const v = toBool(prefs.randomAngle);
      if (v !== randomAngle) { randomAngle = v; changed = true; reroll = true; }
    }
    if (reroll) rollStripeStyle();
    if ((changed || reroll) && (on || selectionOn)) update();
    if (changed) reportState();
  }

  function setStripeStyle(opts) {
    if (!opts) return;
    if (opts.stripeAngle != null && Number.isFinite(Number(opts.stripeAngle))) {
      stripeAngle = Number(opts.stripeAngle);
    }
    if (opts.flowSign != null) flowSign = Number(opts.flowSign) < 0 ? -1 : 1;
    if (on || selectionOn) update();
  }

  function reportState() {
    if (!api || !api.runtime || !api.runtime.sendMessage) return;
    try {
      api.runtime.sendMessage({
        type: "state",
        on, parity, ratio, selectionOn, selParity, enhanceOn: !!enh,
        stripeWhite, stripeBlack, stripeSpeed, randomAngle, flowSign
      });
    } catch (_) {}
  }

  function currentTime() {
    return fakeTimers ? fakeTimers.now : performance.now();
  }

  function scheduleInterval(fn, ms) {
    if (fakeTimers) {
      const id = { fn, ms, next: fakeTimers.now + ms, cleared: false };
      fakeTimers.intervals.push(id);
      return id;
    }
    return setInterval(fn, ms);
  }

  function clearScheduled(id) {
    if (!id && id !== 0) return;
    if (fakeTimers && typeof id === "object") {
      id.cleared = true;
      return;
    }
    clearInterval(id);
  }

  function useFakeTimers() {
    fakeTimers = { now: 0, intervals: [] };
  }

  function advanceFakeTimers(ms) {
    if (!fakeTimers) useFakeTimers();
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return fakeTimers.now;
    fakeTimers.now += n;
    const list = fakeTimers.intervals.slice();
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (it.cleared) continue;
      while (it.next <= fakeTimers.now) {
        it.fn();
        it.next += it.ms;
      }
    }
    return fakeTimers.now;
  }

  function setRatio(v) {
    const next = clampRatio(v);
    if (next === ratio) return next;
    ratio = next;
    if (on || selectionOn) update();
    reportState();
    return ratio;
  }

  function toggle() {
    if (on) stop();
    else start();
  }

  function swap() {
    rollStripeStyle();
    if (selectionOn) {
      selParity = selParity ? 0 : 1;
      update();
      reportState();
      return;
    }
    parity = parity ? 0 : 1;
    if (on) update();
    reportState();
  }

  const touchOpts = { capture: true, passive: true };

  function bindSharedListeners() {
    if (listenersBound) return;
    listenersBound = true;
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule, { capture: true, passive: true });
    mo = new MutationObserver(onMutations);
    mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  }

  function unbindSharedListeners() {
    if (!listenersBound) return;
    listenersBound = false;
    window.removeEventListener("scroll", schedule, { capture: true });
    window.removeEventListener("resize", schedule, { capture: true });
    if (mo) { mo.disconnect(); mo = null; }
  }

  function bindTouch() {
    if (touchBound) return;
    touchBound = true;
    for (const target of [window, document]) {
      target.addEventListener("touchstart", onTouchStart, touchOpts);
      target.addEventListener("touchmove", onTouchMove, touchOpts);
      target.addEventListener("touchend", onTouchEnd, touchOpts);
      target.addEventListener("touchcancel", onTouchCancel, touchOpts);
    }
  }

  function unbindTouch() {
    if (!touchBound) return;
    touchBound = false;
    for (const target of [window, document]) {
      target.removeEventListener("touchstart", onTouchStart, touchOpts);
      target.removeEventListener("touchmove", onTouchMove, touchOpts);
      target.removeEventListener("touchend", onTouchEnd, touchOpts);
      target.removeEventListener("touchcancel", onTouchCancel, touchOpts);
    }
  }

  function teardownOverlay() {
    stopFlow();
    unbindSharedListeners();
    unbindTouch();
    unbindClickExit();
    tap = null;
    lastTwoTapAt = 0;
    if (root) { root.remove(); root = null; }
    lastMasks = [];
  }

  function start() {
    if (on) return;
    on = true;
    rollStripeStyle();
    bindSharedListeners();
    bindTouch();
    if (!selectionOn) {
      ensureRoot();
      update();
      startFlow();
    }
    reportState();
  }

  function stop() {
    on = false;
    tap = null;
    lastTwoTapAt = 0;
    unbindTouch();
    if (selectionOn) {
      reportState();
      return;
    }
    teardownOverlay();
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
    if (!(on || selectionOn) || scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (on || selectionOn) update();
    });
  }

  function sizeCanvas(el) {
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.max(1, innerWidth);
    const cssH = Math.max(1, innerHeight);
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (el.width !== w || el.height !== h) {
      el.width = w;
      el.height = h;
    }
    el.style.width = cssW + "px";
    el.style.height = cssH + "px";
    el.style.left = "0px";
    el.style.top = "0px";
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
    sizeCanvas(root);
  }

  // getClientRects は CSS zoom 後の座標。canvas の描画面は zoom 前の
  // レイアウト座標なので、親の zoom で見た表示サイズとの比で割る。
  function clientScale(el) {
    if (!el) return 1;
    const shown = el.getBoundingClientRect().width;
    const local = el.offsetWidth || innerWidth;
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
    const s = clientScale(root);
    c.save();
    c.imageSmoothingEnabled = false;
    c.beginPath();
    for (let i = 0; i < lastMasks.length; i++) {
      const m = lastMasks[i];
      if (m.width <= 0 || m.height <= 0) continue;
      c.rect(m.left / s, m.top / s, m.width / s, m.height / s);
    }
    c.clip();
    // 流れは常に縞の法線（周期軸）。その成分だけを周期で折り返すので継ぎ目が出ない。
    const period = stripePeriod();
    const ax = -Math.sin(stripeAngle);
    const ay = Math.cos(stripeAngle);
    const wrapped = ((d % period) + period) % period;
    c.translate(wrapped * ax, wrapped * ay);
    c.rotate(stripeAngle);
    const pad = innerWidth + innerHeight + 32;
    const x0 = -pad;
    const y0 = -pad;
    const w = pad * 2;
    const h = pad * 2;
    c.fillStyle = "#000";
    c.fillRect(x0, y0, w, h);
    c.fillStyle = "#fff";
    const yStart = Math.floor(y0 / period) * period + stripeBlack;
    for (let y = yStart; y < y0 + h; y += period) {
      c.fillRect(x0, y, w, stripeWhite);
    }
    c.restore();
  }

  function flowElapsed(now) {
    return Math.max(0, now - flowT0 - flowPausedMs);
  }

  function applyFlow(now) {
    if (!root) return;
    sizeCanvas(root);
    const dpr = window.devicePixelRatio || 1;
    const c = root.getContext("2d", { alpha: true });
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, innerWidth, innerHeight);
    if (!lastMasks.length) return;
    const along = (flowElapsed(now) / 1000) * stripeSpeed;
    const d = along * flowSign;
    drawStripes(c, d);
  }

  function flowTick(now) {
    flowRaf = 0;
    if ((!(on || selectionOn)) || flowPaused) return;
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
    if (!on && !selectionOn) return;
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
  function coverTopForIndex(index, p) {
    if (p === undefined) p = selectionOn ? selParity : parity;
    const odd = (index % 2) === 0;
    return odd ? p === 1 : p === 0;
  }

  function masksFromLines(lines, p) {
    const masks = [];
    const frac = ratio / 100;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const h = line.bottom - line.top;
      const coverTop = coverTopForIndex(i, p);
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

  function collectPage() {
    return masksFromLines(collectLines(), parity);
  }

  // 選択範囲の Range.getClientRects を行にまとめ、各行では選択された横幅だけを塗る
  // （行箱全体ではなく、その部分だけ、という指定に合わせる）。
  function collectSelectionLines(ranges) {
    if (!ranges) ranges = selRanges;
    const rects = [];
    for (let i = 0; i < ranges.length; i++) {
      const range = ranges[i];
      if (!range || range.collapsed) continue;
      let list;
      try { list = range.getClientRects(); } catch (_) { continue; }
      const node = range.commonAncestorContainer;
      const host = node && (node.nodeType === 1 ? node : node.parentElement);
      for (let j = 0; j < list.length; j++) {
        const r = list[j];
        if (r.width <= 0 || r.height <= 0) continue;
        rects.push({
          top: r.top,
          bottom: r.bottom,
          left: r.left,
          right: r.right,
          width: r.width,
          height: r.height,
          el: host
        });
      }
    }
    return clusterLines(rects);
  }

  function collectSelection() {
    return masksFromLines(collectSelectionLines(), selParity);
  }

  function collect() {
    return selectionOn ? collectSelection() : collectPage();
  }

  function hitMask(x, y) {
    const list = enh ? enh.rects : lastMasks;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (x >= m.left && x <= m.left + m.width && y >= m.top && y <= m.top + m.height) return true;
    }
    return false;
  }

  function endRegion() {
    endSelection();
    endEnhance();
  }

  function onDocPointerDown(e) {
    if (!selectionOn && !enh) return;
    if (e.button != null && e.button !== 0) return;
    if (hitMask(e.clientX, e.clientY)) return;
    endRegion();
  }

  // タッチ: スクロールで終わらないよう、短く動かない指離し（タップ）だけを見る。
  let exitTouch = null;
  function onExitTouchStart(e) {
    const t0 = e.touches && e.touches[0];
    exitTouch = e.touches && e.touches.length === 1 && t0
      ? { x: t0.clientX, y: t0.clientY, at: Date.now() } : null;
  }
  function onExitTouchEnd(e) {
    const s = exitTouch;
    exitTouch = null;
    const t0 = e.changedTouches && e.changedTouches[0];
    if (!s || !t0 || (!selectionOn && !enh)) return;
    if (Date.now() - s.at > TAP_MS) return;
    if (Math.hypot(t0.clientX - s.x, t0.clientY - s.y) > 16) return;
    if (!hitMask(t0.clientX, t0.clientY)) endRegion();
  }

  const EXIT_OPTS = { capture: true, passive: true };
  function bindClickExit() {
    if (clickBound) return;
    clickBound = true;
    document.addEventListener("mousedown", onDocPointerDown, EXIT_OPTS);
    document.addEventListener("touchstart", onExitTouchStart, EXIT_OPTS);
    document.addEventListener("touchend", onExitTouchEnd, EXIT_OPTS);
  }

  function unbindClickExit() {
    if (!clickBound || selectionOn || enh) return;
    clickBound = false;
    document.removeEventListener("mousedown", onDocPointerDown, EXIT_OPTS);
    document.removeEventListener("touchstart", onExitTouchStart, EXIT_OPTS);
    document.removeEventListener("touchend", onExitTouchEnd, EXIT_OPTS);
  }

  function startSelTimer() {
    stopSelTimer();
    selTimer = scheduleInterval(() => {
      if (!selectionOn) return;
      selParity = selParity ? 0 : 1;
      rollStripeStyle();
      update();
    }, SEL_SWAP_MS);
  }

  function stopSelTimer() {
    if (selTimer || selTimer === 0) {
      clearScheduled(selTimer);
      selTimer = 0;
    }
  }

  function cloneSelectionRanges(sel) {
    const ranges = [];
    if (!sel) return ranges;
    for (let i = 0; i < sel.rangeCount; i++) {
      const r = sel.getRangeAt(i);
      if (r && !r.collapsed) {
        try { ranges.push(r.cloneRange()); } catch (_) {}
      }
    }
    return ranges;
  }

  function captureSelection() {
    const ranges = cloneSelectionRanges(window.getSelection && window.getSelection());
    if (ranges.length) { capturedRanges = ranges; capturedAt = Date.now(); }
    return ranges;
  }

  function rangesForMask() {
    const live = cloneSelectionRanges(window.getSelection && window.getSelection());
    if (live.length) return live;
    // メニューやポップアップを開くと選択が消えることがあるので、直前の選択を使う。
    if (Date.now() - capturedAt > CAPTURE_MS) return [];
    const saved = [];
    for (let i = 0; i < capturedRanges.length; i++) {
      const r = capturedRanges[i];
      if (!r) continue;
      try {
        if (r.collapsed) continue;
        saved.push(r.cloneRange());
      } catch (_) {
        if (r && !r.collapsed) saved.push(r);
      }
    }
    return saved;
  }

  function clearPageSelection() {
    try {
      const sel = window.getSelection && window.getSelection();
      if (sel && sel.removeAllRanges) sel.removeAllRanges();
    } catch (_) {}
  }

  function maskSelection() {
    const ranges = rangesForMask();
    if (!ranges.length) return false;
    endEnhance();
    selRanges = ranges;
    // 青の選択ハイライトが残らないよう、範囲を確保したあとで外す。
    clearPageSelection();
    selectionOn = true;
    selParity = 0;
    rollStripeStyle();
    bindSharedListeners();
    bindClickExit();
    startSelTimer();
    ensureRoot();
    update();
    startFlow();
    reportState();
    return true;
  }

  function endSelection() {
    if (!selectionOn) return;
    selectionOn = false;
    selRanges = [];
    selParity = 0;
    stopSelTimer();
    unbindClickExit();
    if (on) {
      update();
      startFlow();
    } else {
      teardownOverlay();
    }
    reportState();
  }

  // ---- 視覚増強 ----
  // 選択したすべての行を包む一つの四角を、縞の場と回転の軸の範囲にする。
  // アプリが画面全体を一つの場にするのと同じで、各行はその場を見る窓として塗る。
  // スクロールや組み直しのあとも、いまの行の位置から四角をやり直す。
  // 1 画素ずつ二色のどちらかを決めて ImageData で描く（縁をぼかさない）。
  function enhK() {
    return (window.devicePixelRatio || 1) / clientScale(enh.canvas);
  }

  function enhLayout() {
    const lines = collectSelectionLines(enh.ranges);
    const rects = [];
    for (const line of lines) {
      const clip = ancestorClip(line.el);
      const left = Math.max(line.left, clip.left);
      const top = Math.max(line.top, clip.top);
      const right = Math.min(line.right, clip.right);
      const bottom = Math.min(line.bottom, clip.bottom);
      if (right - left < 0.5 || bottom - top < 0.5) continue;
      rects.push({ left, top, width: right - left, height: bottom - top });
    }
    return { lines, rects };
  }

  // 画面外の行も含め、選択したすべての行を包む四角。原点はその左上。
  function enhBounds(lines) {
    const k = enhK();
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (const x of lines) {
      if (!x) continue;
      l = Math.min(l, x.left);
      t = Math.min(t, x.top);
      r = Math.max(r, x.right);
      b = Math.max(b, x.bottom);
    }
    if (!Number.isFinite(l)) return { ax: 0, ay: 0, w: 1, h: 1 };
    const ax = Math.round(l * k), ay = Math.round(t * k);
    return { ax, ay, w: Math.max(1, Math.round(r * k) - ax), h: Math.max(1, Math.round(b * k) - ay) };
  }

  function enhApplyBounds(lines) {
    const b = enhBounds(lines);
    enh.ax = b.ax;
    enh.ay = b.ay;
    if (!enh.box) enh.box = { w: b.w, h: b.h };
    else { enh.box.w = b.w; enh.box.h = b.h; }
    enh.reach = Math.hypot(b.w, b.h);
    if (enh.motion && enh.motion.resize) enh.motion.resize(b.w, b.h);
    return b;
  }

  function enhDraw() {
    const e = enh;
    const W = e.canvas.width, H = e.canvas.height;
    e.ctx.clearRect(0, 0, W, H);
    if (!e.rects.length || !e.pose) return;
    const k = enhK();
    const pose = e.pose;
    const c0 = pose.hue == null ? ENH.BLACK : ENH.colorAtHue(pose.hue);
    const c1 = pose.hue == null ? ENH.WHITE : ENH.colorAtHue(pose.hue + 180);
    for (const r of e.rects) {
      const x0 = Math.max(0, Math.round(r.left * k));
      const y0 = Math.max(0, Math.round(r.top * k));
      const x1 = Math.min(W, Math.round((r.left + r.width) * k));
      const y1 = Math.min(H, Math.round((r.top + r.height) * k));
      const w = x1 - x0, h = y1 - y0;
      if (w <= 0 || h <= 0) continue;
      // 拡張の content script からは、ページ側の ImageData を直接 new せず、canvas から作る。
      const key = w + "x" + h;
      let img = e.images.get(key);
      if (!img) {
        if (e.images.size > 64) e.images.clear();
        img = e.ctx.createImageData(w, h);
        e.images.set(key, img);
      }
      ENH.fillBands(new Uint32Array(img.data.buffer, 0, w * h), w, h, x0 - e.ax, y0 - e.ay, pose, c0, c1);
      e.ctx.putImageData(img, x0, y0);
    }
    e.drawn = pose;
  }

  // 姿勢が 1/3 画素以上、または色が 1 度以上動いたときだけ描き直す。
  function enhMoved(a, b) {
    if (!a) return true;
    const period = 2 * b.width;
    const d = Math.abs(a.offset - b.offset);
    return Math.min(d, period - d) > 0.34
      || Math.abs(a.angle - b.angle) * enh.reach > 0.34
      || Math.hypot(a.px - b.px, a.py - b.py) > 0.34
      || (a.hue != null && Math.abs(a.hue - b.hue) >= 1);
  }

  function enhPoseAt(t) {
    return enh.motion.pose(t);
  }

  function enhRelayout() {
    const lay = enhLayout();
    enh.rects = lay.rects;
    enhApplyBounds(lay.lines);
    enhDraw();
  }

  function enhFrame(now) {
    enh.raf = 0;
    const p = enhPoseAt((now - enh.t0) / 1000);
    if (enhMoved(enh.drawn, p)) {
      enh.pose = p;
      enhDraw();
    }
    enh.raf = requestAnimationFrame(enhFrame);
  }

  function enhScheduleLayout() {
    if (!enh || enh.scheduled) return;
    enh.scheduled = true;
    requestAnimationFrame(() => {
      if (!enh) return;
      enh.scheduled = false;
      enhRelayout();
    });
  }

  function onEnhMutations(mutations) {
    for (const m of mutations) {
      if (m.target === enh.canvas) continue;
      enhScheduleLayout();
      return;
    }
  }

  function onEnhKey(e) {
    if (e.key === "Escape") endEnhance();
  }

  function enhStartMotion(t0) {
    const lay = enhLayout();
    enh.rects = lay.rects;
    const b = enhApplyBounds(lay.lines);
    enh.motion = ENH.createMotion(enhCfg, enh.seed, b.w, b.h);
    enh.t0 = t0;
    enh.pose = enhPoseAt(0);
    enh.drawn = null;
    enhDraw();
  }

  function enhanceSelection() {
    if (!ENH) return false;
    const ranges = rangesForMask();
    if (!ranges.length) return false;
    endSelection();
    const again = !!enh;
    if (!again) {
      const canvas = document.createElement("canvas");
      canvas.id = ENH_ID;
      canvas.setAttribute("aria-hidden", "true");
      canvas.style.cssText =
        "position:fixed;left:0;top:0;right:auto;bottom:auto;" +
        "pointer-events:none;z-index:" + Z + ";margin:0;padding:0;border:none;";
      (document.documentElement || document.body).appendChild(canvas);
      sizeCanvas(canvas);
      enh = {
        canvas, ctx: canvas.getContext("2d"), ranges, rects: [], images: new Map(), raf: 0, scheduled: false,
        ax: 0, ay: 0, box: null, reach: 1, motion: null, pose: null, drawn: null, t0: 0,
        seed: 1, mo: new MutationObserver(onEnhMutations),
      };
      enh.mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
      window.addEventListener("scroll", enhScheduleLayout, { capture: true, passive: true });
      window.addEventListener("resize", enhOnResize, { capture: true, passive: true });
      document.addEventListener("keydown", onEnhKey, true);
      bindClickExit();
    } else {
      enh.ranges = ranges;
    }
    // 青の選択ハイライトが残らないよう、範囲を確保したあとで外す。
    clearPageSelection();
    enh.seed = 1 + Math.floor(Math.random() * 0x7FFFFFFF);
    enhStartMotion(performance.now());
    if (!enh.raf) enh.raf = requestAnimationFrame(enhFrame);
    reportState();
    return true;
  }

  function enhOnResize() {
    if (!enh) return;
    sizeCanvas(enh.canvas);
    enhScheduleLayout();
  }

  function endEnhance() {
    if (!enh) return;
    const e = enh;
    enh = null;
    if (e.raf) cancelAnimationFrame(e.raf);
    e.mo.disconnect();
    window.removeEventListener("scroll", enhScheduleLayout, { capture: true });
    window.removeEventListener("resize", enhOnResize, { capture: true });
    document.removeEventListener("keydown", onEnhKey, true);
    e.canvas.remove();
    unbindClickExit();
    reportState();
  }

  // 設定が変わったら、同じ選択のまま新しい設定で動かし直す。
  function setEnhance(cfg) {
    if (!ENH) return;
    enhCfg = ENH.normalize(cfg);
    if (!enh) return;
    if (enh.raf) { cancelAnimationFrame(enh.raf); enh.raf = 0; }
    enhStartMotion(performance.now());
    enh.raf = requestAnimationFrame(enhFrame);
  }

  // テスト用: 時間を止めて、開始から t 秒の姿で描く。
  function enhanceAt(t) {
    if (!enh) return false;
    if (enh.raf) { cancelAnimationFrame(enh.raf); enh.raf = 0; }
    enh.motion = ENH.createMotion(enhCfg, enh.seed, enh.box.w, enh.box.h);
    enh.pose = enhPoseAt(t);
    enhDraw();
    return true;
  }

  function update() {
    if (!selectionOn && !on) return;
    updating = true;
    try {
      ensureRoot();
      applyClips(selectionOn ? collectSelection() : collectPage());
    } finally {
      updating = false;
    }
  }

  if (api && api.runtime && api.runtime.onMessage) {
    api.runtime.onMessage.addListener((msg) => {
      if (!msg || !msg.type) return;
      if (msg.type === "toggle") toggle();
      else if (msg.type === "swap") swap();
      else if (msg.type === "maskSelection") {
        const ok = maskSelection();
        return Promise.resolve({ ok, on, parity, ratio, selectionOn, selParity });
      } else if (msg.type === "enhanceSelection") {
        const ok = enhanceSelection();
        return Promise.resolve({ ok, enhanceOn: !!enh });
      } else if (msg.type === "endEnhance") {
        endEnhance();
        return Promise.resolve({ enhanceOn: !!enh });
      } else if (msg.type === "setEnhance") {
        setEnhance(msg.enhance);
        return Promise.resolve({ enhanceOn: !!enh });
      } else if (msg.type === "setRatio") {
        setRatio(msg.ratio);
        return Promise.resolve({ on, parity, ratio, selectionOn, selParity });
      } else if (msg.type === "setStripe") {
        applyStripePrefs(msg, false);
        return Promise.resolve({
          on, parity, ratio, selectionOn, selParity,
          stripeWhite, stripeBlack, stripeSpeed, randomAngle, stripeAngle, flowSign
        });
      } else if (msg.type === "state") {
        return Promise.resolve({
          on, parity, ratio, selectionOn, selParity, enhanceOn: !!enh,
          stripeWhite, stripeBlack, stripeSpeed, randomAngle, flowSign
        });
      }
    });
  }

  // テストと一時的な確認用。ページ側から操作できる。
  globalThis.__lineHalfMask = {
    toggle,
    swap,
    start,
    stop,
    update,
    getState() {
      return {
        on, parity, ratio, flowPaused, selectionOn, selParity, enhanceOn: !!enh,
        stripeWhite, stripeBlack, stripeSpeed, randomAngle, stripeAngle, flowSign
      };
    },
    collect,
    collectLines,
    collectSelectionLines,
    pause,
    setRatio,
    clampRatio,
    clampWidth,
    clampSpeed,
    applyStripePrefs,
    rollStripeStyle,
    setStripeStyle,
    maskSelection,
    endSelection,
    enhanceSelection,
    endEnhance,
    setEnhance,
    enhanceAt,
    enhanceInfo() {
      return enh && { rects: enh.rects, ax: enh.ax, ay: enh.ay, box: enh.box, pose: enh.pose, cfg: enhCfg };
    },
    captureSelection,
    useFakeTimers,
    advanceFakeTimers,
    get STRIPE_WHITE() { return stripeWhite; },
    get STRIPE_BLACK() { return stripeBlack; },
    get STRIPE_PERIOD() { return stripePeriod(); },
    get STRIPE_SPEED() { return stripeSpeed; },
    SEL_SWAP_MS,
    WIDTH_DEFAULT,
    SPEED_DEFAULT,
  };

  document.addEventListener("contextmenu", captureSelection, true);
  document.addEventListener("selectionchange", captureSelection, true);

  function bindStorage() {
    if (!api || !api.storage || !api.storage.local) return;
    const keys = ["ratio", "stripeWhite", "stripeBlack", "stripeSpeed", "randomAngle", "enhance"];
    try {
      api.storage.local.get(keys).then((res) => {
        if (!res) return;
        if (res.ratio != null) setRatio(res.ratio);
        if (res.enhance != null) setEnhance(res.enhance);
        const prefs = {};
        if (res.stripeWhite != null) prefs.stripeWhite = res.stripeWhite;
        if (res.stripeBlack != null) prefs.stripeBlack = res.stripeBlack;
        if (res.stripeSpeed != null) prefs.stripeSpeed = res.stripeSpeed;
        if (res.randomAngle != null) prefs.randomAngle = res.randomAngle;
        applyStripePrefs(prefs, false);
        if (!randomAngle) {
          stripeAngle = DEFAULT_STRIPE_ANGLE;
          flowSign = DEFAULT_FLOW_SIGN;
        }
      }).catch(() => {});
    } catch (_) {}
    if (api.storage.onChanged) {
      api.storage.onChanged.addListener((changes, area) => {
        if (area && area !== "local") return;
        if (!changes) return;
        if (Object.prototype.hasOwnProperty.call(changes, "ratio")) {
          setRatio(changes.ratio && changes.ratio.newValue);
        }
        if (Object.prototype.hasOwnProperty.call(changes, "enhance")) {
          setEnhance(changes.enhance && changes.enhance.newValue);
        }
        const prefs = {};
        let any = false;
        for (const k of ["stripeWhite", "stripeBlack", "stripeSpeed", "randomAngle"]) {
          if (Object.prototype.hasOwnProperty.call(changes, k)) {
            prefs[k] = changes[k] && changes[k].newValue;
            any = true;
          }
        }
        if (any) applyStripePrefs(prefs, false);
      });
    }
  }
  bindStorage();
})();
