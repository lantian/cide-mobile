/**
 * Parsing a pairing payload.
 *
 * Nothing here is secret — it is an id, a name, addresses, a public key and a single-use code —
 * but it is the only description this app ever gets of *which cide it is talking to*, so every
 * refusal is by name. A payload wrong in a small way is otherwise a device that pairs with
 * nothing and cannot say why.
 */
import { describe, expect, it } from 'vitest'
import { InviteError, normaliseCode, parseInvite, parseTyped } from '../src/pairing/parse'

const key = 'A'.repeat(43)
const uri = (over: Record<string, string> = {}) => {
  const params = new URLSearchParams({
    v: '1',
    i: 'i-abc',
    n: '[DEV] thinkpad',
    m: 'seal',
    k: key,
    h: '192.168.1.4:17643,[fd00::1]:17643',
    c: 'K7M2-QX4B',
    ...over,
  })
  return `cide://pair?${params.toString()}`
}

describe('parseInvite', () => {
  it('reads what cide printed', () => {
    const invite = parseInvite(uri())
    expect(invite.protocol).toBe(1)
    expect(invite.instanceId).toBe('i-abc')
    expect(invite.label).toBe('[DEV] thinkpad')
    // A list, in order: a machine has several addresses and the useful one changes with the
    // network.
    expect(invite.hosts).toEqual(['192.168.1.4:17643', '[fd00::1]:17643'])
    expect(invite.serverPublic).toHaveLength(32)
    // Normalised, because the dash is there so eight characters can be read off a screen.
    expect(invite.code).toBe('K7M2QX4B')
  })

  it('ignores a key it does not know, because a newer cide may add one', () => {
    expect(() => parseInvite(uri({ futureThing: 'whatever' }))).not.toThrow()
  })

  it('refuses a transport it cannot speak, and says which end to update', () => {
    expect(() => parseInvite(uri({ m: 'wss' }))).toThrow(/Update one of them/)
  })

  it('refuses a key of the wrong length', () => {
    // Half a key derives a channel that opens nothing, which is the failure this is here to
    // turn into a sentence.
    expect(() => parseInvite(uri({ k: 'AAAA' }))).toThrow(InviteError)
    expect(() => parseInvite(uri({ k: 'not base64url!!' }))).toThrow(/cannot read/)
  })

  it('refuses anything missing, by name', () => {
    // `i` is deliberately absent from this list. cide stopped spending 38 characters of a
    // photographed payload on an instance id the `Paired` frame already carries — see the next
    // test, which is the one that would fail if it came back as a requirement.
    for (const [key, word] of [
      ['v', 'protocol'],
      ['k', 'key'],
      ['h', 'address'],
      ['c', 'code'],
    ] as const) {
      expect(() => parseInvite(uri({ [key]: '' })), key).toThrow(new RegExp(word))
    }
  })

  it('reads the compact payload, with every address and one shared port', () => {
    // The shape cide actually writes. Carrying *all* the addresses is the requirement — a
    // machine has no way to know which of its ten private ones a phone can reach, and an
    // earlier version capped the list to shrink the symbol and dropped the only one that
    // worked. The size comes out of the encoding instead: one port for all of them, bare
    // commas, and no instance id or display name.
    const invite = parseInvite(
      'cide://pair?v=1&m=seal&k=zo060cy2M-x7cMF4FKXHbs0CloUFDTRHRboFhw5YfVk' +
        '&p=17643&h=192.168.31.31,10.215.2.1,10.8.1.5&c=0RXVJ6ZE',
    )
    expect(invite.hosts).toEqual(['192.168.31.31:17643', '10.215.2.1:17643', '10.8.1.5:17643'])
    expect(invite.instanceId).toBeNull()
    expect(invite.serverPublic).not.toBeNull()
  })

  it('brackets an IPv6 address when it puts the shared port back on', () => {
    // cide sends no brackets and is right not to: they exist only to separate an address from
    // the port glued to it, and the port travels separately now. A *URL* needs them back —
    // `ws://fd00::1:17643` is not the machine that sent the code, whatever it parses as.
    const invite = parseInvite(
      'cide://pair?v=1&m=seal&k=zo060cy2M-x7cMF4FKXHbs0CloUFDTRHRboFhw5YfVk' +
        '&p=17643&h=fd00::1,192.168.1.4&c=0RXVJ6ZE',
    )
    expect(invite.hosts).toEqual(['[fd00::1]:17643', '192.168.1.4:17643'])
  })

  it('still reads an address that carries its own port', () => {
    // The older spelling. Reading both costs three lines against a payload that parses to an
    // address nothing can dial, whose only symptom is a pairing that will not connect.
    const invite = parseInvite(
      'cide://pair?v=1&m=seal&k=zo060cy2M-x7cMF4FKXHbs0CloUFDTRHRboFhw5YfVk' +
        '&h=192.168.1.4%3A17643&c=0RXVJ6ZE',
    )
    expect(invite.hosts).toEqual(['192.168.1.4:17643'])
  })

  it('refuses a code of the wrong length', () => {
    expect(() => parseInvite(uri({ c: 'SHORT' }))).toThrow(/eight characters/)
  })

  it('refuses something that is not a pairing code at all', () => {
    expect(() => parseInvite('https://example.com')).toThrow(/not a cide pairing code/)
    expect(() => parseInvite('')).toThrow(InviteError)
  })
})

describe('parseTyped', () => {
  it('takes an address and a code, however the code was typed', () => {
    expect(parseTyped('192.168.1.4:17643', 'k7m2-qx4b')).toEqual({
      host: '192.168.1.4:17643',
      code: 'K7M2QX4B',
    })
  })

  it('asks for the port rather than guessing one', () => {
    expect(() => parseTyped('192.168.1.4', 'K7M2QX4B')).toThrow(/include the port/)
  })

  it('asks for the brackets an IPv6 address needs', () => {
    // A bare v6 address and a port cannot be told apart, which is why cide prints the brackets.
    expect(() => parseTyped('fd00::1:17643', 'K7M2QX4B')).toThrow(/brackets/)
    expect(() => parseTyped('[fd00::1]:17643', 'K7M2QX4B')).not.toThrow()
  })

  it('catches the four characters cide never mints', () => {
    // Refusing here rather than at the server saves a burnt code for a typo the user can see:
    // one wrong guess and the code is gone.
    expect(() => parseTyped('h:1', 'K7M2QX4O')).toThrow(/1 and 0/)
    expect(() => parseTyped('h:1', 'K7M2QX4I')).toThrow(/I, L, O or U/)
  })
})

describe('normaliseCode', () => {
  it('keeps only what a code is made of', () => {
    expect(normaliseCode(' k7m2-qx4b ')).toBe('K7M2QX4B')
    expect(normaliseCode('K7M2 QX4B')).toBe('K7M2QX4B')
  })
})

describe('pairable', () => {
  it('refuses to spend a code on a cide this app cannot talk to', async () => {
    const { pairable } = await import('../src/net/pair')
    const invite = parseInvite(uri())
    expect(pairable({ ...invite, protocol: invite.protocol })).toBeNull()
    // A code is single use, so checking *before* redeeming is the difference between a clear
    // message and a burnt code plus a confusing one.
    expect(pairable({ ...invite, protocol: invite.protocol + 5 })).toMatch(/Update the app/)
    expect(pairable({ ...invite, protocol: invite.protocol - 1 })).toMatch(/Update cide/)
  })
})
