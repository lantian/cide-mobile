import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'expo-router'
import { Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { TaskDetail, TaskResponse, UserRequestResponse } from '../protocol/generated'
import * as registry from '../store/registry'
import { DecisionSubmission, savedAnswer, type AnswerDraft, type DecisionItem } from '../requests/model'
import { useDecisionTask } from '../requests/useTask'
import { QuestionAnswer } from './QuestionAnswer'
import { DecisionTask } from './DecisionTask'
import { ChipButton } from './ChipButton'
import { TaskReferences } from './TaskReferences'
import { T } from './theme'

export function WaitingDecisions({ instance, items, enabled, initialRequest }: { instance: string; items: readonly DecisionItem[]; enabled: boolean; initialRequest?: string | undefined }) {
  const [selected, setSelected] = useState<string | null>(null)
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const handledRequest = useRef<string | null>(null)
  useEffect(() => {
    if (initialRequest === undefined || handledRequest.current === initialRequest) return
    const item = items.find((row) => row.request?.id === initialRequest)
    if (item === undefined) return // Cold-start notification: wait for the project snapshot.
    handledRequest.current = initialRequest
    setOpened((before) => new Set([...before, item.id])); setSelected(item.id)
  }, [items, initialRequest])
  return <View style={{ gap: 12 }}>
    {items.length === 0 && <Text style={{ color: T.dim }}>Nothing is waiting for you.</Text>}
    {items.map((item) => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`${item.label}: ${item.title}`}
      onPress={() => { setOpened((before) => new Set([...before, item.id])); setSelected(item.id) }}
      style={{ padding: 16, gap: 8, backgroundColor: T.panel, borderRadius: 10, borderWidth: 1, borderColor: T.border }}>
      <Text style={{ color: T.warn, fontSize: 12 }}>{item.label}</Text><Text style={{ color: T.text, lineHeight: 22 }}>{item.title}</Text>
      <Text style={{ color: T.dim, fontSize: 12 }}>{item.request?.origin.title ?? item.task?.id}</Text>
    </Pressable>)}
    {items.filter((item) => opened.has(item.id)).map((item) => <Decision key={item.id} instance={instance} item={item} enabled={enabled}
      open={selected === item.id} onClose={() => setSelected(null)} />)}
  </View>
}

