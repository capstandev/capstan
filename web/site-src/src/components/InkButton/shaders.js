/**
 * Shaders for <InkButton />. GLSL ES 3.00.
 *
 * field  One signed distance for all the ink — the button, every strand as a
 *        chain of tapered capsules, the bead on the pointer, falling drops —
 *        joined with a smooth minimum, so a strand necks out of the button
 *        instead of meeting it, and two strands that pass close web
 *        together. Packed into 16 bits of an RGBA8 target.
 *
 * shade  Reads the field and its neighbours, turns depth into a domed height
 *        and so a normal, and lights it as black lacquer: almost no colour of
 *        its own, everything it shows is reflection — a long softbox
 *        overhead, a cool window to the left, warm bounce from below — by a
 *        Fresnel term. A soft contact shadow is read from the same field.
 *
 * Both passes work in GL pixel space: y up, device pixels.
 */

export const vert = /* glsl */ `#version 300 es
in vec2 aPos;
void main() {
  gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);
}
`

export const fieldFrag = /* glsl */ `#version 300 es
precision highp float;
precision highp int;

uniform vec4 uBody;        // centre xy, half width, half height
uniform vec4 uWarp;        // pull direction xy, stretch, squash
uniform vec4 uNodes[128];  // x, y, radius
uniform vec4 uSpan[16];    // first node, node count
uniform vec4 uBox[16];     // strand bounds: min xy, max xy
uniform int uStrands;
uniform vec3 uBlob;        // x, y, radius
uniform vec4 uDrops[12];   // x, y, radius, tail
uniform int uDropCount;
uniform float uMerge;      // how far apart two shapes start to bridge, px

out vec4 outField;

float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

/* A capsule whose radius runs from ra to rb. */
float sdCone(vec2 p, vec2 a, vec2 b, float ra, float rb) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float t = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
  return length(pa - ba * t) - mix(ra, rb, t);
}

void main() {
  vec2 p = gl_FragCoord.xy;

  /* The button, squashed when pressed, stretched towards what pulls it. */
  vec2 q = p - uBody.xy;
  q /= vec2(1.0 + uWarp.w * 0.05, 1.0 - uWarp.w * 0.05);
  float st = uWarp.z * 0.07;
  q -= uWarp.xy * dot(q, uWarp.xy) * (st / (1.0 + st));
  float d = length(vec2(max(abs(q.x) - (uBody.z - uBody.w), 0.0), q.y)) - uBody.w;

  float m = uMerge + 4.0;
  for (int s = 0; s < 16; s++) {
    if (s >= uStrands) break;
    vec4 box = uBox[s];
    if (p.x < box.x - m || p.y < box.y - m || p.x > box.z + m || p.y > box.w + m) continue;
    int start = int(uSpan[s].x);
    int count = int(uSpan[s].y);
    float ds = 1e5;
    for (int i = 0; i < 15; i++) {
      if (i >= count - 1) break;
      vec4 a = uNodes[start + i];
      vec4 b = uNodes[start + i + 1];
      ds = min(ds, sdCone(p, a.xy, b.xy, a.z, b.z));
    }
    d = smin(d, ds, uMerge);
  }

  if (uBlob.z > 0.3) d = smin(d, length(p - uBlob.xy) - uBlob.z, uMerge * 1.3);

  for (int i = 0; i < 12; i++) {
    if (i >= uDropCount) break;
    vec4 dr = uDrops[i];
    float dd = sdCone(p, dr.xy, dr.xy + vec2(0.0, dr.w), dr.z, dr.z * 0.55);
    d = smin(d, dd, uMerge * 0.6);
  }

  /* ±64 px in 16 bits. */
  float v = clamp(d / 128.0 + 0.5, 0.0, 1.0) * 255.0;
  float hi = floor(v);
  outField = vec4(hi / 255.0, fract(v), 0.0, 1.0);
}
`

export const shadeFrag = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D uField;
uniform vec3 uBg;
uniform vec3 uInk;         // the ink's own colour, nearly black
uniform vec3 uSky;         // tint of the reflected light
uniform float uBevel;      // how far in from the edge the surface rounds over, px
uniform float uShadow;
uniform float uDpr;

out vec4 outColor;

float field(ivec2 c) {
  ivec2 size = textureSize(uField, 0);
  vec4 t = texelFetch(uField, clamp(c, ivec2(0), size - 1), 0);
  return ((t.r * 255.0 + t.g) / 255.0 - 0.5) * 128.0;
}

float height(float d) {
  float e = clamp(-d / uBevel, 0.0, 1.0);
  return uBevel * sqrt(1.0 - (1.0 - e) * (1.0 - e));
}

/* What the lacquer reflects, by reflected direction. */
vec3 env(vec3 r) {
  vec3 c = vec3(0.012);
  /* A long softbox overhead. */
  float box = smoothstep(0.26, 0.4, r.y) * (1.0 - smoothstep(0.66, 0.8, r.y)) * (1.0 - smoothstep(0.5, 0.82, abs(r.x + 0.08)));
  c += uSky * box * 9.0;
  /* A cool window up and to the left. */
  c += vec3(0.55, 0.68, 1.0) * smoothstep(0.88, 0.975, dot(r, normalize(vec3(-0.78, 0.32, 0.53)))) * 5.0;
  /* Warm bounce from the floor, and the bright horizon at grazing angles. */
  c += vec3(1.0, 0.9, 0.8) * smoothstep(-0.25, -0.75, r.y) * 0.35;
  c += uSky * smoothstep(0.3, 0.0, r.z) * 0.5;
  return c;
}

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float d = field(c);

  /* Contact shadow: the ink's own shape, dropped and softened. */
  float sd = field(c + ivec2(0, int(5.0 * uDpr)));
  float shadow = (1.0 - smoothstep(-4.0 * uDpr, 22.0 * uDpr, sd)) * uShadow;
  vec3 bg = uBg * (1.0 - shadow);

  float cover = clamp(0.5 - d, 0.0, 1.0);
  if (cover <= 0.0) {
    outColor = vec4(bg, 1.0);
    return;
  }

  float hl = height(field(c + ivec2(-1, 0)));
  float hr = height(field(c + ivec2(1, 0)));
  float hd = height(field(c + ivec2(0, -1)));
  float hu = height(field(c + ivec2(0, 1)));
  vec3 n = normalize(vec3((hl - hr) * 0.5, (hd - hu) * 0.5, 1.0));
  vec3 r = reflect(vec3(0.0, 0.0, -1.0), n);

  float fres = 0.045 + 0.955 * pow(1.0 - n.z, 5.0);
  vec3 col = uInk + env(r) * fres;
  /* A tight glint from the key light. */
  col += uSky * pow(max(dot(r, normalize(vec3(-0.25, 0.62, 0.74))), 0.0), 260.0) * 1.6;

  outColor = vec4(mix(bg, col, cover), 1.0);
}
`
