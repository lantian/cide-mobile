/**
 * Which project each instance's screens are showing. (M75)
 *
 * Module-level rather than component state, because the choice has to outlive the screen: pick a
 * project on Agents, go back, open Tasks, and it is still that project. Holding it in either
 * screen would make the two disagree about what you are looking at, which is the same failure
 * the per-project frames were keyed to prevent one layer down.
 *
 * Not persisted to disk, and that is deliberate. A project can be closed on the machine between
 * one launch and the next, and a remembered choice pointing at a project that is no longer open
 * is a screen that says "nothing here" about a machine that is busy. `resolve` treats an unknown
 * choice as *all*, so the worst a stale one can do is show more than was asked.
 */

/** `null` is every project, which is the honest default before anything is chosen. */
type Choice = string | null

const chosen = new Map<string, Choice>()
const listeners = new Set<() => void>()

/** Rebuilt on change and handed out by identity — `useSyncExternalStore` compares with `Object.is`. */
let snapshot: Readonly<Record<string, Choice>> = {}

function announce(): void {
  snapshot = Object.fromEntries(chosen)
  for (const listener of listeners) listener()
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getSnapshot(): Readonly<Record<string, Choice>> {
  return snapshot
}

export function choose(instanceId: string, project: Choice): void {
  if (chosen.get(instanceId) === project) return
  chosen.set(instanceId, project)
  announce()
}

/** Forget an instance's choice, when the instance itself is forgotten. */
export function drop(instanceId: string): void {
  if (!chosen.has(instanceId)) return
  chosen.delete(instanceId)
  announce()
}

/**
 * The chosen project, if it is still open.
 *
 * A choice naming a project the machine has since closed resolves to *all* rather than to
 * itself: the alternative is a screen filtering on an id nothing matches, which renders as an
 * empty list and reads as "this machine has nothing" — the one wrong answer that looks like a
 * right one.
 */
export function resolve(
  instanceId: string,
  open: readonly { id: unknown }[],
  choices: Readonly<Record<string, Choice>> = snapshot,
): Choice {
  const choice = choices[instanceId] ?? null
  if (choice === null) return null
  return open.some((project) => String(project.id) === choice) ? choice : null
}

/**
 * Everything from a per-project map, for one project or for all of them.
 *
 * The flattening is here rather than in each screen so all three flatten identically — three
 * spellings of "and now for every project" is how one of them ends up showing a project the
 * others do not.
 */
export function forProject<T>(
  byProject: Readonly<Record<string, readonly T[]>>,
  project: Choice,
): T[] {
  if (project !== null) return [...(byProject[project] ?? [])]
  return Object.values(byProject).flat()
}

/**
 * The choice one swipe lands on. (M91)
 *
 * The chips' own order — *All*, then each project as the machine lists them — so a swipe moves
 * to the chip beside the lit one and never somewhere the row does not show. A swipe to the
 * **left** (`1`) is the next chip, the way a page turns; it stops at either end rather than
 * wrapping, because a wrap is a jump from the last project to *All* that nobody could see
 * coming. `null` from a machine with fewer than two projects, which draws no chips at all.
 */
export function nextChoice(
  open: readonly { id: unknown }[],
  current: Choice,
  dir: 1 | -1,
): Choice | undefined {
  if (open.length < 2) return undefined
  const order: Choice[] = [null, ...open.map((project) => String(project.id))]
  const at = Math.max(0, order.indexOf(current))
  const next = at + dir
  if (next < 0 || next >= order.length) return undefined
  return order[next]
}
