import { useEffect, useMemo, useRef } from 'react'
import presets from './presets'
import './ClothesLine.css'

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const f = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d
const wrap = (v, m) => ((((v + m / 2) % m) + m) % m) - m / 2
const isVideo = (src = '') => /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(src)

/* The clips, drawn here — a wooden peg, a binder clip, a strip of tape.
   Each is centred on the pin point and sized from the card. */
function Clip({ kind }) {
  if (kind === 'tape') return <span className="cl__tape" aria-hidden="true" />
  if (kind === 'binder') {
    return (
      <svg className="cl__clip cl__clip--binder" viewBox="0 0 40 46" aria-hidden="true">
        <path d="M13 22 9 4a4 4 0 0 1 7.8-1.6L20 16l3.2-13.6A4 4 0 0 1 31 4l-4 18" fill="none" stroke="var(--cl-wire)" strokeWidth="2.4" strokeLinecap="round" />
        <path d="M4 20h32l-3 22a3 3 0 0 1-3 2.6H10A3 3 0 0 1 7 42z" fill="var(--cl-binder)" />
        <path d="M7 24h26" stroke="#fff" strokeOpacity="0.18" strokeWidth="1.5" />
      </svg>
    )
  }
  return (
    <svg className="cl__clip cl__clip--peg" viewBox="0 0 18 52" aria-hidden="true">
      <rect x="2" y="0" width="14" height="52" rx="3" fill="var(--cl-peg)" />
      <rect x="2" y="0" width="7" height="52" rx="3" fill="#fff" fillOpacity="0.12" />
      <path d="M2 24h14" stroke="var(--cl-wire)" strokeWidth="3" />
      <path d="M9 0v52" stroke="#000" strokeOpacity="0.12" strokeWidth="1" />
    </svg>
  )
}

/**
 * Pictures pegged to a sagging line. The line is a parabola — highest at
 * the edges, lowest in the middle — and every card hangs from its pin on it,
 * turned partway to the rope's slope where it hangs. Each card is also a
 * pendulum: when the line speeds up or slows down the cards swing, and they
 * settle with a damped spring.
 */
