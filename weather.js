/* weather.js — その場所の天気・雨（ぐるっとさんぽ）  設計メモ「追加3」
 *
 * Weather.get(lat, lng, {signal}) → Promise<WeatherInfo>（10分キャッシュ）
 * Weather.rainDuring(info, startDate, minutes) → {likely, maxPct, messageJa}
 * Weather.radar() → Promise<{tileUrl, timeLabelJa, attributionJa, maxNativeZoom} | null>
 * Weather.WeatherError（messageJa）。中止は AbortError。一部だけ取れないときは、その項目を null／空にする。
 *
 * ■ データの出どころ（どれも登録なし・ブラウザから直接読める＝CORS「*」を確認済み 2026-10-05）
 *  気象庁 防災情報 JSON（www.jma.go.jp/bosai/…）
 *   - 天気予報        forecast/data/forecast/{府県予報区}.json（天気・6時間ごとの降水確率・気温）
 *   - 予報区の表      common/const/area.json（市町村 class20 → class15 → class10 → 府県 office）
 *   - 予報区の形      common/const/geojson/class15s.json（住所が取れないときだけ。約420KB）
 *   - アメダス        amedas/const/amedastable.json, amedas/data/latest_time.txt, amedas/data/map/{時刻}.json
 *   - 高解像度降水ナウキャスト  jmatile/data/nowc/targetTimes_N1.json / N2.json と
 *                      nowc/{基準時刻}/none/{対象時刻}/surf/hrpns/{z}/{x}/{y}.png（z は 10 まで。色を読んで mm/h に直す）
 *   - 警報・注意報    warning/data/r8/{府県}.json（2026年からの新しい形＝レベル付き。古い warning/data/warning/ は 2026-05 で更新停止）
 *   利用規約：気象庁ホームページのコンテンツは「公共データ利用規約（第1.0版）」（＝政府標準利用規約の後継。CC BY 4.0 互換）。
 *   商用利用可・登録不要。条件は出典を出すこと → 画面に「出典：気象庁」を必ず出す（天気カード・雨雲レーダー・説明ページ）。
 *   注意：気象業務法 第17条（自分で予報をするには許可が必要）・第23条（気象庁以外は警報を出せない）。
 *         このファイルは気象庁の予報・警報をそのまま見せるだけで、独自の予報・警報は作らない。
 *         「いまの天気」の言葉（晴れ／くもり／雨）はアメダスの観測とナウキャストからの言い換えで、予報ではない。
 *   JSON は公式 API ではないので、予告なく形が変わることがある（変わったら null が増えるだけで、アプリは止まらない）。
 *  国土地理院 逆ジオコーダ  mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress（緯度経度 → 市区町村コード）
 *   国土地理院コンテンツ利用規約（CC BY 4.0 互換・商用可・出典「国土地理院」）。ただし地理院地図用に動かしているもので、
 *   正式に公開された API ではなく動作の保証はない（index.html の住所検索と同じ扱い）。だめなときは気象庁の予報区の形で場所を決める。
 *   気象庁だけで済ませたいときは USE_GSI を false にする（市区町村の名前が「２３区西部」のような予報区の名前になる）。
 *
 * 依存なし。window.Weather だけを公開する。iOS Safari / Android Chrome で動く書き方（fetch・Promise・canvas）。
 */
