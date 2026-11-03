import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientBody, ServerBody, UserRequest } from '../src/protocol/generated'
import { questionRequest, moveRequest } from './requestFixtures'

vi.mock('react-native', () => ({ View: 'View', Text: 'Text', TextInput: 'TextInput', Pressable: 'Pressable', ScrollView: 'ScrollView',
  Modal: ({ visible, children }: { visible: boolean; children: React.ReactNode }) => visible ? React.createElement('Modal', {}, children) : null,
  useWindowDimensions: () => ({ width: 400, height: 800 }),
  FlatList: ({ data, renderItem, ...props }: { data: unknown[]; renderItem: (info: { item: unknown; index: number }) => React.ReactNode }) =>
    React.createElement('FlatList', props, data.map((item, index) => React.createElement(React.Fragment, { key: index }, renderItem({ item, index })))),
}))
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('../src/ui/AttachmentStrip', () => ({ AttachmentTile: 'AttachmentTile' }))
vi.mock('../src/ui/ImageViewer', () => ({ ImageViewer: 'ImageViewer' }))
vi.mock('../src/requests/useTask', () => ({ useDecisionTask: () => ({ detail: { attachments: [], comments: [] }, error: null, refresh: vi.fn() }) }))
vi.mock('../src/ui/DecisionTask', () => ({ DecisionTask: ({ task, onOpenTask }: { task: string; onOpenTask: (id: string) => void }) =>
  React.createElement('TaskDetail', { task }, React.createElement('Pressable', { accessibilityLabel: 'Nested task', onPress: () => onOpenTask('t-9') })) }))
const wire = vi.hoisted(() => ({ request: vi.fn(), adopt: vi.fn() }))
vi.mock('../src/store/registry', () => ({ connectionOf: () => ({ request: wire.request, has: () => true }), adoptUserRequests: wire.adopt }))
import { WaitingDecisions } from '../src/ui/WaitingDecisions'
import { decisions } from '../src/requests/model'

let screen: ReactTestRenderer | undefined
const native = (name: string) => name as React.ElementType
const items = (request: UserRequest) => decisions({ p: { rev: 1n, requests: [request] } }, {}, 'p')
function mount(request = questionRequest()) { act(() => { screen = create(<WaitingDecisions instance="i" enabled items={items(request)} />) }); return screen! }
function button(label: string) {
  return screen!.root.findAllByType(native('Pressable')).find((node) => node.props.accessibilityLabel === label || node.findAllByType(native('Text')).some((text) => text.children.includes(label)))!
}
const press = (label: string) => { const node = button(label); expect(node).toBeDefined(); expect(node.props.disabled).not.toBe(true); act(() => node.props.onPress()) }
afterEach(() => { if (screen) act(() => screen!.unmount()); screen = undefined; vi.clearAllMocks() })

