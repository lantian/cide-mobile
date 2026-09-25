/**
 * The shell: a dark stack, and the instances brought up once at launch.
 *
 * Connections live in `src/store/registry.ts`, outside React, so they survive navigation — a
 * screen that unmounts because another was pushed must not tear down the socket it was watching,
 * or every navigation costs a handshake.
 */
import { useEffect } from 'react'
import { Stack, useRouter } from 'expo-router'
import * as Notifications from 'expo-notifications'
import { StatusBar } from 'expo-status-bar'
import { Text, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { getRandomBytes } from 'expo-crypto'
import { installRandom } from '../src/crypto/random'
import * as instances from '../src/store/instances'
import * as registry from '../src/store/registry'
import * as notify from '../src/notify/driver'
import { coldStartTarget, targetOf } from '../src/notify/notifier'

// Before anything else, and at module scope on purpose: Hermes has no `crypto.getRandomValues`,
// so without this the first handshake fails inside a library three levels down. Installed here
// rather than lazily because there is no useful moment later than "the app exists".
installRandom((length) => getRandomBytes(length))

// How a notification behaves while the app is in front of the user. Set at module scope
// because the handler must exist before any notification can arrive, which on a cold start
// from a tap is immediately.
//
// Shown rather than swallowed: the default is to suppress a notification whose app is already
// open, and that is wrong here — the app being open says nothing about whether the *session*
// that finished is the one on screen. `decide` already refuses to announce the session being
// looked at, so anything reaching here is about a different one.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    // `shouldShowAlert` is the 0.29 spelling; the banner/list pair is what replaces it in
    // later versions. Both are set so this survives the upgrade either way.
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
})

/**
 * What a crash looks like instead of a white screen.
 *
 * expo-router renders this in place of a route that threw. Worth having for one specific reason:
 * a module-scope failure — a missing global, say — shows up as a blank page and a message about
 * the navigation container, naming nothing. This puts the actual error on the device, which is
 * the only place it can be read when the build is a release one with no stack.
 */
export function ErrorBoundary({ error, retry }: { error: Error; retry: () => Promise<void> }) {
  return (
    <View style={{ flex: 1, backgroundColor: '#0d1117', padding: 20, gap: 12, justifyContent: 'center' }}>
      <Text style={{ color: '#ff6b6b', fontSize: 18 }}>Something went wrong</Text>
      <Text style={{ color: '#c9d1d9', fontFamily: 'monospace', fontSize: 13 }}>{error.message}</Text>
      <Text style={{ color: '#8b949e', fontSize: 11 }} numberOfLines={12}>
        {error.stack}
      </Text>
      <Text onPress={() => void retry()} style={{ color: '#6db3ff', fontSize: 16, paddingTop: 8 }}>
        Try again
      </Text>
    </View>
  )
}

export default function Layout() {
  const router = useRouter()

  useEffect(() => {
    // Once. Anything already open is left alone by `registry.open`.
    void instances.list().then((saved) => {
      for (const instance of saved) registry.open(instance)
    })
  }, [])

  // The notification loop, started beside the connections and outside React's tree for the same
  // reason: a turn finishing must be noticed whether or not a screen is mounted.
  useEffect(() => notify.start(), [])

  useEffect(() => {
    /**
     * Navigate **first**, connect behind it.
     *
     * A tap that waits on a socket before it moves feels broken — and the session screen is
     * built to render an empty grid and fill it, which is exactly what it does on a cold start
     * anyway. Routing on the connection would make the common case (the app was already
     * running, the socket is live) wait for a check that is going to pass.
     */
    const go = (target: { instanceId: string; session: string } | null) => {
      if (target === null || target.instanceId === 'demo') return
      router.push(`/session/${target.instanceId}/${target.session}`)
    }

    // A tap that arrived while the app was running.
    const live = Notifications.addNotificationResponseReceivedListener((response) =>
      go(targetOf(response)),
    )
    // And one that started it. Read once and cleared — see `coldStartTarget`.
    void coldStartTarget().then(go)
    return () => live.remove()
  }, [router])

  return (
    // The root every gesture detector needs above it — `ProjectSwipe`'s, today. Without it a
    // `GestureDetector` throws on first render, on every screen that has one. (M91)
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: '#0d1117' }}>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: '#161b22' },
          headerTintColor: '#c9d1d9',
          contentStyle: { backgroundColor: '#0d1117' },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'cide' }} />
        <Stack.Screen name="pair" options={{ title: 'Pair a device' }} />
        <Stack.Screen name="instance/[iid]" options={{ title: 'Sessions' }} />
        <Stack.Screen name="session/[iid]/[sid]" options={{ title: 'Session' }} />
      </Stack>
    </GestureHandlerRootView>
  )
}
