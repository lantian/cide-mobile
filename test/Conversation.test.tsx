import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ClientBody, ConversationPage, ServerBody } from '../src/protocol/generated'

const fixture = vi.hoisted(() => ({ request: vi.fn(), acknowledge: vi.fn(), appState: { currentState: 'active', listeners: new Set<(s: string) => void>() }, keyboard: new Set<() => void>(), views: [] as unknown[], listeners: new Set<() => void>(), copy: vi.fn(), scrollToEnd: vi.fn(), estimatedEnd: vi.fn() }))
vi.mock('react-native', () => ({
  View: 'View', Text: 'Text', Pressable: 'Pressable', TextInput: 'TextInput', KeyboardAvoidingView: 'KeyboardAvoidingView', Platform: { OS: 'android' },
  AppState: { get currentState() { return fixture.appState.currentState }, addEventListener: (_event: string, fn: (s: string) => void) => { fixture.appState.listeners.add(fn); return { remove: () => fixture.appState.listeners.delete(fn) } } },
  Keyboard: { addListener: (_event: string, fn: () => void) => { fixture.keyboard.add(fn); return { remove: () => fixture.keyboard.delete(fn) } } },
  FlatList: React.forwardRef(({ data, renderItem, ...props }: { data: unknown[]; renderItem: (i: { item: unknown }) => React.ReactNode }, ref) => {
    React.useImperativeHandle(ref, () => ({ scrollToEnd: fixture.estimatedEnd, getNativeScrollRef: () => ({ scrollToEnd: fixture.scrollToEnd }) }))
    return React.createElement('FlatList', props, data.map((item, i) => React.createElement(React.Fragment, { key: i }, renderItem({ item }))))
  }),
}))
vi.mock('expo-router', () => ({ Stack: { Screen: 'StackScreen' }, useRouter: () => ({ push: vi.fn(), back: vi.fn() }), useFocusEffect: (fn: () => void | (() => void)) => React.useEffect(fn, [fn]) }))
vi.mock('expo-clipboard', () => ({ setStringAsync: fixture.copy }))
vi.mock('../src/term/ui/Selection', () => ({ Selection: 'Selection' }))
vi.mock('../src/ui/Markdown', () => ({ Markdown: ({ text }: { text: string }) => React.createElement('Text', {}, text) }))
vi.mock('../src/consoles/Attachments', () => ({ ConsoleAttachments: 'ConsoleAttachments' }))
vi.mock('../src/notify/driver', () => ({ watching: vi.fn() }))
const connection = { request: fixture.request, acknowledge: fixture.acknowledge, has: () => true, tell: vi.fn() }
vi.mock('../src/store/registry', () => ({ connectionOf: () => connection, subscribe: (fn: () => void) => { fixture.listeners.add(fn); return () => fixture.listeners.delete(fn) }, getSnapshot: () => fixture.views, acknowledged: vi.fn() }))
import { Conversation } from '../src/conversations/Conversation'

let mounted: ReactTestRenderer | undefined
let sequence = 0
const page: ConversationPage = {
  conversation: { project: 'p', id: 'native', harness: 'codex', title: 'Example', preview: '', updatedUnixMs: 1, session: 's', state: { state: 'busy' }, writable: true, canResume: false },
  generation: 'g', revision: '1', items: [{ id: 'm', ordinal: 0, kind: 'assistant', text: 'Saved answer', tool: null, status: null, detailAvailable: false }], before: null, after: '1', reset: false, available: true, detail: null, prompt: null,
}
beforeEach(() => {
  vi.useFakeTimers(); fixture.appState.currentState = 'active'
  vi.stubGlobal('requestAnimationFrame', (fn: (time: number) => void) => setTimeout(() => fn(0), 16))
  vi.stubGlobal('cancelAnimationFrame', (frame: ReturnType<typeof setTimeout>) => clearTimeout(frame))
  fixture.views = [{ paired: { instanceId: 'i' }, phase: 'ready', sessions: [], awaiting: [] }]
  fixture.request.mockImplementation(async (body: ClientBody): Promise<ServerBody> => {
    if (body.t !== 'conversation') throw new Error('unexpected request')
    if (body.request.action === 'send') return { t: 'conversation', response: { action: 'receipt', operation: body.request.operation, status: 'submitted', session: 's' } }
    return { t: 'conversation', response: { action: 'read', page } }
  })
})
afterEach(() => { if (mounted) act(() => mounted!.unmount()); mounted = undefined; vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
async function mount(readOnly = false) {
  await act(async () => { mounted = create(<Conversation iid="i" project="p" id={`visit-${++sequence}`} readOnly={readOnly} />) })
}
const native = (s: string) => s as React.ElementType
function button(label: string) { return mounted!.root.findAllByType(native('Pressable')).find(n => n.findAllByType(native('Text')).some(t => t.children.includes(label)))! }
const list = () => mounted!.root.findByType(native('FlatList'))
const scroll = (y: number, content = 2400, viewport = 600) => ({ nativeEvent: { contentOffset: { y }, contentSize: { height: content }, layoutMeasurement: { height: viewport } } })
const frame = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(16) }) }

