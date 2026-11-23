'use strict';
/*
 * 音の解析。帯域ごとの音量と、低音の立ち上がり(拍)を検出する。
 * 拍の検出は「スペクトルフラックス」(前のフレームより増えた分の合計)を、
 * 直近 1 秒ほどの平均と比べて判定する。曲の音量に左右されにくい。
 */
(function () {
  class Analyzer {
    /** @param {HTMLAudioElement} audioEl */
    constructor(audioEl) {
      this.el = audioEl;
      this.ctx = null;
    }

    /** AudioContext はユーザーの操作の中でしか開始できないので、最初の再生時に作る */
    ensure() {
      if (!this.ctx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        this.ctx = new Ctx();
        const src = this.ctx.createMediaElementSource(this.el);
        this.node = this.ctx.createAnalyser();
        this.node.fftSize = 2048;
        this.node.smoothingTimeConstant = 0.35;
        src.connect(this.node);
        this.node.connect(this.ctx.destination);
        this.bins = new Uint8Array(this.node.frequencyBinCount);
        this.prev = new Float32Array(this.node.frequencyBinCount);
        this.hist = { bass: [], high: [] };
        this.lastBeat = 0;
        this.levels = { bass: 0, mid: 0, high: 0 };
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
    }

    /** 周波数(Hz)を FFT の bin 番号に変える */
    bin(hz) {
      return Math.min(this.bins.length - 1, Math.round(hz / (this.ctx.sampleRate / 2) * this.bins.length));
    }

    band(lo, hi) {
      let sum = 0;
      let flux = 0;
      const a = this.bin(lo);
      const b = Math.max(a + 1, this.bin(hi));
      for (let i = a; i < b; i++) {
        const v = this.bins[i] / 255;
        sum += v;
        flux += Math.max(0, v - this.prev[i]);
      }
      return { level: sum / (b - a), flux };
    }

    judge(name, flux, now, ratio) {
      const h = this.hist[name];
      h.push(flux);
      if (h.length > 60) h.shift();
      const mean = h.reduce((s, v) => s + v, 0) / h.length;
      return h.length > 10 && flux > mean * ratio + 0.05 ? flux / (mean * ratio + 0.05) : 0;
    }

    /**
     * 1 フレームぶん解析する
     * @returns {{bass:number, mid:number, high:number, beat:number, hat:number}}
     *   beat は低音の拍の強さ(0 は拍なし)、hat は高音の粒立ちの強さ
     */
    update(now) {
      if (!this.ctx) return { bass: 0, mid: 0, high: 0, beat: 0, hat: 0 };
      this.node.getByteFrequencyData(this.bins);
      const bass = this.band(30, 160);
      const mid = this.band(250, 2000);
      const high = this.band(4000, 12000);
      for (let i = 0; i < this.bins.length; i++) this.prev[i] = this.bins[i] / 255;

      let beat = this.judge('bass', bass.flux, now, 1.45);
      // 同じ拍で何度も波を出さない
      if (beat && now - this.lastBeat < 0.14) beat = 0;
      if (beat) this.lastBeat = now;
      const hat = this.judge('high', high.flux, now, 1.6);

      const lv = this.levels;
      lv.bass += (bass.level - lv.bass) * 0.3;
      lv.mid += (mid.level - lv.mid) * 0.2;
      lv.high += (high.level - lv.high) * 0.2;
      return { bass: lv.bass, mid: lv.mid, high: lv.high, beat: Math.min(beat, 2.5), hat: Math.min(hat, 2) };
    }
  }

  window.Analyzer = Analyzer;
})();
