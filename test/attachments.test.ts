/**
 * Attachments on the phone (cide M136): the slice reassembly, the download queue that makes lazy
 * loading unload, and the cache's eviction order. The screen and the disk are not here — they
 * need a device — but every rule they lean on is.
 */
import { describe, expect, it } from 'vitest'
import {
  ATTACHMENT_CHUNK,
  Aborted,
  MAX_ATTACHMENT_BYTES,
  decodedLength,
  download,
} from '../src/attachments/fetchChunks'
import { FetchQueue } from '../src/attachments/queue'
import { evictionPlan, mimeOf, safeName, sizeLabel } from '../src/attachments/files'
import type { ClientBody, ServerBody } from '../src/protocol/generated'

const REF = { project: 'p', task: 't', attachment: 'a' }

/** A cide that serves `file` the way the real one does: clamped slices, base64 each. */
function serving(file: Buffer, tamper?: (body: ServerBody, asked: number) => ServerBody) {
  const asked: number[] = []
  const request = async (body: ClientBody): Promise<ServerBody> => {
    if (body.t !== 'attachmentRead') throw new Error(`unexpected ${body.t}`)
    const offset = Number(body.offset)
    asked.push(offset)
    const len = Math.min(body.len, ATTACHMENT_CHUNK)
    const answer = {
      t: 'attachmentChunk',
      project: body.project,
      task: body.task,
      attachment: body.attachment,
      offset,
      total: file.length,
      data: file.subarray(offset, offset + len).toString('base64'),
      ...(offset === 0 ? { image: 'png' } : {}),
    } as ServerBody
    return tamper === undefined ? answer : tamper(answer, asked.length)
  }
  return { request, asked }
}

const bytes = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7) % 256))

describe('download', () => {
  it('concatenates slices into the base64 of the whole file', async () => {
    const file = bytes(ATTACHMENT_CHUNK * 2 + 11)
    const { request, asked } = serving(file)
    const progress: number[] = []
    const got = await download(request, REF, { onProgress: (done) => progress.push(done) })
    expect(asked).toEqual([0, ATTACHMENT_CHUNK, ATTACHMENT_CHUNK * 2])
    expect(got.base64).toBe(file.toString('base64'))
    expect(got.bytes).toBe(file.length)
    expect(got.image).toBe('png')
    expect(progress).toEqual([ATTACHMENT_CHUNK, ATTACHMENT_CHUNK * 2, file.length])
  })

  it('takes an empty file in one answer', async () => {
    const got = await download(serving(Buffer.alloc(0)).request, REF)
    expect(got).toEqual({ base64: '', bytes: 0, image: 'png' })
  })

  it('refuses in cide\'s own words', async () => {
    const request = async (): Promise<ServerBody> =>
      ({ t: 'error', kind: 'refused', detail: 'no such attachment: a' }) as ServerBody
    await expect(download(request, REF)).rejects.toThrow('no such attachment: a')
  })

  it('refuses a slice at the wrong offset', async () => {
    const { request } = serving(bytes(ATTACHMENT_CHUNK + 3), (b, n) =>
      n === 2 ? ({ ...b, offset: 5 } as ServerBody) : b,
    )
    await expect(download(request, REF)).rejects.toThrow(/not the one at/)
  })

  it('refuses a file that changed size mid-transfer', async () => {
    const { request } = serving(bytes(ATTACHMENT_CHUNK + 3), (b, n) =>
      n === 2 ? ({ ...b, total: ATTACHMENT_CHUNK + 30 } as ServerBody) : b,
    )
    await expect(download(request, REF)).rejects.toThrow(/changed/)
  })

  it('refuses a total over cide\'s own import cap', async () => {
    const { request } = serving(bytes(10), (b) => ({ ...b, total: MAX_ATTACHMENT_BYTES + 1 }) as ServerBody)
    await expect(download(request, REF)).rejects.toThrow(/bytes/)
  })

  it('refuses a short slice that would break the base64 concatenation', async () => {
    const file = bytes(20)
    const request = async (body: ClientBody): Promise<ServerBody> => {
      const offset = Number((body as { offset: number }).offset)
      const take = offset === 0 ? 4 : 16 // 4 is not a multiple of 3
      return {
        t: 'attachmentChunk',
        project: 'p',
        task: 't',
        attachment: 'a',
        offset,
        total: file.length,
        data: file.subarray(offset, offset + take).toString('base64'),
      } as ServerBody
    }
    await expect(download(request, REF)).rejects.toThrow(/base64 group/)
  })

  it('refuses an empty slice before the end instead of looping', async () => {
    const { request } = serving(bytes(10), (b) => ({ ...b, data: '' }) as ServerBody)
    await expect(download(request, REF)).rejects.toThrow(/empty slice/)
  })

  it('stops between slices once abandoned', async () => {
    const signal = { aborted: false }
    const { request, asked } = serving(bytes(ATTACHMENT_CHUNK * 3), (b, n) => {
      if (n === 1) signal.aborted = true
      return b
    })
    await expect(download(request, REF, { signal })).rejects.toBeInstanceOf(Aborted)
    expect(asked).toEqual([0])
  })

  it('knows a base64 string\'s decoded length', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 6, 100]) {
      expect(decodedLength(bytes(n).toString('base64'))).toBe(n)
    }
  })
})

