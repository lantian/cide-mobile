import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { AppState, FlatList, Keyboard, KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from 'react-native'
import { Stack, useFocusEffect, useRouter } from 'expo-router'
import * as Clipboard from 'expo-clipboard'
import * as registry from '../store/registry'
import * as notify from '../notify/driver'
import { T } from '../ui/theme'
import { Markdown } from '../ui/Markdown'
import { Selection } from '../term/ui/Selection'
import { FOLLOWING, grabbed, moved, remainingOf, settled, shouldFollow } from '../term/follow'
import { closeConsole } from '../consoles/close'
import { ConsoleAttachments } from '../consoles/Attachments'
import { askConversation, activity, conversationStore, operationId } from './model'
import type { ConversationItem, ConversationPage, ProjectId } from '../protocol/generated'

interface Props { iid: string; project: string; id: string; readOnly?: boolean; onTerminal?: (() => void) | undefined; followSession?: string | undefined; pane?: string | undefined }
export function Conversation({ iid, project, id, readOnly = false, onTerminal, followSession, pane }: Props) {
  const store = conversationStore(iid, project, id)
  const held = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const views = useSyncExternalStore(registry.subscribe, registry.getSnapshot)
  const view = views.find(v => v.paired.instanceId === iid)
  const connection = registry.connectionOf(iid)
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [action, setAction] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<string | null>(null)
  const [older, setOlder] = useState(false)
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const [following, setFollowing] = useState(true)
  const list = useRef<FlatList<ConversationItem>>(null)
  const follow = useRef(FOLLOWING)
  const scrollFrame = useRef<number | null>(null)
  const reading = useRef(false)
  const pendingRead = useRef<'older' | 'latest' | null>(null)
  const focused = useRef(false)
  const mounted = useRef(true)
  const acting = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const lifetime = useRef(0)
  const known = held.page?.conversation
  const session = known?.session
  const current = view?.sessions.find(s => s.session === session && (pane === undefined || session !== followSession || String(s.pane) === pane))
  const state = current?.state ?? known?.state
  const stateName = state?.state
  const ready = view?.phase === 'ready'
  const latestState = useRef(stateName)
  latestState.current = stateName

  const cancelScroll = useCallback(() => {
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current)
    scrollFrame.current = null
  }, [])
  const scrollToLatest = useCallback(() => {
    if (!shouldFollow(follow.current) || scrollFrame.current !== null) return
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null
      if (!focused.current || !shouldFollow(follow.current)) return
      // FlatList.scrollToEnd estimates the last row using average message heights.
      // The native scroller knows the actual end, including padding. Repeat when
      // newly visible rows are measured, rather than settling on that estimate.
      const scroller = list.current?.getNativeScrollRef()
      if (scroller && 'scrollToEnd' in scroller && typeof scroller.scrollToEnd === 'function') scroller.scrollToEnd({ animated: false })
    })
  }, [])
  useLayoutEffect(() => {
    cancelScroll()
    follow.current = FOLLOWING
    setFollowing(true)
    scrollToLatest()
    return cancelScroll
  }, [store, held.page?.generation, cancelScroll, scrollToLatest])
  useEffect(() => {
    const keyboard = Keyboard.addListener('keyboardDidShow', scrollToLatest)
    return () => keyboard.remove()
  }, [scrollToLatest])

  const refresh = useCallback(async function refresh(history = false): Promise<void> {
    if (!connection || !focused.current || AppState.currentState !== 'active') return
    if (reading.current) {
      if (history) pendingRead.current = 'older'
      else if (pendingRead.current === null) pendingRead.current = 'latest'
      return
    }
    reading.current = true
    const epoch = lifetime.current
    const before = store.getSnapshot()
    try {
      const response = await askConversation(connection, {
        action: 'read', project: project as ProjectId, id: before.page?.conversation.id ?? id,
        generation: before.page?.generation ?? null,
        before: history ? before.before : null,
        after: history ? null : before.after,
        ...(followSession === undefined ? {} : { followSession: followSession as import('../protocol/generated').SessionId }),
      })
      if (epoch !== lifetime.current || !focused.current) return
      if (response.action !== 'read') throw new Error('cide did not return conversation history.')
      store.accept(response.page, history)
      setError(null)
    } catch (e) {
      if (epoch === lifetime.current && focused.current) setError(String(e instanceof Error ? e.message : e))
    } finally {
      reading.current = false
      const pending = pendingRead.current
      pendingRead.current = null
      if (pending !== null && epoch === lifetime.current && focused.current) void refresh(pending === 'older')
    }
  }, [connection, store, project, id, followSession])

  useFocusEffect(useCallback(() => {
    focused.current = true
    const shown = store.getSnapshot().page?.conversation.session
    if (shown && connection && ready && AppState.currentState === 'active') {
      connection.acknowledge(shown); registry.acknowledged(iid, shown); notify.watching(shown)
    }
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      if (ready) await refresh()
      if (stopped || AppState.currentState !== 'active') return
      const page = store.getSnapshot().page
      if (!page || page.conversation.session !== null) timer = setTimeout(() => { void poll() }, latestState.current === 'busy' ? 2000 : 5000)
    }
    void poll()
    const subscription = AppState.addEventListener('change', phase => {
      if (timer !== undefined) clearTimeout(timer)
      if (phase === 'active') void poll()
    })
    return () => {
      stopped = true; focused.current = false; lifetime.current++
      if (timer !== undefined) clearTimeout(timer)
      subscription.remove()
      notify.watching(null)
    }
  }, [ready, refresh, store, connection, iid]))

  useEffect(() => { if (ready && focused.current) void refresh() }, [ready, stateName, session, refresh])

  useEffect(() => {
    if (!session || !connection || !ready || !focused.current || AppState.currentState !== 'active') return
    connection.acknowledge(session)
    registry.acknowledged(iid, session)
    notify.watching(session)
    return () => notify.watching(null)
  }, [session, connection, ready, iid, view?.awaiting.find(a => a.session === session)?.sinceUnixMs])

  const terminal = onTerminal ?? (() => {
    if (session) router.push(`/session/${iid}/${session}?terminal=1${readOnly ? '&readOnly=1' : ''}` as never)
  })
  const perform = async (resume: boolean) => {
    if (!connection || !known || acting.current) return
    acting.current = true
    const text = store.getSnapshot().draft
    setAction(true); setActionError(null); setReceipt(null)
    try {
      const response = await askConversation(connection, resume
        ? { action: 'resume', project: project as ProjectId, id: known.id, operation: operationId() }
        : { action: 'send', project: project as ProjectId, id: known.id, session: known.session!, operation: operationId(), text })
      if (response.action !== 'receipt') throw new Error('Delivery was not acknowledged. Check history before resending.')
      if (!resume && store.getSnapshot().draft === text && store.getSnapshot().page?.conversation.id === known.id) store.draft('')
      if (mounted.current) setReceipt(resume ? 'Conversation resumed' : response.status === 'queued' ? 'Queued by harness' : 'Submitted to harness')
      if (response.session) {
        const page = store.getSnapshot().page
        if (page) store.accept({ ...page, reset: false, items: [], conversation: { ...page.conversation, session: response.session, writable: true, canResume: false } })
      }
      if (mounted.current) await refresh()
    } catch (e) {
      if (mounted.current) setActionError(resume
        ? `${String(e instanceof Error ? e.message : e)} Refresh to check whether the conversation resumed before retrying.`
        : `${String(e instanceof Error ? e.message : e)} Your draft is kept. Messages are never automatically resent.`)
    } finally { acting.current = false; if (mounted.current) setAction(false) }
  }
  const canSend = !readOnly && known?.writable && ready && !action && !['paused', 'awaitingPermission', 'exited'].includes(stateName ?? '')
  return <KeyboardAvoidingView style={{ flex: 1, backgroundColor: T.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <Stack.Screen options={{ title: known?.title || 'Conversation' }} />
    <Selection text={snapshot} onDone={() => setSnapshot(null)} />
    <View style={{ padding: 12, gap: 8, backgroundColor: T.panel }}>
      <Text style={{ color: stateName === 'busy' ? T.accent : T.dim }} accessibilityLiveRegion="polite">
        {known?.harness ? `${known.harness} · ` : ''}{ready ? state ? activity(state) : known ? 'Past conversation' : 'Loading…' : 'Disconnected'}{!ready && known?.state ? ` · last known: ${activity(known.state)}` : ''}
      </Text>
      <View style={{ flexDirection: 'row', gap: 20 }}>
        <Pressable onPress={() => { void refresh() }}><Text style={{ color: T.accent }}>Refresh</Text></Pressable>
        <Pressable onPress={() => setSnapshot(held.items.map(i => `${i.kind === 'user' ? 'You' : i.tool ?? i.kind}\n${i.text}`).join('\n\n'))}><Text style={{ color: T.accent }}>Select text</Text></Pressable>
        {session ? <Pressable onPress={terminal}><Text style={{ color: T.accent }}>Terminal</Text></Pressable> : null}
        {!readOnly && current?.canClose === true && connection?.has('consoleClose') ? <Pressable disabled={action} onPress={() => {
          if (acting.current) return
          acting.current = true
          setAction(true); setActionError(null)
          void closeConsole(connection, current).then(() => router.back()).catch(e => { if (mounted.current) setActionError(String(e instanceof Error ? e.message : e)) }).finally(() => { acting.current = false; if (mounted.current) setAction(false) })
        }}><Text style={{ color: T.dim }}>Close console</Text></Pressable> : null}
      </View>
    </View>
    {error ? <Text selectable style={{ color: T.bad, padding: 12 }}>{error}</Text> : null}
    {actionError ? <Text selectable style={{ color: T.bad, padding: 12 }}>{actionError}</Text> : null}
    {receipt ? <Text style={{ color: T.good, paddingHorizontal: 12 }}>{receipt}</Text> : null}
    {held.page?.detail ? <Text style={{ color: T.dim, padding: 12 }}>{held.page.detail}</Text> : null}
    <FlatList<ConversationItem>
      key={JSON.stringify([project, id, held.page?.generation])}
      ref={list} data={held.items as ConversationItem[]} keyExtractor={item => item.id}
      initialScrollIndex={Math.max(0, held.items.length - 1)}
      onScrollToIndexFailed={scrollToLatest}
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 12, gap: 12 }}
      removeClippedSubviews={false}
      keyboardShouldPersistTaps="always"
      scrollEventThrottle={16}
      maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
      onLayout={scrollToLatest}
      onScrollBeginDrag={() => { cancelScroll(); follow.current = grabbed(follow.current) }}
      onScroll={event => { follow.current = moved(follow.current, remainingOf(event.nativeEvent)); setFollowing(follow.current.stuck) }}
      onScrollEndDrag={event => { follow.current = settled(remainingOf(event.nativeEvent)); setFollowing(follow.current.stuck); scrollToLatest() }}
      onMomentumScrollBegin={() => { cancelScroll(); follow.current = grabbed(follow.current) }}
      onMomentumScrollEnd={event => { follow.current = settled(remainingOf(event.nativeEvent)); setFollowing(follow.current.stuck); scrollToLatest() }}
      onContentSizeChange={scrollToLatest}
      ListHeaderComponent={held.before !== null ? <Pressable disabled={older} onPress={() => { cancelScroll(); follow.current = { stuck: false, driving: false }; setFollowing(false); setOlder(true); void refresh(true).finally(() => setOlder(false)) }} style={{ padding: 12 }}><Text style={{ color: T.accent }}>{older ? 'Loading…' : 'Load earlier messages'}</Text></Pressable> : null}
      ListEmptyComponent={<Text style={{ color: T.dim }}>{held.page ? 'No saved messages yet.' : 'Loading conversation…'}</Text>}
      renderItem={({ item }) => <Message iid={iid} project={project} page={held.page} item={item} />}
    />
    {!following ? <Pressable onPress={() => { follow.current = FOLLOWING; setFollowing(true); scrollToLatest() }} style={{ padding: 12 }}><Text style={{ color: T.accent }}>Jump to latest</Text></Pressable> : null}
    {!readOnly && held.page?.prompt && connection && session ? <View style={{ padding: 12, gap: 8, backgroundColor: T.panel }}>
      <Text selectable style={{ color: T.warn }}>{held.page.prompt.question.join('\n')}</Text>
      {held.page.prompt.options.map(option => <Pressable key={option.number} onPress={() => {
        connection.tell({ t: 'answerPrompt', session, option: option.number, expectScreen: held.page!.prompt!.digest }); void refresh()
      }}><Text style={{ color: T.accent }}>{option.label}</Text></Pressable>)}
    </View> : stateName === 'awaitingPermission' ? <Pressable onPress={terminal} style={{ padding: 12 }}><Text style={{ color: T.warn }}>Open Terminal to answer this approval</Text></Pressable> : null}
    {!readOnly && known?.canResume && connection?.has('conversationResume') ? <Pressable disabled={action || !ready} onPress={() => { void perform(true) }} style={{ padding: 16 }}><Text style={{ color: T.accent }}>{action ? 'Resuming…' : 'Resume conversation'}</Text></Pressable> : null}
    {!readOnly && session && known?.writable ? <View style={{ backgroundColor: T.panel, padding: 12, gap: 8 }}>
      {connection?.has('consoleUpload') ? <ConsoleAttachments connection={connection} session={session} onInsert={path => store.draft(`${store.getSnapshot().draft}${store.getSnapshot().draft ? '\n' : ''}${path}`)} /> : null}
      <TextInput multiline value={held.draft} onChangeText={text => store.draft(text)} placeholder="Message this session" placeholderTextColor={T.dim} style={{ color: T.text, minHeight: 48, maxHeight: 150, padding: 8, borderWidth: 1, borderColor: T.border }} />
      <Pressable disabled={!canSend || held.draft.trim() === ''} onPress={() => { void perform(false) }}><Text style={{ color: canSend ? T.accent : T.dim }}>{action ? 'Sending…' : stateName === 'busy' ? 'Send while working' : 'Send'}</Text></Pressable>
    </View> : null}
  </KeyboardAvoidingView>
}

