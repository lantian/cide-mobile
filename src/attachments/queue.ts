/**
 * Who gets to download next. (cide M136)
 *
 * A task with a hundred screenshots is a hundred tiles, and a person flicking down it mounts and
 * unmounts most of them within a second. Starting a download per mount would put a hundred
 * transfers on one socket, each holding its slices in memory, all for pictures already off the
 * screen — that, and not drawing, is what freezes a phone on a long card. So:
 *
 * - **Wanted, not started.** A tile says it wants a file and gets a release function. At most
 *   `limit` downloads run; the rest wait.
 * - **Newest first.** A stack, not a queue: what the person scrolled to last is what they are
 *   looking at, and the tiles they flicked past on the way are the least likely to matter.
 * - **Released is forgotten.** A key nobody wants any more leaves the waiting list, and a running
 *   one is aborted at its next slice. This is the unload half of lazy loading: a tile that
 *   scrolled away takes its download with it.
 * - **Deduplicated.** Two tiles for one file (a strip and the viewer) share one download.
 *
 * Pure — no React, no disk — so it is tested in Node.
 */
import type { AbortFlag } from './fetchChunks'

export type Job = (signal: AbortFlag) => Promise<void>

interface Entry {
  key: string
  job: Job
  wants: number
  running: boolean
  signal: { aborted: boolean }
}

export class FetchQueue {
  private readonly entries = new Map<string, Entry>()
  /** Waiting keys, newest last. */
  private waiting: string[] = []
  private running = 0

  constructor(private readonly limit = 2) {}

  /**
   * Want `key` fetched by `job`. Returns the release; call it exactly once. A key already
   * wanted keeps its first job and moves to the top of the stack.
   */
  want(key: string, job: Job): () => void {
    let entry = this.entries.get(key)
    if (entry === undefined) {
      entry = { key, job, wants: 0, running: false, signal: { aborted: false } }
      this.entries.set(key, entry)
    }
    entry.wants += 1
    if (!entry.running) {
      this.waiting = this.waiting.filter((k) => k !== key)
      this.waiting.push(key)
    }
    this.pump()

    const held = entry
    let released = false
    return () => {
      if (released) return
      released = true
      held.wants -= 1
      if (held.wants > 0 || this.entries.get(key) !== held) return
      if (held.running) {
        held.signal.aborted = true
      } else {
        this.waiting = this.waiting.filter((k) => k !== key)
      }
      this.entries.delete(key)
    }
  }

  /** How many downloads are running and waiting, for tests and a debug line. */
  get stats(): { running: number; waiting: number } {
    return { running: this.running, waiting: this.waiting.length }
  }

  private pump(): void {
    while (this.running < this.limit && this.waiting.length > 0) {
      const key = this.waiting.pop() as string
      const entry = this.entries.get(key)
      if (entry === undefined || entry.running) continue
      entry.running = true
      this.running += 1
      const finish = () => {
        this.running -= 1
        if (this.entries.get(key) === entry) this.entries.delete(key)
        this.pump()
      }
      // A job's own failure is the job's to report (the store keeps it as `refused`); the queue
      // only needs to know the slot is free.
      entry.job(entry.signal).then(finish, finish)
    }
  }
}
