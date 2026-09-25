/**
 * What the Agents and Tasks screens draw, as pure functions. (M75)
 *
 * Here rather than in the components for the reason the rest of `src/` is: a screen cannot be
 * driven by a test and a decision can. Everything below is a plain function over the frames cide
 * sends, so the rules that decide whether a row offers Pause or Resume — the ones that are wrong
 * in a way nobody notices until they press the button — are checked by `agents.test.ts`.
 */
import type {
  AgentRun,
  AwaitingEntry,
  RemoteAgent,
  RemoteSession,
  RunState,
  TaskRow,
  TaskStatus,
} from '../protocol/generated'

/** A role and the runs of it, joined. */
export interface AgentRowView {
  readonly agent: RemoteAgent
  readonly runs: readonly AgentRun[]
  /** Its live runs, for the count the row shows. */
  readonly running: number
  readonly queued: number
  /** Whether this role's runs are all paused, some are, or none are. */
  readonly pausing: PauseState
}

/**
 * What a Pause/Resume control should offer.
 *
 * Three states and not a boolean, because "some of them are paused" is a real answer and the two
 * honest controls for it are different: offering only Pause hides the paused ones, and offering
 * only Resume hides the running ones. A mixed row offers both.
 */
export type PauseState = 'none' | 'some' | 'all'

/**
 * Is this run alive?
 *
 * `Paused` counts as alive, deliberately: a `SIGSTOP`ped child still holds its worktree, its
 * concurrency slot and its conversation, and a row that stopped counting it would show a role as
 * idle while it is holding the one slot that stops anything else starting.
 */
export function isLive(state: RunState): boolean {
  switch (state.state) {
    case 'starting':
    case 'running':
    case 'idle':
    case 'awaitingPermission':
    case 'paused':
      return true
    default:
      return false
  }
}

/** Can this run be paused right now? Only a live, not-already-paused one. */
export function canPause(state: RunState): boolean {
  return isLive(state) && state.state !== 'paused'
}

/** Can this run be resumed? Only a paused one. */
export function canResume(state: RunState): boolean {
  return state.state === 'paused'
}

/** What a person should read for a run's state. */
export function runLabel(state: RunState): string {
  switch (state.state) {
    case 'queued':
      return 'queued'
    case 'starting':
      return 'starting'
    case 'running':
      return 'working'
    case 'idle':
      return 'waiting'
    case 'awaitingPermission':
      return 'needs permission'
    case 'paused':
      return 'paused'
    case 'interrupted':
      return 'interrupted'
    case 'finished':
      // The number matters: a non-zero exit is the difference between "it is done" and "it
      // gave up", and a row that said "finished" for both would hide every failure.
      return state.code === 0 ? 'finished' : `exited ${state.code}`
    case 'failed':
      return 'failed'
  }
}

/** Which runs belong to a role. */
export function runsOf(runs: readonly AgentRun[], agent: string): AgentRun[] {
  return runs.filter((run) => String(run.agent) === agent)
}

/** How a set of runs stands, for a Pause/Resume control. */
export function pauseStateOf(runs: readonly AgentRun[]): PauseState {
  const live = runs.filter((run) => isLive(run.state))
  if (live.length === 0) return 'none'
  const paused = live.filter((run) => run.state.state === 'paused')
  if (paused.length === 0) return 'none'
  return paused.length === live.length ? 'all' : 'some'
}

/**
 * The roster, joined to its runs and ordered by what is worth looking at.
 *
 * Roles with something running come first, then ones that could run, then ones that cannot —
 * the list exists to answer "what is happening", and alphabetical order buries that under
 * whichever role happens to start with an A.
 */
