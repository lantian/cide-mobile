/**
 * The unread marker, in one place. (M75)
 *
 * One component for every level it appears at — the machine in the list, the Consoles row inside
 * it, and the console itself — because a marker that looks different at each level does not read
 * as *the same thing, from further away*. Somebody scanning the list has to learn that the dot
 * on a machine and the dot on a console mean the same thing, and the cheapest way to teach that
 * is for them to be the same dot.
 *
 * It is deliberately **not** a general-purpose count. It means exactly one thing: this many
 * sessions have finished a turn and nobody has looked at them. That is the number cide keeps and
 * the one a notification was raised from, so a badge showing anything else here would be a
 * second answer to a question already answered.
 */
import { Text, View } from 'react-native'
import { T } from './theme'

export function Badge({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <View
      style={{
        minWidth: 22,
        height: 22,
        borderRadius: 11,
        paddingHorizontal: 7,
        backgroundColor: T.warn,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ color: '#06121f', fontSize: 12, fontWeight: '600' }}>
        {/* Capped, because the badge has to stay a badge. A three-digit count would widen the
            row and push the title it belongs to off the screen, and "a lot" is the only thing
            anybody reads past about nine anyway. */}
        {count > 9 ? '9+' : count}
      </Text>
    </View>
  )
}

/** The same signal where there is no room for a number. */
export function Dot({ on }: { on: boolean }) {
  if (!on) return null
  return <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: T.warn }} />
}
