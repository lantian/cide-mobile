/**
 * Turning what a soft keyboard did into keys.
 *
 * React Native has no keyboard event model worth the name: `onKeyPress` fires unreliably on
 * Android, because Gboard *composes* text rather than emitting keys. So the source of truth is
 * the **delta** — what the input's value was, and what it is now — and this is the pure function
 * that reads one.
 *
 * The value is held at a fixed pad of spaces so a backspace at "empty" still produces a change.
 * Without it the first backspace of a line is indistinguishable from nothing happening.
 */
import type { KeyEvent } from '../protocol/generated'

/**
 * The pad the field holds when nothing has been typed.
 *
 * It exists so a backspace at "empty" still produces a change: without it the first backspace of
 * a line is indistinguishable from nothing happening. Four spaces is plenty, because the field is
 * **topped back up** the moment a delete eats into it — see [`afterChange`] — rather than being
 * a reservoir that has to outlast a burst.
 */
export const PAD = '    '

export interface Delta {
  /** Characters typed, in order. */
  readonly inserted: string
  /** How many backspaces. */
  readonly deleted: number
}

/** What changed between two values of the hidden input. */
export function delta(before: string, after: string): Delta {
  let shared = 0
  while (shared < before.length && shared < after.length && before[shared] === after[shared]) {
    shared++
  }
  return { inserted: after.slice(shared), deleted: before.length - shared }
}

/**
 * The key events a delta means.
 *
 * A multi-character insert is **not** N key events. It is a paste — which a terminal genuinely
 * treats differently, because a program that asked for bracketed paste reads the markers to tell
 * typed text from pasted, and a TUI's own paste detection eats a submit that arrives in the same
 * chunk. The caller sends it as a paste frame.
 */
export function keysFor(d: Delta): { keys: KeyEvent[]; paste: string | null } {
  const keys: KeyEvent[] = []
  for (let i = 0; i < d.deleted; i++) keys.push({ key: { k: 'backspace' } })

  const graphemes = [...d.inserted]
  if (graphemes.length > 1) return { keys, paste: d.inserted }
  for (const char of graphemes) {
    if (char === '\n') keys.push({ key: { k: 'enter' } })
    else keys.push({ key: { k: 'char' }, text: char })
  }
  return { keys, paste: null }
}

/**
 * What one change of the hidden field means, and what to put back in it. (M76)
 *
 * # The race this replaces
 *
 * The field used to be reset to a fresh pad after **every** keystroke, and the next change was
 * diffed against the pad that had been *asked for*. A controlled `TextInput` is updated
 * asynchronously, so any change event that arrived before the reset landed was diffed against the
 * wrong baseline — and the diff of a stale baseline against a growing string is a **prefix**.
 * Typing `hello` into a real device reached the far end as `hehehello`; the ancestor of that bug
 * is written up in this file's history as the `nextPad` dance, which this supersedes: it was
 * never really fixed — only made
 * rare enough to look fixed, until a soft keyboard committed a whole word at once.
 *
 * So nothing is ever diffed against a value that was requested. The baseline is **what was last
 * seen**, the field is allowed to keep what the user typed, and a value is forced back into it at
 * exactly two moments, both of them pauses: when a delete has eaten into the pad, and when the
 * caller submits. Neither can race a keystroke, because at both the user has nothing in flight.
 *
 * The side effect is that the field now *shows* what was typed, which is the other half of the
 * complaint this came from: a box that wipes itself on every character gives a person no way to
 * see what they have written. The terminal still echoes it — that is where the truth is — but the
 * two now agree instead of one of them being blank.
 */
export interface Changed {
  readonly keys: readonly KeyEvent[]
  readonly paste: string | null
  /**
   * What the field must now be rendered with, and the baseline for the next change.
   *
   * **One value for both**, and that is the whole safety of this design. The field is controlled,
   * so whatever the caller renders *is* what it holds: rendering anything other than what was
   * just seen puts the characters back and makes the next diff a lie. The first cut of this left
   * the value prop alone for an ordinary keystroke — "leave it exactly as the user left it" —
   * and React dutifully restored the pad after every character, so each one arrived as a
   * backspace and a letter and `abcd` reached the far end as `d`.
   *
   * It differs from `next` in exactly one case, [`PAD`]'s: a delete has eaten into the pad, and
   * the field is topped back up so the *next* backspace is still a change. That is a pause, so
   * forcing a value there cannot race a keystroke.
   */
  readonly seen: string
}

export function afterChange(seen: string, next: string): Changed {
  const { keys, paste } = keysFor(delta(seen, next))
  return { keys, paste, seen: next.length < PAD.length ? PAD : next }
}

/** One button on the bar. */
export interface BarKey {
  readonly label: string
  readonly key: KeyEvent
  /**
   * A **page of the view**, not a keystroke: up (`-1`) or down (`1`).
   *
   * PgUp/PgDn used to be `ESC[5~`/`ESC[6~` sent to the program, which a shell's readline ignores
   * and which scrolled neither the desk's terminal nor the phone — the "sometimes it works" was
   * a full-screen program that happened to handle the key. Now they scroll what is being looked
   * at, on both ends: see `scrollView` in cide's `remote.rs`.
   */
  readonly page?: 1 | -1
}

/** What the key bar offers, in the order it draws them. */
export const KEY_BAR: readonly BarKey[] = [
  // First, because on a phone they are the ones reached for most: reading back is most of what
  // anybody does with a console they did not start.
  { label: 'pgup', key: { key: { k: 'pageUp' } }, page: -1 },
  { label: 'pgdn', key: { key: { k: 'pageDown' } }, page: 1 },
  { label: 'esc', key: { key: { k: 'escape' } } },
  { label: 'tab', key: { key: { k: 'tab' } } },
  /*
   * A newline *inside* the prompt, which the send button cannot give you. (M76)
   *
   * Enter submits — that is the whole point of the button beside the field — so on a phone there
   * was no way at all to write a second line, and a multi-line message to an agent is the
   * ordinary case rather than an advanced one.
   *
   * Shift+Enter, because `cide_remote::keys` encodes it as **`ESC CR`** and not as the modern
   * `CSI 13;2u` — that module's header carries the argument, and `ESC CR` is exactly what
   * Claude Code's own `/terminal-setup` teaches a terminal to send for this. In a shell it is
   * an ordinary meta-return, which readline ignores harmlessly. Where a program wants neither,
   * `\` then Enter still works and always has.
   */
  { label: '⇧⏎', key: { key: { k: 'enter' }, shift: true } },
  { label: '↑', key: { key: { k: 'up' } } },
  { label: '↓', key: { key: { k: 'down' } } },
  { label: '←', key: { key: { k: 'left' } } },
  { label: '→', key: { key: { k: 'right' } } },
  { label: 'home', key: { key: { k: 'home' } } },
  { label: 'end', key: { key: { k: 'end' } } },
]

/**
 * The Ctrl chords worth a button.
 *
 * Ctrl-C above all: it is the most important key in a terminal and the one a sticky-modifier
 * dance is most likely to get wrong under pressure.
 */
export const CTRL_BAR: readonly BarKey[] = (
  ['c', 'd', 'z', 'l', 'r', 'a', 'e', 'k', 'u', 'w'] as const
).map((letter) => ({
  label: `^${letter.toUpperCase()}`,
  key: { key: { k: 'char' }, text: letter, ctrl: true },
}))
