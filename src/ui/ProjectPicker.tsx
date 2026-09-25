/**
 * Which project a screen is showing. (M75)
 *
 * A row of chips rather than a dropdown, for two reasons that only apply on a phone. A machine
 * has a handful of open projects, not a hundred, so the whole set fits — and a chip row shows
 * *what the alternatives are* without a tap, where a dropdown shows only the current value and
 * makes "is there another project?" a question you have to open something to answer.
 *
 * It renders nothing at all below two projects. A control with one option is furniture that says
 * "you could be choosing something here" while offering no choice, and the screens behind it
 * read identically with and without it.
 */
import { useEffect, useRef } from 'react'
import { Pressable, Text } from 'react-native'
// Gesture-handler's scroller, not React Native's: it is a native gesture `ProjectSwipe` can see,
// so dragging a long row of chips scrolls the row instead of changing project. (M91)
import { ScrollView } from 'react-native-gesture-handler'
import type { RemoteProject } from '../protocol/generated'
import { T } from './theme'
import { Dot } from './Badge'

export function ProjectPicker({
  projects,
  chosen,
  waiting,
  onChoose,
}: {
  projects: readonly RemoteProject[]
  /** `null` is every project. */
  chosen: string | null
  /** How many sessions are waiting on the user, per project. */
  waiting?: Readonly<Record<string, number>>
  onChoose: (project: string | null) => void
}) {
  // The chosen chip is brought into view — a swipe can land on one scrolled off the edge, and a
  // choice nobody can see made reads as the swipe having done nothing.
  const row = useRef<ScrollView>(null)
  const offsets = useRef(new Map<string, number>())
  const key = chosen ?? ''
  useEffect(() => {
    const x = offsets.current.get(key)
    if (x !== undefined) row.current?.scrollTo({ x: Math.max(0, x - 24), animated: true })
  }, [key])

  if (projects.length < 2) return null

  return (
    <ScrollView
      ref={row}
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 8, paddingVertical: 2 }}
    >
      <Chip
        label="All"
        onX={(x) => offsets.current.set('', x)}
        active={chosen === null}
        marked={Object.values(waiting ?? {}).some((n) => n > 0)}
        onPress={() => onChoose(null)}
      />
      {projects.map((project) => (
        <Chip
          key={String(project.id)}
          label={project.name}
          onX={(x) => offsets.current.set(String(project.id), x)}
          active={chosen === String(project.id)}
          marked={(waiting?.[String(project.id)] ?? 0) > 0}
          onPress={() => onChoose(String(project.id))}
        />
      ))}
    </ScrollView>
  )
}

function Chip({
  label,
  active,
  marked,
  onPress,
  onX,
}: {
  label: string
  active: boolean
  marked: boolean
  onPress: () => void
  /** Where the chip sits in the row, for bringing the chosen one into view. */
  onX: (x: number) => void
}) {
  return (
    <Pressable
      onPress={onPress}
      onLayout={(event) => onX(event.nativeEvent.layout.x)}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        paddingVertical: 7,
        paddingHorizontal: 14,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: active ? T.accent : T.border,
        backgroundColor: active ? T.accent : 'transparent',
      }}
    >
      <Text style={{ color: active ? '#06121f' : T.dim, fontSize: 13 }}>{label}</Text>
      {/* The same dot as everywhere else. A chip has no room for a number, and the question a
          chip answers is "is anything over there", not "how much". */}
      <Dot on={marked} />
    </Pressable>
  )
}
