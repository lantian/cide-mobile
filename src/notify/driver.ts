/**
 * The loop that turns cide's awaiting set into notifications. (M75)
 *
 * Outside React, beside the connection registry and for the same reason: a notification must be
 * raised because a *turn finished*, not because a screen happened to be mounted. A component
 * that owned this would stop noticing the moment somebody navigated away, which is precisely
 * when they want to be told.
 *
 * It subscribes to the registry and runs `decide` on every change. That is more often than
 * strictly needed — the set moves for reasons that raise nothing — but `decide` is pure, cheap
 * and idempotent, and the alternative is a second rule about *when* to ask, which is one more
 * place for a missing notification to come from.
 */
import { AppState } from 'react-native'
import * as registry from '../store/registry'
import { acknowledge, decide, type Ledger } from './decide'
import { apply, dismissFor, prepare } from './notifier'

let ledger: Ledger = {}
let running = false
let allowed = false
/** The session a screen is showing, so a wait nobody is looking away from stays silent. */
let onScreen: string | null = null

/**
 * A console is on screen, or none is.
 *
 * Three things happen, and they are three because they are three different records of the same
 * fact — miss one and the marker survives somewhere.
 *
 *  1. cide's set. The screen sends `acknowledge` itself, which is what clears the mark in every
 *     cide window; nothing here does that, and it must stay that way — the set travels *from* a
 *     device one session at a time (`ui/src/panes/awaiting.ts`).
 *  2. This device's **ledger**, so the wait just looked at is not announced again on the next
 *     reconnect. Without it, closing and reopening the app re-notifies for a console that has
 *     already been read.
 *  3. The **tray**, which keeps showing what it was told until somebody takes it down. That was
 *     the visible half of the bug: the badge cleared and the notification stayed.
 */
export function watching(session: string | null): void {
  onScreen = session
  if (session === null) return
  ledger = acknowledge(ledger, session as never)
  void dismissFor(session)
}

/** Start the loop. Idempotent — the layout mounts once, but StrictMode runs effects twice. */
export function start(): () => void {
  if (running) return () => undefined
  running = true
  void prepare().then((granted) => {
    allowed = granted
  })
  const stop = registry.subscribe(() => {
    void tick()
  })
  return () => {
    running = false
    stop()
  }
}

async function tick(): Promise<void> {
  if (!allowed) return
  const state = AppState.currentState === 'active' ? 'active' : 'background'
  for (const view of registry.getSnapshot()) {
    const labels: Record<string, string> = {}
    for (const session of view.sessions) {
      labels[String(session.session)] = session.tabTitle ?? session.title
    }
    const decision = decide({
      instanceId: view.paired.instanceId,
      instanceLabel: view.paired.label,
      awaiting: view.awaiting,
      labels,
      // Nothing feeds this yet: a run that *ended* is a second signal, and the set is the one
      // cide already maintains across every window. Left empty rather than guessed at from
      // session states, which would announce an exit the desktop never called news.
      ended: [],
      ledger,
      openSession: (onScreen as never) ?? null,
      appState: state,
    })
    if (decision.raise.length === 0 && decision.dismiss.length === 0) {
      ledger = decision.ledger
      continue
    }
    ledger = await apply(decision)
  }
}

/**
 * Raise one, now. **Development only** — its one caller is behind `__DEV__`.
 *
 * The feature is otherwise unobservable until an agent happens to finish a turn, which makes
 * "does this device actually show them" expensive to answer while building it. It is not
 * something a shipped app offers: a button that sends a message saying nothing is pressed once,
 * out of curiosity, and never again.
 */
export async function demonstrate(instanceLabel: string): Promise<boolean> {
  const granted = await prepare()
  if (!granted) return false
  allowed = true
  await apply({
    raise: [
      {
        id: `demo:${Date.now()}`,
        channel: 'awaiting',
        title: instanceLabel,
        body: 'This is how you will be told a turn finished.',
        data: { instanceId: 'demo', session: 'demo' as never },
      },
    ],
    dismiss: [],
    ledger,
  })
  return true
}
