/**
 * The terminal model: what an update does to a grid, and what a narrow screen does to a row.
 *
 * No renderer involved. Everything here is a store and a pure function, which is the point of
 * building it that way — the rules worth asserting are about *when the cache is thrown away*, and
 * those are invisible in a snapshot of what was drawn.
 */
import { describe, expect, it } from 'vitest'
import { RowStore } from '../src/term/rowStore'
import { ScreenStore } from '../src/term/screenStore'
import { fitFontSize, wrap, wrappedHeight } from '../src/term/wrap'
import { shapeRow } from '../src/term/frame'
import { KEY_BAR, PAD, PAGE_BAR, afterChange, delta, keysFor } from '../src/term/keys'
import {
  FOLLOWING,
  MAX_OWED,
  grabbed,
  moved,
  remainingOf,
  settled,
  shouldFollow,
  nextNotch,
  owe,
  splitDrag,
  wheelFromDrag,
  paged,
} from '../src/term/follow'
import type { ScreenInfo, ScreenUpdate, StyleRun } from '../src/protocol/generated'

const info = (over: Partial<ScreenInfo> = {}): ScreenInfo => ({
  cols: 20,
  rows: 3,
  mouse: 'off',
  alt: false,
  appCursor: false,
  bracketedPaste: false,
  ...over,
})

const run = (text: string, over: Partial<StyleRun> = {}): StyleRun => ({ text, ...over })

const update = (over: Partial<ScreenUpdate> = {}): ScreenUpdate => ({
  session: 's' as never,
  epoch: 1,
  full: true,
  info: info(),
  lines: [],
  ...over,
})

describe('typing into the hidden input', () => {
  /** One character at a time, the field keeping what the user typed. */
  it('sends one key per keystroke', () => {
    let seen = PAD
    let field = PAD
    const sent: string[] = []
    for (const typed of ['u', 'n', 'a', 'm', 'e', ' ', '-', 'a']) {
      field += typed
      const changed = afterChange(seen, field)
      expect(changed.paste).toBeNull()
      expect(changed.seen).toBe(field)
      for (const k of changed.keys) if (k.key.k === 'char') sent.push(k.text ?? '')
      seen = changed.seen
    }
    expect(sent.join('')).toBe('uname -a')
  })

  /**
   * The bug this model exists to make unrepresentable, pinned as the failure.
   *
   * Diffing against a baseline that was *asked for* rather than *seen* turns every event into a
   * multi-grapheme insert — a paste — of the whole line so far, so the far end receives every
   * prefix of it, joined. Typing `hello` on a real phone arrived as `hehehello`.
   */
  it('never diffs against a value it only asked for', () => {
    let field = PAD
    const stale: string[] = []
    for (const typed of ['h', 'e', 'l', 'l', 'o']) {
      field += typed
      // The old shape: the baseline is always the pristine pad.
      const { keys, paste } = keysFor(delta(PAD, field))
      stale.push(paste ?? keys.map((k) => (k.key.k === 'char' ? (k.text ?? '') : '')).join(''))
    }
    expect(stale.join('')).toBe('hhehelhellhello')

    // And the same keystrokes through `afterChange`, which is what ships.
    let seen = PAD
    field = PAD
    const sent: string[] = []
    for (const typed of ['h', 'e', 'l', 'l', 'o']) {
      field += typed
      const changed = afterChange(seen, field)
      sent.push(changed.paste ?? changed.keys.map((k) => k.text ?? '').join(''))
      seen = changed.seen
    }
    expect(sent.join('')).toBe('hello')
  })

  it('is a paste when a soft keyboard commits a whole word', () => {
    const changed = afterChange(PAD, `${PAD}hello`)
    expect(changed.paste).toBe('hello')
    expect(changed.keys).toEqual([])
  })

  it('reads a delete as a backspace and leaves the field alone', () => {
    const changed = afterChange(`${PAD}ab`, `${PAD}a`)
    expect(changed.keys).toEqual([{ key: { k: 'backspace' } }])
    expect(changed.seen).toBe(`${PAD}a`)
  })

  /**
   * The one moment a value is forced back in, and it is a pause: a delete has eaten into the pad,
   * so the *next* backspace would delete nothing and therefore not be a change at all.
   */
  it('tops the pad back up once a delete eats into it', () => {
    const changed = afterChange(PAD, PAD.slice(1))
    expect(changed.keys).toEqual([{ key: { k: 'backspace' } }])
    expect(changed.seen).toBe(PAD)
  })
})

