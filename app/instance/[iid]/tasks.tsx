/**
 * This instance's task board. (M75)
 *
 * Rows and never content: `TaskRow` exists because the board used to carry every word ever
 * written into a tracker, and a phone is the last place that should arrive. A task's body,
 * comments and history are a separate read, and this screen does not make it.
 *
 * Ordering lives in `src/agents/model.ts` — in progress, then waiting on a look, then not
 * started, then done — because a board sorted by id is a board nobody reads.
 */
import { useState, useSyncExternalStore } from 'react'
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import * as registry from '../../../src/store/registry'
import * as choice from '../../../src/store/projectChoice'
import { ProjectPicker } from '../../../src/ui/ProjectPicker'
import { ProjectSwipe } from '../../../src/ui/ProjectSwipe'
import { ScrollView as HScroll } from 'react-native-gesture-handler'
import { filterTasks, matchesQuery, taskCounts } from '../../../src/agents/model'
import type { TaskFilter } from '../../../src/agents/model'
import { T } from '../../../src/ui/theme'
import type { TaskStatus } from '../../../src/protocol/generated'

/** One colour per state, so the board reads at a glance rather than by reading every label. */
function statusColour(status: TaskStatus): string {
  switch (status) {
    case 'doing':
      return T.accent
    case 'review':
      return T.warn
    case 'done':
      return T.dim
    default:
      return T.text
  }
}

export default function TasksScreen() {
  const { iid } = useLocalSearchParams<{ iid: string }>()
  const views = useSyncExternalStore(registry.subscribe, registry.getSnapshot)
  const choices = useSyncExternalStore(choice.subscribe, choice.getSnapshot)
  const router = useRouter()
  // Component state, not a store: a filter is a gesture on one screen, and unlike the project
  // choice it has no reason to survive leaving it.
  const [filter, setFilter] = useState<TaskFilter>(null)
  const [query, setQuery] = useState('')
  const view = views.find((v) => v.paired.instanceId === iid)

  if (view === undefined) {
    return (
      <View style={{ flex: 1, backgroundColor: T.bg, padding: 16 }}>
        <Text style={{ color: T.dim }}>That instance is not paired any more.</Text>
      </View>
    )
  }

  const project = choice.resolve(iid, view.projects, choices)
  const tasks = choice.forProject(view.tasks, project)
  const rows = filterTasks(tasks, filter).filter((task) => matchesQuery(task, query))
  const counts = taskCounts(tasks)
  // Across every project when none is chosen: a role id is unique within a project, and the
  // worst a collision does here is label a row with the other project's name for the same id.
  const agents = new Map(
    choice.forProject(view.roster, project).map((agent) => [String(agent.id), agent.label]),
  )

  return (
    <>
      <Stack.Screen options={{ title: 'Tasks' }} />
      <ProjectSwipe iid={iid} projects={view.projects} chosen={project}>
        <ScrollView
          style={{ flex: 1, backgroundColor: T.bg }}
          contentContainerStyle={{ padding: 16, gap: 10 }}
        >
          <ProjectPicker
            projects={view.projects}
            chosen={project}
            onChoose={(next) => choice.choose(iid, next)}
          />

          <TextInput
            placeholder="Filter by title or id"
            placeholderTextColor={T.dim}
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
            style={{
              color: T.text,
              borderWidth: 1,
              borderColor: T.border,
              borderRadius: 8,
              paddingHorizontal: 12,
              paddingVertical: 9,
              backgroundColor: T.panel,
              fontSize: 14,
            }}
          />

          {/* Gesture-handler's scroller, so dragging this row scrolls it rather than being taken
              for a swipe to the next project by `ProjectSwipe` around the screen. */}
          <HScroll
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 8, paddingVertical: 2 }}
          >
            {/* Counts on the chips, so an empty state is visible *before* it is chosen — a filter
                that silently leads to nothing is a filter people press twice. */}
            <FilterChip label={`All ${tasks.length}`} active={filter === null} onPress={() => setFilter(null)} />
            {(['doing', 'review', 'todo', 'inbox', 'done'] as const).map((status) => (
              <FilterChip
                key={status}
                label={`${status} ${counts[status]}`}
                active={filter === status}
                onPress={() => setFilter(filter === status ? null : status)}
              />
            ))}
          </HScroll>

          {rows.length === 0 ? (
            <Text style={{ color: T.dim, lineHeight: 21 }}>
              {/* Three different sentences, because "this project has no tracker", "the board is
                  empty" and "your filter matches nothing" have three different next actions. */}
              {tasks.length === 0 ? (
                <>
                  No tasks. A project's tracker lives in its{' '}
                  <Text style={{ color: T.text }}>.cide/</Text> directory.
                </>
              ) : (
                'Nothing matches that.'
              )}
            </Text>
          ) : (
            <>
              <Text style={{ color: T.dim, fontSize: 13 }}>
                {`${counts.doing} in progress · ${counts.review} in review · ${counts.todo} to do · ${counts.done} done`}
              </Text>
              {rows.map((task) => (
                <Pressable
                  key={String(task.id)}
                  onPress={() => router.push(`/task/${iid}/${String(task.id)}`)}
                  style={{
                    padding: 14,
                    borderRadius: 10,
                    borderWidth: 1,
                    borderColor: T.border,
                    backgroundColor: T.panel,
                    gap: 6,
                  }}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <View
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        backgroundColor: statusColour(task.status),
                      }}
                    />
                    <Text style={{ color: T.text, fontSize: 15, flex: 1 }} numberOfLines={2}>
                      {task.title}
                    </Text>
                  </View>
                  <Text style={{ color: T.dim, fontSize: 12 }} numberOfLines={1}>
                    {[
                      task.status,
                      // The role's current label, because a board row names a role by id and an
                      // id is not a name. Falls back to the id when the role is gone — which is a
                      // real state, and blanking it would hide that the task is assigned at all.
                      task.agent === undefined || task.agent === null
                        ? undefined
                        : (agents.get(String(task.agent)) ?? String(task.agent)),
                      String(task.id),
                    ]
                      .filter((part) => part !== undefined && part !== '')
                      .join(' · ')}
                  </Text>
                </Pressable>
              ))}
            </>
          )}
        </ScrollView>
      </ProjectSwipe>
    </>
  )
}

function FilterChip({
  label,
  active,
  onPress,
}: {
  label: string
  active: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: active ? T.accent : T.border,
        backgroundColor: active ? T.accent : 'transparent',
      }}
    >
      <Text style={{ color: active ? '#06121f' : T.dim, fontSize: 12 }}>{label}</Text>
    </Pressable>
  )
}
