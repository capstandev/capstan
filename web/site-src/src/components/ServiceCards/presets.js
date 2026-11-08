/**
 * Colour presets for <ServiceCards />.
 *
 * `accent` is only the fallback — each item usually brings its own, and that
 * is what fills the button on hover. `ctaText` must read on every accent.
 */
export const presets = {
  stone: {
    background: '#f3f3ef',
    card: '#ffffff',
    title: '#111111',
    text: '#55555a',
    muted: '#6e6e73',
    tag: '#f1f1ee',
    badge: '#ffffff',
    accent: '#c6b4ff',
    ctaText: '#111111',
  },

  ink: {
    background: '#0e0f11',
    card: '#17181b',
    title: '#f5f5f6',
    text: '#a9abb2',
    muted: '#8a8c93',
    tag: '#222328',
    badge: '#17181b',
    accent: '#7b61ff',
    ctaText: '#ffffff',
  },

  cream: {
    background: '#f4eee3',
    card: '#fffdf8',
    title: '#2a2219',
    text: '#6b5f50',
    muted: '#8a7b68',
    tag: '#f3ece0',
    badge: '#fffdf8',
    accent: '#f2b38c',
    ctaText: '#2a2219',
  },
}

export default presets
