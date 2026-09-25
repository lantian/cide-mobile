/**
 * Swipe left or right to move between the project chips. (M91)
 *
 * The chips sit at the top of a screen that is mostly a long list, so reaching them with a
 * thumb means scrolling back up. A horizontal swipe anywhere on the list does what tapping the
 * neighbouring chip would — it goes through `projectChoice`, so every screen and the chip row
 * agree about where it landed.
 *
 * Horizontal only, and only once it is plainly horizontal: `activeOffsetX` waits for 24 points
 * sideways before claiming the touch, and `failOffsetY` gives up after 14 points of vertical
 * travel. Without that pair a slightly diagonal scroll of a list changed project, and
 * pull-to-refresh became a coin toss. Not used on the console screen, where a sideways drag
 * pans a wide terminal.
 *
 * `runOnJS(true)`: this app has no Reanimated, and the handlers only choose a project.
 */
import type { ReactNode } from 'react'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import * as choice from '../store/projectChoice'
import type { RemoteProject } from '../protocol/generated'

/** How far, or how fast, a swipe has to go to count. */
const DISTANCE = 60
const VELOCITY = 500

export function ProjectSwipe({
  iid,
  projects,
  chosen,
  children,
}: {
  iid: string
  projects: readonly RemoteProject[]
  chosen: string | null
  children: ReactNode
}) {
  const pan = Gesture.Pan()
    .runOnJS(true)
    .enabled(projects.length >= 2)
    .activeOffsetX([-24, 24])
    .failOffsetY([-14, 14])
    .onEnd((event) => {
      const far = Math.abs(event.translationX) >= DISTANCE
      const fast = Math.abs(event.velocityX) >= VELOCITY
      if (!far && !fast) return
      // A finger moving left turns to the next chip, as a page does.
      const dir = event.translationX < 0 ? 1 : -1
      const next = choice.nextChoice(projects, chosen, dir)
      if (next !== undefined) choice.choose(iid, next)
    })
  return <GestureDetector gesture={pan}>{children}</GestureDetector>
}
