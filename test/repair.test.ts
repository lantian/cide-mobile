import { describe, expect, it } from 'vitest'
import { keepAlias, mergeHosts } from '../src/store/repair'

describe('pairing a machine this phone already knows', () => {
  it('adds the new addresses rather than replacing the old ones', () => {
    // Paired at home over the LAN, then again over the remote address: both are kept, the one
    // just shown to work first.
    expect(mergeHosts(['10.8.1.5:17643'], ['192.168.31.31:17643'])).toEqual([
      '10.8.1.5:17643',
      '192.168.31.31:17643',
    ])
  })

  it('does not list an address twice', () => {
    expect(mergeHosts(['a:1', 'b:1'], ['b:1', 'c:1'])).toEqual(['a:1', 'b:1', 'c:1'])
  })

  it('keeps a rename, since a pairing never carries one', () => {
    expect(keepAlias(undefined, 'Work laptop')).toBe('Work laptop')
    expect(keepAlias(undefined, undefined)).toBeUndefined()
    expect(keepAlias('New', 'Work laptop')).toBe('New')
  })
})
