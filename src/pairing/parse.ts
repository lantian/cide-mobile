/**
 * What a pairing payload says, and what to refuse.
 *
 * cide's Settings screen shows a code and, when it can, a `cide://pair?…` URI. Both roads end
 * here. Everything in the payload is public — an instance id, a name, addresses, a public key and
 * a single-use code — so nothing here is a secret; what it is, is the only description this app
 * will ever get of *which cide it is talking to*, so a payload that is wrong in a small way is a
 * device that pairs with nothing and cannot say why.
 *
 * Every refusal below is therefore by name.
 */
import { fromBase64Url } from '../crypto/seal'

export interface Invite {
  /** The protocol the instance announced in its payload. Checked again at `welcome`. */
  readonly protocol: number
  /** Stable for the life of the instance — how a re-pair is recognised rather than duplicated. */
  /**
   * Which cide this is, across restarts and address changes — or `null` on the typed road,
   * where nobody has said yet. It is filled from the `Welcome` the connection answers with.
   *
   * Never a placeholder: the id is how a re-pair is recognised rather than added as a duplicate,
   * so one shared string would make every typed pairing look like the same machine.
   */
  readonly instanceId: string | null
  /** `thinkpad`, or `[DEV] thinkpad`. A default, not a name: the instance says its own at hello. */
  readonly label: string
  /** `host:port`, in the order to try them. */
  readonly hosts: readonly string[]
  /** The instance's long-lived public key. */
  /**
   * cide's public key, when the invite carried one — that is, when this came from a QR.
   *
   * `null` on the typed road, where all the user had was an address and eight characters. The
   * device then takes the key from the greeting, which anybody in the middle could have written,
   * and the six digits shown on both screens are what settles it. The two roads are therefore
   * not equally strong and this field is where the difference lives: a non-null key was
   * authenticated before a single byte was sealed.
   */
  readonly serverPublic: Uint8Array | null
  /** Eight characters, single use, two minutes. */
  readonly code: string
}

export class InviteError extends Error {}

/** The normalised form of a typed code: uppercase, no punctuation. */
export function normaliseCode(code: string): string {
  return [...code].filter((c) => /[a-zA-Z0-9]/.test(c)).join('').toUpperCase()
}

/**
 * Parse a scanned or pasted `cide://pair?…`.
 *
 * Lenient about what it does not need — an unknown query key is ignored, because a newer cide may
 * add one — and strict about everything it does.
 */
export function parseInvite(text: string): Invite {
  const trimmed = text.trim()
  if (!trimmed.startsWith('cide://pair')) {
    throw new InviteError('that is not a cide pairing code')
  }

  const query = trimmed.slice(trimmed.indexOf('?') + 1)
  const params = new URLSearchParams(trimmed.includes('?') ? query : '')

  const need = (key: string, what: string): string => {
    const value = params.get(key)
    if (value === null || value === '') throw new InviteError(`that pairing code carries no ${what}`)
    return value
  }

  const mode = params.get('m') ?? 'seal'
  if (mode !== 'seal') {
    // A transport this build cannot speak. Named, because the fix is updating one end and the
    // user needs to be told which.
    throw new InviteError(
      `that cide offers the "${mode}" transport; this app speaks "seal". Update one of them.`,
    )
  }

  const protocol = Number.parseInt(need('v', 'protocol version'), 10)
  if (!Number.isFinite(protocol)) throw new InviteError('that pairing code has no protocol version')

  // Still required here. A `cide://pair` line cide wrote always carries a key, so one without
  // it is truncated or edited rather than a typed pairing — the typed road does not build a URI
  // at all, it calls `typedInvite` and gets a `null` key honestly.
  let serverPublic: Uint8Array
  try {
    serverPublic = fromBase64Url(need('k', 'key'))
  } catch {
    throw new InviteError('that pairing code has a key this app cannot read')
  }
  if (serverPublic.length !== 32) {
    throw new InviteError('that pairing code has a key of the wrong length')
  }

  // `p` is the port every address shares, which is how the payload stays small enough to
  // photograph while carrying *all* of them — and carrying all of them is the point, because
  // cide cannot know which of a machine's ten private addresses a phone can reach.
  //
  // An address may still arrive with its own `:port` attached: that is the older spelling, and
  // reading both costs three lines against a class of failure — a code that parses to no usable
  // address — whose symptom is a pairing that cannot connect and says nothing about why.
  const shared = params.get('p')?.trim() ?? ''
  const hosts = need('h', 'address')
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host.length > 0)
    .map((host) => withPort(host, shared))
  if (hosts.length === 0) throw new InviteError('that pairing code carries no address')
  if (hosts.some((host) => !host.includes(':'))) {
    throw new InviteError('that pairing code has an address with no port')
  }

  const code = normaliseCode(need('c', 'code'))
  if (code.length !== 8) throw new InviteError('a pairing code is eight characters')

  return {
    protocol,
    // Optional since M74. cide stopped spending 38 characters of a photographed payload on
    // facts the `Paired` frame already carries — and two copies of one value are two values
    // that can disagree. `null` here is answered by the pairing itself.
    instanceId: params.get('i'),
    label: params.get('n') ?? 'cide',  // replaced by `Paired.label` the moment pairing answers
    hosts,
    serverPublic,
    code,
  }
}

