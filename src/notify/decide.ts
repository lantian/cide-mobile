/**
 * Which notifications to raise, which to take down, and what to remember.
 *
 * Pure, because it is the only place a duplicate or a missing notification can come from, and
 * because every input to it — the time, the set, the ledger, what is on screen — is something a
 * test can simply state.
 *
 * # Why a stamp and not a flag
 *
 * cide's awaiting set carries, per entry, the moment that wait **began** — written on arrival and
 * never touched while the entry stays, because three windows observe one transition and all three
 * report it. A device is asleep for most of that and reconnects to a *set*, from which a boolean
 * cannot distinguish "the wait I already told you about" from "it went busy and is waiting
 * again". Without the stamp the only choices are notifying on every reconnect and staying silent
 * on the second wait; with it the rule is a comparison.
 *
 * # Reconcile is the mechanism, not the fallback
 *
 * There is no push service. Nothing arrives while the OS has the app suspended — iOS always,
 * Android often — so the *normal* case is that a turn finished an hour ago and this runs when the
 * app is opened. That is why nothing here is conditioned on "was this recent": anything in the
 * set that is newer than what was announced is news, however old it is.
 */
import type { AwaitingEntry, SessionId } from '../protocol/generated'

/** What this device has already said about one session. */
export interface LedgerEntry {
  /** The `sinceUnixMs` of the most recent wait announced for it. */
  readonly announced: number
  /** The user has opened or acknowledged it since. */
  readonly acked: boolean
}

export type Ledger = Readonly<Record<string, LedgerEntry>>

/** Something that stopped rather than started waiting. */
export interface Ended {
  readonly session: SessionId
  readonly label: string
  readonly endedUnixMs: number
}

/**
 * What a notification calls one session: the console, and the project it belongs to.
 *
 * Both, always. A machine runs several projects at once and every Claude console on it calls
 * itself `claude`, so a notification that named only the console — or, before the session list
 * had arrived, only "a session" — told somebody *that* something was waiting and never *what*,
 * which is the one thing a notification is for.
 */
export interface SessionLabel {
  readonly console: string
  /** Absent while the project list is still arriving; the title then carries the machine alone. */
  readonly project: string | null
}

/** `thinkpad · cide`, or the machine alone when the project is not known. */
export function titleOf(instanceLabel: string, label: SessionLabel): string {
  return label.project === null ? instanceLabel : `${instanceLabel} · ${label.project}`
}

export interface DecideInput {
  readonly instanceId: string
  readonly instanceLabel: string
  /** cide's authoritative set, whole. */
  readonly awaiting: readonly AwaitingEntry[]
  /**
   * What each session should be called in a notification — only the sessions this device can
   * list. A wait on a session missing here is **held back**, not announced with a placeholder.
   */
  readonly labels: Readonly<Record<string, SessionLabel>>
  readonly ended: readonly Ended[]
  readonly ledger: Ledger
  /** The session on screen right now, if the app is in the foreground looking at one. */
  readonly openSession: SessionId | null
  readonly appState: 'active' | 'background'
}

export interface Raise {
  /**
   * Stable, so a repeat replaces rather than stacks.
   *
   * It carries the stamp: the *same* wait announced twice is one notification, and a second wait
   * on the same session is a new one. That is the whole rule, spelled into the identifier so the
   * platform enforces it too.
   */
  readonly id: string
  readonly channel: 'awaiting' | 'finished'
  readonly title: string
  readonly body: string
  /** Everything the tap handler needs. The route is derived, not stored — see `route.ts`. */
  readonly data: { instanceId: string; session: SessionId }
}

export interface Decision {
  readonly raise: readonly Raise[]
  /** Identifiers to take down. */
  readonly dismiss: readonly string[]
  readonly ledger: Ledger
}

/** Above this many at once, they collapse into one. */
export const COLLAPSE_AT = 3

export function idFor(instanceId: string, session: SessionId, since: number): string {
  return `sess:${instanceId}:${session}:${since}`
}

/** The one notification a collapsed burst becomes. */
export function summaryId(instanceId: string): string {
  return `sess:${instanceId}:summary`
}

