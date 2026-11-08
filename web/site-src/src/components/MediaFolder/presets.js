/**
 * Colour presets for <MediaFolder />.
 *
 * `folder` is the front panel's base; `folderLight` the top of its gradient
 * and `folderBack` / `folderShade` the panel behind, darker so the front
 * reads as nearer. Windows are frosted glass over the page (`window` is the
 * tint), so a preset also has to suit what shows through them.
 */
export const presets = {
  sky: {
    background: '#e2edfb',
    label: '#1d1d1f',
    highlight: 'rgba(0, 43, 161, 0.06)',
    folder: '#3f8cff',
    folderLight: '#a6ccff',
    folderBack: '#3b8af2',
    folderShade: '#1f4f9e',
    window: 'rgba(255, 255, 255, 0.62)',
    windowText: '#2b2b2b',
    checker: 'rgba(0, 0, 0, 0.06)',
    shadow: 'rgba(0, 0, 0, 0.09)',
    accent: '#2f6fe4',
  },

  graphite: {
    background: '#141519',
    label: '#ececf0',
    highlight: 'rgba(255, 255, 255, 0.06)',
    folder: '#5b6170',
    folderLight: '#9aa1b2',
    folderBack: '#4a4f5c',
    folderShade: '#24272f',
    window: 'rgba(38, 40, 48, 0.72)',
    windowText: '#ececf0',
    checker: 'rgba(255, 255, 255, 0.06)',
    shadow: 'rgba(0, 0, 0, 0.4)',
    accent: '#8fb4ff',
  },

  peach: {
    background: '#fbeee6',
    label: '#3a2418',
    highlight: 'rgba(160, 70, 20, 0.07)',
    folder: '#ff8a4c',
    folderLight: '#ffc59e',
    folderBack: '#f07a3e',
    folderShade: '#a3461b',
    window: 'rgba(255, 252, 249, 0.66)',
    windowText: '#3a2418',
    checker: 'rgba(80, 30, 0, 0.06)',
    shadow: 'rgba(90, 40, 10, 0.1)',
    accent: '#e5642a',
  },

  sage: {
    background: '#e7efe6',
    label: '#1d2a1f',
    highlight: 'rgba(30, 90, 40, 0.07)',
    folder: '#5fae72',
    folderLight: '#b5e0bf',
    folderBack: '#54a066',
    folderShade: '#2b5c37',
    window: 'rgba(252, 255, 252, 0.64)',
    windowText: '#1d2a1f',
    checker: 'rgba(0, 40, 0, 0.06)',
    shadow: 'rgba(20, 50, 25, 0.1)',
    accent: '#3c8f52',
  },
}

export default presets
