// ============================================================================
// mini3d — a tiny zero-dependency WebGL engine with a Three.js-shaped API,
// covering exactly what BOPBALL FC uses. ~One shader, scene graph, lights,
// canvas textures, instancing (looped), GL points. MIT-spirited, hand-rolled.
// ============================================================================

// ------------------------------------------------------------- math ---------
export class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  setScalar(s) { this.x = this.y = this.z = s; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
}
export class Euler {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
}
export class Color {
  constructor(c = 0xffffff) { this.r = 1; this.g = 1; this.b = 1; if (c !== undefined) this.setHex(c); }
  setHex(h) { if (h instanceof Color) { this.r = h.r; this.g = h.g; this.b = h.b; return this; }
    this.r = ((h >> 16) & 255) / 255; this.g = ((h >> 8) & 255) / 255; this.b = (h & 255) / 255; return this; }
  copy(c) { this.r = c.r; this.g = c.g; this.b = c.b; return this; }
}
function mat4Identity() { const e = new Float32Array(16); e[0] = e[5] = e[10] = e[15] = 1; return e; }
const _mulScratch = new Float32Array(16);
function mat4Multiply(out, a, b) { // out = a * b (allocation-free)
  const o = _mulScratch;
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  out.set(o); return out;
}
function mat4Compose(out, p, e, s) { // XYZ-ish euler: R = Ry * Rx * Rz (heading, pitch, roll)
  const cx = Math.cos(e.x), sx = Math.sin(e.x), cy = Math.cos(e.y), sy = Math.sin(e.y), cz = Math.cos(e.z), sz = Math.sin(e.z);
  // Ry*Rx
  const r00 = cy, r01 = sy * sx, r02 = sy * cx;
  const r10 = 0, r11 = cx, r12 = -sx;
  const r20 = -sy, r21 = cy * sx, r22 = cy * cx;
  // (*Rz)
  const m00 = r00 * cz + r01 * sz, m01 = -r00 * sz + r01 * cz, m02 = r02;
  const m10 = r10 * cz + r11 * sz, m11 = -r10 * sz + r11 * cz, m12 = r12;
  const m20 = r20 * cz + r21 * sz, m21 = -r20 * sz + r21 * cz, m22 = r22;
  out[0] = m00 * s.x; out[1] = m10 * s.x; out[2] = m20 * s.x; out[3] = 0;
  out[4] = m01 * s.y; out[5] = m11 * s.y; out[6] = m21 * s.y; out[7] = 0;
  out[8] = m02 * s.z; out[9] = m12 * s.z; out[10] = m22 * s.z; out[11] = 0;
  out[12] = p.x; out[13] = p.y; out[14] = p.z; out[15] = 1;
  return out;
}
function mat4Perspective(out, fovDeg, aspect, near, far) {
  const f = 1 / Math.tan(fovDeg * Math.PI / 360);
  out.fill(0);
  out[0] = f / aspect; out[5] = f;
  out[10] = (far + near) / (near - far); out[11] = -1;
  out[14] = 2 * far * near / (near - far);
  return out;
}
function mat4LookAt(out, eye, tgt) {
  let zx = eye.x - tgt.x, zy = eye.y - tgt.y, zz = eye.z - tgt.z;
  let zl = Math.hypot(zx, zy, zz) || 1; zx /= zl; zy /= zl; zz /= zl;
  let xx = zz, xy2 = 0, xz = -zx;           // up = (0,1,0): x = up × z = (zz, 0, -zx)
  let xl = Math.hypot(xx, xy2, xz) || 1; xx /= xl; xz /= xl;
  const yx = zy * xz - zz * xy2, yy = zz * xx - zx * xz, yz = zx * xy2 - zy * xx;
  out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
  out[4] = xy2; out[5] = yy; out[6] = zy; out[7] = 0;
  out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
  out[12] = -(xx * eye.x + xy2 * eye.y + xz * eye.z);
  out[13] = -(yx * eye.x + yy * eye.y + yz * eye.z);
  out[14] = -(zx * eye.x + zy * eye.y + zz * eye.z);
  out[15] = 1;
  return out;
}
function normalFromMat4(out, m) { // inverse-transpose of upper 3x3
  const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  let det = a * A + b * B + c * C; if (!det) det = 1;
  const id = 1 / det;
  out[0] = A * id; out[3] = (c * h - b * i) * id; out[6] = (b * f - c * e) * id;
  out[1] = B * id; out[4] = (a * i - c * g) * id; out[7] = (c * d - a * f) * id;
  out[2] = C * id; out[5] = (b * g - a * h) * id; out[8] = (a * e - b * d) * id;
  // transpose in place (allocation-free)
  let t;
  t = out[1]; out[1] = out[3]; out[3] = t;
  t = out[2]; out[2] = out[6]; out[6] = t;
  t = out[5]; out[5] = out[7]; out[7] = t;
  return out;
}

