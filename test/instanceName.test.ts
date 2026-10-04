import { describe, expect, it } from 'vitest'
import { aliasFrom, nameOf } from '../src/store/instanceName'

describe('what this phone calls a machine', () => {
  it('uses cide’s name until the user renames it', () => {
    expect(nameOf({ label: 'dev · thinkpad' })).toBe('dev · thinkpad')
    expect(nameOf({ label: 'dev · thinkpad', alias: 'Work laptop' })).toBe('Work laptop')
  })

  it('treats a blank alias as none', () => {
    expect(nameOf({ label: 'thinkpad', alias: '   ' })).toBe('thinkpad')
  })

  it('reads an empty box, or cide’s own name, as going back to cide’s name', () => {
    // An alias equal to the label would stop following the desktop the day its name changes.
    expect(aliasFrom('', 'thinkpad')).toBeUndefined()
    expect(aliasFrom('  thinkpad ', 'thinkpad')).toBeUndefined()
    expect(aliasFrom(' Work laptop ', 'thinkpad')).toBe('Work laptop')
  })
})
