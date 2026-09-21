/**
 * The reconnect ladder.
 *
 * Small, and worth its own file: a backoff policy is the kind of thing that looks obviously
 * right and is wrong in one of three ways, none of which raise an error. It waits the wrong
 * amount, it resets on the wrong event, or it resets in lockstep with every other instance that
 * went away at the same moment.
 */
import { describe, expect, it } from 'vitest'
import { JITTER, RUNGS, backoff } from '../src/net/backoff'

describe('backoff', () => {
  it('walks the ladder and then stays at the top', () => {
    const b = backoff(() => 0.5)
    const waits: number[] = []
    for (let i = 0; i < RUNGS.length + 3; i++) {
      waits.push(b.next())
      b.fail()
    }
    expect(waits.slice(0, RUNGS.length)).toEqual([...RUNGS])
    // The last rung repeats rather than growing without bound: half an hour between attempts is
    // already "the user will open the app before this fires".
    expect(waits.slice(RUNGS.length)).toEqual([RUNGS[RUNGS.length - 1], RUNGS[RUNGS.length - 1], RUNGS[RUNGS.length - 1]])
  })

  it('stays within the jitter band, on both edges', () => {
    for (const random of [() => 0, () => 1, () => 0.5]) {
      const b = backoff(random)
      for (const rung of RUNGS) {
        const wait = b.next()
        expect(wait).toBeGreaterThanOrEqual(Math.round(rung * (1 - JITTER)))
        expect(wait).toBeLessThanOrEqual(Math.round(rung * (1 + JITTER)))
        b.fail()
      }
    }
  })

  it('actually spreads, which is the whole reason the jitter exists', () => {
    // Several instances that went away together — a laptop closing its lid — come back together,
    // and without this they retry in lockstep for ever.
    const seen = new Set<number>()
    for (let i = 0; i < 200; i++) {
      seen.add(backoff(Math.random).next())
    }
    expect(seen.size).toBeGreaterThan(50)
  })

  it('resets to the first rung on success and only on success', () => {
    const b = backoff(() => 0.5)
    b.fail()
    b.fail()
    expect(b.next()).toBe(RUNGS[2])
    b.succeed()
    expect(b.attempt).toBe(0)
    expect(b.next()).toBe(RUNGS[0])
  })
})