export function agentRows(
  roster: readonly RemoteAgent[],
  runs: readonly AgentRun[],
): AgentRowView[] {
  const rows = roster.map((agent) => {
    const mine = runsOf(runs, String(agent.id))
    return {
      agent,
      runs: mine,
      // cide's counts, not ours. `RemoteAgent`'s own doc argues this: a count re-derived here
      // would be a second producer of a number that is only visibly wrong beside its own list.
      running: agent.running,
      queued: agent.queued,
      pausing: pauseStateOf(mine),
    }
  })
  return rows.sort((a, b) => rank(a) - rank(b) || a.agent.label.localeCompare(b.agent.label))
}

function rank(row: AgentRowView): number {
  if (row.running > 0) return 0
  if (row.queued > 0) return 1
  return row.agent.unavailable === undefined ? 2 : 3
}

/**
 * A role's state in one line.
 *
 * Paused runs are counted **out** of "running" and named separately. cide's `running` count
 * includes them — correctly, because a `SIGSTOP`ped child still holds its slot — but a row
 * reading "1 running · paused" is a row arguing with itself, and the reader has to work out
 * which half to believe. The number cide sent is still the one shown; it is only split.
 */
export function summarise(row: AgentRowView): string {
  const paused = row.runs.filter((run) => run.state.state === 'paused').length
  const working = Math.max(0, row.running - paused)
  const parts: string[] = []
  if (working > 0) parts.push(`${working} running`)
  if (paused > 0) parts.push(`${paused} paused`)
  if (row.queued > 0) parts.push(`${row.queued} queued`)
  if (parts.length === 0) parts.push('idle')
  parts.push(`max ${row.agent.maxConcurrent}`)
  return parts.join(' · ')
}

/** Every live run across every role, for the "pause everything" control. */
export function liveRuns(runs: readonly AgentRun[]): AgentRun[] {
  return runs.filter((run) => isLive(run.state))
}

/**
 * Is this run *doing something right now*, as opposed to merely alive?
 *
 * The question a spinner answers, and it is narrower than [`isLive`]. A run waiting at its
 * prompt, waiting for a permission answer or frozen is alive and holding its slot, but nothing
 * is moving — and a spinner against a run that will not change until somebody does something is
 * an animation that says "wait" for ever.
 */
export function isWorking(state: RunState): boolean {
  return state.state === 'running' || state.state === 'starting'
}

/** Whether a role has anything actually in motion, for the row's spinner. */
export function isBusy(row: AgentRowView): boolean {
  return row.runs.some((run) => isWorking(run.state))
}

/**
 * How a project's queue stands.
 *
 * `undefined` is *not known yet* rather than paused: a screen that drew "paused" before the
 * first roster landed would accuse every project of it for one round trip, and the one thing a
 * pause indicator must not do is cry wolf.
 */
export function queueState(dispatching: boolean | undefined): 'open' | 'paused' | 'unknown' {
  if (dispatching === undefined) return 'unknown'
  return dispatching ? 'open' : 'paused'
}

// The inbox (cide M83) sits under the backlog and above done: noticed, not planned.
const TASK_ORDER: Record<TaskStatus, number> = { doing: 0, review: 1, todo: 2, inbox: 3, done: 4 }

/**
 * The board, in the order a person cares about.
 *
 * In progress first, then what is waiting on a look, then what has not started, then what is
 * finished — and newest first inside each. A board sorted by id is a board nobody reads.
 */
export function taskRows(tasks: readonly TaskRow[]): TaskRow[] {
  return [...tasks].sort(
    (a, b) =>
      TASK_ORDER[a.status] - TASK_ORDER[b.status] ||
      Number(b.updatedUnixMs) - Number(a.updatedUnixMs),
  )
}

/**
 * How many sessions are waiting on the user, per project. (M75)
 *
 * The awaiting set is a flat list of sessions and carries no project — cide keeps it that way
 * deliberately, because a device's notification rule reads across every session it can see. But
 * every surface *above* a console is organised by project, so the join has to happen somewhere,
 * and doing it in each screen is how one of them ends up counting a session twice or not at all.
 *
 * Sessions the device does not know about are ignored rather than counted against an unknown
 * project: the set can name a session whose pane has since closed, and a count that included it
 * would mark a project that has nothing to show.
 */
