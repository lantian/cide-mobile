import { ActivityIndicator, FlatList, Text, View } from 'react-native'
import type { TaskComment, TaskDetail } from '../protocol/generated'
import { Markdown } from './Markdown'
import { AttachmentStrip } from './AttachmentStrip'
import { ChipButton } from './ChipButton'
import { TaskReferences } from './TaskReferences'
import { authorLabel } from '../agents/author'
import { T } from './theme'

/** Read-only child of a decision. Its parent owns Back and keeps the decision's draft. */
export function DecisionTask({ instance, project, task, detail, error, imagesEnabled, onRetry, onOpenTask }: {
  instance: string; project: string; task: string; detail: TaskDetail | null; error: string | null
  imagesEnabled: boolean; onRetry: () => void; onOpenTask: (id: string) => void
}) {
  if (error != null) return <View style={{ padding: 16, gap: 12 }}><Text accessibilityRole="alert" style={{ color: T.bad }}>{error}</Text><ChipButton label="Retry" onPress={onRetry} /></View>
  if (detail == null) return <View style={{ padding: 16, flexDirection: 'row', gap: 12 }}><ActivityIndicator color={T.dim} /><Text style={{ color: T.dim }}>Reading {task}…</Text></View>
  return <FlatList data={detail.comments.filter((c) => !c.deleted)} keyExtractor={(c) => String(c.id)} keyboardShouldPersistTaps="handled"
    contentContainerStyle={{ padding: 16, gap: 16 }}
    ListHeaderComponent={<View style={{ gap: 12 }}>
      <Text style={{ color: T.text, fontSize: 18 }}>{detail.row.title}</Text>
      <Text style={{ color: T.dim }}>{task} · {detail.row.status}</Text>
      <Markdown text={detail.body || 'No description.'} />
      <AttachmentStrip instance={instance} project={project} task={task} attachments={detail.attachments} enabled={imagesEnabled} />
      {detail.row.links.filter((link) => !link.deleted).map((link, index) => <Text key={index} style={{ color: T.dim }}>
        {link.link} · <TaskReferences text={String(link.target)} onOpenTask={onOpenTask} />
      </Text>)}
      <Text style={{ color: T.dim, marginTop: 8 }}>Log</Text>
    </View>}
    ListEmptyComponent={<Text style={{ color: T.dim }}>No comments yet.</Text>}
    renderItem={({ item }: { item: TaskComment }) => <View style={{ gap: 8, borderTopWidth: 1, borderColor: T.border, paddingTop: 12 }}>
      <Text style={{ color: T.dim }}>{authorLabel(item.author)}</Text><Markdown text={item.text} />
      <AttachmentStrip instance={instance} project={project} task={task} attachments={item.attachments} enabled={imagesEnabled} />
    </View>} />
}
