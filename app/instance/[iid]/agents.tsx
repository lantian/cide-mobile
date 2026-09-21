/**
 * The roles this instance can run, and what they are doing. (M75)
 *
 * The screen the wire could not serve until M75: `runPause`, `runResume` and `runStop` were on
 * the protocol from the start while nothing could *list* a run, so a device could pause a run it
 * had no way to see.
 *
 * Every decision about what a row offers lives in `src/agents/model.ts` and is tested there. A
 * button that is wrong here is wrong silently — it is a control that does nothing to half of
 * what it names — so none of those rules are written in this file.
 */
import { useSyncExternalStore } from 'react'
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import * as registry from '../../../src/store/registry'
import * as choice from '../../../src/store/projectChoice'
import { ProjectPicker } from '../../../src/ui/ProjectPicker'
import {
  agentRows,
  canPause,
  canResume,
  isBusy,
  isWorking,
  queueState,
  liveRuns,
  pauseStateOf,
  runLabel,
  summarise,
} from '../../../src/agents/model'
import type { AgentRowView } from '../../../src/agents/model'
import { T } from '../../../src/ui/theme'

export default function AgentsScreen() {
  const { iid } = useLocalSearchParams<{ iid: string }>()
  const views = useSyncExternalStore(registry.subscribe, registry.getSnapshot)
  const choices = useSyncExternalStore(choice.subscribe, choice.getSnapshot)
  const view = views.find((v) => v.paired.instanceId === iid)

  if (view === undefined) {
    return (
      <View style={{ flex: 1, backgroundColor: T.bg, padding: 16 }}>
        <Text style={{ color: T.dim }}>That instance is not paired any more.</Text>
      </View>
    )
  }

  const connection = registry.connectionOf(iid)
  // Resolved rather than read: a choice naming a project the machine has since closed falls
  // back to *all*, because filtering on an id nothing matches renders as an empty list and
  // reads as "this machine has no agents".
  const project = choice.resolve(iid, view.projects, choices)
  const roster = choice.forProject(view.roster, project)
  const runs = choice.forProject(view.runs, project)
  const rows = agentRows(roster, runs)
  const live = liveRuns(runs)
  const all = pauseStateOf(runs)
  // Across the chosen projects: a machine is "paused" here if any project a device is looking
  // at has its queue shut, because that is the thing a Resume would undo.
  const queues = (project === null ? view.projects.map((p) => String(p.id)) : [project]).map((id) =>
    queueState(view.dispatching[id]),
  )
  const paused = queues.some((state) => state === 'paused')

  // An **omitted** `run` is cide's spelling of *every run in this project* — the host method has
  // taken it since M72 and this is its first caller. One frame per project rather than one per
  // run: the registry already knows how to stop them all, and asking it once is both fewer
  // frames and the only version that cannot race a run starting between them.
  const everything = (t: 'runPause' | 'runResume') => {
    // The projects **in scope**, not the ones that happen to have a live run. Deriving them
    // from the runs meant Resume all did nothing at all on a project whose queue was shut while
    // it was idle — which is precisely the state this control exists to get out of.
    const scope =
      project === null ? view.projects.map((p) => String(p.id)) : [project]
    for (const id of scope) {
      const target = view.projects.find((p) => String(p.id) === id)
      if (target !== undefined) connection?.tell({ t, project: target.id })
    }
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Agents' }} />
      <ScrollView
        style={{ flex: 1, backgroundColor: T.bg }}
        contentContainerStyle={{ padding: 16, gap: 12 }}
      >
        <ProjectPicker
          projects={view.projects}
          chosen={project}
          onChoose={(next) => choice.choose(iid, next)}
        />

        {/* A shut queue is drawn whether or not anything is running, which is the entire
            point: pausing does two things, and a project paused while nothing happened to be
            running used to arrive here looking perfectly ordinary. */}
        {paused ? (
          <View
            style={{
              padding: 12,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: T.warn,
              gap: 4,
            }}
          >
            <Text style={{ color: T.warn, fontSize: 14 }}>Dispatch paused</Text>
            <Text style={{ color: T.dim, fontSize: 12, lineHeight: 18 }}>
              No new runs will start. Anything already running is frozen.
            </Text>
          </View>
        ) : null}

        {live.length > 0 || paused ? (
          <View style={{ flexDirection: 'row', gap: 10 }}>
            {all !== 'all' && live.length > 0 ? (
              <Button label={`Pause all (${live.length})`} onPress={() => everything('runPause')} />
            ) : null}
            {/* Offered when the queue is shut even with nothing frozen — otherwise a project
                paused while idle has no way back, which is the state that started all this. */}
            {all !== 'none' || paused ? (
              <Button label="Resume all" onPress={() => everything('runResume')} />
            ) : null}
          </View>
        ) : null}

        {rows.length === 0 ? (
          <Text style={{ color: T.dim, lineHeight: 21 }}>
            {project === null ? 'This instance has no agent roles' : 'This project has no agent roles'}
            . They are defined in a project's{' '}
            <Text style={{ color: T.text }}>.cide/agents/</Text> directory.
          </Text>
        ) : (
          rows.map((row) => (
            <Row key={String(row.agent.id)} row={row} iid={iid} connection={connection} />
          ))
        )}
      </ScrollView>
    </>
  )
}

