/**
 * Where random bytes come from, which is not the same question on every platform.
 *
 * Node and every browser have `crypto.getRandomValues`. **Hermes does not**, and React Native
 * does not polyfill it — so `@noble`'s `randomBytes`, which reaches for it, throws on the one
 * platform this app actually runs on. It throws at the *call*, which makes it a pairing that
 * fails rather than a screen that never renders, which is only a slightly better failure.
 *
 * So the source is injected. The app installs Expo's at startup; the tests and Node use the
 * global. Nothing in `seal.ts` knows which, and a missing source is a **named** failure rather
 * than an `undefined is not a function` from three libraries down.
 */
export type RandomSource = (length: number) => Uint8Array

let source: RandomSource | null = null

/** Install the platform's source. Called once, from the app's root. */
export function installRandom(fn: RandomSource): void {
  source = fn
}

/** `length` bytes from the best source available. */
export function randomBytes(length: number): Uint8Array {
  if (source !== null) return source(length)
  const webcrypto = (globalThis as { crypto?: Crypto }).crypto
  if (webcrypto?.getRandomValues !== undefined) {
    return webcrypto.getRandomValues(new Uint8Array(length))
  }
  throw new Error(
    'no source of randomness is available — call installRandom() before pairing or connecting',
  )
}
