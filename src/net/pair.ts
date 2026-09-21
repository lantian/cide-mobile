/**
 * Redeem a pairing code, and come away with credentials.
 *
 * This is the one moment a key crosses the wire, and the reason it is safe is the reason the
 * whole transport is shaped the way it is: the pairing connection is **already sealed**, against
 * the instance's public key, which the invite carried. So the channel authenticates *cide* before
 * cide has any way to authenticate the device — and the code, which is what authenticates the
 * device, is spoken inside it.
 *
 * One attempt, and no retry. A wrong code burns the code on cide's side, so a client that
 * "helpfully" tried again would be spending the user's one chance on its own confusion.
 */
import {
  Mode,
  SEAL_VERSION,
  beginHandshake,
  decodeGreeting,
  deriveChannel,
  encodeHandshake,
  fromHex,
} from '../crypto/seal'
import type { Channel } from '../crypto/seal'
import { decodeUtf8, encodeUtf8 } from '../crypto/utf8'

/** Constant-time is not the point here — both sides are public — but one spelling is. */
function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}
import type { ClientFrame, ServerFrame } from '../protocol/generated'
import { PROTOCOL_VERSION } from '../protocol/version'
import type { Invite } from '../pairing/parse'
import type { Dial, Paired } from './connection'

export class PairError extends Error {}

/**
 * The one refusal that is the user's own doing, spelled once.
 *
 * Compared by message rather than by a subclass because it has to survive the `PairError` arm in
 * the address loop, which exists to stop a *cide refusal* being retried against the next
 * address. A cancellation must stop the loop for the same reason and a different cause, and one
 * string is cheaper than a second error type nothing else would use.
 */
const CANCELLED = 'pairing cancelled'

/**
 * How long to wait for cide to answer a redemption before giving up on one address.
 *
 * It measures **the network and nothing else**. The clock is stopped while the six digits are
 * on screen and restarted when they are answered, because that interval belongs to a person
 * reading a number off a monitor — and fifteen seconds is a reasonable wait for a packet and an
 * unreasonable one for somebody who has to find the pairing window first. Counting it cost a
 * successful pairing its own confirmation: the digits matched, the tap landed, and the attempt
 * had already been abandoned as unreachable. The code's two-minute life is the real limit on
 * how long a person may take, and cide is the one enforcing it.
 */
export const PAIR_TIMEOUT = 15_000

/**
 * How long to wait for the *socket* before giving up on one address and trying the next.
 *
 * Much shorter than [`PAIR_TIMEOUT`], and the split exists because the two waits are answers to
 * different questions. Reaching a machine on a local network is fast or it is not happening:
 * three seconds is already generous for a TCP handshake across a room. Being *answered* by a
 * cide that has to read a code, check it and mint a device is worth waiting properly for.
 *
 * Without the split, an invite carrying several addresses is a spinner nobody can escape. cide
 * offers every private address it has, which on a developer's machine means one real network
 * card and a row of docker, libvirt and VPN bridges — and because a pairing code is single use
 * the addresses must be tried **in turn** rather than raced, so each unreachable one costs the
 * full patience. Ten of them at fifteen seconds is two and a half minutes of a disabled button.
 */
export const OPEN_TIMEOUT = 3_000

export interface PairOptions {
  invite: Invite
  dial: Dial
  /** What to call this device in cide's paired-device list. */
  deviceName: string
  platform: string
  appVersion: string
  timeoutMs?: number
  /**
   * Abandon the attempt.
   *
   * There has to be a way out, and before this there was not: the only exit from a pairing that
   * was going nowhere was to wait out every address in the invite, with the button disabled the
   * whole time. Aborting *before* the code is sent leaves it unspent, exactly as refusing the
   * six digits does.
   */
  signal?: AbortSignal
  /**
   * Which address is being tried, as each one is.
   *
   * A pairing walks every address the invite carries — ten of them on a multi-homed machine,
   * nine unreachable — and without this the screen is a spinner for the whole walk. A spinner
   * says *something is happening*; it cannot say *this is the third of ten and the first two
   * were not there*, which is the difference between waiting and giving up.
   */
  onAttempt?: (attempt: { host: string; index: number; total: number }) => void
  /**
   * Ask the user whether cide is showing these six digits. Required on the typed road.
   *
   * It gates the **code**, which is the only thing that matters: the code is what authenticates
   * this device, so it must not be sent until somebody has confirmed that the far end is the
   * machine in front of them. Confirming after sending it would be a dialog that reports an
   * attack it has already lost.
   *
   * Absent on the scanned road, where the key came from the QR and the exchange could not have
   * got this far against anybody else. Asking there would be a confirmation that cannot fail,
   * which is how people learn to dismiss the one that can.
   */
  confirm?: (sas: string) => Promise<boolean>
}

