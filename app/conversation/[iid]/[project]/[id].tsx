import { useLocalSearchParams } from 'expo-router'
import { Conversation } from '../../../../src/conversations/Conversation'
export default function ConversationRoute() {
  const { iid, project, id } = useLocalSearchParams<{ iid: string; project: string; id: string }>()
  return <Conversation iid={iid} project={project} id={id} />
}
