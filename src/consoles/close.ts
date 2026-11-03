import type { RemoteSession } from '../protocol/generated'
import type { Connection } from '../net/connection'
export async function closeConsole(connection: Connection, row: RemoteSession): Promise<void> {
  if (!connection.has('consoleClose') || row.canClose !== true)
    throw new Error('This console cannot be closed from the phone.')
  const body = await connection.request({
    t: 'consoleClose',
    project: row.project,
    pane: row.pane,
    session: row.session,
  })
  if (body.t === 'error') throw new Error(body.detail)
  if (body.t !== 'consoleClosed' || body.pane !== row.pane)
    throw new Error('cide did not confirm closing this console.')
}