// -------------------------------------------------------- scene graph -------
export const DoubleSide = 2;
let _id = 1;
export class Object3D {
  constructor() {
    this.id = _id++; this.children = []; this.parent = null;
    this.position = new Vector3(); this.rotation = new Euler();
    this.scale = new Vector3(1, 1, 1);
    this.visible = true; this.userData = {};
    this.matrix = mat4Identity(); this.worldMatrix = mat4Identity();
    this.frustumCulled = true;
  }
  add(...os) { for (const o of os) { o.parent = this; this.children.push(o); } return this; }
  remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); return this; }
  clone() { // shallow-ish clone for simple meshes
    const c = new this.constructor(this.geometry, this.material);
    c.position.copy(this.position); c.scale.copy(this.scale);
    c.rotation = new Euler(this.rotation.x, this.rotation.y, this.rotation.z);
    return c;
  }
  updateMatrix() { mat4Compose(this.matrix, this.position, this.rotation, this.scale); }
  traverse(cb) { cb(this); for (const c of this.children) c.traverse(cb); }
}
export class Group extends Object3D {}
export class Scene extends Object3D {
  constructor() { super(); this.background = null; this.fog = null; }
}
export class Fog {
  constructor(color, near, far) { this.color = new Color(color); this.near = near; this.far = far; }
}
export class PerspectiveCamera extends Object3D {
  constructor(fov = 50, aspect = 1, near = 0.1, far = 1000) {
    super(); this.fov = fov; this.aspect = aspect; this.near = near; this.far = far;
    this.proj = new Float32Array(16); this.view = new Float32Array(16);
    this._target = new Vector3(0, 0, 0);
    this.updateProjectionMatrix();
  }
  updateProjectionMatrix() { mat4Perspective(this.proj, this.fov, this.aspect, this.near, this.far); }
  lookAt(a, b, c) {
    if (a instanceof Vector3) this._target.copy(a); else this._target.set(a, b, c);
  }
}
export class HemisphereLight extends Object3D {
  constructor(sky, ground, intensity = 1) { super(); this.isHemi = true; this.skyColor = new Color(sky); this.groundColor = new Color(ground); this.intensity = intensity; }
}
export class DirectionalLight extends Object3D {
  constructor(color, intensity = 1) { super(); this.isDir = true; this.color = new Color(color); this.intensity = intensity; }
}

// ---------------------------------------------------------- materials -------
export class MeshLambertMaterial {
  constructor(opts = {}) {
    this.color = new Color(opts.color !== undefined ? opts.color : 0xffffff);
    this.map = opts.map || null;
    this.transparent = !!opts.transparent;
    this.opacity = opts.opacity !== undefined ? opts.opacity : 1;
    this.side = opts.side || 0;
    this.lit = true;
  }
  dispose() {}
}
export class MeshBasicMaterial extends MeshLambertMaterial {
  constructor(opts = {}) { super(opts); this.lit = false; }
}
export class PointsMaterial {
  constructor(opts = {}) {
    this.size = opts.size || 1; this.vertexColors = !!opts.vertexColors;
    this.transparent = !!opts.transparent; this.opacity = opts.opacity ?? 1;
  }
  dispose() {}
}
export class CanvasTexture {
  constructor(canvas) { this.canvas = canvas; this.needsUpdate = true; this._tex = null; this.anisotropy = 1; }
  dispose() {}
}

