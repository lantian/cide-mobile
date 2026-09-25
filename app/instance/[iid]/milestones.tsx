/**
 * A project's milestones, their gates, and the two acts the desk offers on them. (M91)
 *
 * The same view the desk's Milestones tab draws — one producer, `milestones::view`, reached over
 * the wire — so what a card says here is what the tab says there. Pushed rather than polled:
 * cide sends a fresh view when a gate starts and again when it finishes, so "running" and the
 * verdict arrive on their own.
 *
 * Only the **active** milestone can have its gate run or be accepted, as on the desk, and cide
 * refuses either aimed at another — a card on a screen that went stale must not start a gate the
 * person did not choose.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from 'react-native'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import * as registry from '../../../src/store/registry'
import * as choice from '../../../src/store/projectChoice'
import { ProjectPicker } from '../../../src/ui/ProjectPicker'
import { ProjectSwipe } from '../../../src/ui/ProjectSwipe'
import {
  ago,
  byLine,
  cards,
  changeKind,
  lastLines,
  planDiff,
  type Card,
  type Verdict,
} from '../../../src/agents/milestones'
import { T } from '../../../src/ui/theme'
import type { MilestonesView, Proposal } from '../../../src/protocol/generated'

function verdictColour(verdict: Verdict): string {
  switch (verdict) {
    case 'running':
      return T.accent
    case 'passed':
      return T.good
    case 'failed':
      return T.bad
    default:
      return T.dim
  }
}

export default function MilestonesScreen() {
  const { iid } = useLocalSearchParams<{ iid: string }>()
  const views = useSyncExternalStore(registry.subscribe, registry.getSnapshot)
  const choices = useSyncExternalStore(choice.subscribe, choice.getSnapshot)
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const view = views.find((v) => v.paired.instanceId === iid)
  const connection = registry.connectionOf(iid)

  // cide's refusals of a run or an accept, said on this screen rather than lost.
  useEffect(() => registry.onRefusal(iid, setError), [iid])

  if (view === undefined) {
    return (
      <View style={{ flex: 1, backgroundColor: T.bg, padding: 16 }}>
        <Text style={{ color: T.dim }}>That instance is not paired any more.</Text>
      </View>
    )
  }

  const project = choice.resolve(iid, view.projects, choices)
  const names = new Map(view.projects.map((p) => [String(p.id), p.name]))
  const shown = Object.entries(view.milestones)
    .filter(([id, mv]) => mv !== null && (project === null || id === project))
    .map(([, mv]) => mv as MilestonesView)
    // A project with no plan yet can still have a proposal waiting — the first plan is often one.
    .filter((mv) => mv.plan.items.length > 0 || mv.proposals.length > 0)
  const offered = connection?.has('milestones') ?? false

  const runGate = (mv: MilestonesView, card: Card) => {
    setError(null)
    connection?.tell({ t: 'gateRun', project: mv.project, milestone: card.milestone.id })
  }

  const accept = (mv: MilestonesView, card: Card) => {
    Alert.alert(
      `Accept “${card.milestone.title}”?`,
      'Its task is marked done and the next milestone becomes active.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Accept',
          onPress: () => {
            setError(null)
            void connection
              ?.request({ t: 'milestoneAccept', project: mv.project, milestone: card.milestone.id })
              .then((body) => {
                if (body.t === 'error') setError(body.detail)
              })
              .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
          },
        },
      ],
    )
  }

  /**
   * Accept or reject an agent's proposal, after asking. Accepting applies it exactly — a new
   * plan, or files written and committed — so the question names which.
   */
  const decide = (mv: MilestonesView, proposal: Proposal, accept: boolean) => {
    Alert.alert(
      `${accept ? 'Accept' : 'Reject'} “${proposal.title}”?`,
      accept
        ? proposal.change.kind === 'files'
          ? 'cide writes these files and commits them.'
          : proposal.change.kind === 'plan'
            ? 'This becomes the project\'s milestone plan.'
            : 'The note is taken as read.'
        : 'It is dropped; nothing is changed.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: accept ? 'Accept' : 'Reject',
          style: accept ? 'default' : 'destructive',
          onPress: () => {
            setError(null)
            void connection
              ?.request({
                t: accept ? 'proposalAccept' : 'proposalReject',
                project: mv.project,
                id: proposal.id,
              })
              .then((body) => {
                if (body.t === 'error') setError(body.detail)
              })
              .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
          },
        },
      ],
    )
  }

  const openLog = (mv: MilestonesView, card: Card) => {
    router.push({
      pathname: '/milestone-log/[iid]',
      params: {
        iid,
        project: String(mv.project),
        kind: 'gate',
        key: card.milestone.id,
        title: card.milestone.title,
      },
    })
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Milestones' }} />
      <ProjectSwipe iid={iid} projects={view.projects} chosen={project}>
        <ScrollView
          style={{ flex: 1, backgroundColor: T.bg }}
          contentContainerStyle={{ padding: 16, gap: 12 }}
        >
          <ProjectPicker
            projects={view.projects}
            chosen={project}
            onChoose={(next) => choice.choose(iid, next)}
          />

          {!offered && view.phase === 'ready' ? (
            <Text style={{ color: T.warn }}>
              This cide is too old to show milestones on a phone. Update it to see gates here.
            </Text>
          ) : null}
          {error !== null ? <Text style={{ color: T.bad }}>{error}</Text> : null}
          {offered && shown.length === 0 ? (
            <Text style={{ color: T.dim }}>
              No milestones{project === null ? '' : ' in this project'}. They are defined in the
              Milestones tab of the Tasks panel on the desk.
            </Text>
          ) : null}

          {shown.map((mv) => (
            <View key={String(mv.project)} style={{ gap: 10 }}>
              {project === null ? (
                <Text style={{ color: T.dim, fontSize: 13 }}>{names.get(String(mv.project))}</Text>
              ) : null}
              {mv.proposals.map((proposal) => (
                <ProposalCard
                  key={proposal.id}
                  proposal={proposal}
                  onAccept={() => decide(mv, proposal, true)}
                  onReject={() => decide(mv, proposal, false)}
                />
              ))}
              {cards(mv).map((card) => (
                <MilestoneCard
                  key={card.milestone.id}
                  card={card}
                  onRun={() => runGate(mv, card)}
                  onAccept={() => accept(mv, card)}
                  onLog={() => openLog(mv, card)}
                />
              ))}
            </View>
          ))}
        </ScrollView>
      </ProjectSwipe>
    </>
  )
}

