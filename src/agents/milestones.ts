/**
 * A project's milestones, as a phone draws them. (M91)
 *
 * Pure, and the same rules the desk's Milestones tab uses (`MilestonesPanel.tsx`'s `verdictKind`
 * and `gateLine`) — a gate that reads "passed" on the desk and "not run" in a pocket is two
 * surfaces disagreeing about the one fact a milestone is for.
 */
import type {
  CheckResult,
  GateState,
  Milestone,
  MilestonePlan,
  MilestonesView,
  Proposal,
} from '../protocol/generated'

export type Verdict = 'running' | 'none' | 'passed' | 'failed'

export function verdictKind(running: boolean, last: CheckResult | undefined): Verdict {
  if (running) return 'running'
  if (last === undefined) return 'none'
  return last.passed ? 'passed' : 'failed'
}

/** One line about a gate: running, never run, or its last verdict with when and how long. */
export function gateLine(running: boolean, last: CheckResult | undefined, now = Date.now()): string {
  if (running) return 'gate running…'
  if (last === undefined) return 'gate not run yet'
  const when = ago(last.startedUnixMs, now)
  const took = `${Math.round(last.durationMs / 1000)}s`
  if (last.passed) return `gate passed · ${when} · ${took}`
  if (last.timedOut) return `gate timed out · ${when}`
  return `gate failed, exit ${last.exitCode ?? '?'} · ${when} · ${took}`
}

/** "just now", "5 min ago", "3 h ago", "2 d ago" — a phone has no room for a full timestamp. */
export function ago(unixMs: number, now: number): string {
  const s = Math.max(0, Math.round((now - unixMs) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86_400)} d ago`
}

export function lastLines(text: string, n: number): string {
  const lines = text.replace(/\n+$/, '').split('\n')
  return lines.slice(Math.max(0, lines.length - n)).join('\n')
}

/** The active milestone: `active`, or the first when it is unset or names one that is gone. */
export function current(view: MilestonesView): Milestone | undefined {
  const { items, active } = view.plan
  return (active === undefined ? undefined : items.find((m) => m.id === active)) ?? items[0]
}

export function gateOf(view: MilestonesView, milestone: string): GateState | undefined {
  return view.gates.find((gate) => gate.milestone === milestone)
}

/** Everything a card needs about one milestone. */
export interface Card {
  readonly milestone: Milestone
  readonly active: boolean
  readonly accepted: boolean
  readonly verdict: Verdict
  readonly line: string
  readonly running: boolean
  /** Done / all tasks under it. */
  readonly done: number
  readonly total: number
  /** Accept is offered only for the active milestone, once its gate has passed. */
  readonly acceptable: boolean
  /** Run is offered only for the active milestone, and not while it is running. */
  readonly runnable: boolean
  readonly last: CheckResult | undefined
}

export function cards(view: MilestonesView, now = Date.now()): Card[] {
  const active = current(view)
  return view.plan.items.map((milestone) => {
    const gate = gateOf(view, milestone.id)
    const running = gate?.running ?? false
    const verdict = verdictKind(running, gate?.last)
    const accepted = view.accepted.includes(milestone.id)
    const isActive = active?.id === milestone.id
    const tasks = view.tasks.find((t) => t.milestone === milestone.id)?.tasks ?? []
    return {
      milestone,
      active: isActive,
      accepted,
      verdict,
      line: gateLine(running, gate?.last, now),
      running,
      done: tasks.filter((t) => t.status === 'done').length,
      total: tasks.length,
      acceptable: isActive && !accepted && verdict === 'passed',
      runnable: isActive && !running,
      last: gate?.last,
    }
  })
}

/**
 * The line on the machine screen's Milestones row, over the chosen projects' views: the active
 * milestone and its gate when there is one project, a count when there are several.
 */
export function summary(views: readonly MilestonesView[], now = Date.now()): {
  detail: string
  running: boolean
  failed: boolean
  /** Proposals waiting for the user, across the views. */
  proposals: number
} {
  const proposals = views.reduce((n, view) => n + view.proposals.length, 0)
  const waiting = proposals === 0 ? '' : ` · ${proposals} proposal${proposals === 1 ? '' : 's'}`
  const planned = views.filter((view) => view.plan.items.length > 0)
  if (planned.length === 0) {
    return {
      detail: proposals === 0 ? 'No milestones' : `No milestones${waiting}`,
      running: false,
      failed: false,
      proposals,
    }
  }
  const actives = planned.flatMap((view) => {
    const card = cards(view, now).find((c) => c.active)
    return card === undefined ? [] : [card]
  })
  const running = actives.some((c) => c.running)
  const failed = actives.some((c) => c.verdict === 'failed')
  if (planned.length === 1 && actives[0] !== undefined) {
    const card = actives[0]
    return { detail: `${card.milestone.title} · ${card.line}${waiting}`, running, failed, proposals }
  }
  const parts = [`${planned.length} projects`]
  const n = actives.filter((c) => c.running).length
  if (n > 0) parts.push(`${n} gate${n === 1 ? '' : 's'} running`)
  const bad = actives.filter((c) => c.verdict === 'failed').length
  if (bad > 0) parts.push(`${bad} failing`)
  const ok = actives.filter((c) => c.verdict === 'passed').length
  if (ok > 0) parts.push(`${ok} passed`)
  return { detail: parts.join(' · ') + waiting, running, failed, proposals }
}

/* --- proposals ------------------------------------------------------------------------------ */

/** Who proposed it, in words. */
export function byLine(proposal: Proposal): string {
  switch (proposal.by.kind) {
    case 'agent':
      return proposal.by.label || String(proposal.by.agent)
    case 'orchestrator':
      return 'the orchestrator'
    default:
      return 'you'
  }
}

/** What kind of change, for the card's chip. */
export function changeKind(proposal: Proposal): string {
  switch (proposal.change.kind) {
    case 'plan':
      return 'milestone plan'
    case 'files': {
      const n = proposal.change.files.length
      return `${n} file${n === 1 ? '' : 's'}`
    }
    default:
      return 'note'
  }
}

/**
 * A plan proposal as lines a person can read on a phone: `+` added, `-` removed, `~` changed
 * (title or gate), `=` unchanged — in the proposed order, with removals after.
 */
export function planDiff(before: MilestonePlan, after: MilestonePlan): string[] {
  const old = new Map(before.items.map((m) => [m.id, m]))
  const lines: string[] = []
  for (const m of after.items) {
    const was = old.get(m.id)
    if (was === undefined) lines.push(`+ ${m.title} — $ ${m.gate}`)
    else if (was.title !== m.title || was.gate !== m.gate) {
      const what: string[] = []
      if (was.title !== m.title) what.push(`was “${was.title}”`)
      if (was.gate !== m.gate) what.push(`gate $ ${m.gate}`)
      lines.push(`~ ${m.title} (${what.join('; ')})`)
    } else lines.push(`= ${m.title}`)
  }
  const kept = new Set(after.items.map((m) => m.id))
  for (const m of before.items) if (!kept.has(m.id)) lines.push(`- ${m.title}`)
  if ((before.active ?? null) !== (after.active ?? null)) {
    const title = after.items.find((m) => m.id === after.active)?.title ?? after.active ?? 'the first'
    lines.push(`active → ${title}`)
  }
  if (before.verify !== after.verify) lines.push(`verify → $ ${after.verify || '(none)'}`)
  return lines
}
