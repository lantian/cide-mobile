/** Resolve the complete ANSI palette before inverse, dim and readability adjustments. */
import type { ScreenColor, StyleRun } from '../protocol/generated'
export const FG = '#c9d1d9'
export const BG = '#0d1117'
const ANSI = [
  '#1c1f24',
  '#ff6b6b',
  '#5ee08a',
  '#ffd166',
  '#6db3ff',
  '#d78bff',
  '#5fd7d7',
  '#c9d1d9',
  '#4b525c',
  '#ff8787',
  '#89f0ab',
  '#ffe08a',
  '#9fcbff',
  '#e3adff',
  '#8ce8e8',
  '#f0f6fc',
]
type RGB = [number, number, number]
function rgb(hex: string): RGB {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB
}
function hex(c: RGB): string {
  return '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
}
export function colour(value: ScreenColor | undefined, fallback: string): string {
  if (value === undefined) return fallback
  if (value.kind === 'rgb') return hex([value.r, value.g, value.b])
  const n = value.index
  if (n < 16) return ANSI[n] ?? fallback
  if (n < 232) {
    const c = n - 16
    const levels = [0, 95, 135, 175, 215, 255]
    return hex([levels[Math.floor(c / 36)]!, levels[Math.floor(c / 6) % 6]!, levels[c % 6]!] as RGB)
  }
  const level = 8 + (n - 232) * 10
  return hex([level, level, level])
}
function luminance(c: RGB): number {
  const linear = c.map((v) => {
    v /= 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
}
export function contrast(a: string, b: string): number {
  const x = luminance(rgb(a))
  const y = luminance(rgb(b))
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
export function runColours(
  run: StyleRun,
  wrapped: boolean,
): { color: string; backgroundColor?: string } {
  const inverse = ((run.flags ?? 0) & 16) !== 0
  let foreground = colour(inverse ? run.bg : run.fg, inverse ? BG : FG)
  let background = colour(inverse ? run.fg : run.bg, inverse ? FG : BG)
  const c = rgb(background)
  // Pale full-row fills are padding, not useful white rectangles on a dark phone.
  // Preserve actual colored diff fills and preserve all backgrounds in column/pan mode.
  if (wrapped && luminance(c) > 0.65 && Math.max(...c) - Math.min(...c) < 32) background = '#21262d'
  if (((run.flags ?? 0) & 2) !== 0) {
    const f = rgb(foreground),
      b = rgb(background)
    foreground = hex(f.map((v, i) => v * 0.6 + b[i]! * 0.4) as RGB)
  }
  if (wrapped && contrast(foreground, background) < 4.5)
    foreground =
      contrast('#ffffff', background) >= contrast('#000000', background) ? '#ffffff' : '#000000'
  return {
    color: foreground,
    ...(inverse || run.bg !== undefined ? { backgroundColor: background } : {}),
  }
}