export function waitingByProject(
  sessions: readonly RemoteSession[],
  awaiting: readonly AwaitingEntry[],
): Record<string, number> {
  const project = new Map(sessions.map((s) => [String(s.session), String(s.project)]))
  const counts: Record<string, number> = {}
  for (const entry of awaiting) {
    const owner = project.get(String(entry.session))
    if (owner === undefined) continue
    counts[owner] = (counts[owner] ?? 0) + 1
  }
  return counts
}

/** How many are waiting in the chosen scope — one project, or all of them. */
export function waitingIn(counts: Record<string, number>, project: string | null): number {
  if (project !== null) return counts[project] ?? 0
  return Object.values(counts).reduce((total, n) => total + n, 0)
}

/**
 * What the Consoles row on the instance screen says without being opened. (M76)
 *
 * Three numbers and not one. *Open* is how many panes exist, which is a fact about the desktop's
 * layout and changes about once a day; **working** is how many are doing something this second,
 * which is the number somebody unlocks their phone to find out. A row that showed only the first
 * said `6 open` whether every one of them was mid-turn or every one of them had been idle since
 * yesterday — the same sentence for the two states furthest apart.
 *
 * `exited` panes are counted as open, deliberately: cide keeps a finished session's pane until
 * somebody closes it, it is still on the screen the row is describing, and a count that quietly
 * disagreed with the list one tap away would be the worse lie.
 */
export function consoleCounts(
  sessions: readonly RemoteSession[],
  awaiting: readonly AwaitingEntry[],
): { open: number; working: number; waiting: number } {
  const here = new Set(sessions.map((session) => String(session.session)))
  return {
    open: sessions.length,
    // `busy` and nothing else. A session at its prompt, at a permission question or frozen is
    // alive and is not working, which is `isWorking`'s distinction one layer up.
    working: sessions.filter((session) => session.state.state === 'busy').length,
    waiting: awaiting.filter((entry) => here.has(String(entry.session))).length,
  }
}

/**
 * And what the Agents row says: how the project's runs stand right now.
 *
 * Split the same way and for the same reason — a roster size is a fact about the committed
 * files in `.cide/agents/`, not about anything happening.
 */
export function runCounts(runs: readonly AgentRun[]): {
  running: number
  paused: number
  queued: number
} {
  return {
    running: runs.filter((run) => isWorking(run.state)).length,
    paused: runs.filter((run) => run.state.state === 'paused').length,
    queued: runs.filter((run) => run.state.state === 'queued').length,
  }
}

/**
 * What a machine is doing, for the landing screen's row. (M76)
 *
 * The list is of *machines*, and until now a row said how many consoles were open — which is a
 * fact about how somebody arranged their windows, not about whether anything is happening. The
 * three numbers here are the ones somebody picking up a phone actually wants: is a Claude
 * thinking, is a role running, and how much work is still open.
 *
 * Each is counted across **every** project the device is subscribed to, because the row is one
 * machine and a per-project breakdown belongs to the screen behind it. An empty subscription is
 * every project (`interests`' rule on cide's side), which is what this screen has.
 *
 * `openTasks` is todo + doing + review and never `total - done`: the four statuses are a closed
 * set today and a fifth one added tomorrow would silently join "open" under subtraction, which
 * is the wrong default for a number somebody plans their evening around.
 */
