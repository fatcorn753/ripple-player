'use strict';
/*
 * 花火と湖面(WebGL2)
 *
 * 場面: 遠くの湖上(400〜700m 先)から花火が上がり、手前の湖面に映る。カメラは水面から 2.5m の高さ。
 * 1 フレームの流れ:
 *   1. 湖面の波: 手前 80m 四方だけ、水面の画面と同じ波動方程式で進める(花火の衝撃やクリックの波紋)
 *   2. 花火: 粒子を、動いた向きに伸ばした光の筋として加算で描く。前のフレームを少し残して残像にする
 *   3. 場面: 夜空(星・街明かり・遠くの山・花火に照らされた煙)と、それを鏡のように映す湖面
 *   4. ブルームと仕上げ(水面の画面と同じ)
 * 粒子の計算は JS で行う。粒子は配列の詰め替えで消すので、上限まで確保した 1 本の配列だけを使う。
 */
(function () {
  const K = window.GLKit;
  const CAMH = 2.5;
  const MAXP = 40000;
  // 粒子 1 個ぶんの値の並び
  const X = 0, Y = 1, Z = 2, VX = 3, VY = 4, VZ = 5, AGE = 6, LIFE = 7;
  const R1 = 8, G1 = 9, B1 = 10, R2 = 11, G2 = 12, B2 = 13, SW = 14;
  const SIZE = 15, STREAK = 16, FLICK = 17, DRAG = 18, GRAV = 19, EMIT = 20, EKIND = 21, ACC = 22, BRIGHT = 23;
  const NF = 24;
  const STRIDE = 12;
  // 手前の湖面で波を計算する範囲(m)。x の最小・z の最小・幅・奥行き
  const LAKE = [-40, 3, 80, 80];
  const SIM = 256;
  const MAX_LIGHTS = 12;

  const PAL = {
    red: [1, 0.2, 0.1], orange: [1, 0.48, 0.1], gold: [1, 0.66, 0.26], green: [0.22, 1, 0.32],
    blue: [0.28, 0.42, 1], purple: [0.68, 0.32, 1], silver: [0.86, 0.9, 1], cyan: [0.28, 0.88, 1], pink: [1, 0.4, 0.68],
  };
  // 静かな所は寒色、盛り上がると暖色を多く使う
  const COOL = ['blue', 'cyan', 'green', 'silver', 'purple'];
  const WARM = ['red', 'orange', 'gold', 'pink', 'purple', 'green', 'red'];

  const PARTICLE_VS = `#version 300 es
in vec2 aCorner;
in vec3 iPos;
in vec3 iVel;
in vec4 iCol;
in vec2 iEx;
uniform vec2 uRes;
uniform float uHz;
uniform float uF;
uniform float uMinW;
uniform float uTime;
out vec2 vL;
out float vHalf;
out float vW;
out vec3 vCol;
vec2 proj(vec3 p) { return vec2(0.5 * uRes.x + p.x / p.z * uF, uHz + p.y / p.z * uF); }
float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
void main() {
  // 今の位置と、少し前の位置を結ぶ線分を、幅のある四角形で覆う
  vec2 a = proj(iPos);
  vec2 b = proj(iPos - iVel * iEx.x);
  float w = max(iCol.a / iPos.z * uF, uMinW);
  vec2 d = a - b;
  float L = length(d);
  vec2 dir = L > 1e-3 ? d / L : vec2(1.0, 0.0);
  vec2 nr = vec2(-dir.y, dir.x);
  float ext = w * 2.5;
  float hl = L * 0.5;
  vL = vec2(aCorner.x * (hl + ext), aCorner.y * ext);
  vec2 p = (a + b) * 0.5 + dir * vL.x + nr * vL.y;
  vHalf = hl;
  vW = w;
  // 点滅する星(錦冠や点滅星)は、時刻ごとに明るさを跳ばす
  float tw = 1.0;
  if (iEx.y > 0.0) tw = mix(1.0, step(0.55, hash(vec3(floor(uTime * 22.0), iPos.xy))) * 1.8, iEx.y);
  // 尾を引くほど光が長さに散るので、そのぶん暗くする
  vCol = iCol.rgb * tw * w / (w + hl * 0.7);
  gl_Position = vec4(p / uRes * 2.0 - 1.0, 0.0, 1.0);
}`;

  const PARTICLE_FS = `#version 300 es
precision highp float;
in vec2 vL;
in float vHalf;
in float vW;
in vec3 vCol;
out vec4 o;
void main() {
  float dx = max(abs(vL.x) - vHalf, 0.0);
  float d2 = (dx * dx + vL.y * vL.y) / (vW * vW);
  float g = exp(-d2 * 1.2) + 0.6 * exp(-d2 * 6.0);
  o = vec4(vCol * g, 1.0);
}`;

  // 前のフレームの光を薄める(合成の係数で掛けるので、出力は使わない)
  const FADE_FS = `#version 300 es
precision mediump float;
out vec4 o;
void main() { o = vec4(0.0); }`;

  const SCENE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uFw;
uniform sampler2D uState;
uniform vec2 uRes;
uniform float uHz;
uniform float uF;
uniform float uTime;
uniform float uWind;
uniform vec4 uLights[${MAX_LIGHTS}];
uniform vec3 uLightCol[${MAX_LIGHTS}];
uniform int uLightN;
uniform vec4 uLake;
uniform vec2 uSimSize;
const float CAMH = ${CAMH.toFixed(2)};

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * noise(p);
    p = p * 2.03 + 17.1;
    a *= 0.5;
  }
  return s;
}
// 花火の光が空を照らす。画面の座標(px)で、光ごとにぼかした円を足す
vec3 glowAt(vec2 px) {
  vec3 g = vec3(0.0);
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= uLightN) break;
    vec4 L = uLights[i];
    vec2 d = (px - L.xy) / L.z;
    g += uLightCol[i] * L.w * exp(-dot(d, d));
  }
  return g;
}
// 夜空。px は下が 0 の画面座標で、水平線より上
vec3 sky(vec2 px) {
  float a = (px.y - uHz) / uRes.y;
  vec3 col = mix(vec3(0.016, 0.020, 0.042), vec3(0.003, 0.004, 0.012), smoothstep(0.0, 0.5, a));
  // 地平線のあたりの、遠い街明かり
  col += vec3(0.030, 0.016, 0.010) * exp(-a * 14.0);
  vec2 q = px / uRes.y * 420.0;
  vec2 c = floor(q);
  float h = hash(c);
  if (h > 0.992) {
    vec2 f = fract(q) - 0.5 - (vec2(hash(c + 3.1), hash(c + 7.7)) - 0.5) * 0.6;
    col += vec3(0.7, 0.8, 1.0) * exp(-dot(f, f) * 50.0) * (h - 0.992) * 70.0 * smoothstep(0.03, 0.2, a);
  }
  vec3 g = glowAt(px);
  // 打ち上げの煙が、花火の光で浮かび上がる
  float sm = fbm(vec2(px.x / uRes.y * 2.5 + uTime * 0.015, px.y / uRes.y * 3.5 - uTime * 0.004));
  // 光が重なっても空が白くならないよう、上限をなだらかにかける
  g = g / (1.0 + g);
  col += g * (0.02 + 0.22 * sm * sm);
  // 遠くの山なみ
  float ridge = (0.008 + 0.024 * fbm(vec2(px.x / uRes.y * 2.2, 3.7))) * uRes.y;
  if (px.y - uHz < ridge) col = vec3(0.004, 0.005, 0.010) + g * 0.012;
  return col;
}
// 風の波の傾き(dh/dx, dh/dz)。遠くほど 1 画素に入る波が増えて細かい波は見えなくなるので、弱める
vec2 waveSlope(vec2 w, float z) {
  const vec3 WV[6] = vec3[6](vec3(0.94, 0.34, 0.9), vec3(-0.6, 0.8, 1.7), vec3(0.2, 0.98, 3.1),
                             vec3(-0.9, 0.44, 0.55), vec3(0.7, -0.71, 2.3), vec3(0.05, 1.0, 5.5));
  float foot = z * z / (CAMH * uF);
  vec2 s = vec2(0.0);
  for (int i = 0; i < 6; i++) {
    vec2 d = normalize(WV[i].xy);
    float lam = WV[i].z;
    float k = 6.2832 / lam;
    float att = exp(-pow(foot / lam * 1.5, 2.0));
    s += d * 0.11 * cos(dot(d, w) * k - sqrt(9.8 * k) * uTime + float(i) * 1.7) * att;
  }
  return s * uWind;
}
void main() {
  vec2 px = vUv * uRes;
  vec3 col;
  if (px.y >= uHz) {
    col = sky(px) + texture(uFw, vUv).rgb;
  } else {
    // 画面の点を湖面の位置(x, z)に戻す
    float dy = uHz - px.y;
    float z = CAMH * uF / max(dy, 0.5);
    float x = (px.x - 0.5 * uRes.x) * z / uF;
    vec2 s = waveSlope(vec2(x, z), z);
    vec2 su = (vec2(x, z) - uLake.xy) / uLake.zw;
    if (all(greaterThan(su, vec2(0.0))) && all(lessThan(su, vec2(1.0)))) {
      vec2 tx = 1.0 / uSimSize;
      float l = texture(uState, su - vec2(tx.x, 0.0)).r;
      float r = texture(uState, su + vec2(tx.x, 0.0)).r;
      float d = texture(uState, su - vec2(0.0, tx.y)).r;
      float u = texture(uState, su + vec2(0.0, tx.y)).r;
      s += vec2(r - l, u - d) * 0.35;
    }
    // 鏡像: 水平線で折り返し、波の傾きでずらす。視線が浅いので、奥行き方向の傾きは縦に大きく伸びる
    vec2 rp = vec2(px.x + s.x * uF * 0.35, 2.0 * uHz - px.y + s.y * uF * 0.9);
    rp.y = max(rp.y, uHz + 0.5);
    // 光が縦の筋に伸びる反射。少しずつずらして重ねる
    float spread = (0.01 + length(s)) * uF * 0.12;
    vec3 refl = vec3(0.0);
    for (int i = 0; i < 5; i++) {
      float off = (float(i) - 2.0) * spread;
      refl += texture(uFw, vec2(rp.x, max(rp.y + off, uHz + 0.5)) / uRes).rgb;
    }
    refl = refl * 0.2 + sky(rp);
    // 水平線の近くほど浅い角度で見るので、よく映る
    float graze = dy / uRes.y;
    float fres = mix(0.85, 0.30, smoothstep(0.0, 0.4, graze));
    col = vec3(0.001, 0.002, 0.004) + refl * fres;
  }
  o = vec4(col, 1.0);
}`;

  function link(gl, vsSrc, fsSrc, attribs) {
    const p = gl.createProgram();
    gl.attachShader(p, K.compile(gl, gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, K.compile(gl, gl.FRAGMENT_SHADER, fsSrc));
    attribs.forEach((name, i) => gl.bindAttribLocation(p, i, name));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'program link failed');
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
    }
    return { p, u };
  }

  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  function weighted(table) {
    let sum = 0;
    for (const k in table) sum += table[k];
    let r = Math.random() * sum;
    for (const k in table) {
      r -= table[k];
      if (r <= 0) return k;
    }
    return Object.keys(table)[0];
  }

  class Fireworks {
    /** @param {HTMLCanvasElement} canvas */
    constructor(canvas) {
      this.canvas = canvas;
      const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: false });
      if (!gl) throw new Error('WebGL2 を使えません');
      this.gl = gl;
      if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('浮動小数のテクスチャを使えません');
      this.full = !!gl.getExtension('OES_texture_float_linear');

      this.particle = link(gl, PARTICLE_VS, PARTICLE_FS, ['aCorner', 'iPos', 'iVel', 'iCol', 'iEx']);
      this.fade = K.program(gl, FADE_FS);
      this.scene = K.program(gl, SCENE_FS);
      this.sim = K.program(gl, K.SIM_FS);
      this.drop = K.program(gl, K.DROP_FS);
      this.bright = K.program(gl, K.BRIGHT_FS);
      this.blur = K.program(gl, K.BLUR_FS);
      this.final = K.program(gl, K.FINAL_FS);

      this.quad = gl.createVertexArray();
      gl.bindVertexArray(this.quad);
      const qb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, qb);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

      // 粒子: 角の 4 点(共通)と、粒子ごとの値(インスタンス)
      this.pvao = gl.createVertexArray();
      gl.bindVertexArray(this.pvao);
      gl.bindBuffer(gl.ARRAY_BUFFER, qb);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      this.ibuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.ibuf);
      gl.bufferData(gl.ARRAY_BUFFER, (MAXP + 64) * STRIDE * 4, gl.DYNAMIC_DRAW);
      const attr = (loc, size, off) => {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE * 4, off * 4);
        gl.vertexAttribDivisor(loc, 1);
      };
      attr(1, 3, 0);
      attr(2, 3, 3);
      attr(3, 4, 6);
      attr(4, 2, 10);
      gl.bindVertexArray(this.quad);
      this.inst = new Float32Array((MAXP + 64) * STRIDE);

      this.P = new Float32Array(MAXP * NF);
      this.n = 0;
      this.shells = [];
      this.lights = [];
      this.drops = [];
      this.t = 0;
      this.acc = 0;
      this.wind = 1;
      /** 'high' はブルームあり・粒子多め。'low' は省く */
      this.quality = 'high';
      /** 「視差効果を減らす」では粒子と光を控えめにする */
      this.calm = false;

      const simFmt = this.full ? gl.RGBA32F : gl.RGBA16F;
      this.simT = [this.makeTarget(SIM, SIM, simFmt), this.makeTarget(SIM, SIM, simFmt)];
      this.cur = 0;
      this.fbos = {};
    }

    makeTarget(w, h, internal) {
      const gl = this.gl;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return { tex, fb, w, h };
    }

    resize(cssW, cssH, dpr) {
      const gl = this.gl;
      const W = Math.max(1, Math.round(cssW * dpr));
      const H = Math.max(1, Math.round(cssH * dpr));
      this.canvas.width = W;
      this.canvas.height = H;
      this.W = W;
      this.H = H;
      this.css = [cssW, cssH];
      // 縦長の画面では湖面を少し広く取る
      this.hz = H * (cssH > cssW ? 0.40 : 0.34);
      this.f = Math.min(H * 0.95, W * 1.15);
      this.minW = 1.1 * dpr;
      for (const t of Object.values(this.fbos)) {
        gl.deleteTexture(t.tex);
        gl.deleteFramebuffer(t.fb);
      }
      const hw = Math.ceil(W / 2), hh = Math.ceil(H / 2);
      const qw = Math.ceil(W / 4), qh = Math.ceil(H / 4);
      this.fbos = {
        fw: this.makeTarget(W, H, gl.RGBA16F),
        scene: this.makeTarget(W, H, gl.RGBA16F),
        halfA: this.makeTarget(hw, hh, gl.RGBA16F),
        halfB: this.makeTarget(hw, hh, gl.RGBA16F),
        quarterA: this.makeTarget(qw, qh, gl.RGBA16F),
        quarterB: this.makeTarget(qw, qh, gl.RGBA16F),
      };
    }

    /** 世界の座標(m)を画面の座標(px、下が 0)にする */
    proj(x, y, z) {
      return [this.W / 2 + x / z * this.f, this.hz + y / z * this.f];
    }

    /** 奥行き z で、花火の中心を置いてよい横の範囲(m) */
    xRange(z) {
      return (this.W * 0.40) / this.f * z;
    }

    /** 奥行き z で、花火が画面の上にはみ出さない高さの上限(m) */
    hMax(z) {
      return ((this.H - this.hz) * 0.9) / this.f * z;
    }

    spawn(x, y, z, vx, vy, vz, o) {
      if (this.n >= MAXP) return;
      const P = this.P;
      const b = this.n++ * NF;
      P[b + X] = x; P[b + Y] = y; P[b + Z] = z;
      P[b + VX] = vx; P[b + VY] = vy; P[b + VZ] = vz;
      P[b + AGE] = 0;
      P[b + LIFE] = o.life;
      const c1 = o.c1, c2 = o.c2 || o.c1;
      P[b + R1] = c1[0]; P[b + G1] = c1[1]; P[b + B1] = c1[2];
      P[b + R2] = c2[0]; P[b + G2] = c2[1]; P[b + B2] = c2[2];
      P[b + SW] = o.c2 ? o.sw ?? 0.5 : 2;
      P[b + SIZE] = o.size;
      P[b + STREAK] = o.streak ?? 0;
      P[b + FLICK] = o.flick ?? 0;
      P[b + DRAG] = o.drag ?? 1;
      P[b + GRAV] = o.grav ?? 9.8;
      P[b + EMIT] = o.emit ?? 0;
      P[b + EKIND] = o.ekind ?? 0;
      P[b + ACC] = Math.random();
      P[b + BRIGHT] = o.bright ?? 3;
    }

    /**
     * 拍の強さと曲の盛り上がりから、花火の種類・大きさ・色を決める
     * @param {number} s 拍の強さ(0〜1)
     * @param {number} I 盛り上がり(0〜1)
     */
    design(s, I) {
      let type;
      if (I < 0.3) type = s > 0.75 ? 'willow' : weighted({ peony: 3, chrys: 2 });
      else if (I < 0.7) type = weighted({ peony: 3, chrys: 3, ring: 1, strobe: 1, willow: 1 });
      else type = weighted({ chrys: 3, kamuro: 2, peony: 2, ring: 1, strobe: 1 });
      const big = s * 0.6 + I * 0.4;
      const pal = I < 0.4 ? COOL : WARM;
      const c1 = PAL[pick(pal)];
      let c2 = null;
      // 途中で色が変わる星(変色)と、内側にもう一回り小さい球(芯)。日本の割物らしさを出す
      if (I > 0.3 && Math.random() < 0.5) {
        c2 = PAL[pick(pal)];
        if (c2 === c1) c2 = null;
      }
      const pistil = (type === 'peony' || type === 'chrys') && Math.random() < 0.55 ? PAL[pick(pal)] : null;
      const multi = I > 0.8 && s > 0.7 ? 3 : I > 0.6 && s > 0.85 ? 2 : 1;
      return { type, R: 40 + 75 * big, c1, c2, pistil, multi };
    }

    /**
     * 花火を上げる
     * @param {number} lead 今から開くまでの秒数。短すぎると上がる様子が見えないので、そのときはすぐ開く
     */
    launch(spec, lead) {
      for (let k = 0; k < spec.multi; k++) {
        const z = rnd(480, 640);
        const xr = this.xRange(z);
        const x = spec.multi > 1 ? (k - (spec.multi - 1) / 2) * xr * 0.7 + rnd(-30, 30) : rnd(-xr, xr);
        const R = spec.R * (spec.multi > 1 ? 0.8 : 1);
        const h = Math.min(rnd(110, 160) + R * 1.1, this.hMax(z) - R * 0.95);
        const one = k === 0 ? spec : { ...spec, c1: PAL[pick(Object.keys(PAL))] };
        if (lead < 0.35) {
          // すぐ開く花火は、上がってきた跡だけを残す
          for (let i = 0; i < 14; i++) {
            const yy = h - i * 4;
            this.spawn(x + rnd(-0.6, 0.6), yy, z, rnd(-1, 1), rnd(-3, 0), rnd(-1, 1),
              { life: 0.25 + i * 0.02, c1: PAL.gold, size: 0.9, bright: 1.4 * (1 - i / 14), drag: 2, grav: 3 });
          }
          this.burst(one, x, h, z, R);
        } else {
          this.shells.push({ x, z, h, y: 0, t0: this.t, T: lead, spec: one, R });
          // 打ち上げの瞬間、湖上が一瞬光る
          this.spawn(x, 1.5, z, 0, 0, 0, { life: 0.12, c1: [1, 0.7, 0.4], size: 5, bright: 3 });
        }
      }
    }

    burst(spec, x, y, z, R) {
      const q = (this.quality === 'high' ? 1 : 0.6) * (this.calm ? 0.6 : 1);
      const t = spec.type;
      let n = Math.round((60 + R * 1.5) * q);
      const base = {
        peony: { drag: 1.2, life: 1.7, size: 1.5, streak: 0.04, bright: 2.6 },
        chrys: { drag: 1.3, life: 1.9, size: 1.3, streak: 0.10, bright: 2.4, emit: 14, ekind: 2 },
        willow: { drag: 2.0, life: 3.6, size: 1.1, streak: 0.16, bright: 1.8, emit: 16, ekind: 1 },
        kamuro: { drag: 1.9, life: 4.2, size: 1.2, streak: 0.18, bright: 2.2, emit: 24, ekind: 1 },
        ring: { drag: 1.2, life: 1.8, size: 1.5, streak: 0.05, bright: 2.8 },
        strobe: { drag: 1.3, life: 2.2, size: 1.3, streak: 0.03, bright: 2.6, flick: 1 },
      }[t];
      let c1 = spec.c1;
      let c2 = spec.c2;
      if (t === 'willow') { c1 = PAL.gold; c2 = null; n = Math.round(n * 0.7); }
      if (t === 'kamuro') { c1 = [1, 0.82, 0.55]; c2 = PAL.gold; }
      if (t === 'strobe') { c1 = PAL.silver; c2 = null; }

      const dirs = t === 'ring' ? this.ringDirs(Math.round(n * 0.55)) : this.sphereDirs(n);
      for (const [dx, dy, dz] of dirs) {
        // 球の形がくずれないよう、星の速さはほぼそろえる
        const v = R * base.drag * rnd(0.96, 1.04);
        this.spawn(x, y, z, dx * v, dy * v, dz * v, {
          ...base, life: base.life * rnd(0.85, 1.15), c1, c2, sw: rnd(0.42, 0.52),
        });
      }
      if (spec.pistil && t !== 'ring') {
        for (const [dx, dy, dz] of this.sphereDirs(Math.round(n * 0.3))) {
          const v = R * 0.45 * base.drag * rnd(0.95, 1.05);
          this.spawn(x, y, z, dx * v, dy * v, dz * v, { ...base, emit: 0, bright: base.bright * 0.6, life: base.life * 0.8 * rnd(0.9, 1.1), c1: spec.pistil, c2: null });
        }
      }
      // 開いた瞬間の閃光
      this.spawn(x, y, z, 0, 0, 0, { life: 0.1, c1: [1, 0.95, 0.85], size: R * 0.07, bright: 3 * (this.calm ? 0.5 : 1) });

      const [lx, ly] = this.proj(x, y, z);
      const m = Math.max(c1[0], c1[1], c1[2]);
      this.lights.push({ x: lx, y: ly, r: R / z * this.f * 2.6, col: [c1[0] / m, c1[1] / m, c1[2] / m], I: (0.3 + R / 160) * (this.calm ? 0.5 : 1) });
      if (this.lights.length > MAX_LIGHTS) this.lights.shift();
      // 大きな花火の衝撃で、手前の湖面にも波紋が立つ
      if (R > 75) this.ripple(rnd(-20, 20), rnd(15, 55), -0.25 * (R / 100));
    }

    // 球面にむらなく並べた向き(フィボナッチ格子)を、毎回ランダムに回す
    sphereDirs(n) {
      const out = [];
      const ga = Math.PI * (3 - Math.sqrt(5));
      const rot = Math.random() * Math.PI * 2;
      for (let i = 0; i < n; i++) {
        const y = 1 - (i + 0.5) / n * 2;
        const r = Math.sqrt(1 - y * y);
        const th = i * ga + rot;
        out.push([Math.cos(th) * r, y, Math.sin(th) * r]);
      }
      return out;
    }

    // 輪: カメラの方へ少し傾いた円
    ringDirs(n) {
      const tilt = rnd(-0.7, 0.7);
      const roll = rnd(-0.5, 0.5);
      const out = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        let x = Math.cos(a), y = Math.sin(a), z = 0;
        // x 軸まわりに tilt、z 軸まわりに roll だけ回す
        [y, z] = [y * Math.cos(tilt), y * Math.sin(tilt)];
        [x, y] = [x * Math.cos(roll) - y * Math.sin(roll), x * Math.sin(roll) + y * Math.cos(roll)];
        out.push([x, y, z]);
      }
      return out;
    }

    /** 高音の粒立ち: 燃えている星のそばで、小さな火花がはじける */
    crackle(count) {
      if (!this.n) return;
      const P = this.P;
      for (let k = 0; k < count; k++) {
        const b = Math.floor(Math.random() * this.n) * NF;
        if (P[b + LIFE] < 1 || P[b + Y] < 20) continue;
        this.spawn(P[b + X] + rnd(-3, 3), P[b + Y] + rnd(-3, 3), P[b + Z], 0, 0, 0,
          { life: rnd(0.05, 0.1), c1: [1, 1, 0.95], size: 0.9, bright: 9 });
      }
    }

    /** 湖面に波紋を足す。x, z は世界の座標(m) */
    ripple(x, z, amp) {
      if (this.drops.length >= K.MAX_DROPS) return;
      const cx = (x - LAKE[0]) / LAKE[2] * SIM;
      const cy = (z - LAKE[1]) / LAKE[3] * SIM;
      this.drops.push([cx, cy, 0, amp, 1.6]);
    }

    /**
     * 画面を押した所に応じて、空なら花火を上げ、湖なら波紋を立てる
     * @returns {boolean} 何か起きたら true
     */
    poke(cssX, cssY, strength = 1) {
      const dpr = this.W / this.css[0];
      const px = cssX * dpr;
      const py = this.H - cssY * dpr;
      if (py > this.hz) {
        const z = 520;
        const x = (px - this.W / 2) * z / this.f;
        const h = (py - this.hz) * z / this.f;
        this.shells.push({ x, z, h, y: 0, t0: this.t, T: 1.0, spec: this.design(0.6, 0.5), R: 55 });
        return true;
      }
      // 波を計算している手前の範囲より奥を押したときは、範囲の奥の端に立てる
      const z = Math.min(CAMH * this.f / Math.max(this.hz - py, 0.5), LAKE[1] + LAKE[3] * 0.9);
      const x = Math.max(LAKE[0] * 0.9, Math.min(-LAKE[0] * 0.9, (px - this.W / 2) * z / this.f));
      this.ripple(x, z, -0.8 * strength);
      return true;
    }

    update(dt) {
      this.t += dt;
      const P = this.P;

      for (let i = this.shells.length - 1; i >= 0; i--) {
        const s = this.shells[i];
        const u = Math.min(1, (this.t - s.t0) / s.T);
        // 上がるほど遅くなる
        const y = s.h * (1 - (1 - u) * (1 - u));
        const steps = Math.min(12, Math.ceil((y - s.y) / 3));
        for (let k = 0; k < steps; k++) {
          const yy = s.y + (y - s.y) * (k / steps);
          this.spawn(s.x + rnd(-0.4, 0.4), yy, s.z, rnd(-1.5, 1.5), rnd(-5, -1), rnd(-1.5, 1.5),
            { life: rnd(0.3, 0.6), c1: PAL.gold, size: 0.8, bright: 1.5, drag: 2, grav: 4 });
        }
        s.vy = (y - s.y) / Math.max(dt, 1e-3);
        s.y = y;
        if (u >= 1) {
          this.burst(s.spec, s.x, s.h, s.z, s.R);
          this.shells.splice(i, 1);
        }
      }

      let i = 0;
      while (i < this.n) {
        const b = i * NF;
        P[b + AGE] += dt;
        if (P[b + AGE] >= P[b + LIFE] || P[b + Y] < 0) {
          // 最後の粒子をこの場所へ移して詰める
          this.n--;
          if (i < this.n) P.copyWithin(b, this.n * NF, this.n * NF + NF);
          continue;
        }
        const k = Math.exp(-P[b + DRAG] * dt);
        P[b + VX] *= k;
        P[b + VY] = P[b + VY] * k - P[b + GRAV] * dt;
        P[b + VZ] *= k;
        P[b + X] += P[b + VX] * dt;
        P[b + Y] += P[b + VY] * dt;
        P[b + Z] += P[b + VZ] * dt;
        const ek = P[b + EKIND];
        if (ek) {
          P[b + ACC] += P[b + EMIT] * dt;
          while (P[b + ACC] >= 1) {
            P[b + ACC] -= 1;
            const vx = P[b + VX], vy = P[b + VY], vz = P[b + VZ];
            if (ek === 1) {
              // 柳・冠: 金色の火の粉がこぼれて垂れる
              this.spawn(P[b + X], P[b + Y], P[b + Z], vx * 0.1 + rnd(-1.5, 1.5), vy * 0.1 + rnd(-1.5, 1), vz * 0.1 + rnd(-1.5, 1.5),
                { life: rnd(0.5, 1.0), c1: PAL.gold, size: 0.6, bright: 2.2, drag: 3, flick: 0.6, streak: 0.02 });
            } else {
              // 菊: 星の後ろに短い尾の火花を残す
              const sw = P[b + AGE] / P[b + LIFE] < P[b + SW];
              const c = sw ? [P[b + R1], P[b + G1], P[b + B1]] : [P[b + R2], P[b + G2], P[b + B2]];
              this.spawn(P[b + X], P[b + Y], P[b + Z], vx * 0.15, vy * 0.15, vz * 0.15,
                { life: rnd(0.25, 0.45), c1: c, size: 0.7, bright: 1.6, drag: 4, grav: 6 });
            }
          }
        }
        i++;
      }

      for (let j = this.lights.length - 1; j >= 0; j--) {
        const L = this.lights[j];
        L.I *= Math.exp(-2.2 * dt);
        if (L.I < 0.01) this.lights.splice(j, 1);
      }
    }

    // 波を進める。水面の画面より遅い刻みにして、遠目の湖らしい速さにする
    stepWater(dt) {
      const gl = this.gl;
      gl.bindVertexArray(this.quad);
      const simPass = (prog) => {
        const dst = this.simT[1 - this.cur];
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
        gl.viewport(0, 0, SIM, SIM);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.simT[this.cur].tex);
        gl.uniform1i(prog.u.uState, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        this.cur = 1 - this.cur;
      };
      if (this.drops.length) {
        const d = this.drop;
        gl.useProgram(d.p);
        const flat = new Float32Array(K.MAX_DROPS * 4);
        const widths = new Float32Array(K.MAX_DROPS);
        this.drops.forEach((v, i) => { flat.set(v.slice(0, 4), i * 4); widths[i] = v[4]; });
        gl.uniform4fv(d.u.uDrops, flat);
        gl.uniform1fv(d.u.uWidths, widths);
        gl.uniform1i(d.u.uCount, this.drops.length);
        gl.uniform2f(d.u.uSize, SIM, SIM);
        simPass(d);
        this.drops.length = 0;
      }
      const STEP = 1 / 60;
      this.acc = Math.min(this.acc + dt, 0.1);
      const s = this.sim;
      gl.useProgram(s.p);
      gl.uniform2f(s.u.uTexel, 1 / SIM, 1 / SIM);
      gl.uniform2f(s.u.uSize, SIM, SIM);
      // CD はないので、吸い込む円は画面の外へ置く
      gl.uniform2f(s.u.uCenter, -1e5, -1e5);
      gl.uniform1f(s.u.uRadius, 1);
      gl.uniform1f(s.u.uC2, 0.42);
      gl.uniform1f(s.u.uDamp, 0.996);
      while (this.acc >= STEP) {
        simPass(s);
        this.acc -= STEP;
      }
    }

    pass(prog, dst, inputs) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fb : null);
      gl.viewport(0, 0, dst ? dst.w : this.W, dst ? dst.h : this.H);
      inputs.forEach(([name, tex], i) => {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(prog.u[name], i);
      });
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    /** 粒子の値を、描画用の並びに詰める */
    fill() {
      const P = this.P;
      const A = this.inst;
      let k = 0;
      for (let i = 0; i < this.n; i++) {
        const b = i * NF;
        const a = P[b + AGE] / P[b + LIFE];
        const fade = a < 0.03 ? a / 0.03 : Math.pow(1 - a, 1.4);
        const e = fade * P[b + BRIGHT];
        const second = a >= P[b + SW];
        A[k++] = P[b + X]; A[k++] = P[b + Y]; A[k++] = P[b + Z];
        A[k++] = P[b + VX]; A[k++] = P[b + VY]; A[k++] = P[b + VZ];
        A[k++] = (second ? P[b + R2] : P[b + R1]) * e;
        A[k++] = (second ? P[b + G2] : P[b + G1]) * e;
        A[k++] = (second ? P[b + B2] : P[b + B1]) * e;
        A[k++] = P[b + SIZE];
        A[k++] = P[b + STREAK];
        A[k++] = P[b + FLICK];
      }
      // 上がっていく玉
      for (const s of this.shells) {
        A[k++] = s.x; A[k++] = s.y; A[k++] = s.z;
        A[k++] = 0; A[k++] = s.vy || 0; A[k++] = 0;
        A[k++] = 3; A[k++] = 2.2; A[k++] = 1.1;
        A[k++] = 1.3; A[k++] = 0.05; A[k++] = 0;
      }
      return k / STRIDE;
    }

    draw(dt) {
      const gl = this.gl;
      const f = this.fbos;
      this.stepWater(dt);

      // 1. 花火(前のフレームを薄めてから、加算で重ねる)
      gl.bindFramebuffer(gl.FRAMEBUFFER, f.fw.fb);
      gl.viewport(0, 0, this.W, this.H);
      gl.enable(gl.BLEND);
      const keep = Math.exp(-dt * 14);
      gl.blendColor(keep, keep, keep, 1);
      gl.blendFunc(gl.ZERO, gl.CONSTANT_COLOR);
      gl.useProgram(this.fade.p);
      gl.bindVertexArray(this.quad);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      const count = this.fill();
      if (count) {
        const p = this.particle;
        gl.useProgram(p.p);
        gl.uniform2f(p.u.uRes, this.W, this.H);
        gl.uniform1f(p.u.uHz, this.hz);
        gl.uniform1f(p.u.uF, this.f);
        gl.uniform1f(p.u.uMinW, this.minW);
        gl.uniform1f(p.u.uTime, this.t);
        gl.bindVertexArray(this.pvao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.ibuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.inst, 0, count * STRIDE);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
        gl.bindVertexArray(this.quad);
      }
      gl.disable(gl.BLEND);

      // 2. 夜空と湖面
      const s = this.scene;
      gl.useProgram(s.p);
      gl.uniform2f(s.u.uRes, this.W, this.H);
      gl.uniform1f(s.u.uHz, this.hz);
      gl.uniform1f(s.u.uF, this.f);
      gl.uniform1f(s.u.uTime, this.t);
      gl.uniform1f(s.u.uWind, this.wind);
      gl.uniform4f(s.u.uLake, LAKE[0], LAKE[1], LAKE[2], LAKE[3]);
      gl.uniform2f(s.u.uSimSize, SIM, SIM);
      const lp = new Float32Array(MAX_LIGHTS * 4);
      const lc = new Float32Array(MAX_LIGHTS * 3);
      this.lights.forEach((L, i) => {
        lp.set([L.x, L.y, L.r, L.I], i * 4);
        lc.set(L.col, i * 3);
      });
      gl.uniform4fv(s.u.uLights, lp);
      gl.uniform3fv(s.u.uLightCol, lc);
      gl.uniform1i(s.u.uLightN, this.lights.length);
      this.pass(s, f.scene, [['uFw', f.fw.tex], ['uState', this.simT[this.cur].tex]]);

      // 3. ブルーム
      const bloom = this.quality === 'high';
      if (bloom) {
        const b = this.bright;
        gl.useProgram(b.p);
        gl.uniform2f(b.u.uTexel, 1 / f.scene.w, 1 / f.scene.h);
        gl.uniform1f(b.u.uThresh, 0.8);
        this.pass(b, f.halfA, [['uSrc', f.scene.tex]]);
        const bl = this.blur;
        gl.useProgram(bl.p);
        gl.uniform2f(bl.u.uDir, 1.5 / f.halfA.w, 0);
        this.pass(bl, f.halfB, [['uSrc', f.halfA.tex]]);
        gl.uniform2f(bl.u.uDir, 0, 1.5 / f.halfA.h);
        this.pass(bl, f.halfA, [['uSrc', f.halfB.tex]]);
        gl.useProgram(b.p);
        gl.uniform2f(b.u.uTexel, 1 / f.halfA.w, 1 / f.halfA.h);
        gl.uniform1f(b.u.uThresh, 0);
        this.pass(b, f.quarterA, [['uSrc', f.halfA.tex]]);
        gl.useProgram(bl.p);
        gl.uniform2f(bl.u.uDir, 2 / f.quarterA.w, 0);
        this.pass(bl, f.quarterB, [['uSrc', f.quarterA.tex]]);
        gl.uniform2f(bl.u.uDir, 0, 2 / f.quarterA.h);
        this.pass(bl, f.quarterA, [['uSrc', f.quarterB.tex]]);
      }

      // 4. 仕上げ
      const fi = this.final;
      gl.useProgram(fi.p);
      gl.uniform1f(fi.u.uBloom, bloom ? 0.9 : 0);
      gl.uniform1f(fi.u.uAspect, this.W / this.H);
      gl.uniform1f(fi.u.uSeed, (this.t * 7.13) % 100);
      this.pass(fi, null, [['uScene', f.scene.tex], ['uBloomA', f.halfA.tex], ['uBloomB', f.quarterA.tex]]);
    }
  }

  window.Fireworks = Fireworks;
})();
