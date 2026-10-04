/**
 * One strip's pictures, full screen, a swipe apart. (cide M136)
 *
 * A paging `FlatList` with a window of three: the picture on screen and its two neighbours are
 * mounted — so a swipe lands on a picture that is already loading — and the rest are not, so
 * swiping through forty full-size screenshots holds three decoded, not forty.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  Text,
  useWindowDimensions,
  View,
} from 'react-native'
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import { ZoomImage } from './ZoomImage'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { TaskAttachment } from '../protocol/generated'
import { sizeLabel } from '../attachments/files'
import { fetchNow, retry, useAttachment } from '../attachments/store'
import { saveToPhone, share } from '../attachments/export'
import { ChipButton } from './ChipButton'
import { T } from './theme'

type Ref = { project: string; task: string; attachment: string }

export function ImageViewer({
  instance,
  images,
  refOf,
  start,
  onClose,
}: {
  instance: string
  images: readonly TaskAttachment[]
  refOf: (a: TaskAttachment) => Ref
  start: number
  onClose: () => void
}) {
  const { width, height } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const [currentId, setCurrentId] = useState(() => String(images[start]?.id ?? images[0]?.id ?? ''))
  const index = images.findIndex((a) => String(a.id) === currentId)
  const pagerGesture = useMemo(() => Gesture.Native(), [])
  const pager = useRef<FlatList<TaskAttachment>>(null)
  const [paging, setPaging] = useState(true)
  const [reset, setReset] = useState(0)
  const onInteraction = useCallback((enlarged: boolean, pinching: boolean) => setPaging(!enlarged && !pinching), [])
  useEffect(() => { if (index < 0) onClose() }, [index, onClose])
  useEffect(() => {
    if (index < 0) return
    const frame = requestAnimationFrame(() => pager.current?.scrollToIndex({ index, animated: false }))
    return () => cancelAnimationFrame(frame)
  }, [width, height, index])
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const current = images[index]

  const act = async (what: 'save' | 'share') => {
    if (current === undefined || busy) return
    setBusy(true)
    setNote(null)
    try {
      const got = await fetchNow(instance, refOf(current), current.name)
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
    <Modal visible animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <GestureHandlerRootView style={{ flex: 1, backgroundColor: '#000' }}>
        <GestureDetector gesture={pagerGesture}><FlatList
          ref={pager}
          scrollEnabled={paging}
          horizontal
          pagingEnabled
          data={images}
          keyExtractor={(a) => String(a.id)}
          initialScrollIndex={Math.max(0, index)}
          getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          initialNumToRender={1}
          maxToRenderPerBatch={1}
          windowSize={3}
          removeClippedSubviews
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={(e) => {
            const next = images[Math.round(e.nativeEvent.contentOffset.x / width)]
            if (next !== undefined) setCurrentId(String(next.id))
            setNote(null)
          }}
          renderItem={({ item }) => (
            <Page instance={instance} attachment={item} target={refOf(item)} width={width} height={height}
              active={String(item.id) === currentId} reset={reset} onInteraction={onInteraction} pagerGesture={pagerGesture} />
          )}
        /></GestureDetector>

        <View
          style={{
            position: 'absolute',
            top: insets.top + 8,
            left: 12,
            right: 12,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <Pressable onPress={onClose} hitSlop={12} accessibilityLabel="Close">
            <Text style={{ color: T.text, fontSize: 22 }}>✕</Text>
          </Pressable>
          <Text style={{ color: T.text, flex: 1 }} numberOfLines={1}>
            {current?.name}
          </Text>
          <Text style={{ color: T.dim, fontSize: 12 }}>
            {index + 1} / {images.length}
          </Text>
        </View>

        <View
          style={{
            position: 'absolute',
            bottom: insets.bottom + 16,
            left: 12,
            right: 12,
            gap: 8,
            alignItems: 'center',
          }}
        >
          {note !== null && <Text style={{ color: T.text, fontSize: 13 }}>{note}</Text>}
          <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
            <ChipButton label="Reset" onPress={() => setReset((value) => value + 1)} />
            <ChipButton label="Save" disabled={busy} onPress={() => void act('save')} />
            <ChipButton label="Share" disabled={busy} onPress={() => void act('share')} />
            {busy && <ActivityIndicator size="small" color={T.dim} />}
          </View>
        </View>
      </GestureHandlerRootView>
    </Modal>
  )
}

function Page({
  instance,
  attachment,
  target,
  width,
  height,
  active,
  reset,
  onInteraction,
  pagerGesture,
}: {
  instance: string
  attachment: TaskAttachment
  target: Ref
  width: number
  height: number
  active: boolean
  reset: number
  onInteraction: (enlarged: boolean, pinching: boolean) => void
  pagerGesture: ReturnType<typeof Gesture.Native>
}) {
  // Always `auto` here: the person opened this picture, whatever its size.
  const state = useAttachment(instance, target, attachment.name, true)
  const centre = { width, height, alignItems: 'center' as const, justifyContent: 'center' as const, gap: 10 }

  if (state.s === 'ready' && state.image !== null) {
    return (
      <View style={centre}>
        <ZoomImage uri={state.uri} id={String(attachment.id)} width={width} height={height}
          active={active} reset={reset} onInteraction={onInteraction} pagerGesture={pagerGesture} />
      </View>
    )
  }
  return (
    <View style={centre}>
      {state.s === 'loading' || state.s === 'idle' ? (
        <>
          <ActivityIndicator color={T.dim} />
          <Text style={{ color: T.dim }}>
            {state.s === 'loading' && state.total > 0
              ? `${sizeLabel(state.done)} of ${sizeLabel(state.total)}`
              : 'Loading…'}
          </Text>
        </>
      ) : state.s === 'refused' ? (
        <Pressable
          onPress={() => {
            retry(instance, target.attachment)
            void fetchNow(instance, target, attachment.name)
          }}
          style={{ alignItems: 'center', gap: 6, paddingHorizontal: 24 }}
        >
          <Text style={{ color: T.bad, textAlign: 'center' }}>{state.why}</Text>
          <Text style={{ color: T.dim }}>Tap to try again</Text>
        </Pressable>
      ) : (
        <Text style={{ color: T.dim, paddingHorizontal: 24, textAlign: 'center' }}>
          {attachment.name} is not a picture cide could vouch for. Save or share it instead.
        </Text>
      )}
    </View>
  )
}
