/**
 * This app against a real cide, over a real socket.
 *
 * The vectors prove the crypto agrees. The fake wire proves the state machine behaves. Neither is
 * the same as **the two programs speaking to each other**, and the gap between them is where a
 * protocol lives: a field that serialises differently, a frame the client never sends because it
 * assumed the server starts, a `null` where an `undefined` was expected.
 *
 * So this spawns `cargo run -p cide-remote --example fake_cide` — a real `RemoteServer`, a real
 * sealed transport, a host made of constants — and drives it with the same `Connection` the app
 * uses.
 *
 * **Skipped when cide is not beside this repository**, which is the honest behaviour for a test
 * that needs another checkout: a check that cannot run has not passed, and it says so rather than
 * reporting green. Set `CIDE_REPO` to point somewhere else.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Connection, wsDial, type Paired } from '../src/net/connection'
import { PAIR_TIMEOUT, pair } from '../src/net/pair'
import { parseInvite, typedInvite } from '../src/pairing/parse'
import { fromBase64Url, fromHex } from '../src/crypto/seal'
import { PROTOCOL_VERSION } from '../src/protocol/version'
import type { ServerBody } from '../src/protocol/generated'
import { HistoryStore, PAGE, historyText } from '../src/term/history'

const here = dirname(fileURLToPath(import.meta.url))
const cide = process.env.CIDE_REPO ?? resolve(here, '../../cide')
const available = existsSync(join(cide, 'Cargo.toml'))

interface Ready {
  port: number
  device: string
  key: string
  serverPublic: string
  publicBase64: string
  code: string
}

let child: ChildProcess | undefined

/** Start the example and wait for the line it prints when it is listening. */
async function start(): Promise<Ready> {
  const dir = await mkdtemp(join(tmpdir(), 'cide-e2e-'))
  const proc = spawn(
    'cargo',
    ['run', '--offline', '--quiet', '-p', 'cide-remote', '--example', 'fake_cide', '--', dir, '0'],
    { cwd: cide, stdio: ['ignore', 'pipe', 'inherit'] },
  )
  child = proc
  return new Promise<Ready>((done, reject) => {
    let buffered = ''
    const timer = setTimeout(
      () => reject(new Error('the example never said it was listening')),
      180_000,
    )
    proc.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString()
      const line = buffered.split('\n').find((l) => l.startsWith('{'))
      if (line !== undefined) {
        clearTimeout(timer)
        done(JSON.parse(line) as Ready)
      }
    })
    proc.on('error', reject)
    proc.on('exit', (code) => reject(new Error(`the example exited with ${code}`)))
  })
}

/** Wait for the connection to settle, and fail loudly on the two terminal states. */
async function untilReady(connection: Connection): Promise<void> {
  return new Promise<void>((done, reject) => {
    const timer = setTimeout(() => reject(new Error('never became ready')), 20_000)
    const poll = setInterval(() => {
      const { phase, detail } = connection.state
      if (phase === 'ready') {
        clearInterval(poll)
        clearTimeout(timer)
        done()
      }
      if (phase === 'incompatible' || phase === 'revoked') {
        clearInterval(poll)
        clearTimeout(timer)
        reject(new Error(detail ?? phase))
      }
    }, 50)
  })
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))

afterAll(() => {
  child?.kill()
})

