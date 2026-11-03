/** Shared mobile names and identity. Pane identity matters when a session is mirrored. */
import type { RemoteSession } from '../protocol/generated'
export function isAIConsole(row: Pick<RemoteSession, 'kind' | 'harness'>): boolean {
  return row.kind === 'claude' || row.harness !== undefined
}
function generic(name: string): boolean {
  return /^(claude|codex|opencode|qwen|mimo|ai console)$/iu.test(name.trim())
}
export function consoleTitle(row: RemoteSession): string {
  if (!isAIConsole(row)) return row.title.split(' : ').pop() || 'Shell'
  if (row.location === 'main') return 'AI console'
  const name = row.tabTitle ?? row.title.split(' : ').pop() ?? ''
  return generic(name) || name === '' ? 'AI console' : name
}
export function orderedConsoles(
  rows: readonly RemoteSession[],
  project: string | null,
): RemoteSession[] {
  return rows.filter((row) => project === null || String(row.project) === project)
}
export function consoleRoute(iid: string, row: RemoteSession): string {
  return `/session/${iid}/${row.session}?pane=${encodeURIComponent(String(row.pane))}`
}
