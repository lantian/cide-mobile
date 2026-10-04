/**
 * What pairing a machine this phone already knows does to the row it already has.
 *
 * The same cide is often reachable two ways — its LAN address at home, a VPN or forwarded
 * address from anywhere else — and the way to teach the phone the second one is to pair again
 * over it. `instances.save` keys on the instance id, so that second pairing lands on the first
 * one's row, and it used to *replace* it: the new address in, the old one gone, and a phone that
 * had just learned the remote road forgot the local one.
 *
 * So a re-pair adds rather than replaces. The key is the new pairing's — it is the one cide
 * handed out last, and the old device's record on cide is now a spare the user can revoke — but
 * the addresses are the union and the user's rename survives.
 *
 * Import-free, so the rules can be tested without expo.
 */

/**
 * Every address either pairing knew, the new pairing's first.
 *
 * New first because it is the one that has just been shown to work. Order after that matters
 * less than it looks: the connection moves to the next address the moment one does not answer,
 * and remembers whichever one did.
 */
export function mergeHosts(incoming: readonly string[], stored: readonly string[]): string[] {
  return [...new Set([...incoming, ...stored])]
}

/**
 * The alias a pairing should be saved with, given the one already stored for that instance.
 *
 * A fresh pairing carries none — cide does not know it — so a re-pair of a machine this phone had
 * renamed keeps the rename. Losing it there would be the one place the feature visibly forgets.
 */
export function keepAlias(incoming: string | undefined, stored: string | undefined): string | undefined {
  return incoming ?? stored
}
