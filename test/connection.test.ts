/**
 * The connection state machine, driven by hand.
 *
 * Time is a number here and the socket is a test double, so a day of reconnects runs in a
 * millisecond and nothing flakes. What is asserted is the set of things that go wrong *silently*
 * in a reconnect policy: a backoff that resets on the wrong event, a heartbeat that never fires,
 * a subscription that is not replayed, a request left hanging when the socket went away.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from '@noble/hashes/utils'
import {
  Connection,
  Disconnected,
  HEARTBEAT_EVERY,
  type Paired,
  type Phase,
} from '../src/net/connection'
import { PROTOCOL_VERSION } from '../src/protocol/version'
import { RUNGS } from '../src/net/backoff'
import { FakeClock, fakeDial, type FakeSocket } from './fakeWire'
import type { InstanceInfo, ServerBody } from '../src/protocol/generated'

const instance = (name = 'thinkpad'): InstanceInfo => ({
  id: 'i-1',
  name,
  version: '0.9.1-dev',
})

function welcome(protocol = PROTOCOL_VERSION, name = 'thinkpad'): ServerBody {
  return { t: 'welcome', protocol, instance: instance(name), features: ['sessions'] }
}

interface Harness {
  connection: Connection
  clock: FakeClock
  sockets: FakeSocket[]
  phases: { phase: Phase; detail: string | undefined }[]
  events: ServerBody[]
}

function harness(hosts = ['192.168.1.4:17643']): Harness {
  const key = randomBytes(32)
  const { dial, sockets, serverPublic } = fakeDial(key)
  const clock = new FakeClock()
  const phases: Harness['phases'] = []
  const events: ServerBody[] = []
  const paired: Paired = {
    instanceId: 'i-1',
    label: 'thinkpad',
    hosts,
    deviceId: 'd-test',
    serverPublic,
    key,
  }
  const connection = new Connection({
    paired,
    dial,
    clock,
    // No jitter, so a sequence can be asserted exactly. The jitter itself is `backoff`'s own
    // test's problem.
    random: () => 0.5,
    onPhase: (phase, detail) => phases.push({ phase, detail }),
    onEvent: (body) => events.push(body),
  })
  return { connection, clock, sockets, phases, events }
}

/** Bring a harness all the way up. */
function ready(h: Harness): FakeSocket {
  h.connection.start()
  const socket = h.sockets[h.sockets.length - 1]!
  socket.open()
  socket.say(welcome(), 1)
  return socket
}

