/* music.js — 歩きながら流す音楽（ぐるっとさんぽ）
 *
 * 公開するのは window.Music だけ。依存なし。曲の一覧は music/list.json（形は 設計メモ.md「追加4」）。
 *
 *   Music.load([url])            → Promise<一覧>（失敗しても reject しない。失敗時は {categories:[]} と 'error'）
 *   Music.play(categoryKey, {shuffle}) → Promise<true|false>。最初の1回は必ずボタンを押した処理の中で呼ぶ
 *   Music.pause() / resume() / next() / prev() / stop()
 *   Music.setVolume(0〜1) / getVolume() / volumeSupported()（iPhone・iPad は false → 本体の音量ボタンで調整）
 *   Music.isPlaying() / current() → {track, categoryKey} / lastCategory()
 *   Music.duck(true|false)       音声案内の間だけ音楽を小さくする（何度呼んでもよい）
 *   Music.on('track'|'state'|'error', fn) → 登録を外す関数
 *     track: {track, categoryKey, index, total}
 *     state: {state:'loading'|'playing'|'paused'|'stopped', track, categoryKey}
 *     error: {code, messageJa, track}   code = load|nocategory|blocked|network|decode|unsupported|allfailed
 *   Music.credits() → [{id, title, artist, license, licenseUrl, sourceUrl, categoryKey, attributionJa}]（load() のあと）
 *   Music.config({duckMode:'auto'|'volume'|'pause', duckLevel:0〜1})（ふつうは使わない。テスト用）
 *
 * ■ 鳴らし方の方針（2026-10-05 調査して決定）
 *   - 音は <audio> 1つだけで鳴らす。画面を消しても・ほかのアプリに切り替えても続きやすく、
 *     ロック画面の操作（Media Session）にもつながるのは、ふつうの audio 要素で鳴らしたときだけ。
 *   - Web Audio（AudioContext＝ブラウザの中の音の調整卓のこと）は **使わない**。
 *     createMediaElementSource で audio を Web Audio に通すと、iPhone では画面を消した・別のアプリに
 *     移ったときに AudioContext が止められて音楽も止まる（WebKit の不具合。iOS 17.5 で
 *     navigator.audioSession.type='playback' のときだけ直ったが、それより古い iPhone では止まる）。
 *     しかも一度 Web Audio に通した audio は元に戻せないので「画面が見えている間だけ Web Audio」もできない。
 *     Android の Chrome でも、Web Audio だけで出した音はお知らせ欄・ロック画面の操作が出ない。
 *   - そこで：
 *     ・audio.volume が効く端末（Android・パソコン）… 音量と音楽を小さくする（duck）は audio.volume を
 *       少しずつ変えて行う（約0.3秒で20%に下げ、約0.5秒で戻す）。
 *     ・audio.volume が効かない端末（iPhone・iPad。音量は読み出すと常に 1）… 音量は本体の音量ボタンにまかせ、
 *       duck は「案内の間だけ一時停止 → 終わったら再開」にする。ただし画面が消えている間は一時停止しない
 *       （ロック中に止めると、ボタンを押していないので再開できなくなることがあるため）。
 *     ・案内の終わりの知らせ（duck(false)）が来ないことがあるので、20秒たったら自動で元に戻す。
 *   - 曲の終わり（ended）では、すぐ次の曲の src を入れて play() するだけにする（画面ロック中は
 *     JS の動きが遅くなるため、最小限にしている）。
 *   - 通信の節約：再生するまで preload='none'。次の曲は「曲の情報（長さなど）」だけ先に読む
 *     （データセーバーが ON なら読まない）。
 *
 * ■ 実機で確かめること（ヘッドレス Chrome では確かめられない）
 *   - iPhone Safari・Android Chrome で、画面を消した／別のアプリに移ったあとも曲が続き、次の曲に進むか
 *   - ロック画面・お知らせ欄に曲名・画像・再生／一時停止／次／前が出て、押すと効くか
 *   - iPhone で音声案内のとき一時停止→再開がうまくいくか（音声案内と同時に鳴らない・止まったままにならない）
 *   - 電話・Siri などで止まったあと、再生ボタンで戻れるか
 */
