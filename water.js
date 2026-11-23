'use strict';
/*
 * 水面のシミュレーションと描画(WebGL2)
 *
 * 1 フレームの流れ:
 *   1. 波: 高さ場を波動方程式で進める(R=今の高さ、G=1 ステップ前の高さ。2 枚を交互に読み書きする)
 *   2. コースティクス: 水面の格子の各点で光を屈折させて水底まで追い、面積の縮み具合から明るさを求める。
 *      波長ごとに屈折率を変えて 3 回描き、光の縁にわずかな色のにじみを出す
 *   3. 場面: 屈折して見える水底・天井の照明の映り込み・きらめき・CD を、明るさの上限なし(HDR)で描く
 *   4. ブルーム: 明るい所だけを取り出し、2 段階の解像度でぼかす
 *   5. 仕上げ: 場面とブルームを合わせ、トーンマップ・ガンマ・周辺減光をかける
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
  // 波を跳ね返さないよう、画面の縁と CD の下を「吸い込む層」にする。
  // 吸い込みの強さを急に変えると、その境目でも波が跳ね返るので、二乗でゆっくり強める
  vec2 p = vUv * uSize;
  float edge = min(min(p.x, uSize.x - p.x), min(p.y, uSize.y - p.y));
  float band = min(uSize.x, uSize.y) * 0.14;
  float xe = 1.0 - clamp(edge / band, 0.0, 1.0);
  float xc = 1.0 - clamp((distance(p, uCenter) - uRadius * 0.45) / (uRadius * 0.55), 0.0, 1.0);
  float x = max(xe, xc);
  float absorb = x * x;
  float hn = h + (h - hp) * uDamp * (1.0 - 0.10 * absorb) + uC2 * lap;
  hn *= 1.0 - 0.03 * absorb;
  o = vec4(hn, h, 0.0, 1.0);
}`;

  // しずくと波紋の注入。z が 0 なら点、正なら輪。
  // 幅が負のときは山と谷が 1 組になった鋭い輪にする(拍の波を、ほかの細かい波と見分けやすくする)
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
    float w = uWidths[i];
    float x = (distance(p, d.xy) - d.z) / abs(w);
    float g = exp(-x * x);
    add += w > 0.0 ? d.w * g : d.w * (-2.4 * x) * g;
  }
  o = vec4(s.r + add, s.g, s.b, s.a);
}`;

  // 水面の法線。シミュレーションの波に、いつも吹いている細かな風のさざ波を重ねる。
  // コースティクスと場面の両方で同じ法線を使わないと、光の網目と見た目の波がずれる
  const SURFACE = `
uniform sampler2D uState;
uniform vec2 uSize;
uniform float uTime;
uniform float uWind;
const float SLOPE = 2.6;
float H(vec2 q) { return texture(uState, q / uSize).r; }
vec2 microGrad(vec2 p) {
  // 向き(xy)と波長(z、セル)の違う正弦波の合計。深い水の分散関係で、長い波ほど速く進む
  const vec3 W[8] = vec3[8](
    vec3(0.80, 0.60, 34.0), vec3(-0.55, 0.83, 25.0), vec3(0.96, -0.28, 19.0), vec3(-0.71, -0.70, 46.0),
    vec3(0.24, 0.97, 14.0), vec3(-0.92, 0.39, 11.0), vec3(0.45, -0.89, 16.5), vec3(-0.18, -0.98, 29.0));
  vec2 g = vec2(0.0);
  for (int i = 0; i < 8; i++) {
    float k = 6.2831 / W[i].z;
    float om = sqrt(k) * 2.2;
    float ph = k * dot(W[i].xy, p) - om * uTime + float(i) * 1.7;
    g += W[i].xy * cos(ph) * (0.008 + 0.0004 * W[i].z);
  }
  return g * uWind;
}
vec2 simGrad(vec2 p) {
  float l = H(p - vec2(1.0, 0.0)), r = H(p + vec2(1.0, 0.0));
  float d = H(p - vec2(0.0, 1.0)), u = H(p + vec2(0.0, 1.0));
  return vec2(l - r, d - u) * SLOPE;
}
vec3 surfaceNormal(vec2 p) {
  return normalize(vec3(simGrad(p) - microGrad(p), 1.0));
}
`;

  const SCENE_CONST = `
const float DEPTH = 34.0;                  // 水深(セル)
// コースティクスのテクスチャは画面より一回り広く取る。光が斜めに入るので、画面の縁の外の水面からも光が届く
const float CMARGIN = 0.15;
vec2 causticUv(vec2 q, vec2 size) { return (q / size + CMARGIN) / (1.0 + 2.0 * CMARGIN); }
const vec3 LIGHT = vec3(-0.40, 0.50, 0.77); // 主照明の向き(水面から光へ)
`;

  // コースティクス: 水面の格子を、光が屈折して届く水底の位置へ動かして描く
  const CAUSTIC_VS = `#version 300 es
precision highp float;
in vec2 aPos;
${SURFACE}
${SCENE_CONST}
uniform float uIor;
uniform vec2 uCenter;
uniform float uRadius;
out vec2 vOld;
out vec2 vNew;
out float vPass;
void main() {
  vec2 p = aPos * uSize;
  // 実際のプールより浅い水深と弱いさざ波でも網目が出るよう、光の計算だけ細かい波の傾きを強める
  vec3 n = normalize(vec3(simGrad(p) * 2.2 - microGrad(p) * 4.5, 1.0));
  vec3 I = -normalize(LIGHT);
  vec3 r0 = refract(I, vec3(0.0, 0.0, 1.0), 1.0 / uIor);
  vec3 r = refract(I, n, 1.0 / uIor);
  vNew = p + r.xy / max(-r.z, 0.2) * DEPTH * 1.6;
  vOld = p + r0.xy / -r0.z * DEPTH * 1.6;
  // CD は光を通さない。中心の穴だけ通す
  float d = distance(p, uCenter) / uRadius;
  vPass = (d < 1.0 && d > 0.12) ? 0.0 : 1.0;
  gl_Position = vec4(causticUv(vNew, uSize) * 2.0 - 1.0, 0.0, 1.0);
}`;

  const CAUSTIC_FS = `#version 300 es
precision highp float;
in vec2 vOld;
in vec2 vNew;
in float vPass;
out vec4 o;
void main() {
  // 平らな水面のときの面積と、波で曲げられた後の面積の比が明るさになる
  vec2 a = dFdx(vOld), b = dFdy(vOld);
  vec2 c = dFdx(vNew), d = dFdy(vNew);
  float a0 = abs(a.x * b.y - a.y * b.x);
  float a1 = abs(c.x * d.y - c.y * d.x);
  float k = min(a0 / max(a1, 1e-6), 8.0) * vPass;
  o = vec4(k);
}`;

  const SCENE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
${SURFACE}
${SCENE_CONST}
uniform sampler2D uCaustic;
uniform vec2 uCenter;
uniform float uRadius;
uniform float uRot;
uniform float uBob;
uniform float uMood;
uniform float uFlash;

const float TILE = 24.0;

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

// 水底のタイル。目地は少し凹んでいて、縁が暗い
vec3 floorColor(vec2 q) {
  vec2 t = q / TILE;
  vec2 id = floor(t);
  vec2 f = fract(t);
  float e = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)) * TILE;
  float grout = smoothstep(0.5, 1.3, e);
  float n = hash(id);
  vec3 tile = mix(vec3(0.030, 0.120, 0.160), vec3(0.050, 0.165, 0.200), n);
  tile *= 0.86 + 0.14 * vnoise(q * 0.35) + 0.05 * vnoise(q * 1.7);
  tile *= 0.85 + 0.15 * smoothstep(1.0, 5.0, e);
  return mix(vec3(0.012, 0.035, 0.045), tile, grout);
}

// 照明の色。静かな所は青白い月明かり、盛り上がると暖かく明るくなる
vec3 lampColor() {
  return mix(vec3(0.50, 0.66, 1.00) * 0.70, vec3(1.00, 0.78, 0.52) * 1.60, uMood);
}

// 照明の形。角の丸い長方形からの距離
float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

// 映り込む天井。反射した光線が天井に当たる点を、平らな水面なら画面のどこに映るかに直して、照明を置く
vec3 ceiling(vec2 p, vec3 r, vec3 cam) {
  vec3 base = mix(vec3(0.010, 0.014, 0.024), vec3(0.025, 0.035, 0.055), clamp(r.z, 0.0, 1.0));
  if (r.z < 0.02) return base;
  float hc = cam.z * 0.8;
  vec2 c = p + r.xy / r.z * hc;
  vec2 m = cam.xy + (c - cam.xy) / (1.0 + hc / cam.z);
  vec2 S = uSize;
  float s1 = sdBox(m - vec2(S.x * 0.30, S.y * 0.83), vec2(S.x * 0.24, S.y * 0.005));
  float s2 = sdBox(m - vec2(S.x * 0.74, S.y * 0.20), vec2(S.x * 0.17, S.y * 0.005));
  float soft = S.y * 0.004;
  float strips = exp(-pow(max(s1, 0.0) / soft, 2.0)) + exp(-pow(max(s2, 0.0) / soft, 2.0));
  float halo = exp(-max(s1, 0.0) / (S.y * 0.05)) + exp(-max(s2, 0.0) / (S.y * 0.05));
  return base + lampColor() * (strips * 4.5 + halo * 0.04);
}

// 可視光の波長(nm)を色にする(Zucconi の近似)
vec3 bump3y(vec3 x, vec3 yo) {
  vec3 y = 1.0 - x * x;
  return clamp(y - yo, 0.0, 1.0);
}
vec3 spectral(float w) {
  if (w < 400.0 || w > 700.0) return vec3(0.0);
  float x = (w - 400.0) / 300.0;
  const vec3 c1 = vec3(3.54585104, 2.93225262, 2.41593945);
  const vec3 x1 = vec3(0.69549072, 0.49228336, 0.27699880);
  const vec3 y1 = vec3(0.02312639, 0.15225084, 0.52607955);
  const vec3 c2 = vec3(3.90307140, 3.21182957, 3.96587128);
  const vec3 x2 = vec3(0.11748627, 0.86755042, 0.66077860);
  const vec3 y2 = vec3(0.84897130, 0.88445281, 0.73949448);
  return bump3y(c1 * (x - x1), y1) + bump3y(c2 * (x - x2), y2);
}

void main() {
  vec2 p = vUv * uSize;
  vec3 n = surfaceNormal(p);
  vec3 cam = vec3(uSize * 0.5, max(uSize.x, uSize.y) * 1.2);
  vec3 V = normalize(vec3(p, 0.0) - cam);
  vec3 Ln = normalize(LIGHT);
  vec3 lc = lampColor();

  // 屈折して見える水底
  vec3 Rf = refract(V, n, 1.0 / 1.333);
  vec2 q = p + Rf.xy / max(-Rf.z, 0.2) * DEPTH;
  vec2 lampSpot = uSize * 0.5 + Ln.xy / Ln.z * uSize.y * 0.35;
  float lamp = exp(-dot(q - lampSpot, q - lampSpot) / (uSize.y * uSize.y * 0.6));
  vec3 caus = texture(uCaustic, causticUv(q, uSize)).rgb;
  vec3 light = vec3(0.020, 0.032, 0.045) + lc * (0.30 + 0.95 * lamp) * caus * (1.0 + 0.8 * uFlash);
  vec3 under = floorColor(q) * light;
  // 水の吸収。通る距離が長いほど赤から失われる
  float path = DEPTH / max(-Rf.z, 0.2);
  under *= exp(-vec3(0.030, 0.012, 0.009) * path);
  under += vec3(0.003, 0.016, 0.022) * (0.6 + 0.6 * uMood + uFlash * 0.4);

  // 反射
  vec3 Rr = reflect(V, n);
  float F = 0.02 + 0.98 * pow(1.0 - max(dot(-V, n), 0.0), 5.0);
  vec3 col = mix(under, ceiling(p, Rr, cam), clamp(F * 2.5, 0.0, 1.0));
  float g = max(dot(Rr, Ln), 0.0);
  col += lc * (pow(g, 1400.0) * 6.0 + pow(g, 120.0) * 0.10);

  // CD の縁に水が寄って生まれる細い明るい輪
  vec2 dv = p - uCenter;
  float r = length(dv);
  float R = uRadius * (1.0 - uBob);
  col += lc * 0.20 * exp(-pow((r - R * 1.012) / 1.1, 2.0));
  col *= mix(0.75, 1.0, smoothstep(R * 0.99, R * 1.06, r));

  // ---- CD ----
  if (r < R + 2.0) {
    float rr = r / R;
    float aa = max(fwidth(rr), 1e-4) * 1.2;
    float ang = atan(dv.y, dv.x);

    // 浮いている CD は下の波で傾く
    float k = uRadius * 1.18;
    float hx = H(uCenter + vec2(k, 0.0)) - H(uCenter - vec2(k, 0.0));
    float hy = H(uCenter + vec2(0.0, k)) - H(uCenter - vec2(0.0, k));
    vec3 cn = normalize(vec3(-hx * 0.9, -hy * 0.9, 1.0));

    vec3 P = vec3(p, 0.0);
    vec3 Vv = normalize(cam - P);
    // CD を照らすのは近くの電球。距離が近いので、場所ごとに光の向きが変わり、虹が半径方向に流れる
    vec3 lampPos = vec3(uCenter + vec2(-1.0, 1.25) * uRadius, uRadius * 2.4);
    vec3 Lp = normalize(lampPos - P);

    // 回折格子: 溝(同心円)と直角の向き T に沿って d(sinθi + sinθo) = mλ を満たす波長が光る
    vec3 T = vec3(dv / max(r, 1e-3), 0.0);
    T = normalize(T - cn * dot(T, cn));
    vec3 B = cross(cn, T);
    vec3 S = Lp + Vv;
    float u = abs(dot(T, S));
    float along = dot(B, S);
    float vis = exp(-along * along * 9.0);
    vec3 irid = vec3(0.0);
    for (int m = 1; m <= 3; m++) irid += spectral(1600.0 * u / float(m)) / float(m);
    irid *= vis * lc * 1.5;

    vec3 Rc = reflect(-Vv, cn);
    vec3 env = ceiling(p, Rc, cam);
    float spec = pow(max(dot(Rc, Lp), 0.0), 500.0) * 8.0 + pow(max(dot(Rc, Lp), 0.0), 40.0) * 0.12;
    float spin = ang - uRot;
    float tracks = 0.04 * sin(r * 2.4) + 0.03 * sin(spin * 3.0) * smoothstep(0.35, 0.5, rr);
    float shade = 0.75 + 0.25 * dot(cn, Lp);

    vec3 data = vec3(0.17, 0.18, 0.20) * shade * (1.0 + tracks) + env * 0.85 + irid + lc * spec;
    vec3 mirror = vec3(0.30, 0.31, 0.34) * shade + env * 1.1 + lc * spec;
    // ハブは透明な樹脂。下の水が少し明るく透けて見える
    vec3 hub = col * 0.75 + vec3(0.05, 0.055, 0.06) + env * 0.5 + lc * spec * 0.6;
    float marks = step(0.86, fract(spin / 6.2831 * 18.0)) * smoothstep(0.20, 0.21, rr) * (1.0 - smoothstep(0.27, 0.28, rr));
    hub = mix(hub, vec3(0.22, 0.23, 0.25) + env * 0.4, marks * 0.6);
    // 外周の 1.5% も透明な樹脂。縁で光が回り込んで明るい線になる
    vec3 rim = col * 0.6 + env * 0.6 + lc * 0.25 * exp(-pow((rr - 0.997) / 0.004, 2.0));

    float inHub    = smoothstep(0.115 - aa, 0.115 + aa, rr);
    float inMirror = smoothstep(0.305 - aa, 0.305 + aa, rr);
    float inData   = smoothstep(0.335 - aa, 0.335 + aa, rr);
    float inRim    = smoothstep(0.982 - aa, 0.982 + aa, rr);
    float inside   = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, rr);

    vec3 cd = hub;
    cd = mix(cd, mirror, inMirror);
    cd = mix(cd, data, inData);
    cd = mix(cd, rim, inRim);
    cd += lc * 0.15 * exp(-pow((rr - 0.118) / 0.006, 2.0));
    cd *= 1.0 - 0.25 * exp(-pow((rr - 0.235) / 0.012, 2.0));
    col = mix(col, cd, inHub * inside);
  }

  o = vec4(col, 1.0);
}`;

  // 明るい所だけを取り出しながら、半分の大きさに縮める
  const BRIGHT_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uThresh;
void main() {
  vec3 c = texture(uSrc, vUv + uTexel * vec2(-0.5, -0.5)).rgb
         + texture(uSrc, vUv + uTexel * vec2(0.5, -0.5)).rgb
         + texture(uSrc, vUv + uTexel * vec2(-0.5, 0.5)).rgb
         + texture(uSrc, vUv + uTexel * vec2(0.5, 0.5)).rgb;
  c *= 0.25;
  o = vec4(max(c - uThresh, 0.0), 1.0);
}`;

  const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uSrc;
uniform vec2 uDir;
void main() {
  const float W[5] = float[5](0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  vec3 c = texture(uSrc, vUv).rgb * W[0];
  for (int i = 1; i < 5; i++) {
    c += texture(uSrc, vUv + uDir * float(i)).rgb * W[i];
    c += texture(uSrc, vUv - uDir * float(i)).rgb * W[i];
  }
  o = vec4(c, 1.0);
}`;

  const FINAL_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uScene;
uniform sampler2D uBloomA;
uniform sampler2D uBloomB;
uniform float uBloom;
uniform float uAspect;
uniform float uSeed;
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
void main() {
  vec3 col = texture(uScene, vUv).rgb;
  col += (texture(uBloomA, vUv).rgb * 0.55 + texture(uBloomB, vUv).rgb * 0.75) * uBloom;
  col = aces(col);
  col = pow(col, vec3(1.0 / 2.2));
  vec2 vc = vUv - 0.5;
  col *= 1.0 - 0.45 * pow(length(vc * vec2(uAspect, 1.0)) * 0.9, 2.2);
  col += (hash(gl_FragCoord.xy + uSeed) - 0.5) / 255.0;
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

  function program(gl, fs, vs = VS) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(p) || 'program link failed');
    }
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
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
      // 32bit が線形補間できれば波に使う。半精度だと小さな波が量子化されて消え残りが出やすい
      this.full = !!gl.getExtension('OES_texture_float_linear');

      this.sim = program(gl, SIM_FS);
      this.drop = program(gl, DROP_FS);
      this.caustic = program(gl, CAUSTIC_FS, CAUSTIC_VS);
      this.scene = program(gl, SCENE_FS);
      this.bright = program(gl, BRIGHT_FS);
      this.blur = program(gl, BLUR_FS);
      this.final = program(gl, FINAL_FS);

      // 全画面の四角形
      this.quad = gl.createVertexArray();
      gl.bindVertexArray(this.quad);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

      // コースティクス用の格子(resize で作る)
      this.grid = gl.createVertexArray();
      this.gridVbo = gl.createBuffer();
      this.gridIbo = gl.createBuffer();
      this.gridCount = 0;

      this.targets = [];
      this.fbos = {};
      this.drops = [];
      this.acc = 0;
      this.cellPx = 2;
      this.size = [1, 1];
      /** 'high' はコースティクスの色のにじみとブルームあり。'low' は省く */
      this.quality = 'high';
    }

    makeTarget(w, h, internal) {
      const gl = this.gl;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      // 端は値を引き伸ばす
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return { tex, fb, w, h };
    }

    freeTarget(t) {
      if (!t) return;
      this.gl.deleteTexture(t.tex);
      this.gl.deleteFramebuffer(t.fb);
    }

    /** 画面の大きさに合わせて、格子と描画用のテクスチャを作り直す。波は消える */
    resize(cssW, cssH, dpr) {
      const gl = this.gl;
      const W = Math.max(1, Math.round(cssW * dpr));
      const Hh = Math.max(1, Math.round(cssH * dpr));
      this.canvas.width = W;
      this.canvas.height = Hh;
      // 格子は長辺 640 セル程度まで。細かすぎると波が遅く見え、GPU も重くなる
      this.cellPx = Math.max(2, Math.ceil(Math.max(cssW, cssH) / 640));
      const w = Math.max(16, Math.round(cssW / this.cellPx));
      const h = Math.max(16, Math.round(cssH / this.cellPx));
      this.size = [w, h];

      for (const t of this.targets) this.freeTarget(t);
      for (const t of Object.values(this.fbos)) this.freeTarget(t);
      const simFmt = this.full ? gl.RGBA32F : gl.RGBA16F;
      this.targets = [this.makeTarget(w, h, simFmt), this.makeTarget(w, h, simFmt)];
      this.cur = 0;
      // コースティクスは波より細かい解像度で受けると、光の線が鋭くなる
      const cs = Math.min(1.6 * 1.3, 1800 / Math.max(w, h));
      const hw = Math.ceil(W / 2), hh = Math.ceil(Hh / 2);
      const qw = Math.ceil(W / 4), qh = Math.ceil(Hh / 4);
      this.fbos = {
        caustic: this.makeTarget(Math.round(w * cs), Math.round(h * cs), gl.RGBA16F),
        scene: this.makeTarget(W, Hh, gl.RGBA16F),
        halfA: this.makeTarget(hw, hh, gl.RGBA16F),
        halfB: this.makeTarget(hw, hh, gl.RGBA16F),
        quarterA: this.makeTarget(qw, qh, gl.RGBA16F),
        quarterB: this.makeTarget(qw, qh, gl.RGBA16F),
      };

      // 格子は波の格子と同じ細かさ。縁の外まで少しはみ出させ、光が斜めに入っても水底に穴が開かないようにする
      const gw = Math.round(w * 1.5) + 1, gh = Math.round(h * 1.5) + 1;
      const verts = new Float32Array(gw * gh * 2);
      let i = 0;
      for (let y = 0; y < gh; y++) {
        for (let x = 0; x < gw; x++) {
          verts[i++] = -0.25 + 1.5 * (x / (gw - 1));
          verts[i++] = -0.25 + 1.5 * (y / (gh - 1));
        }
      }
      const idx = new Uint32Array((gw - 1) * (gh - 1) * 6);
      i = 0;
      for (let y = 0; y < gh - 1; y++) {
        for (let x = 0; x < gw - 1; x++) {
          const a = y * gw + x;
          idx[i++] = a; idx[i++] = a + 1; idx[i++] = a + gw;
          idx[i++] = a + 1; idx[i++] = a + gw + 1; idx[i++] = a + gw;
        }
      }
      gl.bindVertexArray(this.grid);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.gridVbo);
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.gridIbo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
      this.gridCount = idx.length;
      gl.bindVertexArray(this.quad);
    }

    /** CSS ピクセルの座標を格子の座標に変える(格子は下が y=0) */
    toCell(x, y) {
      return [x / this.cellPx, this.size[1] - y / this.cellPx];
    }

    /**
     * しずくを足す。座標と半径・幅は格子のセル単位
     * @param {number} radius 0 で点、正の値で輪
     * @param {number} width 負の値にすると、山と谷が 1 組の鋭い輪になる
     */
    addDrop(x, y, radius, amp, width) {
      if (this.drops.length >= MAX_DROPS) return;
      this.drops.push([x, y, radius, amp, width]);
    }

    bindTex(unit, tex, loc) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(loc, unit);
    }

    // src を読んで dst に全画面で描く
    pass(prog, dst, inputs) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fb : null);
      gl.viewport(0, 0, dst ? dst.w : this.canvas.width, dst ? dst.h : this.canvas.height);
      inputs.forEach(([name, tex], i) => this.bindTex(i, tex, prog.u[name]));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    simPass(prog) {
      const dst = this.targets[1 - this.cur];
      this.pass(prog, dst, [['uState', this.targets[this.cur].tex]]);
      this.cur = 1 - this.cur;
    }

    /** 経過時間ぶん波を進める。速さを画面の更新間隔に左右されないよう、固定の刻みで回す */
    step(dt, cd) {
      const gl = this.gl;
      gl.bindVertexArray(this.quad);
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
        this.simPass(d);
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
        this.simPass(s);
        this.acc -= STEP;
      }
    }

    setSurfaceUniforms(prog, cd) {
      const gl = this.gl;
      gl.uniform2f(prog.u.uSize, this.size[0], this.size[1]);
      gl.uniform1f(prog.u.uTime, cd.time);
      gl.uniform1f(prog.u.uWind, cd.wind);
    }

    draw(cd) {
      const gl = this.gl;
      const f = this.fbos;
      const state = this.targets[this.cur].tex;

      // 1. コースティクス(加算で重ねる)
      const c = this.caustic;
      gl.useProgram(c.p);
      gl.bindFramebuffer(gl.FRAMEBUFFER, f.caustic.fb);
      gl.viewport(0, 0, f.caustic.w, f.caustic.h);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.bindTex(0, state, c.u.uState);
      this.setSurfaceUniforms(c, cd);
      gl.uniform2f(c.u.uCenter, cd.x, cd.y);
      gl.uniform1f(c.u.uRadius, cd.radius);
      gl.bindVertexArray(this.grid);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      // 赤・緑・青で屈折率をわずかに変え、光の網目の縁に色のにじみを出す
      const passes = this.quality === 'high'
        ? [[1.329, [true, false, false]], [1.333, [false, true, false]], [1.338, [false, false, true]]]
        : [[1.333, [true, true, true]]];
      for (const [ior, mask] of passes) {
        gl.colorMask(mask[0], mask[1], mask[2], false);
        gl.uniform1f(c.u.uIor, ior);
        gl.drawElements(gl.TRIANGLES, this.gridCount, gl.UNSIGNED_INT, 0);
      }
      gl.colorMask(true, true, true, true);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(this.quad);

      // 2. 場面
      const s = this.scene;
      gl.useProgram(s.p);
      this.setSurfaceUniforms(s, cd);
      gl.uniform2f(s.u.uCenter, cd.x, cd.y);
      gl.uniform1f(s.u.uRadius, cd.radius);
      gl.uniform1f(s.u.uRot, cd.rotation);
      gl.uniform1f(s.u.uBob, cd.bob);
      gl.uniform1f(s.u.uMood, cd.mood);
      gl.uniform1f(s.u.uFlash, cd.flash);
      this.pass(s, f.scene, [['uState', state], ['uCaustic', f.caustic.tex]]);

      // 3. ブルーム
      const bloom = this.quality === 'high';
      if (bloom) {
        const b = this.bright;
        gl.useProgram(b.p);
        gl.uniform2f(b.u.uTexel, 1 / f.scene.w, 1 / f.scene.h);
        gl.uniform1f(b.u.uThresh, 0.9);
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
      gl.uniform1f(fi.u.uBloom, bloom ? 1 : 0);
      gl.uniform1f(fi.u.uAspect, this.size[0] / this.size[1]);
      gl.uniform1f(fi.u.uSeed, (cd.time * 7.13) % 100);
      this.pass(fi, null, [['uScene', f.scene.tex], ['uBloomA', f.halfA.tex], ['uBloomB', f.quarterA.tex]]);
    }
  }

  window.Water = Water;
  // 花火の画面でも、波・ブルーム・仕上げのシェーダーを使い回す
  window.GLKit = { VS, SIM_FS, DROP_FS, BRIGHT_FS, BLUR_FS, FINAL_FS, MAX_DROPS, compile, program };
})();
