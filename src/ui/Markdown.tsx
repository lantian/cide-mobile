/**
 * A task's body or comment, rendered as markdown. (M76)
 *
 * # Why the parser is vendored rather than written here
 *
 * cide's `TaskMarkdown.tsx` shares its grammar with the editor's preview because *two grammars
 * would disagree on the first nested list somebody wrote*. The same sentence decides this one,
 * one repository over: a comment is written in cide and read here, so a second parser would draw
 * somebody's own report back to them differently from the box they wrote it in.
 * `tools/sync-protocol.mjs` vendors the three files and `--check` fails a stale copy.
 *
 * # Safe by construction, which is not a property React Native gives away
 *
 * The parser produces a tree with **no markup node of any kind** — `<b>` in a comment is four
 * characters of text — and there is no `dangerouslySetInnerHTML` here because there is nothing on
 * this platform that resembles one. Every string reaches the screen as a `<Text>` child.
 *
 * # Links draw and do nothing
 *
 * cide's card shows a link's text in the accent colour and activates nothing, and this keeps that
 * exactly: a comment is model-authored, and `[innocent words](anywhere)` that opened a browser on
 * a tap would be a worse version of the surface cide already refused. An image is the same shape
 * one step further — its alt text, marked, fetching nothing.
 *
 * # `softBreak: 'break'`
 *
 * The one option, and the same one cide's card passes. A comment is a message, not a `.md` file:
 * an agent reporting five numbered steps one per line must not arrive as one wall of prose.
 */
import { memo } from 'react'
import { Text, View } from 'react-native'
import { parseMarkdown } from '../markdown/blocks'
import type { Block, Inline, ListItem } from '../markdown/types'
import { T } from './theme'
import { FACES } from '../term/ui/Screen'

/** Heading sizes, biggest first. A card is 360 points wide; `#` is not a poster. */
const HEADING = [19, 17, 16, 15, 14, 14]

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const doc = parseMarkdown(text, { softBreak: 'break' })
  return <View style={{ gap: 8 }}>{doc.blocks.map((block, i) => renderBlock(block, `b${i}`))}</View>
})

function renderBlock(block: Block, key: string) {
  switch (block.kind) {
    case 'paragraph':
      return (
        <Text key={key} style={{ color: T.text, lineHeight: 21 }}>
          {inlines(block.body, key)}
        </Text>
      )
    case 'heading':
      return (
        <Text
          key={key}
          style={{
            color: T.text,
            fontSize: HEADING[block.level - 1] ?? 14,
            fontWeight: '600',
            marginTop: 4,
          }}
        >
          {inlines(block.body, key)}
        </Text>
      )
    case 'code':
      // The fence's own text, in the grid font — the one place a comment is monospaced, and the
      // face is the bundled one so a box-drawn diagram in a fence lines up like the terminal's.
      return (
        <View
          key={key}
          style={{
            backgroundColor: T.panel,
            borderRadius: 6,
            borderWidth: 1,
            borderColor: T.border,
            padding: 8,
          }}
        >
          <Text style={{ color: T.text, fontFamily: FACES.regular, fontSize: 12 }}>
            {block.text.replace(/\n$/, '')}
          </Text>
        </View>
      )
    case 'quote':
      return (
        <View
          key={key}
          style={{ borderLeftWidth: 2, borderColor: T.border, paddingLeft: 10, gap: 6 }}
        >
          {block.body.map((child: Block, i: number) => renderBlock(child, `${key}.${i}`))}
        </View>
      )
    case 'list':
      return (
        <View key={key} style={{ gap: 4 }}>
          {block.items.map((item, i) => (
            <Item
              key={`${key}.${i}`}
              item={item}
              marker={block.ordered ? `${block.start + i}.` : '\u2022'}
              keyBase={`${key}.${i}`}
            />
          ))}
        </View>
      )
    case 'rule':
      return (
        <View key={key} style={{ height: 1, backgroundColor: T.border, marginVertical: 4 }} />
      )
    case 'table':
      // Drawn as its rows, one line each, rather than as a grid: a table wide enough to be worth
      // one is wider than a phone, and a squeezed grid is less readable than the cells in order.
      return (
        <View key={key} style={{ gap: 2 }}>
          {[{ cells: block.head }, ...block.rows].map((row, i) => (
            <Text key={`${key}.${i}`} style={{ color: i === 0 ? T.dim : T.text, lineHeight: 20 }}>
              {row.cells.map((cell: readonly Inline[], c: number) => (
                <Text key={c}>
                  {c === 0 ? '' : '  ·  '}
                  {inlines(cell, `${key}.${i}.${c}`)}
                </Text>
              ))}
            </Text>
          ))}
        </View>
      )
    default:
      return null
  }
}

function Item({
  item,
  marker,
  keyBase,
}: {
  item: ListItem
  marker: string
  keyBase: string
}) {
  return (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <Text style={{ color: T.dim, lineHeight: 21 }}>
        {item.checked === null || item.checked === undefined ? marker : item.checked ? '☑' : '☐'}
      </Text>
      <View style={{ flex: 1, gap: 4 }}>
        {item.body.map((child: Block, i: number) => renderBlock(child, `${keyBase}.${i}`))}
      </View>
    </View>
  )
}

function inlines(list: readonly Inline[], key: string) {
  return list.map((node, i) => renderInline(node, `${key}.i${i}`))
}

function renderInline(node: Inline, key: string) {
  switch (node.kind) {
    case 'text':
      return <Text key={key}>{node.text}</Text>
    case 'strong':
      return (
        <Text key={key} style={{ fontWeight: '700' }}>
          {inlines(node.body, key)}
        </Text>
      )
    case 'em':
      return (
        <Text key={key} style={{ fontStyle: 'italic' }}>
          {inlines(node.body, key)}
        </Text>
      )
    case 'del':
      return (
        <Text key={key} style={{ textDecorationLine: 'line-through', color: T.dim }}>
          {inlines(node.body, key)}
        </Text>
      )
    case 'code':
      return (
        <Text key={key} style={{ fontFamily: FACES.regular, color: T.accent, fontSize: 13 }}>
          {node.text}
        </Text>
      )
    case 'link':
      // Accented, and inert. See the header.
      return (
        <Text key={key} style={{ color: T.accent }}>
          {inlines(node.body, key)}
        </Text>
      )
    case 'image':
      return (
        <Text key={key} style={{ color: T.dim }}>
          {`🖼 ${node.alt}`}
        </Text>
      )
    case 'break':
      return <Text key={key}>{'\n'}</Text>
    default:
      return null
  }
}
