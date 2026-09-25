import { describe, expect, it } from 'vitest'
import {
  AGENT_HUES,
  ORCHESTRATOR_COLOR,
  agentColor,
  authorColor,
  authorLabel,
  commentTime,
} from '../src/agents/author'
import {
  agentRows,
  machineCounts,
  machineSummary,
  canPause,
  filterTasks,
  matchesQuery,
  canResume,
  consoleCounts,
  isBusy,
  isLive,
  isWorking,
  liveRuns,
  queueState,
  pauseStateOf,
  runCounts,
  runLabel,
  summarise,
  taskCounts,
  taskRows,
  waitingByProject,
  waitingIn,
  shownState,
} from '../src/agents/model'
import type {
  AgentRun,
  AwaitingEntry,
  RemoteAgent,
  RemoteSession,
  RunState,
  TaskRow,
} from '../src/protocol/generated'

const run = (agent: string, state: RunState): AgentRun =>
  ({
    run: `r-${agent}-${state.state}`,
    agent,
    agentLabel: agent,
    harness: 'claude',
    project: 'p1',
    state,
    startedUnixMs: 1n,
    notify: {},
    staleTurn: false,
    openable: false,
  }) as unknown as AgentRun

const role = (id: string, over: Partial<RemoteAgent> = {}): RemoteAgent =>
  ({
    id,
    label: id,
    scope: 'project',
    harness: 'claude',
    description: '',
    maxConcurrent: 1,
    worktree: true,
    running: 0,
    queued: 0,
    ...over,
  }) as unknown as RemoteAgent

describe('what counts as a live run', () => {
  it('counts a paused run as alive', () => {
    // A `SIGSTOP`ped child still holds its worktree, its slot and its conversation. A row that
    // stopped counting it would show a role as idle while it holds the one slot that stops
    // anything else starting — and the Resume button would be on a row claiming nothing runs.
    expect(isLive({ state: 'paused', sinceUnixMs: 1n })).toBe(true)
    expect(canResume({ state: 'paused', sinceUnixMs: 1n })).toBe(true)
    expect(canPause({ state: 'paused', sinceUnixMs: 1n })).toBe(false)
  })

  it('does not count one that has ended', () => {
    for (const state of [
      { state: 'finished', code: 0 },
      { state: 'failed', reason: 'x' },
      { state: 'interrupted' },
      { state: 'queued' },
    ] as RunState[]) {
      expect(isLive(state), state.state).toBe(false)
      expect(canPause(state), state.state).toBe(false)
    }
  })

  it('offers Pause only for something actually running', () => {
    expect(canPause({ state: 'running' })).toBe(true)
    expect(canPause({ state: 'awaitingPermission' })).toBe(true)
    expect(canPause({ state: 'queued' })).toBe(false)
  })
})

describe('what a run state reads as', () => {
  it('separates a clean exit from a failure', () => {
    // Both are `finished`. Collapsing them to one word hides every failed run behind the word
    // that means it worked.
    expect(runLabel({ state: 'finished', code: 0 })).toBe('finished')
    expect(runLabel({ state: 'finished', code: 1 })).toBe('exited 1')
  })

  it('says what is waiting on a person', () => {
    expect(runLabel({ state: 'awaitingPermission' })).toBe('needs permission')
    expect(runLabel({ state: 'idle' })).toBe('waiting')
  })
})

describe('the pause control', () => {
  it('has three answers, because "some" is a real one', () => {
    // A mixed row offering only Pause hides the paused runs, and only Resume hides the running
    // ones. Either way a button does nothing to half of what it names.
    expect(pauseStateOf([])).toBe('none')
    expect(pauseStateOf([run('a', { state: 'running' })])).toBe('none')
    expect(pauseStateOf([run('a', { state: 'paused', sinceUnixMs: 1n })])).toBe('all')
    expect(
      pauseStateOf([run('a', { state: 'running' }), run('b', { state: 'paused', sinceUnixMs: 1n })]),
    ).toBe('some')
  })

  it('ignores runs that have ended when deciding', () => {
    // A finished run is not un-pausable, it is gone. Counting it would make a role with one
    // paused run and three finished ones read as "some", and offer a Pause that does nothing.
    const runs = [
      run('a', { state: 'paused', sinceUnixMs: 1n }),
      run('b', { state: 'finished', code: 0 }),
      run('c', { state: 'failed', reason: 'x' }),
    ]
    expect(pauseStateOf(runs)).toBe('all')
    expect(liveRuns(runs)).toHaveLength(1)
  })
})

