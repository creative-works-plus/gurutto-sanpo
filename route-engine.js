/*
 * route-engine.js — ぐるっとさんぽ：ルート計算エンジン
 *
 * 使い方（設計メモ.md「route-engine.js — RouteEngine」どおり）
 *   const result = await RouteEngine.generateRoutes({ start, goal, targetMeters, count, variant, onProgress, onRoute, signal });
 *   result = { routes: Route[], noticeJa: string|null }
 *   const route = await RouteEngine.routeBetween(from, to, { signal });  // 「近道で帰る」用の最短ルート 1 本
 *
 * ・普通の <script> で読み込む。グローバルには window.RouteEngine だけを出す
 * ・ほかのファイルや Leaflet には頼らない
 * ・道のデータは OSRM（徒歩）。RouteEngine.config.osrmBaseUrl を変えれば別のサービスに差し替えられる
 * ・OSRM への問い合わせは 1 秒に 1 回まで（エンジンの中で必ず間を空ける）
 *
 * 仕組み（ざっくり）
 *   Route.turns（曲がり角）は OSRM の steps と道すじの角度から作る（下の「曲がり角」の節）。
 *   出発地点（とゴール）を通る「円（または円弧）」を考え、その上に 3〜6 個の経由地点を置いて
 *   OSRM に「出発→経由→…→ゴール」の道を聞く。返ってきた道の長さを測り、円の大きさを
 *   直してもう一度聞く（1 本あたり最大 4 回）。目標の ±5% に入ったら採用、±10% を外れたら捨てる。
 *   3 本は円の向きを 120° ずつ変えて作るので、見た目にちがう形になる。
 */