// ---------------------------------------------------------- geometry --------
export class BufferAttribute {
  constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; this.needsUpdate = false; }
}
export class BufferGeometry {
  constructor() { this.attributes = {}; this.index = null; this._vbo = {}; }
  setAttribute(name, attr) { this.attributes[name] = attr; return this; }
  dispose() {}
}
function geo(positions, normals, uvs, indices) {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  g.index = new Uint16Array(indices);
  return g;
}
export function SphereGeometry(r = 1, ws = 12, hs = 8, phiStart = 0, phiLen = Math.PI * 2, thetaStart = 0, thetaLen = Math.PI) {
  const P = [], N = [], U = [], I = [];
  for (let y = 0; y <= hs; y++) {
    const v = y / hs, theta = thetaStart + v * thetaLen;
    for (let x = 0; x <= ws; x++) {
      const u = x / ws, phi = phiStart + u * phiLen;
      const nx = Math.sin(theta) * Math.cos(phi), ny = Math.cos(theta), nz = Math.sin(theta) * Math.sin(phi);
      P.push(r * nx, r * ny, r * nz); N.push(nx, ny, nz); U.push(u, 1 - v);
    }
  }
  for (let y = 0; y < hs; y++) for (let x = 0; x < ws; x++) {
    const a = y * (ws + 1) + x, b = a + ws + 1;
    I.push(a, b, a + 1, b, b + 1, a + 1);
  }
  return geo(P, N, U, I);
}
export function PlaneGeometry(w = 1, h = 1) {
  return geo(
    [-w / 2, h / 2, 0, w / 2, h / 2, 0, -w / 2, -h / 2, 0, w / 2, -h / 2, 0],
    [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    [0, 1, 1, 1, 0, 0, 1, 0],
    [0, 2, 1, 2, 3, 1]);
}
export function CircleGeometry(r = 1, seg = 16) {
  const P = [0, 0, 0], N = [0, 0, 1], U = [0.5, 0.5], I = [];
  for (let i = 0; i <= seg; i++) {
    const a = i / seg * Math.PI * 2;
    P.push(Math.cos(a) * r, Math.sin(a) * r, 0); N.push(0, 0, 1); U.push(0.5 + Math.cos(a) / 2, 0.5 + Math.sin(a) / 2);
    if (i > 0) I.push(0, i, i + 1);
  }
  return geo(P, N, U, I);
}
export function BoxGeometry(w = 1, h = 1, d = 1) {
  const x = w / 2, y = h / 2, z = d / 2;
  const faces = [
    [[x, -y, -z], [x, y, -z], [x, -y, z], [x, y, z], [1, 0, 0]],
    [[-x, -y, z], [-x, y, z], [-x, -y, -z], [-x, y, -z], [-1, 0, 0]],
    [[-x, y, z], [x, y, z], [-x, y, -z], [x, y, -z], [0, 1, 0]],
    [[-x, -y, -z], [x, -y, -z], [-x, -y, z], [x, -y, z], [0, -1, 0]],
    [[-x, -y, z], [x, -y, z], [-x, y, z], [x, y, z], [0, 0, 1]],
    [[x, -y, -z], [-x, -y, -z], [x, y, -z], [-x, y, -z], [0, 0, -1]],
  ];
  const P = [], N = [], U = [], I = [];
  let vi = 0;
  for (const [a, b, c, dd, n] of faces) {
    P.push(...a, ...b, ...c, ...dd);
    for (let i = 0; i < 4; i++) N.push(...n);
    U.push(0, 0, 1, 0, 0, 1, 1, 1);
    I.push(vi, vi + 1, vi + 2, vi + 1, vi + 3, vi + 2);
    vi += 4;
  }
  return geo(P, N, U, I);
}
export function CylinderGeometry(rt = 1, rb = 1, h = 1, seg = 12, hseg = 1, open = false) {
  const P = [], N = [], U = [], I = [];
  const half = h / 2, slope = (rb - rt) / h;
  for (let y = 0; y <= 1; y++) {
    const r = y === 0 ? rt : rb, py = y === 0 ? half : -half;
    for (let i = 0; i <= seg; i++) {
      const a = i / seg * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      P.push(r * ca, py, r * sa);
      const nl = Math.hypot(1, slope);
      N.push(ca / nl, slope / nl, sa / nl);
      U.push(i / seg, 1 - y);
    }
  }
  for (let i = 0; i < seg; i++) {
    const a = i, b = i + seg + 1;
    I.push(a, b, a + 1, b, b + 1, a + 1);
  }
  let base = P.length / 3;
  if (!open) {
    for (const [r, py, ny] of [[rt, half, 1], [rb, -half, -1]]) {
      if (r <= 0) continue;
      const center = base;
      P.push(0, py, 0); N.push(0, ny, 0); U.push(0.5, 0.5);
      for (let i = 0; i <= seg; i++) {
        const a = i / seg * Math.PI * 2;
        P.push(r * Math.cos(a), py, r * Math.sin(a)); N.push(0, ny, 0); U.push(0.5, 0.5);
        if (i > 0) {
          if (ny > 0) I.push(center, center + i + 1, center + i);
          else I.push(center, center + i, center + i + 1);
        }
      }
      base = P.length / 3;
    }
  }
  return geo(P, N, U, I);
}
export function ConeGeometry(r = 1, h = 1, seg = 8) { return CylinderGeometry(0.001, r, h, seg); }
export function CapsuleGeometry(r = 1, len = 1, capSeg = 4, radSeg = 8) {
  // built as a stretched sphere: top hemisphere + cylinder + bottom hemisphere
  const P = [], N = [], U = [], I = [];
  const rows = [];
  const half = len / 2;
  for (let y = 0; y <= capSeg; y++) { // top cap: theta 0..PI/2
    const t = (y / capSeg) * Math.PI / 2;
    rows.push({ r: Math.sin(t) * r, py: half + Math.cos(t) * r, ny: Math.cos(t), nr: Math.sin(t) });
  }
  for (let y = 0; y <= capSeg; y++) { // bottom cap: PI/2..PI
    const t = Math.PI / 2 + (y / capSeg) * Math.PI / 2;
    rows.push({ r: Math.sin(t) * r, py: -half + Math.cos(t) * r, ny: Math.cos(t), nr: Math.sin(t) });
  }
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri];
    for (let i = 0; i <= radSeg; i++) {
      const a = i / radSeg * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      P.push(row.r * ca, row.py, row.r * sa);
      N.push(row.nr * ca, row.ny, row.nr * sa);
      U.push(i / radSeg, ri / (rows.length - 1));
    }
  }
  for (let y = 0; y < rows.length - 1; y++) for (let i = 0; i < radSeg; i++) {
    const a = y * (radSeg + 1) + i, b = a + radSeg + 1;
    I.push(a, b, a + 1, b, b + 1, a + 1);
  }
  return geo(P, N, U, I);
}
export function TorusGeometry(R = 1, tube = 0.4, rs = 8, ts = 16) {
  const P = [], N = [], U = [], I = [];
  for (let j = 0; j <= rs; j++) {
    for (let i = 0; i <= ts; i++) {
      const u = i / ts * Math.PI * 2, v = j / rs * Math.PI * 2;
      const cx = Math.cos(u) * R, cy = Math.sin(u) * R;
      P.push((R + tube * Math.cos(v)) * Math.cos(u), (R + tube * Math.cos(v)) * Math.sin(u), tube * Math.sin(v));
      N.push(Math.cos(v) * Math.cos(u), Math.cos(v) * Math.sin(u), Math.sin(v));
      U.push(i / ts, j / rs);
    }
  }
  for (let j = 0; j < rs; j++) for (let i = 0; i < ts; i++) {
    const a = j * (ts + 1) + i, b = a + ts + 1;
    I.push(a, b, a + 1, b, b + 1, a + 1);
  }
  return geo(P, N, U, I);
}

