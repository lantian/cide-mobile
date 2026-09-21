/**
 * A terminal, drawn.
 *
 * # The shape this is arranged around
 *
 * The parent renders `rows` row components **once**, from the geometry, and never re-renders on
 * data. Each row subscribes to its own store. A frame that touches twelve rows re-renders twelve
 * components and nothing else.
 *
 * The version that holds the grid in one place and maps over it re-renders the screen on every
 * frame — sixty rows reconciled to update twelve, each a `<Text>` with nested spans that becomes
 * a native attributed-string update crossing to the UI thread. On a mid-range phone that is a
 * dropped-frame machine, and the first thing anybody notices is the keyboard lagging.
 *
 * # Three props that are not decoration
 *
 * `allowFontScaling={false}` — the OS font-size setting must not break the grid.
 * `includeFontPadding={false}` — Android adds leading to a line box otherwise, and rows drift.
 * `numberOfLines={1}` — a row is a row; wrapping is [`wrap`]'s job and is a mode, not an accident.
 *
 * # The font is bundled, and that is a correctness fix rather than a taste one (M76)
 *
 * `fontFamily: 'monospace'` is whatever the phone calls monospace — Roboto Mono on a stock
 * Android — and it does not contain the characters a terminal spends most of its time drawing.
 * Box drawing, braille, the arrows and the check marks all fall through to a *different* face,
 * chosen per glyph by the system, with a different advance. So a display line of `budget`
 * characters that `wrap` had measured as fitting was physically wider than the screen, and
 * `numberOfLines={1}` ellipsised it: a Claude pane's input box arrived as two long rules each
 * ending in `…`, and the thing somebody had opened their phone to read was the part that got
 * cut. The Cyrillic in the same screenshot wrapped perfectly, which is why it took a picture of
 * a real session to see at all.
 *
 * [Adwaita Mono](https://gitlab.gnome.org/GNOME/adwaita-fonts) (Iosevka-derived, OFL) carries
 * every one of them at **one** advance — 600 units of a 1000-unit em, which is where the `0.6`
 * in the budget comes from and it is now a measurement rather than a guess. All four faces are
 * bundled and selected by name, because a style Android cannot find a file for is a style it
 * substitutes from the system, which is the same bug through the other door: an italic run in a
 * face with a different advance walks the rest of the line out of the grid.
 */
