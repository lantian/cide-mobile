import { describe, expect, it } from 'vitest'
import { freshMemory, judge, remember } from '../src/pairing/scan'

const URI = 'cide://pair?v=1&i=abc&m=seal&k=KKK&h=192.168.1.4:17643&c=0RXVJ6ZE'

describe('what the camera hands us', () => {
  it('accepts a pairing URI', () => {
    expect(judge(URI, freshMemory())).toEqual({ kind: 'pair', uri: URI })
  })

  it('acts on a symbol once however many frames it appears in', () => {
    // The assertion the whole module exists for: a pairing code is single use, and a scanner
    // reports the same symbol on every frame.
    let memory = freshMemory()
    const first = judge(URI, memory)
    expect(first.kind).toBe('pair')
    memory = remember(memory, URI)
    for (let frame = 0; frame < 40; frame++) {
      expect(judge(URI, memory)).toEqual({ kind: 'ignore' })
    }
  })

  it('refuses a foreign code without repeating it back', () => {
    const secret = 'https://example.invalid/someone/private/path?token=abcd'
    const verdict = judge(secret, freshMemory())
    expect(verdict.kind).toBe('reject')
    // Camera input is arbitrary text and may be anybody's. It must not be drawn on screen.
    if (verdict.kind === 'reject') expect(verdict.why).not.toContain('example.invalid')
  })

  it('names the machine-side gesture when it refuses, because that is the actual next step', () => {
    const verdict = judge('WIFI:S=cafe;T=WPA;P=hunter2;;', freshMemory())
    expect(verdict.kind).toBe('reject')
    if (verdict.kind === 'reject') expect(verdict.why).toContain('Pair a device')
  })

  it('reads a scheme in any case, because a QR encoder may normalise it', () => {
    expect(judge('CIDE://PAIR?v=1&c=X', freshMemory()).kind).toBe('pair')
  })

  it('trims, because a QR payload may carry a trailing newline', () => {
    const verdict = judge(`  ${URI}\n`, freshMemory())
    expect(verdict).toEqual({ kind: 'pair', uri: URI })
  })

  it('says nothing about an empty read', () => {
    expect(judge('   ', freshMemory())).toEqual({ kind: 'ignore' })
  })

  it('lets a failed pairing be rescanned without moving the phone', () => {
    // `remember` is the caller's choice precisely so this is possible: a machine that was
    // asleep is not a reason to make somebody point the camera away and back.
    const memory = freshMemory()
    expect(judge(URI, memory).kind).toBe('pair')
    expect(judge(URI, memory).kind).toBe('pair')
  })
})
