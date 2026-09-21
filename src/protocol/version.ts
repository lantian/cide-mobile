/**
 * What this build of the app speaks, and what to do when an instance speaks something else.
 *
 * The number itself comes from the vendored `generated.ts`, so it cannot disagree with the
 * protocol it describes — which is the entire reason `PROTOCOL_VERSION` is emitted into that file
 * rather than written down here.
 */
import { PROTOCOL_VERSION } from './generated'

export { PROTOCOL_VERSION }

/** Whether this app can talk to an instance announcing `theirs`. */
export function compatible(theirs: number): boolean {
  // Equal, for now, and deliberately strict. Adding a frame or an optional field keeps the
  // number on the cide side, so a version that differs at all is a version where something was
  // removed or changed meaning — and guessing which is how an app silently stops sending a field
  // the server still requires.
  return theirs === PROTOCOL_VERSION
}

/**
 * What to tell the user, naming which end is behind.
 *
 * A sentence rather than a code, and it says which one to update, because "protocol mismatch" on
 * a phone screen is a dead end for the person reading it.
 */
export function mismatch(theirs: number, instance: string): string {
  if (theirs > PROTOCOL_VERSION) {
    return `${instance} speaks protocol ${theirs}; this app speaks ${PROTOCOL_VERSION}. Update the app.`
  }
  return `${instance} speaks protocol ${theirs}; this app speaks ${PROTOCOL_VERSION}. Update cide.`
}
