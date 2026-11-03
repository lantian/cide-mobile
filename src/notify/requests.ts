import type { UserRequestsView } from '../protocol/generated'

export type RequestTarget = { instanceId: string; project: string; request: string }
export type RequestNotice = { id: string; channel: 'awaiting'; title: string; body: string; data: RequestTarget }
export type RequestLedger = ReadonlySet<string>

/** Questions stay visible while their agent is blocked, independently of console turn markers. */
export function decideRequests(instanceId: string, instanceLabel: string, projects: Readonly<Record<string, string>>, views: Readonly<Record<string, UserRequestsView | null>>, ledger: RequestLedger) {
  const next = new Set(ledger)
  const raise: RequestNotice[] = []
  const dismiss: string[] = []
  for (const [project, view] of Object.entries(views)) {
    if (view == null) continue // No snapshot yet; an offline device cannot conclude they disappeared.
    const pending = new Set<string>()
    for (const request of view.requests) {
      const id = `request:${instanceId}:${project}:${request.id}`
      if (request.delivered || request.response != null) continue
      pending.add(id)
      if (next.has(id) || projects[project] === undefined) continue
      next.add(id)
      raise.push({ id, channel: 'awaiting', title: `${instanceLabel} · ${projects[project]}`, body: request.title, data: { instanceId, project, request: request.id } })
    }
    for (const id of next) if (id.startsWith(`request:${instanceId}:${project}:`) && !pending.has(id)) dismiss.push(id)
  }
  return { raise, dismiss, ledger: next }
}
