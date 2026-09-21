/**
 * Every paired instance's connection, and a way for a component to watch one.
 *
 * Module-level and outside React, for `paneHosts.ts`'s reason in cide itself: a connection must
 * outlive the component that happened to open it. A screen that unmounts because the user pushed
 * another one must not tear down the socket it was watching, or every navigation costs a
 * handshake and every screen shows a board that is being fetched again.
 *
 * Deliberately small. It holds connections, the last snapshot each one sent, and a subscriber
 * list; everything else a screen needs it asks for.
 */
import { Connection, wsDial, type Paired, type Phase } from '../net/connection'
import type {
  AgentRun,
  AwaitingEntry,
  PermissionPrompt,
  RemoteAgent,
  TaskRow,
  RemoteProject,
  RemoteSession,
  ScreenUpdate,
  ServerBody,
} from '../protocol/generated'
import { ScreenStore } from '../term/screenStore'
import { HistoryStore } from '../term/history'

export interface InstanceView {
  readonly paired: Paired
  readonly phase: Phase
  readonly detail: string | undefined
  readonly projects: readonly RemoteProject[]
  readonly sessions: readonly RemoteSession[]
  readonly awaiting: readonly AwaitingEntry[]
  /**
   * The permission question each watched session is asking, by session id.
   *
   * In the view rather than in component state because it arrives as its own frame, at any
   * moment, from a socket that outlives the screen — and because a screen that had to ask for it
   * on mount would show a blank card for one round trip on the one card that matters.
   */
  readonly prompts: Readonly<Record<string, PermissionPrompt>>
  /**
   * The subscribed project's agent runs, roles and tasks. (M75)
   *
   * All three are **per project** and arrive together, which is why they sit beside each other
   * here: the Agents screen draws a row from the roster and its state from the runs, and a view
   * that could hold one without the other is a screen that renders half a row.
   *
   * Empty until something is subscribed. That is indistinguishable from "this project has no
   * agents", and deliberately so — cide flattens its own three-state answers (no tracker, empty
   * tracker, ready) to a list for the same reason: the sentences that tell them apart name a
   * path on a machine nobody holding the phone is sitting at.
   */
  /**
   * Keyed by project, and that is a correctness requirement rather than a convenience.
   *
   * cide sends these three for **every** project a device is subscribed to, one frame each. A
   * flat field would be overwritten by whichever project's frame arrived last, so a machine with
   * two projects open would show one of them — changing, at random, every time the coalescer
   * ticked. Keyed, each frame lands in its own slot and a screen chooses which to read.
   */
  readonly runs: Readonly<Record<string, readonly AgentRun[]>>
  readonly roster: Readonly<Record<string, readonly RemoteAgent[]>>
  /**
   * Whether each project's queue will start anything new.
   *
   * Separate from the runs, because pausing a project does two things and a device is owed
   * both: it shuts the queue *and* freezes the children. A project paused while nothing
   * happened to be running is indistinguishable from an idle one without this — which is
   * exactly how a paused `selfcraft` arrived on a phone looking perfectly ordinary.
   *
   * Absent means *not known yet*, which reads as dispatching: a screen that drew "paused"
   * before the first roster landed would be accusing every project of being paused for one
   * round trip.
   */
  readonly dispatching: Readonly<Record<string, boolean>>
  readonly tasks: Readonly<Record<string, readonly TaskRow[]>>
}

interface Entry {
  connection: Connection
  view: InstanceView
  screens: Map<string, ScreenStore>
  /** The scrollback each watched session has had read, keyed the same way. */
  histories: Map<string, HistoryStore>
}

const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()
let snapshot: InstanceView[] = []