it('reads saved messages without subscribing to terminal screens and polls while working', async () => {
  await mount()
  expect(mounted!.root.findAllByType(native('Text')).some(t => t.children.includes('Saved answer'))).toBe(true)
  expect(mounted!.root.findAllByType(native('Text')).some(t => t.children.includes('Working'))).toBe(true)
  expect(fixture.request.mock.calls[0]![0]).toMatchObject({ t: 'conversation', request: { action: 'read' } })
  const before = fixture.request.mock.calls.length
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(fixture.request.mock.calls.length).toBeGreaterThan(before)
  expect(connection.tell).not.toHaveBeenCalled()
})
it('keeps the draft after failed busy submission and does not replay it', async () => {
  await mount()
  act(() => mounted!.root.findByType(native('TextInput')).props.onChangeText('steer\nwith code'))
  fixture.request.mockImplementation(async (body: ClientBody) => { if (body.t === 'conversation' && body.request.action === 'send') throw new Error('Disconnected'); return { t: 'conversation', response: { action: 'read', page } } })
  await act(async () => button('Send while working').props.onPress())
  expect(mounted!.root.findByType(native('TextInput')).props.value).toBe('steer\nwith code')
  await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
  expect(fixture.request.mock.calls.filter(([b]) => b.t === 'conversation' && b.request.action === 'send')).toHaveLength(1)
  expect(mounted!.root.findAllByType(native('Text')).some(t => t.children.some(child => typeof child === 'string' && child.includes('Disconnected')))).toBe(true)
})
it('clears an acknowledged prompt and keeps read-only logs free of a composer', async () => {
  await mount()
  act(() => mounted!.root.findByType(native('TextInput')).props.onChangeText('hello'))
  await act(async () => button('Send while working').props.onPress())
  expect(mounted!.root.findByType(native('TextInput')).props.value).toBe('')
  act(() => mounted!.unmount()); mounted = undefined
  await mount(true)
  expect(mounted!.root.findAllByType(native('TextInput'))).toHaveLength(0)
})
it('stops reading in the background and catches up on foreground', async () => {
  await mount()
  act(() => { fixture.appState.currentState = 'background'; for (const fn of fixture.appState.listeners) fn('background') })
  const before = fixture.request.mock.calls.length
  await act(async () => { await vi.advanceTimersByTimeAsync(20000) })
  expect(fixture.request).toHaveBeenCalledTimes(before)
  await act(async () => { fixture.appState.currentState = 'active'; for (const fn of fixture.appState.listeners) fn('active') })
  expect(fixture.request.mock.calls.length).toBeGreaterThan(before)
})

it('resumes a past conversation explicitly and binds the composer to the returned session', async () => {
  let resumed = false
  fixture.request.mockImplementation(async (body: ClientBody): Promise<ServerBody> => {
    if (body.t !== 'conversation') throw new Error('unexpected request')
    if (body.request.action === 'resume') {
      resumed = true
      return { t: 'conversation', response: { action: 'receipt', operation: body.request.operation, status: 'resumed', session: 'resumed-session' } }
    }
    return { t: 'conversation', response: { action: 'read', page: { ...page, conversation: { ...page.conversation, session: resumed ? 'resumed-session' : null, writable: resumed, canResume: !resumed, state: resumed ? { state: 'idle' } : { state: 'exited', code: 0 } } } } }
  })
  await mount()
  expect(mounted!.root.findAllByType(native('TextInput'))).toHaveLength(0)
  await act(async () => button('Resume conversation').props.onPress())
  expect(fixture.request.mock.calls.filter(([body]) => body.t === 'conversation' && body.request.action === 'resume')).toHaveLength(1)
  expect(mounted!.root.findByType(native('TextInput'))).toBeDefined()
  expect(mounted!.root.findAllByType(native('Text')).some(t => t.children.includes('Ready'))).toBe(true)
})

