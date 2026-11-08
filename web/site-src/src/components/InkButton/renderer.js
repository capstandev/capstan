import { createProgram, createQuad, bindQuad, createTarget, deleteTarget, hexToRgb } from '../../lib/gl'
import { fieldFrag, shadeFrag, vert } from './shaders'

export const MAX_NODES = 128
export const MAX_STRANDS = 16
export const MAX_DROPS = 12

/** The GL side of <InkButton />: the ink field, then its shading. */
export function createRenderer(canvas) {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false })
  if (!gl) return null
  let res = null
  let lost = false
  let target = null

  const nodes = new Float32Array(MAX_NODES * 4)
  const spans = new Float32Array(MAX_STRANDS * 4)
  const boxes = new Float32Array(MAX_STRANDS * 4)
  const drops = new Float32Array(MAX_DROPS * 4)

  const build = () => {
    res = {
      field: createProgram(gl, vert, fieldFrag, 'InkButton/field'),
      shade: createProgram(gl, vert, shadeFrag, 'InkButton/shade'),
      quad: createQuad(gl),
    }
    target = null
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
  build()

  return {
    /**
     * `scene` is in device pixels with y up: { body, warp, strands: [{ x, y, r, n }],
     * blob: [x, y, r], drops: [{ x, y, r, tail }], merge, bevel, shadow, dpr, colours }.
     */
    render(scene) {
      if (!res || lost) return
      const W = canvas.width
      const H = canvas.height
      if (!target || target.w !== W || target.h !== H) {
        deleteTarget(gl, target)
        target = createTarget(gl, W, H)
      }

      let nodeCount = 0
      let strandCount = 0
      for (const st of scene.strands) {
        if (strandCount >= MAX_STRANDS || nodeCount + st.n > MAX_NODES) break
        let x0 = Infinity
        let y0 = Infinity
        let x1 = -Infinity
        let y1 = -Infinity
        for (let i = 0; i < st.n; i++) {
          const o = (nodeCount + i) * 4
          nodes[o] = st.x[i]
          nodes[o + 1] = st.y[i]
          nodes[o + 2] = st.r[i]
          const r = st.r[i]
          x0 = Math.min(x0, st.x[i] - r)
          y0 = Math.min(y0, st.y[i] - r)
          x1 = Math.max(x1, st.x[i] + r)
          y1 = Math.max(y1, st.y[i] + r)
        }
        spans[strandCount * 4] = nodeCount
        spans[strandCount * 4 + 1] = st.n
        boxes.set([x0, y0, x1, y1], strandCount * 4)
        nodeCount += st.n
        strandCount++
      }
      const dropCount = Math.min(MAX_DROPS, scene.drops.length)
      for (let i = 0; i < dropCount; i++) {
        const d = scene.drops[i]
        drops.set([d.x, d.y, d.r, d.tail], i * 4)
      }

      bindQuad(gl, res.quad)
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb)
      gl.viewport(0, 0, W, H)
      let { u, p } = res.field
      gl.useProgram(p)
      gl.uniform4fv(u.uBody, scene.body)
      gl.uniform4fv(u.uWarp, scene.warp)
      gl.uniform4fv(u['uNodes[0]'], nodes)
      gl.uniform4fv(u['uSpan[0]'], spans)
      gl.uniform4fv(u['uBox[0]'], boxes)
      gl.uniform1i(u.uStrands, strandCount)
      gl.uniform3fv(u.uBlob, scene.blob)
      gl.uniform4fv(u['uDrops[0]'], drops)
      gl.uniform1i(u.uDropCount, dropCount)
      gl.uniform1f(u.uMerge, scene.merge)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, W, H)
      ;({ u, p } = res.shade)
      gl.useProgram(p)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, target.tex)
      gl.uniform1i(u.uField, 0)
      const bg = hexToRgb(scene.colours.background)
      const ink = hexToRgb(scene.colours.ink)
      const sky = hexToRgb(scene.colours.light)
      gl.uniform3f(u.uBg, bg[0], bg[1], bg[2])
      gl.uniform3f(u.uInk, ink[0], ink[1], ink[2])
      gl.uniform3f(u.uSky, sky[0], sky[1], sky[2])
      gl.uniform1f(u.uBevel, scene.bevel)
      gl.uniform1f(u.uShadow, scene.shadow)
      gl.uniform1f(u.uDpr, scene.dpr)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    },

    destroy() {
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      if (res && !lost) {
        deleteTarget(gl, target)
        gl.deleteBuffer(res.quad)
        gl.deleteProgram(res.field.p)
        gl.deleteProgram(res.shade.p)
      }
      res = null
    },
  }
}
