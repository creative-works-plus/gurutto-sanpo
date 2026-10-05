/* poi.js — ルート沿いのコンビニ・公衆トイレを OpenStreetMap（Overpass API）から探す
 *
 *   const list = await Poi.fetchAlongRoute(coords, { kinds, bufferMeters, signal });
 *   list = [{ id, kind, lat, lng, nameJa, brandJa, atMeters, offMeters }]
 *
 * 依存なし・IIFE。window.Poi だけを公開する。
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- 設定
  var config = {
    // 先頭から順に試す。失敗したら次の1つで1回だけやり直す。（2026-10-04 に Chrome から実測。すべて CORS 可）
    //  1. overpass-api.de        … 本家。ふだんはいちばん安定。User-Agent なしだと 406 で断られる（ブラウザは問題なし）
    //  2. overpass.openstreetmap.fr … 本家が混んでいるときの逃げ先。長いルートでも約5秒で返った
    //  3. overpass.private.coffee / 4. maps.mail.ru … 予備。この日は重いクエリで時間切れが出た
    //  ※ overpass.kumi.systems は応答なし、overpass.osm.jp は接続できず（外した）
    endpoints: [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.openstreetmap.fr/api/interpreter',
      'https://overpass.private.coffee/api/interpreter',
      'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
    ],
    serverTimeoutSec: 25,       // [timeout:25]
    clientTimeoutMs: 18000,     // 1回目：これを超えたら失敗扱いにして別のサーバーでやり直す
    retryTimeoutMs: 28000,      // やり直し（2回目）の待ち時間
    simplifyMeters: 25,         // ルートを単純化する許容誤差（Douglas-Peucker）
    maxVertices: 200,           // クエリに入れる点の最大数
    queryMode: 'auto',          // 'around'（ルート沿い）/ 'tiles'（ルートが通る四角を並べる）/ 'bbox'（全体の四角1つ）/ 'auto'
    autoTilesKm: 10,            // auto のとき、ルートがこれより長ければ tiles
    tileMeters: 1000,           // tiles の1マスの大きさ
    maxTileRects: 60,           // tiles の四角の数の上限（超えたらマスを大きくする）
    cacheSize: 20,
    badEndpointMs: 5 * 60 * 1000 // 失敗したサーバーをこの間は後回しにする
  };

  var KIND_LIST = ['convenience', 'toilets'];

  // ---------------------------------------------------------------- エラー
  function PoiError(messageJa, code, cause) {
    var e = new Error(messageJa);
    e.name = 'PoiError';
    e.messageJa = messageJa;
    e.code = code || 'unknown';
    if (cause) e.cause = cause;
    if (Object.setPrototypeOf) Object.setPrototypeOf(e, PoiError.prototype);
    return e;
  }
  PoiError.prototype = Object.create(Error.prototype, {
    constructor: { value: PoiError, writable: true, configurable: true }
  });

  function abortError() {
    var e = PoiError('中止しました', 'aborted');
    e.name = 'AbortError';
    return e;
  }

  function failMessage(kinds) {
    var both = kinds.length > 1;
    var what = both ? 'コンビニとトイレ'
      : (kinds[0] === 'toilets' ? 'トイレ' : 'コンビニ');
    return what + 'の情報を読み込めませんでした。インターネットにつながっているか確かめてください';
  }

  // ---------------------------------------------------------------- 幾何
  var R_EARTH = 6371008.8;
  var RAD = Math.PI / 180;

  function haversine(lat1, lng1, lat2, lng2) {
    var dLat = (lat2 - lat1) * RAD, dLng = (lng2 - lng1) * RAD;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // ルート全体で使う平面座標（メートル）。30km 程度までならこれで十分正確。
  function makeProjector(lat0, lng0) {
    var kx = R_EARTH * RAD * Math.cos(lat0 * RAD), ky = R_EARTH * RAD;
    return function (lat, lng) { return [(lng - lng0) * kx, (lat - lat0) * ky]; };
  }

  function cleanCoords(coords) {
    var out = [];
    for (var i = 0; i < coords.length; i++) {
      var c = coords[i];
      if (c && isFinite(c[0]) && isFinite(c[1])) out.push([+c[0], +c[1]]);
    }
    return out;
  }

  // Douglas-Peucker（反復版・メートル座標）。残す点の番号の配列を返す。
  function simplifyIdx(xy, tol) {
    var n = xy.length;
    if (n <= 2) { var r = []; for (var k = 0; k < n; k++) r.push(k); return r; }
    var keep = new Uint8Array(n);
    keep[0] = keep[n - 1] = 1;
    var stack = [[0, n - 1]];
    var tol2 = tol * tol;
    while (stack.length) {
      var seg = stack.pop(), a = seg[0], b = seg[1];
      if (b <= a + 1) continue;
      var ax = xy[a][0], ay = xy[a][1], dx = xy[b][0] - ax, dy = xy[b][1] - ay;
      var len2 = dx * dx + dy * dy, maxD = -1, maxI = -1;
      for (var i = a + 1; i < b; i++) {
        var px = xy[i][0] - ax, py = xy[i][1] - ay, d2;
        if (len2 === 0) d2 = px * px + py * py;
        else {
          var t = (px * dx + py * dy) / len2;
          t = t < 0 ? 0 : (t > 1 ? 1 : t);
          var qx = px - t * dx, qy = py - t * dy;
          d2 = qx * qx + qy * qy;
        }
        if (d2 > maxD) { maxD = d2; maxI = i; }
      }
      if (maxD > tol2) { keep[maxI] = 1; stack.push([a, maxI], [maxI, b]); }
    }
    var res = [];
    for (var j = 0; j < n; j++) if (keep[j]) res.push(j);
    return res;
  }

  // 点数が maxVertices 以下になるまで許容誤差を広げて単純化する。{ pts, tol }
  function simplifyRoute(coords, xy, tol0, maxV) {
    var tol = tol0, idx = simplifyIdx(xy, tol);
    var guard = 0;
    while (idx.length > maxV && guard++ < 30) {
      tol *= 1.4;
      idx = simplifyIdx(xy, tol);
    }
    var pts = [];
    for (var i = 0; i < idx.length; i++) pts.push(coords[idx[i]]);
    return { pts: pts, tol: tol };
  }

  // ルートに対する点の「いちばん近いところ」。{ off, at }（メートル）
  function Locator(coords) {
    this.n = coords.length;
    this.lat0 = coords[0][0];
    this.lng0 = coords[0][1];
    var proj = this.proj = makeProjector(this.lat0, this.lng0);
    var xy = this.xy = [], cum = this.cum = [0];
    for (var i = 0; i < coords.length; i++) {
      xy.push(proj(coords[i][0], coords[i][1]));
      if (i > 0) cum.push(cum[i - 1] + haversine(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]));
    }
    this.total = cum[cum.length - 1];
  }
  Locator.prototype.locate = function (lat, lng) {
    var p = this.proj(lat, lng), px = p[0], py = p[1], xy = this.xy;
    var best = Infinity, bestAt = 0;
    if (this.n === 1) {
      return { off: Math.sqrt(px * px + py * py), at: 0 };
    }
    for (var i = 0; i < this.n - 1; i++) {
      var ax = xy[i][0], ay = xy[i][1], bx = xy[i + 1][0], by = xy[i + 1][1];
      // 速い足切り: 線分の四角から best 以上離れていたら飛ばす
      if (best < Infinity) {
        if ((px < ax && px < bx && Math.min(ax, bx) - px > best) ||
            (px > ax && px > bx && px - Math.max(ax, bx) > best) ||
            (py < ay && py < by && Math.min(ay, by) - py > best) ||
            (py > ay && py > by && py - Math.max(ay, by) > best)) continue;
      }
      var dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy, t = 0;
      if (len2 > 0) {
        t = ((px - ax) * dx + (py - ay) * dy) / len2;
        t = t < 0 ? 0 : (t > 1 ? 1 : t);
      }
      var qx = ax + t * dx - px, qy = ay + t * dy - py;
      var d = Math.sqrt(qx * qx + qy * qy);
      if (d < best) { best = d; bestAt = this.cum[i] + t * (this.cum[i + 1] - this.cum[i]); }
    }
    return { off: best, at: bestAt };
  };

  // ---------------------------------------------------------------- ブランド名
  // 上から順に最初に合ったものを採用。[正規表現, 表示名]
  var BRANDS = [
    [/ローソン\s*ストア\s*100|lawson\s*store\s*100|ローソンストア１００/i, 'ローソンストア100'],
    [/ナチュラル\s*ローソン|natural\s*lawson/i, 'ナチュラルローソン'],
    [/セブン\s*[-‐‑–ー－]?\s*イレブン|seven[\s-]*eleven|7[\s-]*eleven|７[\s-]*イレブン|セブン[ＩI]ＩＩ?/i, 'セブン-イレブン'],
    [/ファミリー\s*[-‐‑–ー－]?\s*マート|family\s*mart|ファミマ/i, 'ファミリーマート'],
    [/ローソン|lawson/i, 'ローソン'],
    [/ミニ\s*ストップ|mini\s*stop/i, 'ミニストップ'],
    [/デイリー\s*ヤマザキ|daily\s*yamazaki|ヤマザキ\s*デイリー\s*ストア/i, 'デイリーヤマザキ'],
    [/セイコー\s*マート|seico\s*mart/i, 'セイコーマート'],
    [/new\s*days|ニューデイズ/i, 'NewDays'],
    [/ポプラ|poplar/i, 'ポプラ'],
    [/生活彩家/, '生活彩家'],
    [/スリーエフ|three\s*f\b/i, 'スリーエフ'],
    [/ココ\s*ストア|coco\s*store/i, 'ココストア'],
    [/ヤマザキ\s*Y\s*ショップ|ヤマザキYショップ/i, 'ヤマザキYショップ'],
    [/セーブ\s*オン|save\s*on/i, 'セーブオン'],
    [/ショップ\s*99|shop\s*99/i, 'ショップ99'],
    [/タイエー|ハッピー\s*デイズ/, null]
  ];

  function matchBrand(str) {
    if (!str) return null;
    for (var i = 0; i < BRANDS.length; i++) {
      if (BRANDS[i][1] === null) continue;
      var m = BRANDS[i][0].exec(str);
      if (m) return { name: BRANDS[i][1], index: m.index, len: m[0].length };
    }
    return null;
  }

  var JA_RE = /[぀-ヿ㐀-鿿ｦ-ﾟ]/;

  function pickNames(tags, kind) {
    var rawName = tags['name:ja'] || tags['name'] || '';
    var rawBrand = tags['brand:ja'] || tags['brand'] || '';
    var brandJa = '';

    if (kind === 'convenience') {
      // ブランド欄 → 名前欄 → 運営会社 の順にチェーンを探す
      var hit = matchBrand(tags['brand:ja']) || matchBrand(tags['brand']) ||
        matchBrand(tags['brand:en']) || matchBrand(rawName) ||
        matchBrand(tags['name:en']) || matchBrand(tags['operator']);
      brandJa = hit ? hit.name : rawBrand;
    }

    var nameJa = rawName;
    if (nameJa) {
      // 英語表記のチェーン名は日本語名に置きかえる（例: "Lawson Koenji" → "ローソン Koenji"）
      var nh = kind === 'convenience' ? matchBrand(nameJa) : null;
      if (nh) {
        nameJa = nameJa.slice(0, nh.index) + nh.name + nameJa.slice(nh.index + nh.len);
        nameJa = nameJa.replace(/\s{2,}/g, ' ').trim();
      }
    } else if (kind === 'convenience') {
      nameJa = brandJa || 'コンビニ';
    } else {
      nameJa = tags['name:en'] && JA_RE.test(tags['name:en']) ? tags['name:en'] : 'トイレ';
    }
    return { nameJa: nameJa, brandJa: brandJa };
  }

  // ---------------------------------------------------------------- クエリ作り
  function fmt5(v) { return (Math.round(v * 1e5) / 1e5).toString(); }

  // ルートが通るマス（buffer ぶん太らせたもの）を横に連ねて長方形にする。[[南,西,北,東], ...]
  // 長いルートでは around(ポリライン) より速いことが多い（四角の検索は索引だけで済むため）
  function buildTiles(loc, pts, margin, cell, maxRects) {
    var kx = R_EARTH * RAD * Math.cos(loc.lat0 * RAD), ky = R_EARTH * RAD;
    var xy = [];
    for (var i = 0; i < pts.length; i++) xy.push(loc.proj(pts[i][0], pts[i][1]));
    for (var tries = 0; tries < 6; tries++) {
      var seen = {}, rows = {};
      for (var j = 0; j < xy.length; j++) {
        var a = xy[j], b = xy[j + 1] || xy[j];
        var L = Math.sqrt((b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]));
        var n = Math.max(1, Math.ceil(L / (cell / 4)));
        for (var k = 0; k <= n; k++) {
          var x = a[0] + (b[0] - a[0]) * k / n, y = a[1] + (b[1] - a[1]) * k / n;
          for (var ox = -1; ox <= 1; ox++) for (var oy = -1; oy <= 1; oy++) {
            var cx = Math.floor((x + ox * margin) / cell), cy = Math.floor((y + oy * margin) / cell);
            var id = cx + ':' + cy;
            if (!seen[id]) { seen[id] = 1; (rows[cy] = rows[cy] || []).push(cx); }
          }
        }
      }
      var rects = [];
      for (var cyKey in rows) {
        var xs = rows[cyKey].sort(function (p, q) { return p - q; }), s0 = xs[0], prev = xs[0];
        for (var m = 1; m <= xs.length; m++) {
          if (m === xs.length || xs[m] !== prev + 1) {
            rects.push([+cyKey, s0, prev]);
            if (m < xs.length) s0 = xs[m];
          }
          if (m < xs.length) prev = xs[m];
        }
      }
      if (rects.length <= maxRects || tries === 5) {
        return rects.map(function (r) {
          return [loc.lat0 + r[0] * cell / ky, loc.lng0 + r[1] * cell / kx,
            loc.lat0 + (r[0] + 1) * cell / ky, loc.lng0 + (r[2] + 1) * cell / kx];
        });
      }
      cell *= 1.6;
    }
  }

  function bboxFilter(b) {
    return '(' + fmt5(b[0]) + ',' + fmt5(b[1]) + ',' + fmt5(b[2]) + ',' + fmt5(b[3]) + ')';
  }

  function buildQuery(kinds, radius, pts, mode, bbox) {
    var filt;
    if (mode === 'tiles') {
      var parts0 = [];
      for (var t = 0; t < bbox.length; t++) {
        var f = bboxFilter(bbox[t]);
        if (kinds.indexOf('convenience') >= 0) parts0.push('nwr["shop"="convenience"]' + f + ';');
        if (kinds.indexOf('toilets') >= 0) parts0.push('nwr["amenity"="toilets"]["access"!~"^(private|no|customers)$"]' + f + ';');
      }
      return '[out:json][timeout:' + config.serverTimeoutSec + '];(' + parts0.join('') + ');out tags center;';
    }
    if (mode === 'bbox') {
      filt = bboxFilter(bbox);
    } else {
      var s = [];
      for (var i = 0; i < pts.length; i++) s.push(fmt5(pts[i][0]) + ',' + fmt5(pts[i][1]));
      filt = '(around:' + Math.ceil(radius) + ',' + s.join(',') + ')';
    }
    var parts = [];
    if (kinds.indexOf('convenience') >= 0) parts.push('nwr["shop"="convenience"]' + filt + ';');
    if (kinds.indexOf('toilets') >= 0) {
      parts.push('nwr["amenity"="toilets"]["access"!~"^(private|no|customers)$"]' + filt + ';');
    }
    return '[out:json][timeout:' + config.serverTimeoutSec + '];(' + parts.join('') + ');out tags center;';
  }

  // ---------------------------------------------------------------- 通信
  var badUntil = {};          // endpoint → この時刻までは後回し
  var tail = Promise.resolve(); // 同時に1本だけ通信するための行列

  function orderedEndpoints() {
    var eps = (config.endpoints || []).slice(), now = Date.now(), good = [], bad = [];
    for (var i = 0; i < eps.length; i++) (badUntil[eps[i]] > now ? bad : good).push(eps[i]);
    return good.concat(bad);
  }

  // 1回の通信。成功すれば JSON、失敗すれば { retry: true/false } 付きのエラーを投げる。
  function postOnce(endpoint, query, signal, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var ctrl = new AbortController();
      var timedOut = false, done = false;
      var timer = setTimeout(function () { timedOut = true; ctrl.abort(); }, timeoutMs);
      function onAbort() { ctrl.abort(); }
      if (signal) {
        if (signal.aborted) { clearTimeout(timer); reject(abortError()); return; }
        signal.addEventListener('abort', onAbort);
      }
      function finish(fn, v) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        fn(v);
      }
      function fail(code, retry, status) {
        var e = PoiError('通信に失敗しました', code);
        e.retry = retry;
        e.status = status;
        finish(reject, e);
      }
      fetch(endpoint, {
        method: 'POST',
        // 「単純リクエスト」にしてブラウザの事前確認（preflight）を省く
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: 'data=' + encodeURIComponent(query),
        signal: ctrl.signal,
        credentials: 'omit',
        cache: 'no-store'
      }).then(function (res) {
        if (!res.ok) {
          fail('http_' + res.status, res.status === 429 || res.status >= 500 || res.status === 406 || res.status === 403, res.status);
          return;
        }
        return res.json().then(function (json) {
          // Overpass は時間切れでも 200 で remark を返すことがある
          if (json && json.remark && /error|timed out|out of memory/i.test(json.remark)) {
            fail('remark', true, 200);
          } else if (!json || !json.elements) {
            fail('bad_json', true, 200);
          } else finish(resolve, json);
        });
      }).catch(function (err) {
        if (done) return;
        if (signal && signal.aborted) { finish(reject, abortError()); return; }
        if (timedOut) { fail('timeout', true, 0); return; }
        fail('network', true, 0);
      });
    });
  }

  // 最初のサーバーで失敗したら、別のサーバーで1回だけやり直す
  function requestWithRetry(query, signal) {
    var eps = orderedEndpoints();
    if (!eps.length) return Promise.reject(PoiError('設定にサーバーがありません', 'no_endpoint'));
    var first = eps[0], second = eps.length > 1 ? eps[1] : eps[0];
    return postOnce(first, query, signal, config.clientTimeoutMs).catch(function (err) {
      if (err.name === 'AbortError' || !err.retry) throw err;
      badUntil[first] = Date.now() + config.badEndpointMs;
      if (signal && signal.aborted) throw abortError();
      return postOnce(second, query, signal, config.retryTimeoutMs).catch(function (err2) {
        if (err2.name !== 'AbortError' && err2.retry) badUntil[second] = Date.now() + config.badEndpointMs;
        throw err2;
      });
    });
  }

  function enqueue(task, signal) {
    var run = function () {
      if (signal && signal.aborted) return Promise.reject(abortError());
      return task();
    };
    var p = tail.then(run, run);
    tail = p.then(function () {}, function () {});
    // 順番待ちの間に中止された場合もすぐ AbortError にする
    if (!signal) return p;
    return new Promise(function (resolve, reject) {
      function onAbort() { reject(abortError()); }
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort);
      p.then(function (v) { signal.removeEventListener('abort', onAbort); resolve(v); },
        function (e) { signal.removeEventListener('abort', onAbort); reject(e); });
    });
  }

  // ---------------------------------------------------------------- キャッシュ
  var cache = {};     // key → list
  var cacheKeys = [];

  function routeSignature(coords, kinds, buffer) {
    var n = coords.length, step = Math.max(1, Math.floor(n / 24)), s = [];
    for (var i = 0; i < n; i += step) s.push(coords[i][0].toFixed(4) + ',' + coords[i][1].toFixed(4));
    s.push(coords[n - 1][0].toFixed(4) + ',' + coords[n - 1][1].toFixed(4));
    return kinds.join('+') + '|' + buffer + '|' + n + '|' + s.join(';');
  }

  function cacheGet(key) { return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : null; }
  function cacheSet(key, list) {
    if (!cacheGet(key)) cacheKeys.push(key);
    cache[key] = list;
    while (cacheKeys.length > config.cacheSize) delete cache[cacheKeys.shift()];
  }

  function cloneList(list) {
    return list.map(function (o) { var c = {}; for (var k in o) c[k] = o[k]; return c; });
  }

  // ---------------------------------------------------------------- 本体
  function convert(json, kinds, coords, buffer) {
    var loc = new Locator(coords);
    var els = json.elements || [], out = [], seenId = {};
    for (var i = 0; i < els.length; i++) {
      var el = els[i], tags = el.tags || {};
      var lat = el.lat != null ? el.lat : (el.center && el.center.lat);
      var lng = el.lon != null ? el.lon : (el.center && el.center.lon);
      if (lat == null || lng == null) continue;
      var kind = tags.shop === 'convenience' ? 'convenience' : (tags.amenity === 'toilets' ? 'toilets' : null);
      if (!kind || kinds.indexOf(kind) < 0) continue;
      if (kind === 'toilets' && /^(private|no|customers)$/.test(tags.access || '')) continue;
      var id = el.type + '/' + el.id;
      if (seenId[id]) continue;
      seenId[id] = 1;
      var pos = loc.locate(lat, lng);
      if (pos.off > buffer) continue;
      var nm = pickNames(tags, kind);
      out.push({
        id: id, kind: kind, lat: lat, lng: lng,
        nameJa: nm.nameJa, brandJa: nm.brandJa,
        atMeters: Math.round(pos.at), offMeters: Math.round(pos.off)
      });
    }
    out.sort(function (a, b) { return a.atMeters - b.atMeters || a.offMeters - b.offMeters; });

    // 同じ種類・同じ名前で 20m 以内（建物の点と線が二重に載っているものなど）は1つにまとめる
    var res = [];
    for (var j = 0; j < out.length; j++) {
      var o = out[j], dup = false;
      for (var k = res.length - 1; k >= 0; k--) {
        var r = res[k];
        if (o.atMeters - r.atMeters > 60) break;
        if (r.kind === o.kind && r.nameJa === o.nameJa && haversine(r.lat, r.lng, o.lat, o.lng) < 20) {
          dup = true;
          if (o.offMeters < r.offMeters) res[k] = o;
          break;
        }
      }
      if (!dup) res.push(o);
    }
    res.sort(function (a, b) { return a.atMeters - b.atMeters || a.offMeters - b.offMeters; });
    return res;
  }

  function normKinds(kinds) {
    var out = [];
    var src = kinds && kinds.length ? kinds : KIND_LIST;
    for (var i = 0; i < src.length; i++) {
      if (KIND_LIST.indexOf(src[i]) >= 0 && out.indexOf(src[i]) < 0) out.push(src[i]);
    }
    return out.length ? out : KIND_LIST.slice();
  }

  function fetchAlongRoute(coords, opts) {
    opts = opts || {};
    var signal = opts.signal;
    var kinds = normKinds(opts.kinds);
    var buffer = opts.bufferMeters > 0 ? +opts.bufferMeters : 150;

    if (signal && signal.aborted) return Promise.reject(abortError());
    var cs = cleanCoords(coords || []);
    if (!cs.length) return Promise.resolve([]);

    var key = routeSignature(cs, kinds, buffer);
    var hit = cacheGet(key);
    if (hit) return Promise.resolve(cloneList(hit));

    return enqueue(function () {
      // 順番待ちの間に同じルートが取得済みになっていたらそれを使う
      var again = cacheGet(key);
      if (again) return cloneList(again);

      var loc0 = new Locator(cs);
      var s = simplifyRoute(cs, loc0.xy, config.simplifyMeters, config.maxVertices);
      var mode = config.queryMode;
      if (mode === 'auto') mode = loc0.total > config.autoTilesKm * 1000 ? 'tiles' : 'around';
      var bbox = null;
      if (mode === 'tiles') {
        bbox = buildTiles(loc0, s.pts, buffer + s.tol, config.tileMeters, config.maxTileRects);
      } else if (mode === 'bbox') {
        var minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
        for (var i = 0; i < cs.length; i++) {
          if (cs[i][0] < minLat) minLat = cs[i][0];
          if (cs[i][0] > maxLat) maxLat = cs[i][0];
          if (cs[i][1] < minLng) minLng = cs[i][1];
          if (cs[i][1] > maxLng) maxLng = cs[i][1];
        }
        var dLat = buffer / 111320, dLng = buffer / (111320 * Math.cos(cs[0][0] * RAD));
        bbox = [minLat - dLat, minLng - dLng, maxLat + dLat, maxLng + dLng];
      }
      // 単純化した線は元のルートから最大 tol ずれるので、その分だけ検索の幅を広げて、あとで正確に絞る
      var query = buildQuery(kinds, buffer + s.tol, s.pts, mode, bbox);
      lastQueryInfo.mode = mode;
      lastQueryInfo.bytes = query.length;
      lastQueryInfo.vertices = s.pts.length;
      lastQueryInfo.tol = Math.round(s.tol);

      return requestWithRetry(query, signal).then(function (json) {
        var list = convert(json, kinds, cs, buffer);
        lastQueryInfo.elements = (json.elements || []).length;
        cacheSet(key, list);
        return cloneList(list);
      }, function (err) {
        if (err && err.name === 'AbortError') throw err;
        throw PoiError(failMessage(kinds), err && err.code ? err.code : 'failed', err);
      });
    }, signal);
  }

  var lastQueryInfo = { bytes: 0, vertices: 0, tol: 0, elements: 0 };

  window.Poi = {
    fetchAlongRoute: fetchAlongRoute,
    PoiError: PoiError,
    config: config,
    clearCache: function () { cache = {}; cacheKeys = []; },
    // 試験・調査用
    _lastQueryInfo: lastQueryInfo,
    _matchBrand: matchBrand,
    _pickNames: pickNames
  };
})();