describe('the roster', () => {
  it('puts what is happening first', () => {
    const rows = agentRows(
      [
        role('idle-one'),
        role('blocked', { unavailable: 'needs a key' }),
        role('busy', { running: 1 }),
        role('waiting', { queued: 2 }),
      ],
      [],
    )
    expect(rows.map((r) => String(r.agent.id))).toEqual(['busy', 'waiting', 'idle-one', 'blocked'])
  })

  it('takes its counts from cide rather than recomputing them', () => {
    // One producer. A count derived here from the runs list is a second answer to a question
    // cide already answered, and the two are only ever visibly different beside each other.
    const rows = agentRows([role('a', { running: 3 })], [run('a', { state: 'running' })])
    expect(rows[0]?.running).toBe(3)
  })
})

describe('how a role summarises', () => {
  it('does not say running and paused about the same run', () => {
    // cide counts a paused run as running, and is right to — it holds its slot. But a row
    // reading "1 running · paused" argues with itself and the reader has to pick a half.
    const rows = agentRows(
      [role('a', { running: 1 })],
      [run('a', { state: 'paused', sinceUnixMs: 1n })],
    )
    expect(summarise(rows[0]!)).toBe('1 paused · max 1')
  })

  it('splits a role that has both', () => {
    const rows = agentRows(
      [role('a', { running: 2, maxConcurrent: 3 })],
      [run('a', { state: 'running' }), run('b', { state: 'paused', sinceUnixMs: 1n })],
    )
    // `run('b')` is another role's id, so only the paused one that belongs to `a` counts.
    expect(summarise(rows[0]!)).toBe('2 running · max 3')
  })

  it('says idle rather than nothing', () => {
    expect(summarise(agentRows([role('a')], [])[0]!)).toBe('idle · max 1')
  })
})

describe('what deserves a spinner', () => {
  it('spins only for a run that is actually moving', () => {
    // Narrower than "alive". A run waiting at its prompt, waiting for a permission answer or
    // frozen is holding its slot but nothing is happening — and a spinner against something
    // that will not change until a person acts says "wait" for ever.
    expect(isWorking({ state: 'running' })).toBe(true)
    expect(isWorking({ state: 'starting' })).toBe(true)
    for (const state of [
      { state: 'idle' },
      { state: 'awaitingPermission' },
      { state: 'paused', sinceUnixMs: 1n },
      { state: 'queued' },
      { state: 'finished', code: 0 },
    ] as RunState[]) {
      expect(isWorking(state), state.state).toBe(false)
    }
  })

  it('spins a role when any of its runs is moving', () => {
    const rows = agentRows(
      [role('a', { running: 2 })],
      [run('a', { state: 'idle' }), run('a2', { state: 'running' })],
    )
    expect(isBusy(rows[0]!)).toBe(false)
    const both = agentRows([role('a', { running: 1 })], [run('a', { state: 'running' })])
    expect(isBusy(both[0]!)).toBe(true)
  })
})

describe('the queue', () => {
  it('does not call a project paused before it has been told', () => {
    // The one thing a pause indicator must not do is cry wolf. Absent is "not known yet".
    expect(queueState(undefined)).toBe('unknown')
    expect(queueState(true)).toBe('open')
    expect(queueState(false)).toBe('paused')
  })
})

describe('who is waiting, by project', () => {
  const session = (id: string, project: string) =>
    ({ session: id, project }) as unknown as RemoteSession
  const wait = (id: string) => ({ session: id, sinceUnixMs: 1n }) as unknown as AwaitingEntry

  it('joins a flat awaiting set onto the projects that own the sessions', () => {
    // cide keeps the set flat on purpose — a device's notification rule reads across every
    // session it can see — so the join has to happen once, here, rather than in each screen.
    const counts = waitingByProject(
      [session('s1', 'p1'), session('s2', 'p1'), session('s3', 'p2')],
      [wait('s1'), wait('s2'), wait('s3')],
    )
    expect(counts).toEqual({ p1: 2, p2: 1 })
  })

  it('ignores a session it does not know about', () => {
    // The set can name a session whose pane has since closed. Counting it would mark a project
    // that has nothing to show, and a badge that opens onto nothing is worse than no badge.
    expect(waitingByProject([session('s1', 'p1')], [wait('s1'), wait('ghost')])).toEqual({ p1: 1 })
  })

  it('totals across projects when none is chosen', () => {
    const counts = { p1: 2, p2: 1 }
    expect(waitingIn(counts, null)).toBe(3)
    expect(waitingIn(counts, 'p1')).toBe(2)
    expect(waitingIn(counts, 'nope')).toBe(0)
  })
})

