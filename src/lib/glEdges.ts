import type { FlowNode, FlowEdgeRaw } from './types';
import type { Scales } from './layout';

// Segments per curve. Higher than you'd think necessary is cheap here — the
// GPU cost that actually matters is edge COUNT (handled via instancing, one
// draw call regardless of how many), not vertices per instance. Going from
// 18->48 turns visibly faceted "ridges" on the curve into a smooth arc, and
// even at 100k edges that's ~48 * 100k * 2 ≈ 9.6M vertices, trivial for any
// real GPU.
const SEGMENTS = 48;
const FLOATS_PER_INSTANCE = 18; // p0Arc(2) p1Arc(2) p0Geo(2) p1Geo(2) cArc(2) cGeo(2) color(3) width(1) srcIdx(1) tgtIdx(1)

const COMMON_VERT_HEAD = `#version 300 es
layout(location = 2) in vec2 aP0Arc;
layout(location = 3) in vec2 aP1Arc;
layout(location = 4) in vec2 aP0Geo;
layout(location = 5) in vec2 aP1Geo;
layout(location = 6) in vec2 aCArc;
layout(location = 7) in vec2 aCGeo;
layout(location = 8) in vec3 aColor;
layout(location = 9) in float aWidth;
layout(location = 10) in float aSrcIdx;
layout(location = 11) in float aTgtIdx;

uniform float uBlend;      // 0 = arc layout, 1 = geo layout
uniform vec2 uResolution;  // CSS pixel size of the canvas
uniform float uScale;      // pan/zoom
uniform vec2 uTranslate;
uniform float uHoverIdx;   // -1 = nothing hovered

vec2 bezier(vec2 p0, vec2 c, vec2 p1, float t) {
  float mt = 1.0 - t;
  return mt * mt * p0 + 2.0 * mt * t * c + t * t * p1;
}
`;

const EDGE_VERT_SRC = `${COMMON_VERT_HEAD}
layout(location = 0) in float aT;
layout(location = 1) in float aSide;

out vec3 vColor;
out float vAlpha;

void main() {
  vec2 p0 = mix(aP0Arc, aP0Geo, uBlend);
  vec2 p1 = mix(aP1Arc, aP1Geo, uBlend);
  vec2 c  = mix(aCArc,  aCGeo,  uBlend);

  vec2 pos = bezier(p0, c, p1, aT);

  float hot = (aSrcIdx == uHoverIdx || aTgtIdx == uHoverIdx) ? 1.0 : 0.0;

  // Analytic bezier tangent for a stable normal (thick-line offset), no
  // finite-difference epsilon needed.
  vec2 tangent = 2.0 * (1.0 - aT) * (c - p0) + 2.0 * aT * (p1 - c);
  float tlen = length(tangent);
  vec2 normal = tlen > 0.0001 ? vec2(-tangent.y, tangent.x) / tlen : vec2(0.0, 1.0);

  vec2 screenPos = pos * uScale + uTranslate;
  // Width offset applied AFTER the view transform, in screen pixels — this
  // is what keeps line thickness visually constant while zooming. Hot edges
  // also get a width boost so the hovered route reads as clearly emphasized,
  // not just brighter.
  float widthMul = mix(1.0, 1.6, hot);
  screenPos += normal * (aWidth * 0.5 * widthMul) * aSide;

  vec2 clip = (screenPos / uResolution) * 2.0 - 1.0;
  clip.y = -clip.y;
  gl_Position = vec4(clip, 0.0, 1.0);

  float somethingHovered = step(0.0, uHoverIdx);
  float dimmed = somethingHovered * (1.0 - hot);
  // Non-hovered elements fade to nearly nothing (was 0.035) — present, but
  // barely visible — while the hovered route stays fully opaque.
  vAlpha = mix(mix(0.55, 1.0, hot), 0.018, dimmed);

  vColor = aColor;
}
`;

const EDGE_FRAG_SRC = `#version 300 es
precision mediump float;
in vec3 vColor;
in float vAlpha;
out vec4 fragColor;
void main() {
  fragColor = vec4(vColor * vAlpha, vAlpha); // premultiplied alpha
}
`;

