import type { ConversationItem, ConversationPage, ConversationRequest, ConversationResponse, ServerBody, SessionState } from '../protocol/generated'
import type { Connection } from '../net/connection'

export interface ConversationSnapshot {
  readonly page: ConversationPage | null
  readonly items: readonly ConversationItem[]
  readonly before: string | null
  readonly after: string | null
  readonly draft: string
}
export const EMPTY: ConversationSnapshot = { page: null, items: [], before: null, after: null, draft: '' }
export function mergePage(held: ConversationSnapshot, page: ConversationPage, older = false): ConversationSnapshot {
  if (held.page?.generation === page.generation && Number(page.revision) < Number(held.page.revision)) return held
  const reset = held.page === null || held.page.generation !== page.generation || page.reset
  const byId = new Map<string, ConversationItem>(reset ? [] : held.items.map(item => [item.id, item]))
  for (const item of page.items) byId.set(item.id, item)
  return {
    ...held,
    page,
    items: [...byId.values()].sort((a, b) => a.ordinal - b.ordinal),
    before: reset || older ? page.before : held.before,
    after: older && !reset ? held.after : page.after,
  }
}

export class ConversationStore {
  private held = EMPTY
  private listeners = new Set<() => void>()
  getSnapshot = (): ConversationSnapshot => this.held
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  accept(page: ConversationPage, older = false): void { this.held = mergePage(this.held, page, older); this.emit() }
  draft(text: string): void { this.held = { ...this.held, draft: text }; this.emit() }
  private emit(): void { for (const listener of this.listeners) listener() }
}
const stores = new Map<string, ConversationStore>()
export function conversationStore(instance: string, project: string, id: string): ConversationStore {
  const key = JSON.stringify([instance, project, id])
  let store = stores.get(key)
  if (store === undefined) { store = new ConversationStore(); stores.set(key, store) }
  return store
}
export async function askConversation(connection: Pick<Connection, 'request'>, request: ConversationRequest): Promise<ConversationResponse> {
  const body: ServerBody = await connection.request({ t: 'conversation', request })
  if (body.t === 'error') throw new Error(body.detail)
  if (body.t !== 'conversation') throw new Error('cide returned an unexpected conversation response.')
  return body.response
}
export function activity(state: SessionState | null | undefined): string {
  switch (state?.state) {
    case 'busy': return 'Working'
    case 'idle': return 'Ready'
    case 'awaitingInput': return 'Waiting for you'
    case 'awaitingPermission': return 'Waiting for approval'
    case 'paused': return 'Paused'
    case 'exited': return `Exited${state.code === 0 ? '' : ` (${state.code})`}`
    default: return 'Status unavailable'
  }
}
export function operationId(): string {
  // These are deduplication identifiers, not credentials. No native crypto dependency is needed.
  return `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}