describe('RowStore', () => {
  it('hands out a stable snapshot until something replaces it', () => {
    // `useSyncExternalStore` compares with `Object.is`, so a snapshot rebuilt on every call
    // re-renders for ever — and in React 19 throws about an uncached snapshot.
    const row = new RowStore()
    expect(row.getSnapshot()).toBe(row.getSnapshot())
    const runs = [run('hello')]
    row.set(runs)
    expect(row.getSnapshot()).toBe(runs)
    expect(row.getSnapshot()).toBe(row.getSnapshot())
  })

  it('tells its subscribers, and stops when they go', () => {
    const row = new RowStore()
    let told = 0
    const off = row.subscribe(() => told++)
    row.set([run('a')])
    expect(told).toBe(1)
    off()
    row.set([run('b')])
    expect(told).toBe(1)
    expect(row.listenerCount).toBe(0)
  })

  it('is quiet when clearing something already clear', () => {
    const row = new RowStore()
    let told = 0
    row.subscribe(() => told++)
    row.clear()
    expect(told).toBe(0)
  })
})

describe('ScreenStore', () => {
  it('lays out a grid from a full frame and patches only what moved', () => {
    const screen = new ScreenStore()
    expect(
      screen.apply(update({ lines: [{ row: 0, runs: [run('one')] }, { row: 1, runs: [run('two')] }] })),
    ).toMatchObject({ kind: 'reset' })
    expect(screen.row(0)!.text).toBe('one')
    expect(screen.row(1)!.text).toBe('two')

    let toldRowZero = 0
    screen.row(0)!.subscribe(() => toldRowZero++)
    const applied = screen.apply(
      update({ full: false, lines: [{ row: 1, runs: [run('TWO')] }] }),
    )
    expect(applied).toMatchObject({ kind: 'patched', rows: 1 })
    expect(screen.row(1)!.text).toBe('TWO')
    // The row that did not move was not told anything, which is the entire performance story.
    expect(toldRowZero).toBe(0)
  })

  it('throws the grid away when the epoch moves', () => {
    const screen = new ScreenStore()
    screen.apply(update({ lines: [{ row: 0, runs: [run('before')] }] }))

    // A resize re-numbers every row, so a row-by-row patch across one is a list of
    // coincidences. cide bumps the epoch and resends; this must not try to be clever.
    const applied = screen.apply(
      update({ epoch: 2, full: true, info: info({ cols: 40 }), lines: [{ row: 2, runs: [run('after')] }] }),
    )
    expect(applied).toMatchObject({ kind: 'reset' })
    expect(screen.row(0)!.text).toBe('')
    expect(screen.row(2)!.text).toBe('after')
    expect(screen.info!.cols).toBe(40)
  })

  it('keeps its row stores when only the contents changed', () => {
    // A replaced store takes its subscribers with it, so every row component would unmount and
    // remount on a repaint that was only ever about content.
    const screen = new ScreenStore()
    screen.apply(update({ lines: [{ row: 0, runs: [run('a')] }] }))
    const before = screen.row(0)
    screen.apply(update({ epoch: 2, full: true, lines: [{ row: 0, runs: [run('b')] }] }))
    expect(screen.row(0)).toBe(before)
  })

  it('reports a row it cannot place rather than dropping it', () => {
    const screen = new ScreenStore()
    screen.apply(update({}))
    expect(screen.apply(update({ full: false, lines: [{ row: 99, runs: [run('x')] }] }))).toEqual({
      kind: 'desynced',
    })
  })

  it('announces a shape change and stays quiet about a content one', () => {
    const screen = new ScreenStore()
    let announced = 0
    screen.subscribeGeometry(() => announced++)

    screen.apply(update({}))
    expect(announced).toBe(1)
    screen.apply(update({ epoch: 2, full: true, lines: [{ row: 0, runs: [run('x')] }] }))
    expect(announced).toBe(1)
    screen.apply(update({ epoch: 3, full: true, info: info({ rows: 6 }) }))
    expect(announced).toBe(2)
  })

  it('reads back as text, for the copy actions', () => {
    const screen = new ScreenStore()
    screen.apply(
      update({ lines: [{ row: 0, runs: [run('one')] }, { row: 1, runs: [run('two')] }] }),
    )
    expect(screen.text()).toBe('one\ntwo')
  })
})

