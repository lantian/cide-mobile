/**
 * The milestone card rules — the same verdicts the desk's Milestones tab draws. (M91)
 */
import { describe, expect, it } from 'vitest'
import {
  ago,
  byLine,
  cards,
  changeKind,
  current,
  gateLine,
  lastLines,
  planDiff,
  summary,
  verdictKind,
} from '../src/agents/milestones'
import type { CheckResult, MilestonesView } from '../src/protocol/generated'

const NOW = 1_700_000_600_000

const result = (over: Partial<CheckResult> = {}): CheckResult => ({
  command: 'cargo test',
  passed: true,
  timedOut: false,
  tail: 'ok',
  startedUnixMs: NOW - 120_000,
  durationMs: 42_000,
  ...over,
})

const view = (over: Partial<MilestonesView> = {}): MilestonesView =>
  ({
    project: 'p-1',
    plan: {
      items: [
        { id: 'm1', title: 'Slice one', gate: 'cargo test' },
        { id: 'm2', title: 'Slice two', gate: 'cargo test --all' },
      ],
      verify: '',
      guardPaths: [],
    },
    gates: [],
    accepted: [],
    tasks: [
      {
        milestone: 'm1',
        tasks: [
          { id: 't1', title: 'a', status: 'done', depth: 0 },
          { id: 't2', title: 'b', status: 'doing', depth: 0 },
        ],
      },
    ],
    verifies: [],
    proposals: [],
    ...over,
  }) as MilestonesView

describe('the gate verdict', () => {
  it('reads running first, then the last result', () => {
    expect(verdictKind(true, result({ passed: false }))).toBe('running')
    expect(verdictKind(false, undefined)).toBe('none')
    expect(verdictKind(false, result())).toBe('passed')
    expect(verdictKind(false, result({ passed: false }))).toBe('failed')
  })

  it('says what happened, when, and how long it took', () => {
    expect(gateLine(true, undefined, NOW)).toBe('gate running…')
    expect(gateLine(false, undefined, NOW)).toBe('gate not run yet')
    expect(gateLine(false, result(), NOW)).toBe('gate passed · 2 min ago · 42s')
    expect(gateLine(false, result({ passed: false, exitCode: 101 }), NOW)).toBe(
      'gate failed, exit 101 · 2 min ago · 42s',
    )
    expect(gateLine(false, result({ passed: false, timedOut: true }), NOW)).toBe(
      'gate timed out · 2 min ago',
    )
  })

  it('counts time the short way', () => {
    expect(ago(NOW - 5_000, NOW)).toBe('just now')
    expect(ago(NOW - 3 * 3_600_000, NOW)).toBe('3 h ago')
    expect(ago(NOW - 2 * 86_400_000, NOW)).toBe('2 d ago')
  })

  it('keeps the end of a log, where the verdict is', () => {
    expect(lastLines('a\nb\nc\n', 2)).toBe('b\nc')
  })
})

describe('the cards', () => {
  it('takes the first milestone as active when none is named', () => {
    expect(current(view())?.id).toBe('m1')
    expect(current(view({ plan: { ...view().plan, active: 'm2' } }))?.id).toBe('m2')
    // A stale `active` falls back rather than leaving nothing active.
    expect(current(view({ plan: { ...view().plan, active: 'gone' } }))?.id).toBe('m1')
  })

  it('offers run and accept only on the active milestone, and accept only once it passed', () => {
    const idle = cards(view(), NOW)
    expect(idle.map((c) => [c.active, c.runnable, c.acceptable])).toEqual([
      [true, true, false],
      [false, false, false],
    ])
    expect(idle[0]).toMatchObject({ done: 1, total: 2 })

    const running = cards(view({ gates: [{ milestone: 'm1', running: true }] }), NOW)
    expect(running[0]).toMatchObject({ verdict: 'running', runnable: false, acceptable: false })

    const passed = cards(view({ gates: [{ milestone: 'm1', running: false, last: result() }] }), NOW)
    expect(passed[0]).toMatchObject({ verdict: 'passed', acceptable: true })

    const accepted = cards(
      view({ gates: [{ milestone: 'm1', running: false, last: result() }], accepted: ['m1'] }),
      NOW,
    )
    expect(accepted[0]!.acceptable).toBe(false)
  })
})

describe('the machine row', () => {
  it('names the active milestone for one project', () => {
    const out = summary([view({ gates: [{ milestone: 'm1', running: true }] })], NOW)
    expect(out).toEqual({
      detail: 'Slice one · gate running…',
      running: true,
      failed: false,
      proposals: 0,
    })
  })

  it('counts across several', () => {
    const failing = view({ gates: [{ milestone: 'm1', running: false, last: result({ passed: false }) }] })
    const out = summary([failing, view({ project: 'p-2' as never })], NOW)
    expect(out.detail).toBe('2 projects · 1 failing')
    expect(out.failed).toBe(true)
  })

  it('says so when there are none', () => {
    expect(summary([], NOW).detail).toBe('No milestones')
    expect(summary([view({ plan: { items: [], verify: '', guardPaths: [] } })], NOW).detail).toBe(
      'No milestones',
    )
  })
})

describe('proposals', () => {
  const plan = (items: [string, string, string][], active?: string) => ({
    items: items.map(([id, title, gate]) => ({ id, title, gate })),
    ...(active === undefined ? {} : { active }),
    verify: '',
    guardPaths: [],
  })

  it('reads a plan change as added, changed, kept and removed', () => {
    const before = plan([
      ['m1', 'One', 'a'],
      ['m2', 'Two', 'b'],
    ])
    const after = plan(
      [
        ['m1', 'One', 'a'],
        ['m3', 'Three', 'c'],
        ['m2', 'Two!', 'b'],
      ],
      'm3',
    )
    expect(planDiff(before, after)).toEqual([
      '= One',
      '+ Three — $ c',
      '~ Two! (was “Two”)',
      'active → Three',
    ])
    expect(planDiff(after, before)).toContain('- Three')
  })

  it('says who proposed it and what kind of change it is', () => {
    const p = {
      id: 'p1',
      title: 't',
      rationale: 'r',
      by: { kind: 'agent', agent: 'planner', label: 'Planner' },
      createdUnixMs: 0,
      change: { kind: 'files', files: [{ path: 'a', diff: '' }, { path: 'b', diff: '' }] },
    } as never
    expect(byLine(p)).toBe('Planner')
    expect(changeKind(p)).toBe('2 files')
  })

  it('counts them on the machine row', () => {
    const withTwo = view({ proposals: [{} as never, {} as never] })
    expect(summary([withTwo], NOW).proposals).toBe(2)
    expect(summary([withTwo], NOW).detail).toContain('2 proposals')
  })
})
