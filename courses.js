/*
 * courses.js — WalkCourses（いつものコース）
 * グローバルに出すのは window.WalkCourses だけ。保存先は localStorage の "sanpo.courses"。
 * 座標は [lat, lng]、距離は m。ほかのファイルには頼らない。
 * 使えない・いっぱいのときも例外を出さない（最後の手段として、このページを開いている間だけメモリに持つ）。
 */
(function () {
  'use strict';

  var KEY = 'sanpo.courses';
  var TOLERANCE_M = 3;          // 線を間引くときの許容のずれ
  var TOLERANCE_RETRY_M = 8;    // 容量がいっぱいのときの再挑戦
  var memory = null;

  var R = 6371008.8;
  var RAD = Math.PI / 180;
  var KY = R * RAD;

  function hav(a, b) {
    var dLat = (b[0] - a[0]) * RAD, dLng = (b[1] - a[1]) * RAD;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function round5(p) { return [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5]; }

  function cleanCoords(coords) {
    var pts = [];
    (Array.isArray(coords) ? coords : []).forEach(function (c) {
      if (c && isFinite(c[0]) && isFinite(c[1])) pts.push([+c[0], +c[1]]);
    });
    return pts;
  }

  // Douglas-Peucker（再帰なし）。forced に入っている番号の点は必ず残す（曲がり角の頂点）
  function simplify(pts, tolM, forced) {
    var n = pts.length;
    if (n <= 2) return pts.map(function (p, i) { return { p: p, i: i }; });
    var kx = Math.cos(pts[0][0] * RAD) * KY;
    var x = new Array(n), y = new Array(n);
    for (var j = 0; j < n; j++) {
      x[j] = (pts[j][1] - pts[0][1]) * kx;
      y[j] = (pts[j][0] - pts[0][0]) * KY;
    }
    var keep = new Uint8Array(n);
    keep[0] = 1; keep[n - 1] = 1;
    var anchors = [0];
    Object.keys(forced || {}).map(Number).sort(function (a, b) { return a - b; }).forEach(function (i) {
      if (i > 0 && i < n - 1) { keep[i] = 1; anchors.push(i); }
    });
    anchors.push(n - 1);
    var stack = [];
    for (var q = 0; q + 1 < anchors.length; q++) stack.push([anchors[q], anchors[q + 1]]);
    while (stack.length) {
      var seg = stack.pop(), a = seg[0], b = seg[1];
      if (b <= a + 1) continue;
      var dx = x[b] - x[a], dy = y[b] - y[a], len2 = dx * dx + dy * dy;
      var maxD = -1, idx = -1;
      for (var k = a + 1; k < b; k++) {
        var d;
        if (len2 === 0) d = Math.hypot(x[k] - x[a], y[k] - y[a]);
        else {
          var t = ((x[k] - x[a]) * dx + (y[k] - y[a]) * dy) / len2;
          if (t < 0) t = 0; else if (t > 1) t = 1;
          d = Math.hypot(x[k] - (x[a] + t * dx), y[k] - (y[a] + t * dy));
        }
        if (d > maxD) { maxD = d; idx = k; }
      }
      if (maxD > tolM) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
    }
    var out = [];
    for (var m = 0; m < n; m++) if (keep[m]) out.push({ p: pts[m], i: m });
    return out;
  }

  function polyLen(pts) {
    var s = 0;
    for (var i = 1; i < pts.length; i++) s += hav(pts[i - 1], pts[i]);
    return s;
  }

  // 間引いた線の上での曲がり角の位置を測り直す。
  // 元の位置（atMeters）に近い候補を選ぶので、同じ道を往復するルートでも取り違えにくい。
  function remeasureTurns(turns, pts, oldLen) {
    var n = pts.length;
    if (!turns.length || n < 2) return [];
    var cum = [0];
    for (var i = 1; i < n; i++) cum.push(cum[i - 1] + hav(pts[i - 1], pts[i]));
    var newLen = cum[n - 1];
    var scale = oldLen > 0 ? newLen / oldLen : 1;
    var kx = Math.cos(pts[0][0] * RAD) * KY;
    var X = pts.map(function (p) { return (p[1] - pts[0][1]) * kx; });
    var Y = pts.map(function (p) { return (p[0] - pts[0][0]) * KY; });
    var out = turns.map(function (t) {
      var tx = (t.lng - pts[0][1]) * kx, ty = (t.lat - pts[0][0]) * KY;
      var cands = [], best = Infinity;
      for (var i = 0; i < n - 1; i++) {
        var dx = X[i + 1] - X[i], dy = Y[i + 1] - Y[i], len2 = dx * dx + dy * dy;
        var u = len2 > 0 ? ((tx - X[i]) * dx + (ty - Y[i]) * dy) / len2 : 0;
        if (u < 0) u = 0; else if (u > 1) u = 1;
        var d = Math.hypot(tx - (X[i] + u * dx), ty - (Y[i] + u * dy));
        cands.push([d, cum[i] + u * (cum[i + 1] - cum[i])]);
        if (d < best) best = d;
      }
      var exp = (isFinite(t.atMeters) ? t.atMeters : 0) * scale, pick = null, gap = Infinity;
      cands.forEach(function (c) {
        if (c[0] <= best + 8 && Math.abs(c[1] - exp) < gap) { gap = Math.abs(c[1] - exp); pick = c[1]; }
      });
      var o = {};
      for (var k in t) if (Object.prototype.hasOwnProperty.call(t, k)) o[k] = t[k];
      o.atMeters = Math.round((pick === null ? exp : pick) * 10) / 10;
      return o;
    });
    out.sort(function (a, b) { return a.atMeters - b.atMeters; });
    return out;
  }

  function buildRoute(route, tol) {
    route = route || {};
    var pts = cleanCoords(route.coords);
    var oldLen = polyLen(pts);
    var turns = (Array.isArray(route.turns) ? route.turns : []).filter(function (t) {
      return t && isFinite(t.lat) && isFinite(t.lng);
    });
    // 曲がり角にいちばん近い頂点は残す
    var forced = {};
    turns.forEach(function (t) {
      var bi = -1, bd = Infinity;
      for (var i = 0; i < pts.length; i++) {
        var d = Math.abs(pts[i][0] - t.lat) + Math.abs(pts[i][1] - t.lng);
        if (d < bd) { bd = d; bi = i; }
      }
      if (bi >= 0) forced[bi] = true;
    });
    var kept = simplify(pts, tol, forced).map(function (o) { return round5(o.p); });
    var newTurns = remeasureTurns(turns, kept, oldLen).map(function (t) {
      t.lat = Math.round(t.lat * 1e5) / 1e5; t.lng = Math.round(t.lng * 1e5) / 1e5;
      return t;
    });
    var dist = Math.round(polyLen(kept));
    return {
      id: route.id, labelJa: route.labelJa, type: route.type,
      coords: kept, turns: newTurns, distanceMeters: dist
    };
  }

  // ---- 読み書き ----
  function storage() { try { return window.localStorage || null; } catch (e) { return null; } }

  function read() {
    if (memory) return memory.slice();
    try {
      var ls = storage();
      if (!ls) return [];
      var raw = ls.getItem(KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function write(list) {
    try {
      var ls = storage();
      if (!ls) return false;
      ls.setItem(KEY, JSON.stringify(list));
      memory = null;
      return true;
    } catch (e) { return false; }
  }

  function persist(list) {
    if (!write(list)) memory = list;
  }

  function clone(c) { return c ? JSON.parse(JSON.stringify(c)) : c; }

  function newId() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function cleanName(s) {
    s = (typeof s === 'string' ? s : '').replace(/\s+/g, ' ').trim();
    if (s.length > 40) s = s.slice(0, 40);
    return s || 'いつものコース';
  }

  function point(p, fallback) {
    if (p && isFinite(p.lat) && isFinite(p.lng)) return { lat: +p.lat, lng: +p.lng };
    return fallback;
  }

  // ---- 公開 API ----
  function save(input) {
    input = input || {};
    var route0 = input.route || {};
    var pts0 = cleanCoords(route0.coords);
    if (pts0.length < 2) return null; // ルートの座標が2点未満：保存しない（null を返す）
    var first = pts0.length ? { lat: pts0[0][0], lng: pts0[0][1] } : null;
    var last = pts0.length ? { lat: pts0[pts0.length - 1][0], lng: pts0[pts0.length - 1][1] } : null;
    var now = new Date().toISOString();
    var list = read();
    var course = null;
    var tols = [TOLERANCE_M, TOLERANCE_RETRY_M];
    for (var i = 0; i < tols.length; i++) {
      var rt = buildRoute(route0, tols[i]);
      course = {
        id: newId(),
        nameJa: cleanName(input.nameJa),
        createdAt: now,
        lastUsedAt: now,
        useCount: 0,
        route: rt,
        start: point(input.start, first),
        goal: point(input.goal, last),
        goalType: input.goalType === 'home' ? 'home' : 'start',
        distanceMeters: rt.distanceMeters
      };
      var next = list.concat([course]);
      if (write(next)) return clone(course);
    }
    list.push(course);
    memory = list; // 保存先が使えない：このページを開いている間だけ持っておく
    return clone(course);
  }

  function list() {
    return read().map(function (c, i) { return { c: c, i: i }; }).sort(function (x, y) {
      var la = String(x.c.lastUsedAt || ''), lb = String(y.c.lastUsedAt || '');
      if (la !== lb) return la < lb ? 1 : -1;
      var ca = String(x.c.createdAt || ''), cb = String(y.c.createdAt || '');
      if (ca !== cb) return ca < cb ? 1 : -1;
      return y.i - x.i; // 同じ時刻なら後から作ったほうが先
    }).map(function (o) { return clone(o.c); });
  }

  function get(id) {
    var all = read();
    for (var i = 0; i < all.length; i++) if (all[i] && all[i].id === id) return clone(all[i]);
    return null;
  }

  function remove(id) {
    var all = read();
    var next = all.filter(function (c) { return !(c && c.id === id); });
    if (next.length === all.length) return false;
    persist(next);
    return true;
  }

  function update(id, fn) {
    var all = read();
    for (var i = 0; i < all.length; i++) {
      if (all[i] && all[i].id === id) {
        fn(all[i], all);
        persist(all);
        return clone(all[i]);
      }
    }
    return null;
  }

  function rename(id, nameJa) { return update(id, function (c) { c.nameJa = cleanName(nameJa); }); }

  function markUsed(id) {
    return update(id, function (c, all) {
      var now = Date.now();
      all.forEach(function (o) { // 同じ時刻でも「いま使った」が必ず先頭に来るようにする
        var t = Date.parse(o && o.lastUsedAt);
        if (isFinite(t) && t >= now) now = t + 1;
      });
      c.lastUsedAt = new Date(now).toISOString();
      c.useCount = (c.useCount || 0) + 1;
    });
  }

  window.WalkCourses = { save: save, list: list, get: get, remove: remove, rename: rename, markUsed: markUsed };
})();
