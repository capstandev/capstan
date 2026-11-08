import { useEffect, useRef, useState } from 'react'
import presets from './presets'
import { createRenderer } from './renderer'
import { createSim } from './sim'
import './InkButton.css'

/**
 * A button made of wet ink. Touch it and the pointer comes away loaded; pull
 * away and the ink follows in strands that neck out of the button, web where
 * they cross, thin as they stretch, and snap one at a time — the near half
 * whipping back into the button, which wobbles, the far half running back
 * onto the pointer, which drips.
 *
 * The button underneath is an ordinary <button>; the ink is drawn behind its
 * label on a canvas that covers the component.
 */
export default function InkButton({
  label = 'Get in touch',
  href,
  onClick,
  /* Strands drawn out each time the pointer leaves the button. */
  strands = 7,
  /* How far, in px, the strands stretch before they start to snap. */
  reach = 230,
  /* How far along the button's edge the strands are spread, px. */
  spread = 62,
  /* How readily separate bits of ink bridge together, px. */
  viscosity = 8,
  /* Ink per strand, px² — more is thicker. */
  body = 2100,
  /* How hard held strands pull the button, px. */
  tug = 7,
  preset = 'gloss',
  theme,
  className = '',
  style,
  ...rest
}) {
  const colours = { ...(presets[preset] || presets.gloss), ...theme }
  const [noGL, setNoGL] = useState(false)
  const rootRef = useRef(null)
  const canvasRef = useRef(null)
  const btnRef = useRef(null)
  const labelRef = useRef(null)
  const cursorRef = useRef(null)
  const props = useRef(null)
  props.current = { strands, reach, spread, viscosity, body, tug, colours }

  useEffect(() => {
    const root = rootRef.current
    const canvas = canvasRef.current
    const btn = btnRef.current
    if (!root || !canvas || !btn) return undefined
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)')
    let renderer = null
    try {
      renderer = reduce.matches ? null : createRenderer(canvas)
    } catch (err) {
      if (typeof console !== 'undefined') console.warn(err)
    }
    if (!renderer) {
      setNoGL(true)
      return undefined
    }
    const sim = createSim()

    let wake = () => {}
    let W = 0
    let H = 0
    let dpr = 1
    const resize = () => {
      const r = root.getBoundingClientRect()
      W = r.width
      H = r.height
      dpr = Math.min(2, window.devicePixelRatio || 1)
      canvas.width = Math.max(1, Math.round(W * dpr))
      canvas.height = Math.max(1, Math.round(H * dpr))
    }
    resize()
    const onResize = () => { resize(); wake() }
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null
    if (ro) ro.observe(root); else window.addEventListener('resize', onResize)

    const ptr = { x: -999, y: -999, active: false, mouse: false }
    const onMove = (e) => {
      const r = root.getBoundingClientRect()
      ptr.x = e.clientX - r.left
      ptr.y = e.clientY - r.top
      ptr.active = true
      ptr.mouse = e.pointerType === 'mouse'
      wake()
    }
    const onLeave = () => {
      ptr.active = false
      wake()
    }
    const onDown = () => { sim.press(); wake() }
    root.addEventListener('pointermove', onMove)
    root.addEventListener('pointerdown', onMove)
    root.addEventListener('pointerleave', onLeave)
    root.addEventListener('pointercancel', onLeave)
    btn.addEventListener('pointerdown', onDown)

    let raf = 0
    let last = performance.now()
    let visible = !document.hidden
    let inView = true
    let lastActivity = performance.now()
    const frame = (now) => {
      raf = 0
      if (!visible || !W) return
      const dt = Math.min(1 / 30, (now - last) / 1000)
      last = now
      const p = props.current

      const rr = root.getBoundingClientRect()
      const br = btn.getBoundingClientRect()
      const geo = {
        cx: br.left + br.width / 2 - rr.left,
        cy: br.top + br.height / 2 - rr.top,
        hw: br.width / 2,
        hh: br.height / 2,
        height: H,
      }
      const opt = {
        strands: reduce.matches ? 0 : p.strands,
        reach: p.reach,
        spread: p.spread,
        volume: p.body,
        blobVolume: 170,
        dry: 70,
        gravity: 520,
        tug: p.tug,
      }
      /* Two half steps keep the chains stiff when the pointer whips. */
      sim.step(dt / 2, geo, ptr, opt)
      sim.step(dt / 2, geo, ptr, opt)

      const s = sim.state
      const b = s.body
      const gy = (y) => (H - y) * dpr
      renderer.render({
        body: [(geo.cx + b.ox) * dpr, gy(geo.cy + b.oy), geo.hw * dpr, geo.hh * dpr],
        warp: [b.dirX || 0, -(b.dirY || 0), b.stretch || 0, b.squash],
        strands: s.strands.map((st) => ({
          n: st.n,
          x: Array.from(st.x, (v) => v * dpr),
          y: Array.from(st.y, (v) => gy(v)),
          r: Array.from(st.r, (v) => v * dpr),
        })),
        blob: [s.blob.x * dpr, gy(s.blob.y), sim.blobRadius() * dpr],
        drops: s.drops.map((d) => ({ x: d.x * dpr, y: gy(d.y), r: d.r * dpr, tail: Math.min(40, d.vy * 0.03) * dpr })),
        merge: p.viscosity * dpr,
        bevel: 24 * dpr,
        shadow: 0.22,
        dpr,
        colours: p.colours,
      })

      /* The label rides on the wobbling body. */
      if (labelRef.current) {
        labelRef.current.style.transform = `translate(${b.ox}px, ${b.oy}px) scale(${1 + b.squash * 0.05}, ${1 - b.squash * 0.05})`
      }
      const cur = cursorRef.current
      if (cur) {
        const show = ptr.active && ptr.mouse
        cur.style.opacity = show ? '1' : '0'
        cur.style.transform = `translate(${ptr.x}px, ${ptr.y}px)`
        cur.dataset.inked = s.inked ? 'true' : 'false'
        root.classList.toggle('has-cursor', show)
      }
      if (visible && (now - lastActivity < 2500 || s.strands.length || s.drops.length || (!ptr.active && s.blob.vol > 0))) raf = requestAnimationFrame(frame)
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
      cancelAnimationFrame(raf)
      io?.disconnect()
      document.removeEventListener('visibilitychange', updateVisibility)
      if (ro) ro.disconnect(); else window.removeEventListener('resize', onResize)
      root.removeEventListener('pointermove', onMove)
      root.removeEventListener('pointerdown', onMove)
      root.removeEventListener('pointerleave', onLeave)
      root.removeEventListener('pointercancel', onLeave)
      btn.removeEventListener('pointerdown', onDown)
      renderer.destroy()
      renderer = null
    }
    /* Mount-only. Live values are read through props.current. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const vars = {
    '--ib-bg': colours.background,
    '--ib-ink': colours.ink,
    '--ib-label': colours.label,
    '--ib-muted': colours.muted,
    ...style,
  }
  const Tag = href ? 'a' : 'button'

  return (
    <div ref={rootRef} className={`ib ${className}`.trim()} style={vars} data-gl={noGL ? 'off' : 'on'} {...rest}>
      {!noGL && <canvas ref={canvasRef} className="ib__canvas" aria-hidden="true" />}
      <Tag ref={btnRef} className="ib__btn" href={href} type={href ? undefined : 'button'} onClick={onClick}>
        <span ref={labelRef} className="ib__label">
          {label}
        </span>
      </Tag>
      <span ref={cursorRef} className="ib__cursor" aria-hidden="true" />
    </div>
  )
}
