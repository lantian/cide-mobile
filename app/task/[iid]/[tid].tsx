/**
 * One task, read and changed. (M75)
 *
 * Fetched rather than pushed: the board carries rows and no content — `TaskRow` exists because
 * the board used to carry every word ever written into a tracker — so opening a task is the one
 * moment a device asks for its body, comments and history.
 *
 * Re-fetched whenever the board moves, because a `tasksChanged` means *something* in this
 * project was edited and this screen has no way to know whether it was this task. That is one
 * request per edit while a card is open, which is the cheap direction to be wrong in: the
 * alternative is a card quietly showing a body somebody else has already replaced.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import * as registry from '../../../src/store/registry'
import { T } from '../../../src/ui/theme'
import { Markdown } from '../../../src/ui/Markdown'
import { authorColor, authorLabel, commentTime } from '../../../src/agents/author'
import type { TaskDetail, TaskStatus } from '../../../src/protocol/generated'

const STATUSES: readonly TaskStatus[] = ['todo', 'doing', 'review', 'done']

export default function TaskScreen() {
  const { iid, tid } = useLocalSearchParams<{ iid: string; tid: string }>()
  const views = useSyncExternalStore(registry.subscribe, registry.getSnapshot)
  const view = views.find((v) => v.paired.instanceId === iid)
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [missing, setMissing] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  // Which project owns it. The board is keyed by project and a task id is only unique within
  // one, so the row is found rather than assumed — a guessed project edits the wrong tracker.
  const owner = Object.entries(view?.tasks ?? {}).find(([, rows]) =>
    rows.some((row) => String(row.id) === tid),
  )?.[0]

  /*
   * Every role's *declared* hue, by id, for this project's roster.
   *
   * Only the declared ones: `authorColor` derives the rest from the id, so a role missing from
   * this map is not a role without a colour — it is a role whose colour nobody had to store,
   * including one that has since been deleted and still has comments on this card.
   */
  const roleColors: Readonly<Record<string, string>> = Object.fromEntries(
    (view?.roster[owner ?? ''] ?? [])
      .filter((role) => role.color !== undefined && String(role.id).trim() !== '')
      .map((role) => [String(role.id), role.color as string]),
  )

  const fetch = useCallback(() => {
    const connection = registry.connectionOf(iid)
    if (connection === undefined || owner === undefined) return
    void connection
      .request({ t: 'taskGet', project: owner, task: tid } as never)
      .then((body) => {
        if (body.t !== 'task') return
        setDetail(body.task ?? null)
        setMissing(body.task === undefined || body.task === null)
      })
      .catch((error: unknown) =>
        setFailure(error instanceof Error ? error.message : 'could not read that task'),
      )
  }, [iid, owner, tid])

  // On open, and again whenever this project's board moves.
  const boardRev = view?.tasks[owner ?? '']?.length
  const stamp = view?.tasks[owner ?? '']?.find((row) => String(row.id) === tid)?.updatedUnixMs
  useEffect(fetch, [fetch, boardRev, stamp])

  if (view === undefined) {
    return (
      <View style={{ flex: 1, backgroundColor: T.bg, padding: 16 }}>
        <Text style={{ color: T.dim }}>That instance is not paired any more.</Text>
      </View>
    )
  }

  const edit = (kind: 'setStatus', status: TaskStatus) => {
    if (owner === undefined) return
    registry
      .connectionOf(iid)
      ?.tell({ t: 'taskEdit', project: owner, task: tid, edit: { kind, status } } as never)
  }

  const row = detail?.row

  return (
    <>
      <Stack.Screen options={{ title: row?.title ?? 'Task' }} />
      <ScrollView
        style={{ flex: 1, backgroundColor: T.bg }}
        contentContainerStyle={{ padding: 16, gap: 14 }}
      >
        {failure !== null ? <Text style={{ color: T.bad }}>{failure}</Text> : null}

        {missing ? (
          <Text style={{ color: T.dim, lineHeight: 21 }}>
            That task is gone. A board this phone is holding can name one somebody has since
            deleted.
          </Text>
        ) : detail === null ? (
          // A sentence beside a spinner, never a blank card. `TaskDetailPending`'s rule on the
          // desktop: every content field renders a *sentence* when empty, and a card built from
          // nothing reads as a broken dialog rather than as one that is still loading.
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <ActivityIndicator color={T.dim} />
            <Text style={{ color: T.dim }}>Reading this task…</Text>
          </View>
        ) : (
          <>
            <Text style={{ color: T.text, fontSize: 18, lineHeight: 25 }}>{row?.title}</Text>

            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {STATUSES.map((status) => (
                <Pressable
                  key={status}
                  onPress={() => edit('setStatus', status)}
                  style={{
                    paddingVertical: 8,
                    paddingHorizontal: 14,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: row?.status === status ? T.accent : T.border,
                    backgroundColor: row?.status === status ? T.accent : 'transparent',
                  }}
                >
                  <Text style={{ color: row?.status === status ? '#06121f' : T.dim, fontSize: 13 }}>
                    {status}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Text style={{ color: T.dim, fontSize: 12 }}>{String(row?.id)}</Text>

            <Section title="Description">
              {/* The sentence, not an empty box — `TaskDetailView`'s rule. */}
              {detail.body === '' ? (
                <Text style={{ color: T.dim, lineHeight: 21 }}>No description.</Text>
              ) : (
                <Markdown text={detail.body} />
              )}
            </Section>

            <Section title={`Comments (${detail.comments.filter((c) => !c.deleted).length})`}>
              {detail.comments.length === 0 ? (
                <Text style={{ color: T.dim }}>No comments yet.</Text>
              ) : (
                detail.comments
                  // A delete is a tombstone kept in the vector so the merge cannot resurrect
                  // it — see `TaskComment::deleted`. It is a row that should not be drawn, not
                  // a row that is gone.
                  .filter((comment) => !comment.deleted)
                  .map((comment) => {
                    // The name in the role's own colour, the time beside it, the text as
                    // markdown. All three were missing, and the first two were the same defect:
                    // `TaskAuthor` is a tagged enum and the card printed the tag.
                    const tint = authorColor(comment.author, roleColors)
                    return (
                      <View key={String(comment.id)} style={{ gap: 4, paddingVertical: 6 }}>
                        <View
                          style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}
                        >
                          <Text
                            style={{
                              color: tint ?? T.accent,
                              fontSize: 13,
                              fontWeight: '600',
                            }}
                          >
                            {authorLabel(comment.author)}
                          </Text>
                          <Text style={{ color: T.dim, fontSize: 12 }}>
                            {commentTime(Number(comment.atUnixMs))}
                            {comment.editedAtUnixMs === undefined ||
                            comment.editedAtUnixMs === null
                              ? ''
                              : ' · edited'}
                          </Text>
                        </View>
                        <Markdown text={comment.text} />
                      </View>
                    )
                  })
              )}
            </Section>
          </>
        )}
      </ScrollView>
    </>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: T.dim, fontSize: 12, textTransform: 'uppercase' }}>{title}</Text>
      <View
        style={{
          padding: 14,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: T.border,
          backgroundColor: T.panel,
          gap: 6,
        }}
      >
        {children}
      </View>
    </View>
  )
}
