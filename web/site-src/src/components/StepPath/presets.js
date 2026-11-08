/**
 * Colour presets for <StepPath />. `line` is the dashed path at full
 * strength — it rests at `restOpacity` and only the travelling stretch
 * shows it solid.
 */
export const presets = {
  paper: {
    background: '#ffffff',
    title: '#111315',
    number: '#737373',
    text: '#8c8c8c',
    line: '#111315',
    dot: '#111214',
  },

  night: {
    background: '#0c0d10',
    title: '#f4f4f5',
    number: '#7d7f86',
    text: '#8e9098',
    line: '#e8e9ec',
    dot: '#f4f4f5',
  },

  signal: {
    background: '#f3f1ea',
    title: '#1d2a22',
    number: '#5f8a6c',
    text: '#6f7a72',
    line: '#2f6b45',
    dot: '#2f6b45',
  },
}

export default presets