/**
 * Try each of the invite's addresses in turn, and stop at the first that answers.
 *
 * In turn rather than at once: a pairing code is single use, and two connections racing to redeem
 * it would have one of them burn it for the other.
 */
export async function pair(options: PairOptions): Promise<Paired> {
  let last: Error | null = null
  const total = options.invite.hosts.length
  for (const [index, host] of options.invite.hosts.entries()) {
    // Checked between addresses as well as inside the attempt, so abandoning a pairing that is
    // working through a list of unreachable bridges does not have to wait out the current one.
    if (options.signal?.aborted === true) throw new PairError(CANCELLED)
    options.onAttempt?.({ host, index, total })
    try {
      return await pairWith(host, options)
    } catch (error) {
      if (error instanceof PairError && error.message === CANCELLED) throw error
      last = error instanceof Error ? error : new Error(String(error))
      // A refusal from cide is final — the code is gone either way, so trying the next address
      // would only produce a second, more confusing error.
      if (error instanceof PairError) throw error
    }
  }
  throw new PairError(
    last === null ? 'that cide had no address to try' : `could not reach that cide: ${last.message}`,
  )
}

function pairWith(host: string, options: PairOptions): Promise<Paired> {
  const { invite } = options
  return new Promise<Paired>((resolve, reject) => {
    const { handshake, secret } = beginHandshake(Mode.Pair, '')
    // Not derived yet: the key to derive *against* arrives in the greeting. On the scanned road
    // it must equal the one the QR carried, and on the typed road there is nothing to compare it
    // with — which is the whole difference between them, and why the channel cannot be built
    // until the greeting has been seen and judged.
    let channel: Channel | null = null
    let serverPublic: Uint8Array | null = null
    let settled = false

    // Declared before `finish`, which closes over it. The hoisting works out either way today,
    // but a `const` read from a closure that could run before the declaration is a temporal dead
    // zone waiting for somebody to move one line.
    const onAbort = () => finish(() => reject(new PairError(CANCELLED)))
    options.signal?.addEventListener('abort', onAbort)

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Removed here and not only on success: the signal outlives one address, so an attempt
      // that failed and left its listener behind would reject the *next* address's promise too,
      // and the one after that.
      options.signal?.removeEventListener('abort', onAbort)
      wire.close()
      fn()
    }

    const sendCode = (open: Channel) => {
      const frame: ClientFrame = {
        id: 1,
        body: {
          t: 'pair',
          code: invite.code,
          client: {
            name: options.deviceName,
            platform: options.platform,
            appVersion: options.appVersion,
          },
        },
      }
      wire.send(open.seal(encodeUtf8(JSON.stringify(frame))))
    }

    const patience = options.timeoutMs ?? PAIR_TIMEOUT
    const expire = () => finish(() => reject(new Error('cide did not answer in time')))
    // The short one first: until the socket opens this address is a guess, and most of them are
    // wrong. `onOpen` promotes it to the full patience.
    const reaching = () =>
      finish(() => reject(new Error(`nothing answered at ${host}`)))
    let timer = setTimeout(reaching, Math.min(options.timeoutMs ?? OPEN_TIMEOUT, patience))
    // Held across the question and started again for the answer's round trip.
    const holdTheClock = () => clearTimeout(timer)
    const startTheClock = () => {
      clearTimeout(timer)
      timer = setTimeout(expire, patience)
    }

    const wire = options.dial(`ws://${host}`, {
      onOpen: () => {
        // Something is there, so stop being impatient with it.
        startTheClock()
        // The handshake goes first and does not wait for the greeting: the two cross in flight,
        // so waiting would cost a round trip and buy nothing. What must wait is the *code*.
        wire.send(encodeHandshake(handshake))
      },
      onMessage: (data) => {
        // The greeting, which is always the first thing cide says and is never sealed.
        if (channel === null) {
          const greeting = decodeGreeting(data)
          if (greeting === null) {
            finish(() =>
              reject(
                new PairError(
                  'that address answered, but not like a cide — check that it is the machine ' +
                    'showing you the code',
                ),
              ),
            )
            return
          }
          if (greeting.sealVersion !== SEAL_VERSION) {
            finish(() =>
              reject(
                new PairError(
                  `that cide seals frames a different way (${greeting.sealVersion}, this app ` +
                    `speaks ${SEAL_VERSION}). Update whichever is older.`,
                ),
              ),
            )
            return
          }
          // A scanned invite pinned the key, so the greeting is checked against it and a
          // mismatch is refused outright. Nothing here can be salvaged by asking the user: the
          // QR said which machine this is, and this is not it.
          if (invite.serverPublic !== null && !sameKey(invite.serverPublic, greeting.serverPublic)) {
            finish(() =>
              reject(
                new PairError(
                  'that address answered with a different key than the code you scanned. Do not ' +
                    'continue — scan the code again from the machine itself.',
                ),
              ),
            )
            return
          }

          serverPublic = greeting.serverPublic
          channel = deriveChannel(secret, serverPublic, handshake, new Uint8Array())

          // Pinned: nothing to adjudicate, so the code goes now. Unpinned: the key came off the
          // wire, so the code waits behind a person comparing six digits.
          if (invite.serverPublic !== null) {
            sendCode(channel)
          } else if (options.confirm === undefined) {
            finish(() =>
              reject(
                new PairError(
                  'this pairing has no key to check against and no way to ask you to confirm one',
                ),
              ),
            )
          } else {
            holdTheClock()
            void options.confirm(channel.sas).then(
              (agreed) => {
                if (settled) return
                if (!agreed) {
                  finish(() =>
                    reject(
                      new PairError(
                        'pairing stopped. If the numbers did not match, somebody may be between ' +
                          'this phone and that machine — try again on a network you trust.',
                      ),
                    ),
                  )
                  return
                }
                // Non-null by construction: it was assigned before this promise was made.
                startTheClock()
                sendCode(channel as Channel)
              },
              () => finish(() => reject(new PairError('pairing stopped'))),
            )
          }
          return
        }

        let body: ServerFrame['body']
        try {
          // cide answers a device it does not know in the clear; during pairing there is no
          // device yet, so anything unsealed here is a refusal worth reading.
          body =
            data[0] === 0x7b
              ? (JSON.parse(decodeUtf8(data)) as ServerFrame).body
              : (JSON.parse(decodeUtf8(channel.open(data))) as ServerFrame).body
        } catch (error) {
          finish(() =>
            reject(
              new PairError(
                'cide answered with something this app could not read — check that the address ' +
                  'belongs to the cide that showed you the code',
              ),
            ),
          )
          void error
          return
        }

        if (body.t === 'paired') {
          finish(() =>
            resolve({
              // cide's own answer outranks the invite's, and on the typed road it is the
              // only source: that road knows an address and eight characters and nothing about
              // which machine answered. The QR's copy is kept as the fallback so a scanned
              // pairing behaves exactly as it did.
              instanceId: body.instance || invite.instanceId || host,
              label: body.label || invite.label,
              hosts: invite.hosts,
              deviceId: body.device,
              // The key this connection actually derived against — checked against the QR's
              // above when there was one, and confirmed by the six digits when there was not.
              serverPublic: serverPublic ?? invite.serverPublic ?? new Uint8Array(32),
              key: fromHex(body.key),
            }),
          )
          return
        }
        if (body.t === 'error') {
          // cide's own sentence, carried through. It is written for a person to read, and this
          // app has nothing better to say about a code that expired or was already used.
          finish(() => reject(new PairError(body.detail)))
          return
        }
      },
      onClose: () =>
        finish(() => reject(new Error('cide closed the connection before answering'))),
      onError: (error) =>
        finish(() => reject(error instanceof Error ? error : new Error('the connection failed'))),
    })
  })
}

/** Check the invite's protocol before spending the code on a cide this app cannot talk to. */
export function pairable(invite: Invite): string | null {
  if (invite.protocol === PROTOCOL_VERSION) return null
  return invite.protocol > PROTOCOL_VERSION
    ? `${invite.label} speaks protocol ${invite.protocol}; this app speaks ${PROTOCOL_VERSION}. Update the app.`
    : `${invite.label} speaks protocol ${invite.protocol}; this app speaks ${PROTOCOL_VERSION}. Update cide.`
}