function MilestoneCard({
  card,
  onRun,
  onAccept,
  onLog,
}: {
  card: Card
  onRun: () => void
  onAccept: () => void
  onLog: () => void
}) {
  const colour = verdictColour(card.verdict)
  const tail = card.last === undefined ? '' : lastLines(card.last.tail, 12)
  return (
    <View
      style={{
        padding: 14,
        gap: 8,
        borderRadius: 10,
        borderWidth: 1,
        // The active one is the one anything can happen to, so it is the one that stands out.
        borderColor: !card.active ? T.border : colour === T.dim ? T.accent : colour,
        backgroundColor: T.panel,
        opacity: card.accepted ? 0.6 : 1,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={{ color: T.text, fontSize: 16, flex: 1 }} numberOfLines={2}>
          {card.milestone.title}
        </Text>
        {card.accepted ? <Text style={{ color: T.good, fontSize: 12 }}>accepted</Text> : null}
        {card.active && !card.accepted ? (
          <Text style={{ color: T.accent, fontSize: 12 }}>active</Text>
        ) : null}
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {card.running ? <ActivityIndicator size="small" color={T.accent} /> : null}
        <Text style={{ color: colour, fontSize: 13, flex: 1 }}>{card.line}</Text>
      </View>

      <Text style={{ color: T.dim, fontSize: 12, fontFamily: 'monospace' }} numberOfLines={2}>
        $ {card.milestone.gate}
      </Text>
      {card.total > 0 ? (
        <Text style={{ color: T.dim, fontSize: 12 }}>
          {card.done} of {card.total} task{card.total === 1 ? '' : 's'} done
        </Text>
      ) : null}

      {tail !== '' && !card.running ? (
        <ScrollView
          horizontal
          style={{ backgroundColor: T.bg, borderRadius: 6 }}
          contentContainerStyle={{ padding: 8 }}
        >
          <Text style={{ color: T.text, fontSize: 11, fontFamily: 'monospace' }}>{tail}</Text>
        </ScrollView>
      ) : null}

      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {card.active ? (
          <Button label={card.running ? 'Running…' : 'Run gate'} disabled={!card.runnable} onPress={onRun} />
        ) : null}
        {card.acceptable ? <Button label="Accept" primary onPress={onAccept} /> : null}
        {card.running || card.last !== undefined ? (
          <Button label={card.running ? 'Follow log' : 'Full log'} onPress={onLog} />
        ) : null}
      </View>
    </View>
  )
}

/**
 * One proposal an agent made, waiting for the user. The change is shown in full on a tap — a
 * plan as the lines that differ, files as their diffs — because accepting something unread is
 * exactly what the queue exists to prevent.
 */
function ProposalCard({
  proposal,
  onAccept,
  onReject,
}: {
  proposal: Proposal
  onAccept: () => void
  onReject: () => void
}) {
  const [open, setOpen] = useState(false)
  const change = proposal.change
  return (
    <View
      style={{
        padding: 14,
        gap: 8,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: T.warn,
        backgroundColor: T.panel,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={{ color: T.warn, fontSize: 12 }}>proposal · {changeKind(proposal)}</Text>
        <Text style={{ color: T.dim, fontSize: 12, flex: 1, textAlign: 'right' }}>
          {byLine(proposal)} · {ago(proposal.createdUnixMs, Date.now())}
        </Text>
      </View>
      <Text style={{ color: T.text, fontSize: 16 }}>{proposal.title}</Text>
      {proposal.rationale !== '' ? (
        <Text style={{ color: T.dim, fontSize: 13 }} numberOfLines={open ? undefined : 3}>
          {proposal.rationale}
        </Text>
      ) : null}

      {open && change.kind === 'plan' ? (
        <View style={{ backgroundColor: T.bg, borderRadius: 6, padding: 8, gap: 2 }}>
          {planDiff(change.before, change.plan).map((line, i) => (
            <Text
              key={i}
              style={{
                fontSize: 12,
                fontFamily: 'monospace',
                color: line.startsWith('+')
                  ? T.good
                  : line.startsWith('-')
                    ? T.bad
                    : line.startsWith('=')
                      ? T.dim
                      : T.warn,
              }}
            >
              {line}
            </Text>
          ))}
        </View>
      ) : null}
      {open && change.kind === 'files'
        ? change.files.map((file) => (
            <View key={file.path} style={{ gap: 4 }}>
              <Text style={{ color: T.text, fontSize: 12, fontFamily: 'monospace' }}>
                {file.content === undefined ? 'delete ' : ''}
                {file.path}
              </Text>
              <ScrollView
                horizontal
                style={{ backgroundColor: T.bg, borderRadius: 6 }}
                contentContainerStyle={{ padding: 8 }}
              >
                <Text style={{ fontSize: 11, fontFamily: 'monospace', color: T.text }}>
                  {file.diff.split('\n').map((line, i) => (
                    <Text
                      key={i}
                      style={{
                        color:
                          line.startsWith('+') && !line.startsWith('+++')
                            ? T.good
                            : line.startsWith('-') && !line.startsWith('---')
                              ? T.bad
                              : line.startsWith('@@')
                                ? T.accent
                                : T.text,
                      }}
                    >
                      {line}
                      {'\n'}
                    </Text>
                  ))}
                </Text>
              </ScrollView>
            </View>
          ))
        : null}

      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {change.kind === 'note' ? null : (
          <Button label={open ? 'Hide change' : 'Show change'} onPress={() => setOpen(!open)} />
        )}
        <Button label="Accept" primary onPress={onAccept} />
        <Button label="Reject" onPress={onReject} />
      </View>
    </View>
  )
}

function Button({
  label,
  onPress,
  disabled,
  primary,
}: {
  label: string
  onPress: () => void
  disabled?: boolean
  primary?: boolean
}) {
  return (
    <Pressable
      onPress={disabled === true ? undefined : onPress}
      style={{
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: primary === true ? T.accent : T.border,
        backgroundColor: primary === true ? T.accent : 'transparent',
        opacity: disabled === true ? 0.5 : 1,
      }}
    >
      <Text style={{ color: primary === true ? '#06121f' : T.text, fontSize: 13 }}>{label}</Text>
    </Pressable>
  )
}