function Message({ iid, project, page, item }: { iid: string; project: string; page: ConversationPage | null; item: ConversationItem }) {
  const [expanded, setExpanded] = useState(false)
  const [detail, setDetail] = useState('')
  const [next, setNext] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const version = useRef(0)
  useEffect(() => { version.current++; setDetail(''); setNext(null); setExpanded(false); setLoading(false); setError(null); return () => { version.current++ } }, [page?.generation, item.status])
  const load = async (offset = 0) => {
    const connection = registry.connectionOf(iid)
    if (!connection || !page || loading) return
    const epoch = version.current
    setLoading(true); setError(null)
    try {
      const answer = await askConversation(connection, { action: 'detail', project: project as ProjectId, id: page.conversation.id, generation: page.generation, item: item.id, offset })
      if (epoch !== version.current) return
      if (answer.action !== 'detail') throw new Error('Details could not be read.')
      setDetail(before => offset === 0 ? answer.text : before + answer.text); setNext(answer.next)
    } catch (e) { if (epoch === version.current) setError(String(e instanceof Error ? e.message : e)) }
    finally { if (epoch === version.current) setLoading(false) }
  }
  const copy = async () => {
    const epoch = version.current
    setLoading(true); setError(null)
    try {
      let text = item.text
      const connection = registry.connectionOf(iid)
      if (item.detailAvailable && page && connection) {
        text = ''
        let offset: number | null = 0
        while (offset !== null) {
          const answer = await askConversation(connection, { action: 'detail', project: project as ProjectId, id: page.conversation.id, generation: page.generation, item: item.id, offset })
          if (epoch !== version.current) return
          if (answer.action !== 'detail') throw new Error('The full message could not be read.')
          text += answer.text; offset = answer.next
        }
      }
      await Clipboard.setStringAsync(text)
    } catch (e) { if (epoch === version.current) setError(String(e instanceof Error ? e.message : e)) }
    finally { if (epoch === version.current) setLoading(false) }
  }
  return <View style={{ padding: 12, gap: 8, borderRadius: 8, backgroundColor: item.kind === 'user' ? '#172537' : T.panel }}>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
      <Text style={{ color: item.kind === 'error' ? T.bad : T.dim }}>{item.kind === 'user' ? 'You' : item.kind === 'assistant' ? 'Assistant' : item.tool ?? item.kind}{item.status ? ` · ${item.status}` : ''}</Text>
      <Pressable disabled={loading} onPress={() => { void copy() }}><Text style={{ color: T.accent }}>Copy</Text></Pressable>
    </View>
    {item.kind === 'tool' ? null : <Markdown text={item.text} selectable copyCode />}
    {item.detailAvailable ? <Pressable onPress={() => { setExpanded(value => !value); if (!expanded) void load() }}><Text style={{ color: T.accent }}>{expanded ? 'Hide details' : item.kind === 'tool' ? 'Show command and result' : 'Show full message'}</Text></Pressable> : null}
    {expanded ? <><Text accessible selectable style={{ color: T.text, fontFamily: 'monospace' }}>{detail || (loading ? 'Loading…' : '')}</Text>{next !== null ? <Pressable disabled={loading} onPress={() => { void load(next) }}><Text style={{ color: T.accent }}>Load more</Text></Pressable> : null}</> : null}
    {error ? <Text style={{ color: T.bad }}>{error}</Text> : null}
  </View>
}
