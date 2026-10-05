/* elevation.js — 坂の多さ（ぐるっとさんぽ）
 *
 * Elevation.profile(coords, { signal }) → Promise<{
 *   climbMeters, descentMeters, maxGradePct, levelKey, levelJa,
 *   distanceMeters, climbPerKm, source }>
 *   coords = [[lat, lng], ...]（歩くルートの線）
 *   levelKey = 'flat'（平ら）| 'some'（少し坂あり）| 'hilly'（坂が多い）
 * 失敗したら Elevation.ElevationError（messageJa に日本語の説明）。signal で中止すると name 'AbortError'。
 *
 * データ：国土地理院 標高タイル（出典表示：「国土地理院 標高タイル」）
 *   1. dem5a_png（5m メッシュ・ズーム15）→ 2. dem_png（10m メッシュ・ズーム14。5m が無い所・欠けた所の代わり）
 *   PNG の色 x = R*65536 + G*256 + B。x < 2^23 → 標高 x*0.01 m、x = 2^23 → データなし、x > 2^23 → (x-2^24)*0.01 m。
 * 依存なし。window.Elevation だけを公開する。
 */
(function (global) {
  'use strict';

  var ATTRIBUTION = '国土地理院 標高タイル';
  var LAYERS = [
    { name: 'dem5a_png', z: 15, url: 'https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/{z}/{x}/{y}.png' },
    { name: 'dem_png', z: 14, url: 'https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png' }
  ];

  var SPACING_M = 20;          // 標高を読む間隔
  var MAX_SAMPLES = 2500;      // 長すぎるルートは間隔を広げる
  var MEDIAN_WIN = 5;          // とがったノイズ（橋・トンネル・建物）を消す
  var MEAN_WIN = 3;            // なめらかにする（約60m）
  var HYSTERESIS_M = 1.5;      // これ未満の上下は数えない
  var GRADE_WINDOW_M = 60;     // 最大勾配を測る幅（50m以上）
  var MAX_GRADE_PCT = 25;      // これより急な変化はノイズとみなして頭打ち
  var CONCURRENCY = 4;
  var CACHE_LIMIT = 48;        // タイル数（1枚 約256KB）
  var TILE_TIMEOUT_MS = 15000;

  // 坂の多さの判定（根拠は下の levelOf のコメント）
  var FLAT_CLIMB_PER_KM = 8, FLAT_MAX_GRADE = 8;
  var HILLY_CLIMB_PER_KM = 20, HILLY_MAX_GRADE = 12;

  var LEVELS = {
    flat: '平ら',
    some: '少し坂あり',
    hilly: '坂が多い'
  };

  // ---------- エラー ----------
  function ElevationError(messageJa, cause) {
    var e = new Error(messageJa);
    e.name = 'ElevationError';
    e.messageJa = messageJa;
    if (cause) e.cause = cause;
    Object.setPrototypeOf(e, ElevationError.prototype);
    return e;
  }
  ElevationError.prototype = Object.create(Error.prototype, {
    constructor: { value: ElevationError, writable: true, configurable: true }
  });

  function abortError() {
    var e;
    try { e = new DOMException('Aborted', 'AbortError'); }
    catch (_) { e = new Error('Aborted'); e.name = 'AbortError'; }
    return e;
  }
  function throwIfAborted(signal) { if (signal && signal.aborted) throw abortError(); }

  // ---------- タイルの座標 ----------
  function worldPx(lat, lng, z) {
    var n = Math.pow(2, z) * 256;
    var s = Math.sin(lat * Math.PI / 180);
    s = Math.max(-0.9999, Math.min(0.9999, s));
    return {
      x: (lng + 180) / 360 * n,
      y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n
    };
  }

  // ---------- タイルの読み込み（メモリにためる） ----------
  var cache = new Map();     // key → Float32Array(65536) | null（タイルなし）  ※入れた順＝古い順
  var inflight = new Map();  // key → Promise

  function cacheSet(key, val) {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, val);
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  }

  function decodeBlob(blob) {
    function fromCanvasSource(src, w, h) {
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      var ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(src, 0, 0);
      return ctx.getImageData(0, 0, w, h).data;
    }
    function fromImage() {
      return new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(blob);
        var img = new Image();
        img.onload = function () {
          try { resolve(fromCanvasSource(img, img.naturalWidth, img.naturalHeight)); }
          catch (e) { reject(e); }
          finally { URL.revokeObjectURL(url); }
        };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('画像を読めません')); };
        img.src = url;
      });
    }
    var p;
    if (typeof createImageBitmap === 'function') {
      p = createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
        .catch(function () { return createImageBitmap(blob); })
        .then(function (bmp) {
          try { return fromCanvasSource(bmp, bmp.width, bmp.height); }
          finally { if (bmp.close) bmp.close(); }
        })
        .catch(fromImage);
    } else {
      p = fromImage();
    }
    return p.then(function (rgba) {
      var out = new Float32Array(256 * 256);
      var TWO23 = 8388608, TWO24 = 16777216;
      for (var i = 0, j = 0; i < out.length; i++, j += 4) {
        var x = rgba[j] * 65536 + rgba[j + 1] * 256 + rgba[j + 2];
        if (x === TWO23) out[i] = NaN;
        else out[i] = (x < TWO23 ? x : x - TWO24) * 0.01;
      }
      return out;
    });
  }

  function fetchTile(layer, tx, ty, signal) {
    var key = layer.name + '/' + layer.z + '/' + tx + '/' + ty;
    if (cache.has(key)) {
      var v = cache.get(key);
      cacheSet(key, v); // 最近使った扱いにする
      return Promise.resolve(v);
    }
    var pending = inflight.get(key);
    if (pending) {
      return pending.then(function (v) { throwIfAborted(signal); return v; });
    }
    var url = layer.url.replace('{z}', layer.z).replace('{x}', tx).replace('{y}', ty);

    function attempt(tryNo) {
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = null, onAbort = null, timedOut = false;
      if (ctrl) {
        timer = setTimeout(function () { timedOut = true; ctrl.abort(); }, TILE_TIMEOUT_MS);
        if (signal) {
          onAbort = function () { ctrl.abort(); };
          signal.addEventListener('abort', onAbort);
        }
      }
      function cleanup() {
        if (timer) clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      }
      return fetch(url, ctrl ? { signal: ctrl.signal, mode: 'cors' } : { mode: 'cors' })
        .then(function (res) {
          if (res.status === 404 || res.status === 403) return null; // 範囲外・データなし
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.blob().then(decodeBlob);
        })
        .then(function (v) { cleanup(); return v; }, function (err) {
          cleanup();
          if (signal && signal.aborted) throw abortError();
          if (tryNo < 1) return attempt(tryNo + 1);      // 1回だけやり直す
          throw ElevationError(timedOut
            ? '標高データの取得に時間がかかりすぎました。'
            : '標高データを取得できませんでした。通信状況をご確認ください。', err);
        });
    }

    var prom = attempt(0).then(function (v) {
      cacheSet(key, v);
      inflight.delete(key);
      return v;
    }, function (err) {
      inflight.delete(key);
      throw err;
    });
    inflight.set(key, prom);
    return prom;
  }

  // 同時 CONCURRENCY 本までで、タイルをまとめて読む。返り値：key → 標高データ
  function loadTiles(layer, tileList, signal) {
    var result = new Map();
    var idx = 0, failed = null;
    function worker() {
      if (failed || idx >= tileList.length) return Promise.resolve();
      var t = tileList[idx++];
      return fetchTile(layer, t.x, t.y, signal).then(function (v) {
        result.set(t.x + '/' + t.y, v);
        return worker();
      });
    }
    var workers = [];
    for (var i = 0; i < Math.min(CONCURRENCY, tileList.length); i++) {
      workers.push(worker().catch(function (e) { failed = e; throw e; }));
    }
    return Promise.all(workers).then(function () { return result; });
  }

  // ---------- 標高の取り出し ----------
  // 画素の中心で双一次補間。まわりに欠けがあれば一番近い画素を使う。なければ NaN
  function sampleTile(data, px, py) {
    var fx = px - 0.5, fy = py - 0.5;
    var x0 = Math.floor(fx), y0 = Math.floor(fy);
    var ax = fx - x0, ay = fy - y0;
    function at(x, y) {
      x = x < 0 ? 0 : (x > 255 ? 255 : x);
      y = y < 0 ? 0 : (y > 255 ? 255 : y);
      return data[y * 256 + x];
    }
    var a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
    if (a === a && b === b && c === c && d === d) {
      return (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + d * ax) * ay;
    }
    return at(Math.round(fx), Math.round(fy));
  }

  function sampleLayer(layer, pts, which, signal) {
    // which: 読む対象の点の番号の一覧 → 標高を elev に入れる
    var need = new Map(), info = new Array(pts.length);
    which.forEach(function (i) {
      var p = worldPx(pts[i].lat, pts[i].lng, layer.z);
      var tx = Math.floor(p.x / 256), ty = Math.floor(p.y / 256);
      info[i] = { tx: tx, ty: ty, px: p.x - tx * 256, py: p.y - ty * 256 };
      need.set(tx + '/' + ty, { x: tx, y: ty });
    });
    return loadTiles(layer, Array.from(need.values()), signal).then(function (tiles) {
      var found = 0;
      which.forEach(function (i) {
        var inf = info[i], data = tiles.get(inf.tx + '/' + inf.ty);
        if (!data) return;
        var h = sampleTile(data, inf.px, inf.py);
        if (h === h && h > -500 && h < 5000) { pts[i].h = h; found++; }
      });
      return found;
    });
  }

  // ---------- ルートの下ごしらえ ----------
  function resample(coords) {
    var R = 6371008.8, rad = Math.PI / 180;
    var cum = [0];
    for (var i = 1; i < coords.length; i++) {
      var la1 = coords[i - 1][0] * rad, la2 = coords[i][0] * rad;
      var dx = (coords[i][1] - coords[i - 1][1]) * rad * Math.cos((la1 + la2) / 2);
      var dy = la2 - la1;
      cum.push(cum[i - 1] + Math.sqrt(dx * dx + dy * dy) * R);
    }
    var total = cum[cum.length - 1];
    var step = Math.max(SPACING_M, total / MAX_SAMPLES);
    var n = Math.max(1, Math.round(total / step));
    step = total / n;
    var pts = [], j = 0;
    for (var k = 0; k <= n; k++) {
      var d = k * step;
      while (j < coords.length - 2 && cum[j + 1] < d) j++;
      var seg = cum[j + 1] - cum[j];
      var t = seg > 0 ? Math.min(1, Math.max(0, (d - cum[j]) / seg)) : 0;
      pts.push({
        lat: coords[j][0] + (coords[j + 1][0] - coords[j][0]) * t,
        lng: coords[j][1] + (coords[j + 1][1] - coords[j][1]) * t,
        h: NaN
      });
    }
    return { pts: pts, total: total, step: step };
  }

  function fillGaps(h) {
    var n = h.length, first = -1, i;
    for (i = 0; i < n; i++) if (h[i] === h[i]) { first = i; break; }
    if (first < 0) return false;
    for (i = 0; i < first; i++) h[i] = h[first];
    var last = first;
    for (i = first + 1; i < n; i++) {
      if (h[i] === h[i]) {
        for (var k = last + 1; k < i; k++) h[k] = h[last] + (h[i] - h[last]) * (k - last) / (i - last);
        last = i;
      }
    }
    for (i = last + 1; i < n; i++) h[i] = h[last];
    return true;
  }

  function median(arr, win) {
    var half = (win - 1) >> 1, out = new Array(arr.length);
    for (var i = 0; i < arr.length; i++) {
      var s = [];
      for (var k = Math.max(0, i - half); k <= Math.min(arr.length - 1, i + half); k++) s.push(arr[k]);
      s.sort(function (a, b) { return a - b; });
      out[i] = s[s.length >> 1];
    }
    return out;
  }
  function movingAverage(arr, win) {
    var half = (win - 1) >> 1, out = new Array(arr.length);
    for (var i = 0; i < arr.length; i++) {
      var sum = 0, c = 0;
      for (var k = Math.max(0, i - half); k <= Math.min(arr.length - 1, i + half); k++) { sum += arr[k]; c++; }
      out[i] = sum / c;
    }
    return out;
  }

  // 急すぎる変化（橋・トンネル・建物のノイズ）を、1区間あたり MAX_GRADE_PCT までに頭打ちにする
  function clampSteps(h, step) {
    var maxStep = step * MAX_GRADE_PCT / 100, out = [h[0]];
    for (var i = 1; i < h.length; i++) {
      var d = h[i] - h[i - 1];
      out.push(out[i - 1] + (d > maxStep ? maxStep : (d < -maxStep ? -maxStep : d)));
    }
    return out;
  }

  // 小さな上下（HYSTERESIS_M 未満）を数えない上り・下りの合計
  function climbDescent(h) {
    var T = HYSTERESIS_M, dir = 0, ext = h[0], pivots = [h[0]];
    for (var i = 1; i < h.length; i++) {
      var v = h[i];
      if (dir === 0) {
        if (v - ext >= T) { dir = 1; ext = v; }
        else if (ext - v >= T) { dir = -1; ext = v; }
      } else if (dir === 1) {
        if (v > ext) ext = v;
        else if (ext - v >= T) { pivots.push(ext); dir = -1; ext = v; }
      } else {
        if (v < ext) ext = v;
        else if (v - ext >= T) { pivots.push(ext); dir = 1; ext = v; }
      }
    }
    if (dir !== 0) pivots.push(ext);
    var up = 0, down = 0;
    for (var k = 1; k < pivots.length; k++) {
      var d = pivots[k] - pivots[k - 1];
      if (d > 0) up += d; else down -= d;
    }
    return { up: up, down: down };
  }

  function maxGrade(h, step) {
    var w = Math.max(1, Math.ceil(GRADE_WINDOW_M / step)), best = 0;
    for (var i = 0; i + w < h.length; i++) {
      var g = Math.abs(h[i + w] - h[i]) / (w * step) * 100;
      if (g > best) best = g;
    }
    return Math.min(best, MAX_GRADE_PCT);
  }

  // 坂の多さ。1kmあたりの上り（climbPerKm）と最大勾配（60m幅で測る）の両方を見る。
  //  - 坂が多い：上りが 20m/km 以上（約2.4km歩いて約50m登る＝ふつうの人が「きつい」と感じ始める目安）
  //              または 最大勾配 12% 以上（歩道の急坂。車いすの限界を超える）
  //  - 平ら：上りが 8m/km 未満 かつ 最大勾配 8% 未満
  //  - それ以外：少し坂あり
  //  最大勾配を 4% でなく 8% にしたのは、実測で、東京の平らな住宅地でも川や線路をまたぐ所で 6〜8% の短い坂が
  //  1か所出るため（高円寺付近のテスト：上り 2.5m/km なのに最大 7.9%）。それだけで「少し坂あり」にはしない。
  //  また、上りの合計が 6m 未満の短いルートでは最大勾配の判定を使わない。
  function levelOf(climbMeters, perKm, maxPct) {
    var key;
    var steepOk = climbMeters >= 6;
    if (perKm >= HILLY_CLIMB_PER_KM || (steepOk && maxPct >= HILLY_MAX_GRADE)) key = 'hilly';
    else if (perKm < FLAT_CLIMB_PER_KM && (!steepOk || maxPct < FLAT_MAX_GRADE)) key = 'flat';
    else key = 'some';
    return key;
  }

  // ---------- 本体 ----------
  function profile(coords, opts) {
    var signal = opts && opts.signal;
    return Promise.resolve().then(function () {
      throwIfAborted(signal);
      if (!Array.isArray(coords) || coords.length < 2) {
        throw ElevationError('ルートの線が短すぎて、坂を調べられません。');
      }
      var clean = coords.filter(function (c) {
        return c && isFinite(c[0]) && isFinite(c[1]);
      });
      if (clean.length < 2) throw ElevationError('ルートの線が正しくないため、坂を調べられません。');

      var rs = resample(clean);
      if (!(rs.total > 0)) throw ElevationError('ルートの線が短すぎて、坂を調べられません。');
      var pts = rs.pts, all = pts.map(function (_, i) { return i; });
      var source = LAYERS[0].name;

      return sampleLayer(LAYERS[0], pts, all, signal).then(function () {
        var missing = all.filter(function (i) { return !(pts[i].h === pts[i].h); });
        if (!missing.length) return;
        source = LAYERS[0].name + '+' + LAYERS[1].name;
        return sampleLayer(LAYERS[1], pts, missing, signal);
      }).then(function () {
        throwIfAborted(signal);
        var h = pts.map(function (p) { return p.h; });
        var have = h.filter(function (v) { return v === v; }).length;
        if (have < Math.max(2, h.length * 0.3) || !fillGaps(h)) {
          throw ElevationError('このあたりの標高データが見つかりませんでした。');
        }
        h = movingAverage(median(h, MEDIAN_WIN), MEAN_WIN);
        h = clampSteps(h, rs.step);
        var cd = climbDescent(h);
        var mg = maxGrade(h, rs.step);
        var km = rs.total / 1000;
        var perKm = cd.up / km;
        var key = levelOf(cd.up, perKm, mg);
        return {
          climbMeters: Math.round(cd.up),
          descentMeters: Math.round(cd.down),
          maxGradePct: Math.round(mg * 10) / 10,
          levelKey: key,
          levelJa: LEVELS[key],
          distanceMeters: Math.round(rs.total),
          climbPerKm: Math.round(perKm * 10) / 10,
          source: source
        };
      });
    }).catch(function (err) {
      if (err && (err.name === 'AbortError' || err.name === 'ElevationError')) throw err;
      throw ElevationError('坂の多さを調べられませんでした。', err);
    });
  }

  global.Elevation = {
    profile: profile,
    ElevationError: ElevationError,
    attribution: ATTRIBUTION
  };
})(typeof window !== 'undefined' ? window : this);
