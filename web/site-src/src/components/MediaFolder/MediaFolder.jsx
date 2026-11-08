import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { springEasing } from '../../lib/shape'
import presets from './presets'
import './MediaFolder.css'

const kindOf = (it) =>
  it.type ||
  (/\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(it.src || '') ? 'video'
    : /\.(mp3|wav|ogg|m4a|aac|flac)(\?|#|$)/i.test(it.src || '') ? 'audio'
    : 'image')

const time = (s) => {
  if (!Number.isFinite(s)) return '0:00'
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

/* Where windows land when an item does not say: spread round an ellipse,
   alternating a little in and out so the scatter does not read as a ring. */
const autoPlace = (i, n) => {
  const a = -Math.PI / 2 + (i / n) * Math.PI * 2 + 0.3
  const r = i % 2 ? 0.86 : 1
  return { x: Math.cos(a) * 0.3 * r, y: Math.sin(a) * 0.19 * r, rotate: 0 }
}

function Folder({ colours, peek, hover }) {
  const id = useId().replace(/:/g, '')
  return (
    <span className="mf__icon" aria-hidden="true">
      <svg className="mf__back" viewBox="0 0 120 86">
        <defs>
          <linearGradient id={`b${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={colours.folderBack} />
            <stop offset="1" stopColor={colours.folderShade} />
          </linearGradient>
        </defs>
        {/* Back panel with its tab rising on the left. */}
        <path
          d="M2 12.5C2 8.4 5.4 5 9.5 5h27.3c2.3 0 4.4.9 6 2.6l5.2 5.4h62.5c4.1 0 7.5 3.4 7.5 7.5V40H2z"
          fill={`url(#b${id})`}
        />
      </svg>
      {peek.length > 0 && (
        <span className={`mf__peek${hover ? ' is-up' : ''}`}>
          {peek.map((it, i) => (
            <span key={i} className="mf__thumb" style={{ '--i': i - (peek.length - 1) / 2 }}>
              {kindOf(it) === 'video' ? (
                <video src={it.src} poster={it.poster} muted playsInline preload="metadata" />
              ) : (
                <img src={it.cover || it.src} alt="" draggable={false} />
              )}
            </span>
          ))}
        </span>
      )}
      <svg className="mf__front" viewBox="0 0 120 86">
        <defs>
          <linearGradient id={`f${id}`} x1="0" y1="0" x2="0.9" y2="1">
            <stop offset="0" stopColor={colours.folderLight} />
            <stop offset="1" stopColor={colours.folder} />
          </linearGradient>
          <linearGradient id={`g${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fff" stopOpacity="0.4" />
            <stop offset="0.45" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
        </defs>
        <rect x="0" y="21" width="120" height="65" rx="10" fill={`url(#f${id})`} />
        <rect x="0" y="21" width="120" height="65" rx="10" fill={`url(#g${id})`} />
        {/* A hairline highlight along the front's top lip. */}
        <path d="M9 22h102" stroke="#fff" strokeOpacity="0.55" strokeWidth="1" strokeLinecap="round" />
      </svg>
    </span>
  )
}

function AudioBody({ item, colours, playing }) {
  const ref = useRef(null)
  const [on, setOn] = useState(false)
  const [t, setT] = useState(0)
  const [d, setD] = useState(0)
  useEffect(() => {
    if (!playing && ref.current) {
      ref.current.pause()
    }
  }, [playing])
  const toggle = () => {
    const a = ref.current
    if (!a) return
    if (a.paused) a.play().catch(() => {})
    else a.pause()
  }
  return (
    <div className="mf__audio">
      <span className="mf__cover">
        {item.cover ? (
          <img src={item.cover} alt="" draggable={false} />
        ) : (
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V6l10-2v12M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3Zm10-2a3 3 0 1 1-3-3 3 3 0 0 1 3 3Z" /></svg>
        )}
      </span>
      <div className="mf__track">
        <div className="mf__row">
          <button type="button" className="mf__play" aria-label={on ? 'Pause' : 'Play'} onClick={toggle}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              {on ? <path d="M8 5h3v14H8zM13 5h3v14h-3z" /> : <path d="M8 5.5v13l10.5-6.5z" />}
            </svg>
          </button>
          <span className="mf__song">{item.track || item.title}</span>
          <span className="mf__time">{time(t)} / {time(d)}</span>
        </div>
        <div className="mf__bar" style={{ '--p': d ? t / d : 0, '--mf-accent': colours.accent }} />
      </div>
      <audio
        ref={ref}
        src={item.src}
        preload="none"
        onPlay={() => setOn(true)}
        onPause={() => setOn(false)}
        onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setD(e.currentTarget.duration)}
      />
    </div>
  )
}

export default function MediaFolder({
  items = [],
  label = 'Folder',
  preset = 'sky',
  theme,

  /* --- folder ------------------------------------------------------------- */
  /* 'click', 'doubleClick' or 'hover'. */
  openOn = 'click',
  /* Thumbnails poking out of the closed folder. 0 hides them. */
  peek = 3,
  /* Folder width, fraction of the component's width. */
  folderSize = 0.111,
  /* Width over height of the whole component. */
  aspect = 1.556,

  /* --- windows ------------------------------------------------------------ */
  /* Default window width, fraction of the component's width. Items may set
     their own `width`, `x`, `y` (fractions of the width from the centre)
     and `rotate` (degrees). */
  windowWidth = 0.12,
  windowRadius = 12,
  /* Blur behind the window glass, px. */
  windowBlur = 4,
  /* 'dots' (three coloured lights) or 'mono'. */
  chrome = 'dots',
  /* Seconds between windows leaving the folder. */
  stagger = 0.035,
  /* Seconds a window takes to land, and how much it overshoots (0–1). */
  duration = 0.62,
  bounce = 0.42,
  draggable = true,
  /* Clicking anywhere that is not a window closes them all. */
  closeOnOutside = true,
  onOpenChange,

  className = '',
  style,
  ...rest
}) {
  const list = useMemo(
    () => items.filter(Boolean).map((it) => (typeof it === 'string' ? { src: it } : it)),
    [items],
  )
  const colours = { ...(presets[preset] || presets.sky), ...theme }
  const ease = useMemo(() => springEasing(bounce), [bounce])

  const [open, setOpen] = useState(false)
  /* Windows closed one at a time while the rest stay open. */
  const [shut, setShut] = useState(() => new Set())
  const [hover, setHover] = useState(false)
  /* Dragged offsets in px, and the stacking order. */
  const [moved, setMoved] = useState({})
  const [front, setFront] = useState({})
  const zTop = useRef(1)

  const rootRef = useRef(null)
  const folderRef = useRef(null)
  const winRefs = useRef([])

  const setOpenState = (v) => {
    setOpen(v)
    if (v) {
      setShut(new Set())
      setMoved({})
    }
    onOpenChange?.(v)
  }
  const openRef = useRef(open)
  openRef.current = open

  /* All windows closed by hand → the folder is closed. */
  useEffect(() => {
    if (open && list.length && shut.size >= list.length) setOpenState(false)
  }, [shut, open, list.length]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && openRef.current) setOpenState(false)
    }
    const onDown = (e) => {
      if (!closeOnOutside || !openRef.current) return
      const t = e.target
      if (folderRef.current?.contains(t)) return
      if (winRefs.current.some((w) => w?.contains(t))) return
      setOpenState(false)
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [closeOnOutside]) // eslint-disable-line react-hooks/exhaustive-deps

  /* Videos play while their window is out and the folder is on screen. */
  useEffect(() => {
    const root = rootRef.current
    if (!root) return undefined
    let visible = true
    const sync = () => {
      winRefs.current.forEach((w, i) => {
        const v = w?.querySelector('video')
        if (!v) return
        if (open && visible && !shut.has(i)) v.play?.().catch(() => {})
        else v.pause?.()
      })
    }
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting
      sync()
    })
    io.observe(root)
    sync()
    return () => io.disconnect()
  }, [open, shut])

  /* --- drag a window by any part of it ------------------------------------ */
  const startDrag = (i) => (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    zTop.current += 1
    setFront((f) => ({ ...f, [i]: zTop.current }))
    if (!draggable || e.target.closest('button, a, input, audio')) return
    const el = winRefs.current[i]
    if (!el) return
    const base = moved[i] || { x: 0, y: 0 }
    const d = { x: e.clientX, y: e.clientY, on: false, id: e.pointerId, nx: base.x, ny: base.y }
    const onMove = (ev) => {
      if (ev.pointerId !== d.id) return
      const dx = ev.clientX - d.x
      const dy = ev.clientY - d.y
      if (!d.on) {
        if (Math.hypot(dx, dy) < 4) return
        d.on = true
        el.setPointerCapture?.(ev.pointerId)
        el.classList.add('is-dragging')
      }
      d.nx = base.x + dx
      d.ny = base.y + dy
      el.style.setProperty('--mf-dx', `${d.nx}px`)
      el.style.setProperty('--mf-dy', `${d.ny}px`)
    }
    const onUp = (ev) => {
      if (ev.pointerId !== d.id) return
      /* Off before the resting value is committed, so nothing springs. */
      el.classList.remove('is-dragging')
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      if (d.on) setMoved((m) => ({ ...m, [i]: { x: d.nx, y: d.ny } }))
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
  }

  /* Hover opens on entry, but a click still toggles — touch has no hover. */
  const folderEvents =
    openOn === 'doubleClick'
      ? { onDoubleClick: () => setOpenState(!open) }
      : { onClick: () => setOpenState(!open) }
  const onFolderEnter = () => {
    setHover(true)
    if (openOn === 'hover' && !open) setOpenState(true)
  }

  const vars = {
    '--mf-aspect': aspect,
    '--mf-folder': `${folderSize * 100}cqw`,
    '--mf-bg': colours.background,
    '--mf-label': colours.label,
    '--mf-highlight': colours.highlight,
    '--mf-window': colours.window,
    '--mf-window-text': colours.windowText,
    '--mf-checker': colours.checker,
    '--mf-shadow': colours.shadow,
    '--mf-accent': colours.accent,
    '--mf-radius': `${windowRadius}px`,
    '--mf-blur': `${windowBlur}px`,
    '--mf-ease': ease,
    '--mf-duration': `${duration}s`,
    ...style,
  }

  const peekItems = list.filter((it) => kindOf(it) !== 'audio').slice(0, Math.max(0, peek))

  return (
    <div
      ref={rootRef}
      className={`mf ${open ? 'is-open' : ''} ${className}`.trim()}
      style={vars}
      onPointerLeave={openOn === 'hover' ? () => setOpenState(false) : undefined}
      {...rest}
    >
      <div className="mf__windows">
        {list.map((it, i) => {
          const kind = kindOf(it)
          const at = { ...autoPlace(i, list.length), ...it }
          const out = open && !shut.has(i)
          const off = moved[i] || { x: 0, y: 0 }
          const delay = (open ? i : list.length - 1 - i) * stagger
          return (
            <div
              key={i}
              ref={(el) => (winRefs.current[i] = el)}
              className={`mf__window${out ? ' is-out' : ''}`}
              role="group"
              aria-label={it.title || `Item ${i + 1}`}
              aria-hidden={!out}
              inert={!out ? true : undefined}
              onPointerDown={startDrag(i)}
              style={{
                width: `${(it.width ?? windowWidth) * 100}cqw`,
                '--mf-x': `${at.x * 100}cqw`,
                '--mf-y': `${at.y * 100}cqw`,
                '--mf-r': `${at.rotate || 0}deg`,
                '--mf-dx': `${off.x}px`,
                '--mf-dy': `${off.y}px`,
                '--mf-delay': `${delay}s`,
                zIndex: front[i] || 0,
              }}
            >
              <div className="mf__bar-top">
                {chrome === 'dots' ? (
                  <>
                    <button type="button" className="mf__dot mf__dot--close" aria-label={`Close ${it.title || 'window'}`}
                      onClick={() => setShut((s) => new Set(s).add(i))} />
                    <span className="mf__dot mf__dot--min" />
                    <span className="mf__dot mf__dot--max" />
                  </>
                ) : (
                  <button type="button" className="mf__x" aria-label={`Close ${it.title || 'window'}`}
                    onClick={() => setShut((s) => new Set(s).add(i))}>
                    <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3 3 9" /></svg>
                  </button>
                )}
                {it.title && <span className="mf__title">{it.title}</span>}
              </div>
              {kind === 'audio' ? (
                <AudioBody item={it} colours={colours} playing={out} />
              ) : (
                <div className={`mf__media${it.checker ? ' has-checker' : ''}`} style={it.ratio ? { aspectRatio: it.ratio } : undefined}>
                  {kind === 'video' ? (
                    <video src={it.src} poster={it.poster} muted={!it.sound} loop playsInline preload="none" />
                  ) : (
                    <img src={it.src} alt={it.alt ?? it.title ?? ''} draggable={false} decoding="async" />
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <button
        ref={folderRef}
        type="button"
        className={`mf__folder${hover ? ' is-hover' : ''}`}
        aria-expanded={open}
        aria-label={`${label}, ${list.length} items`}
        onPointerEnter={onFolderEnter}
        onPointerLeave={() => setHover(false)}
        {...folderEvents}
      >
        <span className="mf__glow" aria-hidden="true" />
        <Folder colours={colours} peek={open ? [] : peekItems} hover={hover} />
        <span className="mf__label">{label}</span>
      </button>
    </div>
  )
}
