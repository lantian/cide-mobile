/**
 * How long to wait before trying an instance again.
 *
 * Pure, and injected with its own randomness, so the sequence can be asserted rather than
 * observed. A reconnect policy is the kind of thing that looks obviously right and is wrong in
 * one of three ways, all of which cost a battery rather than raising an error.
 */

/** The ladder, in milliseconds. The last rung repeats for ever. */
export const RUNGS = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const

/**
 * How much either side of a rung the jitter may take it.
 *
 * Not decoration. Several instances that went away together — a laptop closing its lid — come
 * back together, and without jitter they would retry in lockstep for ever.
 */
export const JITTER = 0.2

export interface Backoff {
  /** How many failures since the last success. */
  readonly attempt: number
  /** The wait for the *next* attempt, in milliseconds. */
  next(): number
  /** A failure happened: advance. */
  fail(): void
  /**
   * A connection **completed its handshake**: start again from the top.
   *
   * Not "the socket opened", and that distinction is the whole reason this is a method rather
   * than a reset in the connect path. A server that accepts and then immediately rejects —
   * a revoked device, a protocol mismatch, a half-open port — opens a socket every time, so
   * resetting there gives an unthrottled loop that looks exactly like a working reconnect.
   */
  succeed(): void
}

export function backoff(random: () => number = Math.random): Backoff {
  let attempt = 0
  return {
    get attempt() {
      return attempt
    },
    next() {
      const rung = RUNGS[Math.min(attempt, RUNGS.length - 1)] ?? RUNGS[RUNGS.length - 1]!
      const spread = rung * JITTER
      return Math.round(rung - spread + random() * spread * 2)
    },
    fail() {
      attempt += 1
    },
    succeed() {
      attempt = 0
    },
  }
}
