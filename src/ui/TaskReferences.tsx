import { Text } from 'react-native'
import { T } from './theme'

/** Only task IDs navigate. The surrounding model-authored text remains literal text. */
export function TaskReferences({ text, onOpenTask }: { text: string; onOpenTask?: ((task: string) => void) | undefined }) {
  if (onOpenTask === undefined) return <>{text}</>
  const parts = []
  let start = 0
  for (const match of text.matchAll(/(?<![\p{L}\p{N}_])t-[0-9]+(?![\p{L}\p{N}_])/gu)) {
    parts.push(text.slice(start, match.index), <Text key={match.index} accessibilityRole="link" accessibilityLabel={`Open task ${match[0]}`}
      style={{ color: T.accent, textDecorationLine: 'underline' }} onPress={() => onOpenTask(match[0])}>{match[0]}</Text>)
    start = match.index + match[0].length
  }
  parts.push(text.slice(start))
  return <>{parts}</>
}