describe('Connection', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
  })

  it('shakes hands, says hello, and is ready when welcomed', () => {
    const socket = ready(h)
    expect(h.connection.state.phase).toBe('ready')

    // The handshake is first and in the clear; everything after it is sealed.
    expect(new TextDecoder().decode(socket.sent[0]!.subarray(0, 9))).toBe('cide-seal')
    const said = socket.heard()
    expect(said[0]!.body.t).toBe('hello')
    expect(said[0]!.body).toMatchObject({ protocol: PROTOCOL_VERSION })
  })

  it('carries no credential after the handshake', () => {
    // The strongest property of the sealed transport, asserted from this end: everything this
    // app ever sends is in these frames, and none of it is the key.
    const socket = ready(h)
    h.connection.setInterests({ projects: ['p-1' as never] })
    const json = JSON.stringify(socket.heard())
    for (const secret of ['token', 'key', 'seal']) {
      expect(json).not.toContain(secret)
    }
  })

  it('declares its whole interest set, and again after a reconnect', () => {
    const first = ready(h)
    h.connection.setInterests({ projects: ['p-1' as never, 'p-2' as never] })
    expect(first.heard().filter((f) => f.body.t === 'subscribe')).toHaveLength(2)

    first.drop()
    h.clock.advance(RUNGS[0]!)
    const second = h.sockets[h.sockets.length - 1]!
    second.open()
    second.say(welcome(), 1)

    // The whole set, unasked. A delta protocol could not survive this: the server has no way to
    // tell a repeat from a change.
    const subscribes = second.heard().filter((f) => f.body.t === 'subscribe')
    expect(subscribes).toHaveLength(1)
    expect(subscribes[0]!.body).toMatchObject({ projects: ['p-1', 'p-2'] })
  })

  it('watches a console opened before the socket was up, and again after a reconnect', () => {
    // A notification's tap: the console screen mounts while the socket is still connecting.
    // `tell` drops everything before `ready`, so this used to go nowhere and the console sat on
    // "Waiting for the first frame…" for ever.
    h.connection.start()
    h.connection.watch('s-1')
    h.connection.acknowledge('s-1')
    const first = h.sockets[h.sockets.length - 1]!
    first.open()
    first.say(welcome(), 1)
    const said = first.heard().map((f) => f.body)
    expect(said).toContainEqual({ t: 'watchScreen', session: 's-1' })
    expect(said).toContainEqual({ t: 'acknowledge', session: 's-1' })

    first.drop()
    h.clock.advance(RUNGS[0]!)
    const second = h.sockets[h.sockets.length - 1]!
    second.open()
    second.say(welcome(), 1)
    const again = second.heard().map((f) => f.body)
    expect(again).toContainEqual({ t: 'watchScreen', session: 's-1' })
    // The look was said once; a reconnect does not re-acknowledge a later wait nobody saw.
    expect(again.filter((b) => b.t === 'acknowledge')).toHaveLength(0)

    // And a console that was left is not re-watched.
    h.connection.unwatch('s-1')
    second.drop()
    h.clock.advance(RUNGS[0]!)
    const third = h.sockets[h.sockets.length - 1]!
    third.open()
    third.say(welcome(), 1)
    expect(third.heard().filter((f) => f.body.t === 'watchScreen')).toHaveLength(0)
  })

  it('numbers input per socket, not per screen', () => {
    // cide drops a write whose number is not above the last it applied on this socket, so a
    // counter that restarted when a console was reopened lost every key until it caught up.
    ready(h)
    expect([h.connection.nextSeq(), h.connection.nextSeq()]).toEqual([1, 2])
    // A second screen on the same socket carries on from there.
    expect(h.connection.nextSeq()).toBe(3)
  })

  it('knows what the cide on the other end offers', () => {
    expect(h.connection.has('sessions')).toBe(false)
    ready(h)
    expect(h.connection.has('sessions')).toBe(true)
    expect(h.connection.has('scrollView')).toBe(false)
  })

  it('backs off along the ladder and resets only on a completed handshake', () => {
    h.connection.start()
    // A server that accepts and immediately drops: the socket opens every time. Resetting there
    // would be an unthrottled loop that looks exactly like a working reconnect.
    for (const [attempt, rung] of RUNGS.slice(0, 4).entries()) {
      const socket = h.sockets[h.sockets.length - 1]!
      socket.open()
      socket.drop()
      expect(h.connection.state.phase).toBe('backoff')
      // Nothing happens before the rung is up.
      h.clock.advance(rung - 1)
      expect(h.sockets).toHaveLength(attempt + 1)
      h.clock.advance(1)
      expect(h.sockets).toHaveLength(attempt + 2)
    }

    // A completed handshake — and only that — starts the ladder again.
    const socket = h.sockets[h.sockets.length - 1]!
    socket.open()
    socket.say(welcome(), 1)
    expect(h.connection.state.phase).toBe('ready')
    socket.drop()
    h.clock.advance(RUNGS[0]!)
    expect(h.sockets).toHaveLength(6)
  })

  it('stops for ever on a protocol mismatch, naming which end is behind', () => {
    h.connection.start()
    const socket = h.sockets[0]!
    socket.open()
    socket.say(welcome(PROTOCOL_VERSION + 3, 'thinkpad'), 1)

    expect(h.connection.state.phase).toBe('incompatible')
    expect(h.connection.state.detail).toContain('Update the app')

    // No retry, ever. A reconnect storm against a peer that will never agree explains nothing
    // and costs everything.
    h.clock.advance(60_000)
    expect(h.sockets).toHaveLength(1)
    expect(h.connection.retryNow()).toBe(false)
  })

  it('stops for ever when cide says this device was removed', () => {
    h.connection.start()
    const socket = h.sockets[0]!
    socket.open()
    // The one thing cide says in the clear, and the reason it does: a revoked phone would
    // otherwise get a socket that opens and goes quiet, which is what a bad network looks like.
    socket.sayInTheClear({
      t: 'error',
      kind: 'unauthorized',
      detail: 'this device is not paired with this cide',
    })

    expect(h.connection.state.phase).toBe('revoked')
    expect(h.connection.state.detail).toContain('not paired')
    h.clock.advance(60_000)
    expect(h.sockets).toHaveLength(1)
  })

  it('notices a socket that went away without saying so', async () => {
    ready(h)
    const before = h.sockets.length

    // The heartbeat is the only thing that sees a NAT mapping expire. Without it the app sits in
    // `ready` for ever showing a board that stopped updating.
    h.clock.advance(20_000)
    const socket = h.sockets[h.sockets.length - 1]!
    expect(socket.heard().some((f) => f.body.t === 'ping')).toBe(true)

    h.clock.advance(10_000)
    expect(h.connection.state.phase).toBe('backoff')
    expect(h.connection.state.detail).toContain('stopped answering')
    h.clock.advance(RUNGS[0]!)
    expect(h.sockets.length).toBeGreaterThan(before)
  })

  it('keeps beating while cide answers, and a stale check does no harm', () => {
    const socket = ready(h)
    for (let beat = 0; beat < 3; beat++) {
      // Exactly one interval, so the beat fires and *its* deadline does not. The previous
      // beat's deadline does fire in here, which is the point: it must find its own ping
      // already answered and do nothing. An implementation that keyed liveness on "is there an
      // outstanding ping" rather than on *which* ping would tear the connection down here.
      h.clock.advance(20_000)
      const ping = socket.heard().filter((f) => f.body.t === 'ping')
      expect(ping).toHaveLength(beat + 1)
      expect(h.connection.state.phase).toBe('ready')
      socket.say({ t: 'pong' }, ping[beat]!.id!)
      expect(h.connection.state.phase).toBe('ready')
    }
  })

  it('rejects what was outstanding when the socket went away', async () => {
    const socket = ready(h)
    const answer = h.connection.request({ t: 'ping' })
    socket.drop()
    await expect(answer).rejects.toBeInstanceOf(Disconnected)
  })

  it('answers a request with the frame that carries its id', async () => {
    const socket = ready(h)
    const answer = h.connection.request({ t: 'ping' })
    const asked = socket.heard().find((f) => f.body.t === 'ping' && f.id !== undefined)
    socket.say({ t: 'pong' }, asked!.id!)
    await expect(answer).resolves.toMatchObject({ t: 'pong' })
  })

  it('hands everything else to the event handler', () => {
    const socket = ready(h)
    socket.say({ t: 'awaiting', entries: [] })
    expect(h.events.map((e) => e.t)).toContain('awaiting')
  })

  it('tries the host that answered last, first', () => {
    const many = harness(['10.0.0.1:17643', '192.168.1.4:17643'])
    many.connection.start()
    expect(many.sockets[0]!.url).toContain('10.0.0.1')

    const socket = many.sockets[0]!
    socket.open()
    socket.say(welcome(), 1)
    expect(many.connection.preferredHost).toBe('10.0.0.1:17643')

    socket.drop()
    many.clock.advance(RUNGS[0]!)
    expect(many.sockets[1]!.url).toContain('10.0.0.1')
  })

  it('stops when told, and rejects what was in flight', async () => {
    const socket = ready(h)
    const answer = h.connection.request({ t: 'ping' })
    h.connection.stop()
    await expect(answer).rejects.toBeInstanceOf(Disconnected)
    expect(h.connection.state.phase).toBe('idle')
    expect(socket.closed).toBe(true)

    h.clock.advance(60_000)
    expect(h.sockets).toHaveLength(1)
  })
})

