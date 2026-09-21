/**
 * One row of a terminal, as a store a single component subscribes to.
 *
 * # Why a store per row rather than a grid in one store
 *
 * The obvious build holds `rows: StyleRun[][]` in one place and maps over it. A busy terminal
 * changes about ten rows, ten times a second; that build re-renders the *screen* component on
 * every one of those, which reconciles all sixty rows — including the fifty that did not move —
 * and each of those is a `<Text>` with nested spans, which becomes a native attributed-string
 * update crossing to the UI thread. On a mid-range Android that is a dropped-frame machine, and
 * the first thing anybody notices is that the keyboard lags.
 *
 * So: one tiny store per row, a `React.memo` row component subscribing with
 * `useSyncExternalStore`, and a parent that renders the grid once from the geometry and never
 * re-renders on data. A frame touching twelve rows re-renders twelve components.
 *
 * # `getSnapshot` must be referentially stable
 *
 * `useSyncExternalStore` compares snapshots with `Object.is` and re-renders when they differ, so
 * a `getSnapshot` that built a fresh array would re-render on every check and, in React 19,
 * throw *"The result of getSnapshot should be cached"*. This returns the same array until
 * something actually replaces it — which is also why [`set`] takes a new array rather than
 * mutating the old one.
 *
 * Deliberately free of React: this file is driven by `test/term.test.ts` with no renderer at all.
 */
import type { StyleRun } from '../protocol/generated'

export type Listener = () => void

const EMPTY: readonly StyleRun[] = []

export class RowStore {
  private runs: readonly StyleRun[] = EMPTY
  private readonly listeners = new Set<Listener>()

  /** Stable across calls until [`set`] replaces it. See the header. */
  readonly getSnapshot = (): readonly StyleRun[] => this.runs

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  set(runs: readonly StyleRun[]): void {
    this.runs = runs
    for (const listener of this.listeners) listener()
  }

  clear(): void {
    if (this.runs === EMPTY) return
    this.set(EMPTY)
  }

  /** For tests and for the copy actions: this row as plain text. */
  get text(): string {
    return this.runs.map((run) => run.text).join('')
  }

  get listenerCount(): number {
    return this.listeners.size
  }
}
