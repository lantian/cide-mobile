import { useEffect, useRef, useState } from 'react'
import { Image, Pressable, ScrollView, Text, View } from 'react-native'
import * as DocumentPicker from 'expo-document-picker'
import * as ImagePicker from 'expo-image-picker'
import * as FileSystem from 'expo-file-system'
import type { Connection } from '../net/connection'
import type { SessionId } from '../protocol/generated'
import { T } from '../ui/theme'
import { quotePath, uploadFile, UploadCancelled } from './upload'
interface Picked {
  uri: string
  name: string
  image: boolean
}
interface Item extends Picked {
  id: number
  state: 'queued' | 'uploading' | 'inserting' | 'inserted' | 'error' | 'cancelled'
  progress: number
  path?: string
  error?: string | undefined
}
export function ConsoleAttachments({
  connection,
  session,
  expectScreen,
  onInsert,
}: {
  connection: Connection
  session: SessionId
  expectScreen?: string | undefined
  onInsert?: ((path: string) => void) | undefined
}) {
  const [items, setItems] = useState<Item[]>([])
  const [choosing, setChoosing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const next = useRef(1),
    queue = useRef(Promise.resolve()),
    mounted = useRef(true)
  const pending = useRef(new Set<number>())
  const signals = useRef(new Map<number, { aborted: boolean }>())
  const currentPrompt = useRef(expectScreen)
  currentPrompt.current = expectScreen
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      for (const flag of signals.current.values()) flag.aborted = true
    }
  }, [])
  const patch = (id: number, changes: Partial<Item>) => {
    if (mounted.current)
      setItems((held) => held.map((item) => (item.id === id ? { ...item, ...changes } : item)))
  }
  const perform = async (item: Item) => {
    const signal = signals.current.get(item.id)!
    if (signal.aborted || !mounted.current) return
    try {
      let path = item.path
      if (path === undefined) {
        patch(item.id, { state: 'uploading', error: undefined })
        const info = await FileSystem.getInfoAsync(item.uri)
        if (!info.exists || info.isDirectory)
          throw new Error('The selected file is no longer available.')
        path = await uploadFile(
          (body) => connection.request(body),
          session,
          {
            name: item.name,
            size: info.size,
            read: (position, length) =>
              FileSystem.readAsStringAsync(item.uri, {
                encoding: FileSystem.EncodingType.Base64,
                position,
                length,
              }),
          },
          {
            signal,
            onProgress: (done, total) =>
              patch(item.id, { progress: total === 0 ? 1 : done / total }),
          },
        )
        patch(item.id, { path, progress: 1 })
      }
      if (signal.aborted || !mounted.current) return
      if (onInsert !== undefined) {
        onInsert(quotePath(path))
        patch(item.id, { state: 'inserted' })
        return
      }
      patch(item.id, { state: 'inserting' })
      // A paste is requested once and positively acknowledged. Disconnects never replay it.
      const seq = connection.nextSeq()
      const body = await connection.request({
        t: 'paste',
        session,
        text: `${quotePath(path)} `,
        seq,
        ...(currentPrompt.current === undefined ? {} : { expectScreen: currentPrompt.current }),
      })
      if (body.t === 'error') throw new Error(body.detail)
      if (body.t !== 'pasteAccepted' || body.session !== session || body.seq !== seq)
        throw new Error('Insertion was not confirmed. Check the console before retrying.')
      patch(item.id, { state: 'inserted' })
    } catch (e) {
      patch(item.id, {
        state: e instanceof UploadCancelled || signal.aborted ? 'cancelled' : 'error',
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }
  const enqueue = (item: Item): boolean => {
    if (pending.current.has(item.id)) return false
    pending.current.add(item.id)
    signals.current.set(item.id, { aborted: false })
    queue.current = queue.current
      .then(() => perform(item))
      .catch(() => undefined)
      .finally(() => pending.current.delete(item.id))
    return true
  }
  const add = (picked: Picked[]) => {
    const added: Item[] = picked.map((file) => ({
      ...file,
      id: next.current++,
      state: 'queued',
      progress: 0,
    }))
    setItems((held) => [...held, ...added])
    added.forEach(enqueue)
  }
  const choose = async (source: 'files' | 'photos' | 'camera') => {
    try {
      setError(null)
      if (source === 'files') {
        const result = await DocumentPicker.getDocumentAsync({
          multiple: true,
          copyToCacheDirectory: true,
          type: '*/*',
        })
        if (!result.canceled)
          add(
            result.assets.map((file) => ({
              uri: file.uri,
              name: file.name,
              image: file.mimeType?.startsWith('image/') === true,
            })),
          )
        return
      }
      if (source === 'camera' && !(await ImagePicker.requestCameraPermissionsAsync()).granted)
        throw new Error('Allow camera access to attach a photo.')
      const result =
        source === 'camera'
          ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 })
          : await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ['images'],
              allowsMultipleSelection: true,
              quality: 1,
            })
      if (!result.canceled)
        add(
          result.assets.map((file) => ({
            uri: file.uri,
            name: file.fileName ?? file.uri.split('/').pop() ?? 'photo.jpg',
            image: true,
          })),
        )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <View style={{ paddingHorizontal: 8, backgroundColor: T.panel }}>
      <Pressable
        accessibilityLabel="Attach files or images"
        style={{ paddingVertical: 8 }}
        onPress={() => setChoosing((value) => !value)}
      >
        <Text style={{ color: T.accent }}>＋ Attach</Text>
      </Pressable>
      {choosing ? (
        <View style={{ flexDirection: 'row', gap: 16, paddingBottom: 12 }}>
          {(['files', 'photos', 'camera'] as const).map((source) => (
            <Pressable
              key={source}
              onPress={() => {
                setChoosing(false)
                void choose(source)
              }}
            >
              <Text style={{ color: T.accent }}>
                {source === 'files' ? 'Files' : source === 'photos' ? 'Photos' : 'Camera'}
              </Text>
            </Pressable>
          ))}
          <Pressable onPress={() => setChoosing(false)}>
            <Text style={{ color: T.dim }}>Cancel</Text>
          </Pressable>
        </View>
      ) : null}
      {error === null ? null : <Text style={{ color: T.bad }}>{error}</Text>}
      <ScrollView horizontal contentContainerStyle={{ gap: 8 }}>
        {items.map((item) => (
          <View
            key={item.id}
            style={{
              borderWidth: 1,
              borderColor: T.border,
              borderRadius: 7,
              padding: 8,
              maxWidth: 260,
              marginBottom: 8,
            }}
          >
            {item.image ? (
              <Image source={{ uri: item.uri }} style={{ width: 48, height: 48 }} />
            ) : null}
            <Text numberOfLines={1} style={{ color: T.text }}>
              {item.name}
            </Text>
            <Text style={{ color: item.state === 'error' ? T.bad : T.dim }}>
              {item.state === 'uploading'
                ? `Uploading ${Math.round(item.progress * 100)}%`
                : item.state === 'inserted'
                  ? 'Inserted · press Enter to send'
                  : item.state}
            </Text>
            {item.error === undefined ? null : (
              <Text style={{ color: T.bad }}>
                {item.path === undefined
                  ? item.error
                  : `${item.error} Check the console before inserting again.`}
              </Text>
            )}
            {item.state === 'error' || item.state === 'cancelled' ? (
              <Pressable
                onPress={() => {
                  if (enqueue(item)) patch(item.id, { state: 'queued' })
                }}
              >
                <Text style={{ color: T.accent }}>
                  {item.path === undefined ? 'Retry upload' : 'Insert again'}
                </Text>
              </Pressable>
            ) : null}
            {item.state === 'queued' || item.state === 'uploading' ? (
              <Pressable
                onPress={() => {
                  const signal = signals.current.get(item.id)
                  if (signal) signal.aborted = true
                  patch(item.id, { state: 'cancelled' })
                }}
              >
                <Text style={{ color: T.dim }}>Cancel</Text>
              </Pressable>
            ) : null}
            {item.state === 'inserted' || item.state === 'cancelled' || item.state === 'error' ? (
              <Pressable
                onPress={() => setItems((held) => held.filter((entry) => entry.id !== item.id))}
              >
                <Text style={{ color: T.dim }}>Dismiss</Text>
              </Pressable>
            ) : null}
          </View>
        ))}
      </ScrollView>
    </View>
  )
}
