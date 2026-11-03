import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import * as registry from '../store/registry'
import type { TaskDetail } from '../protocol/generated'

/** Reads only the task being inspected. Responses from a previous child card are discarded. */
export function useDecisionTask(instance: string, project: string, task: string | null) {
  const views = useSyncExternalStore(registry.subscribe, registry.getSnapshot)
  const view = views.find((v) => v.paired.instanceId === instance)
  const stamp = view?.tasks[project]?.find((row) => String(row.id) === task)?.updatedUnixMs
  const [retry, setRetry] = useState(0)
  const [state, setState] = useState<{ task: string | null; detail: TaskDetail | null; error: string | null }>({ task: null, detail: null, error: null })
  useEffect(() => {
    if (task === null) return
    let alive = true
    const connection = registry.connectionOf(instance)
    if (connection === undefined || view?.phase !== 'ready') { setState({ task, detail: null, error: 'Connect to cide to read this task.' }); return }
    void connection.request({ t: 'taskGet', project, task } as never).then((reply) => {
      if (!alive) return
      if (reply.t === 'error') throw new Error(reply.detail)
      if (reply.t !== 'task' || String(reply.project) !== project) throw new Error('cide did not return this task.')
      setState({ task, detail: reply.task ?? null, error: reply.task == null ? 'That task is no longer available.' : null })
    }).catch((reason: unknown) => { if (alive) setState({ task, detail: null, error: reason instanceof Error ? reason.message : String(reason) }) })
    return () => { alive = false }
  }, [instance, project, task, stamp, retry, view?.phase])
  const refresh = useCallback(() => setRetry((value) => value + 1), [])
  return { detail: state.task === task ? state.detail : null, error: state.task === task ? state.error : null, refresh }
}
