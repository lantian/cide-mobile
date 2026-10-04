import { describe, expect, it } from 'vitest'
import { AnswerSubmission, answerPayload, questionImages, questionText, toggleSelection } from '../src/questions/model'
import type { QuestionChoices, ServerBody, TaskDetail, TaskQuestion } from '../src/protocol/generated'

const single: QuestionChoices = { text: 'Choose', selection: 'single', options: [
  { id: 'blue', title: 'Blue', image: 'a-blue' }, { id: 'green', title: 'Green', image: 'a-green' },
] } as QuestionChoices
const multiple: TaskQuestion = { ...single, selection: 'multiple' }

describe('question answers', () => {
  it('shows legacy text and structured question text', () => {
    expect(questionText('Plain question')).toBe('Plain question')
    expect(questionText(single)).toBe('Choose')
  })
  it('replaces single selections and toggles multiple selections', () => {
    expect(toggleSelection(single, ['blue'], 'green')).toEqual(['green'])
    expect(toggleSelection(multiple, ['blue'], 'green')).toEqual(['blue', 'green'])
    expect(toggleSelection(multiple, ['blue', 'green'], 'blue')).toEqual(['green'])
    expect(toggleSelection(single, ['blue'], 'unknown')).toEqual(['blue'])
  })
  it('allows choices alone, text alone, or both and includes the displayed snapshot', () => {
    expect(answerPayload(single, '', ['blue'])).toEqual({ kind: 'answer', text: '', selectedIds: ['blue'], expectedQuestion: single })
    expect(answerPayload(single, '  other  ', [])).toMatchObject({ text: 'other', selectedIds: [] })
    expect(answerPayload(multiple, 'details', ['blue', 'green'])).toMatchObject({ text: 'details', selectedIds: ['blue', 'green'] })
    expect(answerPayload('Legacy', '  text ', [])).toMatchObject({ text: 'text', expectedQuestion: 'Legacy' })
  })
  it('rejects empty, unknown, duplicate, or excessive single selections', () => {
    expect(() => answerPayload(single, '  ', [])).toThrow(/empty/)
    expect(() => answerPayload(single, '', ['blue', 'green'])).toThrow(/one/)
    expect(() => answerPayload(multiple, '', ['blue', 'blue'])).toThrow(/option/)
    expect(() => answerPayload(multiple, '', ['unknown'])).toThrow(/option/)
  })
  it('resolves live images from the body and comments in option order', () => {
    const detail = { attachments: [{ id: 'a-green', kind: 'image', deleted: false }],
      comments: [{ deleted: false, attachments: [{ id: 'a-blue', kind: 'image', deleted: false }] },
        { deleted: true, attachments: [{ id: 'a-deleted', kind: 'image', deleted: false }] }] } as TaskDetail
    expect(questionImages(single, detail).map((a) => a.id)).toEqual(['a-blue', 'a-green'])
    const extra = { ...single, options: [...single.options, single.options[0]!,
      { id: 'deleted', title: 'Deleted', image: 'a-deleted' }, { id: 'missing', title: 'Missing', image: 'absent' }] } as TaskQuestion
    expect(questionImages(extra, detail).map((a) => a.id)).toEqual(['a-blue', 'a-green'])
    detail.attachments[0]!.deleted = true
    expect(questionImages(single, detail).map((a) => a.id)).toEqual(['a-blue'])
  })
  it('sends once while pending, checks acknowledgements, and allows retry after refusal', async () => {
    const sender = new AnswerSubmission()
    let complete!: (body: ServerBody) => void
    const bodies: unknown[] = []
    const request = (body: unknown) => { bodies.push(body); return new Promise<ServerBody>((resolve) => { complete = resolve }) }
    const response = answerPayload(single, 'draft', ['blue'])
    const pending = sender.send(request, 'p', 't', response)
    expect(sender.busy).toBe(true)
    expect(await sender.send(request, 'p', 't', response)).toBe(false)
    expect(bodies).toHaveLength(1)
    complete({ t: 'error', kind: 'refused', detail: 'question changed' })
    await expect(pending).rejects.toThrow('question changed')
    expect(sender.busy).toBe(false)
    // The caller's draft and selections are never consumed by a failed request.
    expect(response).toMatchObject({ text: 'draft', selectedIds: ['blue'], expectedQuestion: single })
    expect(await sender.send(async () => ({ t: 'taskResponded', project: 'p', task: 't' } as ServerBody), 'p', 't', response)).toBe(true)
    await expect(sender.send(async () => ({ t: 'taskResponded', project: 'p', task: 'wrong' } as ServerBody), 'p', 't', response)).rejects.toThrow(/confirm/)
    await expect(sender.send(async () => { throw new Error('disconnected') }, 'p', 't', response)).rejects.toThrow('disconnected')
    expect(sender.busy).toBe(false)
  })
})