export function decide(input: DecideInput): Decision {
  const ledger: Record<string, LedgerEntry> = { ...input.ledger }
  const raise: Raise[] = []
  const dismiss: string[] = []

  const waiting = new Set(input.awaiting.map((entry) => String(entry.session)))

  for (const entry of input.awaiting) {
    const key = String(entry.session)
    const since = Number(entry.sinceUnixMs)
    const known = ledger[key]

    // **Not yet: nothing to call it, and nothing to open.** The set can name a session the list
    // does not — the `awaiting` frame of a reconnect lands before `sessions`, and a closed tab
    // parks a child that can go on waiting with no pane anywhere. Announcing either produced
    // "thinkpad — a session: Waiting for you", whose tap opened a console with no row behind it.
    // No ledger write, so the moment the list names it the next tick announces it properly; a
    // parked child that never gets a pane is never announced, which is what the badge on the
    // machine list already does (`waitingByProject`).
    const label = input.labels[key]
    if (label === undefined) continue

    // Already told them about *this* wait. Not about this session — about this wait, which is
    // what lets a second one through.
    if (known !== undefined && known.announced >= since) continue

    // A new wait clears the acknowledgement: the user looked at the last one, not this one.
    ledger[key] = { announced: since, acked: false }

    // Never for the session they are looking at. The notification would be about the thing on
    // their screen, which is noise at best and a vibration in their hand at worst.
    if (input.appState === 'active' && input.openSession !== null && String(input.openSession) === key) {
      ledger[key] = { announced: since, acked: true }
      continue
    }

    raise.push({
      id: idFor(input.instanceId, entry.session, since),
      channel: 'awaiting',
      title: titleOf(input.instanceLabel, label),
      body: `${label.console} is waiting for you.`,
      data: { instanceId: input.instanceId, session: entry.session },
    })
  }

  for (const ended of input.ended) {
    const key = String(ended.session)
    const known = ledger[key]
    if (known !== undefined && known.announced >= ended.endedUnixMs) continue
    ledger[key] = { announced: ended.endedUnixMs, acked: false }
    if (input.appState === 'active' && input.openSession !== null && String(input.openSession) === key) {
      ledger[key] = { announced: ended.endedUnixMs, acked: true }
      continue
    }
    const label = input.labels[key] ?? { console: ended.label, project: null }
    raise.push({
      id: idFor(input.instanceId, ended.session, ended.endedUnixMs),
      channel: 'finished',
      title: titleOf(input.instanceLabel, label),
      body: `${label.console} finished.`,
      data: { instanceId: input.instanceId, session: ended.session },
    })
  }

  // Anything that has stopped waiting has nothing left to say. Taking it down matters more here
  // than it would with push, because these can be hours old by the time anybody looks.
  for (const [key, entry] of Object.entries(ledger)) {
    if (waiting.has(key)) continue
    if (input.ended.some((e) => String(e.session) === key)) continue
    dismiss.push(idFor(input.instanceId, key as SessionId, entry.announced))
  }

  // **And the summary, once nothing it spoke about is still unread.** It names no session of
  // its own — its payload carries the first one's, for the tap — so neither the per-session
  // dismissals above nor `dismissFor` on opening a console could ever reach it: a burst of five
  // left `5 sessions are waiting for you` in the tray after all five had been read, and opening
  // any one of them from the tray did nothing to it. That was the reported "wrong count" and
  // "opening it doesn't clear the notification".
  const unread = input.awaiting.some((entry) => ledger[String(entry.session)]?.acked !== true)
  if (!unread && raise.length === 0) dismiss.push(summaryId(input.instanceId))

  if (raise.length > COLLAPSE_AT) {
    // A burst is the *ordinary* outcome of opening the app after a day away, so it collapses
    // rather than filling the shade with one row per session.
    const summary: Raise = {
      id: summaryId(input.instanceId),
      channel: 'awaiting',
      title: input.instanceLabel,
      // Named, not just counted: "5 sessions" sends somebody into the app to find out which.
      body: `${raise.length} waiting: ${raise
        .map((r) => {
          const label = input.labels[String(r.data.session)]
          return label === undefined ? '' : label.project === null ? label.console : `${label.project}/${label.console}`
        })
        .filter((name) => name !== '')
        .join(', ')}`,
      data: { instanceId: input.instanceId, session: raise[0]!.data.session },
    }
    return { raise: [summary], dismiss, ledger }
  }

  return { raise, dismiss, ledger }
}

/** The user opened or acknowledged a session: stop talking about it. */
export function acknowledge(ledger: Ledger, session: SessionId): Ledger {
  const key = String(session)
  const known = ledger[key]
  if (known === undefined) return ledger
  return { ...ledger, [key]: { ...known, acked: true } }
}

/** Forget an instance entirely — what revoking it must also do. */
export function forgetInstance(ledger: Ledger, sessions: readonly SessionId[]): Ledger {
  const next = { ...ledger }
  for (const session of sessions) delete next[String(session)]
  return next
}
