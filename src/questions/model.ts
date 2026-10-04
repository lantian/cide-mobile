/** Question semantics and the acknowledged submission road, shared by the mobile view and tests. */
import type { ClientBody, ServerBody, TaskAttachment, TaskDetail, TaskQuestion, TaskResponse } from '../protocol/generated'

export function questionText(question: TaskQuestion): string {
  return typeof question === 'string' ? question : question.text
}

export function toggleSelection(question: TaskQuestion, selected: readonly string[], id: string): string[] {
  if (typeof question === 'string' || !question.options.some((option) => option.id === id)) return [...selected]
  if (question.selection !== 'multiple') return [id]
  return selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id]
}

export function answerPayload(question: TaskQuestion, text: string, selected: readonly string[]): TaskResponse {
  const options = typeof question === 'string' ? [] : question.options
  if (selected.length === 0 && text.trim() === '') throw new Error('The answer is empty.')
  if ((typeof question === 'string' || question.selection !== 'multiple') && selected.length > 1) {
    throw new Error('Choose one option.')
  }
  if (new Set(selected).size !== selected.length || selected.some((id) => !options.some((option) => option.id === id))) {
    throw new Error('Choose an option from this question.')
  }
  return { kind: 'answer', text: text.trim(), selectedIds: [...selected], expectedQuestion: question }
}

export function questionImages(question: TaskQuestion, detail: TaskDetail): TaskAttachment[] {
  if (typeof question === 'string') return []
  const records = [...detail.attachments, ...detail.comments.filter((c) => !c.deleted).flatMap((c) => c.attachments)]
  const seen = new Set<string>()
  return question.options.flatMap((option) => {
    const id = option.image
    if (id === undefined || seen.has(id)) return []
    const image = records.find((a) => a.id === id && !a.deleted && a.kind === 'image')
    if (image === undefined) return []
    seen.add(id)
    return [image]
  })
}

/** No offline replay: retrying must use the question the person is currently looking at. */
export class AnswerSubmission {
  busy = false

  async send(request: (body: ClientBody) => Promise<ServerBody>, project: string, task: string, response: TaskResponse): Promise<boolean> {
    if (this.busy) return false
    this.busy = true
    try {
      const reply = await request({ t: 'taskRespond', project, task, response } as ClientBody)
      if (reply.t === 'error') throw new Error(reply.detail)
      if (reply.t !== 'taskResponded' || String(reply.project) !== project || String(reply.task) !== task) {
        throw new Error('cide did not confirm this answer.')
      }
      return true
    } finally {
      this.busy = false
    }
  }
}