it('a rapid second Send does not submit the same draft twice', async () => {
  let confirm: ((body: ServerBody) => void) | undefined
  fixture.request.mockImplementation(async (body: ClientBody): Promise<ServerBody> => {
    if (body.t === 'conversation' && body.request.action === 'send') return new Promise(resolve => { confirm = resolve })
    return { t: 'conversation', response: { action: 'read', page } }
  })
  await mount()
  act(() => mounted!.root.findByType(native('TextInput')).props.onChangeText('one prompt'))
  const press = button('Send while working').props.onPress
  act(() => { press(); press() })
  const sent = fixture.request.mock.calls.filter(([body]) => body.t === 'conversation' && body.request.action === 'send')
  expect(sent).toHaveLength(1)
  await act(async () => { confirm!({ t: 'conversation', response: { action: 'receipt', operation: 'accepted', status: 'submitted', session: 's' } }) })
})

it('Copy fetches the full message instead of silently copying a clipped preview', async () => {
  fixture.request.mockImplementation(async (body: ClientBody): Promise<ServerBody> => {
    if (body.t === 'conversation' && body.request.action === 'detail') return { t: 'conversation', response: { action: 'detail', text: 'Full message including its tail', next: null } }
    return { t: 'conversation', response: { action: 'read', page: { ...page, items: [{ ...page.items[0]!, text: 'Preview', detailAvailable: true }] } } }
  })
  await mount()
  await act(async () => button('Copy').props.onPress())
  expect(fixture.copy).toHaveBeenCalledWith('Full message including its tail')
})

it('opens at the native end and corrects it as the viewport and variable-height messages finish layout', async () => {
  fixture.request.mockResolvedValue({ t: 'conversation', response: { action: 'read', page: { ...page, items: Array.from({ length: 50 }, (_, i) => ({ ...page.items[0]!, id: `message-${i}`, ordinal: i, text: 'A variable-height message. '.repeat(i + 1) })) } } })
  await mount()
  // Start virtualization at the tail instead of walking through 50 unmeasured rows.
  expect(list().props.initialScrollIndex).toBe(49)
  act(() => list().props.onScrollToIndexFailed({ index: 49, averageItemLength: 100, highestMeasuredFrameIndex: 0 }))
  act(() => list().props.onContentSizeChange(360, 2400))
  await frame()
  expect(fixture.scrollToEnd).toHaveBeenLastCalledWith({ animated: false })
  fixture.scrollToEnd.mockClear()
  act(() => list().props.onLayout({ nativeEvent: { layout: { height: 600 } } }))
  await frame()
  expect(fixture.scrollToEnd).toHaveBeenCalledTimes(1)
  fixture.scrollToEnd.mockClear()
  act(() => list().props.onContentSizeChange(360, 5700))
  await frame()
  expect(fixture.scrollToEnd).toHaveBeenCalledTimes(1)
  expect(fixture.estimatedEnd).not.toHaveBeenCalled()
})

it('holds the reader above the bottom, then follows updates after a drag returns to the latest message', async () => {
  await mount(); await frame(); fixture.scrollToEnd.mockClear()
  act(() => {
    list().props.onScrollBeginDrag()
    list().props.onScroll(scroll(300))
    list().props.onScrollEndDrag(scroll(300))
  })
  expect(button('Jump to latest')).toBeDefined()
  fixture.request.mockResolvedValue({ t: 'conversation', response: { action: 'read', page: { ...page, revision: '2', after: '2', items: [{ ...page.items[0]!, id: 'new', ordinal: 1, text: 'New saved message' }] } } })
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  act(() => { list().props.onContentSizeChange(360, 2800); list().props.onLayout({ nativeEvent: { layout: { height: 600 } } }) })
  await frame()
  expect(fixture.scrollToEnd).not.toHaveBeenCalled()
  act(() => {
    list().props.onScrollBeginDrag()
    list().props.onScroll(scroll(2200, 2800))
    list().props.onScrollEndDrag(scroll(2200, 2800))
  })
  await frame(); fixture.scrollToEnd.mockClear()
  expect(button('Jump to latest')).toBeUndefined()
  act(() => list().props.onContentSizeChange(360, 3200))
  await frame()
  expect(fixture.scrollToEnd).toHaveBeenCalledTimes(1)
})

