import { useCallback, useState, useSyncExternalStore } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { Stack, useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router'
import * as registry from '../../../src/store/registry'
import * as choice from '../../../src/store/projectChoice'
import { ProjectPicker } from '../../../src/ui/ProjectPicker'
import { T } from '../../../src/ui/theme'
import { activity, askConversation } from '../../../src/conversations/model'
import type { ConversationSummary } from '../../../src/protocol/generated'
export default function History() {
  const { iid } = useLocalSearchParams<{ iid: string }>()
  const views = useSyncExternalStore(registry.subscribe, registry.getSnapshot)
  const choices = useSyncExternalStore(choice.subscribe, choice.getSnapshot)
  const view = views.find(v => v.paired.instanceId === iid)
  const project = choice.resolve(iid, view?.projects ?? [], choices)
  const [rows, setRows] = useState<ConversationSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()
  const ready = view?.phase === 'ready'
  const projects = view?.projects
  useFocusEffect(useCallback(() => {
    let active = true
    const connection = registry.connectionOf(iid)
    if (ready && connection && projects) {
      void Promise.all(projects.filter(p => project === null || p.id === project).map(async p => {
        const response = await askConversation(connection, { action: 'list', project: p.id })
        if (response.action !== 'list') throw new Error('cide did not return session history.')
        return response.conversations
      })).then(results => { if (active) { setRows(results.flat().sort((a, b) => b.updatedUnixMs - a.updatedUnixMs)); setError(null) } }).catch(e => { if (active) setError(String(e instanceof Error ? e.message : e)) })
    }
    return () => { active = false }
  }, [iid, project, ready, projects]))
  return <View style={{ flex: 1, backgroundColor: T.bg }}>
    <Stack.Screen options={{ title: 'Session history' }} />
    <ProjectPicker projects={projects ?? []} chosen={project} waiting={{}} onChoose={next => choice.choose(iid, next)} />
    {!ready ? <Text style={{ color: T.warn, padding: 12 }}>Disconnected</Text> : null}
    {error ? <Text style={{ color: T.bad, padding: 12 }}>{error}</Text> : null}
    <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>
      {rows.map(row => <Pressable key={`${row.project}:${row.harness}:${row.id}`} onPress={() => router.push(`/conversation/${iid}/${row.project}/${encodeURIComponent(row.id)}` as never)} style={{ padding: 14, gap: 6, borderRadius: 8, backgroundColor: T.panel }}>
        <Text style={{ color: T.text, fontSize: 16 }}>{row.title || 'Conversation'}</Text>
        <Text style={{ color: T.dim }}>{row.harness} · {row.session ? activity(row.state) : 'Past session'} · {new Date(row.updatedUnixMs).toLocaleString()}</Text>
        {row.preview ? <Text numberOfLines={2} style={{ color: T.dim }}>{row.preview}</Text> : null}
      </Pressable>)}
      {rows.length === 0 && !error ? <Text style={{ color: T.dim }}>No recorded conversations in this project.</Text> : null}
    </ScrollView>
  </View>
}
