import { beforeEach, describe, expect, it } from 'vitest'
import * as choice from '../src/store/projectChoice'

const open = [{ id: 'p1' }, { id: 'p2' }]

beforeEach(() => {
  choice.drop('inst')
  choice.drop('other')
})

describe('which project a screen shows', () => {
  it('shows every project until one is chosen', () => {
    expect(choice.resolve('inst', open)).toBeNull()
  })

  it('remembers a choice per instance, not globally', () => {
    // Two machines on the list, each with its own projects. One choice for both would filter a
    // second machine's screens on an id that belongs to the first.
    choice.choose('inst', 'p2')
    expect(choice.resolve('inst', open)).toBe('p2')
    expect(choice.resolve('other', open)).toBeNull()
  })

  it('falls back to every project when the chosen one has been closed', () => {
    // The failure this prevents looks like a right answer: filtering on an id nothing matches
    // renders an empty list, which reads as "this machine has nothing running" about a machine
    // that is busy. Showing more than was asked is the safe direction to be wrong in.
    choice.choose('inst', 'p2')
    expect(choice.resolve('inst', [{ id: 'p1' }])).toBeNull()
  })

  it('hands out a stable snapshot, or the screens re-render for ever', () => {
    // `useSyncExternalStore` compares with `Object.is`. A snapshot rebuilt per call is an
    // infinite render loop that ends at "Maximum update depth exceeded" and unmounts the root.
    const first = choice.getSnapshot()
    expect(choice.getSnapshot()).toBe(first)
    choice.choose('inst', 'p1')
    expect(choice.getSnapshot()).not.toBe(first)
  })

  it('does not announce a choice that did not change', () => {
    choice.choose('inst', 'p1')
    const snapshot = choice.getSnapshot()
    choice.choose('inst', 'p1')
    expect(choice.getSnapshot()).toBe(snapshot)
  })
})

describe('reading a per-project map', () => {
  const byProject = { p1: ['a', 'b'], p2: ['c'] }

  it('takes one project when one is chosen', () => {
    expect(choice.forProject(byProject, 'p1')).toEqual(['a', 'b'])
  })

  it('flattens every project when none is', () => {
    expect(choice.forProject(byProject, null).sort()).toEqual(['a', 'b', 'c'])
  })

  it('is empty rather than undefined for a project with nothing in it', () => {
    // The screens map over this. `undefined` would throw where an empty list renders the
    // "nothing here" sentence, which is the answer that was wanted.
    expect(choice.forProject(byProject, 'p9')).toEqual([])
  })
})

describe('swiping between projects', () => {
  it('steps through the chips in their order, All first', () => {
    expect(choice.nextChoice(open, null, 1)).toBe('p1')
    expect(choice.nextChoice(open, 'p1', 1)).toBe('p2')
    expect(choice.nextChoice(open, 'p2', -1)).toBe('p1')
    expect(choice.nextChoice(open, 'p1', -1)).toBeNull()
  })

  it('stops at either end rather than wrapping', () => {
    expect(choice.nextChoice(open, null, -1)).toBeUndefined()
    expect(choice.nextChoice(open, 'p2', 1)).toBeUndefined()
  })

  it('does nothing where there are no chips', () => {
    expect(choice.nextChoice([{ id: 'p1' }], null, 1)).toBeUndefined()
  })

  it('treats a choice that is gone as All', () => {
    expect(choice.nextChoice(open, 'closed', 1)).toBe('p1')
  })
})
