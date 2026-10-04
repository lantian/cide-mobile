/** A small outlined pill button, for the attachment actions. */
import { Pressable, Text } from 'react-native'
import { T } from './theme'

export function ChipButton({
  label,
  onPress,
  disabled = false,
}: {
  label: string
  onPress: () => void
  disabled?: boolean
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={{
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: disabled ? T.border : T.accent,
      }}
    >
      <Text style={{ color: disabled ? T.dim : T.accent, fontSize: 13 }}>{label}</Text>
    </Pressable>
  )
}
