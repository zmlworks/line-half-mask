// 視覚増強（Android アプリ 視覚増強器 v0.6.0 と同じ動き）の計算部分。
// 画面に依存しない関数だけを置く。content.js（描画）と popup.js（スライダー）が使う。
(() => {
  if (globalThis.LineHalfMaskEnhance) return;

  const D = {
    auto: false,
    speed: 3, width: 1, autoWidth: 8, dir: 1,
    rotate: false, rotSpeed: 0.5, rotDir: 1, wander: false,
    dist: 1, color: 0, hueRate: 2,
  };
  const SPEED_MAX = 300, WIDTH_MIN = 1, WIDTH_MAX = 64, ROT_MAX = 90;
  const DIST_MIN = 0.1, DIST_MAX = 5, HUE_MAX = 36;
  const STEPS = 1000;
  const BASE_ANGLE = Math.PI / 4;
  const FLOW_MAX = 20, ROT_AUTO_MAX = 5, SHAPE_K = 2.5;
  const FLOW_T = [37, 53, 79], ROT_T = [43, 67, 97];
  const AMP = [0.5, 0.32, 0.18];
  const HUE_T = [59, 83, 113], HUE_WOBBLE = 30;
  const PIVOT_X = [41, 63, 89], PIVOT_Y = [47, 71, 97], PIVOT_MARGIN = 0.08;
  const TAG = { flow: 0xF10, rot: 0xF20, h0: 0xC01, wobble: 0xC10, px: 0x51, py: 0xA3 };
  const AUTO_DT = 1 / 60;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const int = (v, lo, hi, d) => clamp(Math.round(num(v, d)), lo, hi);
  const sign = (v, d) => (num(v, d) < 0 ? -1 : 1);

  // 保存された値を、範囲内の正しい型にそろえる。
  function normalize(c) {
    c = c || {};
    return {
      auto: c.auto === true,
      speed: int(c.speed, 0, SPEED_MAX, D.speed),
      width: int(c.width, WIDTH_MIN, WIDTH_MAX, D.width),
      autoWidth: int(c.autoWidth, WIDTH_MIN, WIDTH_MAX, D.autoWidth),
      dir: sign(c.dir, D.dir),
      rotate: c.rotate === true,
      rotSpeed: clamp(num(c.rotSpeed, D.rotSpeed), 0, ROT_MAX),
      rotDir: sign(c.rotDir, D.rotDir),
      wander: c.wander === true,
      dist: clamp(num(c.dist, D.dist), DIST_MIN, DIST_MAX),
      color: c.color === 1 ? 1 : 0,
      hueRate: clamp(num(c.hueRate, D.hueRate), 0, HUE_MAX),
    };
  }

  // スライダー（0〜1000）と値の対応。遅い側を細かくとる。
  const t01 = (p) => clamp(p / STEPS, 0, 1);
  const scales = {
    STEPS,
    speedFromProgress: (p) => Math.round(SPEED_MAX * t01(p) ** 2),
    progressFromSpeed: (v) => Math.round(STEPS * Math.sqrt(clamp(v, 0, SPEED_MAX) / SPEED_MAX)),
    rotFromProgress: (p) => ROT_MAX * t01(p) ** 3,
    progressFromRot: (v) => Math.round(STEPS * Math.cbrt(clamp(v, 0, ROT_MAX) / ROT_MAX)),
    distFromProgress: (p) => DIST_MIN * Math.pow(DIST_MAX / DIST_MIN, t01(p)),
    progressFromDist: (v) => Math.round(STEPS * Math.log(clamp(v, DIST_MIN, DIST_MAX) / DIST_MIN) / Math.log(DIST_MAX / DIST_MIN)),
    hueRateFromProgress: (p) => HUE_MAX * t01(p) ** 3,
    progressFromHueRate: (v) => Math.round(STEPS * Math.cbrt(clamp(v, 0, HUE_MAX) / HUE_MAX)),
  };

  const fmt = (v) => (Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : v.toFixed(1));
  const labels = {
    rot(v) {
      if (v <= 0) return "0 °/秒";
      return v < 1 ? fmt(v * 60) + " °/分" : fmt(v) + " °/秒";
    },
    hueRate(v) {
      if (v <= 0) return "固定";
      const period = 360 / v;
      return period >= 120 ? fmt(period / 60) + " 分で一周" : fmt(period) + " 秒で一周";
    },
    dist: (v) => fmt(v) + "×",
    autoHint(v) {
      return "速さ -" + fmt(FLOW_MAX * v) + "〜" + fmt(FLOW_MAX * v) + " px/秒、回転 -" +
        fmt(ROT_AUTO_MAX * v) + "〜" + fmt(ROT_AUTO_MAX * v) + " °/秒";
    },
  };

  // 速さと回転が滑らかに変わるための、ゆっくりした正弦の和。シードで位相が決まる。
  const phaseCache = new Map();
  function phaseOf(seed, tag, i) {
    const key = seed + ":" + tag + ":" + i;
    let p = phaseCache.get(key);
    if (p === undefined) {
      const M = (1n << 64n) - 1n;
      let x = (BigInt(seed) ^ (BigInt(tag) << 32n) ^ (BigInt(i) * 0x9E3779B97F4A7C15n)) & M;
      x ^= x >> 30n;
      x = (x * 0xBF58476D1CE4E5B9n) & M;
      x ^= x >> 27n;
      x = (x * 0x94D049BB133111EBn) & M;
      x ^= x >> 31n;
      p = Number(x & 0xFFFFFFn) / 0x1000000 * 2 * Math.PI;
      if (phaseCache.size > 200) phaseCache.clear();
      phaseCache.set(key, p);
    }
    return p;
  }

  function wave(t, seed, periods, tag) {
    let s = 0;
    for (let i = 0; i < periods.length; i++) {
      s += AMP[i] * Math.sin(2 * Math.PI * t / periods[i] + phaseOf(seed, tag, i));
    }
    return clamp(s, -1, 1);
  }

  const SHAPE_DEN = Math.tanh(SHAPE_K);
  // ゼロ付近はすばやく通り、範囲の外側寄りを長めにとる。
  function shape(u) {
    if (u <= -1) return -1;
    if (u >= 1) return 1;
    return Math.tanh(SHAPE_K * u) / SHAPE_DEN;
  }

  const flowSpeed = (t, seed) => FLOW_MAX * shape(wave(t, seed, FLOW_T, TAG.flow));
  const rotSpeed = (t, seed) => ROT_AUTO_MAX * shape(wave(t, seed, ROT_T, TAG.rot));

  const wrap = (v, period) => ((v % period) + period) % period;
  const wrapHue = (h) => wrap(h, 360);

  function hueDeg(t, seed, rate) {
    const h0 = phaseOf(seed, TAG.h0, 0) * 180 / Math.PI;
    if (rate <= 0) return h0;
    return h0 + rate * Math.max(0, t) + HUE_WOBBLE * wave(Math.max(0, t), seed, HUE_T, TAG.wobble);
  }

  // 彩度・明度が最大の色。ImageData 用の ABGR（リトルエンディアン）で返す。
  function colorAtHue(h) {
    const h6 = wrapHue(h) / 60;
    const i = Math.floor(h6) % 6, f = h6 - Math.floor(h6);
    const q = 1 - f;
    const rgb = [[1, f, 0], [q, 1, 0], [0, 1, f], [0, q, 1], [f, 0, 1], [1, 0, q]][i];
    const [r, g, b] = rgb.map((v) => Math.round(v * 255));
    return ((0xFF << 24) | (b << 16) | (g << 8) | r) >>> 0;
  }
  const BLACK = 0xFF000000, WHITE = 0xFFFFFFFF;

  function pivotAt(t, w, h, seed) {
    const nx = wave(t, seed, PIVOT_X, TAG.px), ny = wave(t, seed, PIVOT_Y, TAG.py);
    const mx = Math.max(8, w * PIVOT_MARGIN), my = Math.max(8, h * PIVOT_MARGIN);
    const rw = Math.max(0, w - 2 * mx), rh = Math.max(0, h - 2 * my);
    return [mx + rw * (0.5 + 0.5 * nx), my + rh * (0.5 + 0.5 * ny)];
  }

  // 領域（幅 w、高さ h、デバイス画素）での時刻 t の姿勢。t は増える向きにだけ呼ぶ。
  // 角度は縞の法線 (cos, sin)。流れも同じ軸なので、回転しても縞に垂直のまま。
  function createMotion(cfg, seed, w, h) {
    const c = normalize(cfg);
    const width = c.auto ? c.autoWidth : c.width;
    const period = 2 * width;
    const rotating = c.auto || c.rotate;
    const wandering = c.auto || (c.rotate && c.wander);
    let autoT = 0, autoFlow = 0, autoAng = BASE_ANGLE;
    let prev = null, comp = 0;
    function pose(t) {
      t = Math.max(0, t);
      let ang = BASE_ANGLE, flow;
      if (c.auto) {
        if (t < autoT) { autoT = 0; autoFlow = 0; autoAng = BASE_ANGLE; }
        while (t - autoT > 1e-9) {
          const dt = Math.min(AUTO_DT, t - autoT), mid = autoT + dt / 2;
          autoFlow += flowSpeed(mid, seed) * c.dist * dt;
          autoAng += rotSpeed(mid, seed) * c.dist * Math.PI / 180 * dt;
          autoT += dt;
        }
        ang = autoAng;
        flow = autoFlow;
      } else {
        if (c.rotate) ang += c.rotDir * c.rotSpeed * Math.PI / 180 * t;
        flow = -c.dir * c.speed * t;
      }
      const pv = wandering ? pivotAt(t, w, h, seed) : [w / 2, h / 2];
      // 軸が動いても縞が跳ねないよう、位相を補正する。
      if (prev) comp += (pv[0] - prev[0]) * Math.cos(ang) + (pv[1] - prev[1]) * Math.sin(ang);
      prev = pv;
      return {
        angle: ang, offset: wrap(flow + comp, period), px: pv[0], py: pv[1],
        hue: c.color === 1 ? hueDeg(t, seed, c.hueRate) : null,
        width, rotating,
      };
    }
    return { pose, width };
  }

  // 点サンプリングで塗る。どの画素も c0 か c1 の一色（アンチエイリアスなし）。
  // (x0, y0) は buf の左上、pose の px, py と同じ座標系。
  function fillBands(buf, w, h, x0, y0, pose, c0, c1) {
    const wd = pose.width, period = 2 * wd, inv = 1 / wd;
    const cs = Math.cos(pose.angle), sn = Math.sin(pose.angle);
    // 行の中で位相が負にならないよう、周期の整数倍を足す。
    const lift = (Math.ceil(w * Math.abs(cs) / period) + 1) * period;
    let i = 0;
    for (let y = 0; y < h; y++) {
      const base = wrap((x0 - pose.px) * cs + (y0 + y - pose.py) * sn + pose.offset, period) + lift;
      for (let x = 0; x < w; x++) {
        buf[i++] = (((base + x * cs + 1e-3) * inv) | 0) & 1 ? c1 : c0;
      }
    }
  }

  globalThis.LineHalfMaskEnhance = {
    defaults: () => Object.assign({}, D),
    normalize, scales, labels, createMotion, fillBands, colorAtHue,
    BLACK, WHITE, BASE_ANGLE, WIDTH_MIN, WIDTH_MAX,
    // テスト用
    wave, shape, flowSpeed, rotSpeed, hueDeg, pivotAt, phaseOf, TAG, FLOW_T, ROT_T,
  };
})();
