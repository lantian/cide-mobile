/**
 * Names, types and cache policy for attachments on the phone. Pure, so tested in Node.
 */
import type { ImageFormat } from '../protocol/generated'

/**
 * Images at most this big load by themselves when their tile scrolls into view; a bigger one
 * waits for a tap. A 30 MB PNG is 160 slices and a decode the size of the screen's memory
 * budget, and a card of them would spend the person's data on pictures they flicked past.
 */
export const AUTO_LOAD_BYTES = 8 * 1024 * 1024

/** The downloaded-files cache is trimmed, oldest first, back under this. */
export const CACHE_BUDGET_BYTES = 200 * 1024 * 1024

/**
 * A file name safe as one component of a path on the phone.
 *
 * cide already sanitises a name to one component on import, but the tracker is a committed,
 * hand-editable file: the phone does not take the desk's word for it before joining it to a
 * path of its own.
 */
export function safeName(name: string): string {
  const cleaned = name.replace(/[/\\\u0000-\u001f]/g, '_').replace(/^\.+/, '_').trim()
  return cleaned === '' ? 'attachment' : cleaned.slice(0, 120)
}

const IMAGE_MIME: Record<ImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
}

const BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  log: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  xml: 'application/xml',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}

/**
 * The MIME type to hand Android's share sheet and the Storage Access Framework. The sniffed
 * image format wins over the name, for the reason it decides drawing: the name is a hint.
 */
export function mimeOf(name: string, image: ImageFormat | null): string {
  if (image !== null) return IMAGE_MIME[image]
  const dot = name.lastIndexOf('.')
  const ext = dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
  return BY_EXTENSION[ext] ?? 'application/octet-stream'
}

/** `12 KB`, `3.4 MB`: a size a person reads on a chip. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** One cached download, as `evictionPlan` sees it. */
export interface Cached {
  dir: string
  bytes: number
  modifiedMs: number
}

/**
 * Which cached downloads to delete to get back under `budget`: the oldest first.
 *
 * Oldest *downloaded*, not least recently viewed — `expo-file-system` cannot touch a file's
 * time, and a second index written on every view would be a write per scroll. For a cache of
 * pictures that are cheap to fetch again, first-in-first-out is the honest trade.
 */
export function evictionPlan(entries: readonly Cached[], budget: number): string[] {
  let total = entries.reduce((sum, e) => sum + e.bytes, 0)
  const doomed: string[] = []
  for (const entry of [...entries].sort((a, b) => a.modifiedMs - b.modifiedMs)) {
    if (total <= budget) break
    doomed.push(entry.dir)
    total -= entry.bytes
  }
  return doomed
}