/** A job the test finishes by hand. */
function deferred() {
  const started: string[] = []
  const finish = new Map<string, () => void>()
  const signals = new Map<string, { aborted: boolean }>()
  const job = (key: string) => (signal: { readonly aborted: boolean }) => {
    started.push(key)
    signals.set(key, signal as { aborted: boolean })
    return new Promise<void>((done) => finish.set(key, done))
  }
  return { started, finish, signals, job }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('FetchQueue', () => {
  it('runs at most its limit, newest first', async () => {
    const q = new FetchQueue(2)
    const d = deferred()
    for (const key of ['a', 'b', 'c', 'd']) q.want(key, d.job(key))
    expect(d.started).toEqual(['a', 'b'])
    d.finish.get('a')?.()
    await tick()
    // `d` was wanted last — the tile the person scrolled to — so it goes before `c`.
    expect(d.started).toEqual(['a', 'b', 'd'])
  })

  it('drops a waiting key nobody wants any more', async () => {
    const q = new FetchQueue(1)
    const d = deferred()
    q.want('a', d.job('a'))
    const release = q.want('b', d.job('b'))
    release()
    d.finish.get('a')?.()
    await tick()
    expect(d.started).toEqual(['a'])
    expect(q.stats).toEqual({ running: 0, waiting: 0 })
  })

  it('aborts a running key once its last want is released', () => {
    const q = new FetchQueue(1)
    const d = deferred()
    const first = q.want('a', d.job('a'))
    const second = q.want('a', d.job('a'))
    expect(d.started).toEqual(['a'])
    first()
    expect(d.signals.get('a')?.aborted).toBe(false)
    second()
    expect(d.signals.get('a')?.aborted).toBe(true)
  })

  it('shares one download between two wants', () => {
    const q = new FetchQueue(2)
    const d = deferred()
    q.want('a', d.job('a'))
    q.want('a', d.job('a'))
    expect(d.started).toEqual(['a'])
  })

  it('frees the slot when a job fails', async () => {
    const q = new FetchQueue(1)
    const started: string[] = []
    q.want('a', async () => {
      started.push('a')
      throw new Error('refused')
    })
    q.want('b', async () => {
      started.push('b')
    })
    await tick()
    expect(started).toEqual(['a', 'b'])
  })

  it('a flick past many tiles starts only the last few', async () => {
    const q = new FetchQueue(2)
    const d = deferred()
    // Tiles mount and unmount as the list flies by; only the last three stay.
    const releases = Array.from({ length: 50 }, (_, i) => q.want(`t${i}`, d.job(`t${i}`)))
    releases.slice(0, 47).forEach((release) => release())
    d.finish.get('t0')?.()
    d.finish.get('t1')?.()
    await tick()
    expect(d.started).toEqual(['t0', 't1', 't49', 't48'])
  })
})

describe('files', () => {
  it('keeps a name to one component', () => {
    expect(safeName('../../etc/passwd')).toBe('__.._etc_passwd')
    expect(safeName('')).toBe('attachment')
    expect(safeName('shot.png')).toBe('shot.png')
    expect(safeName('.hidden')).toBe('_hidden')
  })

  it('trusts the sniffed format over the name', () => {
    expect(mimeOf('notes.png', null)).toBe('image/png')
    expect(mimeOf('notes.txt', 'jpeg')).toBe('image/jpeg')
    expect(mimeOf('blob', null)).toBe('application/octet-stream')
    expect(mimeOf('Report.PDF', null)).toBe('application/pdf')
  })

  it('evicts the oldest until under budget', () => {
    const plan = evictionPlan(
      [
        { dir: 'new', bytes: 50, modifiedMs: 3 },
        { dir: 'old', bytes: 50, modifiedMs: 1 },
        { dir: 'mid', bytes: 50, modifiedMs: 2 },
      ],
      100,
    )
    expect(plan).toEqual(['old'])
    expect(evictionPlan([{ dir: 'x', bytes: 10, modifiedMs: 0 }], 100)).toEqual([])
  })

  it('labels sizes', () => {
    expect(sizeLabel(512)).toBe('512 B')
    expect(sizeLabel(2048)).toBe('2 KB')
    expect(sizeLabel(3.5 * 1024 * 1024)).toBe('3.5 MB')
  })
})
