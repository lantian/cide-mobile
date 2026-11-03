/** One native text range can cross every row; live repaints cannot move its contents. */
import { useState } from 'react'
import { Modal, Pressable, ScrollView, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import * as Clipboard from 'expo-clipboard'
import { T } from '../../ui/theme'
import { FACES } from './Screen'
export function Selection({ text, onDone }: { text: string | null; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null)
  return (
    <Modal visible={text !== null} animationType="slide" onRequestClose={onDone}>
      <SafeAreaView style={{ flex: 1, backgroundColor: T.bg }}>
        <View style={{ flexDirection: 'row', padding: 16, justifyContent: 'space-between' }}>
          <Pressable onPress={onDone}>
            <Text style={{ color: T.accent }}>Done</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              void Clipboard.setStringAsync(text ?? '').catch(() =>
                setError('The clipboard could not be written.'),
              )
            }}
          >
            <Text style={{ color: T.accent }}>Copy all</Text>
          </Pressable>
        </View>
        <Text style={{ paddingHorizontal: 16, paddingBottom: 8, color: T.dim }}>
          Select text to copy. This snapshot includes the loaded console text.
        </Text>
        {error === null ? null : (
          <Text style={{ color: T.bad, paddingHorizontal: 16 }}>{error}</Text>
        )}
        <ScrollView contentContainerStyle={{ padding: 16 }}>
          <Text
            selectable
            allowFontScaling={false}
            style={{ color: T.text, fontSize: 13, lineHeight: 18, fontFamily: FACES.regular }}
          >
            {text ?? ''}
          </Text>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  )
}
