// 行の半分マスク: 一つの重ね描き（canvas）で、塗りの種類（黒塗り／視覚増強）と範囲を別々に選ぶ。
// 黒塗りは真っ黒の単色（アニメーションなし）。視覚増強（斜めの縞を流す）の計算は enhance.js。
// 範囲 coverage: full 行全体 / top 上半分 / bottom 下半分 / off なし。
// ページ全体のマスクは、行を上から通しで番号づけし、奇数行の下半分と偶数行の上半分（入れ替えで逆）。
// 選択範囲は、選んだ範囲の各行すべてに同じ範囲（行全体・上半分・下半分）を重ねる。
// もう一つ、何も選んでいないときにドラッグで長方形を指定して、そこに視覚増強を出す機能がある。
(() => {
  if (globalThis.__lineHalfMask) return;
  const api = typeof browser !== "undefined" ? browser : typeof chrome !== "undefined" ? chrome : null;
  const ROOT_ID = "line-half-mask-root";
  const PICKER_ID = "line-half-mask-picker";
  const CAPTURE_ID = "line-half-mask-capture";
  const ENH = globalThis.LineHalfMaskEnhance;
  const Z = "2147483647";
  const CAPTURE_MS = 60000;
  const RATIO_MIN = 50;
  const RATIO_MAX = 90;
  const RATIO_DEFAULT = 50;
  const MIN_DRAG = 6;
  const TAP_MOVE = 40;
  const TAP_MS = 600;
  const TWO_TAP_MS = 500;
  const COVERAGES = ["full", "off", "top", "bottom"];
  const COVERAGE_LABELS = { full: "オン", off: "オフ", top: "上半分", bottom: "下半分" };
  // 十字の配置。矢印キーはその方向の範囲を直接選ぶ（カーソル移動ではない）。
  const KEY_COVERAGE = { ArrowLeft: "full", ArrowRight: "off", ArrowUp: "top", ArrowDown: "bottom" };
  const PAD_ITEMS = [["top", "up"], ["full", "left"], ["off", "right"], ["bottom", "down"]];
  const INLINE_DISPLAY = /^(inline|contents|ruby)/;
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
  let sel = null; // 選択範囲（または指定した長方形）の重ね: { ranges, rect, coverage, boxes }
  let paintCount = 0; // 描いた回数（確認用）
  let pageFull = false; // ページ全体のマスクを、奇偶ではなく全行にする
  let drag = null; // 長方形のドラッグ中: { layer, band, start }
  let picker = null;
  let listenersBound = false;
  let touchBound = false;
  let clickBound = false;
  let watch = [];
  let capturedRanges = [];
  let capturedAt = 0;
  let fill = "black"; // black 黒塗り / enhance 視覚増強
  let coverage = "full"; // 選択範囲の既定の範囲
  let fx = null; // 視覚増強の場と動き
  let fxSeed = 1;
  let enhCfg = ENH ? ENH.defaults() : null;

  function clampRatio(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return RATIO_DEFAULT;
    if (n < RATIO_MIN) return RATIO_MIN;
    if (n > RATIO_MAX) return RATIO_MAX;
    return n;
  }

  function active() { return on || !!sel; }

  // 長方形の指定は、塗りの設定にかかわらず視覚増強。
  function fillStyle() { return ENH && (fill === "enhance" || (sel && sel.rect)) ? "enhance" : "black"; }

  function normalizeCoverage(v) { return COVERAGES.indexOf(v) >= 0 ? v : "full"; }

  function rollFx() {
    fxSeed = 1 + Math.floor(Math.random() * 0x7fffffff);
    fx = null;
  }

  function stateSnapshot() {
    return {
      on, parity, ratio, selectionOn: !!sel, rect: !!(sel && sel.rect), pageFull, fill,
      coverage: sel ? sel.coverage : coverage,
      // いま見えている範囲。選択範囲があればそれ、なければページ全体。
      shown: sel ? sel.coverage : on ? (pageFull ? "full" : parity ? "top" : "bottom") : "off"
    };
  }

  function reportState() {
    if (!api || !api.runtime || !api.runtime.sendMessage) return;
    try {
      api.runtime.sendMessage(Object.assign({ type: "state" }, stateSnapshot()));
    } catch (_) {}
  }

  function setRatio(v) {
    const next = clampRatio(v);
    if (next === ratio) return next;
    ratio = next;
    if (active()) update();
    reportState();
    return ratio;
  }

  function setFill(v) {
    const next = v === "enhance" ? "enhance" : "black";
    if (next === fill) return fill;
    fill = next;
    fx = null;
    if (active()) update();
    reportState();
    return fill;
  }

  // 既定の範囲を変える。選択範囲の重ねが出ていれば、それにも反映する。
  function setCoverage(v) {
    coverage = normalizeCoverage(v);
    if (sel) setSelCoverage(coverage);
    else reportState();
    return coverage;
  }

  function setSelCoverage(v) {
    if (!sel) return;
    sel.coverage = normalizeCoverage(v);
    update();
    if (sel && sel.coverage !== "off") startFlow();
    pickerRender();
    reportState();
  }

  // 設定が変わったら、同じ場所のまま新しい設定で動かし直す。
  function setEnhance(cfg) {
    if (!ENH) return;
    enhCfg = ENH.normalize(cfg);
    fx = null;
    if (active()) update();
  }

  function toggle() {
    if (on) stop();
    else start();
  }

  // 選択範囲の重ねでは上半分と下半分を入れ替える。ページ全体は奇偶を入れ替える。
  function swap() {
    if (sel) {
      if (sel.coverage === "top") sel.coverage = "bottom";
      else if (sel.coverage === "bottom") sel.coverage = "top";
      update();
      pickerRender();
      reportState();
      return;
    }
    pageFull = false;
    parity = parity ? 0 : 1;
    if (on) update();
    reportState();
  }

  // ポップアップの十字。選択範囲（60 秒以内に選んだものも含む）があればそれに、なければページ全体に。
  // ページ全体では、左=全行、上=奇偶（1 行目の上半分から）、下=奇偶（1 行目の下半分から）、右=すべてオフ。
  function applyCoverage(v) {
    v = normalizeCoverage(v);
    if (v === "off") {
      endSelection();
      stop();
      return;
    }
    if (sel) {
      setSelCoverage(v);
      return;
    }
    if (rangesForMask().length) {
      overlaySelection({ coverage: v });
      return;
    }
    pageFull = v === "full";
    if (v === "top") parity = 1;
    else if (v === "bottom") parity = 0;
    if (on) update();
    else start();
    reportState();
  }

  const touchOpts = { capture: true, passive: true };

  function bindSharedListeners() {
    if (listenersBound) return;
    listenersBound = true;
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule, { capture: true, passive: true });
    mo = new MutationObserver(onMutations);
    mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  }

  function unbindSharedListeners() {
    if (!listenersBound) return;
    listenersBound = false;
    window.removeEventListener("scroll", schedule, { capture: true });
    document.removeEventListener("scroll", schedule, { capture: true });
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
    fx = null;
  }

  function start() {
    if (on) return;
    on = true;
    bindSharedListeners();
    bindTouch();
    if (!sel) {
      rollFx();
      ensureRoot();
      update();
      startFlow();
    }
    reportState();
  }

  function stop() {
    on = false;
    pageFull = false;
    tap = null;
    lastTwoTapAt = 0;
    unbindTouch();
    if (sel) {
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

  function isOwn(node) {
    const el = node && node.nodeType === 1 ? node : node && node.parentElement;
    if (!el) return false;
    return (root && (el === root || root.contains(el))) ||
      (picker && (el === picker.host || picker.host.contains(el))) ||
      (drag && (el === drag.layer || drag.layer.contains(el)));
  }

  function onMutations(mutations) {
    if (updating) return;
    for (const m of mutations) {
      if (isOwn(m.target)) continue;
      schedule();
      return;
    }
  }

  function schedule() {
    if (!active() || scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (active()) update();
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

  // 重ねた canvas の左上。position:fixed でも、html の transform などで
  // 基準がビューポートでないときは、(0,0) が画面の左上からずれる。
  function overlayOffset(el) {
    if (!el) return { x: 0, y: 0, s: 1 };
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, s: clientScale(el) };
  }

  // 画面内の行の要素をいくつか覚えておき、位置が動いたら描き直す。
  // Shadow DOM の内側スクロールや、transform による移動は scroll 事件が
  // window まで来ないことがある。
  function rememberWatch(lines) {
    watch = [];
    if (!lines) return;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (!l || !l.el || l.bottom < 0 || l.top > innerHeight) continue;
      const r = l.el.getBoundingClientRect();
      watch.push({ el: l.el, top: r.top, left: r.left });
      if (watch.length >= 3) break;
    }
  }

  function watchedMoved() {
    if (!watch.length) return false;
    for (let i = 0; i < watch.length; i++) {
      const w = watch[i];
      if (!w.el || !w.el.isConnected) return true;
      const r = w.el.getBoundingClientRect();
      if (Math.abs(r.top - w.top) > 0.5 || Math.abs(r.left - w.left) > 0.5) return true;
    }
    return false;
  }

  function flowElapsed(now) {
    if (flowPaused) return Math.max(0, flowPausedAt - flowT0 - flowPausedMs);
    return Math.max(0, now - flowT0 - flowPausedMs);
  }

  // 範囲の四角を、デバイス画素に丸めて canvas の座標にする（黒塗りも視覚増強も同じ）。
  function deviceRect(r, o, k) {
    const x0 = Math.max(0, Math.round((r.left - o.x) * k));
    const y0 = Math.max(0, Math.round((r.top - o.y) * k));
    const x1 = Math.min(root.width, Math.round((r.left + r.width - o.x) * k));
    const y1 = Math.min(root.height, Math.round((r.top + r.height - o.y) * k));
    return { x0, y0, w: x1 - x0, h: y1 - y0 };
  }

  // 黒塗り: 真っ黒の単色。位置が変わったときだけ描き直す。
  function paintBlack(c) {
    const k = enhK();
    const o = overlayOffset(root);
    c.fillStyle = "#000";
    for (const r of lastMasks) {
      const d = deviceRect(r, o, k);
      if (d.w > 0 && d.h > 0) c.fillRect(d.x0, d.y0, d.w, d.h);
    }
  }

  // 視覚増強: 1 画素ずつ二色のどちらかを決めて ImageData で描く（縁をぼかさない）。
  // 場は、ページ全体なら画面全体、選択範囲なら選んだ全行を包む一つの四角（指定した長方形ならその四角）。
  // 各行（の範囲）はその場を見る窓として塗る。
  function enhK() {
    return (window.devicePixelRatio || 1) / clientScale(root);
  }

  // 画面外の行も含め、選んだすべての行を包む四角。原点はその左上。
  function enhBounds(lines) {
    const k = enhK();
    const o = overlayOffset(root);
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (const x of lines) {
      if (!x) continue;
      l = Math.min(l, x.left);
      t = Math.min(t, x.top);
      r = Math.max(r, x.right);
      b = Math.max(b, x.bottom);
    }
    if (!Number.isFinite(l)) return { ax: 0, ay: 0, w: 1, h: 1 };
    const ax = Math.round((l - o.x) * k), ay = Math.round((t - o.y) * k);
    return { ax, ay, w: Math.max(1, Math.round((r - o.x) * k) - ax), h: Math.max(1, Math.round((b - o.y) * k) - ay) };
  }

  function fxFit(lines) {
    if (fillStyle() !== "enhance") { fx = null; return; }
    const b = sel ? enhBounds(lines) : { ax: 0, ay: 0, w: root.width, h: root.height };
    if (!fx) fx = { motion: ENH.createMotion(enhCfg, fxSeed, b.w, b.h), images: new Map(), box: { w: b.w, h: b.h }, pose: null, drawn: null };
    fx.ax = b.ax;
    fx.ay = b.ay;
    fx.box.w = b.w;
    fx.box.h = b.h;
    fx.reach = Math.hypot(b.w, b.h);
    fx.motion.resize(b.w, b.h);
  }

  function paintEnhance(c, now) {
    const k = enhK();
    const o = overlayOffset(root);
    const pose = fx.motion.pose(flowElapsed(now) / 1000);
    const c0 = pose.hue == null ? ENH.BLACK : ENH.colorAtHue(pose.hue);
    const c1 = pose.hue == null ? ENH.WHITE : ENH.colorAtHue(pose.hue + 180);
    for (const r of lastMasks) {
      const d = deviceRect(r, o, k);
      const x0 = d.x0, y0 = d.y0, w = d.w, h = d.h;
      if (w <= 0 || h <= 0) continue;
      // 拡張の content script からは、ページ側の ImageData を直接 new せず、canvas から作る。
      const key = w + "x" + h;
      let img = fx.images.get(key);
      if (!img) {
        if (fx.images.size > 64) fx.images.clear();
        img = c.createImageData(w, h);
        fx.images.set(key, img);
      }
      ENH.fillBands(new Uint32Array(img.data.buffer, 0, w * h), w, h, x0 - fx.ax, y0 - fx.ay, pose, c0, c1);
      c.putImageData(img, x0, y0);
    }
    fx.pose = pose;
    fx.drawn = pose;
  }

  // 姿勢が 1/3 画素以上、または色が 1 度以上動いたときだけ描き直す。
  function enhMoved(a, b) {
    if (!a) return true;
    const period = 2 * b.width;
    const d = Math.abs(a.offset - b.offset);
    return Math.min(d, period - d) > 0.34
      || Math.abs(a.angle - b.angle) * fx.reach > 0.34
      || Math.hypot(a.px - b.px, a.py - b.py) > 0.34
      || (a.hue != null && Math.abs(a.hue - b.hue) >= 1);
  }

  function paint(now) {
    if (!root) return;
    paintCount += 1;
    sizeCanvas(root);
    const c = root.getContext("2d", { alpha: true });
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, root.width, root.height);
    if (!lastMasks.length) return;
    if (fx) paintEnhance(c, now);
    else paintBlack(c);
  }

  // 動いている視覚増強だけ描き直す。黒塗りは位置の確認だけで、描き直しは update のときだけ。
  function frame(now) {
    if (fx && enhMoved(fx.drawn, fx.motion.pose(flowElapsed(now) / 1000))) paint(now);
  }

  function tick(now) {
    flowRaf = 0;
    if (!active()) return;
    if (watchedMoved()) update();
    else if (!flowPaused) frame(now);
    flowRaf = requestAnimationFrame(tick);
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
    if (!flowRaf) flowRaf = requestAnimationFrame(tick);
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
      paint(flowPausedAt);
      // 縞は止めても、内側スクロールなどで行が動いたら位置は追う。
      if (!flowRaf) flowRaf = requestAnimationFrame(tick);
      return;
    }
    if (!active()) return;
    startFlow();
  }

  // テスト用: 時間を止めて、開始から t 秒の姿で描く。
  function showAt(t) {
    if (!active() || !fx) return false;
    flowPaused = true;
    flowT0 = 1;
    flowPausedMs = 0;
    flowPausedAt = 1 + t * 1000;
    fx = null;
    update();
    return true;
  }

  function update() {
    if (!active()) return;
    updating = true;
    try {
      const lines = sel ? (sel.rect ? [rectLine()] : collectSelectionLines(sel.ranges)) : collectLines();
      if (sel) sel.boxes = lines.map(clippedBox).filter(Boolean);
      // オフ: 重ねを外し、範囲を選ぶ窓だけ残す。ページ全体のマスクも、選択が終わるまで出さない。
      if (sel && sel.coverage === "off") {
        lastMasks = [];
        fx = null;
        if (root) { root.remove(); root = null; }
        stopFlow();
        if (picker) pickerPlace();
        return;
      }
      ensureRoot();
      sizeCanvas(root);
      lastMasks = masksFromLines(lines, maskPick());
      fxFit(lines);
      rememberWatch(lines);
      paint(performance.now());
      if (picker) pickerPlace();
    } finally {
      updating = false;
    }
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

  // 行を数える「箱」は、inline 系（inline・inline-block・inline-flex など）をまたいだ先の、最初の block 系の祖先。
  // flex や grid の子は block 系になるので、それぞれが別の箱になる。
  // clip は、overflow が visible でない祖先の四角の重なり（ビューポートは含めない）。
  // 要素ごとに一度だけ調べて、同じ走査の中で使い回す。
  function boxInfo(el, cache) {
    let r = cache.get(el);
    if (r) return r;
    const doc = document.documentElement;
    if (!el || el === doc) {
      r = { box: el, clip: null };
    } else {
      const st = getComputedStyle(el);
      const host = el.getRootNode && el.getRootNode().host;
      const up = boxInfo(el.parentElement || host || doc, cache);
      let clip = up.clip;
      if (st.overflowX !== "visible" || st.overflowY !== "visible") {
        const cr = el.getBoundingClientRect();
        clip = clip
          ? { left: Math.max(clip.left, cr.left), top: Math.max(clip.top, cr.top), right: Math.min(clip.right, cr.right), bottom: Math.min(clip.bottom, cr.bottom) }
          : { left: cr.left, top: cr.top, right: cr.right, bottom: cr.bottom };
      }
      r = { box: INLINE_DISPLAY.test(st.display) ? up.box : el, clip };
    }
    cache.set(el, r);
    return r;
  }

  // 行の四角を、祖先の clip とビューポートで切ったもの。
  function visibleBox(line) {
    const c = line.clip;
    const left = Math.max(line.left, c ? c.left : 0, 0);
    const top = Math.max(line.top, c ? c.top : 0, 0);
    const right = Math.min(line.right, c ? c.right : Infinity, innerWidth);
    const bottom = Math.min(line.bottom, c ? c.bottom : Infinity, innerHeight);
    return { left, top, right, bottom };
  }

  function sameLine(a, b) {
    const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    const minH = Math.min(a.bottom - a.top, b.bottom - b.top);
    return minH > 0 && overlap > minH * 0.5;
  }

  // 横に離れすぎていない（行の高さ以内）こと。別の段や別の列の文字を一行にしない。
  function nearLine(a, b) {
    const gap = Math.max(b.left - a.right, a.left - b.right);
    return gap <= Math.min(a.bottom - a.top, b.bottom - b.top);
  }

  // 同じ箱の四角を、縦に半分以上重なり、横に近いものだけ一行にまとめる。
  // DOM 順に並んでいるので、直前の数行だけ見れば足りる。
  function clusterLines(rects) {
    const lines = [];
    for (const r of rects) {
      if (!(r.width > 0 && r.height > 0)) continue;
      let hit = null;
      for (let i = lines.length - 1; i >= 0 && i >= lines.length - 4; i--) {
        if (sameLine(lines[i], r) && nearLine(lines[i], r)) { hit = lines[i]; break; }
      }
      if (hit) {
        hit.top = Math.min(hit.top, r.top);
        hit.bottom = Math.max(hit.bottom, r.bottom);
        hit.left = Math.min(hit.left, r.left);
        hit.right = Math.max(hit.right, r.right);
      } else {
        lines.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right, el: r.el || null, clip: r.clip || null });
      }
    }
    return lines;
  }

  // 行番号。DOM 順に一つずつ増やす。直前の行と同じ視覚行にあって右にある箱（flex や表の横並び）は同じ番号にする。
  function numberRows(lines) {
    let row = -1, prev = null;
    for (const l of lines) {
      if (!(prev && sameLine(prev, l) && l.left >= prev.left)) row += 1;
      l.row = row;
      prev = l;
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
    const cache = new Map();
    const groups = new Map();
    const range = document.createRange();
    for (const node of nodes) {
      const el = node.parentElement || (node.getRootNode && node.getRootNode().host);
      if (!el || (root && root.contains(el))) continue;
      const info = boxInfo(el, cache);
      const c = info.clip;
      // 幅や高さが 2px 未満の枠に閉じ込められた文字（読み上げ用の隠し文字など）は行に数えない。
      if (c && (c.right - c.left < 2 || c.bottom - c.top < 2)) continue;
      range.selectNodeContents(node);
      let list;
      try { list = range.getClientRects(); } catch (_) { continue; }
      let rects = groups.get(info.box);
      if (!rects) groups.set(info.box, rects = []);
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (r.width <= 0 || r.height <= 0) continue;
        rects.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height, el, clip: c });
      }
    }
    const lines = [];
    for (const rects of groups.values()) {
      for (const l of clusterLines(rects)) lines.push(l);
    }
    return numberRows(lines);
  }

  // 各行のどこを塗るか。選択範囲は選んだ範囲を全行に固定で、
  // ページ全体は上から通しの奇偶（奇数行は下、偶数行は上。入れ替えで逆）。
  function maskPick() {
    if (sel) return () => sel.coverage;
    if (pageFull) return () => "full";
    return (i) => ((i % 2 === 0) === (parity === 0) ? "bottom" : "top");
  }

  function masksFromLines(lines, pick) {
    const masks = [];
    const frac = ratio / 100;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const part = pick(line.row != null ? line.row : i);
      if (part === "off") continue;
      const h = line.bottom - line.top;
      const top = part === "bottom" ? line.top + h * (1 - frac) : line.top;
      const bottom = part === "top" ? line.top + h * frac : line.bottom;
      const clip = visibleBox(line);
      const t = Math.max(top, clip.top);
      const bm = Math.min(bottom, clip.bottom);
      const l = Math.max(line.left, clip.left);
      const rgt = Math.min(line.right, clip.right);
      if (bm - t < 0.5 || rgt - l < 0.5) continue;
      masks.push({ top: t, left: l, height: bm - t, width: rgt - l, index: i, coverTop: part === "top" });
    }
    return masks;
  }

  // 範囲を「オフ」にしても、行の位置は終了判定に使う。
  function clippedBox(line) {
    const v = visibleBox(line);
    if (v.right - v.left < 0.5 || v.bottom - v.top < 0.5) return null;
    return { left: v.left, top: v.top, width: v.right - v.left, height: v.bottom - v.top };
  }

  // 選択範囲の Range.getClientRects を行にまとめ、各行では選択された横幅だけを対象にする。
  function collectSelectionLines(ranges) {
    if (!ranges) ranges = sel ? sel.ranges : [];
    const rects = [];
    const cache = new Map();
    for (let i = 0; i < ranges.length; i++) {
      const range = ranges[i];
      if (!range || range.collapsed) continue;
      let list;
      try { list = range.getClientRects(); } catch (_) { continue; }
      const node = range.commonAncestorContainer;
      const host = (node && (node.nodeType === 1 ? node : node.parentElement)) || document.documentElement;
      const clip = boxInfo(host, cache).clip;
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
          el: host,
          clip
        });
      }
    }
    return numberRows(clusterLines(rects));
  }

  function collect() {
    return masksFromLines(sel ? (sel.rect ? [rectLine()] : collectSelectionLines()) : collectLines(), maskPick());
  }

  function hitMask(x, y) {
    const list = sel ? sel.boxes : [];
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (x >= m.left && x <= m.left + m.width && y >= m.top && y <= m.top + m.height) return true;
    }
    return false;
  }

  function inPicker(e) {
    return !!picker && e.composedPath && e.composedPath().indexOf(picker.host) >= 0;
  }

  function onDocPointerDown(e) {
    if (!sel || inPicker(e)) return;
    if (e.button != null && e.button !== 0) return;
    if (hitMask(e.clientX, e.clientY)) {
      dismissPicker();
      return;
    }
    endSelection();
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
    if (!s || !t0 || !sel || inPicker(e)) return;
    if (Date.now() - s.at > TAP_MS) return;
    if (Math.hypot(t0.clientX - s.x, t0.clientY - s.y) > 16) return;
    if (!hitMask(t0.clientX, t0.clientY)) endSelection();
  }

  // 選択範囲の重ねを出している間だけ聞く。窓が開いている間は、矢印キーがその方向の範囲を直接選ぶ。
  // Enter と Esc は窓を閉じる。オフのまま閉じたら重ねも終わる。窓が閉じていれば Esc で終わる。
  function onKey(e) {
    if (!sel || e.isComposing) return;
    if (picker) {
      const cov = KEY_COVERAGE[e.key];
      if (cov) setSelCoverage(cov);
      else if (e.key === "Enter" || e.key === "Escape") dismissPicker();
      else return;
    } else if (e.key === "Escape") {
      endSelection();
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  const EXIT_OPTS = { capture: true, passive: true };
  function bindClickExit() {
    if (clickBound) return;
    clickBound = true;
    document.addEventListener("mousedown", onDocPointerDown, EXIT_OPTS);
    document.addEventListener("touchstart", onExitTouchStart, EXIT_OPTS);
    document.addEventListener("touchend", onExitTouchEnd, EXIT_OPTS);
    window.addEventListener("keydown", onKey, true);
  }

  function unbindClickExit() {
    if (!clickBound || sel) return;
    clickBound = false;
    document.removeEventListener("mousedown", onDocPointerDown, EXIT_OPTS);
    document.removeEventListener("touchstart", onExitTouchStart, EXIT_OPTS);
    document.removeEventListener("touchend", onExitTouchEnd, EXIT_OPTS);
    window.removeEventListener("keydown", onKey, true);
  }

  function cloneSelectionRanges(s) {
    const ranges = [];
    if (!s) return ranges;
    for (let i = 0; i < s.rangeCount; i++) {
      const r = s.getRangeAt(i);
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
      const s = window.getSelection && window.getSelection();
      if (s && s.removeAllRanges) s.removeAllRanges();
    } catch (_) {}
  }

  // opts.fill: 塗りの種類（指定すれば保存もする）、opts.picker: 範囲を選ぶ窓を出す。
  function overlaySelection(opts) {
    const ranges = rangesForMask();
    if (!ranges.length) return false;
    opts = opts || {};
    if (opts.fill) {
      setFill(opts.fill);
      try { api.storage.local.set({ fill }); } catch (_) {}
    }
    if (opts.coverage) coverage = normalizeCoverage(opts.coverage);
    // 窓なしでオフから始めると操作する手段がないので、行全体にする。
    if (!opts.picker && coverage === "off") coverage = "full";
    endDrag();
    closePicker();
    sel = { ranges, coverage, boxes: [] };
    // 青の選択ハイライトが残らないよう、範囲を確保したあとで外す。
    clearPageSelection();
    rollFx();
    bindSharedListeners();
    bindClickExit();
    ensureRoot();
    update();
    startFlow();
    if (opts.picker) openPicker();
    reportState();
    return true;
  }

  function endSelection() {
    if (!sel) return;
    closePicker();
    sel = null;
    fx = null;
    unbindClickExit();
    if (on) {
      rollFx();
      update();
      startFlow();
    } else {
      teardownOverlay();
    }
    reportState();
  }

  // ---- 範囲を指定して視覚トレーニング（コンテキストメニュー、何も選んでいないとき） ----
  // 透明な捕捉層でドラッグを受け、離したら層を外して、その長方形に視覚増強を重ねる。
  // 四角はページ（文書）の座標で持つので、ページのスクロールに付いてくる。
  // 終わらせるのは、四角の外のクリックか Esc（選択範囲の重ねと同じ）。
  function rectLine() {
    const r = sel.rect;
    const left = r.x - window.scrollX, top = r.y - window.scrollY;
    return { left, top, right: left + r.w, bottom: top + r.h, width: r.w, height: r.h, el: document.documentElement };
  }

  function dragBox(e) {
    const x0 = Math.min(drag.start.x, e.clientX), y0 = Math.min(drag.start.y, e.clientY);
    return { left: x0, top: y0, width: Math.abs(e.clientX - drag.start.x), height: Math.abs(e.clientY - drag.start.y) };
  }

  function onDragMove(e) {
    if (!drag || !drag.start) return;
    const b = dragBox(e);
    const o = drag.layer.getBoundingClientRect();
    const st = drag.band.style;
    st.display = "block";
    st.left = b.left - o.left + "px";
    st.top = b.top - o.top + "px";
    st.width = b.width + "px";
    st.height = b.height + "px";
  }

  function onDragUp(e) {
    if (!drag || !drag.start) return;
    const b = dragBox(e);
    endDrag();
    if (b.width >= MIN_DRAG && b.height >= MIN_DRAG) startRect(b);
  }

  function onDragKey(e) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    endDrag();
  }

  function endDrag() {
    if (!drag) return;
    const d = drag;
    drag = null;
    d.layer.remove();
    window.removeEventListener("mousemove", onDragMove, true);
    window.removeEventListener("mouseup", onDragUp, true);
    window.removeEventListener("keydown", onDragKey, true);
  }

  function trainRect() {
    endSelection();
    endDrag();
    const layer = document.createElement("div");
    layer.id = CAPTURE_ID;
    layer.style.cssText =
      "position:fixed;left:0;top:0;right:0;bottom:0;margin:0;padding:0;border:none;background:transparent;" +
      "cursor:crosshair;touch-action:none;user-select:none;z-index:" + Z + ";";
    const band = document.createElement("div");
    band.style.cssText =
      "position:absolute;display:none;box-sizing:border-box;border:1px dashed #111;outline:1px dashed #fff;pointer-events:none;";
    layer.appendChild(band);
    drag = { layer, band, start: null };
    layer.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || !drag) return;
      e.preventDefault();
      drag.start = { x: e.clientX, y: e.clientY };
      window.addEventListener("mousemove", onDragMove, true);
      window.addEventListener("mouseup", onDragUp, true);
    });
    window.addEventListener("keydown", onDragKey, true);
    (document.documentElement || document.body).appendChild(layer);
  }

  // b はビューポートの座標。ページの座標にして持つ。
  function startRect(b) {
    endDrag();
    closePicker();
    sel = {
      rect: { x: b.left + window.scrollX, y: b.top + window.scrollY, w: b.width, h: b.height },
      ranges: [], coverage: "full", boxes: []
    };
    rollFx();
    bindSharedListeners();
    bindClickExit();
    ensureRoot();
    update();
    startFlow();
    reportState();
  }

  // ---- 範囲を選ぶ十字の窓（コンテキストメニューから始めたときだけ） ----
  // 選択範囲の近くに出し、フォーカスは奪わない。操作は window の keydown（キャプチャ）で受ける。
  function openPicker() {
    if (picker || !sel) return;
    const host = document.createElement("div");
    host.id = PICKER_ID;
    host.style.cssText =
      "position:fixed;left:0;top:0;right:auto;bottom:auto;z-index:" + Z + ";margin:0;padding:0;border:none;";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent =
      ".pad{display:grid;grid-template-columns:1fr 1fr 1fr;grid-template-areas:'. up .' 'left . right' '. down .';" +
      "gap:4px;padding:6px;background:#f6f4ef;border:1px solid #888;border-radius:8px;" +
      "box-shadow:0 2px 10px rgba(0,0,0,.35);width:max-content}" +
      "button{font:13px/1.2 system-ui,sans-serif;padding:6px 8px;min-width:4.5em;text-align:center;" +
      "border:1px solid #888;border-radius:6px;cursor:pointer;background:#fff;color:#111}" +
      "button[aria-checked='true']{background:#111;color:#fff}" +
      "[data-dir='up']{grid-area:up}[data-dir='left']{grid-area:left}" +
      "[data-dir='right']{grid-area:right}[data-dir='down']{grid-area:down}";
    const wrap = document.createElement("div");
    wrap.className = "pad";
    wrap.setAttribute("role", "radiogroup");
    wrap.setAttribute("aria-label", "重ねる範囲");
    // ボタンを押してもページの選択やフォーカスが動かないようにする。
    wrap.addEventListener("mousedown", (e) => e.preventDefault());
    const buttons = {};
    for (const [v, dir] of PAD_ITEMS) {
      const b = document.createElement("button");
      b.type = "button";
      b.tabIndex = -1;
      b.setAttribute("role", "radio");
      b.dataset.coverage = v;
      b.dataset.dir = dir;
      b.textContent = COVERAGE_LABELS[v];
      b.addEventListener("click", () => setSelCoverage(v));
      buttons[v] = b;
      wrap.appendChild(b);
    }
    shadow.appendChild(style);
    shadow.appendChild(wrap);
    picker = { host, wrap, buttons };
    (document.documentElement || document.body).appendChild(host);
    pickerRender();
    pickerPlace();
  }

  function closePicker() {
    if (!picker) return;
    picker.host.remove();
    picker = null;
  }

  // 窓を閉じる。オフのままだと重ねるものがないので、選択の重ねも終わる。
  function dismissPicker() {
    closePicker();
    if (sel && sel.coverage === "off") endSelection();
  }

  function pickerRender() {
    if (!picker || !sel) return;
    for (const v of COVERAGES) {
      const on1 = v === sel.coverage;
      const b = picker.buttons[v];
      b.setAttribute("aria-checked", on1 ? "true" : "false");
    }
  }

  // 見えている最後の行の下に置く。入らなければ最初の行の上、それも無理なら画面の下端。
  function pickerPlace() {
    if (!picker) return;
    const m = 8;
    const r = picker.wrap.getBoundingClientRect();
    const w = r.width, h = r.height;
    const vis = (sel && sel.boxes || []).filter((b) => b.top + b.height > 0 && b.top < innerHeight);
    let x = innerWidth - w - m, y = innerHeight - h - m;
    if (vis.length) {
      const first = vis[0], last = vis[vis.length - 1];
      x = Math.min(Math.max(m, last.left), innerWidth - w - m);
      y = last.top + last.height + m;
      if (y + h > innerHeight - m) y = first.top - h - m;
      y = Math.min(Math.max(m, y), innerHeight - h - m);
    }
    const o = root ? overlayOffset(root) : { x: 0, y: 0, s: 1 };
    picker.host.style.left = (x - o.x) / o.s + "px";
    picker.host.style.top = (y - o.y) / o.s + "px";
  }

  if (api && api.runtime && api.runtime.onMessage) {
    api.runtime.onMessage.addListener((msg) => {
      if (!msg || !msg.type) return;
      if (msg.type === "toggle") toggle();
      else if (msg.type === "swap") swap();
      else if (msg.type === "overlaySelection") {
        const ok = overlaySelection({ fill: msg.fill, coverage: msg.coverage, picker: !!msg.picker });
        return Promise.resolve(Object.assign({ ok }, stateSnapshot()));
      } else if (msg.type === "trainRect") {
        trainRect();
        return Promise.resolve(Object.assign({ ok: true }, stateSnapshot()));
      } else if (msg.type === "applyCoverage") {
        applyCoverage(msg.coverage);
        return Promise.resolve(stateSnapshot());
      } else if (msg.type === "setRatio") {
        setRatio(msg.ratio);
        return Promise.resolve(stateSnapshot());
      } else if (msg.type === "state") {
        return Promise.resolve(stateSnapshot());
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
      return Object.assign({ flowPaused, pickerOpen: !!picker, dragging: !!drag, paintCount }, stateSnapshot());
    },
    collect,
    collectLines,
    collectSelectionLines,
    pause,
    setRatio,
    setFill,
    setCoverage,
    setSelCoverage,
    clampRatio,
    overlaySelection,
    endSelection,
    applyCoverage,
    trainRect,
    startRect,
    setEnhance,
    showAt,
    fxInfo() {
      return fx && { rects: lastMasks, ax: fx.ax, ay: fx.ay, box: fx.box, pose: fx.pose, cfg: enhCfg };
    },
    pickerInfo() {
      if (!picker) return null;
      const r = picker.wrap.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height, host: picker.host };
    },
    captureSelection,
  };

  document.addEventListener("contextmenu", captureSelection, true);
  document.addEventListener("selectionchange", captureSelection, true);

  function applyPrefs(res) {
    if (res.ratio !== undefined) setRatio(res.ratio);
    if (res.fill !== undefined) setFill(res.fill);
    if (res.coverage !== undefined) setCoverage(res.coverage);
    if (res.enhance !== undefined) setEnhance(res.enhance);
  }

  function bindStorage() {
    if (!api || !api.storage || !api.storage.local) return;
    const keys = ["ratio", "fill", "coverage", "enhance"];
    try {
      api.storage.local.get(keys).then((res) => {
        if (!res) return;
        applyPrefs(res);
      }).catch(() => {});
    } catch (_) {}
    if (api.storage.onChanged) {
      api.storage.onChanged.addListener((changes, area) => {
        if (area && area !== "local" || !changes) return;
        const res = {};
        for (const k of keys) {
          if (Object.prototype.hasOwnProperty.call(changes, k)) res[k] = changes[k] && changes[k].newValue;
        }
        applyPrefs(res);
      });
    }
  }
  bindStorage();
})();
