/**
 * What to do with something the camera just read.
 *
 * A barcode scanner is a firehose: `expo-camera` reports the same symbol on every frame for as
 * long as it is in shot, which is tens of times a second, and it reports *any* symbol in shot,
 * including a shipping label behind the laptop. A pairing code is single use, so a handler that
 * acted on every callback would spend the code on the first frame and then report a wrong-code
 * failure for each of the next forty — burning the code and explaining the failure wrongly.
 *
 * So the rule is decided here, as a pure function over the scan and what has been seen, and the
 * screen only renders the answer. It is a pure module for the reason the rest of `src/` is: a
 * camera cannot be driven by a test and a decision can.
 */

/** A payload we will act on, or a reason we will not, or silence. */
export type ScanVerdict =
  | { kind: 'pair'; uri: string }
  /** Show this; the user is pointing at something, and it is not us. */
  | { kind: 'reject'; why: string }
  /** Say nothing at all: a repeat of what we already answered. */
  | { kind: 'ignore' }

/** What the caller carries between frames. Start it as `{ last: null, rejected: null }`. */
export interface ScanMemory {
  /** The last payload acted upon or rejected, whatever the verdict was. */
  last: string | null
}

/**
 * The scheme is checked before anything else is parsed.
 *
 * Deliberately not "does it contain a code": a QR on a parcel, a Wi-Fi join code and a URL to
 * somebody's website are all things a camera pointed at a desk will read, and each would
 * otherwise produce a parse failure phrased as though the user had pointed at the right thing
 * and cide had gone wrong.
 */
const PREFIX = 'cide://pair'

export function judge(raw: string, memory: ScanMemory): ScanVerdict {
  const payload = raw.trim()

  // Same symbol, still in shot. This arm is why the code is spent once, and it comes first
  // because it is true for the overwhelming majority of frames.
  if (payload === memory.last) return { kind: 'ignore' }

  if (payload.length === 0) return { kind: 'ignore' }

  if (!payload.toLowerCase().startsWith(PREFIX)) {
    // The payload is *not* echoed back into the message. It is arbitrary text from a camera —
    // it may be a URL, it may be long, and it may be somebody's private data that has no
    // business being drawn on a screen in a sentence about pairing.
    return {
      kind: 'reject',
      why: 'That is a code, but not a cide pairing code. Open Settings → Remote access on the machine and press “Pair a device…”.',
    }
  }

  return { kind: 'pair', uri: payload }
}

/**
 * Fold a verdict into the memory. Separate from `judge` so a caller can decide *not* to
 * remember one — a pairing that failed for a transient reason (the machine was asleep, the
 * Wi-Fi dropped) should be scannable again without moving the phone away and back.
 */
export function remember(memory: ScanMemory, payload: string): ScanMemory {
  return { last: payload.trim() }
}

export const freshMemory = (): ScanMemory => ({ last: null })
