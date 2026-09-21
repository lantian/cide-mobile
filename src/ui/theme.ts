/** The few colours everything shares. Dark only, for now: this is read in bed. */
export const T = {
  bg: '#0d1117',
  panel: '#161b22',
  border: '#30363d',
  text: '#c9d1d9',
  dim: '#8b949e',
  accent: '#6db3ff',
  good: '#5ee08a',
  warn: '#ffd166',
  bad: '#ff6b6b',
} as const

/** What a session's state should look like in a list. */
export function stateColour(state: string): string {
  switch (state) {
    case 'busy':
      return T.accent
    case 'awaitingInput':
    case 'awaitingPermission':
      return T.warn
    case 'exited':
      return T.dim
    case 'paused':
      return T.bad
    default:
      return T.dim
  }
}

/** And what to call it. cide's own words, shortened for a narrow row. */
export function stateLabel(state: string): string {
  switch (state) {
    case 'awaitingInput':
      return 'waiting for you'
    case 'awaitingPermission':
      return 'asking permission'
    case 'busy':
      return 'working'
    case 'idle':
      return 'idle'
    case 'paused':
      return 'paused'
    case 'exited':
      return 'exited'
    case 'splash':
    case 'spawning':
      // **Nothing**, deliberately. Both arms mean *this session has said nothing yet*, which is
      // a moment for a Claude console and the resting state for a shell: cide learns a state
      // from a hook, a shell fires none, and its jobs watcher stays quiet until a foreground
      // job has held the terminal for two minutes. So a console somebody opened and left at its
      // prompt read `starting` for the rest of its life. An empty label is the honest answer —
      // the row still says what kind of console it is and which project it belongs to — and
      // `idle` would be a claim cide has not made.
      return ''
    default:
      return state
  }
}
