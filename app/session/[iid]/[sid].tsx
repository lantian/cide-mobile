/**
 * One session: the terminal, a way to type into it, and the prompt card.
 *
 * # Three things happen on mount, in this order
 *
 *  1. **Acknowledge.** Opening a session here clears its *finished and not yet seen* mark — and
 *     clears it on the desktop too, because cide keeps one set and every surface reports into it.
 *     This is the feature, not a side effect.
 *  2. **Watch.** Nothing is read on the machine until a device asks; a list screen costs cide no
 *     grid walks at all.
 *  3. **Unwatch on leaving.** Same reason, the other way round.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import * as registry from '../../../src/store/registry'
import * as notify from '../../../src/notify/driver'
import { ScreenView } from '../../../src/term/ui/Screen'
import { HistoryView } from '../../../src/term/ui/History'
import { PAGE } from '../../../src/term/history'
import { CTRL_BAR, KEY_BAR, PAD, afterChange } from '../../../src/term/keys'
import { T } from '../../../src/ui/theme'
import { KindTile, look } from '../../../src/ui/Kind'
import type { KeyEvent, PermissionPrompt, SessionId } from '../../../src/protocol/generated'

const SIZES = [9, 10, 11, 12, 14] as const

export default function SessionScreen() {
  const { iid, sid, readOnly } = useLocalSearchParams<{
    iid: string
    sid: string
    readOnly?: string
  }>()
  /**
   * Watching a run's console without being able to type into it. (M75)
   *
   * An agent's log *is* its console — cide keeps one vt100 mirror per session and a run is a
   * session — so this is the same screen with its input taken away rather than a second way of
   * rendering the same bytes.
   *
   * Taken away rather than disabled: a disabled keyboard bar is a row of controls explaining
   * that they do nothing, and it costs the screen a third of its height on the one view whose
   * entire purpose is to show as many lines as possible. The guard is not cosmetic either —
   * an agent's console belongs to the agent, and a stray keystroke lands in whatever prompt
   * its harness is sitting at.
   */
  const watching = readOnly === '1'
  const { width } = useWindowDimensions()
  const [fontSize, setFontSize] = useState<number>(11)
  const [wrapped, setWrapped] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<TextInput>(null)
  /** What the field was last *seen* holding — never what it was asked to hold. `afterChange`. */
  const seen = useRef(PAD)
  // The field is **controlled**. It has to be: the only reliable way to put a value back into a
  // `TextInput` under the New Architecture is to render it, and this app runs bridgeless.
  const [pad, setPad] = useState(PAD)
  const seq = useRef(1)

  const screen = registry.screenOf(iid, sid)
  const history = registry.historyOf(iid, sid)
  const connection = registry.connectionOf(iid)
  const session = sid as SessionId

  const held = useSyncExternalStore(history.subscribe, history.getSnapshot)
  /** One seeding per visit. Without it the effect below asks again on every page that lands. */
  const seeded = useRef(false)

  const askPage = useCallback(
    (fromTop: number, rows: number) => {
      if (connection === undefined) return
      // `begin` is the guard as well as the flag: two taps, or a tap arriving while the seed is
      // still outstanding, would stitch two answers onto a `from` that moved between them.
      if (!history.begin()) return
      connection.tell({ t: 'scrollbackPage', session, fromTop, rows })
    },
    [connection, history, session],
  )

  useEffect(() => {
    seeded.current = false
    // How deep is it? The wire counts from the *oldest* line, so the newest page cannot be named
    // without knowing the depth first — and a page of no rows is how you ask, because every
    // answer carries the depth whether or not it carries anything else.
    askPage(0, 0)
  }, [askPage])

  useEffect(() => {
    if (seeded.current || held.loading || held.lines.length > 0) return
    if (held.depth <= 0) return
    seeded.current = true
    askPage(Math.max(0, held.depth - PAGE), PAGE)
  }, [askPage, held])

  // Read from the registry rather than held here: it arrives as its own frame at any moment, on
  // a socket that outlives this screen.
  const views = useSyncExternalStore(registry.subscribe, registry.getSnapshot)
  const view = views.find((v) => v.paired.instanceId === iid)
  const prompt: PermissionPrompt | null = view?.prompts[sid] ?? null
  // The row this console belongs to, for its name and its kind. Absent while the session list
  // is still arriving, and the header degrades to the generic word rather than to a blank.
  const row = view?.sessions.find((s) => String(s.session) === sid)
  const it = row === undefined ? null : look(row.kind, row.title)
  /*
   * Which project's console this is. (M76)
   *
   * A console's own title is the tab's, and a machine runs several projects at once — so a log
   * read on a phone said *what* was talking and never *about what*, which is the first thing
   * somebody looking at a wall of agent output needs. Absent while the project list is still
   * arriving, and then the line is simply not drawn rather than drawn empty.
   */
  const projectName = view?.projects.find((p) => p.id === row?.project)?.name ?? null

  useEffect(() => {
    if (connection === undefined) return
    // Opening it is looking at it. See the header.
    connection.tell({ t: 'acknowledge', session })
    // And locally, at once. cide's set is still authoritative and its next frame replaces this
    // — but a badge that outlives the act of opening the thing it points at reads as a button
    // that did nothing.
    registry.acknowledged(iid, String(session))
    connection.tell({ t: 'watchScreen', session })
    // And the device's own two records of the same fact: the ledger, so this wait is not
    // announced again after a reconnect, and the tray, which otherwise keeps showing a
    // notification for the console currently filling the screen.
    notify.watching(String(session))
    return () => {
      connection.tell({ t: 'unwatchScreen', session })
      notify.watching(null)
    }
  }, [connection, iid, session])

  const send = useCallback(
    (key: KeyEvent) => {
      connection?.tell({ t: 'input', session, key, seq: seq.current++ })
    },
    [connection, session],
  )

  const onChange = useCallback(
    (next: string) => {
      // Diffed against what was last seen, and the field is left alone unless the pad has been
      // eaten into. `afterChange` carries the race this replaces and the `hehehello` it produced.
      const changed = afterChange(seen.current, next)
      // Rendered *and* remembered, from one value: the field is controlled, so anything else
      // rendered here is what it holds, and the next diff is against something that is not.
      seen.current = changed.seen
      setPad(changed.seen)
      for (const key of changed.keys) send(key)
      if (changed.paste !== null) {
        connection?.tell({ t: 'paste', session, text: changed.paste, seq: seq.current++ })
      }
    },
    [connection, send, session],
  )

  /** Enter, and then an empty line to write the next one on. */
  const submit = useCallback(() => {
    send({ key: { k: 'enter' } })
    seen.current = PAD
    setPad(PAD)
  }, [send])

  const answer = (option: number) => {
    if (prompt === null) return
    // The digest is the guard: over a network the prompt a thumb was travelling towards can
    // already have been replaced by the next one, and cide refuses an answer whose digest moved.
    // No optimistic clearing: cide takes the card down with a `promptGone` when the question is
    // actually gone. Hiding it here would show an answered prompt as answered when the answer
    // was refused for having a stale digest, which is the one case the guard exists for.
    connection?.tell({ t: 'answerPrompt', session, option, expectScreen: prompt.digest })
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: T.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Stack.Screen
        options={{
          title: row?.tabTitle ?? row?.title ?? 'Session',
          // The same mark the list drew, so opening a row lands on something that looks like
          // the row. Without it the two screens agree about nothing but the title, and the one
          // fact worth carrying across — which of the two kinds of console this is — is exactly
          // the one that goes missing at the moment somebody starts typing.
          headerTitle: ({ children }: { children: string }) => (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              {it === null ? null : <KindTile look={it} size={22} />}
              <View style={{ flexShrink: 1 }}>
                <Text style={{ color: T.text, fontSize: 17 }} numberOfLines={1}>
                  {children}
                </Text>
                {projectName === null ? null : (
                  <Text style={{ color: T.dim, fontSize: 12 }} numberOfLines={1}>
                    {projectName}
                  </Text>
                )}
              </View>
            </View>
          ),
          headerRight: () => (
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <Pressable onPress={() => setWrapped((w) => !w)}>
                <Text style={{ color: T.accent }}>{wrapped ? 'wrap' : 'pan'}</Text>
              </Pressable>
              <Pressable
                onPress={() =>
                  setFontSize((s) => SIZES[(SIZES.indexOf(s as never) + 1) % SIZES.length] ?? 11)
                }
              >
                <Text style={{ color: T.accent }}>{fontSize}pt</Text>
              </Pressable>
            </View>
          ),
        }}
      />

      <View
        style={{
          flex: 1,
          // A hairline of the kind's colour under the header: present for as long as the console
          // is open, at no cost in height, and the one piece of the distinction that survives
          // the keyboard covering everything else.
          borderTopWidth: it === null ? 0 : 2,
          borderColor: it?.tint ?? T.border,
        }}
      >
        <ScreenView
          screen={screen}
          fontSize={fontSize}
          wrapped={wrapped}
          width={width - 8}
          // Scrolling towards the top *is* the request for more. The button below stays — it is
          // what says "reading…" and what says "this is the start of what cide still keeps" —
          // but nobody should have to find it to keep reading.
          onNearTop={() => {
            if (history.earlierFrom !== null) askPage(history.earlierFrom, PAGE)
          }}
          // Pulling past an edge of a screen the program owns. (M76)
          //
          // `claude` takes the alternate screen, so the terminal keeps no history for it and
          // there is nothing to page — the transcript is in the program, and the way a terminal
          // asks a program to show more of it is a wheel. cide refuses one aimed at a child that
          // never enabled mouse reports, which is why this can be offered unconditionally.
          onWheel={(lines) => {
            connection?.tell({ t: 'scroll', session, lines, seq: seq.current++ })
          }}
          above={({ fontSize: size, lineHeight, budget }) => (
            <HistoryView
              history={held}
              alt={screen.info?.alt ?? false}
              fontSize={size}
              lineHeight={lineHeight}
              budget={budget}
              onEarlier={
                history.earlierFrom === null
                  ? null
                  : () => askPage(history.earlierFrom ?? 0, PAGE)
              }
            />
          )}
        />
      </View>

      {prompt !== null ? (
        <View style={{ backgroundColor: T.panel, borderTopWidth: 1, borderColor: T.warn, padding: 12, gap: 8 }}>
          {prompt.question.map((line, i) => (
            <Text key={i} style={{ color: T.text }}>
              {line}
            </Text>
          ))}
          {prompt.options.map((option) => (
            <Pressable
              key={option.number}
              onPress={() => answer(option.number)}
              style={{ padding: 12, borderRadius: 8, borderWidth: 1, borderColor: T.border }}
            >
              <Text style={{ color: T.text }}>
                {option.number}. {option.label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {error !== null ? <Text style={{ color: T.bad, padding: 8 }}>{error}</Text> : null}

      {watching ? null : (
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="always"
        style={{ maxHeight: 46, backgroundColor: T.panel, borderTopWidth: 1, borderColor: T.border }}
        contentContainerStyle={{ alignItems: 'center', paddingHorizontal: 8, gap: 6 }}
      >
        {[...KEY_BAR, ...CTRL_BAR].map((entry) => (
          <Pressable
            key={entry.label}
            onPress={() => send(entry.key)}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 7,
              borderRadius: 7,
              borderWidth: 1,
              borderColor: T.border,
            }}
          >
            <Text style={{ color: T.text, fontFamily: 'monospace' }}>{entry.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
      )}

      {watching ? (
        <View style={{ padding: 10, backgroundColor: T.panel, borderTopWidth: 1, borderColor: T.border }}>
          <Text style={{ color: T.dim, fontSize: 12 }}>
            Watching this run's console. Open it in cide to type into it.
          </Text>
        </View>
      ) : (
      <View style={{ flexDirection: 'row', alignItems: 'center', padding: 8, gap: 8 }}>
        {/*
          The hidden input. `visible-password` on Android is the one line that stops Gboard
          composing text rather than emitting it — without it, typing into a terminal produces
          composition artefacts and the delta is wrong.
        */}
        <TextInput
          ref={input}
          value={pad}
          onChangeText={onChange}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          autoComplete="off"
          importantForAutofill="no"
          keyboardType={Platform.OS === 'android' ? 'visible-password' : 'default'}
          multiline={false}
          blurOnSubmit={false}
          onSubmitEditing={submit}
          placeholder="type here"
          placeholderTextColor={T.dim}
          style={{
            flex: 1,
            color: T.text,
            borderWidth: 1,
            borderColor: T.border,
            borderRadius: 8,
            paddingHorizontal: 12,
            paddingVertical: 10,
            backgroundColor: T.panel,
          }}
        />
        <Pressable
          onPress={submit}
          style={{ paddingHorizontal: 16, paddingVertical: 11, borderRadius: 8, backgroundColor: T.accent }}
        >
          <Text style={{ color: '#06121f' }}>⏎</Text>
        </Pressable>
      </View>
      )}
    </KeyboardAvoidingView>
  )
}
