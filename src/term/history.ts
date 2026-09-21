/**
 * A watched session's scrollback, as far back as it has been read. (M76)
 *
 * The live grid is the desktop's *viewport* — sixty rows, or whatever that window happens to be
 * — and it is all a device was ever sent. So a phone watching a session while Claude works could
 * read only what was on screen at that instant: scrolling up reached the top of the viewport and
 * stopped, with the thing worth reading already gone. cide retains five thousand lines per
 * session and the wire has always carried a way to ask for them (`scrollbackPage`); nothing on
 * the phone asked. This is the asking.
 *
 * # Indices count from the oldest line, and that is the wire's choice, not this file's
 *
 * `from_top` names a line from the *oldest* retained one, because the scrollback grows from the
 * bottom while a page is being read: an offset from the end names a different line every time
 * the child prints anything, and a reader paging backwards through one would see rows repeat and
 * rows vanish with nothing wrong anywhere. So the pages this holds are stitched on absolute
 * indices and new output at the bottom cannot disturb them.
 *
 * **The one case it cannot survive is eviction.** cide's ring holds five thousand lines; once it
 * is full, the oldest line is dropped for each new one and index 0 becomes a different line,
 * with `depth` staying exactly where it was. There is nothing in the answer that says so, so a
 * page fetched after an eviction can be stitched a few lines out of true against one fetched
 * before it. That is a real limit and not a bug that has been missed: closing the console and
 * opening it again re-reads from the bottom, which is the only repair available and is what the
 * *Load earlier* road should be understood to be doing between two quiet moments. It takes a
 * five-thousand-line build *while a page is on screen* to see it.
 *
 * React-free, like every other store under `src/term`, so `test/term.test.ts` can drive the
 * whole of it with no renderer.
 */
import type { ScreenLine, ScrollbackCapture } from '../protocol/generated'

/**
 * How many lines a page asks for.
 *
 * `MAX_PAGE_ROWS` on cide's side is 200 and a larger request is silently clamped, so asking for
 * more would quietly mean asking for this and then stitching a gap that is not there.
 */
export const PAGE = 200

export interface History {
  /** The absolute index — from the oldest retained line — of `lines[0]`. */
  from: number
  /** Contiguous, oldest first. `lines[i]` is the line at `from + i`. */
  lines: readonly ScreenLine[]
  /** How deep the scrollback was when the last page arrived. */
  depth: number
  /** A page has been asked for and has not come back. */
  loading: boolean
}

const EMPTY: History = { from: 0, lines: [], depth: 0, loading: false }

export type Listener = () => void

export class HistoryStore {
  private state: History = EMPTY
  private readonly listeners = new Set<Listener>()

  /** Stable until something replaces it — `rowStore.ts`'s rule, for its reason. */
  readonly getSnapshot = (): History => this.state

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Where the next *earlier* page starts, or `null` when the oldest line is already held. */
  get earlierFrom(): number | null {
    if (this.state.lines.length === 0) return null
    if (this.state.from <= 0) return null
    return Math.max(0, this.state.from - PAGE)
  }

  /** Mark a request outstanding, so two scrolls do not ask twice. */
  begin(): boolean {
    if (this.state.loading) return false
    this.replace({ ...this.state, loading: true })
    return true
  }

  /**
   * Take a page.
   *
   * The last outcome is the one worth spelling out. A page that neither abuts nor overlaps what
   * is held is a **gap**, and a gap cannot be patched — the lines between are simply not here —
   * so it replaces rather than stitches. Stitching it would put two pieces of the session's
   * history next to each other as though they were consecutive, which reads as a perfectly
   * ordinary transcript with something missing out of the middle of it.
   *
   * # Overlap is not a gap, and reading it as one threw the transcript away (M76)
   *
   * A page is asked for as `[from - PAGE, from)`, clamped at zero — so the moment `from` is not a
   * multiple of `PAGE`, the last page towards the start **overlaps** what is held instead of
   * abutting it. Held `[100, 500)`, asked from 0, answered `[0, 200)`: neither `from + len ===
   * state.from` nor `from === state.from + len`, so it was taken for a gap and *replaced* the
   * window. Scrolling back to the beginning of a session therefore discarded everything from
   * line 200 onwards — the reader ended up holding two hundred of the oldest lines with no way
   * back to the live screen, which is what "I cannot scroll to see the whole log" looks like
   * from the outside. It needed four pages to show, which is why no fixture had.
   *
   * Overlapping lines are the same lines: the index is absolute and answered from one ring, so
   * the held copy is kept and only what extends the window is taken.
   */
  absorb(page: ScrollbackCapture): void {
    const from = Number(page.fromTop)
    const depth = Number(page.depth)
    const lines = page.lines

    if (lines.length === 0) {
      // A probe, or a page past the end. It still carries the one fact it was asked for.
      this.replace({ ...this.state, depth, loading: false })
      return
    }
    const held = this.state.lines
    if (held.length === 0) {
      this.replace({ from, lines, depth, loading: false })
      return
    }
    const end = from + lines.length
    const heldFrom = this.state.from
    const heldEnd = heldFrom + held.length

    // Older side: abuts (`end === heldFrom`) or overlaps. Whatever reaches past the far end of
    // the held window is taken too, so a page that covers the lot cannot shorten it.
    if (from <= heldFrom && end >= heldFrom) {
      const before = lines.slice(0, heldFrom - from)
      const after = end > heldEnd ? lines.slice(heldEnd - from) : []
      this.replace({ from, lines: [...before, ...held, ...after], depth, loading: false })
      return
    }
    // Newer side, the mirror of it.
    if (from >= heldFrom && from <= heldEnd) {
      const after = lines.slice(Math.min(lines.length, heldEnd - from))
      this.replace({ from: heldFrom, lines: [...held, ...after], depth, loading: false })
      return
    }
    this.replace({ from, lines, depth, loading: false })
  }

  /** Throw it away: a new grid, a reconnect, or a console being left. */
  forget(): void {
    if (this.state === EMPTY) return
    this.replace(EMPTY)
  }

  private replace(next: History): void {
    this.state = next
    for (const listener of this.listeners) listener()
  }
}

/** The plain text of what is held, oldest first. For tests and for a copy action. */
export function historyText(history: History): string {
  return history.lines
    .map((line: ScreenLine) => line.runs.map((run) => run.text).join(''))
    .join('\n')
}