// Particles reuse the exact same per-edge instance buffer as the edges
// themselves (same attributes, same VBO) — a per-instance hash derived from
// gl_InstanceID gives each edge a pseudo-random phase/speed with no extra
// CPU-side data at all. uTime advances the animation; that's the only thing
// that changes per frame.
const PARTICLE_VERT_SRC = `${COMMON_VERT_HEAD}
layout(location = 0) in vec2 aQuadPos;

uniform float uTime;
uniform float uPhaseOffset;

out vec3 vColor;
out float vAlpha;
out vec2 vLocal;

float hash(float n) { return fract(sin(n) * 43758.5453123); }

void main() {
  float h1 = hash(float(gl_InstanceID) * 0.0173 + 1.0);
  float h2 = hash(float(gl_InstanceID) * 0.0281 + 7.0);
  float speed = 0.05 + h2 * 0.09;
  float t = fract(uTime * speed + h1 + uPhaseOffset);

  vec2 p0 = mix(aP0Arc, aP0Geo, uBlend);
  vec2 p1 = mix(aP1Arc, aP1Geo, uBlend);
  vec2 c  = mix(aCArc,  aCGeo,  uBlend);
  vec2 pos = bezier(p0, c, p1, t);
  vec2 screenPos = pos * uScale + uTranslate;

  float fade = sin(3.14159265 * t);
  float hot = (aSrcIdx == uHoverIdx || aTgtIdx == uHoverIdx) ? 1.0 : 0.0;
  float somethingHovered = step(0.0, uHoverIdx);
  float dimmed = somethingHovered * (1.0 - hot);
  // Non-hovered particles fade to nearly nothing (was 0.035) — present, but
  // barely visible.
  float alphaMul = mix(1.0, 0.018, dimmed);

  float r = (2.4 + aWidth * 0.7) * mix(1.0, 1.5, hot);
  vec2 finalPix = screenPos + aQuadPos * r;

  vec2 clip = (finalPix / uResolution) * 2.0 - 1.0;
  clip.y = -clip.y;
  gl_Position = vec4(clip, 0.0, 1.0);

  vColor = aColor;
  vAlpha = clamp(fade, 0.0, 1.0) * alphaMul;
  vLocal = aQuadPos;
}
`;

const PARTICLE_FRAG_SRC = `#version 300 es
precision mediump float;
in vec3 vColor;
in float vAlpha;
in vec2 vLocal;
out vec4 fragColor;
void main() {
  float d = length(vLocal);
  float glow = smoothstep(1.0, 0.0, d);
  float core = smoothstep(0.35, 0.0, d);
  vec3 col = mix(vColor, vec3(1.0), core * 0.85);
  float a = vAlpha * glow;
  fragColor = vec4(col * a, a);
}
`;

// --- 3D (orbit-camera) variants for Geo mode -------------------------------
// Ground plane = geo (x, y) as (worldX, worldZ); routes arch upward into
// worldY (height) based on distance — the same "distance-based arc height"
// convention as the 2D renderer, just lifted into a third dimension instead
// of screen Y. Reuses the exact same per-edge instance buffer; only the
// vertex shaders differ (perspective projection instead of pixel math).
const COMMON_3D_HEAD = `#version 300 es
layout(location = 4) in vec2 aP0Geo;
layout(location = 5) in vec2 aP1Geo;
layout(location = 8) in vec3 aColor;
layout(location = 9) in float aWidth;
layout(location = 10) in float aSrcIdx;
layout(location = 11) in float aTgtIdx;

uniform mat4 uViewProj;
uniform vec2 uResolution;
uniform float uHoverIdx;
uniform float uHeightScale;

vec3 bezier3(vec3 p0, vec3 c, vec3 p1, float t) {
  float mt = 1.0 - t;
  return mt * mt * p0 + 2.0 * mt * t * c + t * t * p1;
}
`;

