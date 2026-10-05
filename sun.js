/* sun.js — 日の出・日の入り（ぐるっとさんぽ）
 *
 * Sun.times(date, lat, lng) → { dawn, sunrise, sunset, dusk, solarNoon }（すべて Date）
 *   dawn / dusk = 市民薄明（太陽の高さ -6°）＝空がまだ明るい時間の境目
 *   sunrise / sunset = 太陽の上のふちが地平線に見える時（高さ -0.833°。大気のゆがみを含む）
 *   白夜・極夜などで起こらないものは null
 * Sun.isDark(date, lat, lng) → true（夜明け前・日没後で暗い）/ false
 *
 * 計算：太陽の位置の標準的な近似式（天文年鑑の簡易式）で、高さが決まった値になる時刻を二分法で探す。国立天文台の表と ±1 分ほど。
 * 依存なし。window.Sun だけを公開する。
 */
(function (global) {
  'use strict';

  var PI = Math.PI, RAD = PI / 180, DAY_MS = 86400000;
  var J1970 = 2440588, J2000 = 2451545;

  function toJulian(date) { return date.getTime() / DAY_MS - 0.5 + J1970; }
  function fromJulian(j) { return new Date((j + 0.5 - J1970) * DAY_MS); }
  function toDays(date) { return toJulian(date) - J2000; }

  // 太陽の位置（天文年鑑の簡易式。誤差 0.01° ほど）。d → { dec, ra }（ラジアン）
  function sunPos(d) { // d = J2000 からの日数
    var L = RAD * (280.460 + 0.9856474 * d);
    var g = RAD * (357.528 + 0.9856003 * d);
    var lam = L + RAD * (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g));
    var eps = RAD * (23.439 - 0.0000004 * d);
    return {
      dec: Math.asin(Math.sin(eps) * Math.sin(lam)),
      ra: Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam))
    };
  }
  // 時角 H（ラジアン、-π〜π）。lng は東経（度）
  function hourAngleAt(d, lng, ra) {
    var h = RAD * (280.46061837 + 360.98564736629 * d + lng) - ra;
    h = h % (2 * PI);
    if (h > PI) h -= 2 * PI; else if (h < -PI) h += 2 * PI;
    return h;
  }
  function altitudeAt(d, lat, lng) {
    var p = sunPos(d), H = hourAngleAt(d, lng, p.ra), phi = RAD * lat;
    return Math.asin(Math.sin(phi) * Math.sin(p.dec) + Math.cos(phi) * Math.cos(p.dec) * Math.cos(H));
  }

  function valid(date, lat, lng) {
    return date instanceof Date && !isNaN(date.getTime()) &&
      typeof lat === 'number' && typeof lng === 'number' &&
      isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90;
  }

  // lo〜hi の間で、太陽の高さが target をよこぎる時刻を二分法で探す（よこぎらなければ null）
  function crossing(lo, hi, target, lat, lng) {
    var flo = altitudeAt(lo, lat, lng) - target, fhi = altitudeAt(hi, lat, lng) - target;
    if (flo === 0) return lo;
    if (flo * fhi > 0) return null;
    for (var i = 0; i < 40; i++) {
      var mid = (lo + hi) / 2, fm = altitudeAt(mid, lat, lng) - target;
      if (fm * flo > 0) { lo = mid; flo = fm; } else { hi = mid; }
    }
    return (lo + hi) / 2;
  }

  function times(date, lat, lng) {
    var out = { dawn: null, sunrise: null, sunset: null, dusk: null, solarNoon: null };
    if (!valid(date, lat, lng)) return out;

    // いちばん近い「太陽が真南に来る時」を求める（日付をまたいでも、その場所の太陽の1日で答える）
    var d = toDays(date);
    var noon = Math.round(d + lng / 360) - lng / 360; // おおよその真南（UTC の正午から経度ぶんずらす）
    for (var i = 0; i < 4; i++) {
      var p = sunPos(noon);
      noon -= hourAngleAt(noon, lng, p.ra) / (2 * PI) * 0.99727; // 1太陽日 ≒ 0.99727 恒星日
    }
    out.solarNoon = fromJulian(noon + J2000);

    function pair(deg) {
      var t = RAD * deg;
      var set = crossing(noon, noon + 0.5, t, lat, lng);
      var rise = crossing(noon - 0.5, noon, t, lat, lng);
      return [rise, set];
    }
    function toDate(x) { return x === null ? null : fromJulian(x + J2000); }
    var sun = pair(-0.833), civil = pair(-6);
    out.sunrise = toDate(sun[0]); out.sunset = toDate(sun[1]);
    out.dawn = toDate(civil[0]); out.dusk = toDate(civil[1]);
    return out;
  }

  // 太陽の高さが -6° より下なら暗い（極地の白夜でも正しく false になる）
  function isDark(date, lat, lng) {
    if (!valid(date, lat, lng)) return false;
    return altitudeAt(toDays(date), lat, lng) < RAD * -6;
  }

  global.Sun = { times: times, isDark: isDark };
})(typeof window !== 'undefined' ? window : this);
