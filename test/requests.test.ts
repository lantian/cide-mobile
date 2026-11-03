import { describe, expect, it } from 'vitest'
import { decisions, newerRequests, savedAnswer, DecisionSubmission } from '../src/requests/model'
import { decideRequests } from '../src/notify/requests'
import type { ServerBody, TaskRow, UserRequestsView } from '../src/protocol/generated'
import { moveRequest, questionRequest } from './requestFixtures'

describe('broker decisions', () => {
  it('includes projects without a tracker, deduplicates mirrored questions, and keeps legacy reviews', () => {
    const boards = { p: [{ id: 't-3', question: 'Mirrored' }, { id: 't-4', question: null, title: 'Review', status: 'review', acceptance: 'user' },
      { id: 't-5', question: null, status: 'review', acceptance: 'cide' }] as unknown as TaskRow[] }
    const views = { p: { rev: 1n, requests: [questionRequest()] }, other: { rev: 1n, requests: [moveRequest()] } }
    expect(decisions(views, boards, null).map((r) => r.label)).toEqual(['Question', 'Accept result', 'Move tasks'])
    expect(decisions(views, boards, 'other')).toHaveLength(1)
    expect(decisions({ p: { rev: 2n, requests: [questionRequest({ delivered: true })] } }, {}, null)).toEqual([])
  })
  it('late acknowledgements and repeated snapshots do not undo a newer delivered view', () => {
    const latest = { rev: 4n, requests: [questionRequest({ delivered: true })] }
    expect(newerRequests(latest, { rev: 3n, requests: [questionRequest()] })).toBe(latest)
    expect(newerRequests(latest, { ...latest })).toBe(latest)
    expect(newerRequests(undefined, latest)).toBe(latest)
  })
  it('shows answer labels and feedback instead of the wire payload', () => {
    expect(savedAnswer(questionRequest({ response: { kind: 'answer', text: 'My note', selectedIds: ['production'] } }))).toEqual(['Wait for production GLB', 'My note'])
    expect(savedAnswer({ ...moveRequest(), response: { kind: 'approve', selectedIds: ['t-8'], note: 'Only second' } })).toEqual(['t-8 · Second model', 'Only second'])
  })
  it('sends once, preserves refusal text, and requires a saved decision from the same project', async () => {
    const submit = new DecisionSubmission()
    let finish!: (body: ServerBody) => void
    const bodies: unknown[] = []
    const send = (body: unknown) => { bodies.push(body); return new Promise<ServerBody>((resolve) => { finish = resolve }) }
    const response = { kind: 'approve' as const, selectedIds: ['t-8'], note: 'Only second' }
    const pending = submit.send(send, 'p', 'move-1', response)
    expect(await submit.send(send, 'p', 'move-1', response)).toBeNull()
    expect(bodies).toEqual([{ t: 'userRequestRespond', project: 'p', id: 'move-1', response }])
    finish({ t: 'error', kind: 'refused', detail: 'Task changed' })
    await expect(pending).rejects.toThrow('Task changed'); expect(submit.busy).toBe(false)
    const view: UserRequestsView = { rev: 2n, requests: [{ ...moveRequest(), response }] }
    expect(await submit.send(async () => ({ t: 'userRequests', project: 'p', view }), 'p', 'move-1', response)).toBe(view)
    for (const reply of [{ t: 'pong' }, { t: 'userRequests', project: 'other', view }, { t: 'userRequests', project: 'p', view: { rev: 1n, requests: [moveRequest()] } }]) {
      await expect(submit.send(async () => reply as ServerBody, 'p', 'move-1', response)).rejects.toThrow(/confirm/)
    }
    await expect(submit.send(async () => { throw new Error('Disconnected') }, 'p', 'move-1', response)).rejects.toThrow('Disconnected')
    expect(submit.busy).toBe(false)
  })
})

describe('question notifications', () => {
  it('announces a pending request independently of sessions and deduplicates reconnects', () => {
    const view = { p: { rev: 1n, requests: [questionRequest()] } }
    const first = decideRequests('i', 'Laptop', { p: 'Game' }, view, new Set())
    expect(first.raise[0]).toMatchObject({ title: 'Laptop · Game', body: 'Choose icons', data: { instanceId: 'i', project: 'p', request: 'q-1' } })
    expect(decideRequests('i', 'Laptop', { p: 'Game' }, view, first.ledger).raise).toEqual([])
    const other = decideRequests('another', 'Desktop', { p: 'Game' }, view, first.ledger)
    expect(other.raise).toHaveLength(1)
  })
  it('dismisses answered decisions without guessing that an offline snapshot is empty', () => {
    const before = decideRequests('i', 'Laptop', { p: 'Game' }, { p: { rev: 1n, requests: [questionRequest()] } }, new Set())
    expect(decideRequests('i', 'Laptop', { p: 'Game' }, { p: null }, before.ledger).dismiss).toEqual([])
    const after = decideRequests('i', 'Laptop', { p: 'Game' }, { p: { rev: 2n, requests: [questionRequest({ response: { kind: 'cancel' } })] } }, before.ledger)
    expect(after.raise).toEqual([]); expect(after.dismiss).toEqual([before.raise[0]!.id])
  })
})
