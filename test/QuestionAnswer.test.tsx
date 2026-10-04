/** Mount the actual mobile form with native host stubs; exercise its press handlers and state. */
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QuestionChoices, ServerBody, TaskDetail } from '../src/protocol/generated'

vi.mock('react-native', () => ({
  View: 'View', Text: 'Text', TextInput: 'TextInput', Pressable: 'Pressable',
  useWindowDimensions: () => ({ width: 400, height: 800 }),
  FlatList: ({ data, renderItem, ...props }: { data: unknown[]; renderItem: (info: { item: unknown; index: number }) => React.ReactNode }) =>
    React.createElement('FlatList', props, data.map((item, index) =>
      React.createElement(React.Fragment, { key: index }, renderItem({ item, index })))),
}))
vi.mock('../src/ui/AttachmentStrip', () => ({ AttachmentTile: 'AttachmentTile' }))
vi.mock('../src/ui/ImageViewer', () => ({ ImageViewer: 'ImageViewer' }))
const request = vi.hoisted(() => vi.fn())
vi.mock('../src/store/registry', () => ({ connectionOf: () => ({ request }) }))
import { QuestionAnswer } from '../src/ui/QuestionAnswer'

const question: QuestionChoices = {
  text: 'Choose a design', selection: 'single',
  options: [{ id: 'blue', title: 'Blue', image: 'a-blue' }, { id: 'green', title: 'Green' }],
}
const detail = { attachments: [{ id: 'a-blue', name: 'blue.png', kind: 'image', deleted: false }], comments: [] } as unknown as TaskDetail
const refresh = vi.fn()
let screen: ReactTestRenderer | undefined
const props = { instance: 'i', project: 'p', task: 't', question, detail, enabled: true, imagesEnabled: true, onRefresh: refresh }

function mount(overrides: Partial<typeof props> = {}) {
  act(() => { screen = create(<QuestionAnswer key={JSON.stringify((overrides.question ?? question))} {...props} {...overrides} />) })
  return screen!
}
const nativeType = (name: string) => name as React.ElementType

function controls(role: 'radio' | 'checkbox') {
  return screen!.root.findAll((node) => node.type === nativeType('Pressable') && node.props.accessibilityRole === role)
}
function button(label: string) {
  return screen!.root.findAllByType(nativeType('Pressable')).find((node) => node.findAllByType(nativeType('Text')).some((text) => text.children.includes(label)))!
}
function press(node: ReturnType<typeof button>) {
  expect(node).toBeDefined()
  expect(node.props.disabled).not.toBe(true)
  act(() => node.props.onPress())
}

afterEach(() => {
  if (screen !== undefined) act(() => screen!.unmount())
  screen = undefined
  vi.clearAllMocks()
})

describe('mobile option controls', () => {
  it('allows selecting a draft even when the desktop cannot submit it yet', () => {
    mount({ enabled: false })
    press(controls('radio')[0]!)
    expect(controls('radio')[0]!.props.accessibilityState.checked).toBe(true)
    expect(button('Answer').props.disabled).toBe(true)
    expect(request).not.toHaveBeenCalled()
  })

  it('single-select replaces the previous choice and enables submission', () => {
    mount()
    press(controls('radio')[0]!)
    press(controls('radio')[1]!)
    expect(controls('radio').map((node) => node.props.accessibilityState.checked)).toEqual([false, true])
    expect(button('Answer').props.disabled).toBe(false)
  })

  it.each(['single', 'multiple'] as const)('submits %s choices without requiring custom text', async (selection) => {
    request.mockResolvedValue({ t: 'taskResponded', project: 'p', task: 't' })
    const shown = { ...question, selection }
    mount({ question: shown })
    const role = selection === 'single' ? 'radio' : 'checkbox'
    press(controls(role)[0]!)
    press(controls(role)[1]!)
    await act(async () => button('Answer').props.onPress())
    expect(request).toHaveBeenCalledWith({ t: 'taskRespond', project: 'p', task: 't', response: {
      kind: 'answer', text: '', selectedIds: selection === 'single' ? ['green'] : ['blue', 'green'], expectedQuestion: shown,
    } })
    expect(controls(role).every((node) => !node.props.accessibilityState.checked)).toBe(true)
  })

  it('multi-select adds choices, toggles them off, and clears them', () => {
    mount({ question: { ...question, selection: 'multiple' } })
    press(controls('checkbox')[0]!)
    press(controls('checkbox')[1]!)
    expect(controls('checkbox').map((node) => node.props.accessibilityState.checked)).toEqual([true, true])
    press(controls('checkbox')[0]!)
    expect(controls('checkbox').map((node) => node.props.accessibilityState.checked)).toEqual([false, true])
    press(button('Clear selection'))
    expect(controls('checkbox').map((node) => node.props.accessibilityState.checked)).toEqual([false, false])
  })

  it('keeps option taps usable while typing and image preview does not change selection', () => {
    mount()
    expect(screen!.root.findByType(nativeType('FlatList')).props.keyboardShouldPersistTaps).toBe('always')
    act(() => screen!.root.findByType(nativeType('TextInput')).props.onChangeText('Details'))
    press(controls('radio')[1]!)
    act(() => screen!.root.findByType(nativeType('AttachmentTile')).props.onOpen())
    expect(screen!.root.findAllByType(nativeType('ImageViewer'))).toHaveLength(1)
    expect(controls('radio').map((node) => node.props.accessibilityState.checked)).toEqual([false, true])
    expect(screen!.root.findByType(nativeType('TextInput')).props.value).toBe('Details')
  })

  it('locks taps while sending, and a refusal retains the choices and custom text', async () => {
    let complete!: (value: ServerBody) => void
    request.mockImplementation(() => new Promise<ServerBody>((resolve) => { complete = resolve }))
    mount({ question: { ...question, selection: 'multiple' } })
    press(controls('checkbox')[0]!)
    press(controls('checkbox')[1]!)
    act(() => screen!.root.findByType(nativeType('TextInput')).props.onChangeText('Use both'))
    await act(async () => button('Answer').props.onPress())
    expect(controls('checkbox').every((node) => node.props.disabled)).toBe(true)
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ response: expect.objectContaining({ selectedIds: ['blue', 'green'], text: 'Use both' }) }))
    await act(async () => complete({ t: 'error', kind: 'refused', detail: 'Try again' }))
    expect(controls('checkbox').map((node) => node.props.accessibilityState.checked)).toEqual([true, true])
    expect(screen!.root.findByType(nativeType('TextInput')).props.value).toBe('Use both')
    expect(controls('checkbox').every((node) => !node.props.disabled)).toBe(true)
  })
})