import { memo, useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { Keyboard, ScrollView, Text, View, type TextStyle } from 'react-native'
import type { ScreenColor, StyleRun } from '../../protocol/generated'
import {
  FOLLOWING,
  grabbed,
  moved,
  remainingOf,
  settled,
  wheelAtEdge,
  type Follow,
} from '../follow'
import type { RowStore } from '../rowStore'
import type { ScreenStore } from '../screenStore'
import { wrap } from '../wrap'
import { shapeRow } from '../frame'

/**
 * The bundled grid font, by style. See the header — every face here has the same advance, and a
 * face that is *not* here is chosen by the system, which does not.
 *
 * Android resolves these names from `android/app/src/main/assets/fonts/<name>.ttf`.
 */
export const FACES = {
  regular: 'AdwaitaMono-Regular',
  bold: 'AdwaitaMono-Bold',
  italic: 'AdwaitaMono-Italic',
  boldItalic: 'AdwaitaMono-BoldItalic',
} as const

/** Ratio of one character's advance to the font size, for every face above. */
export const ADVANCE = 0.6

function faceFor(bold: boolean, italic: boolean): string {
  if (bold && italic) return FACES.boldItalic
  if (bold) return FACES.bold
  if (italic) return FACES.italic
  return FACES.regular
}

/** Attribute bits, as `cide_ipc::screen::flags` numbers them. */
const BOLD = 1 << 0
const DIM = 1 << 1
const ITALIC = 1 << 2
const UNDERLINE = 1 << 3
const INVERSE = 1 << 4

/**
 * The palette, chosen for a five-inch screen rather than copied from the desktop.
 *
 * cide sends an *index*, never a resolved colour, precisely so this can be different: a terminal
 * read at arm's length in daylight wants more contrast than one read at a desk.
 */
const PALETTE: readonly string[] = [
  '#1c1f24', '#ff6b6b', '#5ee08a', '#ffd166', '#6db3ff', '#d78bff', '#5fd7d7', '#c9d1d9',
  '#4b525c', '#ff8787', '#89f0ab', '#ffe08a', '#9fcbff', '#e3adff', '#8ce8e8', '#f0f6fc',
]
const FG = '#c9d1d9'
/** What a border with no colour of its own is drawn in. */
const RULE_INK = '#30363d'
const BG = '#0d1117'

function colour(value: ScreenColor | undefined, fallback: string): string {
  if (value === undefined) return fallback
  if (value.kind === 'idx') return PALETTE[value.index] ?? fallback
  return `rgb(${value.r},${value.g},${value.b})`
}

function styleOf(run: StyleRun, fontSize: number): TextStyle {
  const flags = run.flags ?? 0
  const inverse = (flags & INVERSE) !== 0
  const fg = colour(run.fg, FG)
  const bg = colour(run.bg, BG)
  const bold = (flags & BOLD) !== 0
  return {
    color: inverse ? bg : fg,
    // A background is only drawn when there is one to draw: a span with `backgroundColor` set to
    // the page colour still costs a native layer.
    ...(inverse || run.bg !== undefined ? { backgroundColor: inverse ? fg : bg } : {}),
    // Weight and slope are a **face**, never `fontWeight`/`fontStyle`: Android does not
    // synthesise either for a custom family, and asking silently substitutes a system face with
    // a different advance. Bold also keeps its lift in colour, because a bold face alone is a
    // weak signal at nine points on a phone.
    fontFamily: faceFor(bold, (flags & ITALIC) !== 0),
    ...(bold ? { color: inverse ? bg : '#ffffff' } : {}),
    ...((flags & DIM) !== 0 ? { opacity: 0.6 } : {}),
    ...((flags & UNDERLINE) !== 0 ? { textDecorationLine: 'underline' as const } : {}),
    fontSize,
  }
}

interface LineProps {
  runs: readonly StyleRun[]
  fontSize: number
  lineHeight: number
  /** Characters per display line, or `null` to draw the row at its full width. */
  budget: number | null
}

/**
 * One row's worth of runs, wrapped if asked and drawn.
 *
 * Shared by the live grid and the scrollback rather than written twice, because the two must
 * lay a line out identically: history sits directly above the viewport in the same scroller, and
 * a wrap rule or a line height that differed by a pixel would show up as a seam exactly where
 * the eye is following the text across.
 */
export const Line = memo(function Line({ runs, fontSize, lineHeight, budget }: LineProps) {
  // A box is decided before it is re-flowed — `frame.ts` carries the whole argument, and the
  // short version is that seven display lines of wrapped `─` are not a rectangle.
  const shaped = shapeRow(runs, budget !== null)
  if (shaped.kind === 'rule') {
    return (
      <View style={{ height: lineHeight, justifyContent: 'center' }}>
        {/* Through the one palette, so a border keeps whatever colour it was drawn in. */}
        <View style={{ height: 1, backgroundColor: colour(shaped.color, RULE_INK) }} />
      </View>
    )
  }

  const lines = budget === null ? [shaped.runs] : wrap(shaped.runs, budget)
  const body = lines.map((line, index) => (
    <Text
      key={index}
      allowFontScaling={false}
      numberOfLines={1}
      style={
        {
          height: lineHeight,
          lineHeight,
          fontFamily: FACES.regular,
          includeFontPadding: false,
        } as TextStyle
      }
    >
      {line.map((run, i) => (
        <Text key={i} allowFontScaling={false} style={styleOf(run, fontSize)}>
          {run.text}
        </Text>
      ))}
    </Text>
  ))

  // What the two stripped verticals become: the side of the box, as one border rather than as a
  // character at each end of every display line.
  if (shaped.fenced) {
    return (
      <View style={{ borderLeftWidth: 1, borderColor: RULE_INK, paddingLeft: 6 }}>{body}</View>
    )
  }
  return <>{body}</>
})

interface RowProps {
  store: RowStore
  fontSize: number
  lineHeight: number
  budget: number | null
}

/**
 * One live row.
 *
 * `memo` plus its own subscription is the whole performance story: the parent's props for this
 * row never change, so it re-renders when *its* store fires and at no other time.
 */
const Row = memo(function Row({ store, fontSize, lineHeight, budget }: RowProps) {
  const runs = useSyncExternalStore(store.subscribe, store.getSnapshot)
  return <Line runs={runs} fontSize={fontSize} lineHeight={lineHeight} budget={budget} />
})

export interface ScreenViewProps {
  screen: ScreenStore
  fontSize: number
  /** Re-flow long rows to the device's width instead of panning. */
  wrapped: boolean
  width: number
  /**
   * Drawn directly above the live grid, inside the same scroller.
   *
   * A render prop rather than a node, because whatever goes up there has to lay its text out on
   * exactly the grid this component computes — the scrollback does — and a second place working
   * out the line height from the font size is a second place to get it a pixel wrong.
   */
  above?: (metrics: { fontSize: number; lineHeight: number; budget: number | null }) => ReactNode
  /**
   * The reader is within a screen or two of the top, and whatever is drawn `above` should fetch
   * more of itself.
   *
   * Called on every qualifying scroll event rather than on the edge of one, because the caller
   * is the only thing that knows whether a fetch is already outstanding — `HistoryStore.begin`
   * is that guard, and a second one here would be a second answer to the same question.
   */
  onNearTop?: () => void
  /**
   * The reader has pulled past an edge of a screen the **program** owns, and it should scroll.
   *
   * Offered only where the child has asked for mouse reports — a wheel sent anywhere else
   * arrives as typed characters, which is cide's refusal to make rather than this component's,
   * but there is no reason to ask for one that will be refused.
   */
  onWheel?: (lines: number) => void
}

export function ScreenView({
  screen,
  fontSize,
  wrapped,
  width,
  above,
  onNearTop,
  onWheel,
}: ScreenViewProps) {
  // The geometry, and only the geometry, re-renders this component.
  const info = useSyncExternalStore(
    (listener) => screen.subscribeGeometry(listener),
    () => screen.info,
  )

  /**
   * Whether new content should scroll the view, and whether the reader is driving.
   *
   * A ref and not state: it is read inside a layout callback and setting it must not re-render
   * the grid. `follow.ts` holds the rule and the bug it prevents — being yanked back to the end
   * while reading is worse than missing a line, and *deciding you are being read somewhere else
   * because two hundred lines of scrollback just arrived* is worse than either.
   */
  const follow = useRef<Follow>(FOLLOWING)
  /** When the last wheel went out, so a held finger is steady motion and not a flood. */
  const wheeledAt = useRef(0)
  const scroller = useRef<ScrollView>(null)

  /*
   * The keyboard coming up is a resize, and a resize is not a scroll. (M76)
   *
   * Tapping the input halves the viewport; the content does not change, so neither
   * `onContentSizeChange` nor — reliably, on Android under `adjustResize` — `onLayout` fires with
   * the final height. The view therefore stayed where it was, which put the console's own input
   * line behind the keyboard: you could type, and you could not see what you were typing, which
   * is the one thing a terminal has to show. Two frames after the event, because the layout pass
   * that shortens the scroller runs after `keyboardDidShow` on Android and `scrollToEnd` before
   * it scrolls to the *old* end.
   */
  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', () => {
      if (!follow.current.stuck) return
      requestAnimationFrame(() =>
        requestAnimationFrame(() => scroller.current?.scrollToEnd({ animated: false })),
      )
    })
    return () => shown.remove()
  }, [])

  const lineHeight = Math.round(fontSize * 1.25)
  // The bundled face's own advance, so this is exact rather than empirical — and it is exact for
  // every character in the row, which is the property the bundle was for.
  const advance = fontSize * ADVANCE
  const budget = wrapped ? Math.max(8, Math.floor(width / advance)) : null

  if (info === null) {
    return (
      <View style={{ padding: 16 }}>
        <Text style={{ color: '#8b949e' }}>Waiting for the first frame…</Text>
      </View>
    )
  }

  const rows = Array.from({ length: info.rows }, (_, i) => i)
  const grid = (
    <View style={{ backgroundColor: BG, paddingVertical: 8 }}>
      {rows.map((index) => {
        const store = screen.row(index)
        if (store === undefined) return null
        return (
          <Row
            key={index}
            store={store}
            fontSize={fontSize}
            lineHeight={lineHeight}
            budget={budget}
          />
        )
      })}
    </View>
  )

  const body = (
    <View>
      {above?.({ fontSize, lineHeight, budget })}
      {grid}
    </View>
  )

  // Panning keeps the columns exact, which is what a TUI needs; wrapping keeps the text
  // readable, which is what a Claude pane needs. Neither is right for both.
  //
  // The *vertical* scroller is the outer one either way, and it is the one that follows the
  // output: a horizontal scroller nested inside it pans, and telling that one to scroll to the
  // end would send the view sideways.
  return (
    <ScrollView
      ref={scroller}
      style={{ backgroundColor: BG }}
      /*
       * Anchor the reader to the line they are looking at, not to a pixel offset.
       *
       * Two different things move content out from under a finger here: a page of scrollback
       * prepended above the viewport, and the live rows below changing height as the terminal
       * repaints — a row that was three wrapped display lines becomes one when its trailing
       * padding goes, and every pixel offset below it is then wrong. Without this the reader is
       * dragged up or down by output they are not even looking at, which reads exactly like
       * scrolling being broken.
       *
       * `minIndexForVisible: 0` because everything in this scroller is one column of text and
       * the first visible row is the one to hold still. It is also what makes fetching earlier
       * lines *while scrolling* possible at all: `History.tsx`'s header argued for a button
       * precisely because a prepend used to move the view, and this is the answer to that.
       */
      maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
      scrollEventThrottle={64}
      // The four gesture edges, because a drag and its momentum are one act and either half can
      // be the last thing that happens: a slow release ends at `onScrollEndDrag` with no
      // momentum at all, and a fling ends well after it.
      onScrollBeginDrag={() => {
        follow.current = grabbed(follow.current)
      }}
      onScroll={(event) => {
        const remaining = remainingOf(event.nativeEvent)
        follow.current = moved(follow.current, remaining)
        const { contentOffset, layoutMeasurement } = event.nativeEvent
        // Two screens of warning, so the page has arrived by the time the reader gets there.
        if (contentOffset.y < layoutMeasurement.height * 2) onNearTop?.()
        // And, for a screen the program owns, pulling past an edge asks *it* to scroll.
        if (onWheel !== undefined && info !== null && info.mouse !== 'off') {
          const now = Date.now()
          const lines = wheelAtEdge({
            offsetY: contentOffset.y,
            remaining,
            driving: follow.current.driving,
            now,
            lastAt: wheeledAt.current,
          })
          if (lines !== 0) {
            wheeledAt.current = now
            onWheel(lines)
          }
        }
      }}
      onScrollEndDrag={(event) => {
        follow.current = settled(remainingOf(event.nativeEvent))
      }}
      onMomentumScrollBegin={() => {
        follow.current = grabbed(follow.current)
      }}
      onMomentumScrollEnd={(event) => {
        follow.current = settled(remainingOf(event.nativeEvent))
      }}
      onContentSizeChange={() => {
        if (follow.current.stuck) scroller.current?.scrollToEnd({ animated: false })
      }}
      // Opening a console lands at the end, whatever the content did on the way there. The
      // size change above is what normally does it; this is the one that covers a first layout
      // where the content is already its final height, which is every console with no scrollback
      // to fetch — there is no *change* to react to, so nothing would have scrolled at all.
      onLayout={() => {
        if (follow.current.stuck) scroller.current?.scrollToEnd({ animated: false })
      }}
    >
      {wrapped ? (
        body
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator>
          {body}
        </ScrollView>
      )}
    </ScrollView>
  )
}
