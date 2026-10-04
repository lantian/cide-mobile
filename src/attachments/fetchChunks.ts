/**
 * One attachment's bytes, pulled from cide a slice at a time. (cide M136)
 *
 * Pure: it is handed `request` rather than a connection, so the reassembly rules are tested in
 * Node against fakes and against the real `fake_cide`, and nothing here touches the disk.
 *
 * **One slice in flight, and the next asked for only when the last arrived.** That is the whole
 * of the flow control, and it is enough: cide answers a device through one bounded queue that
 * screen frames share, so a transfer the device paces itself can never fill it, and a transfer
 * whose screen was left (the user scrolled past the image) stops at the next slice boundary
 * because nobody asks for the next one.
 *
 * **The result stays base64, and that is the point.** cide cuts every slice but the last on a
 * multiple of three bytes (`ATTACHMENT_CHUNK`), so the slices' base64 strings concatenate into
 * the base64 of the whole file, and `expo-file-system` writes that in one call. Decoding a
 * 30 MB screenshot into a `Uint8Array` on the JS thread and encoding it back for the write is
 * exactly the work that froze the phone.
 */
import type { ClientBody, ImageFormat, ServerBody } from '../protocol/generated'

/** The slice size cide serves: `cide_ipc::remote::ATTACHMENT_CHUNK`. A request for more is clamped. */
export const ATTACHMENT_CHUNK = 192 * 1024

/** cide refuses to import anything larger (`MAX_ATTACHMENT_BYTES`), so a bigger `total` is a lie. */
export const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024

/** Which attachment, by the record cide holds — never a path. */
export interface AttachmentRef {
  project: string
  task: string
  attachment: string
}

export interface Downloaded {
  /** The whole file, base64. */
  base64: string
  bytes: number
  /** What cide sniffed from the file's own header. Only this makes a file drawable as a picture. */
  image: ImageFormat | null
}

/** A download stopped because nobody wanted it any more. Not a failure to show anyone. */
export class Aborted extends Error {
  constructor() {
    super('the download was abandoned')
    this.name = 'Aborted'
  }
}

/** Anything with an `aborted` flag — an `AbortSignal`, or the queue's own. */
export interface AbortFlag {
  readonly aborted: boolean
}

/** How many bytes a base64 string decodes to, without decoding it. */
export function decodedLength(base64: string): number {
  if (base64.length === 0) return 0
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return (base64.length / 4) * 3 - padding
}

export async function download(
  request: (body: ClientBody) => Promise<ServerBody>,
  ref: AttachmentRef,
  options: { onProgress?: (done: number, total: number) => void; signal?: AbortFlag } = {},
): Promise<Downloaded> {
  // An array joined once at the end, not `+=`: a 32 MiB file is 171 slices, and repeated
  // concatenation of strings that size is quadratic on Hermes.
  const parts: string[] = []
  let offset = 0
  let total: number | null = null
  let image: ImageFormat | null = null
  // A function, not the field read inline: TypeScript narrows the field to `false` after the
  // first check and would call the second one, across the `await`, impossible.
  const abandoned = (): boolean => options.signal?.aborted === true

  for (;;) {
    if (abandoned()) throw new Aborted()
    const body = await request({
      t: 'attachmentRead',
      project: ref.project,
      task: ref.task,
      attachment: ref.attachment,
      offset,
      len: ATTACHMENT_CHUNK,
    } as ClientBody)
    if (abandoned()) throw new Aborted()

    if (body.t === 'error') throw new Error(body.detail)
    if (body.t !== 'attachmentChunk') throw new Error(`cide answered a slice with ${body.t}`)
    if (Number(body.offset) !== offset) {
      throw new Error(`cide sent the slice at ${String(body.offset)}, not the one at ${offset}`)
    }
    const size = Number(body.total)
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`cide says the attachment is ${String(body.total)} bytes`)
    }
    // The file changed size under the transfer — rewritten on the desk. The slices before and
    // after it are of two different files, so nothing written from them would be either.
    if (total !== null && size !== total) throw new Error('the attachment changed while it was read')
    total = size
    if (offset === 0) image = body.image ?? null

    const got = decodedLength(body.data)
    if (offset + got > total) throw new Error('cide sent more than the attachment holds')
    if (offset + got < total) {
      // No progress would loop for ever; a slice off the multiple of three would make the
      // concatenated base64 wrong in a way nothing downstream can detect.
      if (got === 0) throw new Error('cide sent an empty slice before the end')
      if (got % 3 !== 0) throw new Error('cide sent a slice that does not end on a base64 group')
    }
    parts.push(body.data)
    offset += got
    options.onProgress?.(offset, total)
    if (offset === total) break
  }
  return { base64: parts.join(''), bytes: offset, image }
}
