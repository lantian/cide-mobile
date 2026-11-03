import type { UserRequest } from '../src/protocol/generated'

export const questionRequest = (over: Partial<UserRequest> = {}): UserRequest => ({
  id: 'q-1', title: 'Choose icons', message: 'See t-7.', task: 't-3', author: { kind: 'orchestrator' },
  request: { kind: 'question', question: { text: 'Compare t-7; задачаt-70 and t-8_ are plain text.', selection: 'single', options: [
    { id: 'production', title: 'Wait for production GLB' }, { id: 'candidate', title: 'Use candidate' },
  ] } },
  origin: { id: 'conversation', known: true, kind: 'planner', harness: 'codex', title: 'Planner', name: null,
    cwd: '/project', session: 'session', run: null, agent: null, task: null, taskTitle: null,
    prompt: null, branch: null, startedUnixMs: 1, lastSeenUnixMs: 2 },
  wait: true, createdUnixMs: 2n, response: null, applying: false, delivered: false, deliveryError: null, ...over,
})

export const moveRequest = (): UserRequest => questionRequest({ id: 'move-1', title: 'Move into look?', task: null,
  request: { kind: 'moveTasks', milestone: 'look', goal: 't-1', tasks: [
    { id: 't-7', title: 'First model', status: 'inbox', parent: null },
    { id: 't-8', title: 'Second model', status: 'inbox', parent: null },
  ] } })
