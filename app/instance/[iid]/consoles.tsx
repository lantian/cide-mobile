/** One instance’s consoles, in authoritative desktop layout and tab order. */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import * as registry from '../../../src/store/registry'
import { nameOf } from '../../../src/store/instanceName'
import * as choice from '../../../src/store/projectChoice'
import { shownState, waitingByProject } from '../../../src/agents/model'
import { ProjectPicker } from '../../../src/ui/ProjectPicker'
import { ProjectSwipe } from '../../../src/ui/ProjectSwipe'
import { T, stateColour, stateLabel } from '../../../src/ui/theme'
import { Dot } from '../../../src/ui/Badge'
import { KindStripe, KindTile, look } from '../../../src/ui/Kind'
import { consoleTitle, consoleRoute, orderedConsoles, isAIConsole } from '../../../src/consoles/model'
import { closeConsole } from '../../../src/consoles/close'

export default function InstanceScreen() {
  const { iid } = useLocalSearchParams<{ iid: string }>()
  const views = useSyncExternalStore(registry.subscribe, registry.getSnapshot)
  const choices = useSyncExternalStore(choice.subscribe, choice.getSnapshot)
  const view = views.find((v) => v.paired.instanceId === iid)
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [closing, setClosing] = useState<string | null>(null)

  useEffect(() => {
    // Everything this instance has. Narrowing to one project is what the project screen will do;
    // from here the useful view is the machine's whole board.
    registry.connectionOf(iid)?.setInterests({ projects: [] })
  }, [iid])

  if (view === undefined) {
    return (
      <View style={{ flex: 1, backgroundColor: T.bg, padding: 16 }}>
        <Text style={{ color: T.dim }}>That instance is not paired any more.</Text>
      </View>
    )
  }

  const waiting = new Set(view.awaiting.map((entry) => String(entry.session)))
  const project = choice.resolve(iid, view.projects, choices)
  const sessions = orderedConsoles(view.sessions, project)
  const projects = new Map(view.projects.map((p) => [String(p.id), p.name]))

  return (
    <>
      <Stack.Screen options={{ title: nameOf(view.paired) }} />
      <ProjectSwipe iid={iid} projects={view.projects} chosen={project}>
        <ScrollView
          style={{ flex: 1, backgroundColor: T.bg }}
          contentContainerStyle={{ padding: 16, gap: 10 }}
          refreshControl={
            <RefreshControl
              refreshing={view.phase === 'connecting' || view.phase === 'handshaking'}
              onRefresh={() => registry.connectionOf(iid)?.retryNow()}
              tintColor={T.dim}
            />
          }
        >
          <ProjectPicker
            projects={view.projects}
            chosen={project}
            waiting={waitingByProject(view.sessions, view.awaiting)}
            onChoose={(next) => choice.choose(iid, next)}
          />

          {error === null ? null : <Text style={{ color: T.bad }}>{error}</Text>}
          {view.phase !== 'ready' ? (
            <Text style={{ color: T.warn }}>{view.detail ?? view.phase}</Text>
          ) : null}

          {sessions.length === 0 && view.phase === 'ready' ? (
            <Text style={{ color: T.dim }}>Nothing is running on this machine.</Text>
          ) : null}

          {sessions.map((session) => {
            const id = String(session.session)
            const marked = waiting.has(id)
            const state = shownState(session.state.state, marked)
            const it = look(session.kind, session.title, session.harness)
            return (
              <Pressable
                key={String(session.pane)}
                onPress={() => router.push(consoleRoute(iid, session) as never)}
                style={{
                  flexDirection: 'row',
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: marked ? T.warn : T.border,
                  backgroundColor: T.panel,
                  // The stripe is the card's leading edge, so it has to be clipped by the radius
                  // rather than drawn as a rectangle sticking out of a rounded corner.
                  overflow: 'hidden',
                }}
              >
                <KindStripe tint={it.tint} />
                <View style={{ flex: 1, padding: 14, gap: 3 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <KindTile look={it} />
                    {/* AI consoles keep custom tab names; shells keep their own names. */}
                    <Text style={{ color: T.text, fontSize: 16, flex: 1 }} numberOfLines={1}>
                      {consoleTitle(session)}
                    </Text>
                    {/* The mark stays until the session is opened — and opening it here clears it
                        on the desktop too, through the same set every cide window shares. */}
                    <Dot on={marked} />
                  </View>
                  {/* Not drawn at all when there is no state to report — an empty line here is a
                      gap in a stack of rows, and `stateLabel` answers '' on purpose. */}
                  {stateLabel(state) === '' && session.agent === undefined ? null : (
                    <Text style={{ color: stateColour(state), fontSize: 13 }}>
                      {stateLabel(state)}
                      {session.agent !== undefined
                        ? `${stateLabel(state) === '' ? '' : ' · '}${session.agent}`
                        : ''}
                    </Text>
                  )}
                  <Text style={{ color: T.dim, fontSize: 12 }} numberOfLines={1}>
                    {/* The kind is said in words as well as drawn, and it leads the line: colour is
                        not available to every reader and is the first thing a screenshot loses. */}
                    <Text style={{ color: it.tint }}>{it.label}</Text>
                    {[
                      projects.get(String(session.project)),
                      // The tab, for a shell whose heading is now its own name — that is where
                      // *which* Claude it sits beside went. Repeating it under a Claude console,
                      // whose heading is already the tab, would be noise.
                      !isAIConsole(session) && session.tabTitle !== undefined
                        ? `in ${session.tabTitle}`
                        : undefined,
                      // Shown only when it adds something. A detached pane says so instead.
                      session.tabTitle === undefined ? 'detached' : undefined,
                    ]
                      .filter((part) => part !== undefined && part !== '')
                      .map((part) => ` · ${part}`)
                      .join('')}
                  </Text>
                </View>
                {session.canClose === true && registry.connectionOf(iid)?.has('consoleClose') ? (
                  <Pressable accessibilityLabel={`Close ${consoleTitle(session)}`} disabled={closing !== null}
                    style={{ padding: 14, justifyContent: 'center' }}
                    onPress={(event) => {
                      event.stopPropagation()
                      setClosing(String(session.pane)); setError(null)
                      void closeConsole(registry.connectionOf(iid)!, session).catch((e: unknown) => setError(String(e instanceof Error ? e.message : e)))
                        .finally(() => setClosing(null))
                    }}>
                    <Text style={{ color: T.dim }}>{closing === String(session.pane) ? '…' : '×'}</Text>
                  </Pressable>
                ) : null}
              </Pressable>
            )
          })}
        </ScrollView>
      </ProjectSwipe>
    </>
  )
}