describe.skipIf(!available)('against a real cide', () => {
  it('is welcomed, served the board, and repaints a screen', { timeout: 240_000 }, async () => {
    const ready = await start()

    const paired: Paired = {
      instanceId: 'i-example',
      label: 'example',
      hosts: [`127.0.0.1:${ready.port}`],
      deviceId: ready.device,
      serverPublic: fromHex(ready.serverPublic),
      key: fromHex(ready.key),
    }

    const events: ServerBody[] = []
    const connection = new Connection({
      paired,
      dial: wsDial,
      onEvent: (body) => events.push(body),
    })

    connection.start()
    await untilReady(connection)

    // The snapshot arrives unasked, and is the projection rather than the tree.
    await settle(500)
    const kinds = events.map((e) => e.t)
    expect(kinds).toContain('projects')
    expect(kinds).toContain('sessions')
    expect(kinds).toContain('awaiting')

    const projects = events.find((e) => e.t === 'projects')
    expect(projects).toMatchObject({ projects: [{ name: 'cide', displayPath: '~/work/cide' }] })

    // And nothing anywhere in it is a credential — the thing the whole transport is for.
    expect(JSON.stringify(events)).not.toContain(ready.key)

    // A request gets its answer back through the sealed channel.
    await expect(connection.request({ t: 'ping' })).resolves.toMatchObject({ t: 'pong' })

    // A watched screen repaints, which is the one path that is a *stream* rather than an answer.
    const sessions = events.find((e) => e.t === 'sessions') as
      | { sessions: { session: string }[] }
      | undefined
    const session = sessions?.sessions[0]?.session
    expect(session).toBeDefined()
    connection.tell({ t: 'watchScreen', session: session as never })
    await settle(800)
    const screen = events.find((e) => e.t === 'screen')
    expect(screen).toBeDefined()
    expect(JSON.stringify(screen)).toContain('hello from cide')

    connection.stop()
  })

  /**
   * The road the console's *scroll up* takes, end to end. (M76)
   *
   * Driven through `HistoryStore` rather than by reading the frames, because the part that can
   * be wrong is the stitching: the wire counts from the oldest line and the reader pages
   * backwards, so a page taken with the wrong arithmetic still arrives, still parses, and still
   * renders — as a transcript with a piece of itself missing.
   */
  it('reads a page of scrollback and pages backwards from it', { timeout: 240_000 }, async () => {
    const ready = await start()

    const paired: Paired = {
      instanceId: 'i-example',
      label: 'example',
      hosts: [`127.0.0.1:${ready.port}`],
      deviceId: ready.device,
      serverPublic: fromHex(ready.serverPublic),
      key: fromHex(ready.key),
    }

    const events: ServerBody[] = []
    const connection = new Connection({ paired, dial: wsDial, onEvent: (body) => events.push(body) })
    connection.start()
    await untilReady(connection)
    await settle(500)

    const sessions = events.find((e) => e.t === 'sessions') as
      | { sessions: { session: string }[] }
      | undefined
    const session = sessions?.sessions[0]?.session as never
    expect(session).toBeDefined()

    const history = new HistoryStore()
    const take = async (fromTop: number, rows: number) => {
      history.begin()
      const answer = await connection.request({ t: 'scrollbackPage', session, fromTop, rows })
      if (answer.t !== 'scrollback') throw new Error(`asked for a page, got ${answer.t}`)
      history.absorb(answer.page)
    }

    // How deep is it? A page of no rows, which is the only way to ask.
    await take(0, 0)
    const depth = history.getSnapshot().depth
    expect(depth).toBeGreaterThan(PAGE)
    expect(history.getSnapshot().lines).toHaveLength(0)

    // The newest page, which is what opening a console asks for.
    await take(depth - PAGE, PAGE)
    expect(history.getSnapshot().from).toBe(depth - PAGE)
    expect(history.getSnapshot().lines).toHaveLength(PAGE)
    expect(historyText(history.getSnapshot())).toContain(`history line ${depth - 1}`)

    // And the one before it, stitched onto the front rather than replacing it.
    const earlier = history.earlierFrom
    expect(earlier).toBe(depth - 2 * PAGE)
    await take(earlier as number, PAGE)
    expect(history.getSnapshot().from).toBe(depth - 2 * PAGE)
    expect(history.getSnapshot().lines).toHaveLength(2 * PAGE)
    // Contiguous, which is the whole claim: every line from the first held index to the last.
    const text = historyText(history.getSnapshot()).split('\n')
    expect(text[0]).toBe(`history line ${depth - 2 * PAGE}`)
    expect(text[text.length - 1]).toBe(`history line ${depth - 1}`)

    connection.stop()
  })

  it('pairs from an invite, then connects with what it was given', { timeout: 240_000 }, async () => {
    const ready = await start()

    // The invite cide's Settings screen would print, assembled from what the example announced.
    const invite = parseInvite(
      `cide://pair?v=${PROTOCOL_VERSION}&i=i-example&n=example&m=seal` +
        `&k=${ready.publicBase64}&h=127.0.0.1%3A${ready.port}&c=${ready.code}`,
    )

    const paired = await pair({
      invite,
      dial: wsDial,
      deviceName: 'a test',
      platform: 'node',
      appVersion: '0.1.0',
    })

    // What comes back is a *different* device from the one baked into the example, with a key
    // this app has never seen before — which is the whole point of pairing.
    expect(paired.deviceId).not.toBe(ready.device)
    expect(paired.key).toHaveLength(32)
    expect(paired.key).not.toEqual(fromHex(ready.key))

    // And it works: the credentials pairing produced open a resumed connection.
    const connection = new Connection({ paired, dial: wsDial })
    connection.start()
    await untilReady(connection)
    await expect(connection.request({ t: 'ping' })).resolves.toMatchObject({ t: 'pong' })
    connection.stop()
  })

  it('pairs by a typed address once the digits are confirmed', { timeout: 240_000 }, async () => {
    const ready = await start()

    // No key and no instance id: an address and eight characters, which is all the typed road
    // ever has. The key comes off the greeting and the digits are what settle it.
    const invite = typedInvite(`127.0.0.1:${ready.port}`, ready.code, PROTOCOL_VERSION)
    expect(invite.serverPublic).toBeNull()

    let shown: string | null = null
    const paired = await pair({
      invite,
      dial: wsDial,
      deviceName: 'a test',
      platform: 'node',
      appVersion: '0.1.0',
      confirm: (sas) => {
        shown = sas
        return Promise.resolve(true)
      },
    })

    expect(shown).toMatch(/^[0-9]{6}$/)
    expect(paired.key).toHaveLength(32)
    // cide names itself in the answer, because the typed road was never told who it reached.
    expect(paired.instanceId).not.toBe('')
    expect(paired.serverPublic).toEqual(fromBase64Url(ready.publicBase64))

    const connection = new Connection({ paired, dial: wsDial })
    connection.start()
    await untilReady(connection)
    await expect(connection.request({ t: 'ping' })).resolves.toMatchObject({ t: 'pong' })
    connection.stop()
  })

  it('gives up on an unreachable address quickly and moves to the next', { timeout: 240_000 }, async () => {
    // Reported as a spinner nobody could escape. cide offers every private address it has, and
    // on a developer's machine that is one network card and nine docker, libvirt and VPN
    // bridges; a pairing code is single use, so the addresses are tried **in turn** rather than
    // raced, and each unreachable one used to cost the full fifteen seconds.
    //
    // The real address is deliberately last, so this fails against a build that waits the full
    // patience on each of the dead ones before reaching it.
    const ready = await start()
    const invite = {
      ...typedInvite(`127.0.0.1:${ready.port}`, ready.code, PROTOCOL_VERSION),
      // 198.51.100.x is TEST-NET-2, reserved for documentation and routed nowhere.
      hosts: ['198.51.100.1:1', '198.51.100.2:1', `127.0.0.1:${ready.port}`],
    }

    const began = Date.now()
    const paired = await pair({
      invite,
      dial: wsDial,
      deviceName: 'a test',
      platform: 'node',
      appVersion: '0.1.0',
      confirm: () => Promise.resolve(true),
    })
    expect(paired.key).toHaveLength(32)
    // Two dead addresses at the short allowance, not at the long one. The bound is loose on
    // purpose — the claim is "fast enough that nobody thinks it has hung", not a stopwatch.
    expect(Date.now() - began).toBeLessThan(3 * PAIR_TIMEOUT)
  })

  it('can be abandoned, and leaves the code unspent', { timeout: 240_000 }, async () => {
    // There has to be a way out. Before this the only exit from a pairing going nowhere was to
    // wait out every address with the button disabled — which is what a person reports as
    // "the app hung". Aborting before the code is sent must leave it redeemable, for the same
    // reason refusing the six digits does: the code is what authenticates the device.
    const ready = await start()
    const controller = new AbortController()
    const attempt = pair({
      invite: typedInvite(`127.0.0.1:${ready.port}`, ready.code, PROTOCOL_VERSION),
      dial: wsDial,
      deviceName: 'a test',
      platform: 'node',
      appVersion: '0.1.0',
      // Never answered: this is the state somebody is stuck in when they give up.
      confirm: () => new Promise<boolean>(() => {}),
      signal: controller.signal,
    })
    await settle(400)
    controller.abort()
    await expect(attempt).rejects.toThrow(/cancelled/)

    const paired = await pair({
      invite: typedInvite(`127.0.0.1:${ready.port}`, ready.code, PROTOCOL_VERSION),
      dial: wsDial,
      deviceName: 'a test',
      platform: 'node',
      appVersion: '0.1.0',
      confirm: () => Promise.resolve(true),
    })
    expect(paired.key).toHaveLength(32)
  })

  it('waits as long as a person takes to read the digits', { timeout: 240_000 }, async () => {
    // Found by pairing by hand and taking a minute over it: the attempt had been abandoned as
    // unreachable before the tap landed, and the message blamed the network. The timeout is for
    // packets, and the interval it was measuring belonged to somebody walking to a monitor.
    //
    // Every unit test resolves `confirm` immediately, so none of them could see it. This one
    // deliberately takes longer than the entire patience allowance.
    const ready = await start()
    const patience = 400
    const paired = await pair({
      invite: typedInvite(`127.0.0.1:${ready.port}`, ready.code, PROTOCOL_VERSION),
      dial: wsDial,
      deviceName: 'a test',
      platform: 'node',
      appVersion: '0.1.0',
      timeoutMs: patience,
      confirm: () => new Promise((yes) => setTimeout(() => yes(true), patience * 4)),
    })
    expect(paired.key).toHaveLength(32)
  })

  it('sends no code when the digits are refused, so it can be tried again', { timeout: 240_000 }, async () => {
    // The assertion the whole confirmation exists for. Declining must not merely abandon the
    // attempt: it must abandon it *before the code is sent*, because the code is what
    // authenticates this device and a relay that received it has everything it needs. Proving
    // that from outside is exactly this — the code is single use, so if it still works
    // afterwards, cide never saw it.
    const ready = await start()
    const address = `127.0.0.1:${ready.port}`

    let asked = false
    await expect(
      pair({
        invite: typedInvite(address, ready.code, PROTOCOL_VERSION),
        dial: wsDial,
        deviceName: 'a test',
        platform: 'node',
        appVersion: '0.1.0',
        confirm: (sas) => {
          asked = true
          expect(sas).toMatch(/^[0-9]{6}$/)
          return Promise.resolve(false)
        },
      }),
    ).rejects.toThrow()
    expect(asked).toBe(true)

    // Unspent, therefore never sent.
    const paired = await pair({
      invite: typedInvite(address, ready.code, PROTOCOL_VERSION),
      dial: wsDial,
      deviceName: 'a test',
      platform: 'node',
      appVersion: '0.1.0',
      confirm: () => Promise.resolve(true),
    })
    expect(paired.key).toHaveLength(32)
  })

  it('refuses a scanned pairing whose greeting carries another key', { timeout: 240_000 }, async () => {
    // A QR pins the key, so the greeting is checked against it rather than adopted. This is the
    // case the typed road cannot have and the scanned road gets for free: the machine that
    // answered is not the one on the QR, and no number a person could compare would help.
    const ready = await start()
    const somebodyElse = 'A'.repeat(43)
    await expect(
      pair({
        invite: parseInvite(
          `cide://pair?v=${PROTOCOL_VERSION}&i=i-example&n=example&m=seal` +
            `&k=${somebodyElse}&h=127.0.0.1%3A${ready.port}&c=${ready.code}`,
        ),
        dial: wsDial,
        deviceName: 'a test',
        platform: 'node',
        appVersion: '0.1.0',
        // Offered and must not be called: a pinned key that does not match is not a question.
        confirm: () => {
          throw new Error('a mismatched pinned key must never ask the user')
        },
      }),
    ).rejects.toThrow(/different key/)
  })

  it('refuses a code that has already been spent, in cide\'s own words', { timeout: 240_000 }, async () => {
    const ready = await start()
    const invite = parseInvite(
      `cide://pair?v=${PROTOCOL_VERSION}&i=i-example&n=example&m=seal` +
        `&k=${ready.publicBase64}&h=127.0.0.1%3A${ready.port}&c=${ready.code}`,
    )
    const options = {
      invite,
      dial: wsDial,
      deviceName: 'a test',
      platform: 'node',
      appVersion: '0.1.0',
    }

    await pair(options)
    // Single use, and cide says so. This app has nothing better to say about it than cide does.
    await expect(pair(options)).rejects.toThrow()
  })
})
