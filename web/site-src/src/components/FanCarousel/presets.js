/**
 * Colour presets for <FanCarousel />.
 *
 * The cards are photographs, so a preset is the room they hang in: the
 * backdrop, the scrim that keeps a title legible over a bright image, and the
 * page indicators. `pill` is the default tag colour - an item can override it
 * with its own `accent`.
 */
export const presets = {
  midnight: {
    background: '#000000',
    scrim: 'linear-gradient(180deg, rgba(6, 8, 14, 0.62) 0%, rgba(6, 8, 14, 0.16) 34%, rgba(6, 8, 14, 0) 58%)',
    title: '#ffffff',
    subtitle: 'rgba(255, 255, 255, 0.7)',
    pill: 'rgba(255, 255, 255, 0.18)',
    pillText: '#ffffff',
    dot: 'rgba(255, 255, 255, 0.4)',
    dotActive: '#ffffff',
    shadow: 'rgba(0, 0, 0, 0.55)',
  },

  gallery: {
    background: '#f4f5f7',
    scrim: 'linear-gradient(180deg, rgba(10, 12, 18, 0.55) 0%, rgba(10, 12, 18, 0.12) 36%, rgba(10, 12, 18, 0) 60%)',
    title: '#ffffff',
    subtitle: 'rgba(255, 255, 255, 0.72)',
    pill: 'rgba(255, 255, 255, 0.22)',
    pillText: '#ffffff',
    dot: 'rgba(18, 22, 32, 0.28)',
    dotActive: '#12161f',
    shadow: 'rgba(20, 24, 36, 0.28)',
  },

  ink: {
    background: 'radial-gradient(120% 120% at 50% 0%, #1d2230 0%, #0d1017 56%, #05070c 100%)',
    scrim: 'linear-gradient(180deg, rgba(4, 6, 12, 0.66) 0%, rgba(4, 6, 12, 0.18) 34%, rgba(4, 6, 12, 0) 58%)',
    title: '#ffffff',
    subtitle: 'rgba(255, 255, 255, 0.68)',
    pill: 'rgba(255, 255, 255, 0.16)',
    pillText: '#ffffff',
    dot: 'rgba(255, 255, 255, 0.32)',
    dotActive: '#ffffff',
    shadow: 'rgba(0, 0, 0, 0.6)',
  },

  bone: {
    background: 'linear-gradient(180deg, #f7f3ec 0%, #e8e0d4 100%)',
    scrim: 'linear-gradient(180deg, rgba(40, 30, 20, 0.5) 0%, rgba(40, 30, 20, 0.1) 36%, rgba(40, 30, 20, 0) 60%)',
    title: '#ffffff',
    subtitle: 'rgba(255, 255, 255, 0.75)',
    pill: 'rgba(255, 255, 255, 0.24)',
    pillText: '#ffffff',
    dot: 'rgba(60, 44, 30, 0.3)',
    dotActive: '#3c2c1e',
    shadow: 'rgba(84, 62, 38, 0.3)',
  },
}

export default presets
