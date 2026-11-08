import { useEffect, useRef } from 'react'
import presets from './presets'
import './EyeButton.css'

/**
 * A pill button with googly eyes that watch the pointer anywhere on the page.
 *
 * Each pupil eases toward the pointer's direction, travelling further the
 * further away the pointer is (it saturates a few eye-widths out), and the
 * eyes blink every few seconds. Hovering the button widens the pupils a
 * touch; pressing squashes it.
 */
export default function EyeButton({
  children = 'Say hello',
  href,
  newTab = false,
  onClick,
  preset = 'ink',
  theme,

  /* --- shape. Pixels: a button keeps its size whatever its container. ---- */
  fontSize = 20,
  paddingX = 20,
  paddingY = 6,
  /* Corner radius; 999 is a full pill. */
  radius = 999,

  /* --- eyes ------------------------------------------------------------- */
  /* 1 or 2. */
  eyes = 2,
  eyeSize = 35,
  /* Pupil diameter as a fraction of the eye. */
  pupilSize = 0.29,
  eyeGap = 4,
  /* How far the pupil may travel, 0–1 of the room it has inside the eye. */
  range = 0.9,
  /* Seconds for a pupil to cover most of the way (time constant). */
  follow = 0.19,
  blink = true,
  /* Mean seconds between blinks; each wait varies ±40%. */
  blinkEvery = 2.2,
  /* How far the lids close, 0–1. */
  blinkDepth = 0.7,

  className = '',
  style,
  ...rest
}) {
  const colours = { ...(presets[preset] || presets.ink), ...theme }
  const eyeRefs = useRef([])
  const pupilRefs = useRef([])
  const props = useRef(null)
  props.current = { eyeSize, pupilSize, range, follow, blink, blinkEvery, blinkDepth }

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const s = { px: null, py: null, cur: [] }
    const onMove = (e) => {
      s.px = e.clientX
      s.py = e.clientY
    }
    window.addEventListener('pointermove', onMove, { passive: true })

    let raf = 0
    let last = performance.now()
    const frame = (t) => {
      raf = requestAnimationFrame(frame)
      const dt = Math.min(1 / 30, (t - last) / 1000)
      last = t
      const p = props.current
      const room = (p.eyeSize * (1 - p.pupilSize)) / 2
      const k = reduce ? 1 : 1 - Math.exp(-dt / Math.max(0.01, p.follow))
      eyeRefs.current.forEach((eye, i) => {
        const pupil = pupilRefs.current[i]
        if (!eye || !pupil) return
        let tx = 0
        let ty = 0
        if (s.px !== null) {
          /* One rect per eye per frame, read in rAF — never stale, never
             forced from inside an event handler. */
          const r = eye.getBoundingClientRect()
          const dx = s.px - (r.left + r.width / 2)
          const dy = s.py - (r.top + r.height / 2)
          const d = Math.hypot(dx, dy)
          if (d > 0.5) {
            const reach = room * p.range * Math.tanh(d / (p.eyeSize * 1.5))
            tx = (dx / d) * reach
            ty = (dy / d) * reach
          }
        }
        const c = (s.cur[i] ||= { x: 0, y: 0 })
        c.x += (tx - c.x) * k
        c.y += (ty - c.y) * k
        pupil.style.translate = `${c.x.toFixed(2)}px ${c.y.toFixed(2)}px`
      })
    }
    raf = requestAnimationFrame(frame)

    /* Blinks: WAAPI on the eye whites, both eyes together. */
    let timer = 0
    const schedule = () => {
      const wait = props.current.blinkEvery * (0.6 + Math.random() * 0.8)
      timer = setTimeout(() => {
        const q = props.current
        if (q.blink && !reduce && !document.hidden) {
          const lid = 1 - q.blinkDepth
          for (const eye of eyeRefs.current) {
            eye?.animate(
              [{ scale: '1 1' }, { scale: `1 ${lid}`, offset: 0.35 }, { scale: `1 ${lid}`, offset: 0.55 }, { scale: '1 1' }],
              { duration: 280, easing: 'ease-in-out' },
            )
          }
        }
        schedule()
      }, wait * 1000)
    }
    schedule()

    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(timer)
      window.removeEventListener('pointermove', onMove)
    }
  }, [])

  const vars = {
    '--eb-font': `${fontSize}px`,
    '--eb-px': `${paddingX}px`,
    '--eb-py': `${paddingY}px`,
    '--eb-radius': `${radius}px`,
    '--eb-eye': `${eyeSize}px`,
    '--eb-pupil': `${eyeSize * pupilSize}px`,
    '--eb-gap': `${eyeGap}px`,
    '--eb-bg': colours.button,
    '--eb-text': colours.text,
    '--eb-white': colours.eye,
    '--eb-iris': colours.pupil,
    '--eb-shadow': colours.shadow,
    ...style,
  }

  const Tag = href ? 'a' : 'button'
  return (
    <Tag
      className={`eb ${className}`.trim()}
      style={vars}
      href={href}
      target={href && newTab ? '_blank' : undefined}
      rel={href && newTab ? 'noreferrer' : undefined}
      type={href ? undefined : 'button'}
      onClick={onClick}
      {...rest}
    >
      <span className="eb__label">{children}</span>
      <span className="eb__eyes" aria-hidden="true">
        {Array.from({ length: Math.max(1, Math.min(2, eyes)) }, (_, i) => (
          <span key={i} ref={(el) => (eyeRefs.current[i] = el)} className="eb__eye">
            <span ref={(el) => (pupilRefs.current[i] = el)} className="eb__pupil" />
          </span>
        ))}
      </span>
    </Tag>
  )
}