(function (global) {
  'use strict';

  // ------------------------------------------------------------------
  // 設定（ここだけ変えれば差し替えられる）
  // ------------------------------------------------------------------
  var config = {
    osrmBaseUrl: 'https://routing.openstreetmap.de/routed-foot', // ルート計算サービスの場所
    osrmProfile: 'foot',
    minIntervalMs: 1050,          // 問い合わせの間隔（1 秒に 1 回の決まりを守る）
    requestTimeoutMs: 20000,      // 1 回の問い合わせの待ち時間の上限
    continueStraight: false,      // true にすると経由地点で引き返す道を禁止する（検証の結果 false の方が良かった）
    maxCallsPerCandidate: 4,      // 1 本のルートを作るのに使う問い合わせの上限
    callsPerRoute: 5,             // 全体の問い合わせ予算 = callsPerRoute × 本数 (+1)
    maxSnapMeters: 300,           // 経由地点が道からこれ以上離れていたら（海・山の中）やり直す
    maxStartSnapMeters: 400,      // 出発地点が道からこれ以上離れていたら「近くに道がない」
    goodTolerance: 0.05,          // これ以内に入ったらすぐ採用
    maxTolerance: 0.10,           // これを外れた候補は出さない
    initialDetour: 1.3,           // 「道の長さ ÷ 図形の長さ」の最初の見込み
    maxPairOverlap: 0.6,          // ほかのルートとこれ以上重なっていたら別の向きでやり直す
    nearGoalMeters: 150,          // ゴールが出発地点からこれより近ければ「一周ルート」と同じ扱い
    shortestFactor: 1.05,         // 目標距離 < 最短距離 × これ なら最短ルートだけを返す
    turnSteps: true,              // OSRM に曲がり角の情報（steps）も頼む（false なら道すじの形だけから曲がり角を推定）
    turnMinDeg: 25,               // これより小さい角度は「曲がる」とみなさない
    turnMergeMeters: 25,          // これより近い曲がり角はひとつにまとめる（鋭角の交差点を横切る 2 回の曲がりを 1 つにする）
    turnLookMeters: 20,           // 曲がり角の前後この距離の向きで角度を測る（1.5 倍の距離でも同じ向きに曲がっていることを求める）
    turnSlightMergeMeters: 40,    // 「ななめ」が続くときは、この距離以内なら正味の角度でひとつにまとめる（小さければ捨てる）
    nearSpurWidthMeters: 15,      // 行きと帰りがこの距離以内で寄り添う往復（別の線で描かれた歩道など）は切り落とす
    nearSpurMaxMeters: 150        // 切り落とす往復の長さの上限
  };

  var limits = { minMeters: 500, maxMeters: 30000 };

  var DEG = Math.PI / 180;
  var EARTH_R = 6371008.8;

  // ------------------------------------------------------------------
  // エラー
  // ------------------------------------------------------------------
  function RouteError(messageJa, code, detail) {
    var base = Error.call(this, messageJa);
    this.name = 'RouteError';
    this.message = messageJa;
    this.messageJa = messageJa;
    this.code = code || 'unknown';
    if (detail !== undefined) this.detail = detail;
    if (base && base.stack) this.stack = base.stack;
  }
  RouteError.prototype = Object.create(Error.prototype);
  RouteError.prototype.constructor = RouteError;

  function makeAbortError() {
    var e;
    try {
      e = new DOMException('中止しました', 'AbortError');
    } catch (_) {
      e = new Error('中止しました');
      e.name = 'AbortError';
    }
    return e;
  }

  function throwIfAborted(signal) {
    if (signal && signal.aborted) throw makeAbortError();
  }

  // ------------------------------------------------------------------
  // 小さな道具
  // ------------------------------------------------------------------
  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function isLatLng(p) {
    return !!p && isNum(p.lat) && isNum(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
  }
  function formatKm(m) {
    var km = Math.round(m / 100) / 10;
    return (km % 1 === 0 ? String(km) : km.toFixed(1)) + 'km';
  }

  function sleep(ms, signal) {
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) { reject(makeAbortError()); return; }
      var timer = setTimeout(function () {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      function onAbort() {
        clearTimeout(timer);
        reject(makeAbortError());
      }
      if (signal) signal.addEventListener('abort', onAbort);
    });
  }

  // ------------------------------------------------------------------
  // 地理計算（緯度経度 ⇄ メートルの平面）
  // ------------------------------------------------------------------
  function haversine(a, b) { // a, b = [lat, lng]
    var dLat = (b[0] - a[0]) * DEG;
    var dLng = (b[1] - a[1]) * DEG;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a[0] * DEG) * Math.cos(b[0] * DEG) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function pathLength(coords) {
    var d = 0;
    for (var i = 1; i < coords.length; i++) d += haversine(coords[i - 1], coords[i]);
    return d;
  }

  // 出発地点を原点にした「メートルの平面」（x = 東, y = 北）
  function Frame(origin) {
    this.lat0 = origin.lat;
    this.lng0 = origin.lng;
    this.mx = 111320 * Math.cos(origin.lat * DEG);
    this.my = 110574;
  }
  Frame.prototype.toXY = function (p) {
    return { x: (p.lng - this.lng0) * this.mx, y: (p.lat - this.lat0) * this.my };
  };
  Frame.prototype.toLL = function (q) {
    return { lat: this.lat0 + q.y / this.my, lng: this.lng0 + q.x / this.mx };
  };
  Frame.prototype.coordsToXY = function (coords) {
    var out = [];
    for (var i = 0; i < coords.length; i++) out.push(this.toXY({ lat: coords[i][0], lng: coords[i][1] }));
    return out;
  };

  function hypot(x, y) { return Math.sqrt(x * x + y * y); }
  function norm2pi(a) { a = a % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a; }

  // ------------------------------------------------------------------
  // 行って戻るだけの「とげ」を取る
  //   OSRM は経由地点が行き止まりに落ちると A→B→C→B→A のように同じ道を往復する。
  //   「新しい点が 2 つ前の点と同じなら、1 つ前の点を消す」を繰り返すと往復が消える。
  // ------------------------------------------------------------------
  function samePt(a, b) {
    return Math.abs(a[0] - b[0]) < 1.5e-6 && Math.abs(a[1] - b[1]) < 1.5e-6;
  }
  function removeSpurs(coords) {
    var st = [];
    for (var i = 0; i < coords.length; i++) {
      var p = coords[i];
      if (st.length && samePt(st[st.length - 1], p)) continue;      // 同じ点の連続
      if (st.length >= 2 && samePt(st[st.length - 2], p)) { st.pop(); continue; } // 引き返し
      st.push(p);
    }
    return st;
  }

  // 「ほぼ往復」の切り落とし
  //   歩道が道の両側で別の線になっている所では、行きと帰りの座標が一致せず removeSpurs で消えない。
  //   区間 i..j（20〜150m）で、始点と終点が 15m 以内、かつ行き（i..先端）と帰り（先端..j）が互いに 15m 以内で
  //   寄り添っていれば、その区間を i→j の 1 本に置き換える
  function pointSegDist(p, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var l2 = dx * dx + dy * dy;
    var t = l2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
    t = clamp(t, 0, 1);
    return hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
  }
  function pointPolyDist(p, xy, from, to) { // 頂点 from..to の折れ線までの距離
    if (to <= from) return hypot(p.x - xy[from].x, p.y - xy[from].y);
    var best = Infinity;
    for (var k = from; k < to; k++) {
      var d = pointSegDist(p, xy[k], xy[k + 1]);
      if (d < best) best = d;
    }
    return best;
  }
  function isThinExcursion(xy, i, j, w) {
    var tip = i, far = -1;
    for (var k = i + 1; k < j; k++) {
      var d = hypot(xy[k].x - xy[i].x, xy[k].y - xy[i].y);
      if (d > far) { far = d; tip = k; }
    }
    if (tip <= i || tip >= j) return false;
    for (k = i; k <= tip; k++) if (pointPolyDist(xy[k], xy, tip, j) > w) return false;
    for (k = tip; k <= j; k++) if (pointPolyDist(xy[k], xy, i, tip) > w) return false;
    return true;
  }
  function removeNearSpurs(coords) {
    if (coords.length < 4) return coords;
    var w = config.nearSpurWidthMeters, maxLen = config.nearSpurMaxMeters, minLen = 20;
    var frame = new Frame({ lat: coords[0][0], lng: coords[0][1] });
    var xy = frame.coordsToXY(coords);
    var n = xy.length, i, k;
    var cum = [0];
    for (k = 1; k < n; k++) cum.push(cum[k - 1] + hypot(xy[k].x - xy[k - 1].x, xy[k].y - xy[k - 1].y));
    var keep = [];
    i = 0;
    while (i < n) {
      keep.push(i);
      var found = -1;
      for (var j = i + 2; j < n; j++) {
        var len = cum[j] - cum[i];
        if (len > maxLen) break;
        if (len < minLen) continue;
        if (hypot(xy[j].x - xy[i].x, xy[j].y - xy[i].y) > w) continue;
        if (isThinExcursion(xy, i, j, w)) found = j; // 一番長い往復を採る
      }
      i = found > 0 ? found : i + 1;
    }
    if (keep.length === n) return coords;
    var out = [];
    for (k = 0; k < keep.length; k++) out.push(coords[keep[k]]);
    return out;
  }
  function cleanGeometry(coords) {
    var c = removeSpurs(coords);
    c = removeNearSpurs(c);
    c = removeNearSpurs(c); // 入れ子になった往復のために 2 回
    return c;
  }

  // ------------------------------------------------------------------
  // 重なりの測り方（10m ごとに点を打ち、近くに前の点があれば「同じ道をもう一度歩いた」とみなす）
  // ------------------------------------------------------------------
  function resampleXY(xy, step) {
    var out = [];
    if (!xy.length) return out;
    out.push({ x: xy[0].x, y: xy[0].y });
    var carry = 0;
    for (var i = 1; i < xy.length; i++) {
      var a = xy[i - 1], b = xy[i];
      var seg = hypot(b.x - a.x, b.y - a.y);
      if (seg === 0) continue;
      var pos = step - carry;
      while (pos <= seg) {
        var t = pos / seg;
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        pos += step;
      }
      carry = seg - (pos - step);
    }
    return out;
  }

  function Grid(cell) { this.cell = cell; this.map = {}; }
  Grid.prototype.key = function (cx, cy) { return cx + ',' + cy; };
  Grid.prototype.add = function (p, idx) {
    var cx = Math.floor(p.x / this.cell), cy = Math.floor(p.y / this.cell);
    var k = this.key(cx, cy);
    (this.map[k] || (this.map[k] = [])).push({ x: p.x, y: p.y, i: idx });
  };
  Grid.prototype.near = function (p, radius, maxIdx) { // maxIdx 以下の番号の点だけを見る
    var cx = Math.floor(p.x / this.cell), cy = Math.floor(p.y / this.cell);
    for (var dx = -1; dx <= 1; dx++) {
      for (var dy = -1; dy <= 1; dy++) {
        var list = this.map[this.key(cx + dx, cy + dy)];
        if (!list) continue;
        for (var j = 0; j < list.length; j++) {
          var q = list[j];
          if (maxIdx !== undefined && q.i > maxIdx) continue;
          if (hypot(q.x - p.x, q.y - p.y) <= radius) return true;
        }
      }
    }
    return false;
  };

  var OV_STEP = 10, OV_RADIUS = 12, OV_SKIP = 8;

  function selfOverlapXY(xy) {
    var pts = resampleXY(xy, OV_STEP);
    if (pts.length < 2) return 0;
    var grid = new Grid(OV_RADIUS);
    var hits = 0;
    for (var i = 0; i < pts.length; i++) {
      if (i > OV_SKIP && grid.near(pts[i], OV_RADIUS, i - OV_SKIP - 1)) hits++;
      grid.add(pts[i], i);
    }
    return hits / pts.length;
  }

  function pairOverlapXY(xyA, xyB) { // B のうち A の近くを通る割合
    var a = resampleXY(xyA, OV_STEP), b = resampleXY(xyB, OV_STEP);
    if (!a.length || !b.length) return 0;
    var grid = new Grid(OV_RADIUS);
    for (var i = 0; i < a.length; i++) grid.add(a[i], i);
    var hits = 0;
    for (var j = 0; j < b.length; j++) if (grid.near(b[j], OV_RADIUS)) hits++;
    return hits / b.length;
  }

  function selfOverlapRatio(coords) {
    if (!coords || coords.length < 2) return 0;
    var f = new Frame({ lat: coords[0][0], lng: coords[0][1] });
    return selfOverlapXY(f.coordsToXY(coords));
  }
  function pairOverlapRatio(coordsA, coordsB) {
    if (!coordsA || !coordsB || coordsA.length < 2 || coordsB.length < 2) return 0;
    var f = new Frame({ lat: coordsA[0][0], lng: coordsA[0][1] });
    return pairOverlapXY(f.coordsToXY(coordsA), f.coordsToXY(coordsB));
  }

  // ------------------------------------------------------------------
  // 図形（出発地点とゴールを通る円・円弧）の上に経由地点を置く
  //   geom: { loop, S, H, M, c, u, v }   S は原点
  //   cand: { theta, dir, side, stretch, phase }
  //     theta   : 一周ルートで、出発地点から見た円の中心の方角（北 0、時計まわり、ラジアン）
  //     dir     : 一周ルートで、まわる向き（+1 / -1）
  //     side    : ゴールありで、出発→ゴールの線のどちら側にふくらむか（+1 / -1）
  //     stretch : ふくらみ方向の伸び縮み（1 = 円、>1 = 細長い、<1 = 平たい）
  //     phase   : 経由地点の位置ずらし（-0.3〜0.3）
  // ------------------------------------------------------------------
  function shapeVias(geom, cand, k, nVia) {
    var pts = [], i, t, ang, px, py, du, dv;
    if (geom.loop) {
      var ux = Math.sin(cand.theta), uy = Math.cos(cand.theta); // 出発地点→中心
      var vx = -uy, vy = ux;
      var C = { x: k * ux, y: k * uy };
      var a0 = Math.atan2(-uy, -ux); // 中心から見た出発地点の角度
      for (i = 0; i < nVia; i++) {
        t = (i + 1 + cand.phase) / (nVia + 1);
        ang = a0 + cand.dir * 2 * Math.PI * t;
        px = C.x + k * Math.cos(ang);
        py = C.y + k * Math.sin(ang);
        du = px * ux + py * uy;
        dv = (px * vx + py * vy) * cand.stretch;
        pts.push({ x: du * ux + dv * vx, y: du * uy + dv * vy });
      }
    } else {
      var v = { x: geom.v.x * cand.side, y: geom.v.y * cand.side };
      var u = geom.u, M = geom.M;
      var Cg = { x: M.x + k * v.x, y: M.y + k * v.y };
      var R = Math.sqrt(geom.c * geom.c + k * k);
      var aS = Math.atan2(geom.S.y - Cg.y, geom.S.x - Cg.x);
      var aH = Math.atan2(geom.H.y - Cg.y, geom.H.x - Cg.x);
      var aV = Math.atan2(v.y, v.x);
      var ccw = norm2pi(aH - aS);
      var sweep = (norm2pi(aV - aS) < ccw) ? ccw : ccw - 2 * Math.PI; // +v 側を通る向き
      for (i = 0; i < nVia; i++) {
        t = (i + 1 + cand.phase) / (nVia + 1);
        ang = aS + sweep * t;
        px = Cg.x + R * Math.cos(ang) - M.x;
        py = Cg.y + R * Math.sin(ang) - M.y;
        du = px * u.x + py * u.y;
        dv = (px * v.x + py * v.y) * cand.stretch;
        pts.push({ x: M.x + du * u.x + dv * v.x, y: M.y + du * u.y + dv * v.y });
      }
    }
    return pts;
  }

  function chordLength(geom, vias) {
    var pts = [geom.S].concat(vias, [geom.loop ? geom.S : geom.H]);
    var d = 0;
    for (var i = 1; i < pts.length; i++) d += hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    return d;
  }

  // 図形の折れ線の長さが chordTarget になる k を二分探索で求める
  function solveK(geom, cand, nVia, chordTarget) {
    var f = function (k) { return chordLength(geom, shapeVias(geom, cand, k, nVia)); };
    var lo, hi;
    if (geom.loop) { lo = 30; hi = Math.max(chordTarget, 100); }
    else { lo = -chordTarget * 20; hi = Math.max(chordTarget, 100); }
    var guard = 0;
    while (f(hi) < chordTarget && guard++ < 30) hi *= 2;
    if (f(lo) >= chordTarget) return lo;
    for (var i = 0; i < 60; i++) {
      var mid = (lo + hi) / 2;
      if (f(mid) < chordTarget) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  // ------------------------------------------------------------------
  // OSRM への問い合わせ（1 秒に 1 回の間を必ず空ける）
  // ------------------------------------------------------------------
  var lastRequestAt = 0;
  var chain = Promise.resolve();

  function throttled(fn, signal) {
    var p = chain.then(function () {
      var wait = lastRequestAt + config.minIntervalMs - Date.now();
      return (wait > 0 ? sleep(wait, signal) : Promise.resolve()).then(function () {
        throwIfAborted(signal);
        lastRequestAt = Date.now();
        return fn();
      });
    });
    chain = p.then(function () {}, function () {});
    return p;
  }

  function buildUrl(points) {
    var parts = [];
    for (var i = 0; i < points.length; i++) {
      parts.push(points[i].lng.toFixed(6) + ',' + points[i].lat.toFixed(6));
    }
    var url = config.osrmBaseUrl.replace(/\/+$/, '') + '/route/v1/' + config.osrmProfile + '/' +
      parts.join(';') + '?overview=full&geometries=geojson';
    if (config.continueStraight) url += '&continue_straight=true';
    if (config.turnSteps) url += '&steps=true';
    return url;
  }

  // 戻り値: { ok, code, distance, coords:[[lat,lng]], snaps:[m], raw }
  function osrmRoute(ctx, points) {
    var signal = ctx.signal;
    return throttled(function () {
      ctx.stats.osrmCalls++;
      var ac = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var timedOut = false;
      var timer = setTimeout(function () { timedOut = true; if (ac) ac.abort(); }, config.requestTimeoutMs);
      function onAbort() { if (ac) ac.abort(); }
      if (signal) signal.addEventListener('abort', onAbort);
      var init = ac ? { signal: ac.signal } : {};
      return fetch(buildUrl(points), init).then(function (res) {
        if (!res.ok) {
          if (res.status === 429 || res.status >= 500) {
            throw new RouteError('ルートを計算するサービスが混み合っています。少し待ってからもう一度お試しください。', 'busy', res.status);
          }
          return res.json().then(function (body) { return body; }, function () {
            throw new RouteError('ルートを計算するサービスから返事がありませんでした。もう一度お試しください。', 'network', res.status);
          });
        }
        return res.json();
      }).then(function (body) {
        var out = { ok: body && body.code === 'Ok', code: body ? body.code : 'NoResponse', raw: body };
        if (out.ok) {
          var r = body.routes[0];
          var coords = [];
          var g = r.geometry.coordinates;
          for (var i = 0; i < g.length; i++) coords.push([g[i][1], g[i][0]]);
          out.coords = cleanGeometry(coords);
          out.distance = pathLength(out.coords);
          out.turns = buildTurns(out.coords, turnCandidates(r));
          out.osrmDistance = r.distance;
          out.snaps = [];
          for (var j = 0; j < body.waypoints.length; j++) out.snaps.push(body.waypoints[j].distance || 0);
        }
        return out;
      }).catch(function (err) {
        if (err instanceof RouteError) throw err;
        if (signal && signal.aborted) throw makeAbortError();
        if (timedOut) throw new RouteError('ルートの計算に時間がかかりすぎました。電波のよい場所でもう一度お試しください。', 'timeout');
        throw new RouteError('インターネットにつながりません。電波のよい場所でもう一度お試しください。', 'network', String(err && err.message));
      }).then(function (v) {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        return v;
      }, function (err) {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        throw err;
      });
    }, signal);
  }

  // ------------------------------------------------------------------
  // 曲がり角（Route.turns）
  //   OSRM の steps（曲がる指示と交差点の位置）を「曲がり角の候補」にし、とげを取ったあとの道すじで
  //   前後 20m の向きの差を測って、本当に曲がっている所だけを残す。steps がなければ道すじの頂点を候補にする
  // ------------------------------------------------------------------
  function bearingDeg(a, b) { // [lat,lng] → 北 0、時計まわり
    var dLng = (b[1] - a[1]) * DEG;
    var y = Math.sin(dLng) * Math.cos(b[0] * DEG);
    var x = Math.cos(a[0] * DEG) * Math.sin(b[0] * DEG) - Math.sin(a[0] * DEG) * Math.cos(b[0] * DEG) * Math.cos(dLng);
    var br = Math.atan2(y, x) / DEG;
    return br < 0 ? br + 360 : br;
  }
  function turnAngle(before, after) { // -180〜180、右まわりが正
    var a = (after - before) % 360;
    if (a > 180) a -= 360;
    if (a <= -180) a += 360;
    return a;
  }
  function ptKey(lat, lng, digits) {
    var m = Math.pow(10, digits);
    return Math.round(lat * m) + ',' + Math.round(lng * m);
  }

  // OSRM の route から曲がり角の候補（[lat,lng] の配列）を集める
  function turnCandidates(osrmRouteObj) {
    var out = [];
    if (!osrmRouteObj || !osrmRouteObj.legs) return null;
    var seen = {};
    function add(loc) {
      if (!loc || loc.length < 2) return;
      var k = ptKey(loc[1], loc[0], 6);
      if (seen[k]) return;
      seen[k] = true;
      out.push([loc[1], loc[0]]);
    }
    var any = false;
    for (var i = 0; i < osrmRouteObj.legs.length; i++) {
      var steps = osrmRouteObj.legs[i].steps;
      if (!steps) continue;
      for (var j = 0; j < steps.length; j++) {
        any = true;
        var st = steps[j];
        var m = st.maneuver;
        if (m && m.type !== 'depart' && m.type !== 'arrive') add(m.location);
        var ints = st.intersections || [];
        for (var q = 0; q < ints.length; q++) add(ints[q].location);
      }
    }
    return any ? out : null;
  }

  var TURN_TEXT = {
    'left': '左に曲がる', 'right': '右に曲がる',
    'slight-left': 'ななめ左へ', 'slight-right': 'ななめ右へ',
    'sharp-left': '大きく左に曲がる', 'sharp-right': '大きく右に曲がる',
    'uturn': '引き返す'
  };
  function classifyTurn(angle) {
    var a = Math.abs(angle);
    if (a < config.turnMinDeg) return null;
    if (a > 165) return 'uturn';
    var side = angle > 0 ? 'right' : 'left';
    if (a < 60) return 'slight-' + side;
    if (a <= 135) return side;
    return 'sharp-' + side;
  }

  // coords: とげを取ったあとの道すじ、candidates: 候補の [lat,lng]（null なら頂点すべてを候補にする）
  function buildTurns(coords, candidates) {
    var n = coords.length;
    if (n < 3) return [];
    var cum = [0];
    for (var i = 1; i < n; i++) cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]));
    var total = cum[n - 1];
    if (total <= 0) return [];

    // 道すじ上の距離 s にある点
    function pointAt(s) {
      if (s <= 0) return coords[0];
      if (s >= total) return coords[n - 1];
      var lo = 0, hi = n - 1;
      while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
      var seg = cum[hi] - cum[lo];
      var t = seg > 0 ? (s - cum[lo]) / seg : 0;
      return [coords[lo][0] + (coords[hi][0] - coords[lo][0]) * t, coords[lo][1] + (coords[hi][1] - coords[lo][1]) * t];
    }
    function angleAround(s0, s1, look) { // s0 の look 手前 → s0、s1 → s1 の look 先 の向きの差
      var b1 = bearingDeg(pointAt(Math.max(0, s0 - look)), pointAt(s0));
      var b2 = bearingDeg(pointAt(s1), pointAt(Math.min(total, s1 + look)));
      return turnAngle(b1, b2);
    }

    // 候補を道すじの頂点に対応づける（とげの中にあった候補は見つからないので捨てる）
    var idxs = [];
    if (candidates) {
      var map6 = {}, map5 = {};
      for (i = 1; i < n - 1; i++) {
        map6[ptKey(coords[i][0], coords[i][1], 6)] = i;
        var k5 = ptKey(coords[i][0], coords[i][1], 5);
        if (map5[k5] === undefined) map5[k5] = i;
      }
      var used = {};
      for (i = 0; i < candidates.length; i++) {
        var c = candidates[i];
        var ix = map6[ptKey(c[0], c[1], 6)];
        if (ix === undefined) ix = map5[ptKey(c[0], c[1], 5)];
        if (ix === undefined || used[ix]) continue;
        used[ix] = true;
        idxs.push(ix);
      }
    } else {
      for (i = 1; i < n - 1; i++) idxs.push(i);
    }
    idxs.sort(function (a, b) { return a - b; });

    // 頂点ごとの角度（まとめるときに一番曲がっている頂点を場所にする）
    function vertexAngle(ix) {
      return turnAngle(bearingDeg(coords[ix - 1], coords[ix]), bearingDeg(coords[ix], coords[ix + 1]));
    }

    // 近い候補はひとつにまとめ、前後 20m の向きの差で判定する
    var turns = [];
    var g = 0;
    while (g < idxs.length) {
      var h = g;
      while (h + 1 < idxs.length && cum[idxs[h + 1]] - cum[idxs[h]] <= config.turnMergeMeters) h++;
      var s0 = cum[idxs[g]], s1 = cum[idxs[h]];
      if (s0 > 5 && s1 < total - 5) {
        // 20m 基準と 30m 基準の両方で同じ向きに曲がっているときだけ「曲がり角」（短いジグザグを無視する）
        var look = config.turnLookMeters;
        var aShort = angleAround(s0, s1, look), aLong = angleAround(s0, s1, look * 1.5);
        var angle = (aShort + aLong) / 2;
        var dir = (classifyTurn(aShort) && classifyTurn(aLong) && (aShort > 0) === (aLong > 0)) ? classifyTurn(angle) : null;
        if (dir) {
          var bestIx = idxs[g], bestA = -1;
          for (var q = g; q <= h; q++) {
            var va = Math.abs(vertexAngle(idxs[q]));
            if (va > bestA) { bestA = va; bestIx = idxs[q]; }
          }
          turns.push({
            atMeters: Math.round(cum[bestIx]),
            lat: coords[bestIx][0], lng: coords[bestIx][1],
            dir: dir, textJa: TURN_TEXT[dir],
            angle: Math.round(angle),
            _s0: s0, _s1: s1
          });
        }
      }
      g = h + 1;
    }
    // 「ななめ」が近くで続くときは、正味の角度（最初の 30m 手前 → 最後の 30m 先）でひとつにまとめる／捨てる
    var t = 0;
    while (t + 1 < turns.length) {
      var A = turns[t], B = turns[t + 1];
      if (A.dir.indexOf('slight') === 0 && B.dir.indexOf('slight') === 0 && B._s0 - A._s1 < config.turnSlightMergeMeters) {
        var net = angleAround(A._s0, B._s1, config.turnLookMeters * 1.5);
        var dirN = classifyTurn(net);
        if (!dirN) { turns.splice(t, 2); continue; }
        A.dir = dirN; A.textJa = TURN_TEXT[dirN]; A.angle = Math.round(net); A._s1 = B._s1;
        turns.splice(t + 1, 1);
        continue;
      }
      t++;
    }
    for (t = 0; t < turns.length; t++) { delete turns[t]._s0; delete turns[t]._s1; }
    return turns;
  }

  // ------------------------------------------------------------------
  // ルートの名前（方角）
  // ------------------------------------------------------------------
  var DIRS = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
  function bearingName(dx, dy) {
    var ang = Math.atan2(dx, dy) / DEG; // 北 0、時計まわり
    if (ang < 0) ang += 360;
    return DIRS[Math.round(ang / 45) % 8];
  }

  function labelFor(geom, xy) {
    var best = -1, bi = 0, i, d;
    if (geom.loop) {
      for (i = 0; i < xy.length; i++) {
        d = hypot(xy[i].x, xy[i].y);
        if (d > best) { best = d; bi = i; }
      }
      return bearingName(xy[bi].x, xy[bi].y) + 'まわり';
    }
    // ゴールあり：出発→ゴールの線から一番離れた点の方角（線の真ん中から見て）
    for (i = 0; i < xy.length; i++) {
      var rx = xy[i].x - geom.M.x, ry = xy[i].y - geom.M.y;
      d = Math.abs(rx * geom.v.x + ry * geom.v.y);
      if (d > best) { best = d; bi = i; }
    }
    return bearingName(xy[bi].x - geom.M.x, xy[bi].y - geom.M.y) + 'まわり';
  }

  var LABEL_MARKS = ['', '②', '③', '④', '⑤', '⑥'];
  function uniqueLabel(base, routes) { // すでにある名前とかぶらないようにする
    var n = 0;
    for (var i = 0; i < routes.length; i++) if (routes[i].labelJa.indexOf(base) === 0) n++;
    return n === 0 ? base : base + (LABEL_MARKS[n] || ('(' + (n + 1) + ')'));
  }

  // ------------------------------------------------------------------
  // 候補（向き・形）の計画
  // ------------------------------------------------------------------
  var GOAL_SHAPES = [
    { side: 1, stretch: 1 }, { side: -1, stretch: 1 },
    { side: 1, stretch: 1.7 }, { side: -1, stretch: 1.7 },
    { side: 1, stretch: 0.65 }, { side: -1, stretch: 0.65 }
  ];

  function planCandidates(geom, count, variant, state) {
    var list = [], i;
    var phase = ((variant % 3) - 1) * 0.15;
    if (geom.loop) {
      var baseDeg = (variant * 137.508 + 20) % 360;
      var dir = (variant % 2 === 0) ? 1 : -1;
      for (i = 0; i < count; i++) {
        var deg = baseDeg + i * 360 / count;
        list.push({ slot: i, baseDeg: deg, theta: deg * DEG, dir: dir, stretch: 1, phase: phase, attempt: 0 });
      }
    } else {
      var startIdx = (variant * 2) % GOAL_SHAPES.length;
      for (i = 0; i < count; i++) {
        var sh = GOAL_SHAPES[(startIdx + i) % GOAL_SHAPES.length];
        list.push({ slot: i, shapeIdx: startIdx + i, side: sh.side, stretch: sh.stretch, phase: phase, attempt: 0 });
      }
      state.nextShape = startIdx + count;
    }
    return list;
  }

  function angDist(a, b) {
    var d = Math.abs(norm2pi(a - b));
    return d > Math.PI ? 2 * Math.PI - d : d;
  }

  function fallbackCandidate(ctx, geom, cand, state) {
    var n = cand.attempt + 1;
    if (geom.loop) {
      // 15° 刻みの全方向から、採用済み・試した向きから一番離れていて、海や山にかからない向きを選ぶ
      if (n > 6) return null;
      var bestTheta = null, bestScore = -1;
      for (var deg = 0; deg < 360; deg += 15) {
        var th = (cand.baseDeg + deg) * DEG;
        var score = Math.PI;
        var i;
        for (i = 0; i < ctx.usedThetas.length; i++) score = Math.min(score, angDist(th, ctx.usedThetas[i]));
        if (score < 30 * DEG) continue;
        for (i = 0; i < ctx.triedThetas.length; i++) score = Math.min(score, angDist(th, ctx.triedThetas[i]) * 0.5);
        if (score <= bestScore) continue;
        var probe = { theta: th, dir: cand.dir, stretch: 1, phase: cand.phase };
        if (hitsKnownBad(ctx, viasFor(ctx, geom, probe).vias)) continue;
        bestScore = score; bestTheta = th;
      }
      if (bestTheta === null) return null;
      return { slot: cand.slot, baseDeg: cand.baseDeg, theta: bestTheta, dir: cand.dir, stretch: 1, phase: cand.phase, attempt: n };
    }
    if (n > 6) return null;
    var idx = state.nextShape++;
    var sh = GOAL_SHAPES[idx % GOAL_SHAPES.length];
    var phase = idx >= GOAL_SHAPES.length ? ((cand.phase > 0) ? -0.25 : 0.25) : cand.phase;
    return { slot: cand.slot, shapeIdx: idx, side: sh.side, stretch: sh.stretch, phase: phase, attempt: n };
  }

  // いまの見込み（detour）で、候補の経由地点を求める
  function viasFor(ctx, geom, cand) {
    var chordTarget = ctx.target / ctx.detour;
    if (!geom.loop) chordTarget = Math.max(chordTarget, geom.straight * 1.02);
    var k = solveK(geom, cand, ctx.nVia, chordTarget);
    var vias = shapeVias(geom, cand, k, ctx.nVia);
    return { k: k, vias: vias, chord: chordLength(geom, vias) };
  }

  // 「道がないとわかっている場所（海・山）」に経由地点がかかっていないか
  //   OSRM が「一番近い道まで r m」と返した点の r − maxSnap 以内には道がない、と推定できる
  function hitsKnownBad(ctx, vias) {
    for (var i = 0; i < vias.length; i++) {
      for (var j = 0; j < ctx.badPoints.length; j++) {
        var b = ctx.badPoints[j];
        if (hypot(vias[i].x - b.x, vias[i].y - b.y) < Math.max(b.r - config.maxSnapMeters, b.r * 0.6)) return true;
      }
    }
    return false;
  }

  // 採用済みのルートと向きが近すぎないか（一周ルートの予備候補用）
  function tooCloseDirection(ctx, cand) {
    if (cand.attempt === 0 || cand.theta === undefined) return false;
    for (var i = 0; i < ctx.usedThetas.length; i++) {
      var d = Math.abs(norm2pi(cand.theta - ctx.usedThetas[i]));
      if (d > Math.PI) d = 2 * Math.PI - d;
      if (d < 30 * DEG) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------
  // 1 本のルートを作る（最大 maxCallsPerCandidate 回問い合わせる）
  //   戻り値: { route, bad }   route = 採用できる候補（なければ null）
  // ------------------------------------------------------------------
  function solveCandidate(ctx, geom, cand) {
    var best = null;
    var calls = 0;

    var samples = []; // この候補で測った { k, d }

    // 次に試す円の大きさ k を決める
    //   1 回目：見込みの detour から。2 回目以降：目標をはさむ 2 つの測定値があればその間を内分、なければ比例で直す
    function nextK() {
      var below = null, above = null;
      for (var i = 0; i < samples.length; i++) {
        var smp = samples[i];
        if (smp.d < ctx.target && (!below || smp.d > below.d)) below = smp;
        if (smp.d > ctx.target && (!above || smp.d < above.d)) above = smp;
      }
      if (below && above && above.k > below.k) {
        var t = (ctx.target - below.d) / (above.d - below.d);
        t = clamp(t, 0.2, 0.8);
        return below.k + (above.k - below.k) * t;
      }
      return viasFor(ctx, geom, cand).k;
    }

    function step() {
      if (calls >= config.maxCallsPerCandidate || ctx.callsLeft <= 0) return Promise.resolve({ route: best });
      throwIfAborted(ctx.signal);
      var k = nextK();
      var viasXY = shapeVias(geom, cand, k, ctx.nVia);
      var chord = chordLength(geom, viasXY);
      var sh = { k: k };
      if (hitsKnownBad(ctx, viasXY)) return Promise.resolve({ route: best, bad: 'snap' });
      var points = [ctx.start];
      for (var i = 0; i < viasXY.length; i++) points.push(ctx.frame.toLL(viasXY[i]));
      points.push(ctx.goalLL);
      calls++;
      ctx.callsLeft--;
      var tr = { slot: cand.slot, attempt: cand.attempt, theta: cand.theta !== undefined ? Math.round(cand.theta / DEG) : undefined,
        side: cand.side, stretch: cand.stretch, k: Math.round(sh.k), chord: Math.round(chord), detour: Math.round(ctx.detour * 100) / 100 };
      ctx.stats.trace.push(tr);
      return osrmRoute(ctx, points).then(function (r) {
        tr.code = r.code;
        if (r.ok) { tr.d = Math.round(r.distance); tr.snaps = r.snaps.map(function (x) { return Math.round(x); }); }
        if (!r.ok) {
          if (ctx.firstCall && (r.code === 'NoSegment')) {
            throw new RouteError('近くに歩ける道が見つかりませんでした。出発地点を道の近くにしてください。', 'no_road', r.code);
          }
          ctx.firstCall = false;
          return { route: best, bad: 'noroute' };
        }
        if (ctx.firstCall) {
          ctx.firstCall = false;
          if (r.snaps[0] > config.maxStartSnapMeters) {
            throw new RouteError('近くに歩ける道が見つかりませんでした。出発地点を道の近くにしてください。', 'no_road', r.snaps[0]);
          }
        }
        var worstSnap = 0;
        for (var j = 1; j < r.snaps.length - 1; j++) {
          if (r.snaps[j] > worstSnap) worstSnap = r.snaps[j];
          if (r.snaps[j] > config.maxSnapMeters) {
            ctx.badPoints.push({ x: viasXY[j - 1].x, y: viasXY[j - 1].y, r: r.snaps[j] });
          }
        }
        if (worstSnap > config.maxSnapMeters) { tr.bad = 'snap'; return { route: best, bad: 'snap' }; }

        var d = r.distance;
        if (d <= 0) return { route: best, bad: 'noroute' };
        var err = d / ctx.target - 1;
        var xy = ctx.frame.coordsToXY(r.coords);
        var ov = selfOverlapXY(xy);
        var score = Math.abs(err) / config.goodTolerance + Math.max(0, ov - 0.1) * 4;
        tr.err = Math.round(err * 1000) / 10; tr.ov = Math.round(ov * 100);
        if (Math.abs(err) <= config.maxTolerance && (!best || score < best.score)) {
          best = { coords: r.coords, distance: d, err: err, overlap: ov, score: score, xy: xy, calls: calls, turns: r.turns };
        }
        // 「道の長さ ÷ 図形の長さ」を学び直して、次の大きさを決める
        ctx.detour = clamp(d / chord, 1.0, 3.5);
        if (Math.abs(err) <= config.goodTolerance && ov <= 0.3) return { route: best };
        // 同じ長さしか返ってこない（頭打ち）なら、経由地点の位置をずらして別の道を通らせる
        var plateau = false;
        for (var q = 0; q < samples.length; q++) if (Math.abs(samples[q].d - d) < d * 0.01) plateau = true;
        if (plateau) {
          cand.phase = cand.phase + 0.2 > 0.3 ? cand.phase - 0.4 : cand.phase + 0.2;
          samples = [];
          tr.plateau = true;
        } else {
          samples.push({ k: k, d: d });
        }
        return step();
      });
    }
    return step();
  }

  // ------------------------------------------------------------------
  // 入力チェック
  // ------------------------------------------------------------------
  function validate(opts) {
    if (!opts || typeof opts !== 'object') throw new RouteError('出発地点と距離を指定してください。', 'invalid_input');
    if (!isLatLng(opts.start)) throw new RouteError('出発地点がわかりません。位置情報を確かめてください。', 'invalid_input');
    if (opts.goal != null && !isLatLng(opts.goal)) throw new RouteError('家の場所がわかりません。設定で家の場所を登録し直してください。', 'invalid_input');
    var t = opts.targetMeters;
    if (!isNum(t)) throw new RouteError('歩く距離を入れてください。', 'invalid_input');
    if (t < limits.minMeters || t > limits.maxMeters) {
      throw new RouteError('歩く距離は ' + formatKm(limits.minMeters) + ' から ' + formatKm(limits.maxMeters) + ' の間で入れてください。', 'invalid_input');
    }
    if (opts.count != null && (!isNum(opts.count) || opts.count < 1 || opts.count > 6)) {
      throw new RouteError('ルートの本数は 1 から 6 の間で指定してください。', 'invalid_input');
    }
  }

  // ------------------------------------------------------------------
  // 本体
  // ------------------------------------------------------------------
  function generateRoutes(opts) {
    return new Promise(function (resolve) { resolve(); }).then(function () {
      validate(opts);
      var signal = opts.signal || null;
      throwIfAborted(signal);

      var start = { lat: opts.start.lat, lng: opts.start.lng };
      var goal = opts.goal ? { lat: opts.goal.lat, lng: opts.goal.lng } : null;
      var target = opts.targetMeters;
      var count = opts.count != null ? Math.round(opts.count) : 3;
      var variant = (opts.variant != null && isNum(opts.variant)) ? Math.max(0, Math.round(opts.variant)) : 0;
      var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};
      var onRoute = typeof opts.onRoute === 'function' ? opts.onRoute : function () {};

      var t0 = Date.now();
      var frame = new Frame(start);
      var S = { x: 0, y: 0 };
      var goalLL = goal || start;
      var H = frame.toXY(goalLL);
      var straight = hypot(H.x, H.y);
      var loop = !goal || straight < config.nearGoalMeters;
      var geom = { loop: loop, S: S, H: H, straight: straight };
      if (!loop) {
        geom.M = { x: H.x / 2, y: H.y / 2 };
        geom.c = straight / 2;
        geom.u = { x: H.x / straight, y: H.y / straight };
        geom.v = { x: -geom.u.y, y: geom.u.x };
      }
      var nVia = clamp(2 + Math.round(target / 3000), 3, 6);
      var ctx = {
        signal: signal, start: start, goalLL: goalLL, frame: frame, target: target, nVia: nVia,
        detour: config.initialDetour, callsLeft: config.callsPerRoute * count + 1,
        firstCall: true, badPoints: [], usedThetas: [], triedThetas: [], stats: { osrmCalls: 0, elapsedMs: 0, skipped: 0, trace: [] }
      };
      var type = goal ? 'toGoal' : 'loop';
      var routes = [];   // 採用したルート（画面に渡す形）
      var routesXY = []; // 同じ順番で、メートル平面の点の列（重なりの計算用）
      var spares = [];
      var noticeJa = null;
      var shortest = null;

      function progress(text, done) { try { onProgress(text, done, count); } catch (_) {} }
      function emit(route) { try { onRoute(route); } catch (_) {} }
      function finish(list) {
        ctx.stats.elapsedMs = Date.now() - t0;
        return { routes: list, noticeJa: noticeJa, stats: ctx.stats };
      }
      function makeRoute(idx, coords, distance, rtype, label, turns) {
        return { id: 'r' + variant + '-' + idx, coords: coords, distanceMeters: Math.round(distance), type: rtype, labelJa: label, turns: turns || [] };
      }
      function accept(cand, idx) { // 候補を採用して画面に知らせる
        var route = makeRoute(idx, cand.coords, cand.distance, type, uniqueLabel(labelFor(geom, cand.xy), routes), cand.turns);
        routes.push(route);
        routesXY.push(cand.xy);
        emit(route);
        return route;
      }

      progress('ルートを探しています（0/' + count + '）', 0);

      // --- ゴールあり：まず最短ルート
      var pre = Promise.resolve();
      if (goal && !loop) {
        pre = osrmRoute(ctx, [start, goal]).then(function (r) {
          ctx.firstCall = false;
          if (!r.ok) {
            if (r.code === 'NoSegment') throw new RouteError('近くに歩ける道が見つかりませんでした。出発地点や家の場所を道の近くにしてください。', 'no_road', r.code);
            throw new RouteError('家まで歩いて行ける道が見つかりませんでした。', 'no_route', r.code);
          }
          if (r.snaps[0] > config.maxStartSnapMeters) throw new RouteError('近くに歩ける道が見つかりませんでした。出発地点を道の近くにしてください。', 'no_road', r.snaps[0]);
          if (r.snaps[1] > config.maxStartSnapMeters) throw new RouteError('家の近くに歩ける道が見つかりませんでした。家の場所を道の近くにしてください。', 'no_road', r.snaps[1]);
          shortest = makeRoute('s', r.coords, r.distance, 'shortest', '最短', r.turns);
          ctx.detour = clamp(r.distance / straight, 1.1, 2.0);
          if (target < r.distance * config.shortestFactor) {
            if (target < r.distance && formatKm(target) !== formatKm(r.distance)) {
              noticeJa = '家までは最短でも約' + formatKm(r.distance) + 'あります。指定の' + formatKm(target) +
                'では帰れないので、最短のルートを出しています。';
            } else {
              noticeJa = '指定の' + formatKm(target) + 'は家までの最短距離（約' + formatKm(r.distance) +
                '）とほぼ同じなので、最短のルートを出しています。';
            }
            emit(shortest);
            progress('ルートができました（1/1）', 1);
            return 'done';
          }
          return null;
        });
      }

      return pre.then(function (flag) {
        if (flag === 'done') return finish([shortest]);

        var state = {};
        var queue = planCandidates(geom, count, variant, state);
        var idx = 0;

        function next() {
          throwIfAborted(signal);
          if (routes.length >= count || ctx.callsLeft <= 0 || !queue.length) return Promise.resolve();
          var cand = queue.shift();
          // 問い合わせる前に、海・山にかかる候補や向きが近すぎる候補は飛ばす（問い合わせを使わない）
          if (tooCloseDirection(ctx, cand) || hitsKnownBad(ctx, viasFor(ctx, geom, cand).vias)) {
            ctx.stats.skipped++;
            var fb0 = fallbackCandidate(ctx, geom, cand, state);
            if (fb0) queue.push(fb0);
            return next();
          }
          if (cand.theta !== undefined) ctx.triedThetas.push(cand.theta);
          return solveCandidate(ctx, geom, cand).then(function (res) {
            var accepted = false;
            if (res.route) {
              // ほかのルートと重なりすぎていないか
              var maxPair = 0;
              for (var i = 0; i < routesXY.length; i++) {
                var po = pairOverlapXY(routesXY[i], res.route.xy);
                if (po > maxPair) maxPair = po;
              }
              res.route.pair = maxPair;
              if (maxPair <= config.maxPairOverlap) {
                accept(res.route, idx++);
                if (cand.theta !== undefined) ctx.usedThetas.push(cand.theta);
                progress('ルートを探しています（' + routes.length + '/' + count + '）', routes.length);
                accepted = true;
              } else {
                spares.push(res.route);
              }
            }
            if (!accepted) {
              var fb = fallbackCandidate(ctx, geom, cand, state);
              if (fb) queue.push(fb);
            }
            return next();
          });
        }

        return next().then(function () {
          // 本数が足りないときは、重なりが多かった候補で補う
          spares.sort(function (a, b) { return a.score - b.score; });
          while (routes.length < count && spares.length) accept(spares.shift(), idx++);
          var out = routes;
          if (!out.length) {
            if (shortest) {
              noticeJa = '指定の' + formatKm(target) + 'に近いルートが見つからなかったので、家までの最短ルート（約' +
                formatKm(shortest.distanceMeters) + '）を出しています。';
              emit(shortest);
              return finish([shortest]);
            }
            throw new RouteError('この場所では' + formatKm(target) + 'に近いルートが見つかりませんでした。距離を変えるか、別の場所から試してください。', 'no_fit');
          }
          progress('ルートができました（' + out.length + '/' + count + '）', out.length);
          return finish(out);
        });
      });
    });
  }

  // ------------------------------------------------------------------
  // 「近道で帰る」：今いる場所 → ゴールの最短ルート 1 本（OSRM 1 回、間隔の決まりは同じ）
  //   from と to が 30m 以内なら OSRM に聞かず、2 点を結ぶだけのルートを返す（turns は空）
  // ------------------------------------------------------------------
  var shortcutSeq = 0;
  function routeBetween(from, to, opts) {
    opts = opts || {};
    return Promise.resolve().then(function () {
      if (!isLatLng(from)) throw new RouteError('今いる場所がわかりません。位置情報を確かめてください。', 'invalid_input');
      if (!isLatLng(to)) throw new RouteError('ゴールの場所がわかりません。', 'invalid_input');
      var signal = opts.signal || null;
      throwIfAborted(signal);
      var id = 'sc-' + (++shortcutSeq);
      var a = [from.lat, from.lng], b = [to.lat, to.lng];
      if (haversine(a, b) <= 30) {
        return { id: id, coords: [a, b], distanceMeters: Math.round(haversine(a, b)), type: 'shortest', labelJa: '近道', turns: [] };
      }
      var ctx = { signal: signal, stats: { osrmCalls: 0, trace: [] } };
      return osrmRoute(ctx, [{ lat: from.lat, lng: from.lng }, { lat: to.lat, lng: to.lng }]).then(function (r) {
        if (!r.ok) {
          if (r.code === 'NoSegment') throw new RouteError('近くに歩ける道が見つかりませんでした。', 'no_road', r.code);
          throw new RouteError('ゴールまで歩いて行ける道が見つかりませんでした。', 'no_route', r.code);
        }
        if (r.snaps[0] > config.maxStartSnapMeters) throw new RouteError('今いる場所の近くに歩ける道が見つかりませんでした。', 'no_road', r.snaps[0]);
        if (r.snaps[1] > config.maxStartSnapMeters) throw new RouteError('ゴールの近くに歩ける道が見つかりませんでした。', 'no_road', r.snaps[1]);
        if (r.coords.length < 2 || r.distance <= 0) throw new RouteError('ゴールまでの道が見つかりませんでした。', 'no_route');
        return { id: id, coords: r.coords, distanceMeters: Math.round(r.distance), type: 'shortest', labelJa: '近道', turns: r.turns || [] };
      });
    });
  }

  // ------------------------------------------------------------------
  // 公開
  // ------------------------------------------------------------------
  global.RouteEngine = {
    version: '1.0.0',
    config: config,
    limits: limits,
    RouteError: RouteError,
    generateRoutes: generateRoutes,
    routeBetween: routeBetween,
    // 補助（画面やテストで使ってよい）
    geo: {
      pathLength: pathLength,
      haversine: function (a, b) { return haversine([a.lat, a.lng], [b.lat, b.lng]); },
      removeSpurs: removeSpurs,
      removeNearSpurs: removeNearSpurs,
      cleanGeometry: cleanGeometry,
      turnCandidates: turnCandidates,
      selfOverlapRatio: selfOverlapRatio,
      pairOverlapRatio: pairOverlapRatio,
      buildTurns: buildTurns
    }
  };
})(typeof window !== 'undefined' ? window : this);
