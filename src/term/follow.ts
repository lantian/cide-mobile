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

/**
 * Whether content arriving should pull the view to the end *right now*.
 *
 * Not while the reader is driving, even if the drag began at the bottom. `grabbed` keeps `stuck`
 * on purpose — a drag that goes nowhere is still following — but acting on it mid-gesture meant
 * every repaint of a busy console snapped the view back to the end for the first couple of dozen
 * points of a drag, which is the whole of a slow one: the finger moved, the text did not, and
 * scrolling read as broken. Output that arrives during a gesture is caught up when it settles.
 */
export function shouldFollow(follow: Follow): boolean {
  return follow.stuck && !follow.driving
}

/* --- scrolling a program that owns its own screen ------------------------------------------ */

/**
 * The gap between two wheel notches sent to a program, in milliseconds — one notch per message,
 * never a burst.
 *
 * `claude` **accelerates** its wheel: a report arriving within 40 ms of the last one scrolls more
 * rows than the one before, ramping to six and beyond (read out of Claude Code 2.1.283's own
 * wheel handler — `wheelScrollAccelerationEnabled`, window 40 ms, step 0.3, ceiling
 * `max(6, 2 × base)`). The first two cuts of this sent the notches a drag had earned as one
 * burst per tick — several reports in one write, zero milliseconds apart — which is the
 * fastest-spinning wheel there is, so every ordinary swipe replaced the whole screen and the
 * reader lost the line they had just read. Spaced wider than the window, every notch scrolls
 * the program's base amount and nothing more; 60 rather than 41 because a phone network bunches
 * messages up on the way.
 */
export const WHEEL_GAP_MS = 60

/**
 * Finger travel per wheel notch, in grid lines.
 *
 * A notch moves the program's base amount — a few rows — so a notch per three lines of travel
 * keeps the text roughly under the finger: a half-screen swipe is about half a screen.
 */
export const NOTCH_LINES = 3

/**
 * The most notches allowed to wait for their turn.
 *
 * The gap makes the program scroll slower than a quick finger moves, and a queue that kept
 * everything would go on scrolling long after the finger stopped — the reader lifts their thumb
 * to read and the text keeps going, which is the "scrolled too far" this whole module is about.
 * Three is under a fifth of a second of sending: scrolling stops when the finger does.
 */
export const MAX_OWED = 3

/**
 * Turn finger travel into whole wheel notches, carrying the remainder.
 *
 * The console drawing the alternate screen keeps no scrollback — `claude` takes it — so there is
 * nothing on the phone to scroll: the transcript lives in the program, and a drag has to become
 * wheel notches. `perNotch` points of travel make one — see [`NOTCH_LINES`] — and the fraction
 * left over is kept for the next move rather than lost: without that, a slow drag of less than a
 * notch per touch event never scrolls at all.
 *
 * `dy` is the finger's travel since the last call, down positive. Dragging **down** pulls older
 * output into view, which is a wheel **up**: negative.
 */
export function wheelFromDrag(
  carry: number,
  dy: number,
  perNotch: number,
): { lines: number; carry: number } {
  const total = carry + dy
  const whole = Math.trunc(total / perNotch)
  return { lines: whole === 0 ? 0 : -whole, carry: total - whole * perNotch }
}

/**
 * Add freshly earned notches to what is waiting, capped at [`MAX_OWED`].
 *
 * A reversal **replaces** the queue rather than cancelling against it: a finger that turned
 * round wants the text to turn round now, not after the old direction has drained.
 */
export function owe(owed: number, lines: number): number {
  const next = owed !== 0 && Math.sign(owed) !== Math.sign(lines) ? lines : owed + lines
  return Math.max(-MAX_OWED, Math.min(MAX_OWED, next))
}

/**
 * Split a drag on a program-owned screen between this view and the program.
 *
 * Wrapped, a program's screen is often **taller** than the phone's — a Claude pane's rows are a
 * desktop's width — and the first cut sent every drag to the program as wheel while pinning this
 * view to the end. The top of the program's own screen was then under the header for good: Home
 * took `claude` to the start of the conversation and the start was exactly the part that could
 * not be seen. So the part of the screen this view is holding back is scrolled **here** first,
 * and only travel past this view's own edge becomes wheel.
 *
 * `dy` is finger travel, down positive; answers where the view goes and the travel left over.
 */
export function splitDrag(offsetY: number, max: number, dy: number): { y: number; rest: number } {
  const y = Math.min(max, Math.max(0, offsetY - dy))
  return { y, rest: dy - (offsetY - y) }
}

/** The one notch to send now, and what is left waiting. */
export function nextNotch(owed: number): { send: number; rest: number } {
  const send = Math.sign(owed)
  return { send, rest: owed - send }
}

/* --- paging the phone's own view ----------------------------------------------------------- */

/** How much of a viewport one PgUp/PgDn moves: most of it, so a line of context carries over. */
export const PAGE_FRACTION = 0.9

/**
 * Where a PgUp (`-1`) or PgDn (`1`) of the phone's own view lands, and what following becomes.
 *
 * The reader's act, so it decides following exactly as a drag that ended there would: a PgDn
 * that reaches the end is back to following the output, and a PgUp is reading and is left alone
 * by whatever arrives next — which is the only way a page up survives a busy console at all.
 */
export function paged(at: {
  offsetY: number
  viewport: number
  content: number
  dir: 1 | -1
}): { y: number; follow: Follow } {
  const max = Math.max(0, at.content - at.viewport)
  const y = Math.min(max, Math.max(0, at.offsetY + at.dir * at.viewport * PAGE_FRACTION))
  return { y, follow: settled(max - y) }
}
