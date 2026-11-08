/**
 * Small WebGL helpers shared by the canvas components.
 *
 * Everything here is context-agnostic — pass the `gl` in — and works on both
 * WebGL 1 and 2, since the shaders are written in GLSL ES 1.00.
 */

function compile(gl, type, src, tag) {
  const sh = gl.createShader(type)
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh)
    gl.deleteShader(sh)
    throw new Error(`[${tag}] shader: ${log}`)
  }
  return sh
}

/**
 * Links a program with its one attribute pinned to location 0 (`aPos`), and
 * returns it with every active uniform's location, keyed by name.
 */
export function createProgram(gl, vs, fs, tag = 'gl') {
  const p = gl.createProgram()
  const v = compile(gl, gl.VERTEX_SHADER, vs, tag)
  const f = compile(gl, gl.FRAGMENT_SHADER, fs, tag)
  gl.attachShader(p, v)
  gl.attachShader(p, f)
  gl.bindAttribLocation(p, 0, 'aPos')
  gl.linkProgram(p)
  gl.deleteShader(v)
  gl.deleteShader(f)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`[${tag}] link: ${gl.getProgramInfoLog(p)}`)
  }
  const u = {}
  const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS)
  for (let i = 0; i < count; i++) {
    const name = gl.getActiveUniform(p, i).name
    u[name] = gl.getUniformLocation(p, name)
  }
  return { p, u }
}

/** A unit quad, (0,0)–(1,1), as a triangle strip on attribute 0. */
export function createQuad(gl) {
  const vbo = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)
  return vbo
}

export function bindQuad(gl, vbo) {
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
}

/**
 * Uploads an image as a texture, unflipped (row 0 is the image's top edge).
 *
 * Images are usually drawn well below their native size, and without mipmaps
 * they shimmer as they move. WebGL 1 cannot mipmap a non-power-of-two
 * texture, so there it gets plain linear filtering.
 */
export function uploadImage(gl, img) {
  const webgl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  if (webgl2) {
    gl.generateMipmap(gl.TEXTURE_2D)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
  } else {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  }
  return tex
}

/** An RGBA8 colour target the size of the canvas, for a two-pass effect. */
export function createTarget(gl, w, h) {
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  const fb = gl.createFramebuffer()
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  return { fb, tex, w, h }
}

export function deleteTarget(gl, t) {
  if (!t) return
  gl.deleteFramebuffer(t.fb)
  gl.deleteTexture(t.tex)
}

/** '#rrggbb' or '#rgb' → [r, g, b] in 0–1. */
export function hexToRgb(hex) {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const v = parseInt(full, 16)
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
}

/* --- 4×4 matrices, column-major, as WebGL expects ------------------------ */

export const mat4 = {
  identity() {
    const m = new Float32Array(16)
    m[0] = m[5] = m[10] = m[15] = 1
    return m
  },

  /** a · b */
  multiply(a, b) {
    const o = new Float32Array(16)
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        o[c * 4 + r] =
          a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]
      }
    }
    return o
  },

  translation(x, y, z) {
    const m = mat4.identity()
    m[12] = x
    m[13] = y
    m[14] = z
    return m
  },

  scaling(x, y = x, z = 1) {
    const m = mat4.identity()
    m[0] = x
    m[5] = y
    m[10] = z
    return m
  },

  rotationX(a) {
    const m = mat4.identity()
    const c = Math.cos(a)
    const s = Math.sin(a)
    m[5] = c
    m[6] = s
    m[9] = -s
    m[10] = c
    return m
  },

  rotationY(a) {
    const m = mat4.identity()
    const c = Math.cos(a)
    const s = Math.sin(a)
    m[0] = c
    m[2] = -s
    m[8] = s
    m[10] = c
    return m
  },

  rotationZ(a) {
    const m = mat4.identity()
    const c = Math.cos(a)
    const s = Math.sin(a)
    m[0] = c
    m[1] = s
    m[4] = -s
    m[5] = c
    return m
  },

  /** Multiplies left to right: chain(A, B, C) = A · B · C. */
  chain(...ms) {
    return ms.reduce((acc, m) => mat4.multiply(acc, m))
  },

  perspective(fovY, aspect, near, far) {
    const f = 1 / Math.tan(fovY / 2)
    const m = new Float32Array(16)
    m[0] = f / aspect
    m[5] = f
    m[10] = (far + near) / (near - far)
    m[11] = -1
    m[14] = (2 * far * near) / (near - far)
    return m
  },
}
