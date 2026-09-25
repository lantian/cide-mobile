/**
 * One instance's consoles.
 *
 * Sorted by what is asking for attention, because that is the question this app exists to
 * answer: waiting first, then working, then everything else. A list in workspace order would be
 * correct and would bury the one row worth opening.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import * as registry from '../../../src/store/registry'
import * as choice from '../../../src/store/projectChoice'
import { shownState, waitingByProject } from '../../../src/agents/model'
import { ProjectPicker } from '../../../src/ui/ProjectPicker'
import { ProjectSwipe } from '../../../src/ui/ProjectSwipe'
import { T, stateColour, stateLabel } from '../../../src/ui/theme'
import { Dot } from '../../../src/ui/Badge'
import { KindStripe, KindTile, look } from '../../../src/ui/Kind'
import type { RemoteSession } from '../../../src/protocol/generated'

/** Waiting, then working, then the rest. */
function rank(session: RemoteSession, waiting: Set<string>): number {
  if (waiting.has(String(session.session))) return 0
  switch (session.state.state) {
    case 'awaitingPermission':
      return 1
    case 'awaitingInput':
      return 2
    case 'busy':
      return 3
    case 'exited':
      return 6
    default:
      return 5
  }
}

export default function InstanceScreen() {
  const { iid } = useLocalSearchParams<{ iid: string }>()
  const views = useSyncExternalStore(registry.subscribe, registry.getSnapshot)
  const choices = useSyncExternalStore(choice.subscribe, choice.getSnapshot)
  const view = views.find((v) => v.paired.instanceId === iid)
  const router = useRouter()

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
  const sessions = view.sessions
    .filter((session) => project === null || String(session.project) === project)
    .sort((a, b) => rank(a, waiting) - rank(b, waiting))
  const projects = new Map(view.projects.map((p) => [String(p.id), p.name]))

  return (
    <>
      <Stack.Screen options={{ title: view.paired.label }} />
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
            const it = look(session.kind, session.title)
            return (
              <Pressable
                key={id}
                onPress={() => router.push(`/session/${iid}/${id}`)}
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
                    {/* Whose name leads depends on the kind, and getting that wrong renamed
                        people's shells. (M76)

                        A **Claude** pane calls itself `claude` — every one of them does — so a list
                        keyed on the pane's own title is a column of identical rows, and the tab is
                        the only thing that tells them apart. A **shell** is the other way round: it
                        calls itself `bash`, which is the useful word, while the tab it happens to
                        sit in is usually named after the Claude console beside it. So every bash
                        pane in this list was headed *Claude*, which is not a naming quirk — it is
                        the row claiming to be the thing a person opens to talk to an agent.

                        The tab is still worth saying for a shell, and it is said underneath. */}
                    <Text style={{ color: T.text, fontSize: 16, flex: 1 }} numberOfLines={1}>
                      {session.kind === 'claude'
                        ? (session.tabTitle ?? session.title)
                        : (session.title === '' ? session.tabTitle : session.title) ??
                          session.title}
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
                      session.kind !== 'claude' && session.tabTitle !== undefined
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
              </Pressable>
            )
          })}
        </ScrollView>
      </ProjectSwipe>
    </>
  )
}