export default function ClothesLine({
  items = [],
  preset = 'linen',
  theme,
  label = 'Pegged gallery',
  /* 'peg', 'binder' or 'tape'. */
  clip = 'peg',

  /* --- line and cards. Lengths are fractions of the component's width. -- */
  /* Width over height of the whole component. */
  aspect = 1.556,
  /* Height of the rope's lowest point, fraction of the component's HEIGHT. */
  ropeY = 0.31,
  /* How far the rope drops from the edges to the middle. */
  sag = 0.073,
  ropeWidth = 2,
  cardWidth = 0.25,
  /* Card height over width. */
  cardRatio = 1.25,
  spacing = 0.27,
  radius = 16,
  /* How far below the rope the card's top edge hangs. */
  drop = 0.017,
  /* How much a card turns with the rope's slope, 0–1. */
  follow = 0.5,
  /* Degrees of rest tilt each card is given, varied per card. */
  naturalTilt = 1.5,

  /* --- motion ------------------------------------------------------------ */
  /* Widths per second; negative drifts the other way; 0 is still. */
  speed = 0.025,
  pauseOnHover = true,
  /* How hard the cards swing when the line changes speed. */
  swing = 1,
  dragSensitivity = 1,
  inertia = 0.5,
  /* Wheel moves the line; captures page scroll while over it. */
  wheel = true,

  className = '',
  style,
  ...rest
}) {
  const list = useMemo(
    () => items.filter(Boolean).map((it) => (typeof it === 'string' ? { src: it } : it)),
    [items],
  )
  const n = list.length
  const colours = { ...(presets[preset] || presets.linen), ...theme }
  const slots = n ? n * Math.max(1, Math.ceil((1 + 2 * spacing) / (n * spacing)) + 1) : 0

  const rootRef = useRef(null)
  const ropeRef = useRef(null)
  const ropeShadeRef = useRef(null)
  const ropeTwistRef = useRef(null)
  const cardRefs = useRef([])
  const props = useRef(null)
  props.current = { slots, aspect, ropeY, sag, cardWidth, spacing, drop, follow, naturalTilt, speed, pauseOnHover, swing, dragSensitivity, inertia, wheel }

  useEffect(() => {
    const root = rootRef.current
    if (!root) return undefined
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)')
    const s = { offset: 0, vel: 0, lastVel: 0, hover: false, visible: true, cruise: 1, swing: [], swingV: [], W: 0, t: 0 }

    /* Rope: y (in widths, from the top) at x (in widths, from the centre). */
    const ropeAt = (x, p) => p.ropeY / p.aspect - p.sag * (2 * x) ** 2
    const drawRope = () => {
      const p = props.current
      const W = root.clientWidth || 1
      const pts = []
      for (let i = 0; i <= 48; i++) {
        const x = -0.56 + (1.12 * i) / 48
        pts.push(`${i ? 'L' : 'M'}${f((x + 0.5) * W, 1)} ${f(ropeAt(x, p) * W, 1)}`)
      }
      const d = pts.join(' ')
      ropeRef.current?.setAttribute('d', d)
      ropeShadeRef.current?.setAttribute('d', d)
      ropeTwistRef.current?.setAttribute('d', d)
    }

    let drag = null
    const onDown = (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, last: e.clientX, moved: false, hist: [] }
    }
    const onMove = (e) => {
      if (!drag || e.pointerId !== drag.id) return
      if (!drag.moved) {
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return
        drag.moved = true
        root.setPointerCapture?.(e.pointerId)
        root.classList.add('is-dragging')
      }
      s.offset -= ((e.clientX - drag.last) / (root.clientWidth || 1)) * props.current.dragSensitivity
      drag.last = e.clientX
      const t = performance.now() / 1000
      drag.hist.push([t, s.offset])
      while (drag.hist.length > 2 && t - drag.hist[0][0] > 0.1) drag.hist.shift()
      requestFrame()
    }
    const onUp = (e) => {
      if (!drag || e.pointerId !== drag.id) return
      root.classList.remove('is-dragging')
      if (drag.moved) {
        const h = drag.hist
        const dt = h.length > 1 ? h[h.length - 1][0] - h[0][0] : 0
        s.vel = dt > 0.005 ? clamp((h[h.length - 1][1] - h[0][1]) / dt, -3, 3) : 0
        const stop = (ev) => {
          ev.preventDefault()
          ev.stopPropagation()
        }
        root.addEventListener('click', stop, { capture: true, once: true })
        setTimeout(() => root.removeEventListener('click', stop, { capture: true }), 0)
      }
      drag = null
      requestFrame()
    }
    const onWheel = (e) => {
      if (!props.current.wheel) return
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
      if (!d) return
      e.preventDefault()
      s.vel += clamp(d, -120, 120) * 0.0018
    }
    const onEnter = () => (s.hover = true)
    const onLeave = () => (s.hover = false)
    const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver(([e]) => {
      s.visible = e.isIntersecting
      syncVisibility()
    }) : null
    io?.observe(root)
    const onResize = () => { drawRope(); requestFrame() }
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null
    if (ro) ro.observe(root)
    else window.addEventListener('resize', onResize)
    drawRope()

    let raf = 0
    let last = performance.now()
    let prevOffset = 0
    const frame = (t) => {
      raf = 0
      const dt = Math.min(1 / 30, (t - last) / 1000)
      last = t
      const p = props.current
      if (!s.visible || document.hidden || !p.slots) return
      s.t += dt
      if (!drag) {
        s.offset += s.vel * dt
        s.vel *= Math.exp(-dt / Math.max(0.05, p.inertia))
        if (Math.abs(s.vel) < 1e-4) s.vel = 0
        const want = reduce.matches || (p.pauseOnHover && s.hover) ? 0 : 1
        s.cruise += (want - s.cruise) * (1 - Math.exp(-dt * 2.5))
        s.offset += p.speed * s.cruise * dt
      }
      const span = p.slots * p.spacing
      if (Math.abs(s.offset) > span * 50) {
        const shift = Math.round(s.offset / span) * span
        s.offset -= shift
        prevOffset -= shift
      }

      /* The line's acceleration kicks every pendulum the other way. */
      const v = dt > 0 ? (s.offset - prevOffset) / dt : 0
      prevOffset = s.offset
      const acc = dt > 0 ? (v - s.lastVel) / dt : 0
      s.lastVel = v
      const W = root.clientWidth || 1
      for (let k = 0; k < p.slots; k++) {
        const el = cardRefs.current[k]
        if (!el) continue
        const x = wrap(k * p.spacing - s.offset, span)
        if (Math.abs(x) > 0.5 + p.cardWidth) {
          el.style.visibility = 'hidden'
          continue
        }
        el.style.visibility = 'visible'
        const slope = -8 * p.sag * x
        const rest = (Math.atan(slope) * 180) / Math.PI * p.follow + Math.sin(k * 2.39) * p.naturalTilt
        let a = s.swing[k] || 0
        let av = s.swingV[k] || 0
        if (!reduce.matches) {
          av += (-60 * a - 2.2 * av + clamp(acc, -40, 40) * 9 * p.swing) * dt
          a += av * dt
        } else {
          a = 0
          av = 0
        }
        s.swing[k] = a
        s.swingV[k] = av
        const y = ropeAt(x, p)
        el.style.transform = `translate(${f(x * W, 2)}px, ${f(y * W, 2)}px) rotate(${f(rest + a, 3)}deg)`
      }
      if (!reduce.matches) raf = requestAnimationFrame(frame)
    }
    function requestFrame() {
      if (!raf && s.visible && !document.hidden) { last = performance.now(); raf = requestAnimationFrame(frame) }
    }
    function syncVisibility() {
      if (!s.visible || document.hidden) { if (raf) cancelAnimationFrame(raf); raf = 0 }
      else requestFrame()
      root.querySelectorAll('video').forEach((v) => (s.visible && !document.hidden && !reduce.matches ? v.play?.().catch(() => {}) : v.pause?.()))
    }
    document.addEventListener('visibilitychange', syncVisibility)
    reduce.addEventListener?.('change', syncVisibility)
    requestFrame()

    root.addEventListener('pointerdown', onDown)
    root.addEventListener('pointermove', onMove)
    root.addEventListener('pointerup', onUp)
    root.addEventListener('pointercancel', onUp)
    root.addEventListener('pointerenter', onEnter)
    root.addEventListener('pointerleave', onLeave)
    if (wheel) root.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      cancelAnimationFrame(raf)
      io?.disconnect()
      if (ro) ro.disconnect()
      else window.removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', syncVisibility)
      reduce.removeEventListener?.('change', syncVisibility)
      root.removeEventListener('pointerdown', onDown)
      root.removeEventListener('pointermove', onMove)
      root.removeEventListener('pointerup', onUp)
      root.removeEventListener('pointercancel', onUp)
      root.removeEventListener('pointerenter', onEnter)
      root.removeEventListener('pointerleave', onLeave)
      if (wheel) root.removeEventListener('wheel', onWheel)
    }
  }, [])

  const vars = {
    '--cl-aspect': aspect,
    '--cl-card': `${cardWidth * 100}cqw`,
    '--cl-ratio': cardRatio,
    '--cl-drop': `${drop * 100}cqw`,
    '--cl-radius': `${radius}px`,
    '--cl-rope-width': `${ropeWidth}px`,
    '--cl-bg': colours.background,
    '--cl-rope': colours.rope,
    '--cl-rope-light': colours.ropeLight,
    '--cl-card-bg': colours.card,
    '--cl-peg': colours.peg,
    '--cl-binder': colours.binder,
    '--cl-wire': colours.wire,
    '--cl-tape': colours.tape,
    '--cl-shadow': colours.shadow,
    ...style,
  }

  return (
    <div
      ref={rootRef}
      className={`cl ${className}`.trim()}
      style={vars}
      role="region"
      aria-roledescription="carousel"
      aria-label={label}
      {...rest}
    >
      <svg className="cl__rope" aria-hidden="true">
        <path ref={ropeShadeRef} className="cl__rope-shadow" />
        <path ref={ropeRef} className="cl__rope-line" />
        <path ref={ropeTwistRef} className="cl__rope-twist" />
      </svg>
      <div className="cl__line">
        {Array.from({ length: slots }, (_, k) => {
          const it = list[k % n]
          const Tag = it.href ? 'a' : 'div'
          return (
            <Tag
              key={k}
              ref={(el) => (cardRefs.current[k] = el)}
              className="cl__card"
              {...(it.href ? { href: it.href, target: it.target, rel: it.target === '_blank' ? 'noopener noreferrer' : undefined } : {})}
              {...(k >= n ? { 'aria-hidden': true, tabIndex: -1 } : {})}
            >
              <span className="cl__photo">
                {isVideo(it.src) || it.type === 'video' ? (
                  <video src={it.src} poster={it.poster} muted loop playsInline preload="metadata" />
                ) : (
                  <img src={it.src} alt={k < n ? it.alt ?? '' : ''} draggable={false} decoding="async" />
                )}
                {(it.title || it.caption) && (
                  <span className="cl__text">
                    {it.title && <span className="cl__title">{it.title}</span>}
                    {it.caption && <span className="cl__caption">{it.caption}</span>}
                  </span>
                )}
              </span>
              <Clip kind={clip} />
            </Tag>
          )
        })}
      </div>
    </div>
  )
}
