import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'

const held = vi.hoisted(() => ({ views: [] as unknown[], params: { iid: 'i', sid: 's', readOnly: '1' }, listeners: new Set<() => void>(), request: vi.fn() }))
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Pressable: 'Pressable', AppState: { currentState: 'active' }, Platform: { OS: 'android' } }))
vi.mock('expo-router', () => ({ Stack: { Screen: 'StackScreen' }, useLocalSearchParams: () => held.params, useRouter: () => ({ back: vi.fn() }) }))
vi.mock('../src/store/registry', () => ({ getSnapshot: () => held.views, subscribe: (fn: () => void) => { held.listeners.add(fn); return () => held.listeners.delete(fn) }, connectionOf: () => ({ has: () => true, request: held.request }) }))
vi.mock('../src/notify/driver', () => ({ watching: vi.fn() }))
vi.mock('../src/term/ui/Selection', () => ({ Selection: 'Selection' }))
vi.mock('../src/consoles/Attachments', () => ({ ConsoleAttachments: 'ConsoleAttachments' }))
vi.mock('../src/term/ui/Screen', () => ({ ScreenView: 'ScreenView' }))
vi.mock('../src/term/ui/History', () => ({ HistoryView: 'HistoryView' }))
vi.mock('../src/ui/Kind', () => ({ KindTile: 'KindTile', look: vi.fn() }))
vi.mock('../src/conversations/Conversation', () => ({ Conversation: (props: object) => React.createElement('Conversation', props) }))
import SessionScreen from '../app/session/[iid]/[sid]'

let screen: ReactTestRenderer | undefined
const native = (name: string) => name as React.ElementType
afterEach(() => { if (screen) act(() => screen!.unmount()); screen = undefined; vi.clearAllMocks() })

it.each(['claude', 'codex', 'qwen', 'opencode', 'mimo'])('opens a %s agent log without requiring a desktop pane', async harness => {
  held.views = [{ paired: { instanceId: 'i' }, phase: 'ready', projects: [{ id: 'p' }], sessions: [], runs: { p: [{ harness, project: 'p', session: 's' }] } }]
  await act(async () => { screen = create(<SessionScreen />) })
  const conversation = screen!.root.findByType(native('Conversation'))
  expect(conversation.props.project).toBe('p')
  expect(conversation.props.followSession).toBe('s')
  expect(conversation.props.readOnly).toBe(true)
  expect(held.request).not.toHaveBeenCalled()
})

it('keeps the conversation reader open when its console disappears from the live list', async () => {
  const view = { paired: { instanceId: 'i' }, phase: 'ready', projects: [{ id: 'p' }], sessions: [{ session: 's', project: 'p', kind: 'claude', harness: 'codex' }], runs: {} }
  held.views = [view]
  await act(async () => { screen = create(<SessionScreen />) })
  act(() => { held.views = [{ ...view, sessions: [] }]; for (const fn of held.listeners) fn() })
  expect(screen!.root.findByType(native('Conversation')).props.project).toBe('p')
})

it('resolves a notification session through saved project history after its live row is gone', async () => {
  held.views = [{ paired: { instanceId: 'i' }, phase: 'ready', projects: [{ id: 'p' }], sessions: [], runs: {} }]
  held.request.mockResolvedValue({ t: 'conversation', response: { action: 'read', page: { conversation: { project: 'p', id: 'native', harness: 'qwen' }, generation: 'g', revision: '0', items: [], before: null, after: '0', reset: true } } })
  await act(async () => { screen = create(<SessionScreen />) })
  expect(held.request).toHaveBeenCalledWith(expect.objectContaining({ t: 'conversation', request: expect.objectContaining({ action: 'read', project: 'p', followSession: 's' }) }))
  expect(screen!.root.findByType(native('Conversation')).props.project).toBe('p')
})