export function machineCounts(view: {
  sessions: readonly RemoteSession[]
  runs: Readonly<Record<string, readonly AgentRun[]>>
  tasks: Readonly<Record<string, readonly TaskRow[]>>
}): { consoles: number; claudeWorking: number; agentsRunning: number; openTasks: number } {
  const claudeWorking = view.sessions.filter(
    // `busy` and nothing else — a console at its prompt or at a permission question is alive and
    // is not working. `consoleCounts` draws the same line for the same reason.
    (session) => session.kind === 'claude' && session.state.state === 'busy',
  ).length
  let agentsRunning = 0
  for (const runs of Object.values(view.runs)) agentsRunning += runCounts(runs).running
  let openTasks = 0
  for (const rows of Object.values(view.tasks)) {
    openTasks += rows.filter(
      (row) => row.status === 'todo' || row.status === 'doing' || row.status === 'review',
    ).length
  }
  return { consoles: view.sessions.length, claudeWorking, agentsRunning, openTasks }
}

/**
 * The same three numbers, as the sentence the row draws.
 *
 * A **fixed shape**: every part is drawn even at zero, so the row reads the same on every
 * machine and the eye learns where each number is. The alternative — dropping the zeros, which
 * is what `summarise` does for a role — is right for a row that is *about* one thing and wrong
 * for a row that is a dashboard: *"nothing is running"* is an answer somebody opened the phone
 * to get, and a line that shortens when the answer is no is a line they have to re-read.
 */
export function machineSummary(counts: ReturnType<typeof machineCounts>): string {
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
  return [
    `${plural(counts.claudeWorking, 'Claude')} running`,
    `${plural(counts.agentsRunning, 'agent')} running`,
    `${plural(counts.openTasks, 'open task')}`,
  ].join(' \u00b7 ')
}

/** What the Tasks screen is showing. `null` is everything. */
export type TaskFilter = TaskStatus | null

/**
 * The board, narrowed.
 *
 * Separate from [`taskRows`] rather than folded into it, so the ordering rule and the filtering
 * rule can each be wrong on their own and be caught on their own.
 *
 * Note what this deliberately does *not* do: it never returns a different **order** for a
 * filtered list. A board that re-sorted when narrowed would move a row out from under a thumb
 * that was already travelling towards it.
 */
export function filterTasks(tasks: readonly TaskRow[], filter: TaskFilter): TaskRow[] {
  const ordered = taskRows(tasks)
  return filter === null ? ordered : ordered.filter((task) => task.status === filter)
}

/**
 * Does a task match what was typed?
 *
 * Title and id, never the body — the body is not on the board. A local filter that searched
 * text it does not have would draw *no tasks match* over a task whose description contains
 * exactly what was typed, which is the trap `cide_tasks::search` exists to avoid on the desktop
 * and the reason this one is honest about being a title filter.
 *
 * Case-insensitive and trimmed, because nobody types a search query carefully.
 */
export function matchesQuery(task: TaskRow, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  return (
    task.title.toLowerCase().includes(needle) || String(task.id).toLowerCase().includes(needle)
  )
}

/** How many tasks are in each state, for the summary a section row shows. */
export function taskCounts(tasks: readonly TaskRow[]): Record<TaskStatus, number> {
  const counts: Record<TaskStatus, number> = { inbox: 0, todo: 0, doing: 0, review: 0, done: 0 }
  for (const task of tasks) counts[task.status] += 1
  return counts
}

/**
 * The state a console row shows: cide's, except that a finished turn somebody has **looked at**
 * reads as idle rather than "waiting for you". (M91)
 *
 * Two different facts. `awaitingInput` is the hook's: the turn ended, and it stays that way
 * until the next one begins. *Waiting for you* is the awaiting set's: nobody has looked yet —
 * and opening the console takes it out of the set, here and on the desk. The row read the
 * first, so after somebody had opened a console, read it and come back, the dot and the border
 * were gone and the line underneath still said "waiting for you" in the warning colour: the
 * notification cleared and the list contradicted it. The desk keeps the two apart for the same
 * reason (`ui/src/panes/awaitingRule.ts`).
 */
export function shownState(state: string, waiting: boolean): string {
  return state === 'awaitingInput' && !waiting ? 'idle' : state
}
