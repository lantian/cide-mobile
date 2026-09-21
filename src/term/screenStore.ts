/**
 * A watched session's grid, and what an update does to it.
 *
 * cide sends the whole grid once and then only the rows that moved, so this is where "only the
 * rows that moved" becomes a screen. The rules it implements are the other half of the ones in
 * `crates/cide-remote/src/screen.rs`, and the two that matter are both about *not* patching:
 *
 *  * **A different epoch is a different grid.** A resize or an alternate-screen transition
 *    re-numbers every row, so applying a row-by-row diff across one would be applying a list of
 *    coincidences. cide bumps the epoch and sends everything; this throws the cache away.
 *  * **A gap in the sequence is a resync, not a guess.** Frames are numbered per connection; if
 *    one is missed there is no way to know what the missing one said, so the only correct
 *    response is to ask for the whole grid again.
 *
 * React-free on purpose, so the whole model can be driven by a test with no renderer.
 */
import type { Cursor, ScreenInfo, ScreenUpdate } from '../protocol/generated'
import { RowStore } from './rowStore'

/** What applying an update did, for the caller that has to react to it. */
export type Applied =
  /** Patched in place. Nothing above this needs to do anything. */
  | { kind: 'patched'; rows: number }
  /** The grid was replaced: geometry changed, or this was the first frame. */
  | { kind: 'reset'; info: ScreenInfo }
  /** A frame was missed. The caller should re-watch to get a full grid. */
  | { kind: 'desynced' }

export class ScreenStore {
  private epoch: number | null = null
  private rows: RowStore[] = []
  private infoValue: ScreenInfo | null = null
  private cursorValue: Cursor | null = null
  private readonly geometryListeners = new Set<() => void>()

  get info(): ScreenInfo | null {
    return this.infoValue
  }

  get cursor(): Cursor | null {
    return this.cursorValue
  }

  /** The store for one row, or `undefined` past the bottom of the grid. */
  row(index: number): RowStore | undefined {
    return this.rows[index]
  }

  /** Fires when the *shape* changed — which is when the parent must re-render. */
  subscribeGeometry(listener: () => void): () => void {
    this.geometryListeners.add(listener)
    return () => {
      this.geometryListeners.delete(listener)
    }
  }

  apply(update: ScreenUpdate): Applied {
    const epoch = Number(update.epoch)

    if (update.full || this.epoch !== epoch) {
      // A different grid. See the header: a diff across a resize is a list of coincidences.
      this.reset(update.info)
      this.epoch = epoch
      for (const line of update.lines) {
        this.rows[line.row]?.set(line.runs)
      }
      this.cursorValue = update.cursor ?? null
      return { kind: 'reset', info: update.info }
    }

    for (const line of update.lines) {
      // A row past the bottom of a grid this size cannot be applied to it. That is a shape
      // disagreement rather than a lost frame, and it is worth noticing rather than dropping.
      const row = this.rows[line.row]
      if (row === undefined) return { kind: 'desynced' }
      row.set(line.runs)
    }
    this.cursorValue = update.cursor ?? null
    return { kind: 'patched', rows: update.lines.length }
  }

  /** Throw everything away — what an unwatch, or a session that ended, leaves behind. */
  forget(): void {
    this.epoch = null
    this.infoValue = null
    this.cursorValue = null
    this.rows = []
    this.announce()
  }

  private reset(info: ScreenInfo): void {
    const changed =
      this.infoValue === null ||
      this.infoValue.rows !== info.rows ||
      this.infoValue.cols !== info.cols ||
      this.infoValue.alt !== info.alt
    this.infoValue = info

    // Row stores are **kept** where the height did not change, and that is not an optimisation
    // for its own sake: a store that is replaced takes its subscribers with it, so every row
    // component would unmount and remount on a repaint that was only ever about content.
    if (this.rows.length !== info.rows) {
      const next: RowStore[] = []
      for (let i = 0; i < info.rows; i++) next.push(this.rows[i] ?? new RowStore())
      this.rows = next
    }
    for (const row of this.rows) row.clear()
    if (changed) this.announce()
  }

  private announce(): void {
    for (const listener of this.geometryListeners) listener()
  }

  /** The whole grid as text — what *copy screen* copies. */
  text(): string {
    return this.rows
      .map((row) => row.text)
      .join('\n')
      .replace(/\n+$/, '')
  }
}
