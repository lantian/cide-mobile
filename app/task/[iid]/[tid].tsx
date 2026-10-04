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
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ActivityIndicator, FlatList, Pressable, Text, TextInput, View } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import * as registry from '../../../src/store/registry'
import { T } from '../../../src/ui/theme'
import { Markdown } from '../../../src/ui/Markdown'
import { authorColor, authorLabel, commentTime } from '../../../src/agents/author'
import { QuestionAnswer } from '../../../src/ui/QuestionAnswer'
import { AttachmentStrip } from '../../../src/ui/AttachmentStrip'
import type { TaskComment, TaskDetail, TaskStatus } from '../../../src/protocol/generated'

const STATUSES: readonly TaskStatus[] = ['inbox', 'todo', 'doing', 'review', 'done']

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
  // Memoised on the roster, so the memoised comments below see one object until it changes.
  const roster = view?.roster[owner ?? '']
  const roleColors: Readonly<Record<string, string>> = useMemo(
    () =>
      Object.fromEntries(
        (roster ?? [])
          .filter((role) => role.color !== undefined && String(role.id).trim() !== '')
          .map((role) => [String(role.id), role.color as string]),
      ),
    [roster],
  )

  const fetchEpoch = useRef(0)
  const fetch = useCallback(() => {
    const connection = registry.connectionOf(iid)
    if (connection === undefined || owner === undefined) return
    const epoch = ++fetchEpoch.current
    void connection
      .request({ t: 'taskGet', project: owner, task: tid } as never)
      .then((body) => {
        if (epoch !== fetchEpoch.current || body.t !== 'task') return
        setFailure(null)
        setDetail(body.task ?? null)
        setMissing(body.task === undefined || body.task === null)
      })
      .catch((error: unknown) => {
        if (epoch === fetchEpoch.current) setFailure(error instanceof Error ? error.message : 'could not read that task')
      })
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

  /*
   * Legacy send-back edits remain separate from the acknowledged question-answer road.
   */
  const send = (edits: readonly object[]) => {
    if (owner === undefined) return
    const connection = registry.connectionOf(iid)
    for (const one of edits) {
      connection?.tell({ t: 'taskEdit', project: owner, task: tid, edit: one } as never)
    }
  }
  const sendBack = (note: string) =>
    send([
      { kind: 'comment', text: `**Sent back by the user:** ${note}` },
      { kind: 'setStatus', status: 'doing' },
    ])

  const row = detail?.row

  // cide M136: the bytes of an attachment come over the same socket, a slice at a time. An
  // older cide sends the records and not the bytes, and the strips say so.
  const canAnswer = registry.connectionOf(iid)?.has('taskRespond') === true
  const canFetch = registry.connectionOf(iid)?.has('attachments') === true
  const comments = detail === null ? [] : detail.comments.filter((comment) => !comment.deleted)

  /*
   * Everything above the comments, as the list's header. An element and not a component, so a
   * re-render reconciles it rather than remounting it — the Reply boxes inside hold what the
   * person is typing.
   */
  const header = (
    <View style={{ gap: 14, paddingBottom: detail === null ? 0 : 8 }}>
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

          {row !== undefined && (row.question ?? null) !== null && (
            <Waiting title="Waiting for your answer">
              <QuestionAnswer key={JSON.stringify(row.question)} instance={iid} project={owner ?? ''} task={tid}
                question={row.question!} detail={detail} enabled={canAnswer} imagesEnabled={canFetch} onRefresh={fetch} />
            </Waiting>
          )}

          {row !== undefined && row.acceptance === 'user' && row.status === 'review' && (row.question ?? null) === null && (
            <Waiting title="Waiting for your acceptance">
              <Text style={{ color: T.dim, lineHeight: 20 }}>
                cide merged this after verify. Look at it in the game, then accept it or send it
                back with a line on what is wrong.
              </Text>
              <Pressable
                onPress={() => edit('setStatus', 'done')}
                style={{
                  alignSelf: 'flex-start',
                  paddingVertical: 9,
                  paddingHorizontal: 16,
                  borderRadius: 8,
                  backgroundColor: T.good,
                }}
              >
                <Text style={{ color: '#06121f', fontWeight: '600' }}>Accept</Text>
              </Pressable>
              <Reply placeholder="What is wrong" action="Send back" onSend={sendBack} />
            </Waiting>
          )}

          <Section title="Description">
            {/* The sentence, not an empty box — `TaskDetailView`'s rule. */}
            {detail.body === '' ? (
              <Text style={{ color: T.dim, lineHeight: 21 }}>No description.</Text>
            ) : (
              <Markdown text={detail.body} />
            )}
            <AttachmentStrip
              instance={iid}
              project={owner ?? ''}
              task={tid}
              attachments={detail.attachments}
              enabled={canFetch}
            />
          </Section>

          <Text style={{ color: T.dim, fontSize: 12, textTransform: 'uppercase' }}>
            {`Comments (${comments.length})`}
          </Text>
          {comments.length === 0 ? <Text style={{ color: T.dim }}>No comments yet.</Text> : null}
        </>
      )}
    </View>
  )

  /*
   * A `FlatList`, not a `ScrollView`, and that is what keeps a long card from freezing the phone.
   * A `ScrollView` mounts every comment — its markdown, and since M136 its pictures — the moment
   * the task arrives, and a card with two hundred comments and sixty screenshots was all of that
   * at once, on the JS thread and in memory. The list mounts the comments near the screen and
   * unmounts the ones that scroll far away; an unmounted comment's tiles release their pictures
   * and stop their downloads (`attachments/store.ts`), so memory follows the scroll position
   * rather than the size of the task.
   */
  return (
    <>
      <Stack.Screen options={{ title: row?.title ?? 'Task' }} />
      <FlatList
        style={{ flex: 1, backgroundColor: T.bg }}
        contentContainerStyle={{ padding: 16, gap: 8 }}
        data={comments}
        // A comment's id is its identity across the re-fetch on every board change, so a
        // comment that did not change is not remounted — and its pictures do not blink.
        keyExtractor={(comment) => String(comment.id)}
        ListHeaderComponent={header}
        renderItem={({ item }) => (
          <Comment
            comment={item}
            roleColors={roleColors}
            instance={iid}
            project={owner ?? ''}
            task={tid}
            canFetch={canFetch}
          />
        )}
        initialNumToRender={6}
        maxToRenderPerBatch={4}
        windowSize={5}
        removeClippedSubviews
        keyboardShouldPersistTaps="handled"
      />
    </>
  )
}