function Row({
  row,
  iid,
  connection,
}: {
  row: AgentRowView
  iid: string
  connection: ReturnType<typeof registry.connectionOf>
}) {
  const router = useRouter()
  const { agent } = row
  /**
   * Pause or resume just this role's runs.
   *
   * Per run, and it has to be: the frame's project-wide form takes no role, so asking by project
   * here would pause every other role on the machine from a button labelled with this one's
   * name. Only the runs the model says can actually take the gesture are sent — a `runPause` at
   * a run that has already exited is a frame cide has to refuse and a person has to wonder about.
   */
  const act = (t: 'runPause' | 'runResume') => {
    const eligible = row.runs.filter((run) =>
      t === 'runPause' ? canPause(run.state) : canResume(run.state),
    )
    for (const run of eligible) connection?.tell({ t, project: run.project, run: run.run })
  }

  return (
    <View
      style={{
        padding: 14,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: T.border,
        backgroundColor: T.panel,
        gap: 8,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {/* Motion, not a colour. A blue label says "this is running" in the same voice as
            every other label on the screen; a spinner is the only thing that reads as *now*
            from across a room. Drawn only for a run that is actually moving — see `isWorking`,
            which is narrower than "alive" on purpose. */}
        {isBusy(row) ? <ActivityIndicator size="small" color={T.accent} /> : null}
        <Text style={{ color: T.text, fontSize: 16, flex: 1 }} numberOfLines={1}>
          {agent.label}
        </Text>
        <Text style={{ color: T.dim, fontSize: 12 }}>
          {[agent.harness, agent.model ?? 'default'].join(' · ')}
        </Text>
      </View>

      {agent.description !== '' ? (
        <Text style={{ color: T.dim, fontSize: 13, lineHeight: 19 }} numberOfLines={2}>
          {agent.description}
        </Text>
      ) : null}

      {/* cide's sentence, carried through. It names the thing that would fix it, which is more
          than this app could say about a role it cannot dispatch. */}
      {agent.unavailable !== undefined ? (
        <Text style={{ color: T.warn, fontSize: 13, lineHeight: 19 }}>{agent.unavailable}</Text>
      ) : null}

      <Text style={{ color: row.running > 0 ? T.accent : T.dim, fontSize: 13 }}>
        {summarise(row)}
      </Text>

      {row.runs.length > 0 ? (
        <View style={{ gap: 6 }}>
          {row.runs.slice(0, 4).map((run) => {
            // A run with a session has a live console behind it, and that console *is* the
            // log — the mirror cide already keeps. A queued run has no child yet, so there is
            // nothing to open and no row is made tappable rather than drawn disabled.
            const openable = run.session !== undefined && run.session !== null
            return (
              <Pressable
                key={String(run.run)}
                disabled={!openable}
                onPress={() =>
                  router.push(`/session/${iid}/${String(run.session)}?readOnly=1`)
                }
                style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
              >
                {isWorking(run.state) ? (
                  <ActivityIndicator size="small" color={T.dim} />
                ) : null}
                <Text style={{ color: T.dim, fontSize: 12, flex: 1 }} numberOfLines={1}>
                  {runLabel(run.state)}
                  {run.task !== undefined && run.task !== null ? ` · ${String(run.task)}` : ''}
                </Text>
                {openable ? <Text style={{ color: T.accent, fontSize: 12 }}>log</Text> : null}
              </Pressable>
            )
          })}
        </View>
      ) : null}

      {/* Both buttons when the role's runs are mixed. Offering only one would silently do
          nothing to the other half — see `pauseStateOf`, which is where that is decided. */}
      {row.pausing !== 'none' || row.running > 0 ? (
        <View style={{ flexDirection: 'row', gap: 10 }}>
          {row.pausing !== 'all' && row.running > 0 ? (
            <Button label="Pause" onPress={() => act('runPause')} />
          ) : null}
          {row.pausing !== 'none' ? (
            <Button label="Resume" onPress={() => act('runResume')} />
          ) : null}
        </View>
      ) : null}
    </View>
  )
}


function Button({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        paddingVertical: 10,
        paddingHorizontal: 16,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: T.border,
      }}
    >
      <Text style={{ color: T.text, fontSize: 14 }}>{label}</Text>
    </Pressable>
  )
}
