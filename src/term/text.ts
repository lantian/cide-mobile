/** Terminal hard breaks are text; soft wraps and phone display breaks are not. */
import type { ScreenLine, StyleRun } from '../protocol/generated'
export function plainText(lines: readonly Pick<ScreenLine, 'runs' | 'wrapped'>[]): string {
  return lines
    .map(
      (line, i) =>
        (line.wrapped
          ? line.runs.map((run) => run.text).join('')
          : line.runs
              .map((run) => run.text)
              .join('')
              .replace(/[ \t]+$/u, '')) + (i === lines.length - 1 || line.wrapped ? '' : '\n'),
    )
    .join('')
    .replace(/\n+$/, '')
}
export function logicalLines(lines: readonly ScreenLine[]): ScreenLine[] {
  const out: ScreenLine[] = []
  for (const line of lines) {
    const previous = out[out.length - 1]
    if (previous?.wrapped) {
      previous.runs.push(...line.runs)
      previous.wrapped = line.wrapped ?? false
    } else out.push({ ...line, runs: [...line.runs] })
  }
  return out
}
// A run is immutable in the stores. Snapshot callers get their own row records.
export function screenLines(
  rows: readonly { getSnapshot(): readonly StyleRun[]; wrapped: boolean }[],
): ScreenLine[] {
  return rows.map((row, index) => ({
    row: index,
    runs: [...row.getSnapshot()],
    wrapped: row.wrapped,
  }))
}
