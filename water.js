'use strict';
/*
 * 水面のシミュレーションと描画(WebGL2)
 *
 * 高さ場を GPU 上で波動方程式として解く。テクスチャの R に現在の高さ、G に 1 ステップ前の高さを持ち、
 * 2 枚のテクスチャを交互に読み書きする(ping-pong)。
 * 描画は 1 枚の全画面シェーダーで、屈折・水底のコースティクス・反射・きらめき・中央の CD をまとめて描く。
 * file:// で開いても動くよう、ES modules を使わずに window.Water として公開する。
 */
(function () {
  const MAX_DROPS = 16;

  const VS = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

  // 波の 1 ステップ。9 点ラプラシアンを使うと、4 点より波紋が四角くゆがみにくい
  const SIM_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uState;
uniform vec2 uTexel;
uniform vec2 uSize;
uniform vec2 uCenter;
uniform float uRadius;
uniform float uC2;
uniform float uDamp;
float H(vec2 d) { return texture(uState, vUv + d * uTexel).r; }
void main() {
  vec4 s = texture(uState, vUv);
  float h = s.r;
  float hp = s.g;
  float edges = H(vec2(1.0, 0.0)) + H(vec2(-1.0, 0.0)) + H(vec2(0.0, 1.0)) + H(vec2(0.0, -1.0));
  float corners = H(vec2(1.0, 1.0)) + H(vec2(-1.0, 1.0)) + H(vec2(1.0, -1.0)) + H(vec2(-1.0, -1.0));
  float lap = (4.0 * edges + corners - 20.0 * h) / 6.0;
  // 画面の縁の近くは波を吸い込ませる。四角い縁で跳ね返った波が、四角い模様になって残るのを防ぐ
  vec2 p = vUv * uSize;
  float edge = min(min(p.x, uSize.x - p.x), min(p.y, uSize.y - p.y));
  float damp = uDamp * mix(0.93, 1.0, smoothstep(0.0, 28.0, edge));
  float hn = h + (h - hp) * damp + uC2 * lap;
  // CD の下は固定端にする。外へ出た波の一部が CD の縁で跳ね返る
  if (distance(p, uCenter) < uRadius * 0.96) hn = 0.0;
  o = vec4(hn, h, 0.0, 1.0);
}`;

  // しずくと波紋の注入。z が 0 なら点、正なら輪
  const DROP_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uState;
uniform vec2 uSize;
uniform vec4 uDrops[${MAX_DROPS}];
uniform float uWidths[${MAX_DROPS}];
uniform int uCount;
void main() {
  vec4 s = texture(uState, vUv);
  vec2 p = vUv * uSize;
  float add = 0.0;
  for (int i = 0; i < ${MAX_DROPS}; i++) {
    if (i >= uCount) break;
    vec4 d = uDrops[i];
    float x = (distance(p, d.xy) - d.z) / uWidths[i];
    add += d.w * exp(-x * x);
  }
  o = vec4(s.r + add, s.g, s.b, s.a);
}`;

  const RENDER_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uState;
uniform vec2 uSize;
uniform vec2 uCenter;
uniform float uRadius;
uniform float uRot;
uniform float uBob;
uniform float uGlow;

const float SLOPE = 2.6;     // 高さの差を法線の傾きに変える係数
const float DEPTH = 34.0;    // 水深(セル)
const float CAUSTK = 3.5;    // コースティクスの強さ
const float TILE = 24.0;     // タイルの一辺(セル)
const vec3 L  = vec3(-0.40, 0.50, 0.77);   // 主照明(水面から見た向き)
const vec3 L2 = vec3(0.55, -0.35, 0.76);   // 弱い補助照明

float H(vec2 q) { return texture(uState, q / uSize).r; }

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}

vec3 waterNormal(vec2 p) {
  float l = H(p - vec2(1.0, 0.0)), r = H(p + vec2(1.0, 0.0));
  float d = H(p - vec2(0.0, 1.0)), u = H(p + vec2(0.0, 1.0));
  return normalize(vec3((l - r) * SLOPE, (d - u) * SLOPE, 1.0));
}

// 水底のタイル
vec3 floorColor(vec2 q) {
  vec2 t = q / TILE;
  vec2 id = floor(t);
  vec2 f = fract(t);
  float e = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)) * TILE;
  float grout = smoothstep(0.5, 1.3, e);
  float n = hash(id);
  vec3 tile = mix(vec3(0.030, 0.120, 0.160), vec3(0.050, 0.165, 0.200), n);
  tile *= 0.86 + 0.14 * vnoise(q * 0.35) + 0.05 * vnoise(q * 1.7);
  // 目地のそばはわずかに暗い(タイルの縁の丸み)
  tile *= 0.9 + 0.1 * smoothstep(1.0, 4.0, e);
  return mix(vec3(0.012, 0.035, 0.045), tile, grout);
}

