import { useEffect, useMemo, useRef, useState } from 'react'
import { springEasing } from '../../lib/shape'
import presets from './presets'
import './FanCarousel.css'

/**
 * Where a card sits, given how many places it is from the focused one.
 *
 * Measured off the reference rather than guessed: eight degrees of rotation
 * per place, a fixed step sideways and a smaller one downwards, and a scale
 * that drops away from the focused card. The focused card does not sit on
 * that scale curve - it jumps to `focusScale`, well clear of its neighbours,
 * which is what makes it read as picked up rather than merely nearest.
 */
function place(k, p) {
  const away = Math.abs(k)
  return {
    x: k * p.spread,
    y: away * p.rise,
    rot: k * p.rotation,
    scale: away < 0.5
      ? p.focusScale
      : Math.max(0.2, p.neighbourScale - (away - 1) * p.falloff),
  }
}

/* The fan is a hand of cards, not a ring: the ends are ends. */
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

export default function FanCarousel({
  items = [],
  preset = 'midnight',
  theme,

  /* --- the fan. Lengths are fractions of the container's width, so the
     spread holds its proportions at any size. ----------------------------- */
  cardWidth = 0.27,
  /* Height over width. 4:5, the shape the reference uses. */
  cardRatio = 1.25,
  /* Sideways and downwards step between neighbours. */
  spread = 0.121,
  rise = 0.04,
  /* Degrees of rotation per place from the middle. */
  rotation = 8,
  focusScale = 1.1,
  neighbourScale = 0.8,
  falloff = 0.05,
  /* Places drawn either side of the focused card. */
  reach = 3,
  /* Fraction of the card's own width. */
  cornerRadius = 0.1,
  aspect = 2.4,

  /* --- motion ----------------------------------------------------------- */
  startIndex,
  /* Seconds the fan takes to resettle after the focus moves. */
  speed = 0.62,
  /* 0 is a critically damped glide; 1 overshoots about a quarter. */
  bounce = 0.34,
  /* How far the pointer must travel to turn the fan by one card, as a
     fraction of the container's width. */
  swipe = 0.12,
  dragSensitivity = 1,
  wheel = true,
  hoverZoom = 1.05,
  dots = true,
  onChange,

  className = '',
  style,
  ...rest
}) {
  const cards = useMemo(() => items.filter(Boolean), [items])
  const count = cards.length

  const rootRef = useRef(null)
  const cardRefs = useRef([])
  const [index, setIndex] = useState(() =>
    clamp(startIndex ?? Math.floor((count - 1) / 2), 0, Math.max(0, count - 1))
  )

  const geom = { spread, rise, rotation, focusScale, neighbourScale, falloff }

  const drag = useRef({
    active: false,
    pointerId: null,
    startX: 0,
    x: 0,
    moved: false,
    width: 1,
    offset: 0,
  })

  /* One sampled spring, reused by every card's transition. */
  const curve = useMemo(() => springEasing(bounce), [bounce])

  const move = (next) => {
    const to = clamp(next, 0, count - 1)
    if (to === index) return
    setIndex(to)
    onChange?.(to, cards[to])
  }

  /* --- drag ------------------------------------------------------------- */

  /**
   * While a finger is down the fan follows it directly, so the transforms are
   * written here rather than left to React: a fractional offset between two
   * arrangements is not a state the component ever renders. On release the
   * offset is dropped, the spring transition comes back, and the fan settles
   * into whichever card the throw chose.
   */
  const paint = (offset) => {
    const root = rootRef.current
    if (!root) return
    root.classList.toggle('fan--dragging', offset !== 0)
    for (let i = 0; i < cardRefs.current.length; i++) {
      const el = cardRefs.current[i]
      if (!el) continue
      const k = i - index - offset
      const { x, y, rot, scale } = place(k, geom)
      el.style.transform =
        `translate(-50%, -50%) translate(${x * 100}cqw, ${y * 100}cqw) rotate(${rot}deg) scale(${scale})`
      el.style.opacity = Math.abs(k) > reach + 0.5 ? '0' : '1'
    }
  }

  const onPointerDown = (e) => {
    if (e.button != null && e.button !== 0) return
    const d = drag.current
    d.active = true
    d.pointerId = e.pointerId
    d.startX = e.clientX
    d.x = e.clientX
    d.moved = false
    d.offset = 0
    d.width = rootRef.current?.getBoundingClientRect().width || 1
  }

  const onPointerMove = (e) => {
    const d = drag.current
    if (!d.active || d.pointerId !== e.pointerId) return
    d.x = e.clientX
    const travelled = d.x - d.startX
    if (!d.moved && Math.abs(travelled) > 4) {
      d.moved = true
      /* Capture is deferred to here: taken on pointerdown it swallows the
         click on the card underneath. */
      e.currentTarget.setPointerCapture?.(e.pointerId)
    }
    if (!d.moved) return
    /* Dragging right brings earlier cards in, hence the negation. */
    let offset = (-travelled / (d.width * swipe)) * dragSensitivity
    /* The ends resist rather than tear off, so a hand of cards feels finite. */
    const lo = -index, hi = count - 1 - index
    if (offset < lo) offset = lo + (offset - lo) * 0.28
    if (offset > hi) offset = hi + (offset - hi) * 0.28
    d.offset = offset
    paint(offset)
  }

  const endDrag = (e) => {
    const d = drag.current
    if (d.pointerId !== e.pointerId) return
    d.active = false
    d.pointerId = null
    if (!d.moved) return
    const landed = clamp(index + Math.round(d.offset), 0, count - 1)
    d.offset = 0
    paint(0)
    if (landed !== index) move(landed)
  }

  /* React owns the resting layout; this only has to undo a drag's handiwork
     when the index changes underneath it. */
  useEffect(() => {
    if (!drag.current.active) paint(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, count, spread, rise, rotation, focusScale, neighbourScale, falloff, reach])

  /* --- wheel and keys ---------------------------------------------------- */

  useEffect(() => {
    const root = rootRef.current
    if (!root || !wheel) return
    let cooling = 0
    const onWheel = (e) => {
      /* Horizontal intent only. Hijacking a vertical scroll would trap the
         page inside the carousel. */
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
      e.preventDefault()
      const now = performance.now()
      if (now < cooling) return
      cooling = now + 260
      move(index + (e.deltaX > 0 ? 1 : -1))
    }
    root.addEventListener('wheel', onWheel, { passive: false })
    return () => root.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, count, wheel])

  const onKeyDown = (e) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (step) { e.preventDefault(); move(index + step); return }
    if (e.key === 'Home') { e.preventDefault(); move(0) }
    if (e.key === 'End') { e.preventDefault(); move(count - 1) }
  }

  const skin = { ...(presets[preset] || presets.midnight), ...theme }

  const vars = {
    '--fan-bg': skin.background,
    '--fan-scrim': skin.scrim,
    '--fan-title': skin.title,
    '--fan-subtitle': skin.subtitle,
    '--fan-pill': skin.pill,
    '--fan-pill-text': skin.pillText,
    '--fan-dot': skin.dot,
    '--fan-dot-active': skin.dotActive,
    '--fan-shadow-color': skin.shadow,
    '--fan-aspect': aspect,
    '--fan-card-w': `${cardWidth * 100}cqw`,
    '--fan-ratio': cardRatio,
    '--fan-corner': `${cornerRadius * cardWidth * 100}cqw`,
    '--fan-zoom': hoverZoom,
    '--fan-ease': curve,
    '--fan-speed': `${speed}s`,
    ...style,
  }

  if (!count) return null

  return (
    <div
      ref={rootRef}
      className={`fan${className ? ` ${className}` : ''}`}
      style={vars}
      role="region"
      aria-roledescription="carousel"
      aria-label="Fan carousel"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      {...rest}
    >
      <div className="fan-stage">
        {cards.map((item, i) => {
          const k = i - index
          const { x, y, rot, scale } = place(k, geom)
          const beyond = Math.abs(k) > reach
          const Tag = item.href ? 'a' : 'div'
          return (
            <Tag
              key={item.id ?? i}
              ref={(el) => (cardRefs.current[i] = el)}
              className={`fan-card${k === 0 ? ' is-focused' : ''}`}
              href={item.href}
              style={{
                transform:
                  `translate(-50%, -50%) translate(${x * 100}cqw, ${y * 100}cqw) rotate(${rot}deg) scale(${scale})`,
                zIndex: 100 - Math.abs(k),
                opacity: beyond ? 0 : 1,
                /* Nothing past the fan's reach should be clickable. */
                pointerEvents: beyond ? 'none' : undefined,
              }}
              onClick={() => {
                /* A drag that happens to end on a card must not also pick it. */
                if (drag.current.moved) return
                if (k !== 0) move(i)
              }}
              aria-current={k === 0 ? 'true' : undefined}
              aria-label={item.title ?? item.alt ?? undefined}
            >
              <span className="fan-frame">
                {item.image ? (
                  <img
                    className="fan-image"
                    src={item.image}
                    alt={item.alt ?? ''}
                    draggable="false"
                    loading={Math.abs(k) <= reach ? 'eager' : 'lazy'}
                    decoding="async"
                  />
                ) : (
                  /* Stands in until real photography arrives; it zooms on
                     hover exactly as an image would. */
                  <span className="fan-image" style={{ background: item.art }} />
                )}
                <span className="fan-scrim" aria-hidden="true" />
                {(item.title || item.subtitle) && (
                  <span className="fan-text">
                    {item.title && <span className="fan-title">{item.title}</span>}
                    {item.subtitle && <span className="fan-subtitle">{item.subtitle}</span>}
                  </span>
                )}
                {item.tag && (
                  <span
                    className="fan-tag"
                    style={item.accent ? { background: item.accent } : undefined}
                  >
                    {item.tag}
                  </span>
                )}
              </span>
            </Tag>
          )
        })}
      </div>

      {dots && (
        <div className="fan-dots" role="group" aria-label="Choose a step">
          {cards.map((item, i) => (
            <button
              key={item.id ?? i}
              type="button"
              className={`fan-dot${i === index ? ' is-on' : ''}`}
              aria-pressed={i === index}
              aria-label={item.title ?? `Card ${i + 1}`}
              onClick={() => move(i)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
