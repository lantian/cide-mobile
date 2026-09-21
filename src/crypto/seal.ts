/**
 * The JavaScript half of cide's sealed transport.
 *
 * Its Rust twin is `crates/cide-remote/src/seal.rs`, and ADR 0015 is why the frames are boxed
 * rather than the socket: React Native's `WebSocket` exposes no certificate hook on either
 * platform, so pinning a self-signed certificate needs native work on both — and pinning *per
 * paired instance*, which is what this app actually requires, needs it twice.
 *
 * What is bought is not merely parity with TLS. **After pairing, no credential is ever sent.**
 * This device is identified in the handshake, which is public, and authenticated by being able
 * to seal a frame cide can open. A device with the wrong key is not told it is wrong; it is not
 * understood.
 *
 * # This file is a second spelling, and the vectors are what keep it honest
 *
 * Every constant, every byte order and every label below must match the Rust exactly, and none
 * of the ways they can disagree produce an error message that says so — a wrong label produces a
 * different key, and a different key produces a connection that opens and then goes quiet. So
 * `test/seal.test.ts` runs cide's own generated vectors through this code. Change anything here
 * and regenerate them; if you cannot regenerate them, do not change anything here.
 *
 * # The shape
 *
 *   client → server   "cide-seal" 01 | mode | e_pub[32] | len | device-id      (once, in the clear)
 *   both ways         counter[8] | XChaCha20-Poly1305(key, prefix ‖ counter, json)
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha'
import { x25519 } from '@noble/curves/ed25519'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import { blake3 } from '@noble/hashes/blake3'
import { randomBytes } from './random'
import { decodeUtf8, encodeUtf8 } from './utf8'

/** The first bytes of a handshake, so a frame that is not one is refused rather than parsed. */
export const MAGIC = encodeUtf8('cide-seal')

/**
 * The tag on the server's greeting — deliberately *not* `MAGIC`.
 *
 * The two opening messages cross in flight, so a client handed a handshake, or a server handed a
 * greeting, must fail as **the wrong message** rather than as a corrupt one. A shared tag would
 * let one decode as a truncated version of the other.
 */
export const HAIL = encodeUtf8('cide-hail')

/**
 * The handshake's own version, separate from the protocol's.
 *
 * They move for different reasons: a frame can be added without changing how frames are sealed,
 * and the sealing could change without the vocabulary moving.
 */
export const SEAL_VERSION = 2

/** What a connection is for. */
export const Mode = { Pair: 0, Resume: 1 } as const
export type Mode = (typeof Mode)[keyof typeof Mode]

const LABEL_TRANSCRIPT = encodeUtf8('cide-remote/seal/1')
const LABEL_KEYS = encodeUtf8('cide-remote/seal/keys/1')

export interface Handshake {
  mode: Mode
  /** This connection's ephemeral public key. */
  ephemeral: Uint8Array
  /** Empty when pairing: there is no device yet. */
  device: string
}

/** The bytes a client sends first, in the clear. */
export function encodeHandshake(handshake: Handshake): Uint8Array {
  const id = encodeUtf8(handshake.device)
  if (id.length > 255) throw new Error('a device id longer than 255 bytes cannot be sent')
  const out = new Uint8Array(MAGIC.length + 2 + 32 + 1 + id.length)
  let at = 0
  out.set(MAGIC, at)
  at += MAGIC.length
  out[at++] = SEAL_VERSION
  out[at++] = handshake.mode
  out.set(handshake.ephemeral, at)
  at += 32
  out[at++] = id.length
  out.set(id, at)
  return out
}

/** A fresh ephemeral key and the handshake that announces it. */
export function beginHandshake(mode: Mode, device: string): { handshake: Handshake; secret: Uint8Array } {
  const secret = randomBytes(32)
  return {
    secret,
    handshake: { mode, ephemeral: x25519.getPublicKey(secret), device },
  }
}

/** One direction's cipher and counter. */
class Lane {
  private counter = 0n

  constructor(
    private readonly key: Uint8Array,
    private readonly prefix: Uint8Array,
  ) {}

  private nonce(counter: bigint): Uint8Array {
    const nonce = new Uint8Array(24)
    nonce.set(this.prefix, 0)
    new DataView(nonce.buffer).setBigUint64(16, counter, false)
    return nonce
  }

