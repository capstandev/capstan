/**
 * The ink, as physics. Everything is in CSS pixels, relative to the
 * component's top-left corner.
 *
 *   body     the button itself: a pill on a spring, so it is tugged towards
 *            whatever is pulling on it and wobbles when let go
 *   blob     a bead of ink on the pointer, picked up by touching the button
 *   strands  verlet chains pinned between the body and the blob. Each holds
 *            a fixed volume of ink, so it thins as it stretches; past its own
 *            breaking length it snaps at its thinnest point, and the two
 *            halves reel back into whatever they are still attached to
 *   drops    beads that fall off the blob once it is carrying too much
 */

const K = 12
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

/* Pill outline: point at perimeter parameter u (px), clockwise from the left
   end of the top edge. */
function outline(hw, hh, u) {
  const r = hh
  const flat = Math.max(0, 2 * (hw - r))
  const arc = Math.PI * r
  const P = 2 * flat + 2 * arc
  let s = ((u % P) + P) % P
  if (s < flat) return { x: -hw + r + s, y: -r, nx: 0, ny: -1 }
  s -= flat
  if (s < arc) {
    const a = -Math.PI / 2 + s / r
    return { x: hw - r + Math.cos(a) * r, y: Math.sin(a) * r, nx: Math.cos(a), ny: Math.sin(a) }
  }
  s -= arc
  if (s < flat) return { x: hw - r - s, y: r, nx: 0, ny: 1 }
  s -= flat
  const a = Math.PI / 2 + s / r
  return { x: -hw + r + Math.cos(a) * r, y: Math.sin(a) * r, nx: Math.cos(a), ny: Math.sin(a) }
}

/* Perimeter parameter of the outline point nearest p (relative to centre). */
function nearestU(hw, hh, px, py) {
  let best = 0
  let bestD = Infinity
  const r = hh
  const P = 2 * Math.max(0, 2 * (hw - r)) + 2 * Math.PI * r
  for (let i = 0; i < 96; i++) {
    const u = (i / 96) * P
    const o = outline(hw, hh, u)
    const d = (o.x - px) ** 2 + (o.y - py) ** 2
    if (d < bestD) {
      bestD = d
      best = u
    }
  }
  return best
}

/* Signed distance to the pill, relative to its centre. */
export function pillDistance(hw, hh, x, y) {
  return Math.hypot(Math.max(Math.abs(x) - (hw - hh), 0), y) - hh
}

function chain(ax, ay, bx, by) {
  const x = new Float32Array(K)
  const y = new Float32Array(K)
  for (let i = 0; i < K; i++) {
    const t = i / (K - 1)
    x[i] = ax + (bx - ax) * t
    y[i] = ay + (by - ay) * t
  }
  return { x, y, px: Float32Array.from(x), py: Float32Array.from(y), n: K }
}