describe('mobile Waiting decision dialogs', () => {
  it('opens inline task links with nested Back and retains the answer draft after close and return', () => {
    mount(); press('Question: Choose icons')
    const radio = screen!.root.findAll((node) => node.type === native('Pressable') && node.props.accessibilityRole === 'radio')[0]!
    act(() => radio.props.onPress())
    act(() => screen!.root.findByType(native('TextInput')).props.onChangeText('Keep this draft'))
    const links = screen!.root.findAll((node) => node.type === native('Text') && node.props.accessibilityRole === 'link')
    expect(links.map((node) => node.props.accessibilityLabel)).toEqual(['Open task t-7'])
    act(() => links[0]!.props.onPress()); expect(screen!.root.findByType(native('TaskDetail')).props.task).toBe('t-7')
    press('Nested task'); expect(screen!.root.findByType(native('TaskDetail')).props.task).toBe('t-9')
    press('Back'); expect(screen!.root.findByType(native('TaskDetail')).props.task).toBe('t-7')
    press('Back'); expect(screen!.root.findAllByType(native('TaskDetail'))).toHaveLength(0)
    expect(screen!.root.findByType(native('TextInput')).props.value).toBe('Keep this draft')
    press('Close'); expect(wire.request).not.toHaveBeenCalled(); press('Question: Choose icons')
    expect(screen!.root.findByType(native('TextInput')).props.value).toBe('Keep this draft')
    expect(screen!.root.findAll((node) => node.type === native('Pressable') && node.props.accessibilityRole === 'radio')[0]!.props.accessibilityState.checked).toBe(true)
  })
  it('sends a question to the broker, preserves drafts after refusal, and displays the saved choice', async () => {
    wire.request.mockResolvedValue({ t: 'error', kind: 'refused', detail: 'Try again' })
    mount(); press('Question: Choose icons')
    act(() => screen!.root.findAll((node) => node.type === native('Pressable') && node.props.accessibilityRole === 'radio')[0]!.props.onPress())
    await act(async () => button('Answer').props.onPress())
    expect(wire.request).toHaveBeenCalledWith({ t: 'userRequestRespond', project: 'p', id: 'q-1', response: { kind: 'answer', text: '', selectedIds: ['production'] } })
    expect(screen!.root.findAll((node) => node.type === native('Pressable') && node.props.accessibilityRole === 'radio')[0]!.props.accessibilityState.checked).toBe(true)
    const saved = questionRequest({ response: { kind: 'answer', text: '', selectedIds: ['production'] } })
    wire.request.mockResolvedValue({ t: 'userRequests', project: 'p', view: { rev: 2n, requests: [saved] } })
    await act(async () => button('Answer').props.onPress())
    expect(wire.adopt).toHaveBeenCalledWith('i', 'p', { rev: 2n, requests: [saved] })
    act(() => screen!.update(<WaitingDecisions instance="i" enabled items={items(saved)} />))
    expect(JSON.stringify(screen!.toJSON())).toContain('Wait for production GLB')
    expect(JSON.stringify(screen!.toJSON())).not.toContain('selectedIds')
    act(() => screen!.update(<WaitingDecisions instance="i" enabled items={items({ ...saved, delivered: true })} />))
    expect(screen!.root.findAllByType(native('Modal'))).toHaveLength(0)
  })
  it('allows inspecting proposals and sends only selected task IDs without duplicate writes', async () => {
    let finish!: (body: ServerBody) => void
    wire.request.mockImplementation((body: ClientBody) => body.t === 'userRequestRespond' ? new Promise<ServerBody>((resolve) => { finish = resolve }) : Promise.resolve({ t: 'pong' }))
    mount(moveRequest()); press('Move tasks: Move into look?'); press('Include t-7'); press('View task t-8')
    expect(screen!.root.findByType(native('TaskDetail')).props.task).toBe('t-8'); press('Back')
    await act(async () => { button('Accept selected (1)').props.onPress(); button('Accept selected (1)').props.onPress() })
    expect(wire.request).toHaveBeenCalledTimes(1)
    const response = { kind: 'approve' as const, selectedIds: ['t-8'], note: '' }
    expect(wire.request).toHaveBeenCalledWith({ t: 'userRequestRespond', project: 'p', id: 'move-1', response })
    await act(async () => finish({ t: 'userRequests', project: 'p', view: { rev: 2n, requests: [{ ...moveRequest(), response }] } }))
    expect(wire.adopt).toHaveBeenCalled()
  })
  it('opens a cold-start notification after its snapshot arrives and stays closed when dismissed', () => {
    act(() => { screen = create(<WaitingDecisions instance="i" enabled items={[]} initialRequest="q-1" />) })
    act(() => screen!.update(<WaitingDecisions instance="i" enabled items={items(questionRequest())} initialRequest="q-1" />))
    expect(screen!.root.findAllByType(native('Modal'))).toHaveLength(1); press('Close')
    act(() => screen!.update(<WaitingDecisions instance="i" enabled items={items(questionRequest())} initialRequest="q-1" />))
    expect(screen!.root.findAllByType(native('Modal'))).toHaveLength(0)
  })
})
