/**
 * Colour presets for <ClothesLine />.
 *
 * `peg`, `binder`/`wire` and `tape` colour the three clip styles; only the
 * chosen one shows. `shadow` is used for both the rope's and the cards'.
 */
export const presets = {
  linen: {
    background: '#fbfaf7',
    rope: '#9a7b5a',
    ropeLight: '#c9ad8a',
    card: '#ece7e0',
    peg: '#c98a5b',
    binder: '#1b1b1d',
    wire: '#9aa0a6',
    tape: 'rgba(240, 232, 205, 0.82)',
    shadow: 'rgba(40, 30, 20, 0.18)',
  },

  atelier: {
    background: '#151413',
    rope: '#d9cdbd',
    ropeLight: '#fff4e4',
    card: '#262421',
    peg: '#e0a36f',
    binder: '#e9e6e1',
    wire: '#8a8f94',
    tape: 'rgba(255, 250, 235, 0.55)',
    shadow: 'rgba(0, 0, 0, 0.5)',
  },

  pastel: {
    background: '#f3eefc',
    rope: '#8b7bb8',
    ropeLight: '#c5b8ec',
    card: '#e4dcf5',
    peg: '#f2a7c3',
    binder: '#4b3d7a',
    wire: '#b8b2cc',
    tape: 'rgba(255, 240, 160, 0.75)',
    shadow: 'rgba(60, 40, 110, 0.18)',
  },
}

export default presets