const EDGE_VERT_3D_SRC = `${COMMON_3D_HEAD}
layout(location = 0) in float aT;
layout(location = 1) in float aSide;

out vec3 vColor;
out float vAlpha;

void main() {
  vec3 p0 = vec3(aP0Geo.x, 0.0, aP0Geo.y);
  vec3 p1 = vec3(aP1Geo.x, 0.0, aP1Geo.y);
  float dist = length(aP1Geo - aP0Geo);
  vec3 mid = vec3((aP0Geo.x + aP1Geo.x) * 0.5, dist * uHeightScale, (aP0Geo.y + aP1Geo.y) * 0.5);

  vec3 worldPos = bezier3(p0, mid, p1, aT);
  vec3 tangent = normalize(2.0 * (1.0 - aT) * (mid - p0) + 2.0 * aT * (p1 - mid) + vec3(1e-6));

  vec4 clip0 = uViewProj * vec4(worldPos, 1.0);
  // Constant-pixel-width lines under perspective: project a second point
  // just along the tangent, derive the on-screen direction from both, then
  // offset in clip space scaled by w so the GPU's automatic perspective
  // divide leaves a correct constant-width screen offset regardless of
  // camera distance.
  vec4 clip1 = uViewProj * vec4(worldPos + tangent * max(dist * 0.01, 1.0), 1.0);
  vec2 screen0 = clip0.xy / clip0.w;
  vec2 screen1 = clip1.xy / clip1.w;
  vec2 dir2d = normalize(screen1 - screen0 + vec2(1e-6));
  vec2 normal2d = vec2(-dir2d.y, dir2d.x);

  vec2 offsetNdc = normal2d * (aWidth * 0.5) * aSide;
  offsetNdc.x *= 2.0 / uResolution.x;
  offsetNdc.y *= 2.0 / uResolution.y;

  gl_Position = vec4(clip0.xy + offsetNdc * clip0.w, clip0.z, clip0.w);

  float hot = (aSrcIdx == uHoverIdx || aTgtIdx == uHoverIdx) ? 1.0 : 0.0;
  float somethingHovered = step(0.0, uHoverIdx);
  float dimmed = somethingHovered * (1.0 - hot);
  vAlpha = mix(mix(0.55, 1.0, hot), 0.018, dimmed);
  vColor = aColor;
}
`;

const PARTICLE_VERT_3D_SRC = `${COMMON_3D_HEAD}
layout(location = 0) in vec2 aQuadPos;

uniform float uTime;
uniform float uPhaseOffset;

out vec3 vColor;
out float vAlpha;
out vec2 vLocal;

float hash(float n) { return fract(sin(n) * 43758.5453123); }

void main() {
  float h1 = hash(float(gl_InstanceID) * 0.0173 + 1.0);
  float h2 = hash(float(gl_InstanceID) * 0.0281 + 7.0);
  float speed = 0.05 + h2 * 0.09;
  float t = fract(uTime * speed + h1 + uPhaseOffset);

  vec3 p0 = vec3(aP0Geo.x, 0.0, aP0Geo.y);
  vec3 p1 = vec3(aP1Geo.x, 0.0, aP1Geo.y);
  float dist = length(aP1Geo - aP0Geo);
  vec3 mid = vec3((aP0Geo.x + aP1Geo.x) * 0.5, dist * uHeightScale, (aP0Geo.y + aP1Geo.y) * 0.5);
  vec3 worldPos = bezier3(p0, mid, p1, t);

  vec4 clip = uViewProj * vec4(worldPos, 1.0);

  float fade = sin(3.14159265 * t);
  float hot = (aSrcIdx == uHoverIdx || aTgtIdx == uHoverIdx) ? 1.0 : 0.0;
  float somethingHovered = step(0.0, uHoverIdx);
  float dimmed = somethingHovered * (1.0 - hot);
  float alphaMul = mix(1.0, 0.018, dimmed);

  float r = (2.4 + aWidth * 0.7) * mix(1.0, 1.5, hot);
  vec2 offsetNdc = aQuadPos * r;
  offsetNdc.x *= 2.0 / uResolution.x;
  offsetNdc.y *= 2.0 / uResolution.y;

  gl_Position = vec4(clip.xy + offsetNdc * clip.w, clip.z, clip.w);

  vColor = aColor;
  vAlpha = clamp(fade, 0.0, 1.0) * alphaMul;
  vLocal = aQuadPos;
}
`;

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('Shader compile error: ' + log);
  }
  return sh;
}

function linkProgram(gl: WebGL2RenderingContext, vertSrc: string, fragSrc: string): WebGLProgram {
  const program = gl.createProgram()!;
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertSrc));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragSrc));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error('Program link error: ' + gl.getProgramInfoLog(program));
  }
  return program;
}

