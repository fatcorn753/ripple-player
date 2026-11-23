'use strict';
/*
 * 曲全体を先に解析し、拍の時刻と盛り上がりの推移を求める(花火の画面で使う)。
 * 花火は打ち上げてから開くまでに 1 秒ほどかかるので、拍を先に知っていないと音に合わせて開けない。
 * 低音の音量(dB)が急に上がった所を拍とし、前後 0.5 秒の平均より十分に大きいものだけを拾う。
 */
(function () {
  const RATE = 22050;
  const HOP = 256;
  const WIN = 512;

  /**
   * @param {ArrayBuffer} data 音声ファイルの中身
   * @returns {Promise<{onsets:{t:number,s:number}[], env:Float32Array, envRate:number, duration:number}>}
   *   onsets は拍の時刻(秒)と強さ(0〜1)、env は盛り上がり(0〜1)を envRate 回/秒で並べたもの
   */
  async function analyzeBeats(data) {
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new Ctx(1, 1, RATE);
    const buf = await new Promise((res, rej) => {
      const p = ctx.decodeAudioData(data, res, rej);
      if (p && p.catch) p.catch(rej);
    });
    return analyzeBuffer(buf);
  }

  function analyzeBuffer(buf) {
    const sr = buf.sampleRate;
    const n = buf.length;
    const chs = buf.numberOfChannels;
    const x = new Float32Array(n);
    for (let c = 0; c < chs; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) x[i] += d[i] / chs;
    }

    // 低音は 150Hz の一次ローパスを 2 回かけて取り出す。二乗の累積和で、窓ごとの平均を速く求める
    const a = Math.exp(-2 * Math.PI * 150 / sr);
    const cb = new Float64Array(n + 1);
    const cf = new Float64Array(n + 1);
    let l1 = 0;
    let l2 = 0;
    for (let i = 0; i < n; i++) {
      l1 = (1 - a) * x[i] + a * l1;
      l2 = (1 - a) * l1 + a * l2;
      cb[i + 1] = cb[i] + l2 * l2;
      cf[i + 1] = cf[i] + x[i] * x[i];
    }
    const frames = Math.max(0, Math.floor((n - WIN) / HOP));
    const bE = new Float32Array(frames);
    const fE = new Float32Array(frames);
    let maxB = -200;
    for (let f = 0; f < frames; f++) {
      const s = f * HOP;
      bE[f] = 10 * Math.log10(1e-10 + (cb[s + WIN] - cb[s]) / WIN);
      fE[f] = 10 * Math.log10(1e-10 + (cf[s + WIN] - cf[s]) / WIN);
      if (bE[f] > maxB) maxB = bE[f];
    }

    // 立ち上がりの大きさ。曲の中でごく小さい音の揺れは拍にしない
    const nov = new Float32Array(frames);
    for (let f = 2; f < frames; f++) {
      const gate = Math.min(1, Math.max(0, (bE[f] - (maxB - 30)) / 20));
      nov[f] = (Math.max(0, bE[f] - bE[f - 2]) + 0.35 * Math.max(0, fE[f] - fE[f - 2])) * gate;
    }

    const fps = sr / HOP;
    const half = Math.round(fps * 0.5);
    const near = Math.round(fps * 0.06);
    const minGap = Math.round(fps * 0.18);
    const peaks = [];
    let sum = 0;
    let cnt = 0;
    let lo = 0;
    let hi = 0;
    let last = -minGap;
    for (let f = 0; f < frames; f++) {
      // 前後 0.5 秒の平均(窓をずらしながら足し引きする)
      while (hi < Math.min(frames, f + half + 1)) { sum += nov[hi++]; cnt++; }
      while (lo < f - half) { sum -= nov[lo++]; cnt--; }
      const mean = sum / cnt;
      if (nov[f] <= mean * 1.6 + 0.8 || f - last < minGap) continue;
      let isMax = true;
      for (let k = Math.max(0, f - near); k <= Math.min(frames - 1, f + near); k++) {
        if (nov[k] > nov[f]) { isMax = false; break; }
      }
      if (!isMax) continue;
      peaks.push([f, nov[f]]);
      last = f;
    }

    // 強さは、上位 5% の拍を 1 とした比にする
    const sorted = peaks.map((p) => p[1]).sort((p, q) => p - q);
    const ref = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] || sorted[sorted.length - 1] : 1;
    // 窓の後ろ寄りで立ち上がりを捉えるので、時刻は窓の 6 割の位置にする
    const onsets = peaks.map(([f, v]) => ({ t: (f * HOP + WIN * 0.6) / sr, s: Math.min(1, v / ref) }));

    // 盛り上がり: 0.4 秒の平均音量が、曲の最大から 12dB 以内のときを 0〜1 に割り当てる
    const envRate = 10;
    const per = Math.round(sr / envRate);
    const len = Math.ceil(n / per);
    const db = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const s0 = Math.max(0, Math.round((i - 2) * per));
      const s1 = Math.min(n, Math.round((i + 2) * per));
      db[i] = 10 * Math.log10(1e-10 + (cf[s1] - cf[s0]) / Math.max(1, s1 - s0));
    }
    const top = Float32Array.from(db).sort()[Math.floor(len * 0.98)] ?? 0;
    const env = new Float32Array(len);
    for (let i = 0; i < len; i++) env[i] = Math.min(1, Math.max(0, (db[i] - (top - 12)) / 12));

    const grid = beatGrid(nov, fps, onsets);
    const toT = (f) => (f * HOP + WIN * 0.6) / sr;
    const beats = grid.frames.map((f, i) => ({
      t: toT(f),
      s: grid.str[i],
      // 小節の何拍目か(0 が頭)
      pos: ((i - grid.down) % 4 + 4) % 4,
      bar: Math.floor((i - grid.down) / 4),
      // 次の拍との中間(裏拍)に立ち上がりがあるか(0〜1)
      off: grid.off[i],
    }));
    return { onsets, beats, bpm: 60 * fps / grid.period, env, envRate, duration: n / sr };
  }

  /**
   * テンポを求め、拍の並び(ビートグリッド)を作る。
   * 1. 立ち上がりの自己相関でテンポを決める(人が乗りやすい 120BPM 付近を少し優先する)
   * 2. 動的計画法で「立ち上がりの強い所を通り、間隔がテンポに近い」拍の列を選ぶ(Ellis 2007 の方法)。
   *    曲の途中でテンポが少し揺れても追える
   * 3. 4 拍ごとの位置のうち、低音の立ち上がりが最も強いものを小節の頭とする
   */
  function beatGrid(nov, fps, onsets) {
    const n = nov.length;
    const empty = { frames: [], str: [], off: [], down: 0, period: fps / 2 };
    if (n < fps * 4 || !onsets.length) return empty;

    let mean = 0;
    for (let i = 0; i < n; i++) mean += nov[i];
    mean /= n;
    let sd = 0;
    for (let i = 0; i < n; i++) sd += (nov[i] - mean) ** 2;
    sd = Math.sqrt(sd / n) || 1;
    const d = Float32Array.from(nov, (v) => (v - mean) / sd);

    const minLag = Math.floor(fps * 60 / 200);
    const maxLag = Math.ceil(fps * 60 / 60);
    const ac = new Float32Array(maxLag + 2);
    for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
      let s = 0;
      for (let i = 0; i + lag < n; i++) s += d[i] * d[i + lag];
      ac[lag] = s / (n - lag);
    }
    let L = Math.round(fps * 0.5);
    let best = -Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) {
      const bpm = 60 * fps / lag;
      const w = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
      if (ac[lag] * w > best) { best = ac[lag] * w; L = lag; }
    }
    // 1 フレームより細かく、山の頂点を放物線で求める
    const y0 = ac[L - 1], y1 = ac[L], y2 = ac[L + 1];
    const den = y0 - 2 * y1 + y2;
    const P = L + (den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (y0 - y2) / den)) : 0);

    // 立ち上がりを少しなめらかにして、拍の候補の強さにする
    const loc = new Float32Array(n);
    const sw = Math.max(1, Math.round(P / 16));
    for (let i = 0; i < n; i++) {
      let s = 0, ws = 0;
      for (let k = -2 * sw; k <= 2 * sw; k++) {
        const j = i + k;
        if (j < 0 || j >= n) continue;
        const w = Math.exp(-0.5 * (k / sw) ** 2);
        s += nov[j] * w;
        ws += w;
      }
      loc[i] = s / ws / sd;
    }
    const TIGHT = 100;
    const score = new Float32Array(n);
    const back = new Int32Array(n).fill(-1);
    const lo = Math.round(P / 2), hi = Math.round(P * 2);
    for (let i = 0; i < n; i++) {
      let bv = -Infinity, bj = -1;
      for (let j = Math.max(0, i - hi); j <= i - lo; j++) {
        const v = score[j] - TIGHT * Math.log((i - j) / P) ** 2;
        if (v > bv) { bv = v; bj = j; }
      }
      score[i] = loc[i] + (bj >= 0 ? bv : 0);
      back[i] = bj;
    }
    let end = n - 1;
    for (let i = Math.max(0, n - Math.round(P)); i < n; i++) if (score[i] > score[end]) end = i;
    let frames = [];
    for (let i = end; i >= 0; i = back[i]) frames.push(i);
    frames.reverse();

    // 曲の前後の無音にまで拍を置かない
    const f0 = (onsets[0].t * fps) - P * 0.5;
    const f1 = (onsets[onsets.length - 1].t * fps) + P * 0.5;
    frames = frames.filter((f) => f >= f0 && f <= f1);
    if (!frames.length) return empty;

    const near = Math.max(1, Math.round(P * 0.12));
    const peakAt = (c) => {
      let m = 0;
      for (let k = Math.max(0, Math.round(c) - near); k <= Math.min(n - 1, Math.round(c) + near); k++) m = Math.max(m, nov[k]);
      return m;
    };
    const raw = frames.map(peakAt);
    const offRaw = frames.map((f, i) => peakAt(f + ((frames[i + 1] ?? f + P) - f) / 2));
    const ref = [...raw].sort((p, q) => p - q)[Math.floor(raw.length * 0.9)] || 1;
    const str = raw.map((v) => Math.min(1, v / ref));
    const off = offRaw.map((v) => Math.min(1, v / ref));

    const sums = [0, 0, 0, 0];
    raw.forEach((v, i) => { sums[i % 4] += v; });
    const down = sums.indexOf(Math.max(...sums));
    return { frames, str, off, down, period: P };
  }

  /** その時刻の盛り上がり(0〜1) */
  function envAt(map, t) {
    const i = Math.max(0, Math.min(map.env.length - 1, Math.round(t * map.envRate)));
    return map.env[i];
  }

  window.analyzeBeats = analyzeBeats;
  window.envAt = envAt;
})();
