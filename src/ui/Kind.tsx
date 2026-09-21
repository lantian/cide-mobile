/**
 * Telling a Claude console from a shell at a glance. (M76)
 *
 * The list used to say which was which in the small grey line under the title — the pane's own
 * name, `claude` or `bash`, among two other facts in the same size and colour. That is enough to
 * *look up* and not enough to *see*, and these are the two things on the screen least alike:
 * typing into one is a conversation with an agent and typing into the other is a command that
 * runs. Somebody opening the wrong one from a phone finds out by what happens next.
 *
 * So the difference is carried three times over, by the three channels a row has: **colour** (a
 * stripe down the edge and the mark drawn in it), **shape** (a glyph that is not a letter), and
 * **the word**, kept because colour alone is not a thing everybody can read and a monochrome
 * screenshot has to stay legible.
 *
 * The glyphs are plain Unicode rather than an icon set: this app carries no icon font, and
 * adding one for two marks would be a font download on every launch. `✳` is what Claude Code
 * prints as its own spinner and `$` is what a shell prints as its prompt, so neither is an
 * invention of this file.
 */
import { Text, View } from 'react-native'
import { FACES } from '../term/ui/Screen'
import { T } from './theme'
import type { PaneKind } from '../protocol/generated'

export interface Look {
  /** The word, for the meta line and for anybody who cannot use the colour. */
  label: string
  /** One character, drawn large in the tile. */
  glyph: string
  tint: string
}

/**
 * What a pane of this kind looks like.
 *
 * `title` is taken for a shell because cide names that pane after the shell it is running —
 * `bash`, `zsh`, `fish` — and which shell it is, is exactly the thing somebody wants to know
 * about it. Every other kind has one word that is always right.
 */
export function look(kind: PaneKind, title?: string): Look {
  switch (kind) {
    case 'claude':
      return { label: 'Claude', glyph: '✳', tint: '#d78bff' }
    case 'shell':
      return { label: title !== undefined && title !== '' ? title : 'Shell', glyph: '$', tint: T.good }
    case 'diff':
      return { label: 'Diff', glyph: '±', tint: T.warn }
    case 'editor':
      return { label: 'Editor', glyph: '¶', tint: T.accent }
  }
}

/**
 * The mark, in a tinted tile.
 *
 * A tile and not a bare glyph, because a coloured character on a dark panel is a colour applied
 * to two or three per cent of the row's area and reads as nothing at arm's length. The tile is
 * the colour; the glyph is the shape.
 */
export function KindTile({ look: it, size = 28 }: { look: Look; size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 4,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: tinted(it.tint),
        borderWidth: 1,
        borderColor: it.tint,
      }}
    >
      <Text
        allowFontScaling={false}
        // The bundled face rather than the system's: `✳` is not in every phone's monospace,
        // and a tile whose mark is a tofu box is worse than no tile at all.
        style={{ color: it.tint, fontSize: size * 0.55, fontFamily: FACES.regular }}
      >
        {it.glyph}
      </Text>
    </View>
  )
}

/**
 * The tint at the strength a filled shape wants.
 *
 * Eight-digit hex rather than `rgba(...)`: React Native accepts `#rrggbbaa` on both platforms,
 * and building the string from components would mean parsing the tint back out of the hex it is
 * already written as.
 */
function tinted(hex: string): string {
  return `${hex}22`
}

/** The stripe down the leading edge of a card. */
export function KindStripe({ tint }: { tint: string }) {
  return <View style={{ width: 4, backgroundColor: tint }} />
}
