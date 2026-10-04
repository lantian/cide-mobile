import { useRef, useState } from 'react'
import { FlatList, Pressable, Text, TextInput, useWindowDimensions, View } from 'react-native'
import type { TaskDetail, TaskQuestion } from '../protocol/generated'
import * as registry from '../store/registry'
import {
  AnswerSubmission,
  answerPayload,
  questionImages,
  questionText,
  toggleSelection,
} from '../questions/model'
import { AttachmentTile } from './AttachmentStrip'
import { ChipButton } from './ChipButton'
import { ImageViewer } from './ImageViewer'
import { T } from './theme'

/** Keyed by the displayed question; ordinary board refreshes retain the draft. */
export function QuestionAnswer({
  instance,
  project,
  task,
  question,
  detail,
  enabled,
  imagesEnabled,
  onRefresh,
}: {
  instance: string
  project: string
  task: string
  question: TaskQuestion
  detail: TaskDetail
  enabled: boolean
  imagesEnabled: boolean
  onRefresh: () => void
}) {
  const { width } = useWindowDimensions()
  const [text, setText] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [viewing, setViewing] = useState<string | null>(null)
  const submission = useRef(new AnswerSubmission()).current
  const images = questionImages(question, detail)
  const options = typeof question === 'string' ? [] : question.options
  const multiple = typeof question !== 'string' && question.selection === 'multiple'
  const refOf = (a: { id: string }) => ({ project, task, attachment: String(a.id) })
  const valid = selected.length > 0 || text.trim() !== ''

  const send = async () => {
    if (submission.busy || busy || !enabled || !valid) return
    setBusy(true)
    setError(null)
    try {
      const connection = registry.connectionOf(instance)
      if (connection === undefined) throw new Error('That cide is not connected.')
      const sent = await submission.send(
        (body) => connection.request(body),
        project,
        task,
        answerPayload(question, text, selected),
      )
      if (sent) {
        setText('')
        setSelected([])
        onRefresh()
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      // A refusal or lost acknowledgement may mean the question changed at the desk.
      onRefresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={{ gap: 10 }}>
      <Text selectable style={{ color: T.text, lineHeight: 21 }}>
        {questionText(question)}
      </Text>
      {options.length > 0 && (
        <>
          <Text style={{ color: T.dim }}>{multiple ? 'Choose one or more' : 'Choose one'}</Text>
          <FlatList
            horizontal
            data={options}
            extraData={selected}
            keyExtractor={(option) => option.id}
            keyboardShouldPersistTaps="always"
            showsHorizontalScrollIndicator={false}
            initialNumToRender={2}
            maxToRenderPerBatch={2}
            windowSize={3}
            ItemSeparatorComponent={() => <View style={{ width: 10 }} />}
            renderItem={({ item: option }) => {
              const checked = selected.includes(option.id)
              const image = images.find((a) => a.id === option.image)
              return (
                <View
                  style={{
                    width: Math.min(320, width - 64),
                    padding: 12,
                    borderRadius: 8,
                    borderWidth: 1,
                    borderColor: checked ? T.accent : T.border,
                    gap: 8,
                  }}
                >
                  <Text style={{ color: T.text, fontWeight: '600' }}>{option.title}</Text>
                  {option.description !== undefined && (
                    <Text style={{ color: T.dim, lineHeight: 20 }}>{option.description}</Text>
                  )}
                  {option.image !== undefined && (
                    image === undefined ? (
                      <Text style={{ color: T.dim }}>Image unavailable.</Text>
                    ) : !imagesEnabled ? (
                      <Text style={{ color: T.dim }}>Update cide to view this image.</Text>
                    ) : (
                      <View style={{ gap: 4 }}>
                        <AttachmentTile
                          instance={instance}
                          attachment={image}
                          refOf={refOf}
                          onOpen={() => setViewing(String(image.id))}
                        />
                        <Text style={{ color: T.dim, fontSize: 12 }}>Tap image to enlarge</Text>
                      </View>
                    )
                  )}
                  <Pressable
                    disabled={busy}
                    accessibilityRole={multiple ? 'checkbox' : 'radio'}
                    accessibilityState={{ checked, disabled: busy }}
                    accessibilityLabel={option.title}
                    onPress={() => setSelected((before) => toggleSelection(question, before, option.id))}
                    style={{
                      minHeight: 48,
                      marginTop: 'auto',
                      paddingHorizontal: 10,
                      paddingVertical: 10,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 10,
                      borderRadius: 6,
                      backgroundColor: checked ? T.panel : T.bg,
                    }}
                  >
                    <View
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: multiple ? 4 : 11,
                        borderWidth: 2,
                        borderColor: checked ? T.accent : T.dim,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {checked && (
                        <View style={{ width: 12, height: 12, borderRadius: multiple ? 1 : 6, backgroundColor: T.accent }} />
                      )}
                    </View>
                    <Text style={{ flex: 1, color: checked ? T.accent : T.text }}>
                      {checked ? (multiple ? 'Selected · tap to deselect' : 'Selected') : 'Select this option'}
                    </Text>
                  </Pressable>
                </View>
              )
            }}
          />
          {selected.length > 0 && (
            <ChipButton label="Clear selection" disabled={busy} onPress={() => setSelected([])} />
          )}
        </>
      )}
      {!enabled && <Text style={{ color: T.warn }}>Update desktop cide to send this answer.</Text>}
      <TextInput
        multiline
        editable={!busy}
        value={text}
        onChangeText={setText}
        accessibilityLabel="Your answer"
        placeholder={options.length > 0 ? 'Custom answer or additional details' : 'Your answer'}
        placeholderTextColor={T.dim}
        style={{
          color: T.text,
          borderWidth: 1,
          borderColor: T.border,
          borderRadius: 8,
          padding: 12,
          minHeight: 72,
          textAlignVertical: 'top',
          backgroundColor: T.bg,
        }}
      />
      {error !== null && <Text accessibilityRole="alert" style={{ color: T.bad }}>{error}</Text>}
      <ChipButton label={busy ? 'Sending…' : 'Answer'} disabled={busy || !enabled || !valid} onPress={() => void send()} />
      {viewing !== null && images.some((a) => a.id === viewing) && (
        <ImageViewer
          instance={instance}
          images={images}
          refOf={refOf}
          start={images.findIndex((a) => a.id === viewing)}
          onClose={() => setViewing(null)}
        />
      )}
    </View>
  )
}
