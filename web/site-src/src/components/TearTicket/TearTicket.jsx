import { useEffect, useRef, useState } from 'react'
import { drawFaces } from './faces'
import { createPaper } from './paper'
import presets from './presets'
import { createRenderer } from './renderer'
import './TearTicket.css'

export const defaultTicket = {
  operator: 'Nocturne Rail · Sleeper',
  serial: 'Nº 004821',
  from: 'Lisboa',
  to: 'Paris',
  depart: 'Santa Apolónia · 22:40',
  arrive: 'Austerlitz · 09:15',
  fields: [
    ['Coach', '07'],
    ['Berth', '42'],
    ['Class', 'I'],
    ['Date', '14 Nov'],
  ],
  stubBanner: 'Admit one',
  stubLabel: 'Berth',
  stubValue: '42',
  stubNote: 'Coach 07 · Lower',
}

const SIZE = { mainW: 404, stubW: 136, h: 212, radius: 14, hole: 2.6, pitch: 9 }
const NX = 12
const NY = 18

/**
 * A ticket whose stub tears off like paper, because it is paper: a sheet of
 * particles that bends, held to the ticket by its perforation.
 *
 * Grab the stub anywhere and pull. The holes give one at a time as the paper
 * beside them is dragged away, so the tear runs along the line as far as you
 * pull it, and stops when you stop. Let go half way and the stub stays half
 * torn. Pull it free and it drops away, fluttering, and a new one is printed.
 */
