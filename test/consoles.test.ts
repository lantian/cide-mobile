import { describe, expect, it } from 'vitest'
import { consoleRoute, consoleTitle, isAIConsole, orderedConsoles } from '../src/consoles/model'
import { closeConsole } from '../src/consoles/close'
import { quotePath, uploadFile, UploadCancelled } from '../src/consoles/upload'
import { ATTACHMENT_CHUNK, MAX_ATTACHMENT_BYTES } from '../src/attachments/fetchChunks'
import type { ClientBody, RemoteSession, ServerBody } from '../src/protocol/generated'
import type { Connection } from '../src/net/connection'
const row = (extra: Partial<RemoteSession> = {}): RemoteSession => ({
  session: 's',
  project: 'p',
  pane: 'one',
  title: 'p : claude',
  tabTitle: 'Claude',
  kind: 'claude',
  role: 'primary',
  state: { state: 'idle' },
  awaiting: false,
  ...extra,
})
describe('console presentation', () => {
  it('uses AI console for all harness defaults and preserves custom tab titles', () => {
    for (const harness of ['claude', 'codex', 'opencode', 'qwen', 'mimo'] as const)
      expect(consoleTitle(row({ harness, tabTitle: harness }))).toBe('AI console')
    expect(consoleTitle(row({ tabTitle: 'Review API' }))).toBe('Review API')
    expect(consoleTitle(row({ location: 'main', tabTitle: 'Codex' }))).toBe('AI console')
    expect(consoleTitle(row({ kind: 'shell', title: 'p : bash' }))).toBe('bash')
    expect(isAIConsole(row({ kind: 'shell', harness: 'qwen' }))).toBe(true)
  })
  it('keeps authoritative desktop order regardless of attention and narrows without mutation', () => {
    const rows = [
      row({ pane: 'main' }),
      row({ pane: 'tab', awaiting: true, state: { state: 'busy' } }),
      row({ pane: 'other', project: 'q' }),
    ]
    expect(orderedConsoles(rows, 'p').map((r) => r.pane)).toEqual(['main', 'tab'])
    expect(orderedConsoles(rows, null)).toEqual(rows)
    expect(rows).toHaveLength(3)
  })
  it('gives mirrored sessions distinct routes', () => {
    expect(consoleRoute('i', row())).not.toBe(consoleRoute('i', row({ pane: 'two' })))
    expect(consoleRoute('i', row())).toContain('pane=one')
  })
  it('never sends a close for a protected or unsupported pane', async () => {
    let calls = 0
    const c = {
      has: () => true,
      request: async () => {
        calls++
        return { t: 'consoleClosed', pane: 'one' }
      },
    } as unknown as Connection
    await expect(closeConsole(c, row({ canClose: false }))).rejects.toThrow('cannot')
    await closeConsole(c, row({ canClose: true }))
    expect(calls).toBe(1)
    const refused = {
      ...c,
      request: async () => ({ t: 'error', detail: 'changed' }),
    } as unknown as Connection
    await expect(closeConsole(refused, row({ canClose: true }))).rejects.toThrow('changed')
  })
})
describe('console upload', () => {
  function host() {
    const calls: ClientBody[] = []
    const request = async (body: ClientBody): Promise<ServerBody> => {
      calls.push(body)
      switch (body.t) {
        case 'consoleUploadBegin':
          return { t: 'consoleUploadReady', upload: 'u' }
        case 'consoleUploadChunk':
          return {
            t: 'consoleUploadProgress',
            upload: 'u',
            offset: body.offset + Buffer.from(body.data, 'base64').length,
          }
        case 'consoleUploadFinish':
          return {
            t: 'consoleUploadFinished',
            upload: 'u',
            path: '/work/.cide/mobile-uploads/u/a.png',
          }
        case 'consoleUploadCancel':
          return { t: 'consoleUploadCancelled', upload: 'u' }
        default:
          throw new Error('unexpected frame')
      }
    }
    return { calls, request }
  }
  it('streams multiple slices in order without sending paste or Enter', async () => {
    const h = host(),
      data = Buffer.alloc(ATTACHMENT_CHUNK + 7, 33),
      positions: number[] = []
    const path = await uploadFile(
      h.request,
      's',
      {
        name: 'a.png',
        size: data.length,
        read: async (offset, length) => data.subarray(offset, offset + length).toString('base64'),
      },
      { onProgress: (done) => positions.push(done) },
    )
    expect(path).toContain('mobile-uploads')
    expect(positions).toEqual([ATTACHMENT_CHUNK, data.length])
    expect(h.calls.map((c) => c.t)).toEqual([
      'consoleUploadBegin',
      'consoleUploadChunk',
      'consoleUploadChunk',
      'consoleUploadFinish',
    ])
  })
  it('rejects oversized files before allocating an upload', async () => {
    const h = host()
    await expect(
      uploadFile(h.request, 's', {
        name: 'big',
        size: MAX_ATTACHMENT_BYTES + 1,
        read: async () => '',
      }),
    ).rejects.toThrow('32 MB')
    expect(h.calls).toEqual([])
  })
  it('cancels at slice boundaries and never finishes a cancelled file', async () => {
    const h = host(),
      signal = { aborted: false }
    await expect(
      uploadFile(
        h.request,
        's',
        {
          name: 'a',
          size: 3,
          read: async () => {
            signal.aborted = true
            return 'YWJj'
          },
        },
        { signal },
      ),
    ).rejects.toBeInstanceOf(UploadCancelled)
    expect(h.calls.map((c) => c.t)).toEqual(['consoleUploadBegin', 'consoleUploadCancel'])
  })
  it('refuses unexpected acknowledgements and changed local files', async () => {
    const h = host()
    const badAck = async (b: ClientBody): Promise<ServerBody> =>
      b.t === 'consoleUploadChunk'
        ? { t: 'consoleUploadProgress', upload: 'wrong', offset: 3 }
        : h.request(b)
    await expect(
      uploadFile(badAck, 's', { name: 'a', size: 3, read: async () => 'YWJj' }),
    ).rejects.toThrow('unexpected')
    expect(h.calls.at(-1)?.t).toBe('consoleUploadCancel')
    await expect(
      uploadFile(h.request, 's', { name: 'a', size: 3, read: async () => '' }),
    ).rejects.toThrow('changed')
  })
  it('propagates disconnects without automatically retrying or inserting', async () => {
    const h = host()
    const disconnected = async (b: ClientBody): Promise<ServerBody> => {
      if (b.t === 'consoleUploadChunk') throw new Error('Disconnected')
      return h.request(b)
    }
    await expect(
      uploadFile(disconnected, 's', { name: 'a', size: 3, read: async () => 'YWJj' }),
    ).rejects.toThrow('Disconnected')
    expect(h.calls.filter((b) => b.t === 'consoleUploadBegin')).toHaveLength(1)
    expect(h.calls.at(-1)?.t).toBe('consoleUploadCancel')
  })
  it('quotes shell-sensitive characters and rejects terminal control characters', () => {
    expect(quotePath('/work/a b.png')).toBe("'/work/a b.png'")
    expect(quotePath("/work/it's.png")).toBe("'/work/it'\\''s.png'")
    expect(() => quotePath('/work/a\n.png')).toThrow('control')
  })
})