describe('waking up from a locked phone', () => {
  it('opens one socket, however many drops piled up while it slept', async () => {
    // Reported from a real phone: unlock it and cide logs a dozen `Connection reset by peer`
    // from a dozen source ports at the same millisecond.
    //
    // A phone runs no timers while it is locked and then runs them all in one tick. Each drop
    // used to *add* a reconnect without cancelling the one already queued — and the handshake
    // deadline and the heartbeat were still armed too — so a night of failures arrived as a
    // burst of `open()` calls, each dialling a socket and orphaning the one before it.
    //
    // Driven by dropping the socket repeatedly without letting the clock run, which is exactly
    // what a suspended app does.
    const h = harness()
    h.connection.start()
    const before = h.sockets.length

    for (let i = 0; i < 6; i++) h.sockets.at(-1)?.drop()

    // Nothing dialled yet: every reconnect is still pending.
    expect(h.sockets.length).toBe(before)

    // The phone wakes and every timer that came due fires together.
    //
    // Advanced past the longest rung those six drops could have reached, and no further: an
    // unanswered connection is *supposed* to retry, so a longer advance would be measuring the
    // retry ladder rather than the storm this test is about.
    h.clock.advance(RUNGS[5]!)

    // Exactly one new socket. With the timer clears removed from **both** `dropped` and `open`
    // this is six — one per drop that piled up, each orphaning the socket before it, which is
    // the burst of `Connection reset by peer` cide logged from a burst of source ports. Either
    // clear alone is enough, so this fails only when both are gone; that is the property worth
    // pinning, rather than which of the two happens to be doing the work today.
    expect(h.sockets.length - before).toBe(1)
  })

  it('does not leave a stale heartbeat able to drop the new connection', async () => {
    // The other half. A heartbeat armed by the previous life would fire against the new one and
    // drop a socket that was perfectly healthy — which is what "flickering" looks like from the
    // other end: connect, reset, connect, reset.
    const h = harness()
    h.connection.start()
    await ready(h)
    const settled = h.sockets.length

    h.sockets.at(-1)?.drop()
    h.clock.advance(RUNGS[0]!)
    expect(h.sockets.length - settled).toBe(1)

    // The new socket completes its handshake, so nothing is owed a retry.
    ready(h)
    const alive = h.sockets.length

    // Now let the old life's heartbeat and pong deadline come due. A stale one would drop a
    // connection that is perfectly healthy — which is what "flickering" looks like from cide's
    // end: connect, reset, connect, reset.
    h.clock.advance(HEARTBEAT_EVERY - 1)
    expect(h.sockets.length).toBe(alive)
  })
})