describe('wrap', () => {
  it('breaks at the budget and carries the style across', () => {
    const red = run('aaaaaa', { fg: { kind: 'idx', index: 1 } })
    const lines = wrap([red], 4)
    expect(lines.map((l) => l.map((r) => r.text).join(''))).toEqual(['aaaa', 'aa'])
    // The thing a naive implementation loses at the second line of a coloured paragraph.
    expect(lines[1]![0]!.fg).toEqual({ kind: 'idx', index: 1 })
  })

  it('breaks across a run boundary without losing either style', () => {
    const lines = wrap([run('abc'), run('def', { flags: 1 })], 4)
    expect(lines.map((l) => l.map((r) => r.text).join(''))).toEqual(['abcd', 'ef'])
    expect(lines[0]![1]!.flags).toBe(1)
    expect(lines[1]![0]!.flags).toBe(1)
  })

  it('always yields at least one line, even for an empty row', () => {
    // A caller drawing N lines per row needs N even when the row is blank, or every row below
    // it moves.
    expect(wrap([], 10)).toEqual([[]])
    expect(wrap([run('')], 10)).toEqual([[]])
  })

  it('counts code points, not UTF-16 units', () => {
    // Slicing between the halves of a surrogate pair produces a replacement character, which is
    // a visibly broken glyph rather than a narrower line.
    const lines = wrap([run('😀😀😀')], 2)
    expect(lines.map((l) => l.map((r) => r.text).join(''))).toEqual(['😀😀', '😀'])
  })

  it('agrees with its own height function', () => {
    for (const [text, budget] of [
      ['', 10],
      ['short', 10],
      ['exactly10!', 10],
      ['eleven chars', 10],
      ['a'.repeat(97), 10],
    ] as const) {
      expect(wrap([run(text)], budget)).toHaveLength(wrappedHeight([run(text)], budget))
    }
  })

  it('refuses a budget of nothing rather than looping', () => {
    expect(wrap([run('anything')], 0)).toEqual([[]])
    expect(wrappedHeight([run('anything')], 0)).toBe(1)
  })
})

describe('fitFontSize', () => {
  const sizes = [8, 9, 10, 11, 12, 14, 16]

  it('picks the largest size that fits', () => {
    // 80 columns at 0.6 points of advance per point of size, on a 390-point screen: 80 × 0.6 × s
    // ≤ 390 means s ≤ 8.1.
    expect(fitFontSize(80, 390, 6, 10, sizes)).toBe(8)
    expect(fitFontSize(40, 390, 6, 10, sizes)).toBe(16)
  })

  it('says no rather than yes at four points', () => {
    // Two hundred columns do not fit on a phone. Answering with a tiny number would be a worse
    // answer than admitting it and offering to wrap.
    expect(fitFontSize(200, 390, 6, 10, sizes)).toBeNull()
  })
})