// 波の山の下で光が集まる。面の曲率(ラプラシアン)から集光の度合いを近似する
float caustic(vec2 q) {
  float c = H(q);
  float s = H(q + vec2(2.0, 0.0)) + H(q - vec2(2.0, 0.0)) + H(q + vec2(0.0, 2.0)) + H(q - vec2(0.0, 2.0));
  float s2 = H(q + vec2(1.5, 1.5)) + H(q - vec2(1.5, 1.5)) + H(q + vec2(1.5, -1.5)) + H(q - vec2(1.5, -1.5));
  float lap = ((s + s2) * 0.5 - 4.0 * c) / 4.0;
  return clamp(1.0 / max(0.3, 1.0 + CAUSTK * lap), 0.35, 3.0);
}

// 水面に映る夜の天井。照明は柔らかい円
vec3 sky(vec3 r) {
  vec3 base = mix(vec3(0.012, 0.018, 0.030), vec3(0.030, 0.045, 0.070), clamp(r.z, 0.0, 1.0));
  float a = max(dot(r, normalize(L)), 0.0);
  float b = max(dot(r, normalize(L2)), 0.0);
  base += vec3(1.00, 0.88, 0.70) * (pow(a, 900.0) * 9.0 + pow(a, 40.0) * 0.18);
  base += vec3(0.55, 0.70, 1.00) * (pow(b, 700.0) * 2.5 + pow(b, 30.0) * 0.05);
  return base;
}

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec2 p = vUv * uSize;
  vec3 n = waterNormal(p);
  vec3 cam = vec3(uSize * 0.5, max(uSize.x, uSize.y) * 1.2);
  vec3 V = normalize(vec3(p, 0.0) - cam);
  vec3 Ln = normalize(L);

  // 屈折して水底に届く点
  vec3 Rf = refract(V, n, 1.0 / 1.333);
  vec2 q = p + Rf.xy / max(-Rf.z, 0.2) * DEPTH;

  // 照明が水底に作る明るい溜まり
  vec2 lampSpot = uSize * 0.5 + Ln.xy / Ln.z * uSize.y * 0.35;
  float lamp = exp(-dot(q - lampSpot, q - lampSpot) / (uSize.y * uSize.y * 0.55));

  // コースティクスは光の入射方向にずらした水面から落ちる
  float ca = caustic(q + Ln.xy / Ln.z * DEPTH);
  // 集光は強さを少し強調する(実際の水底のコースティクスは網目がくっきり出る)
  float caE = pow(ca, 1.3);
  vec3 under = floorColor(q) * (0.14 + 1.15 * lamp * caE + 0.25 * (caE - 1.0));

  // CD の影。水面にある CD が水底に落とす影は、光と反対へずれる
  float sd = distance(q + Ln.xy / Ln.z * DEPTH, uCenter);
  under *= mix(0.32, 1.0, smoothstep(uRadius * 0.85, uRadius * 1.35, sd));

  // 水の吸収。通る距離が長いほど赤から失われる
  float path = DEPTH / max(-Rf.z, 0.2);
  under *= exp(-vec3(0.030, 0.012, 0.009) * path);
  under += vec3(0.004, 0.022, 0.030);

  // 反射
  vec3 Rr = reflect(V, n);
  float F = 0.02 + 0.98 * pow(1.0 - max(dot(-V, n), 0.0), 5.0);
  vec3 col = mix(under, sky(Rr), clamp(F * 3.0, 0.0, 1.0));
  // 波頭のきらめき
  float g = max(dot(Rr, Ln), 0.0);
  col += vec3(1.0, 0.93, 0.80) * (pow(g, 1400.0) * 5.0 + pow(g, 120.0) * 0.12);

  // CD の縁に水が寄って生まれる細い明るい輪と、水面の上の影
  vec2 dv = p - uCenter;
  float r = length(dv);
  float R = uRadius * (1.0 + uBob);
  float cs = distance(p, uCenter - Ln.xy * R * 0.07);
  col *= mix(0.55, 1.0, smoothstep(R * 0.98, R * 1.14, cs));
  col += vec3(0.6, 0.7, 0.8) * 0.18 * exp(-pow((r - R * 1.01) / 1.2, 2.0));

  // ---- CD ----
  if (r < R + 2.0) {
    float rr = r / R;
    float aa = max(fwidth(rr), 1e-4) * 1.2;
    float ang = atan(dv.y, dv.x);

    // 浮いている CD は下の波で傾く。傾きで虹の帯が動く
    float k = R * 1.18;
    float hx = H(uCenter + vec2(k, 0.0)) - H(uCenter - vec2(k, 0.0));
    float hy = H(uCenter + vec2(0.0, k)) - H(uCenter - vec2(0.0, k));
    vec3 cn = normalize(vec3(-hx * 0.9, -hy * 0.9, 1.0));
    vec3 Vc = normalize(vec3(p, 0.0) - cam);
    vec3 Rc = reflect(Vc, cn);

    // 回折格子の虹は、光の向きと中心を結ぶ線の上に出る
    vec3 hv = normalize(Ln - Vc);
    float la = atan(hv.y, hv.x) + (cn.x - cn.y) * 1.5;
    float s = sin(ang - la);
    float band = exp(-s * s * 10.0);
    float t = rr * 1.6 - (hv.z - cn.z) * 6.0 + cn.x * 2.0;
    vec3 rainbow = 0.5 + 0.5 * cos(6.2831 * (t + vec3(0.0, 0.33, 0.67)));
    float sheen = 0.5 + 0.5 * cos(2.0 * (ang - la));

    // 回転が見えるよう、記録面にごく薄い濃淡を付ける
    float spin = ang - uRot;
    float tracks = 0.035 * sin(r * 2.4) + 0.025 * sin(spin * 3.0) * smoothstep(0.35, 0.5, rr);

    vec3 env = sky(Rc);
    float spec = pow(max(dot(Rc, Ln), 0.0), 260.0) * 3.0;

    vec3 data = vec3(0.26, 0.28, 0.31) * (0.5 + 0.4 * sheen + tracks)
              + rainbow * band * (0.9 + uGlow * 0.8)
              + env * 0.7 + spec;
    // 曲の山場で少しだけ照り返しが強くなる
    data *= 1.0 + uGlow * 0.15;

    vec3 hub = mix(col, vec3(0.60, 0.64, 0.68), 0.22) + env * 0.5 + spec * 0.6;
    float marks = step(0.86, fract(spin / 6.2831 * 18.0)) * smoothstep(0.20, 0.21, rr) * (1.0 - smoothstep(0.27, 0.28, rr));
    hub = mix(hub, vec3(0.75, 0.78, 0.82), marks * 0.25);
    vec3 mirror = vec3(0.55, 0.57, 0.61) * (0.6 + 0.4 * sheen) + env + spec;
    vec3 rim = vec3(0.20, 0.21, 0.24) + env * 0.4;

    float inHub    = smoothstep(0.115 - aa, 0.115 + aa, rr);
    float inMirror = smoothstep(0.305 - aa, 0.305 + aa, rr);
    float inData   = smoothstep(0.335 - aa, 0.335 + aa, rr);
    float inRim    = smoothstep(0.985 - aa, 0.985 + aa, rr);
    float inside   = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, rr);

    vec3 cd = hub;
    cd = mix(cd, mirror, inMirror);
    cd = mix(cd, data, inData);
    cd = mix(cd, rim, inRim);
    // 中心の穴の縁と、ハブの重ね輪
    cd += vec3(0.25) * exp(-pow((rr - 0.118) / 0.006, 2.0));
    cd *= 1.0 - 0.18 * exp(-pow((rr - 0.235) / 0.012, 2.0));
    col = mix(col, cd, inHub * inside);
  }

  // 仕上げ
  col = aces(col * 1.0);
  col = pow(col, vec3(1.0 / 2.2));
  vec2 vc = vUv - 0.5;
  col *= 1.0 - 0.45 * pow(length(vc * vec2(uSize.x / uSize.y, 1.0)) * 0.9, 2.2);
  col += (hash(gl_FragCoord.xy + fract(uRot)) - 0.5) / 255.0;
  o = vec4(col, 1.0);
}`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(s) || 'shader compile failed');
    }
    return s;
  }

  function program(gl, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(p) || 'program link failed');
    }
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, '');
      u[name] = gl.getUniformLocation(p, gl.getActiveUniform(p, i).name);
    }
    return { p, u };
  }

  class Water {
    /** @param {HTMLCanvasElement} canvas */
    constructor(canvas) {
      this.canvas = canvas;
      const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: false });
      if (!gl) throw new Error('WebGL2 を使えません');
      this.gl = gl;
      // 浮動小数のテクスチャへ描き込むのに必要
      if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('浮動小数のテクスチャを使えません');
      // 32bit が線形補間できれば使う。半精度だと小さな波が量子化されて消え残りが出やすい
      this.full = !!gl.getExtension('OES_texture_float_linear');

      this.sim = program(gl, SIM_FS);
      this.drop = program(gl, DROP_FS);
      this.render = program(gl, RENDER_FS);

      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

      this.targets = [];
      this.drops = [];
      this.acc = 0;
      this.cellPx = 2;
      this.size = [1, 1];
    }

    /** 画面の大きさに合わせてシミュレーションの格子を作り直す。波は消える */
    resize(cssW, cssH, dpr) {
      const gl = this.gl;
      this.canvas.width = Math.round(cssW * dpr);
      this.canvas.height = Math.round(cssH * dpr);
      // 格子は長辺 640 セル程度まで。細かすぎると波が遅く見え、GPU も重くなる
      this.cellPx = Math.max(2, Math.ceil(Math.max(cssW, cssH) / 640));
      const w = Math.max(16, Math.round(cssW / this.cellPx));
      const h = Math.max(16, Math.round(cssH / this.cellPx));
      this.size = [w, h];

      for (const t of this.targets) {
        gl.deleteTexture(t.tex);
        gl.deleteFramebuffer(t.fb);
      }
      this.targets = [0, 1].map(() => {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, this.full ? gl.RGBA32F : gl.RGBA16F, w, h, 0, gl.RGBA, gl.FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        // 端は値を引き伸ばす。波は画面の縁で跳ね返る
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        return { tex, fb };
      });
      this.cur = 0;
    }

    /** CSS ピクセルの座標を格子の座標に変える(格子は下が y=0) */
    toCell(x, y) {
      return [x / this.cellPx, this.size[1] - y / this.cellPx];
    }

    /**
     * しずくを足す。座標と半径・幅は格子のセル単位
     * @param {number} radius 0 で点、正の値で輪
     */
    addDrop(x, y, radius, amp, width) {
      if (this.drops.length >= MAX_DROPS) return;
      this.drops.push([x, y, radius, amp, width]);
    }

    swapDraw(prog) {
      const gl = this.gl;
      const src = this.targets[this.cur];
      const dst = this.targets[1 - this.cur];
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
      gl.viewport(0, 0, this.size[0], this.size[1]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1i(prog.u.uState, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      this.cur = 1 - this.cur;
    }

    /** 経過時間ぶん波を進める。速さを画面の更新間隔に左右されないよう、固定の刻みで回す */
    step(dt, cd) {
      const gl = this.gl;
      if (this.drops.length) {
        const d = this.drop;
        gl.useProgram(d.p);
        const flat = new Float32Array(MAX_DROPS * 4);
        const widths = new Float32Array(MAX_DROPS);
        this.drops.forEach((v, i) => {
          flat.set(v.slice(0, 4), i * 4);
          widths[i] = v[4];
        });
        gl.uniform4fv(d.u.uDrops, flat);
        gl.uniform1fv(d.u.uWidths, widths);
        gl.uniform1i(d.u.uCount, this.drops.length);
        gl.uniform2f(d.u.uSize, this.size[0], this.size[1]);
        this.swapDraw(d);
        this.drops.length = 0;
      }

      const STEP = 1 / 240;
      this.acc = Math.min(this.acc + dt, 0.1);
      const s = this.sim;
      gl.useProgram(s.p);
      gl.uniform2f(s.u.uTexel, 1 / this.size[0], 1 / this.size[1]);
      gl.uniform2f(s.u.uSize, this.size[0], this.size[1]);
      gl.uniform2f(s.u.uCenter, cd.x, cd.y);
      gl.uniform1f(s.u.uRadius, cd.radius);
      gl.uniform1f(s.u.uC2, 0.42);
      gl.uniform1f(s.u.uDamp, cd.damp ?? 0.995);
      while (this.acc >= STEP) {
        this.swapDraw(s);
        this.acc -= STEP;
      }
    }

    draw(cd) {
      const gl = this.gl;
      const r = this.render;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.useProgram(r.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.targets[this.cur].tex);
      gl.uniform1i(r.u.uState, 0);
      gl.uniform2f(r.u.uSize, this.size[0], this.size[1]);
      gl.uniform2f(r.u.uCenter, cd.x, cd.y);
      gl.uniform1f(r.u.uRadius, cd.radius);
      gl.uniform1f(r.u.uRot, cd.rotation);
      gl.uniform1f(r.u.uBob, cd.bob);
      gl.uniform1f(r.u.uGlow, cd.glow);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  window.Water = Water;
})();
