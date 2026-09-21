/**
 * What to do with a terminal row that is drawing a *box* rather than saying something. (M76)
 *
 * # The problem, from a photograph of a phone
 *
 * Claude Code frames its input in a rounded box the full width of the terminal. On a desktop
 * that is one line of `╭────╮`, one of `│ ❯   │` and one of `╰────╯`. Wrapped to a phone it is
 * **seven**: the top border becomes two and a half display lines of `─`, the middle row becomes a
 * `│ ❯`, a line of nothing and a stranded `│`, and the bottom border becomes two and a half more.
 * Seven lines of a screen that holds about forty, to draw a rectangle that is no longer a
 * rectangle. Bundling a font fixed the *clipping* and left this untouched, because it was never
 * about glyph widths — it is about `wrap` faithfully re-flowing characters that only meant
 * anything at the width they were drawn for.
 *
 * # The rule
 *
 * A row is *shaped* before it is wrapped, and only in wrap mode — pan mode exists to be exact and
 * is never touched. Three things happen, in this order:
 *
 *  1. **Trailing blanks go.** A terminal pads every row to its full width; at 120 columns and a
 *     budget of 46 that padding alone is two empty display lines under most rows on screen.
 *     Trimming stops at a blank that carries a **background, an underline or the inverse bit**,
 *     which is `cide_pty::screen`'s own rule at the other end of the wire and is there for the
 *     same reason: those are a selection or a highlight, and trimming them frays the right edge
 *     of the one thing being looked at.
 *  2. **A row that is nothing but rule characters becomes a rule.** One hairline, at the screen's
 *     width, in the row's own colour — which is what a horizontal border *means*, and it costs
 *     one line instead of three.
 *  3. **A row fenced by verticals is unfenced.** `│ … │` loses both characters and gains a border
 *     down the side of the block instead, so the prompt inside it is one line of text again.
 *
 * What this gives up is column alignment, and it gives up nothing: wrap mode has already given it
 * up — `wrap.ts`'s header says so — and a reader who needs the columns has `pan`, one tap away in
 * the header.
 *
 * Pure and React-free, so `test/term.test.ts` drives every case with no renderer. Each rule above
 * is a silent failure the other way: a prose row mistaken for a border **disappears**, and a
 * trailing blank trimmed when it should not be takes a highlight's right edge with it.
 */
import type { ScreenColor, StyleRun } from '../protocol/generated'

/** Attribute bits that make a blank cell *visible*. `Screen.tsx` numbers them the same way. */
const UNDERLINE = 1 << 3
const INVERSE = 1 << 4

/**
 * The characters a horizontal border is made of: the box-drawing lines, their corners and their
 * tees, plus the heavy and double variants and the block-element bars.
 *
 * A closed set, and deliberately **not** "anything in U+2500–U+257F": the verticals live in that
 * block too, and a column of `│` is a border that must stay where it is rather than becoming a
 * rule across the screen.
 */
const RULE = new Set([
  '\u2500', '\u2501', '\u2504', '\u2505', '\u2508', '\u2509', '\u254c', '\u254d',
  '\u2550',
  '\u250c', '\u250d', '\u250e', '\u250f', '\u2510', '\u2511', '\u2512', '\u2513',
  '\u2514', '\u2515', '\u2516', '\u2517', '\u2518', '\u2519', '\u251a', '\u251b',
  '\u251c', '\u2524', '\u252c', '\u2534', '\u253c',
  '\u2554', '\u2557', '\u255a', '\u255d', '\u2560', '\u2563', '\u2566', '\u2569', '\u256c',
  '\u256d', '\u256e', '\u256f', '\u2570',
  '\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588',
  '\u2594', '\u203e',
])

/** The characters a *vertical* border is made of. */
const FENCE = new Set([
  '\u2502', '\u2503', '\u2506', '\u2507', '\u250a', '\u250b', '\u2551',
])

/**
 * A row, decided.
 *
 * `rule` carries a colour because a border is often dim or accented and a hairline in the wrong
 * colour is a horizon line through the middle of somebody's output. It is the **wire's** colour,
 * an index or a triple, and never a resolved one: cide sends an index precisely so the palette
 * can be the phone's, and resolving it here would be a second palette — the failure `Screen.tsx`
 * keeps one `PALETTE` to avoid.
 */
export type Shaped =
  | { readonly kind: 'rule'; readonly color: ScreenColor | undefined }
  | { readonly kind: 'runs'; readonly runs: readonly StyleRun[]; readonly fenced: boolean }

function visibleBlank(run: StyleRun): boolean {
  const flags = run.flags ?? 0
  return run.bg !== undefined || (flags & UNDERLINE) !== 0 || (flags & INVERSE) !== 0
}

/** Drop trailing spaces that carry nothing. See rule 1. */
function trimEnd(runs: readonly StyleRun[]): StyleRun[] {
  const out = runs.map((run) => ({ ...run }))
  while (out.length > 0) {
    const last = out[out.length - 1]
    if (last === undefined) break
    if (visibleBlank(last)) break
    const trimmed = last.text.replace(/[ \t]+$/u, '')
    if (trimmed === last.text) break
    if (trimmed === '') {
      out.pop()
      continue
    }
    out[out.length - 1] = { ...last, text: trimmed }
    break
  }
  return out
}

function textOf(runs: readonly StyleRun[]): string {
  return runs.map((run) => run.text).join('')
}

/**
 * Decide what a row is, for a screen in wrap mode.
 *
 * `wrapped: false` answers `runs` unchanged and untouched — the one thing pan mode promises.
 */
export function shapeRow(runs: readonly StyleRun[], wrapped: boolean): Shaped {
  if (!wrapped) return { kind: 'runs', runs, fenced: false }

  const trimmed = trimEnd(runs)
  const text = textOf(trimmed)
  const bare = text.trim()

  // Rule 2. `bare.length > 1` because a lone `─` is as likely to be a dash somebody typed, and a
  // one-character row costs nothing to draw as itself.
  if (bare.length > 1 && [...bare].every((ch) => RULE.has(ch))) {
    return { kind: 'rule', color: trimmed.find((run) => run.text.trim() !== '')?.fg }
  }

  // Rule 3. Both ends, never one: a row that only *starts* with a vertical is a quoted line or a
  // tree drawing, and stripping its leader would move the text under it out of line with it.
  const chars = [...text]
  const first = chars[0]
  const last = chars[chars.length - 1]
  if (chars.length > 1 && first !== undefined && last !== undefined && FENCE.has(first) && FENCE.has(last)) {
    return { kind: 'runs', runs: trimEnd(strip(trimmed)), fenced: true }
  }

  return { kind: 'runs', runs: trimmed, fenced: false }
}

/** Remove the first and last character of a row, run boundaries notwithstanding. */
function strip(runs: readonly StyleRun[]): StyleRun[] {
  const out = runs.map((run) => ({ ...run, text: run.text }))
  for (let i = 0; i < out.length; i += 1) {
    const run = out[i]
    if (run === undefined || run.text === '') continue
    out[i] = { ...run, text: [...run.text].slice(1).join('') }
    break
  }
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const run = out[i]
    if (run === undefined || run.text === '') continue
    const chars = [...run.text]
    out[i] = { ...run, text: chars.slice(0, chars.length - 1).join('') }
    break
  }
  // And the one space a fence is nearly always padded with, on the left only: the right was
  // already taken by the trailing trim.
  const head = out.find((run) => run.text !== '')
  if (head !== undefined && head.text.startsWith(' ')) head.text = head.text.slice(1)
  return out.filter((run) => run.text !== '')
}