function parseColorToRgb01(color: string): [number, number, number] {
  if (color[0] === '#') {
    const hex = color.length === 4
      ? color[1] + color[1] + color[2] + color[2] + color[3] + color[3] // #rgb shorthand
      : color.slice(1, 7);
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return [r / 255, g / 255, b / 255];
  }
  // d3's interpolateRgbBasis (used elsewhere) returns "rgb(r, g, b)" strings.
  const m = color.match(/rgb\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  if (!m) return [0.5, 0.5, 0.5];
  return [parseFloat(m[1]) / 255, parseFloat(m[2]) / 255, parseFloat(m[3]) / 255];
}

function bindInstanceAttribs(gl: WebGL2RenderingContext, instanceBuffer: WebGLBuffer) {
  const STRIDE = FLOATS_PER_INSTANCE * 4;
  gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
  const layout: [number, number, number][] = [
    [2, 2, 0], [3, 2, 8], [4, 2, 16], [5, 2, 24], [6, 2, 32], [7, 2, 40],
    [8, 3, 48], [9, 1, 60], [10, 1, 64], [11, 1, 68],
  ];
  layout.forEach(([loc, size, offset]) => {
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE, offset);
    gl.vertexAttribDivisor(loc, 1);
  });
}

export interface EdgeGLRenderer {
  setEdges(nodes: Map<string, FlowNode>, edges: FlowEdgeRaw[], scales: Scales): Map<string, number>;
  draw(params: {
    blend: number; scale: number; tx: number; ty: number;
    width: number; height: number; hoverIdx: number; time: number;
  }): void;
  draw3D(params: {
    viewProj: Float32Array; heightScale: number;
    width: number; height: number; hoverIdx: number; time: number;
  }): void;
  resize(cssWidth: number, cssHeight: number, dpr: number): void;
  destroy(): void;
}

