/*
 * walk.js — WalkTracker（歩いている間の計測）
 * グローバルに出すのは window.WalkTracker だけ。ほかのファイルやライブラリには頼らない。
 * 座標は [lat, lng]、距離は m、時間は ms。
 *
 * ■ 速度チェックとシミュレーターの関係
 *   GPS の「ワープ」（急に遠くへ飛ぶ）は、見かけの速さ（距離÷時間）が maxSpeed を超えたときに捨てる。
 *   ただし同じ場所に2回続けて飛んだ（＝本当に動いた）ときは採用する。
 *   既定の maxSpeed は 4 m/s（早足〜ジョギング程度）。
 *   simulateGeolocation() が返すオブジェクトには simulatedSpeedMps が付いていて、
 *   WalkTracker はそれを見つけると maxSpeed を max(4, 速さ×1.5+1) に緩める
 *   （画面側がデモで 15 m/s を使っても全部捨てられない）。
 *   create({ maxSpeedMps }) で明示的に決めることもできる（こちらが優先）。
 *   シミュレーターのタイムスタンプは「仮想時間」（virtualIntervalMs ずつ進む）なので、
 *   テストで intervalMs を短くしても見かけの速さは変わらない。
 */
(function () {
  'use strict';

  var R = 6371008.8;
  var RAD = Math.PI / 180;

  // ---- しきい値 ----
  var WEAK_ACCURACY_M = 50;      // これより精度が悪い測位は距離に足さない（gpsWeak）
  var MIN_STEP_M = 5;            // 足あとに足す最小の移動量
  var MAX_STEP_M = 15;           // 〃 精度が悪いときの上限
  var WALK_MAX_SPEED = 4;        // m/s これを超えて動いたように見える測位は一旦捨てる
  var GAP_MS = 10000;            // これ以上測位が途切れたら「バックグラウンドの空白」とみなす
  var GAP_MAX_SPEED = 20;        // m/s 空白のあとの許容速度（直線距離をそのまま足す）
  var OFF_ROUTE_M = 50;          // ルートから離れすぎの目安
  var WINDOW_BACK_M = 30;        // 進み具合の探索窓：いまの進み具合から後ろ
  var WINDOW_AHEAD_M = 300;      // 〃 前（最低値）
  var GOAL_RADIUS_M = 30;        // ゴール判定の半径（精度が悪いときは広げる）
  var GOAL_RADIUS_MAX_M = 60;
  var GOAL_PROGRESS_RATIO = 0.8; // ルートの8割以上進んでいること
  var SMOOTH_MIN_ALPHA = 0.35;   // なめらかにする強さ（小さいほど強い）
  var TURN_PASS_M = 8;           // 曲がり角まで残りこれ以下になったら「通過した」とみなす
  var BIN_M = 10;                // 歩いた区間を記録する細かさ（ルート上 10m ごと）
  var COVER_RADIUS_M = 30;       // 「そばを歩いた」とみなす距離（精度が悪いときは広げる）
  var COVER_MAX_M = 40;
  var COVER_SKIP_MIN_M = 30;     // これより短い歩き残しは GPS のぶれとして無視（埋める）
  var COVER_BEHIND_M = 20;       // 現在の進み具合のこれより手前だけを「飛ばした」と判定
  var SHORTCUT_GOAL_RATIO = 0.5; // 近道ルートでのゴール判定：進み具合がこれ以上、または
  var SHORTCUT_GOAL_REMAIN_M = 60; //   残りがこれ未満
  var PACE_WINDOW_M = 300;       // 「いまのペース」を測る直近の歩いた距離
  var SCREEN_GAP_MS = 15000;     // 動いているしるしがこれ以上途切れたら「画面が消えていた」
  var AUTOSAVE_MS = 10000;       // 途中の状態を保存する間隔
  var AUTOSAVE_TRACK_CAP = 1500; // 保存する足あとの点の上限
  var ACTIVE_KEY = 'sanpo.activeWalk';
  var TICK_MS = 1000;

  function hav(lat1, lng1, lat2, lng2) {
    var dLat = (lat2 - lat1) * RAD;
    var dLng = (lng2 - lng1) * RAD;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function num(v, fallback) {
    return (typeof v === 'number' && isFinite(v)) ? v : fallback;
  }

  // ---------------------------------------------------------------
  // ルートの形（累積距離・平面座標）をまとめて持つ
  // ---------------------------------------------------------------
  function buildGeom(coords) {
    var pts = [];
    (coords || []).forEach(function (p) {
      if (p && isFinite(p[0]) && isFinite(p[1])) pts.push([+p[0], +p[1]]);
    });
    var n = pts.length;
    var g = { n: n, pts: pts, px: [], py: [], cum: [0], segLen: [] };
    g.lat0 = n ? pts[0][0] : 0;
    g.lng0 = n ? pts[0][1] : 0;
    g.kx = Math.cos(g.lat0 * RAD) * R * RAD;
    g.ky = R * RAD;
    for (var i = 0; i < n; i++) {
      g.px.push((pts[i][1] - g.lng0) * g.kx);
      g.py.push((pts[i][0] - g.lat0) * g.ky);
      if (i > 0) {
        var l = hav(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
        g.segLen.push(l);
        g.cum.push(g.cum[i - 1] + l);
      }
    }
    g.len = n ? g.cum[n - 1] : 0;
    g.segCount = Math.max(0, n - 1);
    // s（ルート上の距離）を含む線分の番号
    g.segAt = function (s) {
      if (g.segCount === 0) return 0;
      var lo = 0, hi = g.segCount - 1;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (g.cum[mid + 1] >= s) hi = mid; else lo = mid + 1;
      }
      return lo;
    };
    return g;
  }

  function cleanTurns(route) {
    return (route && Array.isArray(route.turns) ? route.turns : []).filter(function (t) {
      return t && isFinite(t.atMeters);
    }).slice().sort(function (a, b) { return a.atMeters - b.atMeters; });
  }

  function r5(v) { return Math.round(v * 1e5) / 1e5; }

  // ---------------------------------------------------------------
  // 途中の状態の保存（localStorage の sanpo.activeWalk）
  // ---------------------------------------------------------------
  function loadActive() {
    try {
      var raw = window.localStorage.getItem(ACTIVE_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (!s || typeof s !== 'object' || !s.route || !Array.isArray(s.route.coords) || s.route.coords.length < 2) return null;
      return s;
    } catch (e) { return null; }
  }

  function clearActive() {
    try { window.localStorage.removeItem(ACTIVE_KEY); } catch (e) { /* 無視 */ }
  }

  // ---------------------------------------------------------------
  // create
  // ---------------------------------------------------------------
  function create(opts) {
    opts = opts || {};
    var resume = (opts.resumeFrom && typeof opts.resumeFrom === 'object' && opts.resumeFrom.route &&
                  Array.isArray(opts.resumeFrom.route.coords)) ? opts.resumeFrom : null;

    // 計画のルート（記録の plannedMeters・routeCoords・歩いた区間の物差し）と、いま案内に使うルート
    var routeOrg = resume ? (resume.origRoute || resume.route) : (opts.route || {});
    var routeCur = resume ? resume.route : routeOrg;
    var org = buildGeom(routeOrg.coords);
    var cur = (routeCur === routeOrg) ? org : buildGeom(routeCur.coords);
    var turns = cleanTurns(routeCur);
    var replaced = !!(resume && resume.usedShortcut);

    var strideM = Math.max(0.2, num(opts.strideCm, 70) / 100);
    var goalType = (resume && resume.goalType ? resume.goalType : opts.goalType) === 'home' ? 'home' : 'start';
    var onUpdate = typeof opts.onUpdate === 'function' ? opts.onUpdate : function () {};
    var onGoal = typeof opts.onGoal === 'function' ? opts.onGoal : function () {};
    var onError = typeof opts.onError === 'function' ? opts.onError : function () {};
    var geo = opts.geolocation ||
      (typeof navigator !== 'undefined' && navigator.geolocation) || null;

    function goalFrom(g, geom) {
      if (g && isFinite(g.lat) && isFinite(g.lng)) return { lat: +g.lat, lng: +g.lng };
      return geom.n ? { lat: geom.pts[geom.n - 1][0], lng: geom.pts[geom.n - 1][1] } : null;
    }
    var goal = goalFrom((resume && resume.goal) || opts.goal, cur);

    var maxSpeed = num(opts.maxSpeedMps, 0);
    if (!(maxSpeed > 0)) {
      maxSpeed = (geo && num(geo.simulatedSpeedMps, 0) > 0)
        ? Math.max(WALK_MAX_SPEED, geo.simulatedSpeedMps * 1.5 + 1)
        : WALK_MAX_SPEED;
    }
    var gapMaxSpeed = Math.max(GAP_MAX_SPEED, maxSpeed * 1.5);

    // ---- 歩いた区間：元のルート上 BIN_M ごとの「そばを歩いた」印 ----
    var nb = Math.max(1, Math.ceil(org.len / BIN_M));
    var visited = new Uint8Array(nb);
    var covFrozen = 0;        // 近道に切りかえた時点の、元のルート上の進み具合

    // ---- 状態 ----
    var started = false, stopped = false, summary = null;
    var startedMs = 0, startedIso = '';
    var watchId = null, tickTimer = null;
    var wakeLock = null, wakeBusy = false;

    var position = null;
    var walked = 0;
    var track = [];
    var lastPt = null;        // 足あとの最後の点
    var ref = null;           // 最後に採用した良い測位 {lat,lng,ts}
    var smooth = null;        // 足あと・距離用のなめらかにした位置（GPS のぶれで距離がふくらむのを防ぐ）
    var glitch = null;        // 速度チェックで保留中の測位
    var gpsWeak = false;
    var progress = 0;
    var offRoute = 0;
    var isOff = false;
    var offWalk = 0;          // ルートに合わなかった間に歩いた距離（探索窓を広げる）
    var fallback = null;      // 全体検索の候補 {p, count}
    var reached = false, goalFired = false;

    // ペース（時間は測位のタイムスタンプで測る）
    var splits = [];
    var firstTs = null, lastTs = null, splitT0 = null;
    var carrySpanMs = 0, carryKmMs = 0;   // 再開したとき、前回までの分を最初の測位で引きつぐ
    var paceSamples = [];

    // 画面が消えていた時間
    var screenOff = { totalMs: 0, lastGapMs: 0, lastGapEndedAt: null };
    var aliveAt = 0, hiddenAt = null;
    var lastSaveAt = 0;

    // ---- 再開：前回の状態を戻す ----
    if (resume) {
      walked = num(resume.walkedMeters, 0);
      progress = num(resume.progressMeters, 0);
      reached = !!resume.reachedGoal;
      goalFired = reached;
      covFrozen = num(resume.covFrozen, 0);
      if (Array.isArray(resume.track)) {
        resume.track.forEach(function (p) {
          if (p && isFinite(p[0]) && isFinite(p[1])) track.push([+p[0], +p[1]]);
        });
        if (track.length) lastPt = { lat: track[track.length - 1][0], lng: track[track.length - 1][1] };
      }
      if (Array.isArray(resume.visitedBins)) {
        resume.visitedBins.forEach(function (r) {
          if (!r) return;
          for (var b = Math.max(0, r[0] | 0); b < Math.min(nb, r[1] | 0); b++) visited[b] = 1;
        });
      }
      if (Array.isArray(resume.splits)) {
        resume.splits.forEach(function (s) {
          if (s && isFinite(s.km) && isFinite(s.durationMs)) splits.push({ km: s.km, durationMs: s.durationMs });
        });
      }
      carrySpanMs = num(resume.spanMs, 0);
      carryKmMs = num(resume.kmMs, 0);
      if (resume.screenOff) {
        screenOff.totalMs = num(resume.screenOff.totalMs, 0);
        screenOff.lastGapMs = num(resume.screenOff.lastGapMs, 0);
        screenOff.lastGapEndedAt = num(resume.screenOff.lastGapEndedAt, null);
      }
      if (resume.position && isFinite(resume.position.lat) && isFinite(resume.position.lng)) {
        position = { lat: resume.position.lat, lng: resume.position.lng, accuracy: num(resume.position.accuracy, 30) };
      }
    }

    function covProgress() { return replaced ? covFrozen : progress; }

    function turnsState() {
      var idx = -1;
      for (var i = 0; i < turns.length; i++) {
        if (turns[i].atMeters - progress > TURN_PASS_M) { idx = i; break; }
      }
      if (idx < 0) return { nextTurn: null, turnAfter: null };
      var t = turns[idx], u = turns[idx + 1];
      return {
        nextTurn: { dir: t.dir, textJa: t.textJa, lat: t.lat, lng: t.lng,
                    distanceMeters: Math.max(0, t.atMeters - progress) },
        turnAfter: u ? { dir: u.dir, textJa: u.textJa,
                         distanceMeters: Math.max(0, u.atMeters - progress) } : null
      };
    }

    function coverageState() {
      var visitedRanges = [], skippedRanges = [], covered = 0;
      var routeLen = org.len;
      if (org.n < 2 || routeLen <= 0) return { ratio: 0, visitedRanges: visitedRanges, skippedRanges: skippedRanges };
      var maxGapBins = Math.ceil(COVER_SKIP_MIN_M / BIN_M) - 1; // 30m未満の歩き残しは埋める
      var runs = [], i = 0;
      while (i < nb) {
        if (!visited[i]) { i++; continue; }
        var a = i;
        while (i < nb && visited[i]) i++;
        if (runs.length && a - runs[runs.length - 1][1] <= maxGapBins) runs[runs.length - 1][1] = i;
        else runs.push([a, i]);
      }
      var limit = covProgress() - COVER_BEHIND_M;
      var prevEnd = 0;
      for (var r = 0; r <= runs.length; r++) {
        var gs = prevEnd;
        var ge = r < runs.length ? Math.min(routeLen, runs[r][0] * BIN_M) : routeLen;
        ge = Math.min(ge, limit);
        if (ge - gs >= COVER_SKIP_MIN_M) skippedRanges.push([Math.round(gs), Math.round(ge)]);
        if (r < runs.length) {
          var vs = runs[r][0] * BIN_M, ve = Math.min(routeLen, runs[r][1] * BIN_M);
          visitedRanges.push([Math.round(vs), Math.round(ve)]);
          covered += ve - vs;
          prevEnd = ve;
        }
      }
      return { ratio: Math.min(1, covered / routeLen), visitedRanges: visitedRanges, skippedRanges: skippedRanges };
    }

    // 測位 a→b（a は無くてもよい）の道すじのうち、元のルートの近くを通った所に印を付ける。
    // 同じ道を往復するルートで取り違えないよう、進み具合の窓 [lo, hi] の中の線分だけを見る。
    function markCoverage(a, b, accMax, lo, hi) {
      var g = org;
      if (g.segCount === 0) return;
      lo = Math.max(0, lo); hi = Math.min(g.len, hi);
      var rad = Math.min(COVER_MAX_M, Math.max(COVER_RADIUS_M, accMax));
      var len = a ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
      var ns = a ? Math.max(1, Math.ceil(len / 5)) : 0;
      var iLo = g.segAt(lo), iHi = g.segAt(hi);
      var lastP = null;
      for (var k = (a ? 0 : ns); k <= ns; k++) {
        var qx = a ? a.x + (b.x - a.x) * k / ns : b.x;
        var qy = a ? a.y + (b.y - a.y) * k / ns : b.y;
        var bestD = Infinity, bestP = 0;
        for (var i = iLo; i <= iHi; i++) {
          var ax = g.px[i], ay = g.py[i], dx = g.px[i + 1] - ax, dy = g.py[i + 1] - ay;
          var len2 = dx * dx + dy * dy;
          var t = len2 > 0 ? ((qx - ax) * dx + (qy - ay) * dy) / len2 : 0;
          if (t < 0) t = 0; else if (t > 1) t = 1;
          var d = Math.hypot(qx - (ax + t * dx), qy - (ay + t * dy));
          var p = g.cum[i] + t * g.segLen[i];
          if (d < bestD || (d === bestD && Math.abs(p - progress) < Math.abs(bestP - progress))) { bestD = d; bestP = p; }
        }
        if (bestD <= rad) {
          var b1 = Math.min(nb - 1, Math.floor(bestP / BIN_M));
          if (lastP !== null && Math.abs(bestP - lastP) <= 25) {
            var b0 = Math.min(nb - 1, Math.floor(lastP / BIN_M));
            for (var bb = Math.min(b0, b1); bb <= Math.max(b0, b1); bb++) visited[bb] = 1;
          } else {
            visited[b1] = 1;
          }
          lastP = bestP;
        } else {
          lastP = null;
        }
      }
    }

    // ---- ペース ----
    function currentPace() {
      if (walked < PACE_WINDOW_M || lastTs === null) return null;
      var idx = -1;
      for (var i = paceSamples.length - 1; i >= 0; i--) {
        if (paceSamples[i][0] <= walked - PACE_WINDOW_M) { idx = i; break; }
      }
      if (idx < 0) return null;
      if (idx > 0) paceSamples.splice(0, idx); // 古い分は捨てる
      var s0 = paceSamples[0];
      var dd = walked - s0[0], dt = lastTs - s0[1];
      if (dd <= 0 || dt <= 0) return null;
      return Math.round(dt / dd); // ms ÷ m ＝ 秒/km
    }

    function avgPace() {
      if (walked < 50 || firstTs === null || lastTs === null || lastTs <= firstTs) return null;
      return Math.round((lastTs - firstTs) / walked);
    }

    function snapshot() {
      var ts = turnsState();
      var steps = Math.round(walked / strideM);
      return {
        position: position ? { lat: position.lat, lng: position.lng, accuracy: position.accuracy } : null,
        walkedMeters: walked,
        steps: steps,
        progressMeters: progress,
        remainingMeters: Math.max(0, cur.len - progress),
        offRouteMeters: offRoute,
        isOffRoute: isOff,
        elapsedMs: started ? Date.now() - startedMs : 0,
        track: track.slice(),
        gpsWeak: gpsWeak,
        reachedGoal: reached,
        nextTurn: ts.nextTurn,
        turnAfter: ts.turnAfter,
        coverage: coverageState(),
        screenOff: { totalMs: screenOff.totalMs, lastGapMs: screenOff.lastGapMs, lastGapEndedAt: screenOff.lastGapEndedAt },
        splits: splits.map(function (s) { return { km: s.km, durationMs: s.durationMs }; }),
        currentPaceSecPerKm: currentPace(),
        avgPaceSecPerKm: avgPace()
      };
    }

    function emit() {
      try { onUpdate(snapshot()); } catch (e) { /* 画面側のエラーで計測を止めない */ }
    }

    // ---- 途中の状態を保存 ----
    function buildActive(trackCap) {
      function compactRoute(rt, g) {
        return {
          id: rt.id, labelJa: rt.labelJa, type: rt.type,
          distanceMeters: num(rt.distanceMeters, g.len),
          coords: g.pts.map(function (p) { return [r5(p[0]), r5(p[1])]; }),
          turns: cleanTurns(rt).map(function (t) {
            return { atMeters: Math.round(t.atMeters * 10) / 10, lat: t.lat, lng: t.lng, dir: t.dir, textJa: t.textJa };
          })
        };
      }
      var step = Math.max(1, Math.ceil(track.length / trackCap));
      var tr = [];
      for (var i = 0; i < track.length; i += step) tr.push([r5(track[i][0]), r5(track[i][1])]);
      if (track.length && (track.length - 1) % step !== 0) tr.push([r5(track[track.length - 1][0]), r5(track[track.length - 1][1])]);
      var runs = [], b = 0;
      while (b < nb) {
        if (!visited[b]) { b++; continue; }
        var a = b;
        while (b < nb && visited[b]) b++;
        runs.push([a, b]);
      }
      var now = Date.now();
      return {
        v: 1,
        startedAt: startedIso,
        startedMs: startedMs,
        elapsedMs: now - startedMs,   // 歩いていた時間（アプリを閉じていた間は含まない）
        lastUpdatedAt: new Date(now).toISOString(),
        walkedMeters: Math.round(walked * 10) / 10,
        steps: Math.round(walked / strideM),
        plannedMeters: num(routeOrg.distanceMeters, org.len),
        goalType: goalType,
        goal: goal,
        reachedGoal: reached,
        usedShortcut: replaced,
        progressMeters: Math.round(progress * 10) / 10,
        covFrozen: Math.round(covFrozen * 10) / 10,
        route: compactRoute(routeCur, cur),
        origRoute: replaced ? compactRoute(routeOrg, org) : undefined,
        track: tr,
        position: position ? { lat: r5(position.lat), lng: r5(position.lng), accuracy: Math.round(position.accuracy) } : null,
        visitedBins: runs,
        splits: splits.slice(),
        spanMs: (firstTs !== null && lastTs !== null) ? lastTs - firstTs : carrySpanMs,
        kmMs: (splitT0 !== null && lastTs !== null) ? lastTs - splitT0 : carryKmMs,
        screenOff: { totalMs: screenOff.totalMs, lastGapMs: screenOff.lastGapMs, lastGapEndedAt: screenOff.lastGapEndedAt }
      };
    }

    function saveActive() {
      if (stopped || !started) return;
      lastSaveAt = Date.now();
      try {
        var ls = window.localStorage;
        var caps = [AUTOSAVE_TRACK_CAP, 300];
        for (var i = 0; i < caps.length; i++) {
          try {
            ls.setItem(ACTIVE_KEY, JSON.stringify(buildActive(caps[i])));
            return;
          } catch (e) { /* 容量不足など：足あとを減らしてもう一度 */ }
        }
      } catch (e) { /* 保存できなくても歩く計測は続ける */ }
    }

    // ---- ルート上の進み具合 ----
    function updateRoute(lat, lng, acc, moved) {
      var g = cur;
      if (g.n === 0) return;
      var x = (lng - g.lng0) * g.kx, y = (lat - g.lat0) * g.ky;
      var offLimit = Math.max(OFF_ROUTE_M, acc * 1.5);

      if (g.segCount === 0) { // 点1つだけのルート
        offRoute = Math.hypot(x - g.px[0], y - g.py[0]);
        isOff = offRoute > offLimit;
        return;
      }

      var ahead = Math.max(WINDOW_AHEAD_M, moved * 1.5 + 100, offWalk + WINDOW_AHEAD_M);
      var iLo = g.segAt(Math.max(0, progress - WINDOW_BACK_M));
      var iHi = g.segAt(Math.min(g.len, progress + ahead));

      var gBest = Infinity;
      var cands = [];
      var oBest = Infinity, oProg = 0; // 窓の外（前方）で一番近い点
      for (var i = 0; i < g.segCount; i++) {
        var ax = g.px[i], ay = g.py[i];
        var dx = g.px[i + 1] - ax, dy = g.py[i + 1] - ay;
        var len2 = dx * dx + dy * dy;
        var t = len2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        var d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
        if (d < gBest) gBest = d;
        var p = g.cum[i] + t * g.segLen[i];
        if (i >= iLo && i <= iHi) {
          cands.push(d, p);
        } else if (i > iHi && d < oBest) {
          oBest = d; oProg = p;
        }
      }
      offRoute = gBest;
      isOff = gBest > offLimit;

      var wBest = Infinity;
      for (var k = 0; k < cands.length; k += 2) if (cands[k] < wBest) wBest = cands[k];

      if (wBest <= offLimit) {
        // 同じ道を往復するルートでは、近さが同じ候補が複数ある。
        // 「いまの進み具合＋直前の移動量」にいちばん近い候補を選ぶ。
        var tol = Math.min(20, Math.max(6, acc * 0.5));
        var expected = progress + moved;
        var best = null, bestGap = Infinity;
        for (var m = 0; m < cands.length; m += 2) {
          if (cands[m] <= wBest + tol) {
            var gp = Math.abs(cands[m + 1] - expected);
            if (gp < bestGap) { bestGap = gp; best = cands[m + 1]; }
          }
        }
        if (best !== null && best > progress) progress = best; // ほぼ単調（戻らない）
        offWalk = 0;
        fallback = null;
        return;
      }

      // 窓の中ではルートから外れている。近道などで前に飛んだ可能性だけ慎重に確かめる：
      // 前方で25m以内に近づく点が、連続3回の測位でほぼ同じ場所を指したときだけ採用。
      offWalk += moved;
      if (oBest <= 25) {
        if (fallback && Math.abs(fallback.p - oProg) < 150) {
          fallback.count++;
          fallback.p = oProg;
        } else {
          fallback = { p: oProg, count: 1 };
        }
        if (fallback.count >= 3) {
          if (fallback.p > progress) progress = fallback.p;
          fallback = null;
          offWalk = 0;
        }
      } else {
        fallback = null;
      }
    }

    // ---- 画面が消えていた時間の記録 ----
    function addGap(ms, endedAt) {
      screenOff.totalMs += ms;
      screenOff.lastGapMs = ms;
      screenOff.lastGapEndedAt = endedAt;
    }
    // 「動いている」しるし（タイマー・測位・画面が戻った）が来るたびに呼ぶ。
    // 画面が消えるとタイマーも止まるので、前回のしるしから15秒以上あいたらすき間とみなす。
    function markAlive() {
      var now = Date.now();
      if (aliveAt && now - aliveAt >= SCREEN_GAP_MS) addGap(now - aliveAt, now);
      aliveAt = now;
    }

    // ---- 測位が届いたとき ----
    function onPosition(pos) {
      if (!started || stopped || !pos || !pos.coords) return;
      markAlive();
      var c = pos.coords;
      var lat = c.latitude, lng = c.longitude;
      if (!isFinite(lat) || !isFinite(lng)) return;
      var acc = num(c.accuracy, 30);
      var ts = num(pos.timestamp, Date.now());
      var cur0 = { lat: lat, lng: lng, accuracy: acc };

      // 精度が悪い：位置だけ更新して、距離・進み具合には使わない
      if (acc > WEAK_ACCURACY_M) {
        gpsWeak = true;
        position = cur0;
        emit();
        return;
      }
      gpsWeak = false;

      // 速度チェック
      if (ref) {
        var accepted = false;
        for (var pass = 0; pass < 2 && !accepted; pass++) {
          var dt = Math.max(1, (ts - ref.ts) / 1000);
          var gap = (ts - ref.ts) > GAP_MS;
          var limit = gap ? gapMaxSpeed : maxSpeed;
          var d = hav(ref.lat, ref.lng, lat, lng);
          if (d / dt <= limit) {
            glitch = null;
            accepted = true;
          } else if (glitch && pass === 0 &&
                     hav(glitch.lat, glitch.lng, lat, lng) < Math.max(25, acc * 2)) {
            // 同じ場所に2回続けて飛んだ＝本当に動いた。直線距離をそのまま足して採用し、
            // 今回の測位はそこからの動きとして改めて調べる。
            adopt(glitch);
            glitch = null;
          } else {
            glitch = { lat: lat, lng: lng, accuracy: acc, ts: ts };
            emit();
            return;
          }
        }
      }

      adopt({ lat: lat, lng: lng, accuracy: acc, ts: ts });
      emit();
      if (reached && !goalFired) {
        goalFired = true;
        try { onGoal(snapshot()); } catch (e) { /* 無視 */ }
      }
    }

    function goalNear(f) {
      if (!goal || cur.len <= 0) return false;
      var radius = Math.min(GOAL_RADIUS_MAX_M, Math.max(GOAL_RADIUS_M, f.accuracy));
      if (hav(f.lat, f.lng, goal.lat, goal.lng) > radius) return false;
      if (!replaced) return progress >= cur.len * GOAL_PROGRESS_RATIO;
      // 近道は短いことがあるので、半分以上進んだか、残り 60m 未満でよい
      return progress >= cur.len * SHORTCUT_GOAL_RATIO || cur.len - progress < SHORTCUT_GOAL_REMAIN_M;
    }

    // 良い測位を採用して、距離・進み具合・ゴール判定を更新する
    function adopt(f) {
      var moved = ref ? hav(ref.lat, ref.lng, f.lat, f.lng) : 0;
      position = { lat: f.lat, lng: f.lng, accuracy: f.accuracy };

      // 時間の起点（再開したときは前回までの分をさかのぼって引きつぐ）
      if (firstTs === null) {
        firstTs = f.ts - carrySpanMs;
        splitT0 = f.ts - carryKmMs;
        lastTs = f.ts;
        paceSamples.push([walked, f.ts]);
      }

      // ゆっくり歩いているとき（測位どうしが12m未満）だけ、指数移動平均で軽くなめらかにする。
      // 速いとき・測位が途切れたあとは、遅れが出ないようそのまま使う。
      if (!smooth || moved > 30) {
        smooth = { lat: f.lat, lng: f.lng };
      } else {
        var alpha = Math.min(1, Math.max(SMOOTH_MIN_ALPHA, moved / 12));
        smooth = { lat: smooth.lat + alpha * (f.lat - smooth.lat), lng: smooth.lng + alpha * (f.lng - smooth.lng) };
      }
      if (!lastPt) {
        lastPt = { lat: smooth.lat, lng: smooth.lng };
        track.push([smooth.lat, smooth.lng]);
      } else {
        var thr = Math.max(MIN_STEP_M, Math.min(f.accuracy * 0.5, MAX_STEP_M));
        var d = hav(lastPt.lat, lastPt.lng, smooth.lat, smooth.lng);
        if (d > thr) {
          var walkedBefore = walked, tPrev = lastTs;
          walked += d;
          lastPt = { lat: smooth.lat, lng: smooth.lng };
          track.push([smooth.lat, smooth.lng]);
          lastTs = f.ts;
          paceSamples.push([walked, f.ts]);
          // 1km ごとの記録（またいだ位置の時刻は、前の点との間で割り算して求める）
          while (walked >= (splits.length + 1) * 1000) {
            var km = splits.length + 1;
            var frac = Math.min(1, Math.max(0, (km * 1000 - walkedBefore) / d));
            var tc = tPrev + frac * (f.ts - tPrev);
            splits.push({ km: km, durationMs: Math.max(0, Math.round(tc - splitT0)) });
            splitT0 = tc;
          }
        }
      }
      var prevRef = ref, pBefore = progress;
      ref = { lat: f.lat, lng: f.lng, ts: f.ts, accuracy: f.accuracy };
      updateRoute(f.lat, f.lng, f.accuracy, moved);
      if (!replaced && org.n >= 2) {
        markCoverage(
          prevRef ? { x: (prevRef.lng - org.lng0) * org.kx, y: (prevRef.lat - org.lat0) * org.ky } : null,
          { x: (f.lng - org.lng0) * org.kx, y: (f.lat - org.lat0) * org.ky },
          prevRef ? Math.max(f.accuracy, num(prevRef.accuracy, 0)) : f.accuracy,
          pBefore - WINDOW_BACK_M, progress + 30);
      }

      if (!reached && goalNear(f)) reached = true;
    }

    // ---- エラーを日本語に ----
    function onGeoError(err) {
      var code = err && err.code;
      var msg;
      if (code === 1) {
        msg = '位置情報の利用が許可されていません。ブラウザの設定で、このサイトの位置情報を「許可」にしてから、もう一度開いてください。';
      } else if (code === 2) {
        msg = '現在地を取得できません。電波の入りやすい場所に移動してください。';
      } else if (code === 3) {
        msg = '現在地がなかなか取れません。空が見える場所に移動してください。このまま探し続けます。';
      } else {
        msg = '位置情報でうまくいかないことがありました。このまま探し続けます。';
      }
      try { onError(msg); } catch (e) { /* 無視 */ }
    }

    // ---- 画面を点けたままにする（Wake Lock） ----
    function acquireWake() {
      try {
        if (stopped || wakeLock || wakeBusy) return;
        if (typeof navigator === 'undefined' || !navigator.wakeLock || !navigator.wakeLock.request) return;
        wakeBusy = true;
        navigator.wakeLock.request('screen').then(function (lock) {
          wakeBusy = false;
          if (stopped) { try { lock.release(); } catch (e) {} return; }
          wakeLock = lock;
          try {
            lock.addEventListener('release', function () { if (wakeLock === lock) wakeLock = null; });
          } catch (e) {}
        }, function () { wakeBusy = false; });
      } catch (e) { wakeBusy = false; }
    }

    function releaseWake() {
      try {
        var l = wakeLock;
        wakeLock = null;
        if (l && l.release) { var r = l.release(); if (r && r.catch) r.catch(function () {}); }
      } catch (e) { /* 無視 */ }
    }

    function onVisibility() {
      if (typeof document === 'undefined' || stopped) return;
      if (document.visibilityState === 'visible') {
        var now = Date.now();
        var before = screenOff.totalMs;
        markAlive();
        // タイマーが止まらないブラウザでも、隠れていた時間が15秒以上なら数える
        if (hiddenAt !== null && now - hiddenAt >= SCREEN_GAP_MS && screenOff.totalMs === before) {
          addGap(now - hiddenAt, now);
        }
        hiddenAt = null;
        acquireWake();
        emit();
      } else {
        hiddenAt = Date.now();
        saveActive();
      }
    }

    function onPageHide() { saveActive(); }

    function onTick() {
      if (stopped) return;
      markAlive();
      if (Date.now() - lastSaveAt >= AUTOSAVE_MS) saveActive();
      emit();
    }

    // ---- 近道に切りかえる ----
    function replaceRoute(newRoute, newGoal) {
      if (stopped || !newRoute || !Array.isArray(newRoute.coords)) return;
      var g = buildGeom(newRoute.coords);
      if (g.n < 1) return;
      if (!replaced) covFrozen = progress; // 歩いた区間の物差しは元のルートのまま、ここで止める
      replaced = true;
      routeCur = newRoute;
      cur = g;
      turns = cleanTurns(newRoute);
      goal = goalFrom(newGoal, g);
      progress = 0;
      offWalk = 0;
      fallback = null;
      offRoute = 0;
      isOff = false;
      if (position && !gpsWeak) updateRoute(position.lat, position.lng, position.accuracy, 0);
      saveActive();
      emit();
    }

    // ---- start / stop ----
    function start() {
      if (started || stopped) return;
      started = true;
      if (resume && isFinite(Date.parse(resume.startedAt))) {
        // startedAt は記録の日付用に元のまま。経過時間は「保存時点までの歩いた時間」から数え直す
        // （アプリを閉じていた間は経過時間にも、画面が消えていた時間にも入れない）。
        startedIso = resume.startedAt;
        startedMs = isFinite(resume.elapsedMs) ? Date.now() - Math.max(0, resume.elapsedMs)
          : num(resume.startedMs, Date.parse(resume.startedAt));
      } else {
        startedMs = Date.now();
        startedIso = new Date(startedMs).toISOString();
      }
      aliveAt = Date.now();

      if (!geo || typeof geo.watchPosition !== 'function') {
        try { onError('この端末・ブラウザでは位置情報を使えません。'); } catch (e) {}
      } else {
        try {
          watchId = geo.watchPosition(onPosition, onGeoError,
            { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
        } catch (e) {
          try { onError('位置情報を使い始められませんでした。ブラウザの設定を確認してください。'); } catch (e2) {}
        }
      }
      tickTimer = setInterval(onTick, TICK_MS);
      acquireWake();
      try {
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
        window.addEventListener('pagehide', onPageHide);
      } catch (e) {}
      lastSaveAt = Date.now();
      emit();
    }

    function stop() {
      if (summary) return summary;
      var now = Date.now();
      if (!started) { startedMs = now; startedIso = new Date(now).toISOString(); }
      stopped = true;
      if (watchId !== null && geo && typeof geo.clearWatch === 'function') {
        try { geo.clearWatch(watchId); } catch (e) {}
      }
      watchId = null;
      if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
      try {
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('pagehide', onPageHide);
      } catch (e) {}
      releaseWake();
      if (started) clearActive();

      var walkedRounded = Math.round(walked);
      summary = {
        startedAt: startedIso,
        endedAt: new Date(now).toISOString(),
        durationMs: now - startedMs,
        walkedMeters: walkedRounded,
        steps: Math.round(walkedRounded / strideM),
        plannedMeters: num(routeOrg.distanceMeters, org.len),
        goalType: goalType,
        reachedGoal: reached,
        coverageRatio: Math.round(coverageState().ratio * 1000) / 1000,
        screenOffMs: screenOff.totalMs,
        splits: splits.map(function (s) { return { km: s.km, durationMs: s.durationMs }; }),
        avgPaceSecPerKm: avgPace(),
        usedShortcut: replaced,
        routeCoords: org.pts.map(function (p) { return [p[0], p[1]]; }),
        trackCoords: track.slice()
      };
      return summary;
    }

    return { start: start, stop: stop, replaceRoute: replaceRoute };
  }

  // ---------------------------------------------------------------
  // simulateGeolocation — 歩いているふりをする geolocation
  //   coords の上を speedMps で進み、intervalMs ごとに測位を返す。終点に着いたらそこに止まり続ける。
  //   virtualIntervalMs（既定は intervalMs）：1回ごとに進む「仮想の時間」。タイムスタンプと
  //   進む距離はこちらで決まるので、intervalMs を短くしてテストを速く回せる。
  //   noiseM：ぶれ（標準偏差 m）。seed を渡すと同じ乱数になる。
  // ---------------------------------------------------------------
  function simulateGeolocation(coords, o) {
    o = o || {};
    var speedMps = num(o.speedMps, 1.4);
    var intervalMs = Math.max(1, num(o.intervalMs, 1000));
    var virtualMs = Math.max(1, num(o.virtualIntervalMs, intervalMs));
    var noiseM = Math.max(0, num(o.noiseM, 0));
    var pts = (coords || []).filter(function (p) { return p && isFinite(p[0]) && isFinite(p[1]); });

    var seed = (o.seed === undefined ? Math.floor(Math.random() * 4294967296) : o.seed) >>> 0;
    function rand() { // mulberry32
      seed = (seed + 0x6D2B79F5) >>> 0;
      var t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    function gauss() {
      var u = Math.max(1e-12, rand()), v = rand();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }

    var cum = [0];
    for (var i = 1; i < pts.length; i++) {
      cum.push(cum[i - 1] + hav(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
    }
    var total = pts.length ? cum[pts.length - 1] : 0;

    function at(s) {
      if (!pts.length) return [0, 0];
      if (s <= 0 || pts.length === 1) return pts[0];
      if (s >= total) return pts[pts.length - 1];
      var lo = 0, hi = pts.length - 1;
      while (hi - lo > 1) {
        var mid = (lo + hi) >> 1;
        if (cum[mid] <= s) lo = mid; else hi = mid;
      }
      var seg = cum[hi] - cum[lo];
      var t = seg > 0 ? (s - cum[lo]) / seg : 0;
      return [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * t, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * t];
    }

    var watchers = {};
    var nextId = 1;

    function watchPosition(success, error, wopts) {
      var id = nextId++;
      var k = 0;
      var base = Date.now();
      function tick() {
        var s = speedMps * (virtualMs / 1000) * k;
        var p = at(s);
        var lat = p[0], lng = p[1];
        if (noiseM > 0) {
          lat += gauss() * noiseM / (R * RAD);
          lng += gauss() * noiseM / (R * RAD * Math.cos(p[0] * RAD));
        }
        var acc = Math.max(5 + rand() * 5, noiseM * 3);
        var ts = base + k * virtualMs;
        k++;
        try {
          success({
            coords: {
              latitude: lat, longitude: lng, accuracy: acc,
              altitude: null, altitudeAccuracy: null, heading: null,
              speed: s < total ? speedMps : 0
            },
            timestamp: ts
          });
        } catch (e) { /* 呼び出し側のエラーでシミュレーターを止めない */ }
      }
      var first = setTimeout(function () {
        tick();
        if (watchers[id] !== undefined) watchers[id] = setInterval(tick, intervalMs);
      }, 0);
      watchers[id] = first;
      return id;
    }

    function clearWatch(id) {
      if (watchers[id] !== undefined) {
        clearTimeout(watchers[id]);
        clearInterval(watchers[id]);
        delete watchers[id];
      }
    }

    return {
      watchPosition: watchPosition,
      clearWatch: clearWatch,
      simulatedSpeedMps: speedMps // WalkTracker が速度チェックを緩めるための目印
    };
  }

  window.WalkTracker = {
    create: create,
    simulateGeolocation: simulateGeolocation,
    loadActive: loadActive,
    clearActive: clearActive
  };
})();