export function createSim() {
  const s = {
    body: { ox: 0, oy: 0, vx: 0, vy: 0, squash: 0, sv: 0 },
    blob: { x: 0, y: 0, vol: 0, vx: 0, vy: 0 },
    strands: [],
    drops: [],
    contact: false,
    inked: false,
    lastX: 0,
    lastY: 0,
  }

  const blobR = () => Math.sqrt(Math.max(0, s.blob.vol) / Math.PI)

  function spawnStrands(geo, opt, px, py) {
    const u0 = nearestU(geo.hw, geo.hh, px - geo.cx, py - geo.cy)
    const n = opt.strands
    for (let i = 0; i < n; i++) {
      const spread = n === 1 ? 0 : (i / (n - 1) - 0.5) * 2
      const u = u0 + spread * opt.spread + (Math.random() - 0.5) * 10
      const o = outline(geo.hw, geo.hh, u)
      const ax = geo.cx + s.body.ox + o.x
      const ay = geo.cy + s.body.oy + o.y
      const ang = Math.random() * Math.PI * 2
      const rad = Math.random() * blobR() * 0.55
      const c = chain(ax, ay, px, py)
      s.strands.push({
        ...c,
        u,
        tipX: Math.cos(ang) * rad,
        tipY: Math.sin(ang) * rad,
        vol: opt.volume * (0.2 + Math.random() * Math.random() * 1.4),
        breakAt: opt.reach * (0.55 + Math.random() * 0.75),
        mode: 'held',
        rest: 1,
        r: new Float32Array(c.n),
      })
    }
  }

  /* Split a held strand at its thinnest point. */
  function snap(st) {
    const m = clamp(Math.floor(st.n / 2 + (Math.random() - 0.5) * 4), 2, st.n - 3)
    const sliceTo = (from, to) => ({
      x: st.x.slice(from, to),
      y: st.y.slice(from, to),
      px: st.px.slice(from, to),
      py: st.py.slice(from, to),
      n: to - from,
    })
    const share = m / (st.n - 1)
    const back = { ...sliceTo(0, m + 1), u: st.u, vol: st.vol * share, mode: 'retract', rest: 1, r: new Float32Array(m + 1) }
    const front = { ...sliceTo(m, st.n), tipX: st.tipX, tipY: st.tipY, vol: st.vol * (1 - share), mode: 'drip', rest: 1, r: new Float32Array(st.n - m) }
    return [back, front]
  }

  function length(st) {
    let L = 0
    for (let i = 1; i < st.n; i++) L += Math.hypot(st.x[i] - st.x[i - 1], st.y[i] - st.y[i - 1])
    return L
  }

  /**
   * Advance by dt seconds.
   * `geo`: the button at rest { cx, cy, hw, hh }; `ptr`: { x, y, active }.
   */
  function step(dt, geo, ptr, opt) {
    const b = s.body
    const rel = { x: ptr.x - geo.cx - b.ox, y: ptr.y - geo.cy - b.oy }
    const inside = ptr.active && pillDistance(geo.hw, geo.hh, rel.x, rel.y) < 1
    const vx = (ptr.x - s.lastX) / Math.max(dt, 1e-3)
    const vy = (ptr.y - s.lastY) / Math.max(dt, 1e-3)
    s.lastX = ptr.x
    s.lastY = ptr.y

    /* Touching the button loads the pointer with ink. Leaving it draws
       strands out after it. */
    if (inside) {
      s.inked = true
      s.blob.vol += (opt.blobVolume - s.blob.vol) * (1 - Math.exp(-dt * 6))
      for (const st of s.strands) if (st.mode === 'held') st.mode = 'retract'
    } else if (s.contact && ptr.active && s.inked) {
      spawnStrands(geo, opt, ptr.x, ptr.y)
    }
    s.contact = inside
    s.blob.x = ptr.x
    s.blob.y = ptr.y
    s.blob.vx = vx
    s.blob.vy = vy
    if (!ptr.active) for (const st of s.strands) if (st.mode === 'held') st.mode = 'retract'

    /* --- strands -------------------------------------------------------- */
    let pullX = 0
    let pullY = 0
    const born = []
    s.strands = s.strands.filter((st) => {
      const anchorOf = () => {
        const o = outline(geo.hw, geo.hh, st.u)
        return [geo.cx + b.ox + o.x, geo.cy + b.oy + o.y]
      }
      const L = length(st)
      if (st.mode === 'held' && L > st.breakAt) {
        born.push(...snap(st))
        b.sv += 2.2
        return false
      }
      let restLen
      if (st.mode === 'held') {
        const [ax, ay] = anchorOf()
        const span = Math.hypot(ptr.x + st.tipX - ax, ptr.y + st.tipY - ay)
        /* A little slack, so the strand sags under its own weight. */
        restLen = (span * 1.05) / (st.n - 1)
        const k = Math.min(1, span / 260)
        pullX += ((ptr.x - ax) / (span || 1)) * k
        pullY += ((ptr.y - ay) / (span || 1)) * k
      } else {
        /* Reel in: fast at first, like elastic letting go. */
        st.rest *= Math.exp(-dt * (st.mode === 'retract' ? 11 : 7))
        restLen = (L / (st.n - 1)) * st.rest + 0.05
        if (st.rest < 0.04) {
          if (st.mode === 'drip') s.blob.vol += st.vol * 0.25
          else b.sv += 1.2
          return false
        }
      }

      /* Verlet, then length constraints with the ends pinned. */
      const g = opt.gravity * dt * dt
      for (let i = 0; i < st.n; i++) {
        const nx = st.x[i] + (st.x[i] - st.px[i]) * 0.97
        const ny = st.y[i] + (st.y[i] - st.py[i]) * 0.97 + g
        st.px[i] = st.x[i]
        st.py[i] = st.y[i]
        st.x[i] = nx
        st.y[i] = ny
      }
      for (let it = 0; it < 10; it++) {
        if (st.mode !== 'drip') {
          const [ax, ay] = anchorOf()
          st.x[0] = ax
          st.y[0] = ay
        }
        if (st.mode !== 'retract') {
          st.x[st.n - 1] = ptr.x + st.tipX
          st.y[st.n - 1] = ptr.y + st.tipY
        }
        for (let i = 0; i < st.n - 1; i++) {
          const dx = st.x[i + 1] - st.x[i]
          const dy = st.y[i + 1] - st.y[i]
          const d = Math.hypot(dx, dy) || 1e-6
          const diff = (d - restLen) / d
          const pinA = (i === 0 && st.mode !== 'drip') ? 1 : 0
          const pinB = (i + 1 === st.n - 1 && st.mode !== 'retract') ? 1 : 0
          const wa = pinA ? 0 : pinB ? 1 : 0.5
          const wb = pinB ? 0 : pinA ? 1 : 0.5
          st.x[i] += dx * diff * wa
          st.y[i] += dy * diff * wa
          st.x[i + 1] -= dx * diff * wb
          st.y[i + 1] -= dy * diff * wb
        }
      }

      /* Radius from volume: a long strand is a thin one. The ends stay
         fat where the ink is still joined to the button and the bead. */
      const Ln = Math.max(4, length(st))
      const base = Math.sqrt(st.vol / (Math.PI * Ln))
      for (let i = 0; i < st.n; i++) {
        const t = i / (st.n - 1)
        const nearBody = st.mode === 'drip' ? 0 : 1 - Math.min(1, t / 0.22)
        const nearTip = st.mode === 'retract' ? 0 : Math.max(0, (t - 0.8) / 0.2)
        st.r[i] = clamp(base * (0.8 + 1.8 * nearBody * nearBody + 0.35 * nearTip), 0.55, 12)
      }
      return true
    })
    s.strands.push(...born)

    /* --- the bead on the pointer: dries, and drips when overloaded ---------- */
    if (!inside) s.blob.vol = Math.max(0, s.blob.vol - dt * opt.dry)
    /* Overloaded, it lets a drop go — at once if it is far too heavy. */
    const heavy = s.blob.vol > opt.blobVolume * 1.5
    if (!inside && (heavy || (s.blob.vol > opt.blobVolume * 0.9 && Math.random() < dt * 1.6))) {
      const r = Math.min(blobR() * 0.6, Math.sqrt(Math.max(0, s.blob.vol - opt.blobVolume * 0.6) / Math.PI))
      if (r > 1.5) {
        s.blob.vol -= Math.PI * r * r
        s.drops.push({ x: ptr.x, y: ptr.y + blobR() * 0.6, vx: vx * 0.25, vy: 60 + Math.max(0, vy * 0.25), r })
      }
    }
    s.blob.vol = Math.min(s.blob.vol, opt.blobVolume * 2)
    if (s.blob.vol < 3 && !s.strands.some((st) => st.mode !== 'retract')) {
      s.blob.vol = 0
      if (!inside) s.inked = false
    }

    for (const d of s.drops) {
      d.vy += opt.gravity * 1.6 * dt
      d.vx *= 1 - dt * 0.8
      d.x += d.vx * dt
      d.y += d.vy * dt
    }
    s.drops = s.drops.filter((d) => d.y < geo.height + 60)

    /* --- the body: tugged by held strands, springy --------------------------- */
    const pull = Math.min(1, Math.hypot(pullX, pullY) / 3)
    const pl = Math.hypot(pullX, pullY) || 1
    const tx = (pullX / pl) * pull * opt.tug
    const ty = (pullY / pl) * pull * opt.tug
    b.vx += ((tx - b.ox) * 160 - b.vx * 12) * dt
    b.vy += ((ty - b.oy) * 160 - b.vy * 12) * dt
    b.ox += b.vx * dt
    b.oy += b.vy * dt
    b.sv += (-b.squash * 260 - b.sv * 9) * dt
    b.squash += b.sv * dt
    b.stretch = pull
    b.dirX = pullX / pl
    b.dirY = pullY / pl
  }

  return {
    state: s,
    step,
    blobRadius: blobR,
    press() {
      s.body.sv -= 3.4
    },
  }
}
