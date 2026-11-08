import { useEffect, useMemo, useRef } from 'react'
import presets from './presets'
import './HaloCarousel.css'

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const f = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d
const smooth = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1)
  return t * t * (3 - 2 * t)
}
const isVideo = (src = '') => /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(src)

/**
 * Cards ride the rim of a large wheel whose hub sits below the frame, so the
 * visible part of the rim is a shallow arch over the copy. Every card is
 * turned to the rim's tangent and fades out as it rolls down either side.
 *
 * Position is an angle (`s.pos`, in cards), so drag, wheel, momentum and the
 * idle drift all add to one number and the layout is a pure function of it.
 */
export default function HaloCarousel({
  items = [],
  preset = 'paper',
  theme,
  label = 'Work carousel',

  /* --- copy ------------------------------------------------------------- */
  eyebrow = '',
  title = '',
  body = '',
  /* Top of the copy block, fraction of the component's height. */
  copyTop = 0.477,

  /* --- the arch. Lengths are fractions of the component's width. -------- */
  /* Width over height of the whole component. */
  aspect = 1.556,
  /* Radius of the wheel the cards ride. Bigger is a flatter arch. */
  arcRadius = 0.66,
  /* Height of the arch's crown: where the top card's centre sits, as a
     fraction of the component's height. */
  crown = 0.256,
  cardSize = 0.196,
  /* Card height over width. */
  cardRatio = 1,
  /* Space between cards along the rim. */
  gap = 0.0286,
  /* Corner radius, fraction of the card's width. */
  radius = 0.095,
  /* Tilt cards to the rim (1), keep them upright (0), or anything between. */
  tilt = 1,
  /* Degrees off the crown where cards start fading, and where they are gone. */
  fadeStart = 58,
  fadeEnd = 106,
  /* Scale a card shrinks to by the time it is gone. 1 is off. */
  edgeScale = 1,
  shadow = true,

  /* --- motion ----------------------------------------------------------- */
  /* Idle drift, cards per second, clockwise (left to right). Negative
     drifts the other way; 0 is off. */
  drift = 0.154,
  /* Seconds the drift waits after the visitor lets go. */
  resume = 1.2,
  pauseOnHover = false,
  dragSensitivity = 1,
  /* How far a flick carries, in seconds of its release speed. */
  inertia = 0.35,
  /* Wheel and trackpad turn the arch. Captures page scroll while over it. */
  wheel = true,
  keyboard = true,

  className = '',
  style,
  ...rest
}) {
  const list = useMemo(
    () => items.filter(Boolean).map((it) => (typeof it === 'string' ? { src: it } : it)),
    [items],
  )
  const n = list.length
  const colours = { ...(presets[preset] || presets.paper), ...theme }

  /* Angle between neighbouring cards, from the chord they need. */
  const stepDeg = (((cardSize + gap) / arcRadius) * 180) / Math.PI
  /* Enough copies that the loop's seam is always past the fade. */
  const slots = n ? n * Math.max(1, Math.ceil((2 * fadeEnd + stepDeg) / (n * stepDeg))) : 0

  const rootRef = useRef(null)
  const cardRefs = useRef([])

  const props = useRef(null)
  props.current = {
    slots, stepDeg, arcRadius, crown, aspect, tilt, fadeStart, fadeEnd, edgeScale,
    drift, resume, pauseOnHover, dragSensitivity, inertia, wheel, keyboard,
  }

  useEffect(() => {
    const root = rootRef.current
    if (!root) return undefined
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)')
    const s = { pos: 0, vel: 0, idle: 99, hover: false, visible: true, dirty: true }

    /* --- drag: the card under the finger stays under it ------------------ */
    let drag = null
    const onDown = (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, last: e.clientX, moved: false, hist: [] }
    }
    const onMove = (e) => {
      if (!drag || e.pointerId !== drag.id) return
      if (!drag.moved) {
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return
        drag.moved = true
        root.setPointerCapture?.(e.pointerId)
        root.classList.add('is-dragging')
      }
      const p = props.current
      const W = root.clientWidth || 1
      /* Pixels along the rim → degrees → cards. */
      const deg = (((e.clientX - drag.last) / (W * p.arcRadius)) * 180) / Math.PI
      drag.last = e.clientX
      s.pos -= (deg / p.stepDeg) * p.dragSensitivity
      s.vel = 0
      s.idle = 0
      const t = performance.now() / 1000
      drag.hist.push([t, s.pos])
      while (drag.hist.length > 2 && t - drag.hist[0][0] > 0.1) drag.hist.shift()
    }
    const onUp = (e) => {
      if (!drag || e.pointerId !== drag.id) return
      root.classList.remove('is-dragging')
      if (drag.moved) {
        const h = drag.hist
        const dt = h.length > 1 ? h[h.length - 1][0] - h[0][0] : 0
        s.vel = dt > 0.005 ? clamp((h[h.length - 1][1] - h[0][1]) / dt, -12, 12) : 0
        const stop = (ev) => {
          ev.preventDefault()
          ev.stopPropagation()
        }
        root.addEventListener('click', stop, { capture: true, once: true })
        setTimeout(() => root.removeEventListener('click', stop, { capture: true }), 0)
      }
      s.idle = 0
      drag = null
    }

    const onWheel = (e) => {
      const p = props.current
      if (!p.wheel) return
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
      if (!d) return
      e.preventDefault()
      s.vel += clamp(d, -120, 120) * 0.012
      s.idle = 0
    }
    const onKey = (e) => {
      if (!props.current.keyboard) return
      const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
      if (!dir) return
      e.preventDefault()
      /* One card's worth of momentum: with friction k the glide is v / k. */
      s.vel += dir * 2.6
      s.idle = 0
    }
    const onEnter = () => (s.hover = true)
    const onLeave = () => (s.hover = false)

    const io = new IntersectionObserver(([entry]) => {
      s.visible = entry.isIntersecting
      root.querySelectorAll('video').forEach((v) => {
        if (s.visible && !reduce.matches) v.play?.().catch(() => {})
        else v.pause?.()
      })
    })
    io.observe(root)

    const paint = () => {
      const p = props.current
      const S = p.slots
      const H = 1 / p.aspect /* height in widths */
      const cy = p.crown * H + p.arcRadius
      for (let k = 0; k < S; k++) {
        const el = cardRefs.current[k]
        if (!el) continue
        let u = k - s.pos
        u = ((((u + S / 2) % S) + S) % S) - S / 2
        const deg = u * p.stepDeg
        const a = Math.abs(deg)
        if (a > p.fadeEnd + p.stepDeg) {
          if (el.style.visibility !== 'hidden') el.style.visibility = 'hidden'
          continue
        }
        const th = (deg * Math.PI) / 180
        const x = Math.sin(th) * p.arcRadius
        const y = cy - Math.cos(th) * p.arcRadius
        const fade = 1 - smooth(p.fadeStart, p.fadeEnd, a)
        const sc = p.edgeScale + (1 - p.edgeScale) * fade
        /* Explicit: the stylesheet parks unplaced cards hidden, so clearing
           the inline value would hide them again. */
        el.style.visibility = fade > 0.001 ? 'visible' : 'hidden'
        el.style.opacity = f(fade, 4)
        el.style.transform =
          `translate(-50%, -50%) translate(${f(x * 100, 4)}cqw, ${f(y * 100, 4)}cqw) rotate(${f(deg * p.tilt, 3)}deg) scale(${f(sc, 4)})`
        el.style.pointerEvents = fade > 0.3 ? '' : 'none'
      }
    }

    let raf = 0
    let last = performance.now()
    const frame = (t) => {
      raf = requestAnimationFrame(frame)
      const dt = Math.min(1 / 30, (t - last) / 1000)
      last = t
      const p = props.current
      if (!p.slots || !s.visible) return
      const before = s.pos

      if (!drag) {
        /* Momentum bleeds off; the drift fades back in once it has. */
        s.pos += s.vel * dt
        s.vel *= Math.exp(-dt * 2.6)
        if (Math.abs(s.vel) < 1e-3) s.vel = 0
        s.idle += dt
        const cruise = reduce.matches || (p.pauseOnHover && s.hover) ? 0 : p.drift
        const ramp = clamp((s.idle - p.resume) / 0.8, 0, 1)
        /* Positive drift turns the arch clockwise: cards travel left to right. */
        s.pos -= cruise * ramp * dt
      }
      if (Math.abs(s.pos) > p.slots * 50) s.pos -= Math.round(s.pos / p.slots) * p.slots

      if (s.dirty || s.pos !== before) {
        s.dirty = false
        paint()
      }
    }
    raf = requestAnimationFrame(frame)

    const ro = new ResizeObserver(() => (s.dirty = true))
    ro.observe(root)

    root.addEventListener('pointerdown', onDown)
    root.addEventListener('pointermove', onMove)
    root.addEventListener('pointerup', onUp)
    root.addEventListener('pointercancel', onUp)
    root.addEventListener('pointerenter', onEnter)
    root.addEventListener('pointerleave', onLeave)
    root.addEventListener('wheel', onWheel, { passive: false })
    root.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(raf)
      io.disconnect()
      ro.disconnect()
      root.removeEventListener('pointerdown', onDown)
      root.removeEventListener('pointermove', onMove)
      root.removeEventListener('pointerup', onUp)
      root.removeEventListener('pointercancel', onUp)
      root.removeEventListener('pointerenter', onEnter)
      root.removeEventListener('pointerleave', onLeave)
      root.removeEventListener('wheel', onWheel)
      root.removeEventListener('keydown', onKey)
    }
  }, [])

  const vars = {
    '--hc-aspect': aspect,
    '--hc-card': `${cardSize * 100}cqw`,
    '--hc-ratio': cardRatio,
    '--hc-radius': radius,
    '--hc-copy-top': `${copyTop * 100}%`,
    '--hc-bg': colours.background,
    '--hc-card-bg': colours.card,
    '--hc-eyebrow': colours.eyebrow,
    '--hc-title': colours.title,
    '--hc-body': colours.body,
    '--hc-shadow': shadow ? colours.shadow : 'transparent',
    ...style,
  }

  return (
    <div
      ref={rootRef}
      className={`hc ${className}`.trim()}
      style={vars}
      role="region"
      aria-roledescription="carousel"
      aria-label={label}
      tabIndex={keyboard ? 0 : undefined}
      {...rest}
    >
      <div className="hc__rim">
        {Array.from({ length: slots }, (_, k) => {
          const it = list[k % n]
          const video = isVideo(it.src) || it.type === 'video'
          const Tag = it.href ? 'a' : 'div'
          return (
            <Tag
              key={k}
              ref={(el) => (cardRefs.current[k] = el)}
              className="hc__card"
              {...(it.href
                ? { href: it.href, target: it.target, rel: it.target === '_blank' ? 'noopener noreferrer' : undefined, 'aria-label': it.alt || 'Open project' }
                : {})}
              {...(k >= n ? { 'aria-hidden': true, tabIndex: -1 } : {})}
            >
              {video ? (
                <video src={it.src} poster={it.poster} muted loop playsInline preload="metadata" />
              ) : (
                <img src={it.src} alt={k < n ? it.alt ?? '' : ''} draggable={false} decoding="async" />
              )}
            </Tag>
          )
        })}
      </div>

      {(eyebrow || title || body) && (
        <div className="hc__copy">
          {eyebrow && <p className="hc__eyebrow">{eyebrow}</p>}
          {title && <h2 className="hc__title">{title}</h2>}
          {body && <p className="hc__body">{body}</p>}
        </div>
      )}
    </div>
  )
}