  /** `counter ‖ ciphertext`. */
  seal(plaintext: Uint8Array): Uint8Array {
    const counter = this.counter
    const header = new Uint8Array(8)
    new DataView(header.buffer).setBigUint64(0, counter, false)
    // The counter is authenticated as associated data rather than merely sent, or an observer
    // could renumber frames and the cipher would not notice.
    const box = xchacha20poly1305(this.key, this.nonce(counter), header).encrypt(plaintext)
    this.counter = counter + 1n
    const out = new Uint8Array(8 + box.length)
    out.set(header, 0)
    out.set(box, 8)
    return out
  }

  /**
   * Open a frame, or throw.
   *
   * **Exact succession**, not mere increase — the Rust does the same, for the same reason: a
   * WebSocket delivers in order and drops nothing, so a gap is a bug or an attack and there is no
   * reason to be lenient about which. A replay is a counter already used, and this refuses it.
   */
  open(frame: Uint8Array): Uint8Array {
    if (frame.length < 8) throw new SealError('that frame is too short to be one')
    const header = frame.subarray(0, 8)
    const counter = new DataView(header.buffer, header.byteOffset, 8).getBigUint64(0, false)
    if (counter !== this.counter) {
      throw new SealError('that frame arrived out of order')
    }
    const plaintext = xchacha20poly1305(this.key, this.nonce(counter), header).decrypt(
      frame.subarray(8),
    )
    this.counter = counter + 1n
    return plaintext
  }
}

export class SealError extends Error {}

/** Both directions of one connection. */
export class Channel {
  constructor(
    private readonly inbound: Lane,
    private readonly outbound: Lane,
    /**
     * Six digits, for a person to compare against the six on cide's screen.
     *
     * It falls out of the same expansion as the keys, so it binds to the Diffie-Hellman result
     * as well as to the transcript. It is the *only* thing standing between a typed pairing and
     * somebody relaying the connection: a relay holds two exchanges, with its own static key
     * towards this phone and its own ephemeral key towards cide, and the two transcripts — and
     * so the two numbers — differ. Everything else about a relayed connection looks perfect.
     */
    readonly sas: string = '',
  ) {}

  seal(plaintext: Uint8Array): Uint8Array {
    return this.outbound.seal(plaintext)
  }

  open(frame: Uint8Array): Uint8Array {
    return this.inbound.open(frame)
  }
}

/**
 * The 96 bytes both ends expand to: a key and a 16-byte nonce prefix each way.
 *
 * Split out because there are two callers with *different inputs and identical arithmetic* — a
 * client that has an ephemeral secret and the server's public key, and a server that has its own
 * secret and the client's ephemeral public key — and the one thing that must not differ between
 * them is the transcript. Writing it twice is how the two ends end up deriving cleanly and
 * understanding nothing.
 */
function material(
  shared: Uint8Array,
  serverPublic: Uint8Array,
  handshake: Handshake,
  psk: Uint8Array,
): Uint8Array {
  const transcript = blake3
    .create({})
    .update(LABEL_TRANSCRIPT)
    .update(new Uint8Array([SEAL_VERSION, handshake.mode]))
    .update(handshake.ephemeral)
    .update(serverPublic)
    .update(encodeUtf8(handshake.device))
    .digest()

  const ikm = new Uint8Array(psk.length + shared.length)
  ikm.set(psk, 0)
  ikm.set(shared, psk.length)
  return hkdf(sha256, ikm, transcript, LABEL_KEYS, 104)
}

/**
 * Eight bytes down to six digits, the same arithmetic as `Sas::from_bytes` in Rust.
 *
 * Big-endian, modulo a million, zero-padded to six. Every one of those four choices is a place
 * the two languages could disagree and produce a mismatch a person would read as an attack, so
 * `contract/seal-vectors.json` pins the digits for each case and `seal.test.ts` checks them.
 *
 * `BigInt` and not arithmetic on a `number`: eight bytes is 64 bits and a double carries 53, so
 * the top eleven bits would be silently rounded away — which still yields six plausible digits.
 */
function sasFrom(bytes: Uint8Array): string {
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  return String(value % 1_000_000n).padStart(6, '0')
}

/** The digits as a person reads them: `418 302`. Spaced in one place, on both sides. */
export function groupSas(digits: string): string {
  return `${digits.slice(0, 3)} ${digits.slice(3)}`
}

/** What the server says first: which sealing it speaks, and the key to derive against. */
export interface Greeting {
  sealVersion: number
  serverPublic: Uint8Array
}

/**
 * Read the greeting, or `null` if this is not one.
 *
 * Exact length and not "at least" — `decodeHandshake`'s rule, for its reason: trailing bytes
 * mean this is not the message it claims to be.
 */