// ------------------------------------------------------------- meshes -------
export class Mesh extends Object3D {
  constructor(geometry, material) { super(); this.geometry = geometry; this.material = material; this.isMesh = true; }
}
export class InstancedMesh extends Mesh {
  constructor(geometry, material, count) {
    super(geometry, material);
    this.isInstanced = true; this.count = count;
    this._mats = []; for (let i = 0; i < count; i++) this._mats.push(mat4Identity());
    this._cols = null;
    this.instanceMatrix = { needsUpdate: false };
  }
  setMatrixAt(i, obj) { this._mats[i].set(obj.matrix ? obj.matrix : obj); }
  setColorAt(i, c) { if (!this._cols) this._cols = new Array(this.count); this._cols[i] = [c.r, c.g, c.b]; }
}
export class Points extends Object3D {
  constructor(geometry, material) { super(); this.geometry = geometry; this.material = material; this.isPoints = true; }
}

// ------------------------------------------------------------ renderer ------
const VERT = `
attribute vec3 position; attribute vec3 normal; attribute vec2 uv;
uniform mat4 uProj, uView, uModel; uniform mat3 uNormalM;
varying vec3 vNormal; varying vec2 vUv; varying float vDist;
void main(){
  vec4 wp = uModel * vec4(position, 1.0);
  vec4 vp = uView * wp;
  gl_Position = uProj * vp;
  vNormal = uNormalM * normal;
  vUv = uv; vDist = -vp.z;
}`;
const FRAG = `
precision mediump float;
uniform vec3 uColor; uniform float uOpacity;
uniform bool uUseMap; uniform sampler2D uMap;
uniform bool uLit;
uniform vec3 uDirColor; uniform vec3 uDirDir; uniform float uDirI;
uniform vec3 uHemiSky; uniform vec3 uHemiGround; uniform float uHemiI;
uniform vec3 uFogColor; uniform float uFogNear; uniform float uFogFar; uniform bool uUseFog;
varying vec3 vNormal; varying vec2 vUv; varying float vDist;
void main(){
  vec3 base = uColor; float alpha = uOpacity;
  if (uUseMap) { vec4 t = texture2D(uMap, vUv); base *= t.rgb; alpha *= t.a; if (alpha < 0.03) discard; }
  vec3 col = base;
  if (uLit) {
    vec3 n = normalize(vNormal);
    float dl = max(dot(n, normalize(uDirDir)), 0.0);
    float hemiMix = n.y * 0.5 + 0.5;
    vec3 amb = mix(uHemiGround, uHemiSky, hemiMix) * uHemiI;
    col = base * (amb * 0.62 + uDirColor * dl * uDirI * 0.62 + 0.14);
  }
  if (uUseFog) { float f = smoothstep(uFogNear, uFogFar, vDist); col = mix(col, uFogColor, f); }
  gl_FragColor = vec4(col, alpha);
}`;
const PVERT = `
attribute vec3 position; attribute vec3 color;
uniform mat4 uProj, uView; uniform float uSize; uniform float uScaleH;
varying vec3 vColor;
void main(){
  vec4 vp = uView * vec4(position, 1.0);
  gl_Position = uProj * vp;
  gl_PointSize = uSize * (uScaleH / max(-vp.z, 0.5));
  vColor = color;
}`;
const PFRAG = `
precision mediump float;
uniform float uOpacity; varying vec3 vColor;
void main(){
  vec2 d = gl_PointCoord - vec2(0.5);
  if (dot(d, d) > 0.25) discard;
  gl_FragColor = vec4(vColor, uOpacity);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src); gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(sh));
  return sh;
}
function program(gl, v, f) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, v));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, f));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
  const uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); uniforms[info.name] = gl.getUniformLocation(p, info.name); }
  const attribs = {};
  const an = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
  for (let i = 0; i < an; i++) { const info = gl.getActiveAttrib(p, i); attribs[info.name] = gl.getAttribLocation(p, info.name); }
  return { p, u: uniforms, a: attribs };
}

export class WebGLRenderer {
  constructor(opts = {}) {
    this.canvas = opts.canvas || document.createElement('canvas');
    const gl = this.canvas.getContext('webgl', { antialias: opts.antialias !== false, alpha: false })
      || this.canvas.getContext('experimental-webgl');
    if (!gl) throw new Error('WebGL unavailable');
    this.gl = gl;
    this.ratio = 1;
    this.prog = program(gl, VERT, FRAG);
    this.pprog = program(gl, PVERT, PFRAG);
    this._geoCache = new Map();   // geometry → {vbo,nbo,ubo,ibo,count}
    this._texCache = new Map();
    this._normalM = new Float32Array(9);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  }
  setPixelRatio(r) { this.ratio = r; }
  setSize(w, h) {
    this.canvas.width = Math.floor(w * this.ratio); this.canvas.height = Math.floor(h * this.ratio);
    this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }
  _geoBuffers(g) {
    let b = this._geoCache.get(g);
    if (!b) {
      const gl = this.gl;
      b = {};
      b.vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, g.attributes.position.array, gl.STATIC_DRAW);
      if (g.attributes.normal) {
        b.nbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b.nbo);
        gl.bufferData(gl.ARRAY_BUFFER, g.attributes.normal.array, gl.STATIC_DRAW);
      }
      if (g.attributes.uv) {
        b.ubo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b.ubo);
        gl.bufferData(gl.ARRAY_BUFFER, g.attributes.uv.array, gl.STATIC_DRAW);
      }
      if (g.index) {
        b.ibo = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, g.index, gl.STATIC_DRAW);
        b.count = g.index.length;
      } else {
        b.count = g.attributes.position.array.length / 3;
      }
      this._geoCache.set(g, b);
    }
    return b;
  }
  _texture(t) {
    const gl = this.gl;
    let tex = this._texCache.get(t);
    if (!tex) { tex = gl.createTexture(); this._texCache.set(t, tex); t.needsUpdate = true; }
    if (t.needsUpdate) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, t.canvas);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      t.needsUpdate = false;
    }
    return tex;
  }
  render(scene, camera) {
    const gl = this.gl;
    const bg = scene.background || new Color(0x000000);
    gl.clearColor(bg.r, bg.g, bg.b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    camera.updateMatrix();
    mat4LookAt(camera.view, camera.position, camera._target);

    // collect lights + draw list (arrays reused across frames)
    let hemi = null, dirL = null;
    const opaque = this._opaque || (this._opaque = []);
    const transparent = this._transparent || (this._transparent = []);
    const points = this._points || (this._points = []);
    opaque.length = 0; transparent.length = 0; points.length = 0;
    const walk = (node, parentW, parentVisible) => {
      if (!node.visible) return;
      node.updateMatrix();
      mat4Multiply(node.worldMatrix, parentW, node.matrix);
      if (node.isHemi) hemi = node;
      else if (node.isDir) dirL = node;
      else if (node.isPoints) points.push(node);
      else if (node.isMesh) {
        (node.material.transparent ? transparent : opaque).push(node);
      }
      for (const c of node.children) walk(c, node.worldMatrix, true);
    };
    const ID = this._rootID || (this._rootID = mat4Identity());
    walk(scene, ID, true);

    const P = this.prog;
    gl.useProgram(P.p);
    gl.uniformMatrix4fv(P.u.uProj, false, camera.proj);
    gl.uniformMatrix4fv(P.u.uView, false, camera.view);
    if (hemi) {
      gl.uniform3f(P.u.uHemiSky, hemi.skyColor.r, hemi.skyColor.g, hemi.skyColor.b);
      gl.uniform3f(P.u.uHemiGround, hemi.groundColor.r, hemi.groundColor.g, hemi.groundColor.b);
      gl.uniform1f(P.u.uHemiI, hemi.intensity);
    } else { gl.uniform1f(P.u.uHemiI, 0.6); gl.uniform3f(P.u.uHemiSky, 1, 1, 1); gl.uniform3f(P.u.uHemiGround, 0.4, 0.4, 0.4); }
    if (dirL) {
      const dp = dirL.position;
      const l = Math.hypot(dp.x, dp.y, dp.z) || 1;
      gl.uniform3f(P.u.uDirDir, dp.x / l, dp.y / l, dp.z / l);
      gl.uniform3f(P.u.uDirColor, dirL.color.r, dirL.color.g, dirL.color.b);
      gl.uniform1f(P.u.uDirI, dirL.intensity);
    } else { gl.uniform1f(P.u.uDirI, 0); gl.uniform3f(P.u.uDirDir, 0, 1, 0); gl.uniform3f(P.u.uDirColor, 1, 1, 1); }
    if (scene.fog) {
      gl.uniform1i(P.u.uUseFog, 1);
      gl.uniform3f(P.u.uFogColor, scene.fog.color.r, scene.fog.color.g, scene.fog.color.b);
      gl.uniform1f(P.u.uFogNear, scene.fog.near); gl.uniform1f(P.u.uFogFar, scene.fog.far);
    } else gl.uniform1i(P.u.uUseFog, 0);

    gl.disable(gl.BLEND); gl.depthMask(true);
    for (const mesh of opaque) this._drawMesh(mesh);
    gl.enable(gl.BLEND); gl.depthMask(false);
    for (const mesh of transparent) this._drawMesh(mesh);
    // points
    if (points.length) {
      const PP = this.pprog;
      gl.useProgram(PP.p);
      gl.uniformMatrix4fv(PP.u.uProj, false, camera.proj);
      gl.uniformMatrix4fv(PP.u.uView, false, camera.view);
      gl.uniform1f(PP.u.uScaleH, (this.canvas.height * 0.5) / Math.tan(camera.fov * Math.PI / 360));
      for (const pt of points) this._drawPoints(pt);
    }
    gl.depthMask(true);
  }
  _bindAttr(loc, buf, size) {
    const gl = this.gl;
    if (loc === undefined || loc < 0 || !buf) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  }
  _drawMesh(mesh) {
    const gl = this.gl, P = this.prog, mat = mesh.material;
    const b = this._geoBuffers(mesh.geometry);
    this._bindAttr(P.a.position, b.vbo, 3);
    this._bindAttr(P.a.normal, b.nbo, 3);
    this._bindAttr(P.a.uv, b.ubo, 2);
    gl.uniform1i(P.u.uLit, mat.lit ? 1 : 0);
    gl.uniform1f(P.u.uOpacity, mat.opacity);
    if (mat.map) {
      gl.uniform1i(P.u.uUseMap, 1);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._texture(mat.map));
      gl.uniform1i(P.u.uMap, 0);
    } else gl.uniform1i(P.u.uUseMap, 0);
    if (mat.side === DoubleSide) gl.disable(gl.CULL_FACE); else gl.enable(gl.CULL_FACE);
    const drawOne = (world, color) => {
      gl.uniformMatrix4fv(P.u.uModel, false, world);
      normalFromMat4(this._normalM, world);
      gl.uniformMatrix3fv(P.u.uNormalM, false, this._normalM);
      gl.uniform3f(P.u.uColor, color[0], color[1], color[2]);
      if (b.ibo) { gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.ibo); gl.drawElements(gl.TRIANGLES, b.count, gl.UNSIGNED_SHORT, 0); }
      else gl.drawArrays(gl.TRIANGLES, 0, b.count);
    };
    const mc = [mat.color.r, mat.color.g, mat.color.b];
    if (mesh.isInstanced) {
      const tmp = this._instScratch || (this._instScratch = mat4Identity());
      for (let i = 0; i < mesh.count; i++) {
        mat4Multiply(tmp, mesh.worldMatrix, mesh._mats[i]);
        const c = mesh._cols && mesh._cols[i] ? mesh._cols[i] : mc;
        drawOne(tmp, c);
      }
    } else {
      drawOne(mesh.worldMatrix, mc);
    }
  }
  _drawPoints(pt) {
    const gl = this.gl, PP = this.pprog, g = pt.geometry, mat = pt.material;
    let b = this._geoCache.get(g);
    if (!b) { b = { vbo: gl.createBuffer(), cbo: gl.createBuffer() }; this._geoCache.set(g, b); g.attributes.position.needsUpdate = true; g.attributes.color.needsUpdate = true; }
    gl.bindBuffer(gl.ARRAY_BUFFER, b.vbo);
    if (g.attributes.position.needsUpdate) { gl.bufferData(gl.ARRAY_BUFFER, g.attributes.position.array, gl.DYNAMIC_DRAW); g.attributes.position.needsUpdate = false; }
    this._bindAttr(PP.a.position, b.vbo, 3);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.cbo);
    if (g.attributes.color.needsUpdate) { gl.bufferData(gl.ARRAY_BUFFER, g.attributes.color.array, gl.DYNAMIC_DRAW); g.attributes.color.needsUpdate = false; }
    this._bindAttr(PP.a.color, b.cbo, 3);
    gl.uniform1f(PP.u.uSize, mat.size);
    gl.uniform1f(PP.u.uOpacity, mat.opacity);
    gl.drawArrays(gl.POINTS, 0, g.attributes.position.array.length / 3);
  }
}