(function (global) {
  'use strict';

  var JMA = 'https://www.jma.go.jp/bosai/';
  var GSI_REV = 'https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress';
  var USE_GSI = true;
  var TTL = 10 * 60 * 1000, FOREVER = Infinity, TIMEOUT = 15000, MIN = 60000, H6 = 6 * 3600000, JST = 9 * 3600000;
  var NOWC_Z = 10;          // ナウキャストの一番細かいズーム（11 以上は空の絵が返る）

  // 気象庁の天気コード → 短い言葉（気象庁の予報ページの表 TELOPS から。表示のとき 晴→晴れ 曇→くもり 後→のち に直す）
  var TELOPS = {100:"晴",101:"晴時々曇",102:"晴一時雨",103:"晴時々雨",104:"晴一時雪",105:"晴時々雪",106:"晴一時雨か雪",107:"晴時々雨か雪",108:"晴一時雨か雷雨",110:"晴後時々曇",111:"晴後曇",112:"晴後一時雨",113:"晴後時々雨",114:"晴後雨",115:"晴後一時雪",116:"晴後時々雪",117:"晴後雪",118:"晴後雨か雪",119:"晴後雨か雷雨",120:"晴朝夕一時雨",121:"晴朝の内一時雨",122:"晴夕方一時雨",123:"晴山沿い雷雨",124:"晴山沿い雪",125:"晴午後は雷雨",126:"晴昼頃から雨",127:"晴夕方から雨",128:"晴夜は雨",130:"朝の内霧後晴",131:"晴明け方霧",132:"晴朝夕曇",140:"晴時々雨で雷を伴う",160:"晴一時雪か雨",170:"晴時々雪か雨",181:"晴後雪か雨",200:"曇",201:"曇時々晴",202:"曇一時雨",203:"曇時々雨",204:"曇一時雪",205:"曇時々雪",206:"曇一時雨か雪",207:"曇時々雨か雪",208:"曇一時雨か雷雨",209:"霧",210:"曇後時々晴",211:"曇後晴",212:"曇後一時雨",213:"曇後時々雨",214:"曇後雨",215:"曇後一時雪",216:"曇後時々雪",217:"曇後雪",218:"曇後雨か雪",219:"曇後雨か雷雨",220:"曇朝夕一時雨",221:"曇朝の内一時雨",222:"曇夕方一時雨",223:"曇日中時々晴",224:"曇昼頃から雨",225:"曇夕方から雨",226:"曇夜は雨",228:"曇昼頃から雪",229:"曇夕方から雪",230:"曇夜は雪",231:"曇海上海岸は霧か霧雨",240:"曇時々雨で雷を伴う",250:"曇時々雪で雷を伴う",260:"曇一時雪か雨",270:"曇時々雪か雨",281:"曇後雪か雨",300:"雨",301:"雨時々晴",302:"雨時々止む",303:"雨時々雪",304:"雨か雪",306:"大雨",308:"雨で暴風を伴う",309:"雨一時雪",311:"雨後晴",313:"雨後曇",314:"雨後時々雪",315:"雨後雪",316:"雨か雪後晴",317:"雨か雪後曇",320:"朝の内雨後晴",321:"朝の内雨後曇",322:"雨朝晩一時雪",323:"雨昼頃から晴",324:"雨夕方から晴",325:"雨夜は晴",326:"雨夕方から雪",327:"雨夜は雪",328:"雨一時強く降る",329:"雨一時みぞれ",340:"雪か雨",350:"雨で雷を伴う",361:"雪か雨後晴",371:"雪か雨後曇",400:"雪",401:"雪時々晴",402:"雪時々止む",403:"雪時々雨",405:"大雪",406:"風雪強い",407:"暴風雪",409:"雪一時雨",411:"雪後晴",413:"雪後曇",414:"雪後雨",420:"朝の内雪後晴",421:"朝の内雪後曇",422:"雪昼頃から雨",423:"雪夕方から雨",425:"雪一時強く降る",426:"雪後みぞれ",427:"雪一時みぞれ",450:"雪で雷を伴う"};

  // 警報・注意報コード（2026年からの新しい形。気象庁 警報ページの表から）→ [名前, レベル(2〜5), レベル付きの種類か]
  var WARN = {'10':['大雨',2,1],'03':['大雨',3,1],'43':['大雨',4,1],'33':['大雨',5,1],
    '29':['土砂災害',2,1],'09':['土砂災害',3,1],'49':['土砂災害',4,1],'39':['土砂災害',5,1],
    '19':['高潮',2,1],'08':['高潮',3,1],'48':['高潮',4,1],'38':['高潮',5,1],
    '15':['強風',2],'05':['暴風',3],'35':['暴風',5],'13':['風雪',2],'02':['暴風雪',3],'32':['暴風雪',5],
    '12':['大雪',2],'06':['大雪',3],'36':['大雪',5],'16':['波浪',2],'07':['波浪',3],'37':['波浪',5],
    '14':['雷',2],'17':['融雪',2],'20':['濃霧',2],'21':['乾燥',2],'22':['なだれ',2],'23':['低温',2],
    '24':['霜',2],'25':['着氷',2],'26':['着雪',2],'18':['洪水',2],'04':['洪水',3]};
  var WARN_SUFFIX = {2:'注意報',3:'警報',4:'危険警報',5:'特別警報'};
  var WARN_KEY = {2:'advisory',3:'warning',4:'warning',5:'emergency'};
  var ZEN = '０１２３４５６７８９';

  // ナウキャストの色 → mm/h（気象庁の凡例。値はその段の下の端。いちばん薄い色は 1 未満なので 0.5）
  var RAIN_COLORS = [[242,242,255,0.5],[160,210,255,1],[33,140,255,5],[0,65,255,10],[250,245,0,20],[255,153,0,30],[255,40,0,50],[180,0,104,80]];
  function levelJaOf(mm) {
    return mm >= 80 ? '猛烈な雨' : mm >= 50 ? '非常に激しい雨' : mm >= 30 ? '激しい雨' : mm >= 20 ? '強い雨' :
      mm >= 10 ? 'やや強い雨' : mm >= 5 ? '雨' : mm > 0 ? '弱い雨' : null;
  }

  // 府県予報区の天気予報ファイルが別の区にまとまっているところ（十勝→釧路・根室、奄美→鹿児島）
  var FORECAST_OFFICE = {'014030': '014100', '460040': '460100'};
  var PREFS = '北海道,青森県,岩手県,宮城県,秋田県,山形県,福島県,茨城県,栃木県,群馬県,埼玉県,千葉県,東京都,神奈川県,新潟県,富山県,石川県,福井県,山梨県,長野県,岐阜県,静岡県,愛知県,三重県,滋賀県,京都府,大阪府,兵庫県,奈良県,和歌山県,鳥取県,島根県,岡山県,広島県,山口県,徳島県,香川県,愛媛県,高知県,福岡県,佐賀県,長崎県,熊本県,大分県,宮崎県,鹿児島県,沖縄県'.split(',');

  // ───────── エラー
  function WeatherError(messageJa, cause) {
    this.name = 'WeatherError'; this.message = messageJa; this.messageJa = messageJa; this.cause = cause;
    this.stack = (new Error(messageJa)).stack;
  }
  WeatherError.prototype = Object.create(Error.prototype);
  WeatherError.prototype.constructor = WeatherError;
  function abortError() {
    try { return new DOMException('中止しました', 'AbortError'); }
    catch (e) { var err = new Error('中止しました'); err.name = 'AbortError'; return err; }
  }
  function isAbort(e) { return e && e.name === 'AbortError'; }

  // ───────── 取得（同じ URL は一度だけ取りに行き、みんなで使い回す）
  var memo = {};
  function shared(url, ttl, type) {
    var now = Date.now(), m = memo[url];
    if (m && now - m.t < ttl) return m.p;
    for (var k in memo) if (memo[k].ttl !== FOREVER && now - memo[k].t > 2 * TTL) delete memo[k]; // 古いものは捨てる
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, TIMEOUT);
    var p = fetch(url, ctl ? { signal: ctl.signal } : {}).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
      return type === 'blob' ? r.blob() : type === 'text' ? r.text() : r.json();
    });
    p = p.then(function (v) { clearTimeout(timer); return v; }, function (e) {
      clearTimeout(timer); if (memo[url] && memo[url].p === p) delete memo[url]; throw e;
    });
    memo[url] = { t: now, p: p, ttl: ttl };
    return p;
  }
  // 呼んだ側の signal で中止できるようにする（取りに行った通信そのものは他の人と共有なので止めない）
  function guard(p, signal) {
    if (!signal) return p;
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise(function (res, rej) {
      function onAbort() { rej(abortError()); }
      signal.addEventListener('abort', onAbort);
      p.then(function (v) { signal.removeEventListener('abort', onAbort); res(v); },
        function (e) { signal.removeEventListener('abort', onAbort); rej(e); });
    });
  }
  function soft(p) { return p.then(null, function (e) { if (isAbort(e)) throw e; return null; }); } // 失敗 → null
  // 同時に走らせる数をしぼって順に処理する
  function pool(items, n, fn) {
    var out = new Array(items.length), i = 0;
    function next() { if (i >= items.length) return Promise.resolve(); var k = i++; return fn(items[k]).then(function (v) { out[k] = v; return next(); }); }
    var ws = []; for (var j = 0; j < Math.min(n, items.length); j++) ws.push(next());
    return Promise.all(ws).then(function () { return out; });
  }

  // ───────── 小さな道具
  function distKm(a1, o1, a2, o2) {
    var R = Math.PI / 180, x = (o2 - o1) * R * Math.cos((a1 + a2) / 2 * R), y = (a2 - a1) * R;
    return Math.sqrt(x * x + y * y) * 6371;
  }
  function jstDay(d) { return new Date(d.getTime() + JST).toISOString().slice(0, 10); }
  function jstHour(d) { return new Date(d.getTime() + JST).getUTCHours(); }
  function hhmm(d) { var j = new Date(d.getTime() + JST); return j.getUTCHours() + ':' + ('0' + j.getUTCMinutes()).slice(-2); }
  function utcStamp(s) { // "20261005124000"（UTC）→ Date
    return new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12)));
  }
  function num(v) { var n = parseFloat(v); return v === '' || v == null || isNaN(n) ? null : n; }
  function niceWeather(code) {
    var t = TELOPS[+code]; if (!t) return null;
    return t.replace(/晴/g, '晴れ').replace(/曇/g, 'くもり').replace(/後/g, 'のち').replace(/止む/g, 'やむ').replace(/朝の内/g, '朝のうち');
  }
  function zen(n) { return String(n).replace(/\d/g, function (c) { return ZEN[c]; }); }

  // ───────── 場所 → 気象庁の予報区
  function areaTable() { return shared(JMA + 'common/const/area.json', FOREVER, 'json'); }

  function locate(lat, lng, signal) {
    var byGsi = USE_GSI ? soft(guard(shared(GSI_REV + '?lat=' + lat.toFixed(5) + '&lon=' + lng.toFixed(5), TTL, 'json'), signal)) : Promise.resolve(null);
    return Promise.all([guard(areaTable(), signal), byGsi]).then(function (r) {
      var area = r[0], g = r[1], muni = g && g.results && g.results.muniCd;
      if (muni) {
        muni = String(muni); if (muni.length === 4) muni = '0' + muni;
        // 市区町村コード + "00" が気象庁の class20。政令市の区は市（例 01101→0110000）、分かれている町は全部（例 0120601〜）
        var c20s = Object.keys(area.class20s).filter(function (k) { return k.indexOf(muni) === 0; });
        if (!c20s.length) { var city = muni.slice(0, 4) + '0'; c20s = Object.keys(area.class20s).filter(function (k) { return k.indexOf(city) === 0; }); }
        if (c20s.length) {
          var c20 = area.class20s[c20s[0]], c15 = area.class15s[c20.parent];
          if (c15) {
            var pref = PREFS[+muni.slice(0, 2) - 1] || '';
            return { class20s: c20s, class10: c15.parent, nameJa: (pref ? pref + ' ' : '') + c20.name };
          }
        }
      }
      // 住所が取れないとき：気象庁の予報区（class15）の形の中に入っているかで決める
      return guard(shared(JMA + 'common/const/geojson/class15s.json', FOREVER, 'json'), signal).then(function (gj) {
        var code = findPolygon(gj, lat, lng);
        var c15 = code && area.class15s[code]; if (!c15) return null;
        var c10 = area.class10s[c15.parent], off = c10 && area.offices[c10.parent];
        return { class20s: c15.children || [], class10: c15.parent, nameJa: (off ? off.name + ' ' : '') + c15.name };
      });
    });
  }
  // 点が入っている形を探す。海沿いで少しはみ出したときのために、3km 以内のいちばん近い形も認める
  function findPolygon(gj, lat, lng) {
    var best = null, bestD = 3;
    (gj.features || []).forEach(function (f) {
      var g = f.geometry; if (!g) return;
      var polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      polys.forEach(function (poly) {
        var inside = false;
        poly.forEach(function (ring) {
          for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
            if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
            var d = distKm(lat, lng, yi, xi); if (d < bestD) { bestD = d; best = f.properties.code; }
          }
        });
        if (inside) { best = f.properties.code; bestD = -1; }
      });
    });
    return best;
  }

  // ───────── 予報（今日の天気・気温・降水確率）
  function parseForecast(f, class10, lat, lng, table, now) {
    var b0 = f && f[0]; if (!b0 || !b0.timeSeries) return null;
    function areaOf(ts) {
      if (!ts) return null;
      for (var i = 0; i < ts.areas.length; i++) if (ts.areas[i].area.code === class10) return ts.areas[i];
      return null;
    }
    var today = jstDay(now), out = { today: null, pops: [], code: null };
    var tw = b0.timeSeries[0], aw = areaOf(tw);
    if (aw) {
      for (var i = 0; i < tw.timeDefines.length; i++) {
        if (jstDay(new Date(tw.timeDefines[i])) === today) {
          out.code = aw.weatherCodes && aw.weatherCodes[i];
          out.today = { weatherJa: niceWeather(out.code) || (aw.weathers[i] || '').replace(/\s+/g, ''), maxC: null, minC: null };
          break;
        }
      }
    }
    var tp = b0.timeSeries[1], ap = areaOf(tp);
    if (ap) tp.timeDefines.forEach(function (t, i) {
      var from = new Date(t), to = tp.timeDefines[i + 1] ? new Date(tp.timeDefines[i + 1]) : new Date(from.getTime() + H6);
      var pct = num(ap.pops[i]);
      if (to > now && pct != null) out.pops.push({ from: from, to: to, pct: pct });
    });
    // 気温：予報に載っている観測点のうち、いちばん近いところ。00時＝朝の最低、09時＝日中の最高
    var tt = b0.timeSeries[2];
    if (tt && table && out.today) {
      var best = null, bd = Infinity;
      tt.areas.forEach(function (a) {
        var s = table[a.area.code]; if (!s) return;
        var d = distKm(lat, lng, s.lat[0] + s.lat[1] / 60, s.lon[0] + s.lon[1] / 60); if (d < bd) { bd = d; best = a; }
      });
      if (best) tt.timeDefines.forEach(function (t, i) {
        var d = new Date(t); if (jstDay(d) !== today) return;
        var v = num(best.temps[i]); if (v == null) return;
        if (jstHour(d) === 0) out.today.minC = v; else out.today.maxC = v;
      });
      // 朝・昼の発表では「朝の最低」の欄に最高気温が入っていることがある → 同じ値なら最低はなしにする
      if (out.today.minC != null && out.today.minC === out.today.maxC) out.today.minC = null;
    }
    return out;
  }

  // ───────── アメダス（いまの気温・雨が降っているか・日が照っているか）
  function amedas(lat, lng, signal) {
    return guard(shared(JMA + 'amedas/data/latest_time.txt', TTL, 'text'), signal).then(function (txt) {
      var at = new Date(txt.trim()); if (isNaN(at)) throw new Error('latest_time');
      var stamp = new Date(at.getTime() + JST).toISOString().replace(/\D/g, '').slice(0, 12) + '00';
      return Promise.all([guard(shared(JMA + 'amedas/const/amedastable.json', FOREVER, 'json'), signal),
        guard(shared(JMA + 'amedas/data/map/' + stamp + '.json', TTL, 'json'), signal)]).then(function (r) {
        var table = r[0], data = r[1], tBest = null, tD = 40, pBest = null, pD = 15;
        Object.keys(data).forEach(function (id) {
          var s = table[id]; if (!s) return;
          var d = distKm(lat, lng, s.lat[0] + s.lat[1] / 60, s.lon[0] + s.lon[1] / 60), o = data[id];
          if (o.temp && o.temp[1] === 0 && o.temp[0] != null && d < tD) { tD = d; tBest = id; }
          if (o.precipitation10m && o.precipitation10m[1] === 0 && d < pD) { pD = d; pBest = id; }
        });
        var t = tBest && data[tBest];
        return {
          table: table, observedAt: at,
          tempC: t ? t.temp[0] : null, stationJa: t ? table[tBest].kjName : null,
          sun10m: t && t.sun10m && t.sun10m[1] === 0 ? t.sun10m[0] : null,
          rain10m: pBest ? data[pBest].precipitation10m[0] : null
        };
      });
    });
  }

  // ───────── 降水ナウキャスト（いま〜60分先、5分ごと）
  function tileXY(lat, lng, z) {
    var n = Math.pow(2, z) * 256, s = Math.sin(lat * Math.PI / 180);
    return { x: (lng + 180) / 360 * n, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n };
  }
  function nowcastTimes(signal) {
    return Promise.all([guard(shared(JMA + 'jmatile/data/nowc/targetTimes_N1.json', 3 * MIN, 'json'), signal),
      guard(shared(JMA + 'jmatile/data/nowc/targetTimes_N2.json', 3 * MIN, 'json'), signal)]).then(function (r) {
      var n2 = (r[1] || []).filter(function (t) { return t.elements.indexOf('hrpns') >= 0; });
      var base = n2.length ? n2[0].basetime : r[0][0].basetime;
      var list = [{ basetime: base, validtime: base }].concat(n2.filter(function (t) { return t.basetime === base; }));
      list.sort(function (a, b) { return a.validtime < b.validtime ? -1 : 1; });
      return list;
    });
  }
  function tileUrl(basetime, validtime) {
    return JMA + 'jmatile/data/nowc/' + basetime + '/none/' + validtime + '/surf/hrpns/{z}/{x}/{y}.png';
  }
  // 絵の中の、その場所のまわり（5×5 マス＝約600m 四方）でいちばん強い雨を読む
  function readTile(blob, px, py) {
    var url = URL.createObjectURL(blob);
    return new Promise(function (res, rej) {
      var img = new Image();
      img.onload = function () {
        try {
          var c = document.createElement('canvas'); c.width = c.height = 5;
          var ctx = c.getContext('2d'); ctx.drawImage(img, 2 - px, 2 - py);
          var d = ctx.getImageData(0, 0, 5, 5).data, max = 0;
          for (var i = 0; i < d.length; i += 4) if (d[i + 3] > 0) max = Math.max(max, colorToMm(d[i], d[i + 1], d[i + 2]));
          res(max);
        } catch (e) { rej(e); } finally { URL.revokeObjectURL(url); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('tile image')); };
      img.src = url;
    });
  }
  function colorToMm(r, g, b) {
    var best = 0, bd = Infinity;
    RAIN_COLORS.forEach(function (c) { var d = (r - c[0]) * (r - c[0]) + (g - c[1]) * (g - c[1]) + (b - c[2]) * (b - c[2]); if (d < bd) { bd = d; best = c[3]; } });
    return bd < 3000 ? best : 0;
  }
  function nowcast(lat, lng, now, signal) {
    var p = tileXY(lat, lng, NOWC_Z), tx = Math.floor(p.x / 256), ty = Math.floor(p.y / 256);
    var px = Math.floor(p.x - tx * 256), py = Math.floor(p.y - ty * 256);
    return nowcastTimes(signal).then(function (list) {
      return pool(list, 4, function (t) {
        var url = tileUrl(t.basetime, t.validtime).replace('{z}', NOWC_Z).replace('{x}', tx).replace('{y}', ty);
        return guard(shared(url, TTL, 'blob'), signal).then(function (b) { return readTile(b, px, py); })
          .then(function (mm) { return { at: utcStamp(t.validtime), mm: mm }; }, function (e) { if (isAbort(e)) throw e; return null; });
      });
    }).then(function (steps) {
      // 最初の絵（解析＝いまの雨）を「いま」とみなし、何分後かはそこから数える（配信は5〜10分ほど遅れるため）
      if (!steps[0]) return null;
      var base = steps[0].at, raining = steps[0].mm > 0, starts = null, stops = null, max = 0;
      steps = steps.filter(Boolean);
      steps.forEach(function (s) {
        s.inMin = Math.round((s.at - base) / MIN);
        if (!raining && starts == null && s.mm > 0) starts = s.inMin;
        if (raining && stops == null && s.mm === 0) stops = s.inMin;
        max = Math.max(max, s.mm);
      });
      return { nowRaining: raining, startsInMin: raining ? 0 : starts, stopsInMin: stops,
        maxMmPerHour: max, levelJa: levelJaOf(raining ? steps[0].mm : max), observedAt: base, steps: steps };
    });
  }

  // ───────── 警報・注意報（市区町村ごと。住所が取れなかったときは予報区 class10 ごと）
  function warnings(office, loc, signal) {
    return guard(shared(JMA + 'warning/data/r8/' + office + '.json', TTL, 'json'), signal).then(function (w) {
      var blocks = Array.isArray(w) ? w : [w], found = {};
      blocks.forEach(function (b) {
        var ws = b && b.warning; if (!ws) return;
        var items = loc.class20s.length ? ws.class20Items : ws.class10Items, codes = loc.class20s.length ? loc.class20s : [loc.class10];
        (items || []).forEach(function (it) {
          if (codes.indexOf(it.areaCode) < 0) return;
          (it.kinds || []).forEach(function (k) {
            var t = k.code && WARN[k.code];
            if (!t || /解除|なし/.test(k.status || '')) return;
            var key = t[0];
            if (!found[key] || found[key].level < t[1]) found[key] = { nameJa: t[0] + WARN_SUFFIX[t[1]] + (t[2] ? '（レベル' + zen(t[1]) + '）' : ''), levelKey: WARN_KEY[t[1]], level: t[1] };
          });
        });
      });
      return Object.keys(found).map(function (k) { return found[k]; }).sort(function (a, b) { return b.level - a.level; });
    });
  }

  // ───────── いまの天気の言葉（観測からの言い換え。予報ではない）
  function currentWeatherJa(rain, am, fc, now) {
    var wet = (rain && rain.nowRaining) || (am && am.rain10m > 0);
    if (wet) return am && am.tempC != null && am.tempC <= 1 ? '雪' : '雨';
    var base = fc && fc.code ? String(fc.code).charAt(0) : null;
    var word = base === '1' ? '晴れ' : base ? 'くもり' : null; // 予報が雨でも、いま降っていなければ「くもり」
    if (am && am.sun10m != null) {
      if (am.sun10m >= 5) return '晴れ';
      var h = jstHour(now); if (am.sun10m === 0 && h >= 9 && h <= 15) return 'くもり';
    }
    return word;
  }

  // ───────── 本体
  var cache = {};
  function get(lat, lng, opts) {
    var signal = opts && opts.signal;
    if (typeof lat !== 'number' || typeof lng !== 'number' || !isFinite(lat) || !isFinite(lng))
      return Promise.reject(new WeatherError('場所がわからないので、天気を調べられません'));
    if (signal && signal.aborted) return Promise.reject(abortError());
    var key = lat.toFixed(2) + ',' + lng.toFixed(2), c = cache[key], now = new Date();
    if (c && now - c.t < TTL) return guard(c.p, signal);

    var p = locate(lat, lng, null).then(function (loc) {
      if (!loc) throw new WeatherError('この場所の天気はわかりません（日本の陸地とその近くだけで使えます）');
      return areaTable().then(function (area) {
        var c10 = area.class10s[loc.class10], office = c10 && c10.parent;
        if (!office) throw new WeatherError('この場所の天気予報の地域が見つかりませんでした');
        var amP = soft(amedas(lat, lng, null));
        var fcP = soft(shared(JMA + 'forecast/data/forecast/' + (FORECAST_OFFICE[office] || office) + '.json', TTL, 'json'));
        var tableP = amP.then(function (a) { return a ? a.table : soft(shared(JMA + 'amedas/const/amedastable.json', FOREVER, 'json')); });
        return Promise.all([amP, fcP, tableP, soft(nowcast(lat, lng, now, null)), soft(warnings(office, loc, null))]).then(function (r) {
          var am = r[0], fc = r[1] ? parseForecast(r[1], loc.class10, lat, lng, r[2], now) : null, rain = r[3], warn = r[4];
          if (!am && !fc && !rain && !warn) throw new WeatherError('天気の情報を取れませんでした。電波の良い所で、もう一度お試しください');
          var wj = currentWeatherJa(rain, am, fc, now);
          return {
            areaNameJa: loc.nameJa,
            current: (am && am.tempC != null) || wj ? { weatherJa: wj, tempC: am ? am.tempC : null, observedAt: am ? am.observedAt : null, stationJa: am ? am.stationJa : null } : null,
            today: fc ? fc.today : null,
            pops: fc ? fc.pops : [],
            rain: rain,
            warnings: warn || [],
            sourceJa: '気象庁', fetchedAt: new Date()
          };
        });
      });
    }).then(null, function (e) {
      delete cache[key];
      if (e instanceof WeatherError || isAbort(e)) throw e;
      throw new WeatherError('天気の情報を取れませんでした。電波の良い所で、もう一度お試しください', e);
    });
    cache[key] = { t: now.getTime(), p: p };
    return guard(p, signal);
  }

  // 歩く時間（startDate から minutes 分）に雨が降りそうか
  function rainDuring(info, startDate, minutes) {
    var s = (startDate instanceof Date ? startDate : new Date()).getTime(), e = s + Math.max(0, minutes || 0) * MIN;
    var maxPct = null;
    ((info && info.pops) || []).forEach(function (p) {
      if (p.from.getTime() < e && p.to.getTime() > s) maxPct = Math.max(maxPct == null ? 0 : maxPct, p.pct);
    });
    // ナウキャストの各コマは「取得した時刻 + inMin 分後」からの5分間とみなす
    var rain = info && info.rain, wet = null, t0 = info && info.fetchedAt ? info.fetchedAt.getTime() : Date.now();
    if (rain && rain.steps) rain.steps.forEach(function (st) {
      var t = t0 + (st.inMin || 0) * MIN;
      if (!wet && st.mm > 0 && t + 5 * MIN > s && t < e) wet = st;
    });
    var pctTxt = maxPct != null ? '（降水確率 ' + maxPct + '%）' : '';
    if (wet) {
      var inMin = Math.round((t0 + wet.inMin * MIN - Math.max(s, Date.now())) / MIN);
      var lv = levelJaOf(wet.mm) || '雨';
      return { likely: true, maxPct: maxPct, messageJa: (wet.inMin === 0 && inMin <= 5 ? 'いま' + lv + 'が降っています。' : inMin <= 5 ? 'まもなく雨が降り出しそうです。' : '約' + inMin + '分後に雨が降り出しそうです。') + 'かさを持って行きましょう' };
    }
    if (maxPct != null && maxPct >= 50) return { likely: true, maxPct: maxPct, messageJa: '歩いている間に雨が降りそうです' + pctTxt + '。かさを持って行きましょう' };
    if (maxPct == null && !rain) return { likely: false, maxPct: null, messageJa: '雨の情報を取れませんでした' };
    return { likely: false, maxPct: maxPct, messageJa: '歩いている間は雨の心配は少なそうです' + pctTxt };
  }

  // 地図に重ねる雨雲レーダー（いまの解析雨量の絵。Leaflet なら maxNativeZoom: 10 で使う）
  function radar() {
    return nowcastTimes(null).then(function (list) {
      var t = list[0];
      return { tileUrl: tileUrl(t.basetime, t.validtime), timeLabelJa: hhmm(utcStamp(t.validtime)) + ' の雨雲', attributionJa: '雨雲レーダー：気象庁', maxNativeZoom: NOWC_Z };
    }).then(null, function () { return null; });
  }

  global.Weather = { get: get, rainDuring: rainDuring, radar: radar, WeatherError: WeatherError };
})(window);