/**
 * The typed road: an address and a code, and no key at all.
 *
 * A key cannot be typed — it is 32 bytes, and cide does not print it — so this road takes the
 * one the server greets with and settles it afterwards, by showing six digits on both screens
 * for a person to compare. That is strictly weaker than a scanned pairing, where the key was
 * known before anything was sealed, and [`typedInvite`] returning a `null` key is how the rest
 * of the app can tell which road it is on rather than having to remember.
 */
/**
 * A whole invite for the typed road, with no key and nothing invented.
 *
 * It exists so the typed road does not have to build a `cide://pair` URI to hand to
 * `parseInvite` — which is what it used to do, with a placeholder instance id and a key the
 * user had been asked to type. Going through the URI meant the one field that says *which road
 * this is* had to be faked, and a faked pinned key is indistinguishable from a real one exactly
 * where the difference matters.
 */
export function typedInvite(address: string, code: string, protocol: number): Invite {
  const typed = parseTyped(address, code)
  return {
    protocol,
    // Unknown until cide says so in its `Welcome`, and deliberately not guessed: the id is how
    // the app recognises a re-pair rather than adding a duplicate, and a placeholder shared by
    // every typed pairing would make two different machines look like one.
    instanceId: null,
    label: typed.host,
    hosts: [typed.host],
    serverPublic: null,
    code: typed.code,
  }
}

/**
 * Give a bare address its port, and an IPv6 address its brackets.
 *
 * The brackets are the whole reason this is a function. cide no longer sends them, and it is
 * right not to: a bracket is only needed to tell an address from the port glued to it, and the
 * port travels separately now — so `fd00::1` is unambiguous in the payload and costs two fewer
 * characters. But a *URL* needs them back, because `ws://fd00::1:17643` is not parseable and
 * whatever it does parse as, it is not the machine that sent the code.
 *
 * An address that already carries its own port is left exactly as it is, brackets and all.
 */
function withPort(host: string, shared: string): string {
  // Two or more colons is an IPv6 literal; one is a v4 address that already has its port.
  const colons = (host.match(/:/g) ?? []).length
  if (host.startsWith('[') || colons === 1) return host
  if (shared.length === 0) return host
  return colons > 1 ? `[${host}]:${shared}` : `${host}:${shared}`
}

export function parseTyped(address: string, code: string): { host: string; code: string } {
  const host = address.trim()
  if (host.length === 0) throw new InviteError('type the address cide is listening on')
  // A bare IPv6 address and a port cannot be told apart without brackets, which is why cide
  // prints them — and why an address with a colon in it and no brackets is ambiguous rather than
  // wrong.
  const looksV6 = (host.match(/:/g)?.length ?? 0) > 1 && !host.startsWith('[')
  if (looksV6) {
    throw new InviteError('put an IPv6 address in brackets, like [fd00::1]:17643')
  }
  if (!host.includes(':')) throw new InviteError('include the port, like 192.168.1.4:17643')

  const normalised = normaliseCode(code)
  if (normalised.length !== 8) throw new InviteError('a pairing code is eight characters')
  // The alphabet cide mints from, with the characters that are read wrongly left out. Refusing
  // here rather than at the server saves a burnt code for a typo the user can see.
  if (/[ILOU]/.test(normalised)) {
    throw new InviteError('a pairing code never contains I, L, O or U — check for 1 and 0')
  }
  return { host, code: normalised }
}
