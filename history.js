/*
 * history.js — WalkHistory（歩いた記録の保存）
 * グローバルに出すのは window.WalkHistory だけ。保存先は localStorage の "sanpo.history"。
 * localStorage が使えない・いっぱいのときも、画面が壊れないようにする
 * （最後の手段として、このページを開いている間だけメモリに持つ）。
 */
(function () {
  'use strict';

  var KEY = 'sanpo.history';
  var TOLERANCE_M = 4;          // 線を間引くときの許容のずれ（m）
  var memory = null;            // 保存に失敗したときの避難先（配列 or null）

  var RAD = Math.PI / 180;
  var KY = 6371008.8 * RAD;

  // ---- 線の間引き（Douglas-Peucker。再帰を使わない） ----
  function simplify(coords, tolM) {
    if (!Array.isArray(coords)) return [];
    var pts = [];
    for (var i = 0; i < coords.length; i++) {
      var c = coords[i];
      if (c && isFinite(c[0]) && isFinite(c[1])) pts.push([+c[0], +c[1]]);
    }
    var n = pts.length;
    if (n <= 2) return pts.map(round5);

    var lat0 = pts[0][0];
    var kx = Math.cos(lat0 * RAD) * KY;
    var x = new Array(n), y = new Array(n);
    for (var j = 0; j < n; j++) {
      x[j] = (pts[j][1] - pts[0][1]) * kx;
      y[j] = (pts[j][0] - lat0) * KY;
    }

    var keep = new Uint8Array(n);
    keep[0] = 1; keep[n - 1] = 1;
    var stack = [[0, n - 1]];
    while (stack.length) {
      var seg = stack.pop();
      var a = seg[0], b = seg[1];
      if (b <= a + 1) continue;
      var dx = x[b] - x[a], dy = y[b] - y[a];
      var len2 = dx * dx + dy * dy;
      var maxD = -1, idx = -1;
      for (var k = a + 1; k < b; k++) {
        var d;
        if (len2 === 0) {
          d = Math.hypot(x[k] - x[a], y[k] - y[a]);
        } else {
          var t = ((x[k] - x[a]) * dx + (y[k] - y[a]) * dy) / len2;
          if (t < 0) t = 0; else if (t > 1) t = 1;
          d = Math.hypot(x[k] - (x[a] + t * dx), y[k] - (y[a] + t * dy));
        }
        if (d > maxD) { maxD = d; idx = k; }
      }
      if (maxD > tolM) {
        keep[idx] = 1;
        stack.push([a, idx], [idx, b]);
      }
    }
    var out = [];
    for (var m = 0; m < n; m++) if (keep[m]) out.push(round5(pts[m]));
    return out;
  }

  function round5(p) {
    return [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5];
  }

  function numOr0(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }

  function newId() {
    return 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ---- 読み書き ----
  function storage() {
    try { return window.localStorage || null; } catch (e) { return null; }
  }

  function read() {
    if (memory) return memory.slice();
    try {
      var ls = storage();
      if (!ls) return [];
      var raw = ls.getItem(KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function write(list) {
    try {
      var ls = storage();
      if (!ls) return false;
      ls.setItem(KEY, JSON.stringify(list));
      memory = null;
      return true;
    } catch (e) {
      return false;
    }
  }

  function hasCoords(r) {
    return (r.routeCoords && r.routeCoords.length) || (r.trackCoords && r.trackCoords.length);
  }

  // 容量がいっぱいのとき：古い記録の線から削って、数字は残す。
  // list は古い順（末尾が新しい）。
  function writeWithTrim(list) {
    if (write(list)) return true;
    for (var i = 0; i < list.length; i++) {
      if (!hasCoords(list[i])) continue;
      list[i].routeCoords = [];
      list[i].trackCoords = [];
      if (write(list)) return true;
    }
    return false;
  }

  function clone(r) {
    return JSON.parse(JSON.stringify(r));
  }

  // ---- 公開 API ----
  function save(record) {
    record = record || {};
    var saved = {
      id: newId(),
      startedAt: record.startedAt || new Date().toISOString(),
      endedAt: record.endedAt || new Date().toISOString(),
      durationMs: numOr0(record.durationMs),
      walkedMeters: numOr0(record.walkedMeters),
      steps: numOr0(record.steps),
      plannedMeters: numOr0(record.plannedMeters),
      goalType: record.goalType === 'home' ? 'home' : 'start',
      reachedGoal: !!record.reachedGoal,
      routeCoords: simplify(record.routeCoords, TOLERANCE_M),
      trackCoords: simplify(record.trackCoords, TOLERANCE_M)
    };
    // 歩いた区間の割合（0〜1）。古い記録・渡されなかったときは付けない
    if (typeof record.coverageRatio === 'number' && isFinite(record.coverageRatio)) {
      saved.coverageRatio = Math.max(0, Math.min(1, record.coverageRatio));
    }
    // 追加の記録（ペース・画面が消えていた時間・近道）。渡されたものだけ保存する
    if (Array.isArray(record.splits)) {
      saved.splits = record.splits.filter(function (x) {
        return x && isFinite(x.km) && isFinite(x.durationMs);
      }).map(function (x) { return { km: +x.km, durationMs: Math.round(x.durationMs) }; });
    }
    if (typeof record.avgPaceSecPerKm === 'number' && isFinite(record.avgPaceSecPerKm)) {
      saved.avgPaceSecPerKm = Math.round(record.avgPaceSecPerKm);
    }
    if (typeof record.screenOffMs === 'number' && isFinite(record.screenOffMs)) {
      saved.screenOffMs = Math.max(0, Math.round(record.screenOffMs));
    }
    if (record.usedShortcut !== undefined) saved.usedShortcut = !!record.usedShortcut;
    var list = read();
    list.push(saved);
    if (!writeWithTrim(list)) {
      memory = list; // 保存先が使えない：このページを開いている間だけ持っておく
    }
    return clone(saved);
  }

  function list() {
    return read().reverse().map(clone);
  }

  function get(id) {
    var all = read();
    for (var i = 0; i < all.length; i++) {
      if (all[i] && all[i].id === id) return clone(all[i]);
    }
    return null;
  }

  function remove(id) {
    var all = read();
    var next = all.filter(function (r) { return !(r && r.id === id); });
    if (next.length === all.length) return false;
    if (!write(next)) memory = next;
    return true;
  }

  function totals() {
    var all = read();
    var meters = 0, steps = 0;
    for (var i = 0; i < all.length; i++) {
      meters += numOr0(all[i] && all[i].walkedMeters);
      steps += numOr0(all[i] && all[i].steps);
    }
    return { count: all.length, meters: meters, steps: steps };
  }

  // ---- 日・週・月のまとめ（日付は端末の時刻で決める） ----
  function pad2(v) { return (v < 10 ? '0' : '') + v; }
  function dateKey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function toDate(now) {
    var d = now instanceof Date ? new Date(now.getTime()) : (typeof now === 'number' ? new Date(now) : new Date());
    return isNaN(d.getTime()) ? new Date() : d;
  }
  function addDays(d, k) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + k); }

  // { 'YYYY-MM-DD': { meters, steps, count, durationMs } }（歩き始めた日で数える）
  function daily() {
    var out = {};
    var all = read();
    for (var i = 0; i < all.length; i++) {
      var r = all[i];
      if (!r) continue;
      var d = new Date(r.startedAt);
      if (isNaN(d.getTime())) continue;
      var k = dateKey(d);
      var e = out[k] || (out[k] = { meters: 0, steps: 0, count: 0, durationMs: 0 });
      e.meters += numOr0(r.walkedMeters);
      e.steps += numOr0(r.steps);
      e.count += 1;
      e.durationMs += numOr0(r.durationMs);
    }
    return out;
  }

  // kind: 'week'（月曜はじまり）| 'month'、offset: 0 が今、-1 が前。now は試験用（省略すると今）
  function periodTotals(kind, offset, now) {
    offset = (typeof offset === 'number' && isFinite(offset)) ? Math.round(offset) : 0;
    var today = toDate(now);
    var start, end;
    if (kind === 'month') {
      start = new Date(today.getFullYear(), today.getMonth() + offset, 1);
      end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
    } else {
      var dow = (today.getDay() + 6) % 7; // 月曜 = 0
      start = addDays(today, -dow + offset * 7);
      end = addDays(start, 6);
    }
    var byDay = daily();
    var res = { from: dateKey(start), to: dateKey(end), meters: 0, steps: 0, count: 0, durationMs: 0, days: [] };
    for (var d = start; d.getTime() <= end.getTime(); d = addDays(d, 1)) {
      var k = dateKey(d);
      var e = byDay[k] || { meters: 0, steps: 0, count: 0, durationMs: 0 };
      res.days.push({ date: k, meters: e.meters, steps: e.steps, count: e.count });
      res.meters += e.meters; res.steps += e.steps; res.count += e.count; res.durationMs += e.durationMs;
    }
    return res;
  }

  // 何日連続で歩いたか。今日まだ歩いていなくても、昨日まで続いていれば current は続いている。
  // 「歩いた日」＝その日に walkedMeters が 0 より大きい記録がある日。now は試験用。
  function streak(now) {
    var byDay = daily();
    var days = Object.keys(byDay).filter(function (k) { return byDay[k].meters > 0; }).sort();
    var set = {};
    days.forEach(function (k) { set[k] = true; });
    var best = 0, run = 0, prev = null;
    days.forEach(function (k) {
      var p = k.split('-');
      var d = new Date(+p[0], +p[1] - 1, +p[2]);
      run = (prev && dateKey(addDays(prev, 1)) === k) ? run + 1 : 1;
      if (run > best) best = run;
      prev = d;
    });
    var today = toDate(now);
    var d0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    var cursor = set[dateKey(d0)] ? d0 : addDays(d0, -1);
    var current = 0;
    while (set[dateKey(cursor)]) { current++; cursor = addDays(cursor, -1); }
    return { current: current, best: best };
  }

  window.WalkHistory = {
    save: save, list: list, get: get, remove: remove, totals: totals,
    daily: daily, periodTotals: periodTotals, streak: streak
  };
})();
