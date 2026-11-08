/**
 * The printed faces of the ticket, drawn on canvas: paper with a little
 * fibre in it, security guilloche, type, and the perforation — each side
 * carries half of every hole, so the two halves meet as a row of holes and
 * part as two bitten edges.
 *
 * Original design. Fonts: Instrument Serif, Inter, IBM Plex Mono (all OFL).
 */

const serif = (size, italic = false) => `${italic ? 'italic ' : ''}400 ${size}px 'Instrument Serif', Georgia, serif`
const sans = (weight, size) => `${weight} ${size}px Inter, system-ui, sans-serif`
const mono = (weight, size) => `${weight} ${size}px 'IBM Plex Mono', ui-monospace, monospace`

/* Deterministic randomness so the paper fibre is the same every render. */
function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

function paper(g, w, h, colour, seed) {
  g.fillStyle = colour
  g.fillRect(0, 0, w, h)
  const rand = rng(seed)
  /* Fibre: short faint strokes, light and dark. */
  for (let i = 0; i < (w * h) / 60; i++) {
    const x = rand() * w
    const y = rand() * h
    const a = rand() * Math.PI
    const l = 2 + rand() * 6
    g.strokeStyle = rand() < 0.5 ? 'rgba(255,255,255,0.35)' : 'rgba(90,70,40,0.07)'
    g.lineWidth = 0.6
    g.beginPath()
    g.moveTo(x, y)
    g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l)
    g.stroke()
  }
}

/* Fine interference lines, the kind printed on banknotes and tickets. */
function guilloche(g, x, y, w, h, colour) {
  g.save()
  g.beginPath()
  g.rect(x, y, w, h)
  g.clip()
  g.strokeStyle = colour
  g.lineWidth = 0.6
  for (let k = 0; k < 14; k++) {
    g.beginPath()
    for (let i = 0; i <= w; i += 2) {
      const t = i / w
      const yy = y + h / 2 + Math.sin(t * Math.PI * 9 + k * 0.45) * h * 0.32 * Math.cos(t * Math.PI * 2 + k * 0.2) + Math.sin(t * 40 + k) * 1.2
      if (i === 0) g.moveTo(x + i, yy)
      else g.lineTo(x + i, yy)
    }
    g.stroke()
  }
  g.restore()
}

/* Cut half-holes along an edge, and a hair of torn fibre round each. */
function perforate(g, x, h, side, hole, pitch) {
  g.save()
  g.globalCompositeOperation = 'destination-out'
  for (let y = pitch / 2; y < h; y += pitch) {
    g.beginPath()
    g.arc(x, y, hole, 0, Math.PI * 2)
    g.fill()
  }
  g.restore()
  const rand = rng(91 + side)
  g.strokeStyle = 'rgba(255,255,255,0.55)'
  g.lineWidth = 0.5
  for (let y = 0; y < h; y += 0.9) {
    const l = rand() * 1.6
    g.beginPath()
    g.moveTo(x, y)
    g.lineTo(x + side * l, y + (rand() - 0.5))
    g.stroke()
  }
}

function roundClip(g, w, h, r, left, right) {
  g.beginPath()
  g.moveTo(left ? r : 0, 0)
  g.lineTo(right ? w - r : w, 0)
  if (right) g.arcTo(w, 0, w, r, r)
  g.lineTo(w, right ? h - r : h)
  if (right) g.arcTo(w, h, w - r, h, r)
  g.lineTo(left ? r : 0, h)
  if (left) g.arcTo(0, h, 0, h - r, r)
  g.lineTo(0, left ? r : 0)
  if (left) g.arcTo(0, 0, r, 0, r)
  g.closePath()
  g.clip()
}

function barcode(g, x, y, w, h, seed, colour) {
  const rand = rng(seed)
  g.fillStyle = colour
  let cx = x
  while (cx < x + w - 2) {
    const bw = 0.8 + Math.floor(rand() * 3) * 0.8
    g.fillRect(cx, y, bw, h)
    cx += bw + 0.8 + Math.floor(rand() * 2) * 0.8
  }
}

