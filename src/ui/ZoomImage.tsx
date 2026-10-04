import { useEffect, useRef, useState } from 'react'
import { Animated, Text, View } from 'react-native'
import { Image } from 'expo-image'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import { T } from './theme'
import { bounded, FIT, fitSize, zoomAt, type Size, type Zoom } from './imageZoom'

export function ZoomImage({ uri, id, width, height, active, reset, onInteraction, pagerGesture }: {
  uri: string; id: string; width: number; height: number; active: boolean; reset: number
  pagerGesture: ReturnType<typeof Gesture.Native>
  onInteraction: (enlarged: boolean, pinching: boolean) => void
}) {
  const [source, setSource] = useState<Size>({ width, height })
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [uri])
  const [enlarged, setEnlarged] = useState(false)
  const transform = useRef<Zoom>({ ...FIT })
  const pinchStart = useRef({ zoom: { ...FIT }, x: 0, y: 0 })
  const panStart = useRef({ ...FIT })
  const pinching = useRef(false)
  const scale = useRef(new Animated.Value(1)).current
  const position = useRef(new Animated.ValueXY()).current
  const viewport = { width, height }
  const fitted = fitSize(source, viewport)
  const apply = (next: Zoom) => {
    transform.current = next
    scale.setValue(next.scale)
    position.setValue({ x: next.x, y: next.y })
    const large = next.scale > 1.001
    setEnlarged(large)
    if (active) onInteraction(large, pinching.current)
  }

  useEffect(() => {
    pinching.current = false
    transform.current = { ...FIT }
    scale.setValue(1)
    position.setValue({ x: 0, y: 0 })
    setEnlarged(false)
    if (active) onInteraction(false, false)
  }, [id, uri, width, height, source.width, source.height, active, reset, scale, position, onInteraction])

  const pinch = Gesture.Pinch().runOnJS(true).enabled(active).simultaneousWithExternalGesture(pagerGesture)
    .onTouchesDown((event) => {
      if (event.numberOfTouches >= 2) { pinching.current = true; onInteraction(enlarged, true) }
    })
    .onStart((event) => {
      pinching.current = true
      pinchStart.current = { zoom: { ...transform.current }, x: event.focalX - width / 2, y: event.focalY - height / 2 }
      onInteraction(enlarged, true)
    })
    .onUpdate((event) => {
      const start = pinchStart.current
      apply(zoomAt(start.zoom, start.zoom.scale * event.scale, start,
        { x: event.focalX - width / 2, y: event.focalY - height / 2 }, fitted, viewport))
    })
    .onFinalize(() => {
      pinching.current = false
      apply(bounded(transform.current, fitted, viewport))
    })
  const pan = Gesture.Pan().runOnJS(true).enabled(active && enlarged).maxPointers(1)
    .onStart(() => { panStart.current = { ...transform.current } })
    .onUpdate((event) => {
      if (pinching.current) return
      apply(bounded({ ...transform.current, x: panStart.current.x + event.translationX,
        y: panStart.current.y + event.translationY }, fitted, viewport))
    })
  const doubleTap = Gesture.Tap().runOnJS(true).enabled(active).numberOfTaps(2).maxDuration(250)
    .onEnd((event, success) => {
      if (!success) return
      if (transform.current.scale > 1.001) apply({ ...FIT })
      else {
        const focal = { x: event.x - width / 2, y: event.y - height / 2 }
        apply(zoomAt(transform.current, 3, focal, focal, fitted, viewport))
      }
    })
  if (failed) return <View style={{ width, height, alignItems: 'center', justifyContent: 'center' }}>
    <Text style={{ color: T.dim }}>Image unavailable.</Text>
  </View>
  return <GestureDetector gesture={Gesture.Simultaneous(pinch, pan, doubleTap)}>
    <View collapsable={false} style={{ width, height, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View style={{ width: fitted.width, height: fitted.height,
        transform: [{ translateX: position.x }, { translateY: position.y }, { scale }] }}>
        <Image source={{ uri }} style={{ width: '100%', height: '100%' }} contentFit="contain"
          recyclingKey={id} cachePolicy="memory" allowDownscaling={false} onError={() => setFailed(true)} onLoad={(event) => {
            setSource({ width: event.source.width, height: event.source.height })
          }} />
      </Animated.View>
    </View>
  </GestureDetector>
}
