import { createProgram, createQuad, bindQuad, createTarget, deleteTarget, hexToRgb, mat4, uploadImage } from '../../lib/gl'

/**
 * The GL side of <TearTicket />. GLSL ES 1.00.
 *
 * World units are CSS pixels with y down the page and z out of it; the
 * camera sits so the page plane maps 1:1 onto the canvas, with enough
 * perspective that a lifted corner looks lifted.
 *
 * Each frame: shadows of both pieces are drawn into a half-size target —
 * the stub's shadow slides away and softens as it rises — blurred, laid on
 * the background; then the paper itself, lit.
 */

const paperVert = /* glsl */ `
precision highp float;
attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec2 aUv;
uniform mat4 uViewProj;
varying vec2 vUv;
varying vec3 vNormal;
varying float vLift;
void main() {
  vUv = aUv;
  /* World y runs down the page; the camera's runs up. */
  vNormal = vec3(aNormal.x, -aNormal.y, aNormal.z);
  vLift = aPos.z;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}
`

const paperFrag = /* glsl */ `
precision highp float;
uniform sampler2D uTex;
uniform vec3 uBack;      // the unprinted back of the paper
uniform float uAlpha;
varying vec2 vUv;
varying vec3 vNormal;
varying float vLift;
void main() {
  vec4 t = texture2D(uTex, vUv);
  if (t.a < 0.5) discard;
  vec3 n = normalize(vNormal);
  vec3 base = t.rgb;
  if (!gl_FrontFacing) {
    n = -n;
    /* The back: plain paper with the print just showing through. */
    base = mix(uBack, t.rgb, 0.08);
  }
  vec3 L = normalize(vec3(-0.45, 0.55, 0.7));
  /* Flat paper is lit at exactly 1, so the print keeps its colours. */
  float lit = 1.0 + 0.32 * (dot(n, L) - L.z);
  float sheen = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 18.0) * 0.06;
  /* Paper lifted towards the light catches a little more of it. */
  lit += clamp(vLift / 400.0, 0.0, 0.06);
  gl_FragColor = vec4((base * lit + sheen) * uAlpha, uAlpha);
}
`

const shadowVert = /* glsl */ `
precision highp float;
attribute vec3 aPos;
attribute vec2 aUv;
uniform mat4 uViewProj;
uniform vec2 uCast;      // how far a shadow slides per px of height
varying vec2 vUv;
varying float vFade;
void main() {
  vUv = aUv;
  float z = max(aPos.z, 0.0);
  vFade = 1.0 / (1.0 + z / 140.0);
  gl_Position = uViewProj * vec4(aPos.xy + uCast * z + vec2(0.0, 3.0), 0.0, 1.0);
}
`

const shadowFrag = /* glsl */ `
precision mediump float;
uniform sampler2D uTex;
uniform float uAlpha;
varying vec2 vUv;
varying float vFade;
void main() {
  float a = step(0.5, texture2D(uTex, vUv).a) * vFade * uAlpha;
  gl_FragColor = vec4(0.0, 0.0, 0.0, a);
}
`

const quadVert = /* glsl */ `
precision highp float;
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos;
  gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);
}
`

/* Nine-tap Gaussian, one axis per pass. */
const blurFrag = /* glsl */ `
precision mediump float;
uniform sampler2D uSrc;
uniform vec2 uStep;
varying vec2 vUv;
void main() {
  float w[5];
  w[0] = 0.227; w[1] = 0.1945; w[2] = 0.1216; w[3] = 0.054; w[4] = 0.0162;
  float a = texture2D(uSrc, vUv).a * w[0];
  for (int i = 1; i < 5; i++) {
    a += texture2D(uSrc, vUv + uStep * float(i)).a * w[i];
    a += texture2D(uSrc, vUv - uStep * float(i)).a * w[i];
  }
  gl_FragColor = vec4(0.0, 0.0, 0.0, a);
}
`

const compositeFrag = /* glsl */ `
precision mediump float;
uniform sampler2D uSrc;
uniform vec3 uTint;
uniform float uStrength;
varying vec2 vUv;
void main() {
  float a = texture2D(uSrc, vUv).a * uStrength;
  gl_FragColor = vec4(uTint * a, a);
}
`

export const CAMERA_D = 1500

