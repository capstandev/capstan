/**
 * The stub, as a sheet of paper: a grid of particles held together by
 * position-based constraints, and held to the ticket by its perforation.
 *
 *   stretch  between neighbours — paper barely stretches, so these are stiff
 *   shear    across each cell's diagonals
 *   bend     between every other particle, and long ties across three or
 *            four cells — card curls a little but swings as a whole
 *
 * The first column is the perforation. Each of its particles is pinned in
 * place by a joint; a joint breaks when the paper next to it is pulled
 * further than paper will give. Pull from a corner and the joints near it
 * go first and the tear runs down the line, one hole at a time. Let go half
 * way and the stub hangs by what is left.
 *
 * Units are CSS pixels; y points down the page, z out of it.
 */

export function createPaper({ x0, y0, w, h, nx, ny }) {
  const N = nx * ny
  const pos = new Float32Array(N * 3)
  const prev = new Float32Array(N * 3)
  const rest = new Float32Array(N * 3)
  const inv = new Float32Array(N)
  const uv = new Float32Array(N * 2)
  const normals = new Float32Array(N * 3)
  const joint = new Uint8Array(ny)
  const id = (i, j) => j * nx + i

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = id(i, j)
      rest[k * 3] = x0 + (w * i) / (nx - 1)
      rest[k * 3 + 1] = y0 + (h * j) / (ny - 1)
      uv[k * 2] = i / (nx - 1)
      uv[k * 2 + 1] = j / (ny - 1)
    }
  }

  /* Constraints: pairs, rest lengths, stiffness. */
  const pairs = []
  const add = (a, b, k) => pairs.push([a, b, k])
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (i + 1 < nx) add(id(i, j), id(i + 1, j), 1)
      if (j + 1 < ny) add(id(i, j), id(i, j + 1), 1)
      if (i + 1 < nx && j + 1 < ny) {
        add(id(i, j), id(i + 1, j + 1), 1)
        add(id(i + 1, j), id(i, j + 1), 1)
      }
      /* Card stock: bends, but resists it. */
      if (i + 2 < nx) add(id(i, j), id(i + 2, j), 0.7)
      if (j + 2 < ny) add(id(i, j), id(i, j + 2), 0.7)
      /* Long-range ties: card does not crumple in the hand, it swings
         as a whole and curls a little. */
      if (i + 3 < nx && j + 3 < ny) {
        add(id(i, j), id(i + 3, j + 3), 0.35)
        add(id(i + 3, j), id(i, j + 3), 0.35)
      }
      if (i + 4 < nx) add(id(i, j), id(i + 4, j), 0.35)
      if (j + 4 < ny) add(id(i, j), id(i, j + 4), 0.35)
    }
  }
  const C = pairs.length
  const ca = new Int32Array(C)
  const cb = new Int32Array(C)
  const ck = new Float32Array(C)
  const cl = new Float32Array(C)
  pairs.forEach(([a, b, k], c) => {
    ca[c] = a
    cb[c] = b
    ck[c] = k
    cl[c] = Math.hypot(rest[a * 3] - rest[b * 3], rest[a * 3 + 1] - rest[b * 3 + 1])
  })


  /* Triangles for drawing. */
  const tris = []
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = id(i, j)
      const b = id(i + 1, j)
      const c = id(i, j + 1)
      const d = id(i + 1, j + 1)
      tris.push(a, c, b, b, c, d)
    }
  }
  const index = new Uint16Array(tris)

  const state = { grabbed: -1, gx: 0, gy: 0, gz: 0, torn: 0, free: false, cool: 0 }

  function reset() {
    pos.set(rest)
    prev.set(rest)
    for (let j = 0; j < ny; j++) {
      joint[j] = 1
      for (let i = 0; i < nx; i++) inv[id(i, j)] = i === 0 ? 0 : 1
    }
    state.grabbed = -1
    state.torn = 0
    state.free = false
    state.cool = 0
  }
  reset()


  /**
   * One substep. `opt`: { gravity, drag, flutter, tearStrain, iterations }.
   */
  function step(dt, opt) {
    /* Predict. While it lies on the page the page carries its weight; once
       free, gravity takes it down the page. */
    const gravity = state.free ? opt.gravity : 0
    for (let k = 0; k < N; k++) {
      if (inv[k] === 0) continue
      const o = k * 3
      const vx = (pos[o] - prev[o]) * (1 - opt.drag)
      const vy = (pos[o + 1] - prev[o + 1]) * (1 - opt.drag)
      const vz = (pos[o + 2] - prev[o + 2]) * (1 - opt.drag)
      prev[o] = pos[o]
      prev[o + 1] = pos[o + 1]
      prev[o + 2] = pos[o + 2]
      pos[o] += vx
      pos[o + 1] += vy + gravity * dt * dt
      /* Lifted paper that is still attached settles back onto the page. */
      pos[o + 2] += vz - (state.free ? 0 : opt.gravity * 0.35 * dt * dt)
    }

    /* Falling paper flutters: air pushes on each face along its normal. */
    if (state.free && opt.flutter > 0) {
      for (let t = 0; t < index.length; t += 3) {
        const a = index[t] * 3
        const b = index[t + 1] * 3
        const c = index[t + 2] * 3
        const ux = pos[b] - pos[a]
        const uy = pos[b + 1] - pos[a + 1]
        const uz = pos[b + 2] - pos[a + 2]
        const vx = pos[c] - pos[a]
        const vy = pos[c + 1] - pos[a + 1]
        const vz = pos[c + 2] - pos[a + 2]
        let nx2 = uy * vz - uz * vy
        let ny2 = uz * vx - ux * vz
        let nz2 = ux * vy - uy * vx
        const area = Math.hypot(nx2, ny2, nz2) || 1
        nx2 /= area
        ny2 /= area
        nz2 /= area
        const wx = -((pos[a] - prev[a]) + (pos[b] - prev[b]) + (pos[c] - prev[c])) / 3
        const wy = -((pos[a + 1] - prev[a + 1]) + (pos[b + 1] - prev[b + 1]) + (pos[c + 1] - prev[c + 1])) / 3
        const wz = -((pos[a + 2] - prev[a + 2]) + (pos[b + 2] - prev[b + 2]) + (pos[c + 2] - prev[c + 2])) / 3
        const push = (wx * nx2 + wy * ny2 + wz * nz2) * opt.flutter
        for (const p of [a, b, c]) {
          pos[p] += nx2 * push
          pos[p + 1] += ny2 * push
          pos[p + 2] += nz2 * push
        }
      }
    }

    for (let it = 0; it < opt.iterations; it++) {
      if (state.grabbed >= 0) {
        const g = state.grabbed * 3
        pos[g] = state.gx
        pos[g + 1] = state.gy
        pos[g + 2] = state.gz
      }
      for (let c = 0; c < C; c++) {
        const a = ca[c]
        const b = cb[c]
        const wa = a === state.grabbed ? 0 : inv[a]
        const wb = b === state.grabbed ? 0 : inv[b]
        const w = wa + wb
        if (w === 0) continue
        const ao = a * 3
        const bo = b * 3
        const dx = pos[bo] - pos[ao]
        const dy = pos[bo + 1] - pos[ao + 1]
        const dz = pos[bo + 2] - pos[ao + 2]
        const d = Math.hypot(dx, dy, dz) || 1e-6
        const f = (((d - cl[c]) / d) * ck[c]) / w
        pos[ao] += dx * f * wa
        pos[ao + 1] += dy * f * wa
        pos[ao + 2] += dz * f * wa
        pos[bo] -= dx * f * wb
        pos[bo + 1] -= dy * f * wb
        pos[bo + 2] -= dz * f * wb
      }
      /* Still attached: the page is a floor. */
      if (!state.free) {
        for (let k = 0; k < N; k++) if (pos[k * 3 + 2] < 0) pos[k * 3 + 2] = 0
      }
    }

    /* Joints: the most strained one gives first; tearing is one hole at a
       time, which is what makes it run down the line instead of popping. */
    state.cool -= dt
    if (!state.free && state.cool <= 0) {
      /* A hole gives when the paper beside it has been dragged further
         from it than paper will stretch: measured as how far that
         neighbour sits from where it was printed. */
      let worst = -1
      let worstS = opt.tearGap
      for (let j = 0; j < ny; j++) {
        if (!joint[j]) continue
        const k = id(1, j) * 3
        const s = Math.hypot(pos[k] - rest[k], pos[k + 1] - rest[k + 1], pos[k + 2] - rest[k + 2])
        if (s > worstS) {
          worstS = s
          worst = j
        }
      }
      if (worst >= 0) {
        joint[worst] = 0
        inv[id(0, worst)] = 1
        state.torn++
        state.cool = opt.tearDelay
        if (state.torn === ny) state.free = true
      }
    }
  }

  function computeNormals() {
    normals.fill(0)
    for (let t = 0; t < index.length; t += 3) {
      const a = index[t] * 3
      const b = index[t + 1] * 3
      const c = index[t + 2] * 3
      const ux = pos[b] - pos[a]
      const uy = pos[b + 1] - pos[a + 1]
      const uz = pos[b + 2] - pos[a + 2]
      const vx = pos[c] - pos[a]
      const vy = pos[c + 1] - pos[a + 1]
      const vz = pos[c + 2] - pos[a + 2]
      /* v × u: the triangles wind so that this faces out of the page. */
      const nx2 = vy * uz - vz * uy
      const ny2 = vz * ux - vx * uz
      const nz2 = vx * uy - vy * ux
      for (const p of [a, b, c]) {
        normals[p] += nx2
        normals[p + 1] += ny2
        normals[p + 2] += nz2
      }
    }
  }

  /** Nearest particle to (x, y) within r px, or -1. */
  function pick(x, y, r) {
    let best = -1
    let bestD = r * r
    for (let k = 0; k < N; k++) {
      const d = (pos[k * 3] - x) ** 2 + (pos[k * 3 + 1] - y) ** 2
      if (d < bestD) {
        bestD = d
        best = k
      }
    }
    return best
  }

  /** Is (x, y) over the sheet? Tested against its cells. */
  function contains(x, y) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const q = [id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1)]
        let inside = false
        for (let a = 0, b = 3; a < 4; b = a++) {
          const ax = pos[q[a] * 3]
          const ay = pos[q[a] * 3 + 1]
          const bx = pos[q[b] * 3]
          const by = pos[q[b] * 3 + 1]
          if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside
        }
        if (inside) return true
      }
    }
    return false
  }

  return {
    N,
    nx,
    ny,
    pos,
    uv,
    normals,
    index,
    joint,
    state,
    reset,
    step,
    computeNormals,
    pick,
    contains,
    grab(k, x, y, z) {
      /* The perforation itself cannot be dragged off its joint. */
      if (k >= 0 && k % nx === 0 && inv[k] === 0) k += 1
      state.grabbed = k
      state.gx = x
      state.gy = y
      state.gz = z
    },
    release() {
      state.grabbed = -1
    },
    /** Lowest point of the sheet, px. */
    bottom() {
      let m = -Infinity
      for (let k = 0; k < N; k++) m = Math.max(m, pos[k * 3 + 1])
      return m
    },
  }
}
