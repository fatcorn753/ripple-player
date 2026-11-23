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

    return { onsets, env, envRate, duration: n / sr };
  }

  /** その時刻の盛り上がり(0〜1) */
  function envAt(map, t) {
    const i = Math.max(0, Math.min(map.env.length - 1, Math.round(t * map.envRate)));
    return map.env[i];
  }

  window.analyzeBeats = analyzeBeats;
  window.envAt = envAt;
})();
