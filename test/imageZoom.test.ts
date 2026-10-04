import { describe, expect, it } from 'vitest'
import { bounded, FIT, fitSize, zoomAt } from '../src/ui/imageZoom'

const viewport = { width: 400, height: 800 }
const fitted = { width: 400, height: 400 }
describe('image zoom geometry', () => {
  it('fits portrait and landscape images without changing aspect ratio', () => {
    expect(fitSize({ width: 1600, height: 800 }, viewport)).toEqual({ width: 400, height: 200 })
    expect(fitSize({ width: 100, height: 400 }, viewport)).toEqual({ width: 200, height: 800 })
  })
  it('clamps scale and pan against the image rather than its letterbox', () => {
    expect(bounded({ scale: 0.2, x: 100, y: -100 }, fitted, viewport)).toEqual(FIT)
    expect(bounded({ scale: 2, x: 999, y: 999 }, fitted, viewport)).toEqual({ scale: 2, x: 200, y: 0 })
    expect(bounded({ scale: 99, x: 9999, y: -9999 }, fitted, viewport)).toEqual({ scale: 8, x: 1400, y: -1200 })
  })
  it('keeps the tapped pixel under the fingers while scaling', () => {
    expect(zoomAt(FIT, 3, { x: 50, y: 20 }, { x: 50, y: 20 }, fitted, viewport)).toEqual({ scale: 3, x: -100, y: -40 })
  })
  it('allows moving a pinch and restores fit without residual offsets', () => {
    expect(zoomAt(FIT, 3, { x: 0, y: 0 }, { x: 40, y: -50 }, fitted, viewport)).toEqual({ scale: 3, x: 40, y: -50 })
    expect(zoomAt({ scale: 3, x: -100, y: 80 }, 1, { x: 40, y: 50 }, { x: 40, y: 50 }, fitted, viewport)).toEqual(FIT)
  })
})
