/**
 * Every attachment the phone has looked at: what state its download is in, and where its bytes
 * are on disk. (cide M136)
 *
 * Keyed by instance and attachment id, and deliberately **outside** the task screen. That screen
 * re-reads the whole task on every board change (see its header), and a cache that lived in its
 * state would drop every picture on every edit anybody made anywhere in the project. An
 * attachment's id names immutable bytes — cide never rewrites a file under its id — so a
 * download, once on disk, is never stale.
 *
 * # Memory
 *
 * JavaScript holds a download's base64 only between the last slice and the write. The pixels live
 * in `expo-image`, which decodes off the JS thread, downsamples to the size of the view, and drops
 * them when the view unmounts. The list does the unmounting; the queue (see `queue.ts`) makes an
 * unmounted tile's download stop.
 *
 * One store per key with `useSyncExternalStore`, as `term/rowStore.ts` does, so a progress tick
 * on one tile re-renders that tile and not the card.
 */
import { useEffect, useSyncExternalStore } from 'react'
import * as FileSystem from 'expo-file-system'
import type { ImageFormat } from '../protocol/generated'
import * as registry from '../store/registry'
import { Aborted, type AttachmentRef, download } from './fetchChunks'
import { FetchQueue } from './queue'
import { CACHE_BUDGET_BYTES, evictionPlan, mimeOf, safeName } from './files'

export type AttachmentState =
  | { s: 'idle' }
  | { s: 'loading'; done: number; total: number }
  | { s: 'ready'; uri: string; image: ImageFormat | null; mime: string; name: string }
  | { s: 'refused'; why: string }

const IDLE: AttachmentState = { s: 'idle' }

const states = new Map<string, AttachmentState>()
const listeners = new Map<string, Set<() => void>>()
/** Two at a time: one socket, and a phone decoding two pictures is already a phone working. */
const queue = new FetchQueue(2)
/** Which keys a disk lookup is running for, so two tiles do not look twice. */
const looking = new Set<string>()

export function keyOf(instance: string, attachment: string): string {
  return `${instance}/${attachment}`
}

function stateOf(key: string): AttachmentState {
  return states.get(key) ?? IDLE
}

function set(key: string, state: AttachmentState): void {
  states.set(key, state)
  for (const listener of listeners.get(key) ?? []) listener()
}

function subscribe(key: string, listener: () => void): () => void {
  let set = listeners.get(key)
  if (set === undefined) {
    set = new Set()
    listeners.set(key, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(key)
  }
}

// --- the disk ---------------------------------------------------------------------------------

const ROOT = `${FileSystem.cacheDirectory ?? ''}attachments/`

function dirOf(instance: string, attachment: string): string {
  return `${ROOT}${encodeURIComponent(instance)}/${encodeURIComponent(attachment)}/`
}

interface Meta {
  name: string
  image: ImageFormat | null
  bytes: number
}

/**
 * A finished download, or `null`. `meta.json` is written **after** the file, so its presence is
 * what "finished" means: a download killed halfway leaves a file and no meta, and is fetched
 * again rather than drawn half.
 */
async function readCached(instance: string, attachment: string): Promise<AttachmentState | null> {
  const dir = dirOf(instance, attachment)
  try {
    const info = await FileSystem.getInfoAsync(`${dir}meta.json`)
    if (!info.exists) return null
    const meta = JSON.parse(await FileSystem.readAsStringAsync(`${dir}meta.json`)) as Meta
    const uri = `${dir}${safeName(meta.name)}`
    if (!(await FileSystem.getInfoAsync(uri)).exists) return null
    return { s: 'ready', uri, image: meta.image, mime: mimeOf(meta.name, meta.image), name: meta.name }
  } catch {
    return null
  }
}

async function writeCached(
  instance: string,
  attachment: string,
  name: string,
  base64: string,
  meta: Meta,
): Promise<string> {
  const dir = dirOf(instance, attachment)
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true })
  const uri = `${dir}${safeName(name)}`
  await FileSystem.writeAsStringAsync(uri, base64, { encoding: FileSystem.EncodingType.Base64 })
  await FileSystem.writeAsStringAsync(`${dir}meta.json`, JSON.stringify(meta))
  return uri
}

let trimming: Promise<void> | null = null
let trimAgain = false

/** Trim the cache under its budget. Serialised: one pass at a time, and one more if asked meanwhile. */
function trim(): void {
  if (trimming !== null) {
    trimAgain = true
    return
  }
  trimming = trimOnce()
    .catch(() => undefined)
    .finally(() => {
      trimming = null
      if (trimAgain) {
        trimAgain = false
        trim()
      }
    })
}

