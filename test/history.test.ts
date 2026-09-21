/**
 * The scrollback store: what stitches, what replaces, and what a probe is.
 *
 * Every rule here is about *not* joining two pages that are not neighbours, because the failure
 * that causes is silent — a transcript that reads perfectly with a piece missing out of the
 * middle of it.
 */
import { describe, expect, it } from 'vitest'
import { HistoryStore, PAGE, historyText } from '../src/term/history'
import type { ScreenLine, ScrollbackCapture } from '../src/protocol/generated'

const line = (text: string, row = 0): ScreenLine => ({ row, runs: [{ text }] })

const page = (fromTop: number, texts: string[], depth: number): ScrollbackCapture => ({
  fromTop,
  depth,
  lines: texts.map((text, i) => line(text, i)),
})

describe('the scrollback a device has read', () => {
  it('starts empty and has nothing earlier to ask for', () => {
    const history = new HistoryStore()
    expect(history.getSnapshot().lines).toHaveLength(0)
    expect(history.earlierFrom).toBeNull()
  })

  it('takes the depth from a page carrying no lines, which is how the depth is asked for', () => {
    const history = new HistoryStore()
    history.absorb(page(0, [], 4_000))
    expect(history.getSnapshot().depth).toBe(4_000)
    expect(history.getSnapshot().lines).toHaveLength(0)
    // Still nothing to page back through: the probe established how deep it is, not what is in it.
    expect(history.earlierFrom).toBeNull()
  })

  it('stitches a page that ends where the held block starts', () => {
    const history = new HistoryStore()
    history.absorb(page(10, ['c', 'd'], 12))
    history.absorb(page(8, ['a', 'b'], 12))
    expect(historyText(history.getSnapshot())).toBe('a\nb\nc\nd')
    expect(history.getSnapshot().from).toBe(8)
  })

  it('stitches a page that starts where the held block ends', () => {
    const history = new HistoryStore()
    history.absorb(page(8, ['a', 'b'], 12))
    history.absorb(page(10, ['c', 'd'], 12))
    expect(historyText(history.getSnapshot())).toBe('a\nb\nc\nd')
    expect(history.getSnapshot().from).toBe(8)
  })

  /**
   * The one that matters. Two blocks with lines missing between them are not a transcript, and
   * joining them would produce one that reads as complete.
   */
  it('replaces rather than joins two blocks that are not neighbours', () => {
    const history = new HistoryStore()
    history.absorb(page(0, ['a', 'b'], 100))
    history.absorb(page(50, ['x', 'y'], 100))
    expect(historyText(history.getSnapshot())).toBe('x\ny')
    expect(history.getSnapshot().from).toBe(50)
  })

  it('names the page before the one it holds, and stops at the oldest line', () => {
    const history = new HistoryStore()
    history.absorb(page(PAGE, ['a'], PAGE + 1))
    expect(history.earlierFrom).toBe(0)
    history.absorb(page(0, Array.from({ length: PAGE }, (_, i) => `l${i}`), PAGE + 1))
    expect(history.getSnapshot().from).toBe(0)
    expect(history.earlierFrom).toBeNull()
  })

  it('lets one request be outstanding at a time', () => {
    const history = new HistoryStore()
    expect(history.begin()).toBe(true)
    expect(history.begin()).toBe(false)
    history.absorb(page(0, ['a'], 1))
    expect(history.getSnapshot().loading).toBe(false)
    expect(history.begin()).toBe(true)
  })

  it('hands out the same snapshot until something replaces it', () => {
    const history = new HistoryStore()
    const first = history.getSnapshot()
    expect(history.getSnapshot()).toBe(first)
    history.absorb(page(0, ['a'], 1))
    expect(history.getSnapshot()).not.toBe(first)
  })

  it('tells its subscribers and forgets everything when the grid goes', () => {
    const history = new HistoryStore()
    let told = 0
    const off = history.subscribe(() => {
      told += 1
    })
    history.absorb(page(0, ['a'], 1))
    expect(told).toBe(1)
    history.forget()
    expect(told).toBe(2)
    expect(history.getSnapshot().lines).toHaveLength(0)
    off()
    history.absorb(page(0, ['b'], 1))
    expect(told).toBe(2)
  })
})

describe('pages that overlap', () => {
  const line = (text: string) => ({ row: 0, wrapped: false, runs: [{ text }] }) as never
  const page = (fromTop: number, texts: string[], depth: number) =>
    ({ fromTop, depth, lines: texts.map(line) }) as never

  /**
   * The bug that ate the transcript. A page is asked for as `[from - PAGE, from)` clamped at
   * zero, so the last one towards the start overlaps rather than abuts — and an overlap read as a
   * gap replaced the window, leaving the reader holding the oldest lines with no way back to the
   * live screen.
   */
  it('extends the window when an earlier page overlaps it', () => {
    const history = new HistoryStore()
    history.absorb(page(2, ['c', 'd', 'e'], 5))
    history.absorb(page(0, ['a', 'b', 'c'], 5))
    expect(historyText(history.getSnapshot())).toBe('a\nb\nc\nd\ne')
    expect(history.getSnapshot().from).toBe(0)
  })

  it('extends it when a newer page overlaps it', () => {
    const history = new HistoryStore()
    history.absorb(page(0, ['a', 'b', 'c'], 5))
    history.absorb(page(2, ['c', 'd', 'e'], 5))
    expect(historyText(history.getSnapshot())).toBe('a\nb\nc\nd\ne')
    expect(history.getSnapshot().from).toBe(0)
  })

  it('never shortens the window with a page that covers it', () => {
    const history = new HistoryStore()
    history.absorb(page(2, ['c'], 5))
    history.absorb(page(0, ['a', 'b', 'c', 'd', 'e'], 5))
    expect(historyText(history.getSnapshot())).toBe('a\nb\nc\nd\ne')
  })

  /** A page already inside the window changes nothing, and must not duplicate it. */
  it('takes nothing from a page it already holds', () => {
    const history = new HistoryStore()
    history.absorb(page(0, ['a', 'b', 'c', 'd'], 4))
    history.absorb(page(1, ['b', 'c'], 4))
    expect(historyText(history.getSnapshot())).toBe('a\nb\nc\nd')
  })

  /** And a real gap still replaces, which is the rule this sits beside. */
  it('still replaces a block that is neither adjacent nor overlapping', () => {
    const history = new HistoryStore()
    history.absorb(page(0, ['a', 'b'], 100))
    history.absorb(page(50, ['x', 'y'], 100))
    expect(historyText(history.getSnapshot())).toBe('x\ny')
  })
})
