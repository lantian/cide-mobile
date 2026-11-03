import { describe, expect, it } from 'vitest'
import { EMPTY, activity, askConversation, mergePage } from '../src/conversations/model'
import type { ConversationItem, ConversationPage } from '../src/protocol/generated'

const item = (id: string, ordinal: number, text = id): ConversationItem => ({ id, ordinal, text, kind: 'assistant', tool: null, status: null, detailAvailable: false })
const page = (changes: Partial<ConversationPage> = {}): ConversationPage => ({
  conversation: { project: 'p', id: 'native-id', harness: 'claude', title: 'Conversation', preview: '', updatedUnixMs: 1, session: 's', state: { state: 'busy' }, writable: true, canResume: false },
  generation: 'one', revision: '10', items: [item('new', 50)], before: '50', after: '10', reset: false, available: true, detail: null, prompt: null, ...changes,
})
describe('conversation history', () => {
  it('prepends older pages while preserving the update cursor and draft', () => {
    let held = mergePage({ ...EMPTY, draft: 'unsent' }, page())
    held = mergePage(held, page({ items: [item('old', 1)], before: null }), true)
    expect(held.items.map(i => i.id)).toEqual(['old', 'new'])
    expect(held.before).toBeNull(); expect(held.after).toBe('10'); expect(held.draft).toBe('unsent')
  })
  it('updates existing tool cards without moving them or duplicating messages', () => {
    let held = mergePage(EMPTY, page({ items: [item('tool', 1), item('message', 2)] }))
    held = mergePage(held, page({ items: [item('tool', 1, 'completed')], revision: '11', after: '11' }))
    expect(held.items.map(i => i.text)).toEqual(['completed', 'message'])
    expect(held.before).toBe('50')
  })
  it('discards stale pages and resets cursors on a replaced source', () => {
    const held = mergePage(EMPTY, page())
    expect(mergePage(held, page({ revision: '9' }))).toBe(held)
    const reset = mergePage(held, page({ generation: 'two', revision: '1', items: [item('replacement', 0)], before: null, after: '1', reset: true }))
    expect(reset.items.map(i => i.id)).toEqual(['replacement']); expect(reset.before).toBeNull()
  })
  it('does not collapse identical prompts with different identities', () => {
    const held = mergePage(EMPTY, page({ items: [item('a', 0, 'same'), item('b', 1, 'same')] }))
    expect(held.items).toHaveLength(2)
  })
  it('does not claim that an unknown state is idle', () => {
    expect(activity(null)).toBe('Status unavailable')
    expect(activity({ state: 'busy' })).toBe('Working')
    expect(activity({ state: 'awaitingPermission' })).toBe('Waiting for approval')
    expect(activity({ state: 'exited', code: 2 })).toBe('Exited (2)')
  })
  it('uses the acknowledged conversation API and rejects an unrelated response', async () => {
    const request = { action: 'list' as const, project: 'p' }
    await expect(askConversation({ request: async () => ({ t: 'conversation', response: { action: 'list', conversations: [] } }) }, request)).resolves.toEqual({ action: 'list', conversations: [] })
    await expect(askConversation({ request: async () => ({ t: 'pong' }) }, request)).rejects.toThrow('unexpected')
  })
})