function announce(): void {
  // Rebuilt once per change and handed out by identity, because `useSyncExternalStore` compares
  // with `Object.is` — a snapshot built per call re-renders for ever.
  snapshot = [...entries.values()].map((entry) => entry.view)
  for (const listener of listeners) listener()
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getSnapshot(): InstanceView[] {
  return snapshot
}

export function viewOf(instanceId: string): InstanceView | undefined {
  return entries.get(instanceId)?.view
}

export function connectionOf(instanceId: string): Connection | undefined {
  return entries.get(instanceId)?.connection
}

/** The grid for one session, created on first ask. */
export function screenOf(instanceId: string, session: string): ScreenStore {
  const entry = entries.get(instanceId)
  if (entry === undefined) return new ScreenStore()
  let screen = entry.screens.get(session)
  if (screen === undefined) {
    screen = new ScreenStore()
    entry.screens.set(session, screen)
  }
  return screen
}

/**
 * The scrollback for one session, created on first ask.
 *
 * Separate from the grid rather than a field of it, because the two are filled by different
 * frames at different times and only one of them is ever thrown away by a resize: a new epoch
 * re-numbers the *viewport* and says nothing about the lines that have already scrolled off.
 */
export function historyOf(instanceId: string, session: string): HistoryStore {
  const entry = entries.get(instanceId)
  if (entry === undefined) return new HistoryStore()
  let history = entry.histories.get(session)
  if (history === undefined) {
    history = new HistoryStore()
    entry.histories.set(session, history)
  }
  return history
}

/** Bring an instance up, or leave it alone if it is already here. */
export function open(paired: Paired): void {
  if (entries.has(paired.instanceId)) return

  const connection = new Connection({
    paired,
    dial: wsDial,
    onPhase: (phase, detail) => {
      const entry = entries.get(paired.instanceId)
      if (entry === undefined) return
      entry.view = { ...entry.view, phase, detail }
      announce()
    },
    onEvent: (body) => receive(paired.instanceId, body),
  })

  entries.set(paired.instanceId, {
    connection,
    view: {
      paired,
      phase: 'idle',
      detail: undefined,
      projects: [],
      sessions: [],
      awaiting: [],
      prompts: {},
      runs: {},
      roster: {},
      dispatching: {},
      tasks: {},
    },
    screens: new Map(),
    histories: new Map(),
  })
  announce()
  connection.start()
}

/**
 * This device has looked at a session: drop its marker now, without waiting to be told. (M75)
 *
 * cide's set stays authoritative — the very next `awaiting` frame replaces this wholesale, so a
 * session cide still considers waiting comes straight back. What this removes is the *gap*: the
 * screen sends `acknowledge`, cide updates its set, emits, and the frame comes back over the
 * network, and for all of that time the badge sits there on a console the user is looking at.
 * A marker that survives the act of reading it is the clearest possible way of saying the
 * button did not work.
 *
 * Optimistic in one direction only, which is the safe one: it can hide a marker a beat early,
 * and it cannot invent one. The mirror image — waiting for confirmation — cannot be made safe,
 * because a push that never arrives leaves the marker up for ever with nothing to notice it.
 */
export function acknowledged(instanceId: string, session: string): void {
  const entry = entries.get(instanceId)
  if (entry === undefined) return
  const remaining = entry.view.awaiting.filter((item) => String(item.session) !== session)
  if (remaining.length === entry.view.awaiting.length) return
  entry.view = { ...entry.view, awaiting: remaining }
  announce()
}

export function close(instanceId: string): void {
  const entry = entries.get(instanceId)
  if (entry === undefined) return
  entry.connection.stop()
  entries.delete(instanceId)
  announce()
}

function receive(instanceId: string, body: ServerBody): void {
  const entry = entries.get(instanceId)
  if (entry === undefined) return

  switch (body.t) {
    case 'projects':
      entry.view = { ...entry.view, projects: body.projects }
      break
    case 'sessions':
      entry.view = { ...entry.view, sessions: body.sessions }
      break
    case 'awaiting':
      entry.view = { ...entry.view, awaiting: body.entries }
      break
    // The three per-project reads. Replaced wholesale rather than merged: each is the answer to
    // "what is true now", and a merge would keep a run cide has forgotten.
    // Replaced per project, never merged across them: each frame is the whole answer for the
    // project it names, and a merge would keep a run cide has forgotten.
    case 'runs':
      entry.view = {
        ...entry.view,
        runs: { ...entry.view.runs, [String(body.project)]: body.runs },
      }
      break
    case 'roster':
      entry.view = {
        ...entry.view,
        roster: { ...entry.view.roster, [String(body.project)]: body.agents },
        dispatching: { ...entry.view.dispatching, [String(body.project)]: body.dispatching },
      }
      break
    case 'board':
      entry.view = {
        ...entry.view,
        tasks: { ...entry.view.tasks, [String(body.project)]: body.tasks },
      }
      break
    case 'sessionState': {
      // Patched in place rather than re-fetched: a transition arrives several times a second
      // during a turn, and asking for the whole list each time would be the 2.25 MB task board's
      // mistake on a phone.
      const sessions = entry.view.sessions.map((session) =>
        String(session.session) === String(body.session) ? { ...session, state: body.state } : session,
      )
      entry.view = { ...entry.view, sessions }
      break
    }
    case 'prompt': {
      entry.view = {
        ...entry.view,
        prompts: { ...entry.view.prompts, [String(body.session)]: body.prompt },
      }
      break
    }
    case 'promptGone': {
      // Said out loud by cide rather than left to silence, because a card that has stopped
      // changing and a card about a question somebody answered at the desk are one picture.
      const prompts = { ...entry.view.prompts }
      delete prompts[String(body.session)]
      entry.view = { ...entry.view, prompts }
      break
    }
    case 'screen': {
      applyScreen(entry, body.update)
      // A repaint is not a list change; announcing here would re-render every screen in the app
      // ten times a second. The row stores tell their own subscribers.
      return
    }
    case 'screenGone': {
      entry.screens.get(String(body.session))?.forget()
      entry.histories.get(String(body.session))?.forget()
      return
    }
    case 'scrollback': {
      const key = String(body.session)
      let history = entry.histories.get(key)
      if (history === undefined) {
        history = new HistoryStore()
        entry.histories.set(key, history)
      }
      history.absorb(body.page)
      // Its own subscribers, for `screen`'s reason: a page is not a list change.
      return
    }
    case 'desync':
      // Whatever was missed, the cure is the same: ask again for everything subscribed.
      entry.connection.tell({ t: 'subscribe', projects: entry.view.projects.map((p) => p.id) })
      return
    default:
      return
  }
  announce()
}

function applyScreen(entry: Entry, update: ScreenUpdate): void {
  const key = String(update.session)
  let screen = entry.screens.get(key)
  if (screen === undefined) {
    screen = new ScreenStore()
    entry.screens.set(key, screen)
  }
  const applied = screen.apply(update)
  if (applied.kind === 'desynced') {
    // A row that will not fit the grid this device holds. Re-watching is the only correct
    // response: there is no way to know what the frame that would have resized it said.
    entry.connection.tell({ t: 'unwatchScreen', session: update.session })
    entry.connection.tell({ t: 'watchScreen', session: update.session })
  }
}