describe('the board', () => {
  const task = (id: string, status: TaskRow['status'], updated: number): TaskRow =>
    ({ id, title: id, status, links: [], createdUnixMs: 1n, updatedUnixMs: BigInt(updated) }) as unknown as TaskRow

  it('leads with what is in progress and ends with what is done', () => {
    const rows = taskRows([
      task('d', 'done', 9),
      task('t', 'todo', 9),
      task('r', 'review', 9),
      task('g', 'doing', 9),
    ])
    expect(rows.map((r) => r.id)).toEqual(['g', 'r', 't', 'd'])
  })

  it('puts the most recently touched first within a state', () => {
    const rows = taskRows([task('old', 'doing', 1), task('new', 'doing', 5)])
    expect(rows.map((r) => r.id)).toEqual(['new', 'old'])
  })

  it('narrows without reordering', () => {
    // A board that re-sorted when narrowed would move a row out from under a thumb already
    // travelling towards it.
    const board = [task('a', 'doing', 3), task('b', 'review', 9), task('c', 'doing', 1)]
    expect(filterTasks(board, null).map((t) => t.id)).toEqual(['a', 'c', 'b'])
    expect(filterTasks(board, 'doing').map((t) => t.id)).toEqual(['a', 'c'])
    expect(filterTasks(board, 'done')).toEqual([])
  })

  it('searches the title and the id, and says so by not searching the body', () => {
    // The body is not on the board. A local filter searching text it does not have would draw
    // "no tasks match" over a task whose description contains exactly what was typed.
    const one = task('T-42', 'doing', 1)
    expect(matchesQuery(one, '')).toBe(true)
    expect(matchesQuery(one, '  ')).toBe(true)
    expect(matchesQuery(one, 't-42')).toBe(true)
    expect(matchesQuery(one, 'T-4')).toBe(true)
    expect(matchesQuery(one, 'nothing like it')).toBe(false)
  })

  it('counts every state, including the ones with nothing in them', () => {
    // A zero has to be present, not absent: the section row renders "3 doing, 0 review" and an
    // absent key would render `undefined`.
    expect(taskCounts([task('a', 'doing', 1)])).toEqual({ inbox: 0, todo: 0, doing: 1, review: 0, done: 0 })
  })
})

describe('what a section row says without being opened', () => {
  const session = (state: string, id: string) =>
    ({
      session: id as never,
      project: 'p' as never,
      title: 'claude',
      kind: 'claude' as const,
      role: 'primary' as const,
      state: { state } as never,
      awaiting: false,
    }) as never

  it('counts what is open and, separately, what is working', () => {
    const counts = consoleCounts(
      [session('busy', 'a'), session('idle', 'b'), session('exited', 'c')],
      [],
    )
    // An exited pane is still a pane on the desktop, and the list one tap away shows it.
    expect(counts.open).toBe(3)
    expect(counts.working).toBe(1)
  })

  it('counts only the waiting entries whose session it can see', () => {
    const counts = consoleCounts([session('idle', 'a')], [
      { session: 'a' as never, sinceUnixMs: 1n as never },
      { session: 'gone' as never, sinceUnixMs: 1n as never },
    ] as never)
    expect(counts.waiting).toBe(1)
  })

  it('separates a running run from a paused and a queued one', () => {
    const run = (state: string) => ({ state: { state } }) as never
    const counts = runCounts([
      run('running'),
      run('starting'),
      run('paused'),
      run('queued'),
      run('idle'),
      run('finished'),
    ])
    // `starting` is working: it is a child that has been forked and is on its way.
    expect(counts).toEqual({ running: 2, paused: 1, queued: 1 })
  })
})

