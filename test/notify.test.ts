/**
 * The notification decision.
 *
 * The most test-worthy thing in this app, because with no push service the *normal* case is that
 * a turn finished an hour ago and this runs when the phone is next picked up. Every way it can be
 * wrong is a way somebody either misses something or is buzzed about something they have already
 * dealt with, and neither raises an error.
 */
import { describe, expect, it } from 'vitest'
import { COLLAPSE_AT, acknowledge, decide, idFor, type Ledger } from '../src/notify/decide'
import type { AwaitingEntry, SessionId } from '../src/protocol/generated'

const s = (n: number) => `0000000${n}-0000-4000-8000-000000000000` as SessionId
const waiting = (n: number, since: number): AwaitingEntry => ({ session: s(n), sinceUnixMs: since })

const input = (over: Partial<Parameters<typeof decide>[0]> = {}) => ({
  instanceId: 'i-1',
  instanceLabel: 'thinkpad',
  awaiting: [] as AwaitingEntry[],
  labels: { [s(1)]: 'claude', [s(2)]: 'reviewer' },
  ended: [],
  ledger: {} as Ledger,
  openSession: null,
  appState: 'background' as const,
  ...over,
})

describe('decide', () => {
  it('announces a wait it has not announced', () => {
    const out = decide(input({ awaiting: [waiting(1, 1000)] }))
    expect(out.raise).toHaveLength(1)
    expect(out.raise[0]!.title).toBe('thinkpad — claude')
    expect(out.raise[0]!.id).toBe(idFor('i-1', s(1), 1000))
    expect(out.ledger[s(1)]).toEqual({ announced: 1000, acked: false })
  })

  it('says nothing the second time about the same wait', () => {
    // The reconnect case, which happens every time the app comes back. A boolean could not tell
    // this from the case below.
    const first = decide(input({ awaiting: [waiting(1, 1000)] }))
    const second = decide(input({ awaiting: [waiting(1, 1000)], ledger: first.ledger }))
    expect(second.raise).toHaveLength(0)
  })

  it('announces a second wait on a session it has already announced', () => {
    // It went busy and is waiting again. The stamp is the only thing that distinguishes this
    // from the case above, which is the entire reason cide carries one.
    const first = decide(input({ awaiting: [waiting(1, 1000)] }))
    const second = decide(input({ awaiting: [waiting(1, 5000)], ledger: first.ledger }))
    expect(second.raise).toHaveLength(1)
    expect(second.raise[0]!.id).toBe(idFor('i-1', s(1), 5000))
  })

  it('never buzzes about the session on screen', () => {
    const out = decide(
      input({ awaiting: [waiting(1, 1000)], openSession: s(1), appState: 'active' }),
    )
    expect(out.raise).toHaveLength(0)
    // And it counts as seen, so leaving that screen does not make it news again.
    expect(out.ledger[s(1)]).toEqual({ announced: 1000, acked: true })
  })

  it('does buzz about it when the app is in the background', () => {
    // `openSession` is the *last* screen when the app is not on top, and a turn that finished
    // while the phone was in a pocket is exactly what this feature is for.
    const out = decide(
      input({ awaiting: [waiting(1, 1000)], openSession: s(1), appState: 'background' }),
    )
    expect(out.raise).toHaveLength(1)
  })

  it('reconciles a day of silence into one announcement per session', () => {
    // The normal case. Nothing arrived while the OS had the app suspended; this is what the
    // first reconnect does about it.
    const out = decide(input({ awaiting: [waiting(1, 1000), waiting(2, 2000)] }))
    expect(out.raise.map((r) => r.data.session)).toEqual([s(1), s(2)])
  })

  it('collapses a burst rather than filling the shade', () => {
    const many = Array.from({ length: COLLAPSE_AT + 2 }, (_, i) => waiting(i, 1000 + i))
    const out = decide(input({ awaiting: many }))
    expect(out.raise).toHaveLength(1)
    expect(out.raise[0]!.body).toContain(`${COLLAPSE_AT + 2} sessions`)
    // Every one of them is still recorded, so none of them is announced twice later.
    for (const entry of many) {
      expect(out.ledger[String(entry.session)]!.announced).toBe(Number(entry.sinceUnixMs))
    }
  })

  it('takes down what has stopped waiting', () => {
    const first = decide(input({ awaiting: [waiting(1, 1000)] }))
    const second = decide(input({ awaiting: [], ledger: first.ledger }))
    expect(second.dismiss).toEqual([idFor('i-1', s(1), 1000)])
    expect(second.raise).toHaveLength(0)
  })

  it('announces a session that ended, once', () => {
    const ended = [{ session: s(2), label: 'reviewer', endedUnixMs: 4000 }]
    const first = decide(input({ ended }))
    expect(first.raise).toHaveLength(1)
    expect(first.raise[0]!.channel).toBe('finished')
    expect(decide(input({ ended, ledger: first.ledger })).raise).toHaveLength(0)
  })

  it('does not take down something it is announcing in the same breath', () => {
    const ended = [{ session: s(2), label: 'reviewer', endedUnixMs: 4000 }]
    const out = decide(input({ ended }))
    expect(out.dismiss).not.toContain(out.raise[0]!.id)
  })

  it('falls back to a name rather than showing an id', () => {
    const out = decide(input({ awaiting: [waiting(9, 1000)] }))
    expect(out.raise[0]!.title).toBe('thinkpad — a session')
  })
})

describe('acknowledge', () => {
  it('stays quiet about a wait that was opened, across a reconnect', () => {
    // The half that is invisible until it is not. Opening a console clears cide's mark and the
    // tray entry immediately; the *ledger* is what stops the same wait being announced again
    // the next time the app reconnects and re-reads the whole set.
    //
    // Without it, closing and reopening the app re-notifies for a console already read — which
    // is the failure mode this feature has to avoid above all others, because an app that
    // repeats itself is one whose notifications get switched off.
    const first = decide(input({ awaiting: [waiting(1, 1_000)] }))
    expect(first.raise).toHaveLength(1)

    const opened = acknowledge(first.ledger, s(1))
    const again = decide(input({ awaiting: [waiting(1, 1_000)], ledger: opened }))
    expect(again.raise).toEqual([])

    // And a *new* wait on that same session is still news: the user looked at the last one.
    const later = decide(input({ awaiting: [waiting(1, 2_000)], ledger: opened }))
    expect(later.raise).toHaveLength(1)
  })

  it('marks a session seen without inventing one', () => {
    const first = decide(input({ awaiting: [waiting(1, 1000)] }))
    const after = acknowledge(first.ledger, s(1))
    expect(after[s(1)]!.acked).toBe(true)
    // A session it has never heard of stays unheard of: an acknowledgement is not a claim that
    // something was waiting.
    expect(acknowledge(first.ledger, s(7))).toBe(first.ledger)
  })
})
