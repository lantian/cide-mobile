/** Geometry independent of React/native gestures, in viewport points. */
export type Size = { width: number; height: number }
export type Zoom = { scale: number; x: number; y: number }
export const FIT: Zoom = { scale: 1, x: 0, y: 0 }
export const MAX_ZOOM = 8

export function fitSize(image: Size, viewport: Size): Size {
  if (image.width <= 0 || image.height <= 0) return viewport
  const ratio = Math.min(viewport.width / image.width, viewport.height / image.height)
  return { width: image.width * ratio, height: image.height * ratio }
}

export function bounded(zoom: Zoom, fitted: Size, viewport: Size): Zoom {
  const scale = Math.max(1, Math.min(MAX_ZOOM, zoom.scale))
  const maxX = Math.max(0, (fitted.width * scale - viewport.width) / 2)
  const maxY = Math.max(0, (fitted.height * scale - viewport.height) / 2)
  return { scale, x: maxX === 0 ? 0 : Math.max(-maxX, Math.min(maxX, zoom.x)), y: maxY === 0 ? 0 : Math.max(-maxY, Math.min(maxY, zoom.y)) }
}

/** Anchor coordinates are relative to viewport centre. Moving the pinch also pans the image. */
export function zoomAt(before: Zoom, scale: number, anchor: { x: number; y: number }, focal: { x: number; y: number }, fitted: Size, viewport: Size): Zoom {
  const next = Math.max(1, Math.min(MAX_ZOOM, scale))
  const ratio = next / before.scale
  return bounded({ scale: next, x: focal.x - (anchor.x - before.x) * ratio,
    y: focal.y - (anchor.y - before.y) * ratio }, fitted, viewport)
}