/**
 * Draws both faces. `t` is the ticket content, `c` the colours, sizes in CSS
 * px; `scale` is the texture's pixels per CSS px.
 */
export function drawFaces(t, c, size, scale) {
  const { mainW, stubW, h, radius, hole, pitch } = size
  const make = (w) => {
    const cv = document.createElement('canvas')
    cv.width = Math.round(w * scale)
    cv.height = Math.round(h * scale)
    const g = cv.getContext('2d')
    g.scale(scale, scale)
    return { cv, g }
  }

  /* --- main ------------------------------------------------------------ */
  const m = make(mainW)
  let g = m.g
  g.save()
  roundClip(g, mainW, h, radius, true, false)
  paper(g, mainW, h, c.paper, 7)
  guilloche(g, 0, h - 54, mainW, 46, c.guilloche)
  g.fillStyle = c.accent
  g.fillRect(0, 0, 5, h)

  g.fillStyle = c.muted
  g.font = sans(600, 9.5)
  g.letterSpacing = '0.16em'
  g.fillText(t.operator.toUpperCase(), 26, 32)
  g.letterSpacing = '0px'
  g.fillStyle = c.accent
  g.font = mono(600, 10)
  g.textAlign = 'right'
  g.fillText(t.serial, mainW - 22, 32)
  g.textAlign = 'left'

  g.fillStyle = c.ink
  g.font = serif(44)
  g.fillText(t.from, 24, 82)
  const fw = g.measureText(t.from).width
  g.font = serif(26, true)
  g.fillStyle = c.muted
  g.fillText('to', 24 + fw + 12, 80)
  const tw = g.measureText('to').width
  g.fillStyle = c.ink
  g.font = serif(44)
  g.fillText(t.to, 24 + fw + 12 + tw + 12, 82)

  g.font = mono(400, 10.5)
  g.fillStyle = c.muted
  g.fillText(t.depart, 26, 102)
  g.textAlign = 'right'
  g.fillText(t.arrive, mainW - 22, 102)
  g.textAlign = 'left'

  let x = 26
  for (const [label, value] of t.fields) {
    g.font = sans(600, 8.5)
    g.fillStyle = c.muted
    g.letterSpacing = '0.14em'
    g.fillText(label.toUpperCase(), x, 132)
    g.letterSpacing = '0px'
    g.font = sans(500, 15)
    g.fillStyle = c.ink
    g.fillText(value, x, 152)
    x += Math.max(g.measureText(value).width, 44) + 30
  }
  g.restore()
  perforate(g, mainW, h, -1, hole, pitch)

  /* --- stub ------------------------------------------------------------ */
  const s = make(stubW)
  g = s.g
  g.save()
  roundClip(g, stubW, h, radius, false, true)
  paper(g, stubW, h, c.paper, 13)
  g.fillStyle = c.accent
  g.fillRect(0, 0, stubW, 44)
  g.fillStyle = c.paper
  g.font = sans(700, 9)
  g.letterSpacing = '0.22em'
  g.textAlign = 'center'
  g.fillText(t.stubBanner.toUpperCase(), stubW / 2, 27)
  g.letterSpacing = '0.16em'
  g.fillStyle = c.muted
  g.font = sans(600, 8.5)
  g.fillText(t.stubLabel.toUpperCase(), stubW / 2, 72)
  g.letterSpacing = '0px'
  g.fillStyle = c.ink
  g.font = serif(56)
  g.fillText(t.stubValue, stubW / 2, 118)
  g.font = mono(400, 9.5)
  g.fillStyle = c.muted
  g.fillText(t.stubNote, stubW / 2, 140)
  barcode(g, 18, h - 46, stubW - 36, 26, 5, c.ink)
  g.font = mono(400, 7.5)
  g.fillText(t.serial, stubW / 2, h - 10)
  g.textAlign = 'left'
  g.restore()
  perforate(g, 0, h, 1, hole, pitch)

  return { main: m.cv, stub: s.cv }
}
