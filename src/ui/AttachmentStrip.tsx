/**
 * A task's or a comment's attachments: pictures as tiles, everything else as chips. (cide M136)
 *
 * The tiles are a horizontal `FlatList`, so one comment with forty screenshots mounts the handful
 * on screen and not forty — the card around it is a vertical `FlatList` for the same reason, and
 * the two together are what keep a long card from freezing the phone. A tile loads its picture
 * while it is mounted and stops when it is not (see `attachments/store.ts`); files wait for a tap.
 *
 * `kind` from the record only decides where an attachment is *laid out*. Whether it is drawn as a
 * picture is decided by what cide sniffed from the bytes (`image` on the first slice) — a tile
 * whose file turns out not to be an image shows its name instead, never a broken picture.
 */
import { memo, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native'
import { Image } from 'expo-image'
import type { TaskAttachment } from '../protocol/generated'
import { AUTO_LOAD_BYTES, sizeLabel } from '../attachments/files'
import { type AttachmentState, fetchNow, retry, useAttachment } from '../attachments/store'
import { saveToPhone, share } from '../attachments/export'
import { ChipButton } from './ChipButton'
import { ImageViewer } from './ImageViewer'
import { T } from './theme'

export const TILE = 96

export interface StripProps {
  instance: string
  project: string
  task: string
  attachments: readonly TaskAttachment[]
  /** The cide on the other end serves bytes (`features` carries `"attachments"`). */
  enabled: boolean
}

export function AttachmentStrip({ instance, project, task, attachments, enabled }: StripProps) {
  const [viewing, setViewing] = useState<number | null>(null)
  // A delete keeps the record and removes the file: a tombstone, not an attachment.
  const live = attachments.filter((a) => !a.deleted)
  if (live.length === 0) return null

  if (!enabled) {
    // An older cide sends the records and cannot send the bytes. The names, and why.
    return (
      <View style={{ gap: 2 }}>
        {live.map((a) => (
          <Text key={String(a.id)} style={{ color: T.dim, fontSize: 13 }}>
            📎 {a.name} · {sizeLabel(Number(a.bytes))}
          </Text>
        ))}
        <Text style={{ color: T.dim, fontSize: 12, fontStyle: 'italic' }}>
          This cide is too old to send attachments to the phone.
        </Text>
      </View>
    )
  }

  const images = live.filter((a) => a.kind === 'image')
  const files = live.filter((a) => a.kind !== 'image')
  const ref = (a: TaskAttachment) => ({ project, task, attachment: String(a.id) })

  return (
    <View style={{ gap: 8 }}>
      {images.length > 0 && (
        <FlatList
          horizontal
          data={images}
          keyExtractor={(a) => String(a.id)}
          renderItem={({ item, index }) => (
            <AttachmentTile
              instance={instance}
              attachment={item}
              refOf={ref}
              onOpen={() => setViewing(index)}
            />
          )}
          ItemSeparatorComponent={Gap}
          showsHorizontalScrollIndicator={false}
          // A strip is a few screens wide at most; what matters is that a long one does not
          // mount, and so does not load, what is off to the right.
          initialNumToRender={4}
          maxToRenderPerBatch={3}
          windowSize={3}
          removeClippedSubviews
          getItemLayout={(_, index) => ({ length: TILE + 8, offset: (TILE + 8) * index, index })}
        />
      )}
      {files.map((a) => (
        <FileChip key={String(a.id)} instance={instance} attachment={a} target={ref(a)} />
      ))}
      {viewing !== null && (
        <ImageViewer
          instance={instance}
          images={images}
          refOf={ref}
          start={viewing}
          onClose={() => setViewing(null)}
        />
      )}
    </View>
  )
}

function Gap() {
  return <View style={{ width: 8 }} />
}

export const AttachmentTile = memo(function AttachmentTile({
  instance,
  attachment,
  refOf,
  onOpen,
}: {
  instance: string
  attachment: TaskAttachment
  refOf: (a: TaskAttachment) => { project: string; task: string; attachment: string }
  onOpen: () => void
}) {
  const [failed, setFailed] = useState(false)
  const bytes = Number(attachment.bytes)
  const auto = bytes <= AUTO_LOAD_BYTES
  const target = refOf(attachment)
  const state = useAttachment(instance, target, attachment.name, auto)

  const box = {
    width: TILE,
    height: TILE,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: T.border,
    backgroundColor: T.bg,
    overflow: 'hidden' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  }

  if (state.s === 'ready' && state.image !== null && !failed) {
    return (
      <Pressable onPress={onOpen} style={box} accessibilityLabel={attachment.name}>
        <Image
          source={{ uri: state.uri }}
          style={{ width: TILE, height: TILE }}
          contentFit="cover"
          // A recycled row must not flash the previous row's picture.
          recyclingKey={String(attachment.id)}
          // The file is already on disk; a second copy in expo-image's disk cache is waste.
          cachePolicy="memory"
          onError={() => setFailed(true)}
          transition={120}
        />
      </Pressable>
    )
  }

  const press = () => {
    if (state.s === 'refused') retry(instance, target.attachment)
    void fetchNow(instance, target, attachment.name)
  }
  return (
    <Pressable onPress={state.s === 'ready' ? undefined : press} style={[box, { padding: 6 }]}>
      {failed ? <Text style={{ color: T.dim, fontSize: 11 }}>Image unavailable.</Text>
        : <TileBody state={state} name={attachment.name} bytes={bytes} />}
    </Pressable>
  )
})

function TileBody({ state, name, bytes }: { state: AttachmentState; name: string; bytes: number }) {
  const small = { color: T.dim, fontSize: 11, textAlign: 'center' as const }
  switch (state.s) {
    case 'loading':
      return (
        <>
          <ActivityIndicator color={T.dim} />
          <Text style={small}>{percent(state)}</Text>
        </>
      )
    case 'refused':
      return (
        <>
          <Text style={{ color: T.bad, fontSize: 18 }}>!</Text>
          <Text style={small} numberOfLines={3}>
            {state.why}
          </Text>
        </>
      )
    case 'ready':
      // Laid out as a picture, sniffed as something else: say what it is.
      return (
        <Text style={small} numberOfLines={4}>
          {name}
        </Text>
      )
    case 'idle':
      return (
        <>
          <Text style={{ color: T.dim, fontSize: 18 }}>🖼</Text>
          <Text style={small} numberOfLines={2}>
            Tap to load{'\n'}
            {sizeLabel(bytes)}
          </Text>
        </>
      )
  }
}

function percent(state: { done: number; total: number }): string {
  return state.total === 0 ? '' : `${Math.floor((state.done / state.total) * 100)}%`
}

function FileChip({
  instance,
  attachment,
  target,
}: {
  instance: string
  attachment: TaskAttachment
  target: { project: string; task: string; attachment: string }
}) {
  // Files never load by themselves: `auto` is false, and this only follows the state.
  const state = useAttachment(instance, target, attachment.name, false)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const act = async (what: 'save' | 'share') => {
    if (busy) return
    setBusy(true)
    setNote(null)
    try {
      const got = await fetchNow(instance, target, attachment.name)
      if (got.s !== 'ready') {
        setNote(got.s === 'refused' ? got.why : 'Could not load it.')
        return
      }
      if (what === 'share') await share(got.uri, got.mime, got.name)
      else setNote(await saveToPhone(got.uri, got.mime, got.name))
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: T.border,
        borderRadius: 8,
        backgroundColor: T.bg,
        paddingVertical: 8,
        paddingHorizontal: 10,
        gap: 6,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={{ color: T.dim }}>📄</Text>
        <Text style={{ color: T.text, flex: 1 }} numberOfLines={1}>
          {attachment.name}
        </Text>
        <Text style={{ color: T.dim, fontSize: 12 }}>
          {state.s === 'loading' ? percent(state) : sizeLabel(Number(attachment.bytes))}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <ChipButton label="Save" disabled={busy} onPress={() => void act('save')} />
        <ChipButton label="Open / share" disabled={busy} onPress={() => void act('share')} />
        {busy && <ActivityIndicator size="small" color={T.dim} />}
      </View>
      {note !== null && (
        <Text style={{ color: T.dim, fontSize: 12 }} numberOfLines={3}>
          {note}
        </Text>
      )}
    </View>
  )
}