describe('the soft-keyboard delta', () => {
  it('reads an insert and a backspace out of two values', async () => {
    const { PAD, delta, keysFor } = await import('../src/term/keys')
    expect(delta(PAD, `${PAD}a`)).toEqual({ inserted: 'a', deleted: 0 })
    // The pad is why this is visible at all: without it, a backspace at "empty" changes nothing
    // and the first backspace of a line does nothing.
    expect(delta(PAD, PAD.slice(0, -1))).toEqual({ inserted: '', deleted: 1 })

    expect(keysFor({ inserted: 'a', deleted: 0 }).keys).toEqual([
      { key: { k: 'char' }, text: 'a' },
    ])
    expect(keysFor({ inserted: '', deleted: 2 }).keys).toHaveLength(2)
  })

  it('treats a multi-character insert as a paste, not as typing', async () => {
    const { keysFor } = await import('../src/term/keys')
    // A terminal genuinely treats them differently, and collapsing the distinction is how a
    // paste into a TUI submits itself halfway through.
    const out = keysFor({ inserted: 'hello world', deleted: 0 })
    expect(out.paste).toBe('hello world')
    expect(out.keys).toHaveLength(0)
  })

  it('counts a grapheme rather than a UTF-16 unit', async () => {
    const { keysFor } = await import('../src/term/keys')
    // One emoji is one keystroke, not a paste of two surrogate halves.
    const out = keysFor({ inserted: '😀', deleted: 0 })
    expect(out.paste).toBeNull()
    expect(out.keys).toEqual([{ key: { k: 'char' }, text: '😀' }])
  })

  it('sends a newline as Enter', async () => {
    const { keysFor } = await import('../src/term/keys')
    expect(keysFor({ inserted: '\n', deleted: 0 }).keys).toEqual([{ key: { k: 'enter' } }])
  })
})

describe('following the output', () => {
  const event = (remaining: number) => ({
    contentOffset: { y: 1000 },
    layoutMeasurement: { height: 800 },
    contentSize: { height: 1800 + remaining },
  })

  it('opens at the end and follows', () => {
    expect(FOLLOWING.stuck).toBe(true)
    expect(FOLLOWING.driving).toBe(false)
  })

  /**
   * The bug this module exists for. Two hundred lines of scrollback are prepended above the
   * viewport, `contentOffset` does not move, and the scroll event that follows measures the
   * whole of it — from a reader who has touched nothing.
   */
  it('does not stop following because content arrived', () => {
    const after = moved(FOLLOWING, 3000)
    expect(after.stuck).toBe(true)
  })

  it('stops following when the reader scrolls away, and resumes at the bottom', () => {
    const away = moved(grabbed(FOLLOWING), 3000)
    expect(away.stuck).toBe(false)
    const back = moved(away, 4)
    expect(back.stuck).toBe(true)
  })

  /** A slow release ends here with no momentum at all, so this edge has to decide too. */
  it('takes the answer from where a gesture settles', () => {
    expect(settled(3000).stuck).toBe(false)
    expect(settled(0).stuck).toBe(true)
    expect(settled(3000).driving).toBe(false)
  })

  /** Within the slack a fling lands in, which is not zero. */
  it('counts a few points short of the end as the end', () => {
    expect(settled(24).stuck).toBe(true)
    expect(settled(25).stuck).toBe(false)
  })

  /**
   * The snap-back: a drag that began at the bottom of a busy console kept `stuck`, and every
   * repaint pulled the view back to the end before the finger had moved it far enough to say
   * otherwise.
   */
  it('does not follow while the reader is driving, even from the bottom', () => {
    expect(shouldFollow(FOLLOWING)).toBe(true)
    expect(shouldFollow(grabbed(FOLLOWING))).toBe(false)
    expect(shouldFollow(settled(0))).toBe(true)
    expect(shouldFollow(settled(3000))).toBe(false)
  })

  it('measures what a scroll event reports', () => {
    expect(remainingOf(event(0))).toBe(0)
    expect(remainingOf(event(512))).toBe(512)
  })
})

