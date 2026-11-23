'use strict';
/*
 * プレーヤーの操作と、音から波への変換。
 */
(function () {
  const $ = (s) => document.querySelector(s);
  const audio = $('#audio');
  const canvas = $('#water');
  const seek = $('#seek');
  const volume = $('#volume');
  const playBtn = $('#play');
  const fileInput = $('#file');
  const listEl = $('#playlist-items');
  const playlist = $('#playlist');
  const listBtn = $('#list-btn');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

  /** @type {{name:string, url:string}[]} */
  let tracks = [];
  let index = -1;

  // ---------- 水面 ----------
  let water = null;
  try {
    water = new Water(canvas);
  } catch (e) {
    const el = $('#gl-error');
    el.textContent = 'この端末やブラウザでは水面を描けませんでした。最新の Chrome か Safari で開いてください。(' + e.message + ')';
    el.hidden = false;
  }
  const analyzer = new Analyzer(audio);

  const cd = { x: 0, y: 0, radius: 0, rotation: 0, speed: 0, bob: 0, kick: 0, damp: 0.995, time: 0, wind: 1, mood: 0, flash: 0 };

  // 重い端末では、描画の解像度を下げる(画質を自動で落とす仕組みが変える)
  let dprScale = 1;

  function resize() {
    if (!water) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * dprScale;
    water.resize(innerWidth, innerHeight, dpr);
    const [w, h] = water.size;
    cd.x = w / 2;
    // 操作バーのぶん少し上に置き、見た目の中央に合わせる
    cd.y = h / 2 + Math.min(h * 0.04, 40 / water.cellPx);
    cd.radius = Math.min(w, h) * 0.16;
  }
  let resizeTimer = 0;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 120);
  });
  resize();

  // ---------- 音から波へ ----------
  let prevBass = 0;
  let ambientAt = 0;
  let last = performance.now();

  function drive(now) {
    const t = now / 1000;
    const a = analyzer.update(t);
    const playing = !audio.paused;
    // 「視差効果を減らす」設定では波を穏やかにする
    const gain = reduceMotion.matches ? 0.45 : 1;
    const R = cd.radius;

    // 盛り上がり(0〜1)の二乗で効かせ、静かな所はより静かにする
    const I = playing ? a.intensity : 0;
    const e = 0.12 + 0.88 * I * I;

    if (playing) {
      if (a.beat) {
        const s = a.accent;
        // 拍: CD が沈み込むように、縁のすぐ外を押し下げる。強い拍ほど深く、波長の長いうねりにする
        // 幅を負にすると、山と谷が 1 組の鋭い輪になり、ほかの細かい波と見分けやすい
        water.addDrop(cd.x, cd.y, R * 1.1, -(0.25 + 1.7 * s * s) * e * gain, -(1.8 + 4.5 * s * I));
        cd.kick = Math.max(cd.kick, s * e);
        cd.flash = Math.max(cd.flash, s * s * I);
        // 山場の強い拍では、CD の周りにしぶきを散らす
        if (s > 0.8 && I > 0.65) {
          for (let k = 0; k < 7; k++) {
            const th = Math.random() * Math.PI * 2;
            const rr = R * (1.25 + Math.random() * 0.7);
            water.addDrop(cd.x + Math.cos(th) * rr, cd.y + Math.sin(th) * rr, 0, 0.45 * gain, 1.3 + Math.random());
          }
        }
      }
      // 拍のあいだの細かな波は、盛り上がっているときだけ出す
      const rise = a.bass - prevBass;
      if (rise > 0.004 && I > 0.3) water.addDrop(cd.x, cd.y, R * 1.08, -Math.min(rise * 4, 0.15) * I * I * gain, 2.4);
      // 高音の粒立ちは、水面のあちこちに落ちる小さなしずくにする。数と大きさも盛り上がりで変える
      if (a.hat && Math.random() < 0.1 + 0.6 * I) {
        const [w, h] = water.size;
        let x, y;
        do {
          x = Math.random() * w;
          y = Math.random() * h;
        } while (Math.hypot(x - cd.x, y - cd.y) < R * 1.4);
        water.addDrop(x, y, 0, 0.12 * a.hat * (0.3 + 0.7 * I) * gain, 1.3);
      }
    } else if (t > ambientAt) {
      // 止まっている間も、ときどき小さなしずくを落として水だと分かるようにする
      const [w, h] = water.size;
      water.addDrop(Math.random() * w, Math.random() * h, 0, 0.25 * gain, 1.6);
      ambientAt = t + 2.5 + Math.random() * 3;
    }
    prevBass = a.bass;

    // CD の回転は再生と一時停止でなめらかに加減速する
    const target = playing && !reduceMotion.matches ? Math.PI * 1.1 : 0;
    const dt = Math.min((now - last) / 1000, 0.1);
    cd.speed += (target - cd.speed) * Math.min(dt * 1.5, 1);
    cd.rotation = (cd.rotation + cd.speed * dt) % (Math.PI * 200);
    // 強い拍で CD が一瞬沈み、すぐ戻る
    cd.kick *= Math.exp(-dt * 7);
    cd.bob = playing ? (a.bass * 0.006 + cd.kick * 0.035) * gain : 0;
    // 照明の色は曲の展開に合わせてゆっくり変える。強い拍では水中の光が一瞬強まる
    cd.mood += ((playing ? I : 0) - cd.mood) * Math.min(dt * 0.8, 1);
    cd.flash *= Math.exp(-dt * 5);
    cd.time += dt;
    cd.wind = (0.7 + 0.5 * cd.mood) * gain;
    // 静かな所では水が早く落ち着き、山場では波が長く残る
    cd.damp = 0.990 + 0.0055 * I;
    return dt;
  }

  // 2 秒ごとに平均のフレーム時間を見て、遅ければ画質を 1 段ずつ下げる。
  // 1 段目: 光の色のにじみとブルームを省く。2 段目以降: 描画の解像度を下げる(波は作り直しで消える)
  let slowSum = 0;
  let slowN = 0;
  function watchSpeed(dt) {
    if (dt <= 0 || dt > 0.25) return;
    slowSum += dt;
    slowN++;
    if (slowSum < 2) return;
    const avg = slowSum / slowN;
    slowSum = 0;
    slowN = 0;
    if (avg < 1 / 40) return;
    if (water.quality === 'high') water.quality = 'low';
    else if (dprScale > 0.5) {
      dprScale = Math.max(0.5, dprScale * 0.75);
      resize();
    }
  }

  function frame(now) {
    if (water && !document.hidden) {
      const dt = drive(now);
      water.step(dt, cd);
      water.draw(cd);
      watchSpeed(dt);
    }
    last = now;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
  canvas.addEventListener('webglcontextrestored', () => location.reload());

  // 水面を指でなぞると波が立つ
  let lastPt = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (!water) return;
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = water.toCell(e.clientX, e.clientY);
    water.addDrop(x, y, 0, -0.9, 2.2);
    lastPt = [x, y];
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!lastPt || !water) return;
    const [x, y] = water.toCell(e.clientX, e.clientY);
    if (Math.hypot(x - lastPt[0], y - lastPt[1]) > 3) {
      water.addDrop(x, y, 0, -0.35, 1.8);
      lastPt = [x, y];
    }
  });
  const endDrag = () => { lastPt = null; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // ---------- 再生リスト ----------
  const baseName = (n) => n.replace(/\.[^.]+$/, '');

  function addFiles(files) {
    const list = Array.from(files).filter((f) => f.type.startsWith('audio/') || /\.(mp3|m4a|aac|flac|wav|ogg|opus)$/i.test(f.name));
    if (!list.length) {
      toast('音楽ファイルが見つかりませんでした。mp3 などの音声ファイルを選んでください。');
      return;
    }
    const first = tracks.length;
    for (const f of list) tracks.push({ name: baseName(f.name), url: URL.createObjectURL(f) });
    renderList();
    $('#empty').hidden = true;
    // 何も再生していなければ、追加した最初の曲から始める
    if (index < 0 || audio.paused) load(first, true);
    else toast(list.length + ' 曲を再生リストに追加しました');
  }

  function renderList() {
    // 曲の追加や削除で番号が変わるので、ここでまとめて更新する
    if (index >= 0) $('#now-sub').textContent = (index + 1) + ' / ' + tracks.length + ' 曲目';
    listEl.replaceChildren();
    if (!tracks.length) {
      const p = document.createElement('li');
      p.className = 'playlist-empty';
      p.textContent = '曲がありません。右下の追加ボタンかドロップで読み込めます。';
      listEl.append(p);
      return;
    }
    tracks.forEach((tr, i) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'track';
      b.setAttribute('aria-current', String(i === index));
      b.innerHTML = '<span class="track-no num"></span><span class="track-name"></span>';
      b.firstChild.textContent = i + 1;
      b.lastChild.textContent = tr.name;
      b.addEventListener('click', () => load(i, true));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'td-btn';
      del.dataset.variant = 'ghost';
      del.dataset.iconOnly = '';
      del.setAttribute('aria-label', '「' + tr.name + '」をリストから外す');
      del.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
      del.addEventListener('click', () => removeTrack(i));
      li.append(b, del);
      listEl.append(li);
    });
  }

  // 外したあと元に戻せるよう、URL はすぐには解放しない
  function removeTrack(i) {
    const [tr] = tracks.splice(i, 1);
    const wasCurrent = i === index;
    if (i < index) index--;
    if (wasCurrent) {
      if (tracks.length) load(Math.min(i, tracks.length - 1), !audio.paused);
      else stop();
    }
    renderList();
    toast('「' + tr.name + '」をリストから外しました', {
      actionLabel: '元に戻す',
      onAction() {
        tracks.splice(i, 0, tr);
        // 戻した位置より後ろにある再生中の曲は、番号が 1 つずれる
        if (index >= i) index++;
        if (index < 0) load(i, false);
        $('#empty').hidden = true;
        renderList();
      },
    });
  }

  function stop() {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    index = -1;
    $('#now-title').textContent = '曲が選ばれていません';
    $('#now-sub').textContent = 'ファイルを選ぶと再生できます';
    seek.disabled = true;
    $('#empty').hidden = false;
    syncPlay();
  }

  function load(i, autoplay) {
    if (!tracks[i]) return;
    index = i;
    audio.src = tracks[i].url;
    if (analyzer.ctx) analyzer.reset();
    $('#now-title').textContent = tracks[i].name;
    document.title = tracks[i].name + ' — 波紋プレーヤー';
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: tracks[i].name });
    renderList();
    if (autoplay) play();
  }

  function play() {
    if (index < 0) {
      if (tracks.length) load(0, false);
      else return fileInput.click();
    }
    analyzer.ensure();
    audio.play().catch(() => {});
  }

  function step(d) {
    if (!tracks.length) return;
    // 3 秒以上進んでいれば、「前」は曲の頭に戻す
    if (d < 0 && audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    load((index + d + tracks.length) % tracks.length, !audio.paused || d > 0);
  }

  // ---------- 表示の同期 ----------
  const fmt = (s) => {
    if (!isFinite(s)) return '0:00';
    s = Math.floor(s);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };
  const setFill = (el) => {
    const max = Number(el.max) || 1;
    el.style.setProperty('--fill', (Number(el.value) / max) * 100 + '%');
  };
  let seeking = false;

  function syncPlay() {
    const on = !audio.paused;
    playBtn.setAttribute('aria-pressed', String(on));
    playBtn.setAttribute('aria-label', on ? '一時停止' : '再生');
    if (!on) document.body.removeAttribute('data-idle');
    else poke();
  }
  audio.addEventListener('play', syncPlay);
  audio.addEventListener('pause', syncPlay);
  audio.addEventListener('loadedmetadata', () => {
    seek.max = audio.duration || 0;
    seek.disabled = false;
    $('#time-dur').textContent = fmt(audio.duration);
  });
  audio.addEventListener('timeupdate', () => {
    if (seeking) return;
    seek.value = audio.currentTime;
    setFill(seek);
    $('#time-cur').textContent = fmt(audio.currentTime);
  });
  audio.addEventListener('ended', () => {
    if (index < tracks.length - 1) load(index + 1, true);
    else syncPlay();
  });
  audio.addEventListener('error', () => {
    if (index < 0 || !audio.getAttribute('src')) return;
    $('#now-sub').textContent = 'この形式は再生できませんでした。mp3 か m4a のファイルを選んでください。';
    playBtn.setAttribute('aria-pressed', 'false');
  });

  seek.addEventListener('input', () => {
    seeking = true;
    setFill(seek);
    $('#time-cur').textContent = fmt(Number(seek.value));
  });
  seek.addEventListener('change', () => {
    audio.currentTime = Number(seek.value);
    seeking = false;
  });
  volume.addEventListener('input', () => {
    audio.volume = Number(volume.value);
    setFill(volume);
  });
  audio.volume = Number(volume.value);
  setFill(volume);

  // ---------- 操作 ----------
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    const act = b.dataset.action;
    if (act === 'open') fileInput.click();
    else if (act === 'play') audio.paused ? play() : audio.pause();
    else if (act === 'prev') step(-1);
    else if (act === 'next') step(1);
    else if (act === 'list') toggleList();
  });
  fileInput.addEventListener('change', () => {
    addFiles(fileInput.files);
    fileInput.value = '';
  });

  function toggleList(force) {
    const open = force ?? playlist.hidden;
    playlist.hidden = !open;
    listBtn.setAttribute('aria-expanded', String(open));
    if (open) {
      renderList();
      (listEl.querySelector('[aria-current="true"]') || playlist.querySelector('button')).focus();
    } else if (playlist.contains(document.activeElement)) listBtn.focus();
  }

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea') && e.target.type !== 'range') return;
    if (e.key === 'Escape' && !playlist.hidden) return toggleList(false);
    if (e.target.closest('button, input')) {
      if (e.key !== 'Escape') return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      audio.paused ? play() : audio.pause();
    } else if (e.key === 'ArrowRight' && index >= 0) audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5);
    else if (e.key === 'ArrowLeft' && index >= 0) audio.currentTime = Math.max(0, audio.currentTime - 5);
    else if (e.key === 'n' || e.key === 'N') step(1);
    else if (e.key === 'p' || e.key === 'P') step(-1);
    else if (e.key === 'o' || e.key === 'O') fileInput.click();
  });

  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', play);
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    navigator.mediaSession.setActionHandler('nexttrack', () => step(1));
    navigator.mediaSession.setActionHandler('previoustrack', () => step(-1));
  }

  // ドラッグ&ドロップ
  const hint = $('#drop-hint');
  let dragDepth = 0;
  addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    hint.hidden = false;
  });
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      hint.hidden = true;
    }
  });
  addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    hint.hidden = true;
    if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files);
  });

  // 再生中にしばらく触らなければ操作バーを隠し、水面だけを見せる
  let idleTimer = 0;
  function poke() {
    document.body.removeAttribute('data-idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!audio.paused && playlist.hidden) document.body.setAttribute('data-idle', '');
    }, 3000);
  }
  for (const ev of ['pointermove', 'pointerdown', 'keydown']) addEventListener(ev, poke, { passive: true });

  // ---------- トースト(components.md の実装) ----------
  function toast(message, { actionLabel, onAction } = {}) {
    const region = document.querySelector('.td-toast-region');
    const el = document.createElement('div');
    el.className = 'td-toast';
    el.innerHTML = '<span></span>';
    el.firstChild.textContent = message;
    const close = () => {
      el.dataset.leaving = '';
      el.addEventListener('animationend', () => el.remove(), { once: true });
    };
    if (actionLabel) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = actionLabel;
      b.addEventListener('click', () => { onAction?.(); close(); });
      el.append(b);
    } else {
      let t = setTimeout(close, 4000);
      el.addEventListener('pointerenter', () => clearTimeout(t));
      el.addEventListener('pointerleave', () => { t = setTimeout(close, 2000); });
    }
    region.replaceChildren(el);
  }

  syncPlay();
  renderList();
})();
