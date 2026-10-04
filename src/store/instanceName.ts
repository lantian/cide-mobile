/**
 * What this phone calls a paired machine.
 *
 * Two names, kept apart on purpose. `label` is **cide's** name for itself — the host name, with
 * the profile in front — written by pairing. `alias` is the one the person holding the phone gave
 * it, and it never leaves the phone: renaming the machine for everyone is the desktop's decision,
 * made in its own settings, and a phone that could do it would be renaming a machine under every
 * other device paired with it.
 *
 * Kept as two fields rather than one overwritten label because each of the obvious one-field
 * versions loses something: clearing a rename would have nothing to fall back to, and re-pairing
 * the same machine — which rewrites the whole stored row — would silently undo it.
 *
 * Import-free, so the rules can be tested without expo.
 */

export interface Named {
  readonly label: string
  readonly alias?: string
}

/** The name to draw: the alias when there is one, cide's own name otherwise. */
export function nameOf(paired: Named): string {
  const alias = paired.alias?.trim() ?? ''
  return alias === '' ? paired.label : alias
}

/**
 * What a rename box's text means as an alias.
 *
 * Blank is "go back to cide's name", and so is typing cide's name exactly: an alias equal to the
 * label would read as nothing more than the label, until the day the desktop's name changes and it
 * quietly stops following.
 */
export function aliasFrom(text: string, label: string): string | undefined {
  const trimmed = text.trim()
  return trimmed === '' || trimmed === label ? undefined : trimmed
}
