/**
 * A socket and a clock that a test drives by hand.
 *
 * Everything worth asserting about `Connection` is a behaviour over *time* — a backoff sequence,
 * a heartbeat that fires, a reconnect that replays its subscriptions — and a test that waited for
 * real time would take minutes and flake. So time is a number this file advances.
 *
 * The fake server half seals with cide's own algebra (`src/crypto/seal.ts` is checked against
 * cide-generated vectors), so a frame this hands the connection is a frame cide would have sent.
 */
import {
  Channel,
  decodeHandshake,
  deriveServerChannel,
  type Handshake,
} from '../src/crypto/seal'
import { x25519 } from '@noble/curves/ed25519'
import { randomBytes } from '@noble/hashes/utils'
import type { Clock, Dial, Wire, WireHandlers } from '../src/net/connection'
import type { ClientFrame, ServerBody } from '../src/protocol/generated'

export class FakeClock implements Clock {
  private at = 0
  private seq = 0
  private readonly timers = new Map<number, { due: number; fn: () => void }>()

  now(): number {
    return this.at
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const handle = this.seq++
    this.timers.set(handle, { due: this.at + ms, fn })
    return handle
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number)
  }

  /** Move time forward, firing what is due in order. */
  advance(ms: number): void {
    const until = this.at + ms
    for (;;) {
      let next: [number, { due: number; fn: () => void }] | undefined
      for (const entry of this.timers) {
        if (entry[1].due <= until && (next === undefined || entry[1].due < next[1].due)) {
          next = entry
        }
      }
      if (next === undefined) break
      this.timers.delete(next[0])
      this.at = next[1].due
      next[1].fn()
    }
    this.at = until
  }

  get pending(): number {
    return this.timers.size
  }
}

/** One socket the test is the far end of. */
export class FakeSocket {
  readonly sent: Uint8Array[] = []
  private channel: Channel | null = null
  private handshake: Handshake | null = null
  closed = false

  constructor(
    readonly url: string,
    private readonly handlers: WireHandlers,
    private readonly serverSecret: Uint8Array,
    private readonly psk: Uint8Array,
  ) {}

  /** The client believes the socket opened. */
  open(): void {
    this.handlers.onOpen()
  }

  /** Derive the server's side from the handshake the client sent first. */
  private ensureChannel(): Channel {
    if (this.channel !== null) return this.channel
    const first = this.sent[0]
    if (first === undefined) throw new Error('the client sent no handshake')
    const handshake = decodeHandshake(first)
    if (handshake === null) throw new Error('the client sent something that was not a handshake')
    this.handshake = handshake
    this.channel = deriveServerChannel(this.serverSecret, handshake, this.psk)
    return this.channel
  }

  private readonly opened: ClientFrame[] = []
  private next = 1

  /**
   * What the client has said, in order, after the handshake.
   *
   * Accumulated rather than recomputed, because opening a frame **advances the counter**: a
   * second pass over the same frames would be a replay, and the transport refuses one. That is
   * the transport working, and it is also exactly the shape of bug a test helper hides.
   */
  heard(): ClientFrame[] {
    const channel = this.ensureChannel()
    while (this.next < this.sent.length) {
      const frame = this.sent[this.next++]!
      const plaintext = channel.open(frame)
      this.opened.push(JSON.parse(new TextDecoder().decode(plaintext)) as ClientFrame)
    }
    return this.opened
  }

  /** Send the client a frame, sealed the way cide would. */
  say(body: ServerBody, id?: number): void {
    const channel = this.ensureChannel()
    const json = new TextEncoder().encode(JSON.stringify(id === undefined ? { body } : { id, body }))
    this.handlers.onMessage(channel.seal(json))
  }

  /** Send the one thing cide says in the clear. */
  sayInTheClear(body: ServerBody): void {
    this.handlers.onMessage(new TextEncoder().encode(JSON.stringify({ body })))
  }

  drop(): void {
    this.closed = true
    this.handlers.onClose()
  }

  wire(): Wire {
    return {
      send: (bytes) => this.sent.push(bytes),
      close: () => {
        this.closed = true
      },
    }
  }
}

/** A dial that hands every socket to the test. */
export function fakeDial(psk: Uint8Array): {
  dial: Dial
  sockets: FakeSocket[]
  serverPublic: Uint8Array
} {
  // The fake server's "static" key. `deriveChannel` is symmetric in the pair (e, S), so the fake
  // derives with (S_secret, e_public) where the client derived with (e_secret, S_public) — the
  // same shared secret, which is the whole of X25519.
  const serverSecret = randomBytes(32)
  const serverPublic = x25519.getPublicKey(serverSecret)
  const sockets: FakeSocket[] = []
  const dial: Dial = (url, handlers) => {
    const socket = new FakeSocket(url, handlers, serverSecret, psk)
    sockets.push(socket)
    return socket.wire()
  }
  return { dial, sockets, serverPublic }
}
