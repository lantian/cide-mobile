import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Pressable: 'Pressable' }))
vi.mock('../src/term/ui/Screen', () => ({ FACES: { regular: 'AdwaitaMono-Regular' } }))
import { Markdown } from '../src/ui/Markdown'

it('makes every message block selectable and explicitly focusable for Android native selection', () => {
  const text = '# Heading\n\nParagraph with **bold** and `inline code`.\n\n> A quote\n\n- A list item\n\n```sh\necho example\n```\n\n| Name | Value |\n| --- | --- |\n| Row | Cell |'
  let view: ReturnType<typeof create>
  act(() => { view = create(<Markdown text={text} selectable copyCode />) })
  const blocks = view!.root.findAllByType('Text' as React.ElementType).filter(node => node.props.selectable === true)
  expect(blocks.length).toBeGreaterThanOrEqual(7)
  for (const block of blocks) {
    // RN's Android accessible prop sets native focusability; its implicit false
    // otherwise overrides the focus required by TextView's selection handles.
    expect(block.props.accessible).toBe(true)
    expect(block.props.onLongPress).toBeUndefined()
    expect(block.props.onStartShouldSetResponder).toBeUndefined()
  }
  act(() => view!.unmount())
})

it('preserves platform accessibility defaults when text selection was not requested', () => {
  let view: ReturnType<typeof create>
  act(() => { view = create(<Markdown text="Ordinary task text" />) })
  const text = view!.root.findAllByType('Text' as React.ElementType)[0]!
  expect(text.props.accessible).toBeUndefined()
  expect(text.props.selectable).toBe(false)
  act(() => view!.unmount())
})
