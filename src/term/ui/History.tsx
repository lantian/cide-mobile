/**
 * What scrolled off the top of the session, drawn above what did not. (M76)
 *
 * It lives inside the live screen's scroller rather than in a mode of its own, because the
 * gesture somebody makes when they want it is *scroll up* — not *find the history button, read,
 * find the live button*. One column of text, the oldest at the top, the viewport at the bottom,
 * and a button above the oldest line that fetches the page before it.
 *
 * The button is deliberate rather than an `onScroll` threshold. Prepending to a React Native
 * `ScrollView` does not move `contentOffset`, so content loaded at the top slides *under* the
 * reader and the view has to be corrected by exactly the height of what arrived — which, with
 * wrapping on, is not a number this component knows. A tap that lands the reader at the top of
 * the block they asked for is honest about that and behaves the same every time.
 */
import { Pressable, Text, View } from 'react-native'
import { Line } from './Screen'
import type { History } from '../history'
import { T } from '../../ui/theme'

export interface HistoryViewProps {
  history: History
  fontSize: number
  lineHeight: number
  budget: number | null
  /** Ask for the page before the oldest line held. `null` when there is none. */
  onEarlier: (() => void) | null
  /**
   * Is the console on the **alternate screen**? (M76)
   *
   * Because that decides which of two very different sentences is true when there is nothing
   * above the viewport. A shell with no scrollback simply has not printed a screenful yet. A
   * program holding the alternate screen — `claude` does, measured: `ESC[?1049h` on startup —
   * has no scrollback *by construction*, since the alternate screen is the one the terminal
   * keeps no history for. Telling somebody "nothing has scrolled off yet" about a session with
   * an hour of conversation in it is worse than saying nothing at all.
   */
  alt: boolean
}

export function HistoryView({
  history,
  fontSize,
  lineHeight,
  budget,
  onEarlier,
  alt,
}: HistoryViewProps) {
  // Nothing above the live screen, and the reason is worth a sentence. (M76)
  //
  // Drawing nothing here is the same class of answer as an empty list: a reader who scrolls up,
  // finds the top of the viewport and stops has been told that scrolling is broken. `depth` is
  // cide's own count of what it still keeps for this console, and zero is a real state — a
  // console that has printed less than a screenful, or one whose program holds the terminal
  // without ever scrolling it. Said once it is known, never while the first page is in flight,
  // which is what `loading` distinguishes.
  if (history.lines.length === 0 && !history.loading) {
    if (history.depth > 0) return null
    return (
      <View style={{ paddingTop: 10, paddingBottom: 6, paddingHorizontal: 16 }}>
        <Text style={{ color: T.dim, fontSize: 12, textAlign: 'center' }}>
          {alt
            ? 'This program draws its own screen, so the terminal keeps no history for it. Scroll it from the machine.'
            : 'Nothing has scrolled off this console yet.'}
        </Text>
      </View>
    )
  }
  return (
    <View style={{ paddingTop: 8 }}>
      <View style={{ alignItems: 'center', paddingVertical: 6 }}>
        {history.loading ? (
          <Text style={{ color: T.dim, fontSize: 12 }}>Reading earlier lines…</Text>
        ) : onEarlier !== null ? (
          <Pressable
            onPress={onEarlier}
            style={{
              paddingHorizontal: 14,
              paddingVertical: 7,
              borderRadius: 7,
              borderWidth: 1,
              borderColor: T.border,
            }}
          >
            <Text style={{ color: T.accent, fontSize: 13 }}>Load earlier lines</Text>
          </Pressable>
        ) : (
          // Said out loud, because a column of text that simply stops is indistinguishable from
          // one that is still loading.
          <Text style={{ color: T.dim, fontSize: 12 }}>The start of what cide still keeps</Text>
        )}
      </View>

      {history.lines.map((line, index) => (
        <Line
          key={history.from + index}
          runs={line.runs}
          fontSize={fontSize}
          lineHeight={lineHeight}
          budget={budget}
        />
      ))}

      {/* The seam between what has scrolled away and what is on the desktop's screen right now.
          Without it the join is invisible, and the live grid's blank rows read as a gap in the
          transcript rather than as the bottom of a terminal. */}
      <View
        style={{
          borderBottomWidth: 1,
          borderColor: T.border,
          marginTop: 6,
          marginHorizontal: 8,
        }}
      />
    </View>
  )
}
