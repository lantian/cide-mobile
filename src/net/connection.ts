/**
 * One cide instance, and everything about staying connected to it.
 *
 * # Injected, not imported
 *
 * The socket and the clock are parameters. That is not testing ceremony — it is the only way the
 * things worth asserting here *can* be asserted: a backoff sequence, a heartbeat that fires, a
 * reconnect that replays its subscriptions, a request rejected because the socket went away.
 * Every one of those is a behaviour over time, and a test that waited for real time would take
 * minutes and flake.
 *
 * # The three rules that are wrong in ways nothing throws
 *
 *  * **Backoff resets on a completed handshake, never on an open socket.** A server that accepts
 *    and immediately rejects — a revoked device, a protocol mismatch, a half-open port — opens a
 *    socket every time. Resetting there is an unthrottled loop that looks like a working
 *    reconnect and drains a battery in an afternoon.
 *  * **A protocol mismatch is terminal.** No retry, ever. A reconnect storm against a peer that
 *    will never agree is the worst failure available here: it explains nothing and costs
 *    everything.
 *  * **Interests are declared, not commanded.** The app says what it wants to be told about; this
 *    re-sends the whole set after every handshake. A delta protocol cannot survive a reconnect,
 *    because the server has no way to tell a repeat from a change.
 */
import {
  Channel,
  Mode,
  beginHandshake,
  decodeGreeting,
  deriveChannel,
  encodeHandshake,
  type Handshake,
} from '../crypto/seal'
import { decodeUtf8, encodeUtf8 } from '../crypto/utf8'
import type { ClientBody, ClientFrame, ProjectId, ServerBody, ServerFrame } from '../protocol/generated'
import { PROTOCOL_VERSION, compatible, mismatch } from '../protocol/version'
import { backoff, type Backoff } from './backoff'

/** How long a handshake may take before the socket is abandoned. */
export const HANDSHAKE_TIMEOUT = 15_000
/** How often to ping. RN's `WebSocket` exposes no protocol-level ping, so this is app-level. */
export const HEARTBEAT_EVERY = 20_000
/** How long a pong may take before the connection is presumed dead. */
export const HEARTBEAT_TIMEOUT = 10_000
/** How long a request may go unanswered. */
export const REQUEST_TIMEOUT = 15_000
/** How long to race each candidate address before trying the next. */
export const CANDIDATE_TIMEOUT = 3_000

export type Phase =
  | 'idle'
  | 'connecting'
  | 'handshaking'
  | 'ready'
  | 'backoff'
  /** This app and that cide will never agree. Terminal: no retry. */
  | 'incompatible'
  /** That cide does not know this device any more. Terminal: no retry. */
  | 'revoked'

/** What pairing established, and what this app stored. */
export interface Paired {
  /** Stable for the life of the instance's state directory — the only thing that identifies it. */
  readonly instanceId: string
  /** What to call it before it has said its own name. */
  readonly label: string
  /**
   * Addresses to try, in order, as `host:port`.
   *
   * A list because a machine has several and the useful one changes with the network. The one
   * that answered is remembered by the caller and tried first next time.
   */
  readonly hosts: readonly string[]
  readonly deviceId: string
  readonly serverPublic: Uint8Array
  readonly key: Uint8Array
}

/** What this connection wants to be told about. */
export interface Interests {
  readonly projects: readonly ProjectId[]
}

/** The socket, as this module needs it. */
export interface Wire {
  send(bytes: Uint8Array): void
  close(): void
}

export interface WireHandlers {
  onOpen(): void
  onMessage(data: Uint8Array): void
  onClose(): void
  onError(error: unknown): void
}

/** How a socket is opened. Replaced in tests; `wsDial` in the app. */
export type Dial = (url: string, handlers: WireHandlers) => Wire

/** The clock, so a test can run a day in a millisecond. */
export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface ConnectionOptions {
  paired: Paired
  dial: Dial
  clock?: Clock
  random?: () => number
  /** Every frame the server sent that was not the answer to a request. */
  onEvent?: (body: ServerBody) => void
  onPhase?: (phase: Phase, detail?: string) => void
}

