/**
 * A gate's (or a verify's) whole log, followed while it runs. (M91)
 *
 * The phone's `CheckLogModal`: the last MiB cide keeps of the check's output, re-read every
 * second while the check is running and kept at the end — unless the reader has scrolled up,
 * which is reading, and must not be yanked back down by the next line of a test run.
 *
 * Asked for, not pushed: a log can be a megabyte, and cide's milestone push carries only the
 * state. Whether the check is still running comes from that pushed state, so the polling stops
 * by itself the moment the verdict arrives.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import * as registry from '../../src/store/registry'
import { gateLine, gateOf } from '../../src/agents/milestones'
import { T } from '../../src/ui/theme'

const EVERY_MS = 1000

export default function CheckLogScreen() {
  const { iid, project, kind, key, title } = useLocalSearchParams<{
    iid: string
    project: string
    kind: string
    key: string
    title?: string
  }>()
  const views = useSyncExternalStore(registry.subscribe, registry.getSnapshot)
  const view = views.find((v) => v.paired.instanceId === iid)
  const connection = registry.connectionOf(iid)
  const milestones = view?.milestones[project] ?? null
  const gate = milestones === null || kind !== 'gate' ? undefined : gateOf(milestones, key)
  const running =
    kind === 'gate'
      ? (gate?.running ?? false)
      : (milestones?.verifies.find((v) => String(v.task) === key)?.running ?? false)

  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const scroller = useRef<ScrollView>(null)
  /** Following the end: true until the reader scrolls away from it, and again when they return. */
  const stuck = useRef(true)

  const read = useCallback(() => {
    if (connection === undefined || view?.phase !== 'ready') return
    connection
      .request({ t: 'checkLog', project: project as never, kind, key })
      .then((body) => {
        if (body.t === 'checkLog') {
          setText(body.text ?? null)
          setError(null)
        } else if (body.t === 'error') {
          setError(body.detail)
        }
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [connection, key, kind, project, view?.phase])

  // Once on opening and once more when a run ends — the verdict's last lines land after the
  // final poll otherwise — and every second while it runs.
  useEffect(() => {
    read()
    if (!running) return
    const timer = setInterval(read, EVERY_MS)
    return () => clearInterval(timer)
  }, [read, running])

  return (
    <View style={{ flex: 1, backgroundColor: T.bg }}>
      <Stack.Screen options={{ title: title ?? (kind === 'gate' ? 'Gate log' : 'Verify log') }} />
      <View style={{ padding: 12, gap: 4, borderBottomWidth: 1, borderColor: T.border }}>
        <Text style={{ color: running ? T.accent : T.dim, fontSize: 13 }}>
          {kind === 'gate' ? gateLine(running, gate?.last) : running ? 'verify running…' : 'verify'}
        </Text>
        {error !== null ? <Text style={{ color: T.bad, fontSize: 13 }}>{error}</Text> : null}
      </View>
      <ScrollView
        ref={scroller}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 10 }}
        scrollEventThrottle={64}
        onScroll={(event) => {
          const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
          stuck.current = contentSize.height - layoutMeasurement.height - contentOffset.y < 24
        }}
        onContentSizeChange={() => {
          if (stuck.current) scroller.current?.scrollToEnd({ animated: false })
        }}
      >
        <ScrollView horizontal>
          <Text selectable style={{ color: T.text, fontSize: 11, fontFamily: 'monospace' }}>
            {text ?? (running ? 'Waiting for output…' : 'This check has not run on that machine.')}
          </Text>
        </ScrollView>
      </ScrollView>
    </View>
  )
}
