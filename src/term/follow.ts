/**
 * Whether the viewport follows the output, and what is allowed to change the answer. (M76)
 *
 * The rule every terminal and every chat window has is *follow the output while the reader is at
 * the bottom, and hold still the moment they scroll away* — and all the difficulty is in the word
 * **they**. The first cut read the answer off every scroll event, which is also how a React
 * Native `ScrollView` reports content *arriving*: opening a console asks for two hundred lines of
 * scrollback, they are prepended above the viewport, `contentOffset` does not move because
 * nothing was scrolled, and the next event therefore measures three thousand points between the
 * reader and the end. Nothing had been touched. But the view had already decided it was being
 * read somewhere else, so it stopped following — and a console opened in the middle of its own
 * transcript with the live rows below the fold, which is the one place somebody opening a console
 * never wants to be.
 *
 * So the answer moves on a **gesture** and never on a measurement taken outside one. A drag
 * begins, the place it settles decides, and content that turns up in between is not an opinion
 * about where the reader is. That also makes the programmatic scroll safe: `scrollToEnd` emits
 * scroll events like any other, and under the old rule the view was reasoning about its own
 * corrections.
 *
 * React-free, like every other module under `src/term`, so `test/term.test.ts` can drive the
 * whole of it with no renderer — which matters more here than usual, because every state this
 * describes is a *frame* somebody would have to catch by eye.
 */

/**
 * How close to the bottom still counts as *at the bottom*, in points.
 *
 * Not zero: a fling lands a point or two short of the end often enough that an exact test makes
 * following stop for no reason a reader could see or reproduce.
 */
export const STUCK_WITHIN = 24

export interface Follow {
  /** Should content arriving pull the viewport to the end? */
  readonly stuck: boolean
  /**
   * Is the reader driving — from the start of a drag until its momentum stops?
   *
   * The gate on every measurement. Without it there is no way to tell a reader's scroll from
   * the view's own, and the two arrive through the same callback.
   */
  readonly driving: boolean
}

/** How a console opens: at the end, and following. */
export const FOLLOWING: Follow = { stuck: true, driving: false }

/** Distance from the end, in points, as a scroll event reports it. */
export function remainingOf(event: {
  contentOffset: { y: number }
  contentSize: { height: number }
  layoutMeasurement: { height: number }
}): number {
  return event.contentSize.height - event.layoutMeasurement.height - event.contentOffset.y
}

export function atBottom(remaining: number): boolean {
  return remaining <= STUCK_WITHIN
}

/** A drag began. From here until it settles, where the view sits is the reader's business. */
export function grabbed(follow: Follow): Follow {
  return { stuck: follow.stuck, driving: true }
}

/**
 * A scroll event, read **only** while the reader is driving.
 *
 * Ignored otherwise on purpose: see the header. This is the line that fixes opening a console.
 */
export function moved(follow: Follow, remaining: number): Follow {
  if (!follow.driving) return follow
  return { stuck: atBottom(remaining), driving: true }
}

/** The gesture ended where it ended, and that is the answer. */
export function settled(remaining: number): Follow {
  return { stuck: atBottom(remaining), driving: false }
}

/* --- scrolling a program that owns its own screen ------------------------------------------ */

/**
 * How many lines one edge-drag asks a program to scroll, and how often. (M76)
 *
 * Three lines is a wheel notch on every desktop, so the program moves by an amount its author
 * already tuned for. The interval is what turns a held finger into steady motion without asking
 * a full-screen program to redraw sixty times a second — each notch is a repaint, sent over a
 * phone network, and the answer has to come back before it is worth sending another.
 */
export const WHEEL_LINES = 3
export const WHEEL_INTERVAL_MS = 160

/** How close to an edge counts as being *at* it, in points. Tighter than [`STUCK_WITHIN`]. */
const EDGE_WITHIN = 6

/**
 * What to send a program whose screen the reader is trying to scroll past the end of.
 *
 * A console drawing the alternate screen keeps no scrollback — `claude` takes it, measured — so
 * there is nothing above the viewport to scroll *to*, and the transcript lives in the program.
 * Reaching the edge and pulling is therefore not a scroll at all: it is a request to the program,
 * and it goes out as a wheel.
 *
 * **Only while the reader is driving**, for `moved`'s reason one step further along: a repaint
 * arriving while somebody rests at the top would otherwise send another wheel, which would cause
 * another repaint. That is not a stutter, it is a loop.
 *
 * Answers a signed number of lines — negative is up, towards older output — or `0` for nothing.
 */
export function wheelAtEdge(at: {
  offsetY: number
  remaining: number
  driving: boolean
  now: number
  lastAt: number
}): number {
  if (!at.driving) return 0
  if (at.now - at.lastAt < WHEEL_INTERVAL_MS) return 0
  if (at.offsetY <= EDGE_WITHIN) return -WHEEL_LINES
  if (at.remaining <= EDGE_WITHIN) return WHEEL_LINES
  return 0
}