/** A request that was outstanding when the socket went away. */
export class Disconnected extends Error {
  constructor() {
    super('the connection to cide went away before that was answered')
  }
}

/** One spelling of "are these the same key", shared with the pairing road. */
function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}

export class Connection {
  private phase: Phase = 'idle'
  private detail: string | undefined
  private wire: Wire | null = null
  private channel: Channel | null = null
  private readonly back: Backoff
  private readonly clock: Clock
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (body: ServerBody) => void; reject: (error: Error) => void; timer: unknown }
  >()
  private interests: Interests = { projects: [] }
  /**
   * The consoles a screen is showing, re-watched after every handshake.
   *
   * An interest like the projects, for the header's reason, and it has to be: `tell` drops what
   * it is handed before `ready`. A notification's tap routes **first** and connects behind it,
   * so the console screen mounted, said `watchScreen` into a socket still handshaking, and the
   * saying went nowhere — nothing re-sent it, the effect's only dependency being this very
   * object, and the console sat on "Waiting for the first frame…" for ever. Every reconnect
   * while a console was open did the same thing more quietly.
   */
  private readonly watched = new Set<string>()
  /** Consoles opened while the socket was down, whose `acknowledge` is owed on the next `ready`. */
  private readonly looked = new Set<string>()
  /**
   * The input counter, **per socket**, shared by every screen that writes.
   *
   * cide drops a write whose `seq` is not above the last one it applied from this device on this
   * socket (`accept_write`, keyed by device, epoch'd by connection). It was a `useRef(1)` in the
   * console screen, so leaving a console and opening it again on the same socket restarted the
   * count under a watermark in the dozens, and every key — PgUp most visibly, being the one
   * nobody types around — was discarded, answered `ok`, until the new count overtook the old.
   * Reset on `welcome`, when the epoch changes with it.
   */
  private seq = 1
  /** What the cide on the other end said it can do, in its `welcome`. Empty until then. */
  private features: ReadonlySet<string> = new Set()
  private timers: unknown[] = []
  private stopped = false
  /** The host that answered last, tried first next time. */
  private preferred: string | undefined
  /** The id of the ping this connection is waiting on, if any. */
  private awaitingPong: number | null = null

  constructor(private readonly options: ConnectionOptions) {
    this.clock = options.clock ?? systemClock
    this.back = backoff(options.random)
  }

  get state(): { phase: Phase; detail: string | undefined } {
    return { phase: this.phase, detail: this.detail }
  }

  /** Where this connection will try first. Remembered across attempts. */
  get preferredHost(): string | undefined {
    return this.preferred
  }

  /** Declare what to be told about. Re-sent after every handshake; see the header. */
  setInterests(interests: Interests): void {
    this.interests = interests
    if (this.phase === 'ready') {
      this.tell({ t: 'subscribe', projects: [...interests.projects] })
    }
  }

  start(): void {
    this.stopped = false
    if (this.phase === 'idle' || this.phase === 'backoff') {
      this.open()
    }
  }

  /** Stop, and stay stopped. Rejects everything outstanding rather than leaving it hanging. */
  stop(): void {
    this.stopped = true
    this.teardown('idle')
  }

  /**
   * Try again now, cancelling any wait.
   *
   * What the foreground transition and a pull-to-refresh call. Deliberately refuses when the
   * phase is terminal: the two terminal states are ones no amount of retrying resolves, and a
   * refresh gesture that silently did nothing is better than one that pretends.
   */
  retryNow(): boolean {
    if (this.phase === 'incompatible' || this.phase === 'revoked') return false
    this.stopped = false
    this.clearTimers()
    this.open()
    return true
  }

  /** Ask cide something and wait for the answer. */
  async request(body: ClientBody): Promise<ServerBody> {
    if (this.phase !== 'ready') throw new Disconnected()
    const id = this.nextId++
    return new Promise<ServerBody>((resolve, reject) => {
      const timer = this.clock.setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('cide did not answer that in time'))
      }, REQUEST_TIMEOUT)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ id, body })
    })
  }

  /** Whether the cide on the other end offers `feature` — for a frame an older one would refuse. */
  has(feature: string): boolean {
    return this.features.has(feature)
  }

  /** The next input number. See `seq`. */
  nextSeq(): number {
    return this.seq++
  }

  /** Show this console's screen, now or as soon as the socket is up — and after every reconnect. */
  watch(session: string): void {
    this.watched.add(session)
    this.tell({ t: 'watchScreen', session: session as never })
  }

  unwatch(session: string): void {
    this.watched.delete(session)
    this.tell({ t: 'unwatchScreen', session: session as never })
  }

  /** This console has been looked at. Kept until it can be said, rather than dropped. */
  acknowledge(session: string): void {
    if (this.phase === 'ready') this.tell({ t: 'acknowledge', session: session as never })
    else this.looked.add(session)
  }

  /** Say something that expects no answer. */
  tell(body: ClientBody): void {
    if (this.phase !== 'ready' && body.t !== 'hello' && body.t !== 'pair') return
    this.send({ body })
  }

  // --- the machine ------------------------------------------------------------------------

  private open(): void {
    // A fresh life inherits no timer from the last one — including the reconnect that
    // scheduled this call, which has fired and must not be waited on twice. See `dropped`,
    // which explains why both clears exist when either would do.
    this.clearTimers()
    this.closeWire()
    this.enter('connecting')

    const hosts = this.candidates()
    const host = hosts[0]
    if (host === undefined) {
      this.fail('this instance has no address to try')
      return
    }

    const { handshake, secret } = beginHandshake(Mode.Resume, this.options.paired.deviceId)
    let settled = false
    // cide greets before anything is sealed, so the first message on every socket is one. It is
    // read and *checked* rather than skipped: this end already holds the key it paired with, so
    // the greeting is never evidence here — but a greeting carrying a different key is a fact
    // worth a sentence, because the alternative is a channel that derives cleanly, opens
    // nothing, and reads exactly like a bad network for as long as the user keeps retrying.
    let greeted = false

    const wire = this.options.dial(`ws://${host}`, {
      onOpen: () => {
        this.enter('handshaking')
        wire.send(encodeHandshake(handshake))
        this.channel = deriveChannel(
          secret,
          this.options.paired.serverPublic,
          handshake,
          this.options.paired.key,
        )
        // The handshake is one-way: nothing comes back until `hello` is answered, so the proof
        // that the key is right is the first frame that opens.
        this.send({ id: this.nextId++, body: { t: 'hello', protocol: PROTOCOL_VERSION, client: this.client() } })
      },
      onMessage: (data) => {
        settled = true
        if (!greeted) {
          greeted = true
          const greeting = decodeGreeting(data)
          if (greeting !== null) {
            if (!sameKey(greeting.serverPublic, this.options.paired.serverPublic)) {
              this.terminal(
                'revoked',
                'that machine is not the cide this phone paired with — its key has changed. ' +
                  'Pair again from its Settings screen.',
              )
              return
            }
            // Nothing else to do with it: the channel was derived from the pinned key, which is
            // the one this connection is entitled to talk to.
            return
          }
          // Not a greeting. An older cide that does not send one would land here, and so would
          // a sealed frame arriving first — both are handled by falling through, so a server
          // that stops greeting degrades to the previous behaviour rather than to silence.
        }
        this.receive(data, handshake)
      },
      onClose: () => {
        if (!settled) this.preferred = undefined
        this.dropped('the connection closed')
      },
      onError: (error) => {
        this.dropped(error instanceof Error ? error.message : 'the connection failed')
      },
    })
    this.wire = wire
    this.preferred = host

    this.after(HANDSHAKE_TIMEOUT, () => {
      if (this.phase === 'connecting' || this.phase === 'handshaking') {
        this.dropped('cide did not answer the handshake')
      }
    })
  }

  /** The addresses to try, most likely first. */
  private candidates(): string[] {
    const all = [...this.options.paired.hosts]
    if (this.preferred !== undefined) {
      return [this.preferred, ...all.filter((h) => h !== this.preferred)]
    }
    return all
  }

  private receive(data: Uint8Array, handshake: Handshake): void {
    // The one thing cide says in the clear: a refusal to a device it does not know. It is JSON,
    // not a sealed frame, and it is the difference between "you were removed" and a socket that
    // opens and goes quiet.
    if (this.looksLikeText(data)) {
      const body = this.parse(data)
      if (body?.t === 'error' && body.kind === 'unauthorized') {
        this.terminal('revoked', body.detail)
        return
      }
    }

    const channel = this.channel
    if (channel === null) return
    let plaintext: Uint8Array
    try {
      plaintext = channel.open(data)
    } catch (error) {
      // A frame that will not open is a wrong key or a tampered stream. Neither is worth
      // retrying on this socket, and neither says anything a user could act on beyond "this is
      // not the cide you paired with".
      this.dropped(error instanceof Error ? error.message : 'a frame did not open')
      return
    }

    const frame = this.parseFrame(plaintext)
    if (frame === null) return
    void handshake

    if (frame.body.t === 'welcome') {
      if (!compatible(frame.body.protocol)) {
        this.terminal('incompatible', mismatch(frame.body.protocol, frame.body.instance.name))
        return
      }
      this.back.succeed()
      this.features = new Set(frame.body.features)
      this.enter('ready')
      // Declared, not commanded: the whole set, every time. See the header.
      this.send({ body: { t: 'subscribe', projects: [...this.interests.projects] } })
      this.seq = 1
      for (const session of this.looked) this.send({ body: { t: 'acknowledge', session: session as never } })
      this.looked.clear()
      for (const session of this.watched) this.send({ body: { t: 'watchScreen', session: session as never } })
      this.beat()
    }

    if (frame.id !== undefined && frame.id !== null && frame.id === this.awaitingPong) {
      this.awaitingPong = null
      this.beat()
      return
    }

    if (frame.id !== undefined && frame.id !== null) {
      const waiting = this.pending.get(frame.id)
      if (waiting !== undefined) {
        this.pending.delete(frame.id)
        this.clock.clearTimeout(waiting.timer)
        waiting.resolve(frame.body)
        return
      }
    }
    this.options.onEvent?.(frame.body)
  }

  /**
   * Ping, and notice if nothing comes back.
   *
   * Deliberately **not** built on [`request`]: that resolves a promise, and a promise settles in
   * a microtask while a timeout fires on the macrotask queue — so a pong that arrived in time
   * would still be missed by the check that runs immediately after the timer. Liveness is the
   * one thing here that must not depend on the ordering of two queues, so it is a field and an
   * id comparison.
   *
   * This is the only thing that sees a NAT mapping expire. Without it a phone that changed
   * networks sits in `ready` for ever, showing a board that stopped updating.
   */
  private beat(): void {
    this.after(HEARTBEAT_EVERY, () => {
      if (this.phase !== 'ready') return
      const id = this.nextId++
      this.awaitingPong = id
      this.send({ id, body: { t: 'ping' } })
      this.after(HEARTBEAT_TIMEOUT, () => {
        if (this.awaitingPong === id && this.phase === 'ready') {
          this.dropped('cide stopped answering')
        }
      })
    })
  }

  private dropped(why: string): void {
    if (this.phase === 'incompatible' || this.phase === 'revoked') return
    this.awaitingPong = null
    this.rejectPending()
    this.closeWire()
    // Every timer outstanding belongs to the life that has just ended — the handshake
    // deadline, the heartbeat, its pong deadline, and any reconnect an earlier drop queued.
    //
    // Nothing cleared them, so each drop *added* a reconnect rather than replacing one. A phone
    // runs no timers while it is locked and then runs them all in one tick, so a night of drops
    // arrived as a burst of `open()` calls, each dialling a socket and orphaning the one before
    // it: cide logged a dozen `Connection reset by peer` from a dozen source ports.
    //
    // This clear and the one at the top of `open` are **each sufficient** for that — either
    // alone collapses the burst, which `waking up from a locked phone` demonstrates by failing
    // only when both are removed. Both are kept because they answer different questions: this
    // one says a dead life arms nothing further, and `open`'s says a new life inherits nothing.
    // The pair is also what stops a stale heartbeat dropping a healthy connection, which is the
    // half that reads as flickering rather than as a storm.
    this.clearTimers()
    if (this.stopped) {
      this.enter('idle', why)
      return
    }
    // Read the rung *then* advance, or the first failure waits the second rung and the ladder
    // is silently one step ahead of the one written down.
    const wait = this.back.next()
    this.back.fail()
    this.enter('backoff', why)
    this.after(wait, () => {
      if (!this.stopped) this.open()
    })
  }

  private fail(why: string): void {
    this.dropped(why)
  }

  private terminal(phase: 'incompatible' | 'revoked', detail: string): void {
    this.rejectPending()
    this.closeWire()
    this.clearTimers()
    this.enter(phase, detail)
  }

  private teardown(phase: Phase): void {
    this.rejectPending()
    this.closeWire()
    this.clearTimers()
    this.enter(phase)
  }

  // --- plumbing ---------------------------------------------------------------------------

  private send(frame: { id?: number; body: ClientBody }): void {
    const channel = this.channel
    const wire = this.wire
    if (channel === null || wire === null) return
    const json = encodeUtf8(JSON.stringify(frame))
    wire.send(channel.seal(json))
  }

  private client() {
    return { name: this.options.paired.label, platform: 'unknown', appVersion: '0.1.0' }
  }

  private enter(phase: Phase, detail?: string): void {
    this.phase = phase
    this.detail = detail
    this.options.onPhase?.(phase, detail)
  }

  private after(ms: number, fn: () => void): void {
    this.timers.push(this.clock.setTimeout(fn, ms))
  }

  private clearTimers(): void {
    for (const timer of this.timers) this.clock.clearTimeout(timer)
    this.timers = []
  }

  private closeWire(): void {
    this.wire?.close()
    this.wire = null
    this.channel = null
  }

  private rejectPending(): void {
    for (const [, waiting] of this.pending) {
      this.clock.clearTimeout(waiting.timer)
      waiting.reject(new Disconnected())
    }
    this.pending.clear()
  }

  private looksLikeText(data: Uint8Array): boolean {
    return data[0] === 0x7b // '{'
  }

  private parse(data: Uint8Array): ServerBody | null {
    const frame = this.parseFrame(data)
    return frame?.body ?? null
  }

  private parseFrame(data: Uint8Array): ServerFrame | null {
    try {
      return JSON.parse(decodeUtf8(data)) as ServerFrame
    } catch {
      // A frame this build does not understand. Ignored rather than fatal: a device built against
      // an older cide must degrade, not disconnect.
      return null
    }
  }
}

/** The production socket, over whatever `WebSocket` this platform has. */
export const wsDial: Dial = (url, handlers) => {
  const socket = new WebSocket(url)
  socket.binaryType = 'arraybuffer'
  socket.onopen = () => handlers.onOpen()
  socket.onmessage = (event: MessageEvent) => {
    const data = event.data
    if (data instanceof ArrayBuffer) handlers.onMessage(new Uint8Array(data))
    else if (typeof data === 'string') handlers.onMessage(encodeUtf8(data))
  }
  socket.onclose = () => handlers.onClose()
  socket.onerror = (event: Event) => handlers.onError(event)
  return {
    send: (bytes) => socket.send(bytes),
    close: () => socket.close(),
  }
}