export function decodeGreeting(bytes: Uint8Array): Greeting | null {
  if (bytes.length !== HAIL.length + 33) return null
  for (const [i, byte] of HAIL.entries()) if (bytes[i] !== byte) return null
  // The length is exact and was just checked, so this index cannot be out of range — the
  // narrowing is what `noUncheckedIndexedAccess` cannot see, not a guess about the data.
  return {
    sealVersion: bytes[HAIL.length] as number,
    serverPublic: bytes.slice(HAIL.length + 1),
  }
}

/**
 * Derive this connection's channel, as the **client**.
 *
 * `psk` is the device's key when resuming and empty when pairing. It is mixed into the input
 * keying material rather than used as the salt, so a wrong key produces a different channel
 * rather than a detectable failure at a known point.
 *
 * The nonce prefixes come out of the same expansion and are **never sent**: they cost no round
 * trip, and because they are a function of a transcript containing a fresh ephemeral key, two
 * connections under one long-lived key can never reuse a nonce. That is the one place this
 * design is catastrophic rather than merely broken if it is got wrong.
 */
export function deriveChannel(
  ephemeralSecret: Uint8Array,
  serverPublic: Uint8Array,
  handshake: Handshake,
  psk: Uint8Array,
): Channel {
  const bytes = material(
    x25519.getSharedSecret(ephemeralSecret, serverPublic),
    serverPublic,
    handshake,
    psk,
  )
  // c2s is what this end *sends*; s2c is what it receives. Getting these the wrong way round is
  // a channel that derives cleanly and understands nothing, which is why the vectors check both
  // directions rather than one.
  return new Channel(
    new Lane(bytes.subarray(32, 64), bytes.subarray(80, 96)),
    new Lane(bytes.subarray(0, 32), bytes.subarray(64, 80)),
    sasFrom(bytes.subarray(96, 104)),
  )
}

/**
 * The same channel, from the **server's** side.
 *
 * Here for the mock cide in `tools/`, which has to be a real peer if the tests that drive this
 * app's reconnect logic are to mean anything. It is the mirror image and nothing more: the same
 * shared secret reached from the other end, the same transcript, and the two lanes swapped.
 */
export function deriveServerChannel(
  serverSecret: Uint8Array,
  handshake: Handshake,
  psk: Uint8Array,
): Channel {
  const serverPublic = x25519.getPublicKey(serverSecret)
  const bytes = material(
    x25519.getSharedSecret(serverSecret, handshake.ephemeral),
    serverPublic,
    handshake,
    psk,
  )
  return new Channel(
    new Lane(bytes.subarray(0, 32), bytes.subarray(64, 80)),
    new Lane(bytes.subarray(32, 64), bytes.subarray(80, 96)),
    sasFrom(bytes.subarray(96, 104)),
  )
}

/** Read a handshake off the wire. The mock server's half of `encodeHandshake`. */
export function decodeHandshake(bytes: Uint8Array): Handshake | null {
  if (bytes.length < MAGIC.length + 35) return null
  for (const [i, byte] of MAGIC.entries()) if (bytes[i] !== byte) return null
  let at = MAGIC.length
  if (bytes[at++] !== SEAL_VERSION) return null
  const mode = bytes[at++]
  if (mode !== Mode.Pair && mode !== Mode.Resume) return null
  const ephemeral = bytes.subarray(at, at + 32)
  at += 32
  const len = bytes[at++] ?? 0
  // Exactly, not at least: trailing bytes mean this is not the frame it claims to be.
  if (bytes.length !== at + len) return null
  return { mode, ephemeral, device: decodeUtf8(bytes.subarray(at, at + len)) }
}

/** URL-safe base64 without padding — what a pairing payload carries a key as. */
export function fromBase64Url(text: string): Uint8Array {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let acc = 0
  let bits = 0
  const out: number[] = []
  for (const c of text) {
    const value = ALPHABET.indexOf(c)
    if (value < 0) throw new SealError(`${JSON.stringify(c)} is not base64url`)
    acc = (acc << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((acc >> bits) & 0xff)
    }
  }
  return new Uint8Array(out)
}

/** Hex, as the pairing frame hands a key over. */
export function fromHex(text: string): Uint8Array {
  if (text.length % 2 !== 0) throw new SealError('a key is an even number of hex digits')
  const out = new Uint8Array(text.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) throw new SealError('a key is hex')
    out[i] = byte
  }
  return out
}