function Decision({ instance, item, enabled, open, onClose }: { instance: string; item: DecisionItem; enabled: boolean; open: boolean; onClose: () => void }) {
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const request = item.request
  const proposal = request?.request
  const task = request?.task ?? item.task?.id ?? null
  const question = proposal?.kind === 'question' ? proposal.question : item.task?.question ?? null
  const move = proposal?.kind === 'moveTasks' ? proposal : null
  const [draft, setDraft] = useState<AnswerDraft>({ text: '', selected: [] })
  const [selected, setSelected] = useState<string[]>(() => move?.tasks.map((row) => String(row.id)) ?? [])
  const [note, setNote] = useState('')
  const [details, setDetails] = useState(false)
  const [sendingBack, setSendingBack] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [taskStack, setTaskStack] = useState<string[]>([])
  const submission = useRef(new DecisionSubmission()).current
  const inFlight = useRef(false)
  const rootTask = useDecisionTask(instance, item.project, task == null ? null : String(task))
  const childId = taskStack.at(-1) ?? null
  const child = useDecisionTask(instance, item.project, childId)
  const connection = registry.connectionOf(instance)
  const imagesEnabled = connection?.has('attachments') === true
  const canRespond = enabled && connection?.has(request ? 'userRequests' : 'taskRespond') === true
  const resolved = request?.response != null
  const locked = busy || !canRespond || request?.applying === true
  const openTask = (id: string) => setTaskStack((before) => before.at(-1) === id ? before : [...before, id])
  const back = () => setTaskStack((before) => before.slice(0, -1))
  const refresh = () => {
    rootTask.refresh()
    if (request && connection?.has('userRequests')) void connection.request({ t: 'userRequestsGet', project: item.project } as never)
      .then((reply) => { if (reply.t === 'userRequests') registry.adoptUserRequests(instance, item.project, reply.view ?? null) }).catch(() => undefined)
  }
  const respond = async (response: UserRequestResponse) => {
    if (!request || !connection || !canRespond) throw new Error('Connect to an updated cide to send this decision.')
    const view = await submission.send((body) => connection.request(body), item.project, request.id, response)
    if (view !== null) registry.adoptUserRequests(instance, item.project, view)
  }
  const act = async (work: () => Promise<void>) => {
    if (locked || inFlight.current) return
    inFlight.current = true; setBusy(true); setError(null)
    try { await work() } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); refresh() }
    finally { inFlight.current = false; setBusy(false) }
  }
  const taskRespond = async (response: TaskResponse) => {
    if (!connection || task == null) throw new Error('This task is unavailable.')
    const reply = await connection.request({ t: 'taskRespond', project: item.project, task, response } as never)
    if (reply.t === 'error') throw new Error(reply.detail)
    if (reply.t !== 'taskResponded' || String(reply.project) !== item.project || String(reply.task) !== String(task)) throw new Error('cide did not confirm this response.')
    onClose()
  }
  const emptyDetail = { attachments: [], comments: [] } as unknown as TaskDetail
  return <Modal visible={open} animationType="slide" presentationStyle="fullScreen" onRequestClose={childId === null ? onClose : back}>
    <View style={{ flex: 1, backgroundColor: T.bg, paddingTop: insets.top, paddingBottom: insets.bottom }}>
      <View style={{ padding: 16, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderColor: T.border }}>
        {childId !== null && <ChipButton label="Back" onPress={back} />}
        <Text style={{ flex: 1, color: T.text, fontSize: 17 }}>{childId ?? item.title}</Text><ChipButton label="Close" onPress={onClose} />
      </View>
      <View style={{ flex: 1, display: childId === null ? 'flex' : 'none' }}>
        {question == null && move == null && !resolved && task != null
          ? <DecisionTask instance={instance} project={item.project} task={String(task)} detail={rootTask.detail} error={rootTask.error} imagesEnabled={imagesEnabled} onRetry={rootTask.refresh} onOpenTask={openTask} />
          : <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, gap: 16 }}>
            <Text style={{ color: T.dim }}>{item.label}</Text>
            {(error || request?.deliveryError) && <Text accessibilityRole="alert" style={{ color: T.bad }}>{error ?? request?.deliveryError}</Text>}
            {resolved && request ? <View style={{ gap: 12 }}><Text style={{ color: T.dim }}>{request.applying ? 'Applying your decision…' : request.wait ? 'Decision saved. Sending it to the original conversation…' : 'Decision saved. The agent continued working; delivery waits for its current turn to end.'}</Text>
              {savedAnswer(request).map((line, index) => <Text key={index} selectable style={{ color: T.text }}>{line}</Text>)}
            </View> : move ? <>
              <Text selectable style={{ color: T.text, lineHeight: 21 }}><TaskReferences text={request?.message ?? ''} onOpenTask={openTask} /></Text>
              <Text style={{ color: T.dim }}>Move selected tasks into {move.milestone}. Inbox tasks become Todo.</Text>
              {move.tasks.map((row) => <View key={String(row.id)} style={{ padding: 12, gap: 10, backgroundColor: T.panel, borderWidth: 1, borderColor: T.border, borderRadius: 8 }}>
                <Pressable accessibilityRole="checkbox" accessibilityLabel={`Include ${row.id}`} accessibilityState={{ checked: selected.includes(String(row.id)), disabled: locked }} disabled={locked}
                  onPress={() => setSelected((before) => before.includes(String(row.id)) ? before.filter((id) => id !== String(row.id)) : [...before, String(row.id)])}>
                  <Text style={{ color: selected.includes(String(row.id)) ? T.accent : T.text, lineHeight: 22 }}>{selected.includes(String(row.id)) ? 'Selected · ' : 'Include · '}{row.title}</Text>
                </Pressable>
                <Text style={{ color: T.dim, fontSize: 12 }}>{row.id} · {row.status} → {row.status === 'inbox' ? 'todo' : row.status}</Text>
                <View style={{ alignItems: 'flex-start' }}><ChipButton label={`View task ${row.id}`} onPress={() => openTask(String(row.id))} /></View>
              </View>)}
              <TextInput value={note} editable={!locked} onChangeText={setNote} multiline accessibilityLabel="Feedback on the proposed moves" placeholder="Optional feedback" placeholderTextColor={T.dim} style={inputStyle} />
            </> : question != null ? <QuestionAnswer instance={instance} project={item.project} task={String(task ?? request?.id ?? item.id)} question={question}
              detail={rootTask.detail ?? emptyDetail} enabled={!locked} imagesEnabled={imagesEnabled} onRefresh={refresh} draft={draft} onDraftChange={setDraft} onOpenTask={openTask}
              onSubmit={request ? async (answer) => { if (answer.kind === 'answer') await respond({ kind: 'answer', text: answer.text, selectedIds: answer.selectedIds ?? [] }) } : undefined} /> : null}
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: details }} onPress={() => setDetails((before) => !before)}><Text style={{ color: T.dim }}>Details and related tasks</Text></Pressable>
            {details && <View style={{ gap: 14 }}>
              {request && <Text style={{ color: T.dim }}>{request.origin.title} · {request.origin.harness} · {request.wait ? 'Waiting for your answer' : 'Independent work may continue'}</Text>}
              {request?.origin.session != null && <View style={{ alignItems: 'flex-start' }}><ChipButton label="Open original conversation" onPress={() => { onClose(); router.push(`/session/${instance}/${request.origin.session}`) }} /></View>}
              {task != null && <View style={{ alignItems: 'flex-start' }}><ChipButton label={`Open task ${task}`} onPress={() => openTask(String(task))} /></View>}
              {move && <View style={{ alignItems: 'flex-start' }}><ChipButton label={`Open milestone task ${move.goal}`} onPress={() => openTask(String(move.goal))} /></View>}
            </View>}
          </ScrollView>}
        {(error && question == null && move == null) && <Text accessibilityRole="alert" style={{ color: T.bad, padding: 16 }}>{error}</Text>}
        {sendingBack && !resolved && <TextInput value={note} onChangeText={setNote} multiline accessibilityLabel="What needs changing" placeholder="What needs changing" placeholderTextColor={T.dim} style={{ ...inputStyle, margin: 16 }} />}
        <View style={{ padding: 16, flexDirection: 'row', flexWrap: 'wrap', gap: 12, borderTopWidth: 1, borderColor: T.border }}>
          {request && !resolved && <ChipButton label="Cancel request" disabled={locked} onPress={() => void act(() => respond({ kind: 'cancel' }))} />}
          {move && !resolved && <><ChipButton label="Reject" disabled={locked} onPress={() => void act(() => respond({ kind: 'reject', note }))} />
            <ChipButton label={busy ? 'Applying…' : `Accept selected (${selected.length})`} disabled={locked || selected.length === 0} onPress={() => void act(() => respond({ kind: 'approve', selectedIds: selected as never, note }))} /></>}
          {!request && question == null && (sendingBack ? <><ChipButton label="Cancel" onPress={() => setSendingBack(false)} /><ChipButton label="Send back" disabled={locked || note.trim() === ''} onPress={() => void act(() => taskRespond({ kind: 'sendBack', note: note.trim() }))} /></>
            : <><ChipButton label="Send back" disabled={locked} onPress={() => setSendingBack(true)} /><ChipButton label="Accept" disabled={locked || rootTask.detail == null} onPress={() => void act(() => taskRespond({ kind: 'accept' }))} /></>)}
        </View>
      </View>
      {childId !== null && <DecisionTask instance={instance} project={item.project} task={childId} detail={child.detail} error={child.error} imagesEnabled={imagesEnabled} onRetry={child.refresh} onOpenTask={openTask} />}
    </View>
  </Modal>
}

const inputStyle = { color: T.text, backgroundColor: T.panel, borderWidth: 1, borderColor: T.border, borderRadius: 8, padding: 12, minHeight: 64, textAlignVertical: 'top' as const }
