/** One bounded slice in flight. A failed transfer never retries or types by itself. */
import type { ClientBody, ServerBody, SessionId } from '../protocol/generated'
import {
  ATTACHMENT_CHUNK,
  MAX_ATTACHMENT_BYTES,
  decodedLength,
  type AbortFlag,
} from '../attachments/fetchChunks'
type Request = (body: ClientBody) => Promise<ServerBody>
export interface UploadFile {
  name: string
  size: number
  read(offset: number, length: number): Promise<string>
}
export class UploadCancelled extends Error {
  constructor() {
    super('Upload cancelled')
    this.name = 'UploadCancelled'
  }
}
function answer(body: ServerBody): ServerBody {
  if (body.t === 'error') throw new Error(body.detail)
  return body
}
export async function uploadFile(
  request: Request,
  session: SessionId,
  file: UploadFile,
  options: { signal?: AbortFlag; onProgress?: (done: number, total: number) => void } = {},
): Promise<string> {
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_ATTACHMENT_BYTES)
    throw new Error('Each attachment must be at most 32 MB.')
  let token: string | null = null
  const check = () => {
    if (options.signal?.aborted) throw new UploadCancelled()
  }
  try {
    check()
    const begun = answer(
      await request({ t: 'consoleUploadBegin', session, name: file.name, size: file.size }),
    )
    if (begun.t !== 'consoleUploadReady') throw new Error('cide did not start the upload.')
    token = begun.upload
    let offset = 0
    while (offset < file.size) {
      check()
      const length = Math.min(ATTACHMENT_CHUNK, file.size - offset)
      const data = await file.read(offset, length)
      check()
      if (decodedLength(data) !== length)
        throw new Error('The selected file changed during the upload.')
      const body = answer(await request({ t: 'consoleUploadChunk', upload: token, offset, data }))
      if (
        body.t !== 'consoleUploadProgress' ||
        body.upload !== token ||
        Number(body.offset) !== offset + length
      )
        throw new Error('cide acknowledged an unexpected upload position.')
      offset += length
      options.onProgress?.(offset, file.size)
    }
    check()
    const done = answer(await request({ t: 'consoleUploadFinish', upload: token }))
    if (done.t !== 'consoleUploadFinished' || done.upload !== token)
      throw new Error('cide did not finish the upload.')
    check()
    return done.path
  } catch (error) {
    if (token !== null) {
      try {
        await request({ t: 'consoleUploadCancel', upload: token })
      } catch {
        /* disconnect owns cleanup */
      }
    }
    throw error
  }
}
/** Quoted paths cannot become shell expansions; individual pastes let image-aware TUIs attach. */
export function quotePath(path: string): string {
  if (/[\u0000-\u001f\u007f]/u.test(path))
    throw new Error('The upload path contains terminal control characters.')
  return `'${path.replace(/'/gu, `'\\''`)}'`
}