describe('shaping a box row', () => {
  const r = (text: string, over: Partial<StyleRun> = {}): StyleRun => ({ text, ...over })
  const rule = '\u2500'.repeat(118)

  it('collapses a border into one rule', () => {
    const shaped = shapeRow([r(`\u256d${rule}\u256e`)], true)
    expect(shaped.kind).toBe('rule')
  })

  it('keeps a border in pan mode, exactly as it was', () => {
    const runs = [r(`\u256d${rule}\u256e`)]
    const shaped = shapeRow(runs, false)
    expect(shaped).toEqual({ kind: 'runs', runs, fenced: false })
  })

  /** The failure that costs a line of somebody's output: prose read as a border disappears. */
  it('never collapses a row that says something', () => {
    expect(shapeRow([r('--- a heading ---')], true).kind).toBe('runs')
    expect(shapeRow([r(`text with a \u2500 in it`)], true).kind).toBe('runs')
    expect(shapeRow([r('\u2500')], true).kind).toBe('runs')
  })

  it('takes the rule colour from the row, when it has one', () => {
    // The wire's colour, not a resolved one — the palette is `Screen.tsx`'s and stays there.
    const fg = { kind: 'rgb', r: 1, g: 2, b: 3 } as never
    expect(shapeRow([r(rule, { fg })], true)).toEqual({ kind: 'rule', color: fg })
  })

  it('unfences a row and says so', () => {
    const shaped = shapeRow([r(`\u2502 \u276f${' '.repeat(40)}\u2502`)], true)
    expect(shaped.kind).toBe('runs')
    if (shaped.kind !== 'runs') return
    expect(shaped.fenced).toBe(true)
    expect(shaped.runs.map((run) => run.text).join('')).toBe('\u276f')
  })

  /** One end is a quote marker or a tree drawing, not a box. */
  it('leaves a row fenced at one end alone', () => {
    const shaped = shapeRow([r('\u2502 a quoted line')], true)
    expect(shaped.kind).toBe('runs')
    if (shaped.kind !== 'runs') return
    expect(shaped.fenced).toBe(false)
  })

  it('drops the padding every terminal row carries', () => {
    const shaped = shapeRow([r('hello'), r(' '.repeat(100))], true)
    if (shaped.kind !== 'runs') throw new Error('runs')
    expect(shaped.runs.map((run) => run.text).join('')).toBe('hello')
  })

  /**
   * The other half of that rule, and the one that costs the user something: a trailing blank
   * with a background is a selection, and trimming it frays the edge of what they are reading.
   */
  it('keeps a trailing blank that is visible', () => {
    const selected = r('    ', { bg: { kind: 'idx', index: 4 } as never })
    const shaped = shapeRow([r('hello'), selected], true)
    if (shaped.kind !== 'runs') throw new Error('runs')
    expect(shaped.runs.map((run) => run.text).join('')).toBe('hello    ')
  })
})

describe('the key bar', () => {
  /**
   * Enter submits, so without this there is no way to write a second line at all — and a
   * multi-line message to an agent is the ordinary case. `ESC CR` is what cide encodes it as.
   */
  it('offers a newline that is not a submit', () => {
    const newline = KEY_BAR.find((entry) => entry.label === '⇧⏎')
    expect(newline).toBeDefined()
    expect(newline?.key).toEqual({ key: { k: 'enter' }, shift: true })
  })

  /** Touch is how a view scrolls; the page keys are kept, out of the thumb's way. */
  it('leads with escape and keeps paging for the end', () => {
    expect(KEY_BAR[0]?.label).toBe('esc')
    expect(KEY_BAR.every((entry) => entry.page === undefined)).toBe(true)
    expect(PAGE_BAR.map((entry) => [entry.label, entry.page, entry.whole === true])).toEqual([
      ['home', -1, true],
      ['end', 1, true],
      ['pgup', -1, false],
      ['pgdn', 1, false],
    ])
  })

  /**
   * Plain Home/End move `claude`'s caret along its input line, which from a phone looks like
   * nothing happened. Ctrl+Home/End are its `scroll:top`/`scroll:bottom`.
   */
  it('asks a program for its top and bottom with Ctrl+Home and Ctrl+End', () => {
    const home = PAGE_BAR.find((entry) => entry.label === 'home')
    const end = PAGE_BAR.find((entry) => entry.label === 'end')
    expect(home?.key).toEqual({ key: { k: 'home' }, ctrl: true })
    expect(end?.key).toEqual({ key: { k: 'end' }, ctrl: true })
  })
})