(function (global) {
  'use strict';

  var STORE_KEY = 'sanpo.music';
  var DEFAULT_LIST_URL = 'music/list.json';
  var DUCK_LEVEL = 0.2;          // 案内中の音量（ふだんの何倍か）
  var DUCK_DOWN_MS = 300, DUCK_UP_MS = 500;
  var DUCK_SAFETY_MS = 20000;    // duck(false) が来なくても、これだけたったら元に戻す
  var PREV_RESTART_SEC = 3;      // これより進んでいたら「前へ」は曲の頭に戻る

  /* ---------- 小さな道具 ---------- */
  function safe(fn) { try { return fn(); } catch (e) { return undefined; } }
  function clamp01(v) { v = Number(v); if (!isFinite(v)) return 1; return v < 0 ? 0 : v > 1 ? 1 : v; }

  function loadStore() {
    var s = safe(function () { return JSON.parse(global.localStorage.getItem(STORE_KEY) || 'null'); });
    return (s && typeof s === 'object') ? s : {};
  }
  function saveStore() {
    safe(function () {
      global.localStorage.setItem(STORE_KEY, JSON.stringify({ category: lastCat, volume: volume }));
    });
  }

  function isIOS() {
    var ua = (global.navigator && navigator.userAgent) || '';
    if (/iPhone|iPad|iPod/.test(ua)) return true;
    // iPadOS は Mac のふりをするので、タッチできる Mac は iPad とみなす
    return /Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1;
  }
  // audio.volume が本当に効くか（iPhone では書いても 1 のまま）
  function detectVolumeSupport() {
    if (isIOS()) return false;
    return !!safe(function () {
      var a = document.createElement('audio');
      a.volume = 0.5;
      return Math.abs(a.volume - 0.5) < 0.01;
    });
  }

  // 無音の短い WAV（リストを読みこむ前に「ボタンを押した中で」audio を使えるようにしておくため）
  function silentWavUrl() {
    var n = 800, rate = 8000, buf = [], i;
    function u32(v) { buf.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255); }
    function u16(v) { buf.push(v & 255, (v >> 8) & 255); }
    function str(s) { for (var k = 0; k < s.length; k++) buf.push(s.charCodeAt(k)); }
    str('RIFF'); u32(36 + n); str('WAVE'); str('fmt '); u32(16); u16(1); u16(1); u32(rate); u32(rate); u16(1); u16(8);
    str('data'); u32(n);
    for (i = 0; i < n; i++) buf.push(128);
    var bin = '';
    for (i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    return 'data:audio/wav;base64,' + global.btoa(bin);
  }

  /* ---------- 状態 ---------- */
  var stored = loadStore();
  var volume = (typeof stored.volume === 'number') ? clamp01(stored.volume) : 1;
  var lastCat = (typeof stored.category === 'string') ? stored.category : null;

  var listData = null, listPromise = null, listUrl = null;
  var catKey = null, cat = null;     // 今のカテゴリ
  var order = [], pos = 0, shuffle = true;
  var curTrack = null;
  var failed = {};                   // 再生できなかった曲（id → true）。このページの間はとばす
  var failStreak = 0;
  var loadToken = 0;                 // 曲を入れかえるたびに増やす（古い曲のエラー・Promise を無視するため）
  var wantPlay = false;              // 再生していたい（ユーザーの操作の結果）
  var userState = 'stopped';
  var audio = null, pre = null;      // pre = 次の曲の情報だけ先に読む用
  var volumeOk = null, duckModeOpt = 'auto', duckLevel = DUCK_LEVEL;
  var ducked = false, duckPaused = false, duckFactor = 1, fadeTimer = null, duckSafetyTimer = null;
  var listeners = { track: [], state: [], error: [] };

  function duckMode() {
    if (duckModeOpt === 'volume' || duckModeOpt === 'pause') return duckModeOpt;
    if (volumeOk === null) volumeOk = detectVolumeSupport();
    return volumeOk ? 'volume' : 'pause';
  }

  function emit(name, payload) {
    var ls = (listeners[name] || []).slice();
    for (var i = 0; i < ls.length; i++) {
      try { ls[i](payload); } catch (e) { if (global.console) console.error('[Music] listener error', e); }
    }
  }
  function setState(s) {
    userState = s;
    emit('state', { state: s, track: curTrack, categoryKey: catKey });
    safe(function () {
      if (navigator.mediaSession) {
        navigator.mediaSession.playbackState = s === 'playing' || s === 'loading' ? 'playing' : s === 'paused' ? 'paused' : 'none';
      }
    });
  }
  function error(code, messageJa, track) {
    emit('error', { code: code, messageJa: messageJa, track: track || null });
  }
  function trackName(t) { return t && t.title ? '「' + t.title + '」' : ''; }

  /* ---------- audio 要素 ---------- */
  function ensureAudio() {
    if (audio) return audio;
    audio = document.createElement('audio');
    audio.preload = 'none';
    audio.setAttribute('playsinline', '');
    audio.setAttribute('webkit-playsinline', '');
    // 曲の終わり：すぐ次の曲へ（ロック中でも動くよう、ここは最小限）
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('playing', function () {
      if (audio.src === silentSrc) return;
      failStreak = 0;
      if (wantPlay && userState !== 'playing') setState('playing');
    });
    audio.addEventListener('waiting', function () { if (wantPlay && userState === 'playing') setState('loading'); });
    audio.addEventListener('pause', function () {
      // 曲の終わり・曲の入れかえ・案内中の一時停止は「止められた」ではない
      if (!audio.paused || audio.ended || switching || duckPaused || !wantPlay || audio.src === silentSrc) return;
      // 電話・ロック画面の一時停止・ほかのアプリなど、外から止められた
      wantPlay = false;
      setState('paused');
    });
    audio.addEventListener('error', function () { onTrackError(loadToken, mediaErrorCode()); });
    audio.addEventListener('loadedmetadata', updatePosition);
    applyVolume();
    setupMediaSession();
    return audio;
  }
  var silentSrc = null;
  var switching = false;

  function mediaErrorCode() {
    var e = audio && audio.error;
    if (!e) return 'network';
    if (e.code === 2) return 'network';
    if (e.code === 3) return 'decode';
    if (e.code === 4) return 'unsupported';
    return 'network';
  }

  function applyVolume() {
    if (!audio) return;
    if (duckMode() !== 'volume') return; // iPhone では効かないので触らない
    safe(function () { audio.volume = clamp01(volume * duckFactor); });
  }

  /* ---------- 一覧 ---------- */
  function resolveUrl(rel, base) {
    return safe(function () { return new URL(rel, base).href; }) || rel;
  }
  function trackUrl(t) {
    var f = String(t.file || '');
    if (/^(https?:|data:|blob:|\/)/.test(f) || /^music\//.test(f)) return resolveUrl(f, document.baseURI);
    return resolveUrl(f, listUrl || resolveUrl(DEFAULT_LIST_URL, document.baseURI)); // list.json からの相対
  }

  function load(url) {
    if (listPromise && !url) return listPromise;
    listUrl = resolveUrl(url || DEFAULT_LIST_URL, document.baseURI);
    listPromise = fetch(listUrl, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      var cats = (j && Array.isArray(j.categories)) ? j.categories : [];
      cats.forEach(function (c) { if (!Array.isArray(c.tracks)) c.tracks = []; });
      listData = { categories: cats };
      return listData;
    }).catch(function () {
      listPromise = null; // 次にもう一度ためせるように
      error('load', '曲の一覧を読みこめませんでした。電波のよい所でもう一度ためしてください。');
      return { categories: [] };
    });
    return listPromise;
  }

  function findCat(key) {
    if (!listData) return null;
    for (var i = 0; i < listData.categories.length; i++) {
      if (listData.categories[i].key === key) return listData.categories[i];
    }
    return null;
  }

  function makeOrder(n, avoidFirst) {
    var a = [], i;
    for (i = 0; i < n; i++) a.push(i);
    if (shuffle) {
      for (i = n - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
      // ひと回りしたとき、同じ曲が2回続かないように
      if (n > 1 && avoidFirst != null && a[0] === avoidFirst) { a[0] = a[1]; a[1] = avoidFirst; }
    }
    return a;
  }

  /* ---------- 曲の入れかえ ---------- */
  // step: +1 次 / -1 前 / 0 今の pos。とばす曲をよけて pos を決める。全部だめなら -1
  function pickPos(fromPos, step) {
    var n = order.length;
    if (!n) return -1;
    var p = fromPos;
    for (var tries = 0; tries <= n; tries++) {
      if (step !== 0 || tries > 0) {
        var s = step === 0 ? 1 : step;
        p += s;
        if (p >= n) {
          // ひと回りした：シャッフルなら並べ直す
          var last = order[n - 1];
          if (shuffle) order = makeOrder(n, last);
          p = 0;
        } else if (p < 0) p = n - 1;
      }
      var t = cat.tracks[order[p]];
      if (t && !failed[t.id || t.file]) return p;
    }
    return -1;
  }

  function startAt(p) {
    if (p < 0) {
      allFailed();
      return Promise.resolve(false);
    }
    pos = p;
    curTrack = cat.tracks[order[pos]];
    var a = ensureAudio();
    var token = ++loadToken;
    wantPlay = true;
    switching = true;
    a.preload = 'auto';
    a.src = trackUrl(curTrack);
    var pr = safe(function () { return a.play(); });
    switching = false;
    setMetadata(curTrack);
    emit('track', { track: curTrack, categoryKey: catKey, index: pos, total: order.length });
    setState('loading');
    preloadNext();
    return handlePlayPromise(pr, token);
  }

  function handlePlayPromise(pr, token) {
    if (!pr || typeof pr.then !== 'function') return Promise.resolve(true);
    return pr.then(function () { return true; }, function (e) {
      if (token !== loadToken) return false; // もう別の曲に変わった
      var name = e && e.name;
      if (name === 'AbortError') return false;
      if (name === 'NotAllowedError') {
        wantPlay = false;
        setState('paused');
        error('blocked', '音楽を流せませんでした。もう一度「再生」ボタンを押してください。', curTrack);
        return false;
      }
      // NotSupportedError など：その曲をとばす（'error' イベントでも来るが token で1回にまとめる）
      onTrackError(token, name === 'NotSupportedError' ? 'unsupported' : 'network');
      return false;
    });
  }

  var handledErrorToken = -1;
  function onTrackError(token, code) {
    if (!audio || audio.src === silentSrc || !curTrack || !cat) return;
    if (token !== loadToken || handledErrorToken === token) return;
    handledErrorToken = token;
    var t = curTrack;
    failed[t.id || t.file] = true;
    failStreak++;
    if (code !== 'decode' && global.navigator && navigator.onLine === false) code = 'network';
    var msg = code === 'network'
      ? '通信がうまくいかず、曲' + trackName(t) + 'を読みこめませんでした。次の曲にします。'
      : code === 'decode'
        ? '曲' + trackName(t) + 'のファイルがこわれていて再生できませんでした。次の曲にします。'
        : '曲' + trackName(t) + 'を読みこめませんでした（通信が悪いか、ファイルがありません）。次の曲にします。';
    error(code, msg, t);
    if (!wantPlay) return;
    if (failStreak > order.length) { allFailed(); return; }
    startAt(pickPos(pos, 1));
  }

  function allFailed() {
    wantPlay = false;
    safe(function () { audio && audio.pause(); });
    error('allfailed', 'この種類の曲はどれも再生できませんでした。電波のよい所でもう一度ためしてください。', null);
    curTrack = null;
    setState('stopped');
  }

  function onEnded() {
    if (!wantPlay || !cat) return;
    // まず次の曲を鳴らす（ロック中でも続くよう、ほかの処理はあと）
    var p = pickPos(pos, 1);
    if (p < 0) { allFailed(); return; }
    startAt(p);
  }

  function preloadNext() {
    safe(function () {
      var c = navigator.connection;
      if (c && c.saveData) return; // データセーバー ON
      if (!cat || order.length < 2) return;
      var n = pos + 1 < order.length ? order[pos + 1] : null; // ひと回りの境目は並べ直すので読まない
      if (n == null) return;
      var t = cat.tracks[n];
      if (!t || failed[t.id || t.file]) return;
      if (!pre) { pre = document.createElement('audio'); pre.muted = true; pre.preload = 'metadata'; }
      var u = trackUrl(t);
      if (pre.src !== u) pre.src = u;
    });
  }

  /* ---------- Media Session（ロック画面・お知らせ欄の表示と操作） ---------- */
  function setupMediaSession() {
    if (!global.navigator || !navigator.mediaSession) return;
    var ms = navigator.mediaSession;
    var acts = {
      play: function () { resume(); },
      pause: function () { pause(); },
      nexttrack: function () { next(); },
      previoustrack: function () { prev(); },
      stop: function () { stop(); }
    };
    Object.keys(acts).forEach(function (k) { safe(function () { ms.setActionHandler(k, acts[k]); }); });
  }
  function setMetadata(t) {
    safe(function () {
      if (!navigator.mediaSession || typeof global.MediaMetadata !== 'function') return;
      navigator.mediaSession.metadata = new global.MediaMetadata({
        title: t.title || '音楽',
        artist: t.artist || '',
        album: 'ぐるっとさんぽ',
        artwork: [
          { src: resolveUrl('img/icon-192.png', document.baseURI), sizes: '192x192', type: 'image/png' },
          { src: resolveUrl('img/icon-512.png', document.baseURI), sizes: '512x512', type: 'image/png' }
        ]
      });
    });
  }
  function updatePosition() {
    safe(function () {
      var ms = navigator.mediaSession;
      if (!ms || !ms.setPositionState || !audio || !isFinite(audio.duration)) return;
      ms.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate || 1, position: Math.min(audio.currentTime, audio.duration) });
    });
  }

  /* ---------- 公開する操作 ---------- */
  function play(key, opts) {
    try {
      opts = opts || {};
      var a = ensureAudio();
      if (typeof opts.shuffle === 'boolean') shuffle = opts.shuffle;
      if (!listData) {
        // 一覧がまだ：ボタンを押したこの瞬間に無音を鳴らして audio を使える状態にしておく（iPhone 対策）
        if (!silentSrc) silentSrc = silentWavUrl();
        switching = true;
        a.src = silentSrc;
        safe(function () { var p = a.play(); if (p && p.catch) p.catch(function () {}); });
        switching = false;
        setState('loading');
        var token = ++loadToken;
        return load().then(function () {
          if (token !== loadToken) return false; // その間に別の操作があった
          if (!listData) { setState('stopped'); return false; }
          return play(key, opts);
        });
      }
      var c = findCat(key);
      if (!c) {
        error('nocategory', '音楽の種類が見つかりませんでした。', null);
        return Promise.resolve(false);
      }
      if (!c.tracks.length) {
        error('allfailed', 'この種類には曲がありません。', null);
        return Promise.resolve(false);
      }
      cat = c; catKey = key; lastCat = key; saveStore();
      order = makeOrder(c.tracks.length, null);
      failStreak = 0;
      return startAt(pickPos(0, 0));
    } catch (e) {
      return Promise.resolve(false);
    }
  }

  function pause() {
    try {
      wantPlay = false;
      duckPaused = false;
      if (audio) audio.pause();
      if (userState !== 'stopped') setState('paused');
    } catch (e) {}
  }

  function resume() {
    try {
      if (!cat) {
        if (lastCat) return play(lastCat, {});
        return Promise.resolve(false);
      }
      if (!curTrack) return startAt(pickPos(pos, 0));
      var a = ensureAudio();
      if (!a.src || a.src === silentSrc) return startAt(pickPos(pos, 0));
      wantPlay = true;
      duckPaused = false;
      var pr = safe(function () { return a.play(); });
      setState(a.readyState >= 3 ? 'playing' : 'loading');
      return handlePlayPromise(pr, loadToken);
    } catch (e) { return Promise.resolve(false); }
  }

  function next() {
    try {
      if (!cat) return Promise.resolve(false);
      failStreak = 0;
      return startAt(pickPos(pos, 1));
    } catch (e) { return Promise.resolve(false); }
  }

  function prev() {
    try {
      if (!cat) return Promise.resolve(false);
      if (audio && curTrack && audio.currentTime > PREV_RESTART_SEC) {
        audio.currentTime = 0;
        if (!wantPlay) return resume();
        return Promise.resolve(true);
      }
      failStreak = 0;
      return startAt(pickPos(pos, -1));
    } catch (e) { return Promise.resolve(false); }
  }

  function stop() {
    try {
      wantPlay = false;
      duckPaused = false;
      loadToken++;
      if (audio) {
        switching = true;
        audio.pause();
        audio.removeAttribute('src');
        safe(function () { audio.load(); }); // 通信を止める
        audio.preload = 'none';
        switching = false;
      }
      if (pre) { pre.removeAttribute('src'); safe(function () { pre.load(); }); }
      curTrack = null;
      safe(function () { if (navigator.mediaSession) navigator.mediaSession.metadata = null; });
      setState('stopped');
    } catch (e) {}
  }

  function setVolume(v) {
    try {
      volume = clamp01(v);
      saveStore();
      if (!fadeTimer) applyVolume();
    } catch (e) {}
  }

  /* ---------- 音声案内の間だけ小さく ---------- */
  function fadeTo(target, ms) {
    if (fadeTimer) { clearInterval(fadeTimer); fadeTimer = null; }
    // 画面が消えているとタイマーが遅れるので、すぐに切りかえる
    if (document.hidden || ms <= 0) { duckFactor = target; applyVolume(); return; }
    var start = duckFactor, t0 = Date.now();
    fadeTimer = setInterval(function () {
      var k = Math.min(1, (Date.now() - t0) / ms);
      duckFactor = start + (target - start) * k;
      applyVolume();
      if (k >= 1) { clearInterval(fadeTimer); fadeTimer = null; }
    }, 30);
  }

  function duck(on) {
    try {
      on = !!on;
      if (duckSafetyTimer) { clearTimeout(duckSafetyTimer); duckSafetyTimer = null; }
      if (on) duckSafetyTimer = setTimeout(function () { duck(false); }, DUCK_SAFETY_MS);
      if (on === ducked) return;
      ducked = on;
      if (duckMode() === 'volume') {
        fadeTo(on ? duckLevel : 1, on ? DUCK_DOWN_MS : DUCK_UP_MS);
        return;
      }
      // iPhone：一時停止 → 再開
      if (on) {
        if (audio && wantPlay && !audio.paused && !document.hidden) {
          duckPaused = true;
          audio.pause();
        }
      } else if (duckPaused) {
        duckPaused = false;
        if (audio && wantPlay) {
          var p = safe(function () { return audio.play(); });
          if (p && p.catch) p.catch(function () {});
        }
      }
    } catch (e) {}
  }

  function credits() {
    try {
      if (!listData) return [];
      var out = [], seen = {};
      listData.categories.forEach(function (c) {
        c.tracks.forEach(function (t) {
          var id = t.id || t.file;
          if (seen[id]) return;
          seen[id] = true;
          var lic = t.license || '';
          var pd = /CC0|public\s*domain|パブリックドメイン/i.test(lic);
          var aj = t.attributionJa || ('「' + (t.title || '') + '」' + (t.artist ? ' ' + t.artist : '') +
            '（' + (lic || 'ライセンス不明') + (pd ? '・著作権の心配なし' : '') + '）');
          out.push({ id: id, title: t.title || '', artist: t.artist || '', license: lic,
            licenseUrl: t.licenseUrl || '', sourceUrl: t.sourceUrl || '', categoryKey: c.key, attributionJa: aj });
        });
      });
      return out;
    } catch (e) { return []; }
  }

  function on(name, fn) {
    try {
      if (!listeners[name] || typeof fn !== 'function') return function () {};
      listeners[name].push(fn);
      return function () { var i = listeners[name].indexOf(fn); if (i >= 0) listeners[name].splice(i, 1); };
    } catch (e) { return function () {}; }
  }

  global.Music = {
    load: function (url) { try { return load(url); } catch (e) { return Promise.resolve({ categories: [] }); } },
    play: play,
    pause: pause,
    resume: resume,
    next: next,
    prev: prev,
    stop: stop,
    setVolume: setVolume,
    getVolume: function () { return volume; },
    volumeSupported: function () { return duckMode() === 'volume'; },
    isPlaying: function () { return wantPlay && userState !== 'stopped' && userState !== 'paused'; },
    current: function () { return { track: curTrack, categoryKey: catKey || lastCat }; },
    lastCategory: function () { return lastCat; },
    duck: duck,
    on: on,
    credits: credits,
    config: function (o) {
      try {
        o = o || {};
        if (o.duckMode) duckModeOpt = o.duckMode;
        if (typeof o.duckLevel === 'number') duckLevel = clamp01(o.duckLevel);
      } catch (e) {}
    }
  };
})(window);