describe("a comment's author", () => {
  const agent = (id: string, label = '') =>
    ({ kind: 'agent', agent: id, label }) as never

  it('names a person, the orchestrator and a role', () => {
    expect(authorLabel({ kind: 'user' } as never)).toBe('You')
    expect(authorLabel({ kind: 'orchestrator' } as never)).toBe('Orchestrator')
    expect(authorLabel(agent('reviewer', 'Reviewer'))).toBe('Reviewer')
  })

  /** A role deleted after it commented still has a name in the comment. */
  it('falls back to the id, and then to a word', () => {
    expect(authorLabel(agent('reviewer'))).toBe('reviewer')
    expect(authorLabel(agent('', ''))).toBe('Agent')
  })

  it('takes a declared hue, and derives one otherwise', () => {
    expect(authorColor(agent('reviewer'), { reviewer: 'cyan' })).toBe(AGENT_HUES.cyan)
    const derived = authorColor(agent('builder'), {})
    expect(Object.values(AGENT_HUES)).toContain(derived)
  })

  /**
   * The same role is the same colour every time, on every device, with nothing stored — which is
   * the whole reason the derivation exists rather than a table.
   */
  it('derives the same colour twice', () => {
    expect(agentColor('builder')).toBe(agentColor('builder'))
    expect(agentColor('builder')).not.toBe(agentColor('reviewer'))
  })

  /** By id and never by label: a rename must not repaint a conversation halfway down. */
  it('ignores the label', () => {
    expect(authorColor(agent('builder', 'Builder'))).toBe(authorColor(agent('builder', 'Bob')))
  })

  it('leaves the user alone and slates the orchestrator', () => {
    expect(authorColor({ kind: 'user' } as never)).toBeNull()
    expect(authorColor({ kind: 'orchestrator' } as never)).toBe(ORCHESTRATOR_COLOR)
  })

  it('refuses a hue that is not one of the eight', () => {
    expect(agentColor('reviewer', 'chartreuse')).toBe(agentColor('reviewer'))
  })
})

describe("a comment's time", () => {
  const at = new Date(2026, 8, 21, 14, 5).getTime()

  /** 24-hour, always: a clock that repeats itself twice a day answers the question badly. */
  it('is the clock alone on the day it happened', () => {
    expect(commentTime(at, new Date(2026, 8, 21, 23, 59).getTime())).toBe('14:05')
  })

  it('carries the date once it is not today', () => {
    expect(commentTime(at, new Date(2026, 8, 22, 0, 1).getTime())).toBe('2026-09-21 14:05')
  })

  it('pads both halves', () => {
    const early = new Date(2026, 0, 2, 3, 4).getTime()
    expect(commentTime(early, new Date(2026, 5, 1).getTime())).toBe('2026-01-02 03:04')
  })
})

describe('what a machine is doing', () => {
  const session = (kind: string, state: string, project = 'p1') =>
    ({ session: `s-${Math.random()}`, project, kind, state: { state } }) as never
  const run = (state: string) => ({ state: { state } }) as never
  const task = (status: string) => ({ status }) as never

  const view = {
    sessions: [
      session('claude', 'busy'),
      session('claude', 'awaitingInput'),
      session('shell', 'busy'),
    ],
    runs: { p1: [run('running'), run('paused')], p2: [run('starting'), run('queued')] },
    tasks: { p1: [task('todo'), task('done'), task('review')], p2: [task('doing')] },
  }

  it('counts a working Claude, not every console', () => {
    // A shell that is busy is not a Claude thinking, and a Claude at its prompt is not working.
    expect(machineCounts(view).claudeWorking).toBe(1)
    expect(machineCounts(view).consoles).toBe(3)
  })

  /** Across every project, because the row is one machine. */
  it('counts running runs across projects, and not paused or queued ones', () => {
    expect(machineCounts(view).agentsRunning).toBe(2)
  })

  /** todo + doing + review, never `total - done`. */
  it('counts open tasks by naming the open statuses', () => {
    expect(machineCounts(view).openTasks).toBe(3)
  })

  it('draws every part even at zero', () => {
    const quiet = machineCounts({ sessions: [], runs: {}, tasks: {} })
    expect(machineSummary(quiet)).toBe('0 Claudes running · 0 agents running · 0 open tasks')
  })

  it('says one of each in the singular', () => {
    const one = { claudeWorking: 1, agentsRunning: 1, openTasks: 1, consoles: 1 }
    expect(machineSummary(one)).toBe('1 Claude running · 1 agent running · 1 open task')
  })
})

describe('shownState', () => {
  // The reported bug: the notification cleared and the row still said "waiting for you".
  it('says a finished turn somebody has looked at is idle', () => {
    expect(shownState('awaitingInput', false)).toBe('idle')
  })

  it('keeps waiting while it is still in the set', () => {
    expect(shownState('awaitingInput', true)).toBe('awaitingInput')
  })

  it('leaves every other state alone', () => {
    for (const state of ['busy', 'awaitingPermission', 'exited', 'spawning']) {
      expect(shownState(state, false)).toBe(state)
    }
  })
})