/**
 * One comment: the name in the role's own colour, the time beside it, the text as markdown, and
 * its attachments. Memoised so the re-fetch on every board change re-renders only the comments
 * whose record actually changed — the rest keep their identity by value of their fields.
 */
const Comment = memo(
  function Comment({
    comment,
    roleColors,
    instance,
    project,
    task,
    canFetch,
  }: {
    comment: TaskComment
    roleColors: Readonly<Record<string, string>>
    instance: string
    project: string
    task: string
    canFetch: boolean
  }) {
    // `TaskAuthor` is a tagged enum; the card once printed the tag. See `authorLabel`.
    const tint = authorColor(comment.author, roleColors)
    return (
      <View
        style={{
          gap: 6,
          padding: 14,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: T.border,
          backgroundColor: T.panel,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
          <Text style={{ color: tint ?? T.accent, fontSize: 13, fontWeight: '600' }}>
            {authorLabel(comment.author)}
          </Text>
          <Text style={{ color: T.dim, fontSize: 12 }}>
            {commentTime(Number(comment.atUnixMs))}
            {comment.editedAtUnixMs === undefined || comment.editedAtUnixMs === null
              ? ''
              : ' · edited'}
          </Text>
        </View>
        <Markdown text={comment.text} />
        <AttachmentStrip
          instance={instance}
          project={project}
          task={task}
          attachments={comment.attachments}
          enabled={canFetch}
        />
      </View>
    )
  },
  (a, b) =>
    a.instance === b.instance &&
    a.project === b.project &&
    a.task === b.task &&
    a.canFetch === b.canFetch &&
    a.roleColors === b.roleColors &&
    a.comment.text === b.comment.text &&
    a.comment.editedAtUnixMs === b.comment.editedAtUnixMs &&
    a.comment.attachments.length === b.comment.attachments.length &&
    a.comment.attachments.every(
      (x, i) => x.id === b.comment.attachments[i]?.id && x.deleted === b.comment.attachments[i]?.deleted,
    ),
)

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

/** A task that waits for the user: the one block on the card that asks them for something. */
function Waiting({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View
      style={{
        padding: 14,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: T.warn,
        backgroundColor: T.panel,
        gap: 10,
      }}
    >
      <Text style={{ color: T.warn, fontSize: 12, textTransform: 'uppercase' }}>{title}</Text>
      {children}
    </View>
  )
}

/** A multi-line box and its button; empty text sends nothing, and a sent text clears the box. */
function Reply({
  placeholder,
  action,
  onSend,
}: {
  placeholder: string
  action: string
  onSend: (text: string) => void
}) {
  const [text, setText] = useState('')
  const ready = text.trim() !== ''
  return (
    <View style={{ gap: 8 }}>
      <TextInput
        multiline
        placeholder={placeholder}
        placeholderTextColor={T.dim}
        value={text}
        onChangeText={setText}
        style={{
          color: T.text,
          borderWidth: 1,
          borderColor: T.border,
          borderRadius: 8,
          paddingHorizontal: 12,
          paddingVertical: 9,
          minHeight: 72,
          textAlignVertical: 'top',
          backgroundColor: T.bg,
          fontSize: 14,
        }}
      />
      <Pressable
        disabled={!ready}
        onPress={() => {
          onSend(text.trim())
          setText('')
        }}
        style={{
          alignSelf: 'flex-start',
          paddingVertical: 9,
          paddingHorizontal: 16,
          borderRadius: 8,
          backgroundColor: ready ? T.accent : T.border,
        }}
      >
        <Text style={{ color: ready ? '#06121f' : T.dim, fontWeight: '600' }}>{action}</Text>
      </Pressable>
    </View>
  )
}
