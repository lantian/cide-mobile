import { useMemo, useSyncExternalStore } from 'react'
import { ScrollView, Text } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import * as registry from '../../../src/store/registry'
import * as choice from '../../../src/store/projectChoice'
import { decisions } from '../../../src/requests/model'
import { WaitingDecisions } from '../../../src/ui/WaitingDecisions'
import { ProjectPicker } from '../../../src/ui/ProjectPicker'
import { T } from '../../../src/ui/theme'

export default function WaitingScreen() {
  const { iid, request } = useLocalSearchParams<{ iid: string; request?: string }>()
  const views = useSyncExternalStore(registry.subscribe, registry.getSnapshot)
  const choices = useSyncExternalStore(choice.subscribe, choice.getSnapshot)
  const view = views.find((v) => v.paired.instanceId === iid)
  const project = view === undefined ? null : choice.resolve(iid, view.projects, choices)
  const items = useMemo(() => decisions(view?.userRequests ?? {}, view?.tasks ?? {}, project), [view?.userRequests, view?.tasks, project])
  return <><Stack.Screen options={{ title: 'Waiting for you' }} /><ScrollView style={{ flex: 1, backgroundColor: T.bg }} contentContainerStyle={{ padding: 16, gap: 16 }}>
    {view === undefined ? <Text style={{ color: T.dim }}>That instance is not paired any more.</Text> : <>
      <ProjectPicker projects={view.projects} chosen={project} waiting={Object.fromEntries(view.projects.map((p) => [String(p.id), decisions(view.userRequests, view.tasks, String(p.id)).length]))} onChoose={(next) => choice.choose(iid, next)} />
      {view.phase !== 'ready' && <Text style={{ color: T.warn }}>Connect to cide to send decisions. Your drafts stay here.</Text>}
      {!registry.connectionOf(iid)?.has('userRequests') && <Text style={{ color: T.dim }}>Update desktop cide to receive standalone questions and task-move proposals.</Text>}
      <WaitingDecisions instance={iid} items={items} enabled={view.phase === 'ready'} initialRequest={request} />
    </>}
  </ScrollView></>
}