describe('the field is what was seen', () => {
  /**
   * The regression that produced `abcd` → `d`. A controlled `TextInput` holds whatever is
   * rendered into it, so `seen` has to be renderable as-is: any keystroke whose answer is not
   * the text the user just typed puts the old text back and turns the next one into a backspace
   * and a letter.
   */
  it('hands back exactly what the user typed, for every keystroke', () => {
    let seen = PAD
    for (const typed of ['a', 'b', 'c', 'd']) {
      const field = seen + typed
      const changed = afterChange(seen, field)
      expect(changed.seen).toBe(field)
      expect(changed.keys).toEqual([{ key: { k: 'char' }, text: typed }])
      seen = changed.seen
    }
    expect(seen).toBe(`${PAD}abcd`)
  })
})

describe('scrolling a program that owns its screen', () => {
  it('turns dragging down into older output, a notch per notch of travel', () => {
    expect(wheelFromDrag(0, 45, 15)).toEqual({ lines: -3, carry: 0 })
    expect(wheelFromDrag(0, -30, 15)).toEqual({ lines: 2, carry: 0 })
  })

  /** Without the carry a slow drag — under a line per touch event — never scrolls at all. */
  it('carries the part of a line a slow drag has not finished', () => {
    let carry = 0
    let lines = 0
    for (let i = 0; i < 10; i += 1) {
      const step = wheelFromDrag(carry, 4, 15)
      carry = step.carry
      lines += step.lines
    }
    expect(lines).toBe(-2)
    expect(carry).toBe(10)
  })

  /** Past the cap, a quick finger's notches are dropped rather than scrolled after it stops. */
  it('keeps only a few notches waiting', () => {
    expect(owe(0, -10)).toBe(-MAX_OWED)
    expect(owe(-MAX_OWED, -1)).toBe(-MAX_OWED)
  })

  it('turns round at once when the finger does', () => {
    expect(owe(-3, 1)).toBe(1)
    expect(owe(2, -1)).toBe(-1)
  })

  /**
   * A wrapped Claude screen is taller than the phone. Its top has to be reachable by scrolling
   * this view before anything is asked of the program, or it is never seen at all.
   */
  it('scrolls what this view holds back before wheeling the program', () => {
    // 300 points of the screen below the header; dragging down reveals them first.
    expect(splitDrag(300, 300, 100)).toEqual({ y: 200, rest: 0 })
    expect(splitDrag(50, 300, 100)).toEqual({ y: 0, rest: 50 })
    // At the top, all of it is wheel.
    expect(splitDrag(0, 300, 40)).toEqual({ y: 0, rest: 40 })
    // Dragging up goes back to this view's end first, then asks for newer.
    expect(splitDrag(250, 300, -80)).toEqual({ y: 300, rest: -30 })
    // A screen that fits has nothing held back.
    expect(splitDrag(0, 0, -20)).toEqual({ y: 0, rest: -20 })
  })

  /** One report per message: a burst is what `claude` reads as a fast-spinning wheel. */
  it('sends one notch at a time', () => {
    expect(nextNotch(-3)).toEqual({ send: -1, rest: -2 })
    expect(nextNotch(2)).toEqual({ send: 1, rest: 1 })
    expect(nextNotch(0)).toEqual({ send: 0, rest: 0 })
  })
})

describe('paging the view', () => {
  it('moves most of a screen, and stops at the ends', () => {
    const up = paged({ offsetY: 1000, viewport: 500, content: 2000, dir: -1 })
    expect(up.y).toBe(550)
    // Reading back: new output must not yank the view to the end.
    expect(up.follow.stuck).toBe(false)
    expect(paged({ offsetY: 100, viewport: 500, content: 2000, dir: -1 }).y).toBe(0)
  })

  it('follows again once a page down reaches the end', () => {
    const down = paged({ offsetY: 1400, viewport: 500, content: 2000, dir: 1 })
    expect(down.y).toBe(1500)
    expect(down.follow).toEqual({ stuck: true, driving: false })
  })
})
