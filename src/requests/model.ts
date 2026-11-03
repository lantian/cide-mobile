import type { ClientBody, ServerBody, TaskRow, UserRequest, UserRequestResponse, UserRequestsView } from '../protocol/generated'

export type DecisionItem = { id: string; project: string; title: string; label: string; request: UserRequest | null; task: TaskRow | null }
export type AnswerDraft = { text: string; selected: string[] }

/** A whole view replaces the previous one; a late acknowledgement cannot undo a newer push. */
export function newerRequests(before: UserRequestsView | null | undefined, next: UserRequestsView | null): UserRequestsView | null {
  return before != null && next != null && Number(next.rev) <= Number(before.rev) ? before : next
}

export function decisions(views: Readonly<Record<string, UserRequestsView | null>>, boards: Readonly<Record<string, readonly TaskRow[]>>, project: string | null): DecisionItem[] {
  const items: DecisionItem[] = []
  for (const id of new Set([...Object.keys(views), ...Object.keys(boards)])) {
    if (project !== null && id !== project) continue
    const pending = (views[id]?.requests ?? []).filter((r) => !r.delivered)
    for (const request of pending) items.push({ id: `${id}:${request.id}`, project: id, title: request.title,
      label: request.response != null ? 'Decision saved' : request.request.kind === 'question' ? 'Question' : 'Move tasks', request, task: null })
    const mirrored = new Set(pending.filter((r) => r.request.kind === 'question').map((r) => r.task))
    for (const task of boards[id] ?? []) {
      if (mirrored.has(task.id)) continue
      const question = task.question
      if (question != null || (task.status === 'review' && task.acceptance === 'user')) items.push({ id: `${id}:task:${task.id}`, project: id,
        title: question == null ? task.title : typeof question === 'string' ? question : question.text,
        label: question == null ? 'Accept result' : 'Question', task, request: null })
    }
  }
  return items
}

export function savedAnswer(request: UserRequest): string[] {
  const response = request.response
  const proposal = request.request
  if (response == null) return []
  if (response.kind === 'cancel') return ['Request cancelled.']
  if (response.kind === 'reject') return ['Proposal rejected.', ...(response.note ? [response.note] : [])]
  const selected = response.kind === 'answer' && proposal.kind === 'question'
    ? response.selectedIds.map((id) => typeof proposal.question === 'string' ? id : proposal.question.options.find((o) => o.id === id)?.title ?? id)
    : response.kind === 'approve' && proposal.kind === 'moveTasks'
      ? response.selectedIds.map((id) => `${id} · ${proposal.tasks.find((t) => String(t.id) === String(id))?.title ?? ''}`) : []
  const text = response.kind === 'answer' ? response.text : response.note
  return [...selected, ...(text ? [text] : [])]
}

/** No offline replay or optimistic disappearance: a saved view is the acknowledgement. */
export class DecisionSubmission {
  busy = false
  async send(send: (body: ClientBody) => Promise<ServerBody>, project: string, id: string, response: UserRequestResponse): Promise<UserRequestsView | null> {
    if (this.busy) return null
    this.busy = true
    try {
      const reply = await send({ t: 'userRequestRespond', project, id, response } as ClientBody)
      if (reply.t === 'error') throw new Error(reply.detail)
      if (reply.t !== 'userRequests' || String(reply.project) !== project || reply.view == null || !reply.view.requests.some((r) => r.id === id && r.response != null)) {
        throw new Error('cide did not confirm this decision.')
      }
      return reply.view
    } finally { this.busy = false }
  }
}
