/**
 * The platform half of notifications. (M75)
 *
 * Everything that *decides* lives in `decide.ts` and is pure; this file only carries the
 * decision out. The split is deliberate — a duplicate or missing notification is the kind of bug
 * that can only be found by stating the inputs, and none of those inputs are reachable from a
 * device API.
 *
 * # The ceiling, stated where somebody will read it
 *
 * There is no push service and there is not going to be one. A local notification needs running
 * code, and the OS suspends this app — iOS always, Android often. So the honest behaviour is:
 * notify while connected, and **reconcile into a burst when the app is next opened**. That is the
 * mechanism rather than a fallback, which is why `decide` conditions nothing on how recent a wait
 * is: anything in the set newer than what was announced is news, however old.
 */
import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'
import type { Decision, Ledger } from './decide'

/**
 * Channels are created **before** permission is asked.
 *
 * Android 13 shows the permission prompt against the channels an app has declared, and a channel
 * created afterwards inherits nothing the user chose. Getting this order wrong is invisible in
 * development, where permission was granted long ago.
 */
export async function prepare(): Promise<boolean> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('awaiting', {
      name: 'Waiting for you',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 200, 100, 200],
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
    })
    await Notifications.setNotificationChannelAsync('finished', {
      name: 'Finished',
      importance: Notifications.AndroidImportance.DEFAULT,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
    })
  }

  const existing = await Notifications.getPermissionsAsync()
  if (existing.granted) return true
  // Asked once. A refusal is a decision, and re-prompting on every launch is how an app gets
  // its notifications turned off in system settings rather than merely declined.
  if (!existing.canAskAgain) return false
  const asked = await Notifications.requestPermissionsAsync()
  return asked.granted
}

/**
 * Raise and dismiss what the decision says, and hand back the ledger to store.
 *
 * `identifier` is the decision's own id, which carries the wait's stamp — so the platform
 * enforces "one notification per wait" too: a repeat replaces rather than stacks, and a *second*
 * wait on the same session is a genuinely new one.
 */
export async function apply(decision: Decision): Promise<Ledger> {
  for (const id of decision.dismiss) {
    await Notifications.dismissNotificationAsync(id).catch(() => undefined)
  }
  for (const raise of decision.raise) {
    await Notifications.scheduleNotificationAsync({
      identifier: raise.id,
      content: {
        title: raise.title,
        body: raise.body,
        data: raise.data,
        ...(Platform.OS === 'android' ? { channelId: raise.channel } : {}),
      },
      // Now. `null` is "deliver immediately" — a trigger of any kind would put this behind the
      // scheduler, which on Android rounds to the minute.
      trigger: null,
    }).catch(() => undefined)
  }
  return decision.ledger
}

/**
 * Take down whatever is on screen about one session.
 *
 * By **payload**, not by identifier, and that is the point. A notification's id carries the
 * stamp of the wait it announced (`sess:<instance>:<session>:<since>`), so dismissing by id
 * would need the caller to know which wait it was looking at — and it is not looking at a wait,
 * it is looking at a *session*. The tray is asked what it is showing and only the entries whose
 * data names this session are taken down.
 *
 * Which is also why this cannot be `dismissAllNotificationsAsync`: the user opened one console,
 * and clearing the others would throw away the only record that three other sessions are still
 * waiting — the exact thing they opened the app to find out.
 */
export async function dismissFor(session: string): Promise<void> {
  const shown = await Notifications.getPresentedNotificationsAsync().catch(() => [])
  for (const item of shown) {
    const data = item.request.content.data as Record<string, unknown> | null | undefined
    if (data?.['session'] === session) {
      await Notifications.dismissNotificationAsync(item.request.identifier).catch(() => undefined)
    }
  }
}

/**
 * How a notification the app was not running for reaches a screen.
 *
 * Read **once** and cleared. `getLastNotificationResponseAsync` keeps answering with the same
 * response for the life of the process, so a component that read it on every mount would jump
 * back to the same session every time the tree remounted — which on a cold start from a tap is
 * exactly when it remounts.
 */
let coldStartHandled = false

export async function coldStartTarget(): Promise<
  { instanceId: string; session: string } | null
> {
  if (coldStartHandled) return null
  coldStartHandled = true
  const response = await Notifications.getLastNotificationResponseAsync()
  return targetOf(response)
}

export function targetOf(
  response: Notifications.NotificationResponse | null,
): { instanceId: string; session: string } | null {
  const data = response?.notification.request.content.data
  if (data === undefined || data === null) return null
  const instanceId = (data as Record<string, unknown>)['instanceId']
  const session = (data as Record<string, unknown>)['session']
  if (typeof instanceId !== 'string' || typeof session !== 'string') return null
  return { instanceId, session }
}
