import { expect, it } from 'vitest'
import { colour, contrast, runColours } from '../src/term/colors'
import { plainText, logicalLines } from '../src/term/text'
import { wrap } from '../src/term/wrap'
import { shapeRow } from '../src/term/frame'
import { ScreenStore } from '../src/term/screenStore'
import type { ScreenLine, ScreenUpdate } from '../src/protocol/generated'
const line = (text: string, wrapped = false, row = 0): ScreenLine => ({
  row,
  wrapped,
  runs: [{ text }],
})
it('resolves all indexed colors, including the cube and grayscale', () => {
  expect(colour({ kind: 'idx', index: 196 }, '#000000')).toBe('#ff0000')
  expect(colour({ kind: 'idx', index: 46 }, '#000000')).toBe('#00ff00')
  expect(colour({ kind: 'idx', index: 232 }, '#000000')).toBe('#080808')
  expect(colour({ kind: 'idx', index: 255 }, '#000000')).toBe('#eeeeee')
})
it('keeps bold, dim, RGB and inverse text readable on light or dark fills', () => {
  for (const flags of [0, 1, 2, 16, 17, 18]) {
    const style = runColours(
      {
        text: 'Codex',
        fg: { kind: 'rgb', r: 235, g: 235, b: 235 },
        bg: { kind: 'idx', index: 15 },
        flags,
      },
      true,
    )
    expect(contrast(style.color, style.backgroundColor!)).toBeGreaterThanOrEqual(4.5)
  }
})
it('shapes the screenshot-style Codex prompt without white rectangles or wrapped padding', () => {
  const run = {
    text: '› Implement the plan.' + ' '.repeat(120),
    bg: { kind: 'rgb', r: 255, g: 255, b: 255 } as const,
  }
  expect(runColours(run, true).backgroundColor).toBe('#21262d')
  expect(runColours(run, false).backgroundColor).toBe('#ffffff')
  expect(
    runColours(
      { text: 'pan', fg: { kind: 'idx', index: 196 }, bg: { kind: 'idx', index: 196 } },
      false,
    ).color,
  ).toBe('#ff0000')
  const shaped = shapeRow([run], true)
  if (shaped.kind !== 'runs') throw new Error('prompt should be text')
  expect(wrap(shaped.runs, 40)).toHaveLength(1)
  const green = { text: '+ line', bg: { kind: 'rgb', r: 34, g: 92, b: 43 } as const }
  expect(runColours(green, true).backgroundColor).toBe('#225c2b')
})
it('breaks at word boundaries across styles and preserves wide/combining graphemes', () => {
  const lines = wrap([{ text: 'Search ' }, { text: 'agents.rs', flags: 1 }], 12)
  expect(lines.map((l) => l.map((r) => r.text).join(''))).toEqual(['Search ', 'agents.rs'])
  expect(lines[1]![0]!.flags).toBe(1)
  expect(wrap([{ text: 'e\u0301e\u0301' }], 1).map((l) => l[0]!.text)).toEqual([
    'e\u0301',
    'e\u0301',
  ])
  expect(wrap([{ text: '中中', flags: 32 }], 2).map((l) => l[0]!.text)).toEqual(['中', '中'])
  expect(wrap([{ text: '👩‍💻👩‍💻' }], 2).map((l) => l[0]!.text)).toEqual(['👩‍💻', '👩‍💻'])
})
it('joins terminal soft wraps but preserves hard breaks for reading and copying', () => {
  const rows = [line('hello ', true), line('world   ', false, 1), line('next', false, 2)]
  expect(logicalLines(rows).map((l) => l.runs.map((r) => r.text).join(''))).toEqual([
    'hello world   ',
    'next',
  ])
  expect(plainText(rows)).toBe('hello world\nnext')
  // Whitespace at a genuine soft wrap belongs to the sentence, not terminal padding.
  expect(plainText([line('hello', true), line(' world')])).toBe('hello world')
})
it('retains wrap flags through incremental updates and leaves a captured snapshot stable', () => {
  const screen = new ScreenStore()
  const update: ScreenUpdate = {
    session: 's',
    epoch: 1,
    full: true,
    info: { cols: 20, rows: 2, alt: false, appCursor: false, bracketedPaste: false, mouse: 'off' },
    lines: [line('abc', true), line('def', false, 1)],
  }
  screen.apply(update)
  const copied = screen.text()
  expect(copied).toBe('abcdef')
  screen.apply({ ...update, full: false, lines: [line('changed', false, 1)] })
  expect(screen.text()).toBe('abcchanged')
  expect(copied).toBe('abcdef')
})