export function createEdgeGLRenderer(canvas: HTMLCanvasElement): EdgeGLRenderer | null {
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: true, depth: true });
  if (!gl) return null; // caller falls back gracefully if WebGL2 isn't available

  const edgeProgram = linkProgram(gl, EDGE_VERT_SRC, EDGE_FRAG_SRC);
  const particleProgram = linkProgram(gl, PARTICLE_VERT_SRC, PARTICLE_FRAG_SRC);
  const edge3dProgram = linkProgram(gl, EDGE_VERT_3D_SRC, EDGE_FRAG_SRC);
  const particle3dProgram = linkProgram(gl, PARTICLE_VERT_3D_SRC, PARTICLE_FRAG_SRC);

  const edgeU = {
    blend: gl.getUniformLocation(edgeProgram, 'uBlend'),
    resolution: gl.getUniformLocation(edgeProgram, 'uResolution'),
    scale: gl.getUniformLocation(edgeProgram, 'uScale'),
    translate: gl.getUniformLocation(edgeProgram, 'uTranslate'),
    hoverIdx: gl.getUniformLocation(edgeProgram, 'uHoverIdx'),
  };
  const particleU = {
    blend: gl.getUniformLocation(particleProgram, 'uBlend'),
    resolution: gl.getUniformLocation(particleProgram, 'uResolution'),
    scale: gl.getUniformLocation(particleProgram, 'uScale'),
    translate: gl.getUniformLocation(particleProgram, 'uTranslate'),
    hoverIdx: gl.getUniformLocation(particleProgram, 'uHoverIdx'),
    time: gl.getUniformLocation(particleProgram, 'uTime'),
    phaseOffset: gl.getUniformLocation(particleProgram, 'uPhaseOffset'),
  };
  const edge3dU = {
    viewProj: gl.getUniformLocation(edge3dProgram, 'uViewProj'),
    resolution: gl.getUniformLocation(edge3dProgram, 'uResolution'),
    hoverIdx: gl.getUniformLocation(edge3dProgram, 'uHoverIdx'),
    heightScale: gl.getUniformLocation(edge3dProgram, 'uHeightScale'),
  };
  const particle3dU = {
    viewProj: gl.getUniformLocation(particle3dProgram, 'uViewProj'),
    resolution: gl.getUniformLocation(particle3dProgram, 'uResolution'),
    hoverIdx: gl.getUniformLocation(particle3dProgram, 'uHoverIdx'),
    heightScale: gl.getUniformLocation(particle3dProgram, 'uHeightScale'),
    time: gl.getUniformLocation(particle3dProgram, 'uTime'),
    phaseOffset: gl.getUniformLocation(particle3dProgram, 'uPhaseOffset'),
  };

  // Shared "ribbon" template for edges: (SEGMENTS+1) steps along t, 2
  // vertices per step, drawn as a TRIANGLE_STRIP.
  const ribbonVerts: number[] = [];
  for (let i = 0; i <= SEGMENTS; i++) {
    const t = i / SEGMENTS;
    ribbonVerts.push(t, -1, t, 1);
  }
  const ribbonBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, ribbonBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(ribbonVerts), gl.STATIC_DRAW);
  const vertsPerInstance = (SEGMENTS + 1) * 2;

  // Small quad template for particles.
  const quadBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

  const instanceBuffer = gl.createBuffer()!;
  let instanceCount = 0;

  const edgeVao = gl.createVertexArray();
  gl.bindVertexArray(edgeVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, ribbonBuffer);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 1, gl.FLOAT, false, 8, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 8, 4);
  bindInstanceAttribs(gl, instanceBuffer);
  gl.bindVertexArray(null);

  const particleVao = gl.createVertexArray();
  gl.bindVertexArray(particleVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  bindInstanceAttribs(gl, instanceBuffer);
  gl.bindVertexArray(null);

  // 3D VAOs reuse the exact same ribbon/quad base geometry and the exact
  // same instance buffer — only the shader programs differ.
  const edge3dVao = gl.createVertexArray();
  gl.bindVertexArray(edge3dVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, ribbonBuffer);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 1, gl.FLOAT, false, 8, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 8, 4);
  bindInstanceAttribs(gl, instanceBuffer);
  gl.bindVertexArray(null);

  const particle3dVao = gl.createVertexArray();
  gl.bindVertexArray(particle3dVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  bindInstanceAttribs(gl, instanceBuffer);
  gl.bindVertexArray(null);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied

  return {
    setEdges(nodes, edges, scales) {
      const idxMap = new Map<string, number>();
      let nextIdx = 0;
      const idOf = (id: string) => {
        let i = idxMap.get(id);
        if (i === undefined) {
          i = nextIdx++;
          idxMap.set(id, i);
        }
        return i;
      };

      const data = new Float32Array(edges.length * FLOATS_PER_INSTANCE);
      let count = 0;
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        const s = nodes.get(e.sourceId);
        const t = nodes.get(e.targetId);
        if (!s || !t) continue;
        const o = count * FLOATS_PER_INSTANCE;

        const p0a = s.arc, p1a = t.arc, p0g = s.geo, p1g = t.geo;
        const midAx = (p0a.x + p1a.x) / 2, midAy = (p0a.y + p1a.y) / 2;
        const distA = Math.max(Math.hypot(p1a.x - p0a.x, p1a.y - p0a.y), 1);
        const cArcX = midAx, cArcY = midAy - distA * 0.55;

        const midGx = (p0g.x + p1g.x) / 2, midGy = (p0g.y + p1g.y) / 2;
        const dgx = p1g.x - p0g.x, dgy = p1g.y - p0g.y;
        const distG = Math.max(Math.hypot(dgx, dgy), 1);
        const nx = -dgy / distG, ny = dgx / distG;
        const cGeoX = midGx + nx * distG * 0.16, cGeoY = midGy + ny * distG * 0.16;

        const [r, g, b] = parseColorToRgb01(scales.colorScale(e.value));
        const width = scales.widthScale(e.value);

        data[o + 0] = p0a.x; data[o + 1] = p0a.y;
        data[o + 2] = p1a.x; data[o + 3] = p1a.y;
        data[o + 4] = p0g.x; data[o + 5] = p0g.y;
        data[o + 6] = p1g.x; data[o + 7] = p1g.y;
        data[o + 8] = cArcX; data[o + 9] = cArcY;
        data[o + 10] = cGeoX; data[o + 11] = cGeoY;
        data[o + 12] = r; data[o + 13] = g; data[o + 14] = b;
        data[o + 15] = width;
        data[o + 16] = idOf(e.sourceId);
        data[o + 17] = idOf(e.targetId);
        count++;
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, count === edges.length ? data : data.subarray(0, count * FLOATS_PER_INSTANCE), gl.DYNAMIC_DRAW);
      instanceCount = count;
      return idxMap;
    },

    draw({ blend, scale, tx, ty, width, height, hoverIdx, time }) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.disable(gl.DEPTH_TEST);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (instanceCount === 0) return;

      // Pass 1: edges (one draw call, all instances).
      gl.useProgram(edgeProgram);
      gl.bindVertexArray(edgeVao);
      gl.uniform1f(edgeU.blend, blend);
      gl.uniform2f(edgeU.resolution, width, height);
      gl.uniform1f(edgeU.scale, scale);
      gl.uniform2f(edgeU.translate, tx, ty);
      gl.uniform1f(edgeU.hoverIdx, hoverIdx);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, vertsPerInstance, instanceCount);
      gl.bindVertexArray(null);

      // Pass 2: particles — every edge gets flowing dots, two passes with a
      // phase offset for a denser flow, still just two cheap draw calls
      // regardless of edge count.
      gl.useProgram(particleProgram);
      gl.bindVertexArray(particleVao);
      gl.uniform1f(particleU.blend, blend);
      gl.uniform2f(particleU.resolution, width, height);
      gl.uniform1f(particleU.scale, scale);
      gl.uniform2f(particleU.translate, tx, ty);
      gl.uniform1f(particleU.hoverIdx, hoverIdx);
      gl.uniform1f(particleU.time, time);
      gl.uniform1f(particleU.phaseOffset, 0.0);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, instanceCount);
      gl.uniform1f(particleU.phaseOffset, 0.5);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, instanceCount);
      gl.bindVertexArray(null);
    },

    draw3D({ viewProj, heightScale, width, height, hoverIdx, time }) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (instanceCount === 0) {
        gl.disable(gl.DEPTH_TEST);
        return;
      }

      // Edges write depth — nearer arcs correctly occlude farther ones,
      // which is what actually makes a "skyline of flow" read as a real 3D
      // scene instead of a flat pile of translucent lines.
      gl.depthMask(true);
      gl.useProgram(edge3dProgram);
      gl.bindVertexArray(edge3dVao);
      gl.uniformMatrix4fv(edge3dU.viewProj, false, viewProj);
      gl.uniform2f(edge3dU.resolution, width, height);
      gl.uniform1f(edge3dU.hoverIdx, hoverIdx);
      gl.uniform1f(edge3dU.heightScale, heightScale);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, vertsPerInstance, instanceCount);
      gl.bindVertexArray(null);

      // Particles test against that depth (so they still hide behind
      // nearer arcs) but don't write it themselves, so overlapping glows
      // blend together instead of harshly occluding each other.
      gl.depthMask(false);
      gl.useProgram(particle3dProgram);
      gl.bindVertexArray(particle3dVao);
      gl.uniformMatrix4fv(particle3dU.viewProj, false, viewProj);
      gl.uniform2f(particle3dU.resolution, width, height);
      gl.uniform1f(particle3dU.hoverIdx, hoverIdx);
      gl.uniform1f(particle3dU.heightScale, heightScale);
      gl.uniform1f(particle3dU.time, time);
      gl.uniform1f(particle3dU.phaseOffset, 0.0);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, instanceCount);
      gl.uniform1f(particle3dU.phaseOffset, 0.5);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, instanceCount);
      gl.bindVertexArray(null);

      gl.depthMask(true);
      gl.disable(gl.DEPTH_TEST);
    },

    resize(cssWidth, cssHeight, dpr) {
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(cssHeight * dpr);
      canvas.style.width = cssWidth + 'px';
      canvas.style.height = cssHeight + 'px';
    },

    destroy() {
      gl.deleteBuffer(ribbonBuffer);
      gl.deleteBuffer(quadBuffer);
      gl.deleteBuffer(instanceBuffer);
      gl.deleteVertexArray(edgeVao);
      gl.deleteVertexArray(particleVao);
      gl.deleteVertexArray(edge3dVao);
      gl.deleteVertexArray(particle3dVao);
      gl.deleteProgram(edgeProgram);
      gl.deleteProgram(particleProgram);
      gl.deleteProgram(edge3dProgram);
      gl.deleteProgram(particle3dProgram);
    },
  };
}