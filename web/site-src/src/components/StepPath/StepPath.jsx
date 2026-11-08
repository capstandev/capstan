import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import presets from './presets'
import './StepPath.css'

const f = (n) => Math.round(n * 100) / 100

/**
 * Process steps joined by one dashed line.
 *
 * Each step hangs a little lower than the last, and the line hops from dot
 * to dot in arcs that rise before they fall. On entering the view the line
 * draws itself from the first dot, each step fading up as the line reaches
 * it; after that a darker stretch of the dashes keeps travelling along it.
 *
 * Geometry is measured from the laid-out text, so the line follows whatever
 * the copy does. Below `stackBelow` px the steps stack and the line runs down
 * their left edge in shallow S-bends.
 */
export default function StepPath({
  steps = [],
  preset = 'paper',
  theme,
  label = 'Process',

  /* --- layout. Lengths are fractions of the component's width. ----------- */
  /* Each step sits this much lower than the one before. */
  drop = 0.071,
  /* The dot sits this far right of its text, and `dotRaise` above it. */
  dotInset = 0.06,
  dotRaise = 0.033,
  /* How high each hop rises, as a fraction of its own width. */
  curve = 0.24,
  /* Stack the steps vertically below this width, in px. */
  stackBelow = 640,

  /* --- line. Pixels, so the weave stays even at any size. --------------- */
  dash = 7,
  gap = 7,
  thickness = 1,
  dotSize = 11,
  /* Opacity of the resting line. */
  restOpacity = 0.16,

  /* --- motion ----------------------------------------------------------- */
  /* 'view' draws the line when it scrolls into view; 'mount' straight away;
     'none' shows everything at once. */
  trigger = 'view',
  /* Seconds for the line to draw from the first dot to the last. */
  drawDuration = 1.8,
  /* Seconds for the travelling stretch to run the whole line; 0 is off. */
  travel = 6.2,
  /* Length of the travelling stretch, as a fraction of the line. */
  trail = 0.3,

  className = '',
  style,
  ...rest
}) {
  const colours = { ...(presets[preset] || presets.paper), ...theme }
  const rootRef = useRef(null)
  const blockRefs = useRef([])
  const trailRefs = useRef([])
  const [geo, setGeo] = useState(null)
  const [shown, setShown] = useState(trigger === 'none')

  /* --- measure: dots from the laid-out text, path through the dots. ------ */
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return undefined
    const measure = () => {
      const W = root.clientWidth
      const H = root.clientHeight
      const stacked = W < stackBelow
      const dots = blockRefs.current.filter(Boolean).map((b) => {
        const title = b.firstElementChild
        if (stacked) return { x: dotSize, y: b.offsetTop + (title?.offsetHeight || 30) / 2 }
        return { x: b.offsetLeft + dotInset * W, y: b.offsetTop - dotRaise * W }
      })
      let d = dots.length ? `M ${f(dots[0].x)} ${f(dots[0].y)}` : ''
      for (let i = 1; i < dots.length; i++) {
        const a = dots[i - 1]
        const b = dots[i]
        if (stacked) {
          /* Down the left edge: a shallow S that swings out and back. */
          const dy = b.y - a.y
          d += ` C ${f(a.x + dotSize * 2)} ${f(a.y + dy * 0.35)} ${f(b.x - dotSize * 2)} ${f(b.y - dy * 0.35)} ${f(b.x)} ${f(b.y)}`
        } else {
          /* A hop: both handles lifted above the start, so the arc crests
             early and drops into the next dot. */
          const dx = b.x - a.x
          const lift = curve * dx
          d += ` C ${f(a.x + dx * 0.25)} ${f(a.y - lift)} ${f(a.x + dx * 0.76)} ${f(a.y - lift * 0.88)} ${f(b.x)} ${f(b.y)}`
        }
      }
      /* Where along the line (0–1) each dot falls: when to reveal its step. */
      const svgNS = 'http://www.w3.org/2000/svg'
      const probe = document.createElementNS(svgNS, 'path')
      const at = [0]
      let total = 1
      if (dots.length > 1) {
        probe.setAttribute('d', d)
        total = probe.getTotalLength() || 1
        let acc = `M ${f(dots[0].x)} ${f(dots[0].y)}`
        const segs = d.split(' C ').slice(1)
        for (const s of segs) {
          acc += ` C ${s}`
          probe.setAttribute('d', acc)
          at.push(probe.getTotalLength() / total)
        }
      }
      setGeo({ W, H, d, dots, at, stacked })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(root)
    blockRefs.current.forEach((b) => b && ro.observe(b))
    document.fonts?.ready.then(measure)
    return () => ro.disconnect()
  }, [steps.length, drop, dotInset, dotRaise, curve, stackBelow, dotSize])

  /* --- trigger ------------------------------------------------------------ */
  useEffect(() => {
    if (trigger === 'none' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(true)
      return undefined
    }
    if (trigger === 'mount') {
      const t = requestAnimationFrame(() => setShown(true))
      return () => cancelAnimationFrame(t)
    }
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setShown(true)
          io.disconnect()
        }
      },
      { threshold: 0.35 },
    )
    io.observe(rootRef.current)
    return () => io.disconnect()
  }, [trigger])

  /* --- the travelling stretch --------------------------------------------- */
  const props = useRef(null)
  props.current = { travel, trail, drawDuration, shown }
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined
    const s = { visible: true, head: 0, started: 0 }
    const io = new IntersectionObserver(([e]) => (s.visible = e.isIntersecting))
    io.observe(rootRef.current)
    let raf = 0
    let last = performance.now()
    const frame = (t) => {
      raf = requestAnimationFrame(frame)
      const dt = Math.min(1 / 30, (t - last) / 1000)
      last = t
      const p = props.current
      if (!s.visible || !p.shown || !p.travel) return
      /* Wait for the draw-in to finish before the stretch sets off. */
      if (!s.started) s.started = t + p.drawDuration * 1000
      if (t < s.started) return
      const span = 1 + p.trail
      s.head = (s.head + dt / p.travel * span) % span
      /* Stacked strokes of growing length, all centred on the same point:
         where they overlap the dashes are darkest, so the stretch has soft
         ends instead of cut ones. */
      const centre = s.head - p.trail / 2
      const k = trailRefs.current.length
      trailRefs.current.forEach((el, j) => {
        if (!el) return
        const len = (p.trail * (j + 1)) / k
        el.setAttribute('stroke-dasharray', `${f4(len)} 3`)
        el.setAttribute('stroke-dashoffset', f4(-(centre - len / 2)))
      })
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      io.disconnect()
    }
  }, [])

  const n = steps.length
  const id = useRef(`sp${Math.random().toString(36).slice(2, 8)}`).current
  const vars = {
    '--spth-drop': `${drop * 100}cqw`,
    '--spth-cols': Math.max(1, n),
    '--spth-draw': `${drawDuration}s`,
    '--spth-bg': colours.background,
    '--spth-title': colours.title,
    '--spth-number': colours.number,
    '--spth-text': colours.text,
    '--spth-line': colours.line,
    '--spth-dot': colours.dot,
    ...style,
  }

  return (
    <section
      ref={rootRef}
      className={`spth ${geo?.stacked ? 'is-stacked' : ''} ${shown ? 'is-shown' : ''} ${className}`.trim()}
      style={vars}
      aria-label={label}
      {...rest}
    >
      {geo && (
        <svg className="spth__svg" width={geo.W} height={geo.H} viewBox={`0 0 ${geo.W} ${geo.H}`} aria-hidden="true">
          <defs>
            <mask id={`${id}-draw`} maskUnits="userSpaceOnUse">
              <path className="spth__draw" d={geo.d} pathLength="1" stroke="#fff" strokeWidth={dotSize * 2} fill="none" />
            </mask>
            <mask id={`${id}-trail`} maskUnits="userSpaceOnUse">
              {[0, 1, 2, 3].map((j) => (
                <path
                  key={j}
                  ref={(el) => (trailRefs.current[j] = el)}
                  d={geo.d}
                  pathLength="1"
                  stroke="#fff"
                  strokeOpacity="0.25"
                  strokeWidth={dotSize * 2}
                  strokeDasharray="0 3"
                  fill="none"
                />
              ))}
            </mask>
          </defs>
          <g mask={`url(#${id}-draw)`}>
            <path d={geo.d} fill="none" stroke="var(--spth-line)" strokeWidth={thickness} strokeDasharray={`${dash} ${gap}`} opacity={restOpacity} />
            {travel > 0 && (
              <path d={geo.d} fill="none" stroke="var(--spth-line)" strokeWidth={thickness} strokeDasharray={`${dash} ${gap}`} mask={`url(#${id}-trail)`} />
            )}
          </g>
          {geo.dots.map((p, i) => (
            <circle
              key={i}
              className="spth__dot"
              cx={f(p.x)}
              cy={f(p.y)}
              r={dotSize / 2}
              style={{ transitionDelay: `${(geo.at[i] || 0) * drawDuration}s`, transformOrigin: `${f(p.x)}px ${f(p.y)}px` }}
            />
          ))}
        </svg>
      )}

      <ol className="spth__steps">
        {steps.map((s, i) => (
          <li
            key={i}
            ref={(el) => (blockRefs.current[i] = el)}
            className="spth__step"
            style={{ '--spth-i': i, transitionDelay: `${(geo?.at[i] || 0) * drawDuration + 0.08}s` }}
          >
            <h3 className="spth__title">
              <span className="spth__number">{s.number ?? `${String(i + 1).padStart(2, '0')})`}</span> {s.title}
            </h3>
            {s.text && <p className="spth__text">{s.text}</p>}
          </li>
        ))}
      </ol>
    </section>
  )
}

const f4 = (n) => String(Math.round(n * 1e4) / 1e4)
