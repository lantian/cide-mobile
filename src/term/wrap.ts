/** Reflow styled terminal text by words and display cells, keeping graphemes intact. */
import type { StyleRun } from '../protocol/generated'
interface Unit {
  text: string
  width: number
  run: StyleRun
}
const mark = /[\p{Mark}\uFE00-\uFE0F\u{1F3FB}-\u{1F3FF}]/u
function units(runs: readonly StyleRun[]): Unit[] {
  const out: Unit[] = []
  for (const run of runs) {
    for (const ch of run.text) {
      const last = out[out.length - 1]
      const point = ch.codePointAt(0)!
      const regional = point >= 0x1f1e6 && point <= 0x1f1ff
      const previousRegional = last !== undefined && /^[\u{1F1E6}-\u{1F1FF}]$/u.test(last.text)
      if (
        last !== undefined &&
        (mark.test(ch) ||
          ch === '\u200d' ||
          last.text.endsWith('\u200d') ||
          (regional && previousRegional))
      ) {
        last.text += ch
        continue
      }
      const wide =
        ((run.flags ?? 0) & 32) !== 0 ||
        (point >= 0x1100 &&
          (point <= 0x115f ||
            point === 0x2329 ||
            point === 0x232a ||
            (point >= 0x2e80 && point <= 0xa4cf) ||
            (point >= 0xac00 && point <= 0xd7a3) ||
            (point >= 0xf900 && point <= 0xfaff) ||
            (point >= 0xfe10 && point <= 0xfe6f) ||
            (point >= 0xff01 && point <= 0xff60) ||
            point >= 0x1f000))
      out.push({ text: ch, width: mark.test(ch) ? 0 : wide ? 2 : 1, run })
    }
  }
  return out
}
function styled(items: Unit[]): StyleRun[] {
  const out: StyleRun[] = []
  let previous: StyleRun | undefined
  for (const item of items) {
    if (previous === item.run) out[out.length - 1]!.text += item.text
    else {
      out.push({ ...item.run, text: item.text })
      previous = item.run
    }
  }
  return out
}
export function wrap(runs: readonly StyleRun[], budget: number): StyleRun[][] {
  if (budget <= 0) return [[]]
  const input = units(runs),
    lines: StyleRun[][] = []
  let start = 0
  while (start < input.length) {
    let end = start,
      used = 0,
      breakAt = -1
    while (end < input.length && (used + input[end]!.width <= budget || end === start)) {
      used += input[end]!.width
      if (/\s/u.test(input[end]!.text)) breakAt = end + 1
      end += 1
    }
    if (end < input.length && breakAt > start && !/\s/u.test(input[end]!.text)) end = breakAt
    lines.push(styled(input.slice(start, end)))
    start = end
  }
  return lines.length === 0 ? [[]] : lines
}
export function wrappedHeight(runs: readonly StyleRun[], budget: number): number {
  return wrap(runs, budget).length
}
export function fitFontSize(
  cols: number,
  width: number,
  advance: number,
  probe: number,
  sizes: readonly number[],
): number | null {
  const perPoint = advance / probe
  let best: number | null = null
  for (const size of sizes)
    if (cols * perPoint * size <= width) best = best === null ? size : Math.max(best, size)
  return best
}