export default function TearTicket({
  ticket = defaultTicket,
  /* How far, px, the paper beside a hole must be dragged before it gives. */
  toughness = 12,
  /* Seconds before a torn-off stub is replaced; 0 never. */
  restoreAfter = 1.2,
  preset = 'cream',
  theme,
  onTear,
  className = '',
  style,
  ...rest
}) {
  const colours = { ...(presets[preset] || presets.cream), ...theme }
  const [noGL, setNoGL] = useState(false)
  const [fallback, setFallback] = useState(null)
  const rootRef = useRef(null)
  const canvasRef = useRef(null)
  const stubBtnRef = useRef(null)
  const props = useRef(null)
  props.current = { ticket, toughness, restoreAfter, colours, onTear }

  useEffect(() => {
    const root = rootRef.current
    const canvas = canvasRef.current
    if (!root || !canvas) return undefined
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)')
    let renderer = null
    try {
      renderer = reduce.matches ? null : createRenderer(canvas)
    } catch (err) {
      if (typeof console !== 'undefined') console.warn(err)
    }

    let disposed = false
    let wake = () => {}
    let W = 0
    let H = 0
    let dpr = 1
    let origin = [0, 0]
    let paper = null
    let facesSig = ''

    const drawPrint = () => {
      const p = props.current
      const src = drawFaces(p.ticket, p.colours, SIZE, Math.max(2, dpr) * 1.25)
      facesSig = JSON.stringify([p.ticket, p.colours])
      if (renderer) renderer.setFaces(src)
      else setFallback({ main: src.main.toDataURL(), stub: src.stub.toDataURL() })
    }

    const layout = () => {
      const r = root.getBoundingClientRect()
      W = root.offsetWidth || r.width
      H = root.offsetHeight || r.height
      dpr = Math.min(2, window.devicePixelRatio || 1)
      canvas.width = Math.max(1, Math.round(W * dpr))
      canvas.height = Math.max(1, Math.round(H * dpr))
      const x0 = Math.round((W - SIZE.mainW - SIZE.stubW) / 2)
      const y0 = Math.round((H - SIZE.h) / 2)
      if (paper && x0 === origin[0] && y0 === origin[1]) return
      origin = [x0, y0]
      paper = createPaper({ x0: x0 + SIZE.mainW, y0, w: SIZE.stubW, h: SIZE.h, nx: NX, ny: NY })
      const mx = x0
      const main = {
        pos: new Float32Array([mx, y0, 0, mx + SIZE.mainW, y0, 0, mx, y0 + SIZE.h, 0, mx + SIZE.mainW, y0 + SIZE.h, 0]),
        normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uv: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
        index: new Uint16Array([0, 2, 1, 1, 2, 3]),
      }
      paper.computeNormals()
      renderer?.setMesh({ main, stub: paper })
      /* Keyboard users get a real button over the stub. */
      const b = stubBtnRef.current
      if (b) {
        b.style.left = `${x0 + SIZE.mainW}px`
        b.style.top = `${y0}px`
        b.style.width = `${SIZE.stubW}px`
        b.style.height = `${SIZE.h}px`
      }
    }
    layout()
    drawPrint()
    const onResize = () => { layout(); wake() }
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null
    if (ro) ro.observe(root); else window.addEventListener('resize', onResize)
    document.fonts?.ready?.then(() => { if (!disposed) { drawPrint(); wake() } })

    if (!renderer) {
      setNoGL(true)
      return () => { disposed = true; if (ro) ro.disconnect(); else window.removeEventListener('resize', onResize) }
    }

    /* --- input ------------------------------------------------------------ */
    const local = (e) => {
      const r = root.getBoundingClientRect()
      return [(e.clientX - r.left) * W / r.width, (e.clientY - r.top) * H / r.height]
    }
    let held = null
    let auto = null
    const lift = 16
    const onDown = (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return
      const [x, y] = local(e)
      if (!paper.contains(x, y)) return
      const k = paper.pick(x, y, 60)
      if (k < 0) return
      held = { id: e.pointerId }
      root.setPointerCapture?.(e.pointerId)
      paper.grab(k, x, y, lift)
      root.classList.add('is-holding')
      wake()
    }
    const onMove = (e) => {
      const [x, y] = local(e)
      if (held && e.pointerId === held.id) { paper.grab(paper.state.grabbed, x, y, lift); wake() }
      root.classList.toggle('is-over', !held && paper.contains(x, y))
    }
    const onUp = (e) => {
      if (!held || e.pointerId !== held.id) return
      held = null
      paper.release()
      root.classList.remove('is-holding')
      wake()
    }
    root.addEventListener('pointerdown', onDown)
    root.addEventListener('pointermove', onMove)
    root.addEventListener('pointerup', onUp)
    root.addEventListener('pointercancel', onUp)

    /* Enter or Space on the stub: tear it off with a scripted pull. */
    const onKey = (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      if (paper.state.free || auto) return
      const k = NX - 1
      auto = { t: 0, k, x: paper.pos[k * 3], y: paper.pos[k * 3 + 1] }
      wake()
    }
    const btn = stubBtnRef.current
    btn?.addEventListener('keydown', onKey)

    /* --- frame ------------------------------------------------------------- */
    let raf = 0
    let last = performance.now()
    let visible = !document.hidden
    let inView = true
    let lastActivity = performance.now()
    let stubAlpha = 1
    let freeAt = 0
    let restoring = 0
    let told = false
    const frame = (now) => {
      raf = 0
      if (!visible || !W) return
      const dt = Math.min(1 / 30, (now - last) / 1000)
      last = now
      const p = props.current
      if (JSON.stringify([p.ticket, p.colours]) !== facesSig) drawPrint()

      if (auto) {
        auto.t += dt
        const t = Math.min(1, auto.t / 0.9)
        paper.grab(auto.k, auto.x + t * 240, auto.y + t * t * 120, lift)
        if (t >= 1) {
          paper.release()
          auto = null
        }
      }

      const opt = {
        gravity: 2400,
        drag: paper.state.free ? 0.01 : 0.06,
        flutter: 0.45,
        tearGap: p.toughness,
        tearDelay: 0.028,
        iterations: 18,
      }
      const steps = 4
      for (let i = 0; i < steps; i++) paper.step(dt / steps, opt)
      paper.computeNormals()

      if (paper.state.free) {
        if (!told) {
          told = true
          p.onTear?.()
          root.classList.remove('is-over')
        }
        if (!freeAt) freeAt = now
        /* Gone off the bottom, or it has been a while: print another. */
        const gone = paper.bottom() > H + 80 || now - freeAt > 4500
        if (gone && p.restoreAfter > 0 && !held) {
          if (!restoring) restoring = now + p.restoreAfter * 1000
          if (now >= restoring) {
            paper.reset()
            stubAlpha = 0
            freeAt = 0
            restoring = 0
            told = false
          }
        }
      }
      stubAlpha = Math.min(1, stubAlpha + dt / (reduce.matches ? 0.01 : 0.45))

      renderer.render({
        cssW: W,
        cssH: H,
        stubAlpha,
        cast: [0.22, 0.42],
        shadow: 0.42,
        colours: p.colours,
      })
      if (visible && (held || auto || paper.state.free || now - lastActivity < 2500)) raf = requestAnimationFrame(frame)
    }
    wake = () => { lastActivity = performance.now(); if (visible && !raf) { last = lastActivity; raf = requestAnimationFrame(frame) } }
    raf = requestAnimationFrame(frame)

    const updateVisibility = () => {
      visible = inView && !document.hidden
      last = performance.now()
      if (visible && !raf) wake()
      if (!visible && raf) { cancelAnimationFrame(raf); raf = 0 }
    }
    const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; updateVisibility() }) : null
    if (io) io.observe(root); else updateVisibility()
    document.addEventListener('visibilitychange', updateVisibility)

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      io?.disconnect()
      document.removeEventListener('visibilitychange', updateVisibility)
      if (ro) ro.disconnect(); else window.removeEventListener('resize', onResize)
      root.removeEventListener('pointerdown', onDown)
      root.removeEventListener('pointermove', onMove)
      root.removeEventListener('pointerup', onUp)
      root.removeEventListener('pointercancel', onUp)
      btn?.removeEventListener('keydown', onKey)
      renderer.destroy()
      renderer = null
    }
    /* Mount-only. Live values are read through props.current. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const vars = { '--tt-bg': colours.background, '--tt-focus': colours.accent, ...style }
  const t = ticket

  return (
    <div ref={rootRef} className={`tt ${className}`.trim()} style={vars} {...rest}>
      {noGL ? (
        fallback && (
          <div className="tt__fallback">
            <img src={fallback.main} alt="" />
            <img src={fallback.stub} alt="" />
          </div>
        )
      ) : (
        <canvas ref={canvasRef} className="tt__canvas" aria-hidden="true" />
      )}
      <button ref={stubBtnRef} hidden={noGL} type="button" className="tt__stub-btn" aria-label={`Tear off the ${t.stubLabel.toLowerCase()} stub`} />
      <div className="tt__sr">
        {t.operator}. {t.from} to {t.to}. {t.depart}, arriving {t.arrive}.{' '}
        {t.fields.map(([k, v]) => `${k} ${v}`).join(', ')}. {t.serial}.
      </div>
    </div>
  )
}