async function trimOnce(): Promise<void> {
  if (!(await FileSystem.getInfoAsync(ROOT)).exists) return
  const entries: { dir: string; bytes: number; modifiedMs: number; key: string }[] = []
  for (const instance of await FileSystem.readDirectoryAsync(ROOT)) {
    const base = `${ROOT}${instance}/`
    for (const attachment of await FileSystem.readDirectoryAsync(base)) {
      const dir = `${base}${attachment}/`
      const info = await FileSystem.getInfoAsync(`${dir}meta.json`)
      const key = keyOf(decodeURIComponent(instance), decodeURIComponent(attachment))
      if (!info.exists) {
        // A download that died halfway, unless it is the one running now.
        if (stateOf(key).s !== 'loading') await FileSystem.deleteAsync(dir, { idempotent: true })
        continue
      }
      const meta = JSON.parse(await FileSystem.readAsStringAsync(`${dir}meta.json`)) as Meta
      entries.push({ dir, bytes: meta.bytes, modifiedMs: info.modificationTime * 1000, key })
    }
  }
  const doomed = new Set(evictionPlan(entries, CACHE_BUDGET_BYTES))
  for (const entry of entries) {
    if (!doomed.has(entry.dir)) continue
    await FileSystem.deleteAsync(entry.dir, { idempotent: true })
    // A tile still showing it keeps its decoded pixels; the next one to mount fetches again.
    if (stateOf(entry.key).s === 'ready') set(entry.key, IDLE)
  }
}

// --- wanting ----------------------------------------------------------------------------------

/**
 * Want this attachment on disk. Returns the release, which stops a download nobody else wants.
 *
 * A disk hit is answered without a queue slot — a cached picture should appear as it scrolls in,
 * not after two downloads of pictures further up.
 */
export function want(instance: string, ref: AttachmentRef, name: string): () => void {
  const key = keyOf(instance, ref.attachment)
  const now = stateOf(key)
  if (now.s === 'ready' || now.s === 'refused') return () => undefined

  let released = false
  let release: (() => void) | null = null
  const enqueue = () => {
    if (released) return
    release = queue.want(key, (signal) => fetchInto(instance, ref, name, key, signal))
  }
  if (looking.has(key) || now.s === 'loading') {
    enqueue()
  } else {
    looking.add(key)
    void readCached(instance, ref.attachment).then((hit) => {
      looking.delete(key)
      if (hit !== null) set(key, hit)
      else enqueue()
    })
  }
  return () => {
    released = true
    release?.()
  }
}

async function fetchInto(
  instance: string,
  ref: AttachmentRef,
  name: string,
  key: string,
  signal: { readonly aborted: boolean },
): Promise<void> {
  if (stateOf(key).s === 'ready') return
  const hit = await readCached(instance, ref.attachment)
  if (hit !== null) {
    set(key, hit)
    return
  }
  const connection = registry.connectionOf(instance)
  if (connection === undefined) {
    set(key, { s: 'refused', why: 'That cide is not connected.' })
    return
  }
  set(key, { s: 'loading', done: 0, total: 0 })
  try {
    const got = await download((body) => connection.request(body), ref, {
      signal,
      onProgress: (done, total) => set(key, { s: 'loading', done, total }),
    })
    const uri = await writeCached(instance, ref.attachment, name, got.base64, {
      name,
      image: got.image,
      bytes: got.bytes,
    })
    set(key, { s: 'ready', uri, image: got.image, mime: mimeOf(name, got.image), name })
    trim()
  } catch (error) {
    if (error instanceof Aborted) set(key, IDLE)
    else set(key, { s: 'refused', why: error instanceof Error ? error.message : String(error) })
  }
}

/** Forget a refusal, so the next `want` tries again — a tap on a failed tile. */
export function retry(instance: string, attachment: string): void {
  const key = keyOf(instance, attachment)
  if (stateOf(key).s === 'refused') set(key, IDLE)
}

/**
 * Fetch now and wait for the answer — a tap on a file chip, or Save in the viewer. Holds its own
 * want until the download ends, so scrolling the chip away does not cancel what was asked for.
 */
export function fetchNow(
  instance: string,
  ref: AttachmentRef,
  name: string,
): Promise<AttachmentState> {
  retry(instance, ref.attachment)
  const key = keyOf(instance, ref.attachment)
  return new Promise((resolve) => {
    let release: (() => void) | null = null
    const settle = (): boolean => {
      const now = stateOf(key)
      if (now.s !== 'ready' && now.s !== 'refused') return false
      unsubscribe()
      release?.()
      resolve(now)
      return true
    }
    const unsubscribe = subscribe(key, () => void settle())
    if (!settle()) release = want(instance, ref, name)
  })
}

/**
 * This attachment's state, and — when `auto` — a want held for as long as the calling component
 * is mounted. `auto` is how a picture tile loads when it scrolls into view and stops when it
 * scrolls out: the list mounts and unmounts it.
 */
export function useAttachment(
  instance: string,
  ref: AttachmentRef,
  name: string,
  auto: boolean,
): AttachmentState {
  const key = keyOf(instance, ref.attachment)
  const state = useSyncExternalStore(
    (listener) => subscribe(key, listener),
    () => stateOf(key),
  )
  const { project, task, attachment } = ref
  useEffect(() => {
    if (!auto) return undefined
    return want(instance, { project, task, attachment }, name)
  }, [auto, instance, project, task, attachment, name])
  return state
}

// Once per app start: whatever an earlier run left over the budget.
trim()
