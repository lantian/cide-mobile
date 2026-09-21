/**
 * One instance, as three questions. (M75)
 *
 * Consoles, Agents, Tasks — rather than a flat list of sessions, which is what this screen used
 * to be. The flat list answered only one of the three and gave no hint the other two existed;
 * worse, the wire carried no runs, roster or board at all, so a device could *pause* a run it
 * had no way to see. The sections came with the reads.
 *
 * Each row carries its own count, because a section worth opening and an empty one should not
 * look the same from here.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import * as registry from '../../../src/store/registry'
import * as choice from '../../../src/store/projectChoice'
import { ProjectPicker } from '../../../src/ui/ProjectPicker'
import { consoleCounts, runCounts, taskCounts, waitingByProject } from '../../../src/agents/model'
import { T } from '../../../src/ui/theme'
import { Badge } from '../../../src/ui/Badge'

export default function InstanceScreen() {
  const { iid } = useLocalSearchParams<{ iid: string }>()
  const views = useSyncExternalStore(registry.subscribe, registry.getSnapshot)
  const choices = useSyncExternalStore(choice.subscribe, choice.getSnapshot)
  const view = views.find((v) => v.paired.instanceId === iid)
  const router = useRouter()

  useEffect(() => {
    // Everything this instance has. An empty list means *all projects* on both sides of the
    // wire — the same rule `sessions(None)` follows — so the three per-project reads arrive for
    // every open project and the screens below filter locally.
    registry.connectionOf(iid)?.setInterests({ projects: [] })
  }, [iid])

  if (view === undefined) {
    return (
      <View style={{ flex: 1, backgroundColor: T.bg, padding: 16 }}>
        <Text style={{ color: T.dim }}>That instance is not paired any more.</Text>
      </View>
    )
  }

  // The choice is made here and every section below counts through it, so the three numbers on
  // this screen and the three screens behind them are always describing the same project.
  const project = choice.resolve(iid, view.projects, choices)
  // Per project, so a chip can say which one is asking for something without being opened.
  const byProject = waitingByProject(view.sessions, view.awaiting)
  const sessions =
    project === null
      ? view.sessions
      : view.sessions.filter((session) => String(session.project) === project)
  const consoles = consoleCounts(sessions, view.awaiting)
  const waiting = consoles.waiting
  const roster = choice.forProject(view.roster, project)
  const runs = runCounts(choice.forProject(view.runs, project))
  const counts = taskCounts(choice.forProject(view.tasks, project))
  const open = counts.todo + counts.doing + counts.review

  return (
    <>
      <Stack.Screen options={{ title: view.paired.label }} />
      <ScrollView
        style={{ flex: 1, backgroundColor: T.bg }}
        contentContainerStyle={{ padding: 16, gap: 12 }}
      >
        <ProjectPicker
          projects={view.projects}
          chosen={project}
          waiting={byProject}
          onChoose={(next) => choice.choose(iid, next)}
        />

        <Section
          title="Consoles"
          detail={
            consoles.open === 0
              ? 'Nothing open'
              : // `working` is stated even when it is zero, because *nothing is running* is the
                // answer somebody came to the screen for and a missing clause reads as a screen
                // that has not finished loading. The other two appear only when they are true.
                [
                  `${consoles.open} open`,
                  `${consoles.working} working`,
                  waiting > 0 ? `${waiting} waiting on you` : undefined,
                ]
                  .filter((part) => part !== undefined)
                  .join(' · ')
          }
          alert={waiting > 0}
          badge={waiting}
          onPress={() => router.push(`/instance/${iid}/consoles`)}
        />
        <Section
          title="Agents"
          detail={
            roster.length === 0
              ? 'No roles'
              : [
                  `${roster.length} role${roster.length === 1 ? '' : 's'}`,
                  `${runs.running} running`,
                  runs.paused > 0 ? `${runs.paused} paused` : undefined,
                  runs.queued > 0 ? `${runs.queued} queued` : undefined,
                ]
                  .filter((part) => part !== undefined)
                  .join(' · ')
          }
          onPress={() => router.push(`/instance/${iid}/agents`)}
        />
        <Section
          title="Tasks"
          detail={
            counts.todo + counts.doing + counts.review + counts.done === 0
              ? 'No tasks'
              : `${open} open · ${counts.doing} in progress · ${counts.review} in review`
          }
          onPress={() => router.push(`/instance/${iid}/tasks`)}
        />
      </ScrollView>
    </>
  )
}

function Section({
  title,
  detail,
  alert,
  badge,
  onPress,
}: {
  title: string
  detail: string
  alert?: boolean
  /** How many sessions here have finished and not been looked at. */
  badge?: number
  onPress: () => void
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        padding: 16,
        borderRadius: 10,
        borderWidth: 1,
        // The one section that might be asking for something is the one that gets a colour,
        // and it is the **same** colour as the badge on it and as the machine's row on the
        // screen before. Two colours for one signal makes a person check whether they mean
        // different things — which, on the one marker that says "somebody is waiting for you",
        // is the doubt it can least afford.
        borderColor: alert === true ? T.warn : T.border,
        backgroundColor: T.panel,
        gap: 6,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Text style={{ color: T.text, fontSize: 17, flex: 1 }}>{title}</Text>
        <Badge count={badge ?? 0} />
      </View>
      <Text style={{ color: alert === true ? T.warn : T.dim, fontSize: 13 }}>{detail}</Text>
    </Pressable>
  )
}
