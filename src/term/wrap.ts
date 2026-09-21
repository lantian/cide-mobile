/**
 * Re-flow a terminal row to a narrower width, keeping its colours.
 *
 * # Why this exists at all
 *
 * cide never resizes a session for a device — the phone mirrors the desktop's terminal, because
 * resizing it would reflow five thousand lines of scrollback under whoever is sitting at the
 * machine. So the grid arriving here is eighty, or a hundred and twenty, or two hundred columns
 * wide, and the screen it has to land on is about forty.
 *
 * Three ways to cope, and this is one of them: pan (exact columns, and the user scrolls), fit
 * (shrink the font until it fits, which stops being legible past about a hundred columns), and
 * **wrap**. Wrap destroys column alignment, so it is wrong for anything drawing boxes — and it is
 * right for a Claude pane, which is mostly prose, and which is the pane somebody opens their
 * phone to read.
 *
 * It is easy only because rows arrive as *runs*: splitting styled text at a column is a slice of
 * a string and a copy of four fields. Doing the same thing to a stream of escape sequences would
 * mean tracking the SGR state across the break.
 *
 * Pure, memoisable, and driven by `test/term.test.ts` with no renderer.
 */
import type { StyleRun } from '../protocol/generated'

/**
 * Break one row into display lines of at most `budget` characters.
 *
 * Always returns at least one line, empty if the row is. A caller drawing N lines for one row
 * needs to know N even when the row has nothing in it, or the rows below it move.
 */
export function wrap(runs: readonly StyleRun[], budget: number): StyleRun[][] {
  if (budget <= 0) return [[]]

  const lines: StyleRun[][] = []
  let line: StyleRun[] = []
  let used = 0

  for (const run of runs) {
    // Code points, not UTF-16 units: a surrogate pair is one thing on a screen, and slicing
    // between its halves produces a replacement character rather than a narrower line.
    let chars = [...run.text]
    while (chars.length > 0) {
      const room = budget - used
      if (room <= 0) {
        lines.push(line)
        line = []
        used = 0
        continue
      }
      const take = chars.slice(0, room)
      chars = chars.slice(room)
      // The style is carried across every break — which is the whole reason this takes runs
      // rather than text, and the thing a naive implementation loses at the second line of a
      // coloured paragraph.
      line.push({ ...run, text: take.join('') })
      used += take.length
    }
  }

  lines.push(line)
  return lines
}

/**
 * How many display lines a row will take.
 *
 * Separate from [`wrap`] because a list that has to know its own height asks this for every row
 * and wraps only the ones on screen. Counting by summing run lengths is what keeps that cheap.
 */
export function wrappedHeight(runs: readonly StyleRun[], budget: number): number {
  if (budget <= 0) return 1
  let width = 0
  for (const run of runs) width += [...run.text].length
  return Math.max(1, Math.ceil(width / budget))
}

/**
 * The largest font size at which `cols` columns fit in `width` points, or `null` when none does.
 *
 * `null` rather than a tiny number, and the caller says so out loud: two hundred columns do not
 * fit on a phone, and rendering them at four points is a worse answer than admitting it and
 * offering to wrap. `advance` is the measured width of one character at `probe` points, which
 * every monospace face scales linearly.
 */
export function fitFontSize(
  cols: number,
  width: number,
  advance: number,
  probe: number,
  sizes: readonly number[],
): number | null {
  const perPoint = advance / probe
  let best: number | null = null
  for (const size of sizes) {
    if (cols * perPoint * size <= width) best = best === null ? size : Math.max(best, size)
  }
  return best
}
