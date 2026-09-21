/**
 * Who wrote a comment, and what colour to draw their name in. (M76)
 *
 * The same two rules cide's `AgentsPanel/model.ts` uses, restated here rather than shared: the
 * panel's versions answer `var(--agent-blue)`, a CSS custom property resolved out of whichever
 * theme is on, and a phone has no such thing. What crosses is the *rule*, not the value — and
 * the rule is what has to match, because a person reads the same conversation on both screens and
 * a role that is cyan in the panel and pink on the phone is two roles as far as the eye is
 * concerned.
 *
 * # The derivation is the point, not a fallback
 *
 * A role that declares no colour is coloured from a hash of its **id**, which is FNV-1a over the
 * code units and is identical in both implementations by construction. So nothing has to be
 * stored, a role invented this morning is already distinguishable, and the wire carries only the
 * one fact a device could not work out for itself — [`RemoteAgent::color`], the *name* of a
 * declared hue.
 *
 * The id rather than the label, deliberately, and cide's `agentColor` carries the argument:
 * `TaskAuthor.agent.label` is copied at write time so an old comment still reads correctly after
 * a rename, and colouring by it would mean a role's own comments changed colour halfway down a
 * log the day somebody edited `label:`.
 *
 * React-free, so `test/agents.test.ts` can drive it.
 */
import type { TaskAuthor } from '../protocol/generated'

/**
 * The eight hues, in cide's order — the order is load-bearing, since it is what the hash indexes.
 *
 * The values are cide's **dark** theme (`tokens.css`), because this app is dark and says so in
 * `app.json`. If it ever grows a light mode these become a pair, exactly as they are there.
 */
export const AGENT_HUES = {
  blue: '#7aa2f7',
  green: '#8fbf7a',
  orange: '#e08a4c',
  purple: '#bb9af7',
  cyan: '#5fd4d0',
  red: '#f07178',
  yellow: '#d9c86a',
  pink: '#f094c8',
} as const

const ORDER = Object.keys(AGENT_HUES) as (keyof typeof AGENT_HUES)[]

/**
 * The orchestrator's colour: a slate, not a ninth hue.
 *
 * cide's token is at least 100 redmean units from all eight, where the eight are 70 from each
 * other, so *"not one of the agents"* reads as a different kind of colour rather than as the next
 * one along. Copied rather than re-derived for the same reason as the table above.
 */
export const ORCHESTRATOR_COLOR = '#9aa5b8'

/** A role's colour: its declared hue if it named one of the eight, otherwise one from its id. */
export function agentColor(id: string, declared: string | null = null): string {
  const named = declared === null ? null : declared.trim().toLowerCase()
  if (named !== null && named in AGENT_HUES) return AGENT_HUES[named as keyof typeof AGENT_HUES]
  let hash = 0x811c9dc5
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i)
    // FNV's 32-bit prime, as the shifts a 32-bit `Math.imul` would cost a polyfill for.
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0
  }
  const hue = ORDER[hash % ORDER.length] ?? 'blue'
  return AGENT_HUES[hue]
}

/**
 * The name to draw.
 *
 * `label` before `agent`, and a word before neither: a comment whose role has been deleted still
 * has a name in it, and one written by a build that did not copy the label still has an id.
 */
export function authorLabel(author: TaskAuthor): string {
  if (author.kind === 'user') return 'You'
  if (author.kind === 'orchestrator') return 'Orchestrator'
  if (author.label.trim() !== '') return author.label
  return author.agent.trim() !== '' ? author.agent : 'Agent'
}

/**
 * The colour to draw it in, or `null` for the user.
 *
 * `null` rather than an accent value, so the caller keeps its own: *"You"* is a flourish, not a
 * signal — a reader is never in doubt about which lines are their own — and it is the one arm
 * that is deliberately outside the separation the eight hues are chosen for.
 *
 * `colors` is the roster's declared hues by role id. A role it has never heard of falls through
 * to the id alone, which is the right answer for a comment written by a role that has since been
 * deleted — and is why the id is passed rather than only looked up.
 */
export function authorColor(
  author: TaskAuthor,
  colors: Readonly<Record<string, string>> = {},
): string | null {
  if (author.kind === 'orchestrator') return ORCHESTRATOR_COLOR
  if (author.kind !== 'agent') return null
  const id = String(author.agent)
  if (id.trim() === '') return null
  return agentColor(id, colors[id] ?? null)
}

/**
 * A comment's time, as a person reads it: 24-hour, and the date only when it is not today.
 *
 * Twenty-four hours because cide's own log card is, and because the one question a timestamp on a
 * console answers — *is this the run I am watching* — is answered badly by a clock that repeats
 * itself twice a day. The date is dropped for today's comments so a conversation that happened
 * this afternoon reads as times rather than as a column of the same date.
 */
export function commentTime(atUnixMs: number, now: number = Date.now()): string {
  const at = new Date(atUnixMs)
  const clock = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  const today = new Date(now)
  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate()
  if (sameDay) return clock
  const date = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
  return `${date} ${clock}`
}