function viewProj(W, H) {
  const fov = 2 * Math.atan(H / 2 / CAMERA_D)
  return mat4.chain(mat4.perspective(fov, W / H, 50, 5000), mat4.translation(-W / 2, H / 2, -CAMERA_D), mat4.scaling(1, -1, 1))
}

export function createRenderer(canvas) {
  const attrs = { alpha: true, premultipliedAlpha: true, antialias: true, depth: true }
  const gl = canvas.getContext('webgl2', attrs) || canvas.getContext('webgl', attrs)
  if (!gl) return null
  let res = null
  let lost = false
  let faces = null
  let mesh = null
  let targets = null

  const build = () => {
    const paper = createProgram(gl, paperVert, paperFrag, 'TearTicket/paper')
    const shadow = createProgram(gl, shadowVert, shadowFrag, 'TearTicket/shadow')
    res = {
      paper,
      shadow,
      blur: createProgram(gl, quadVert, blurFrag, 'TearTicket/blur'),
      composite: createProgram(gl, quadVert, compositeFrag, 'TearTicket/composite'),
      quad: createQuad(gl),
      attr: {
        pNormal: gl.getAttribLocation(paper.p, 'aNormal'),
        pUv: gl.getAttribLocation(paper.p, 'aUv'),
        sUv: gl.getAttribLocation(shadow.p, 'aUv'),
      },
      bufs: {},
    }
    targets = null
    if (faces) api.setFaces(faces.src)
    if (mesh) api.setMesh(mesh.src)
  }
  const onLost = (e) => {
    e.preventDefault()
    lost = true
    res = null
  }
  const onRestored = () => {
    lost = false
    build()
  }
  canvas.addEventListener('webglcontextlost', onLost)
  canvas.addEventListener('webglcontextrestored', onRestored)

  const buffer = (data, usage, kind = gl.ARRAY_BUFFER) => {
    const b = gl.createBuffer()
    gl.bindBuffer(kind, b)
    gl.bufferData(kind, data, usage)
    return b
  }

  const attrib = (loc, buf, size) => {
    if (loc < 0) return
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0)
  }

  const api = {
    /** `src`: { main, stub } canvases. */
    setFaces(src) {
      faces = { src }
      if (!res || lost) return
      faces.main = uploadImage(gl, src.main)
      faces.stub = uploadImage(gl, src.stub)
    },

    /**
     * `src`: { main: { pos, normal, uv, index } static, stub: paper } —
     * the stub's positions and normals are re-sent every frame.
     */
    setMesh(src) {
      mesh = { src }
      if (!res || lost) return
      const m = src.main
      mesh.main = {
        pos: buffer(m.pos, gl.STATIC_DRAW),
        normal: buffer(m.normal, gl.STATIC_DRAW),
        uv: buffer(m.uv, gl.STATIC_DRAW),
        index: buffer(m.index, gl.STATIC_DRAW, gl.ELEMENT_ARRAY_BUFFER),
        count: m.index.length,
      }
      const s = src.stub
      mesh.stub = {
        pos: buffer(s.pos, gl.DYNAMIC_DRAW),
        normal: buffer(s.normals, gl.DYNAMIC_DRAW),
        uv: buffer(s.uv, gl.STATIC_DRAW),
        index: buffer(s.index, gl.STATIC_DRAW, gl.ELEMENT_ARRAY_BUFFER),
        count: s.index.length,
      }
    },

    /** `scene`: { cssW, cssH, stubAlpha, cast, shadow, colours }. */
    render(scene) {
      if (!res || lost || !faces?.main || !mesh?.main) return
      const W = canvas.width
      const H = canvas.height
      const vp = viewProj(scene.cssW, scene.cssH)
      const s = mesh.src.stub
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.stub.pos)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, s.pos)
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.stub.normal)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, s.normals)

      const sw = Math.max(1, Math.round(W / 2))
      const sh = Math.max(1, Math.round(H / 2))
      if (!targets || targets.a.w !== sw || targets.a.h !== sh) {
        if (targets) {
          deleteTarget(gl, targets.a)
          deleteTarget(gl, targets.b)
        }
        targets = { a: createTarget(gl, sw, sh), b: createTarget(gl, sw, sh) }
      }

      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      gl.disable(gl.CULL_FACE)

      /* --- shadows ---------------------------------------------------- */
      gl.bindFramebuffer(gl.FRAMEBUFFER, targets.a.fb)
      gl.viewport(0, 0, sw, sh)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.disable(gl.DEPTH_TEST)
      let { u, p } = res.shadow
      gl.useProgram(p)
      gl.uniformMatrix4fv(u.uViewProj, false, vp)
      gl.uniform2f(u.uCast, scene.cast[0], scene.cast[1])
      gl.uniform1i(u.uTex, 0)
      gl.activeTexture(gl.TEXTURE0)
      for (const [part, tex, alpha] of [
        [mesh.main, faces.main, 1],
        [mesh.stub, faces.stub, scene.stubAlpha],
      ]) {
        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.uniform1f(u.uAlpha, alpha)
        attrib(0, part.pos, 3)
        attrib(res.attr.sUv, part.uv, 2)
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, part.index)
        gl.drawElements(gl.TRIANGLES, part.count, gl.UNSIGNED_SHORT, 0)
      }
      if (res.attr.sUv >= 0) gl.disableVertexAttribArray(res.attr.sUv)

      /* Blur: a → b horizontally, b → a vertically, twice for softness. */
      bindQuad(gl, res.quad)
      ;({ u, p } = res.blur)
      gl.useProgram(p)
      gl.uniform1i(u.uSrc, 0)
      for (let pass = 0; pass < 2; pass++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, targets.b.fb)
        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.bindTexture(gl.TEXTURE_2D, targets.a.tex)
        gl.uniform2f(u.uStep, 2.2 / sw, 0)
        gl.blendFunc(gl.ONE, gl.ZERO)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
        gl.bindFramebuffer(gl.FRAMEBUFFER, targets.a.fb)
        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.bindTexture(gl.TEXTURE_2D, targets.b.tex)
        gl.uniform2f(u.uStep, 0, 2.2 / sh)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      }
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

      /* --- onto the canvas --------------------------------------------- */
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, W, H)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      ;({ u, p } = res.composite)
      gl.useProgram(p)
      gl.bindTexture(gl.TEXTURE_2D, targets.a.tex)
      gl.uniform1i(u.uSrc, 0)
      const tint = hexToRgb(scene.colours.shadow)
      gl.uniform3f(u.uTint, tint[0], tint[1], tint[2])
      gl.uniform1f(u.uStrength, scene.shadow)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

      gl.enable(gl.DEPTH_TEST)
      gl.depthFunc(gl.LEQUAL)
      ;({ u, p } = res.paper)
      gl.useProgram(p)
      gl.uniformMatrix4fv(u.uViewProj, false, vp)
      const back = hexToRgb(scene.colours.back)
      gl.uniform3f(u.uBack, back[0], back[1], back[2])
      gl.uniform1i(u.uTex, 0)
      for (const [part, tex, alpha] of [
        [mesh.main, faces.main, 1],
        [mesh.stub, faces.stub, scene.stubAlpha],
      ]) {
        if (alpha <= 0.01) continue
        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.uniform1f(u.uAlpha, alpha)
        attrib(0, part.pos, 3)
        attrib(res.attr.pNormal, part.normal, 3)
        attrib(res.attr.pUv, part.uv, 2)
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, part.index)
        gl.drawElements(gl.TRIANGLES, part.count, gl.UNSIGNED_SHORT, 0)
      }
      if (res.attr.pNormal >= 0) gl.disableVertexAttribArray(res.attr.pNormal)
      if (res.attr.pUv >= 0) gl.disableVertexAttribArray(res.attr.pUv)
    },

    destroy() {
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      if (res && !lost) {
        if (faces?.main) gl.deleteTexture(faces.main)
        if (faces?.stub) gl.deleteTexture(faces.stub)
        for (const part of [mesh?.main, mesh?.stub]) {
          if (!part) continue
          for (const k of ['pos', 'normal', 'uv', 'index']) gl.deleteBuffer(part[k])
        }
        if (targets) {
          deleteTarget(gl, targets.a)
          deleteTarget(gl, targets.b)
        }
        gl.deleteBuffer(res.quad)
        for (const k of ['paper', 'shadow', 'blur', 'composite']) gl.deleteProgram(res[k].p)
      }
      res = null
    },
  }

  build()
  return api
}