it('does not mistake a content-growth scroll event for the reader scrolling away', async () => {
  await mount(); await frame(); fixture.scrollToEnd.mockClear()
  act(() => { list().props.onScroll(scroll(1800, 3200)); list().props.onContentSizeChange(360, 3200) })
  await frame()
  expect(fixture.scrollToEnd).toHaveBeenCalledTimes(1)
  expect(button('Jump to latest')).toBeUndefined()
})

it('cancels a pending follow when the reader starts dragging or flinging', async () => {
  await mount(); await frame(); fixture.scrollToEnd.mockClear()
  act(() => { list().props.onContentSizeChange(360, 2400); list().props.onScrollBeginDrag() })
  await frame()
  expect(fixture.scrollToEnd).not.toHaveBeenCalled()
  act(() => { list().props.onScrollEndDrag(scroll(1800)); list().props.onMomentumScrollBegin() })
  await frame()
  expect(fixture.scrollToEnd).not.toHaveBeenCalled()
  act(() => list().props.onMomentumScrollEnd(scroll(1800)))
  await frame()
  expect(fixture.scrollToEnd).toHaveBeenCalledTimes(1)
})

it('Jump to latest restores following, including when the keyboard resizes the view', async () => {
  await mount(); await frame(); fixture.scrollToEnd.mockClear()
  act(() => { list().props.onScrollBeginDrag(); list().props.onScrollEndDrag(scroll(200)) })
  act(() => { for (const fn of fixture.keyboard) fn() })
  await frame()
  expect(fixture.scrollToEnd).not.toHaveBeenCalled()
  act(() => button('Jump to latest').props.onPress())
  await frame()
  expect(fixture.scrollToEnd).toHaveBeenCalledTimes(1)
  fixture.scrollToEnd.mockClear()
  act(() => { for (const fn of fixture.keyboard) fn() })
  await frame()
  expect(fixture.scrollToEnd).toHaveBeenCalledTimes(1)
})

it('reopens a cached conversation at its latest message after leaving it scrolled up', async () => {
  await mount(); await frame()
  const props = mounted!.root.findByType(Conversation).props as React.ComponentProps<typeof Conversation>
  act(() => { list().props.onScrollBeginDrag(); list().props.onScrollEndDrag(scroll(200)) })
  act(() => mounted!.unmount()); mounted = undefined
  fixture.scrollToEnd.mockClear()
  await act(async () => { mounted = create(<Conversation {...props} />) })
  act(() => list().props.onLayout({ nativeEvent: { layout: { height: 600 } } }))
  await frame()
  expect(fixture.scrollToEnd).toHaveBeenCalledTimes(1)
  expect(button('Jump to latest')).toBeUndefined()
})

it('loading earlier messages preserves the viewport instead of pulling the reader back down', async () => {
  fixture.request.mockResolvedValue({ t: 'conversation', response: { action: 'read', page: { ...page, before: '1' } } })
  await mount(); await frame(); fixture.scrollToEnd.mockClear()
  await act(async () => list().props.ListHeaderComponent.props.onPress())
  act(() => list().props.onContentSizeChange(360, 5000))
  await frame()
  expect(fixture.scrollToEnd).not.toHaveBeenCalled()
  expect(button('Jump to latest')).toBeDefined()
  expect(list().props.maintainVisibleContentPosition).toEqual({ minIndexForVisible: 0 })
})

it('keeps native text views attached and touchable for long-press selection', async () => {
  await mount()
  expect(list().props.removeClippedSubviews).toBe(false)
  expect(list().props.keyboardShouldPersistTaps).toBe('always')
})
