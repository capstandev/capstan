/**
 * Shared geometry helper.
 *
 * A damped spring sampled into a CSS `linear()` easing, so the bounce runs on
 * the compositor with no physics library and no JS per frame.
 *
 * `bounce` 0 is critically damped (no overshoot); 1 overshoots ~25%.
 */
export function springEasing(bounce = 0.75, steps = 40) {
  const zeta = Math.max(0.2, Math.min(1, 1 - 0.6 * bounce))
  const w0 = 6.2 / zeta /* settles by the end of the duration */
  const values = []

  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    let x
    if (zeta >= 0.999) {
      x = 1 - (1 + w0 * t) * Math.exp(-w0 * t)
    } else {
      const wd = w0 * Math.sqrt(1 - zeta * zeta)
      x =
        1 -
        Math.exp(-zeta * w0 * t) *
          (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t))
    }
    values.push(Math.round(x * 1e4) / 1e4)
  }

  values[0] = 0
  values[values.length - 1] = 1
  return `linear(${values.join(', ')})`
}
