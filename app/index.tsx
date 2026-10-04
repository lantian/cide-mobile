/**
 * The instances this phone is paired with.
 *
 * The landing screen, and deliberately a list of *machines* rather than of sessions: the first
 * question on opening this app is which cide, because the answer is usually "the one that is not
 * the dev one".
 */
import { useCallback, useState, useSyncExternalStore } from 'react'
import { Alert, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { Link, useFocusEffect, useRouter } from 'expo-router'
import * as instances from '../src/store/instances'
import * as registry from '../src/store/registry'
import { aliasFrom, nameOf } from '../src/store/instanceName'
import type { Paired } from '../src/net/connection'
import * as choice from '../src/store/projectChoice'
import * as notify from '../src/notify/driver'
import { T } from '../src/ui/theme'
import { Badge } from '../src/ui/Badge'
import { machineCounts, machineSummary, waitingByProject, waitingIn } from '../src/agents/model'

/**
 * Forget a paired instance, after asking.
 *
 * Both halves, in this order: the live connection is dropped first so nothing is still writing
 * to the store when its credentials go, then the credentials themselves. Leaving the connection
 * up would have it reconnect against a device cide has never heard of and sit in `revoked` for
 * the rest of the session.
 *
 * This is the device's own record only. cide keeps its side until somebody revokes the device in
 * its Settings — this app cannot revoke itself, and saying otherwise would leave a row on the
 * machine that nothing will ever remove.
 */
function forget(instanceId: string, label: string): void {
  Alert.alert(`Forget ${label}?`, 'This phone will need to be paired again from that machine.', [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'Forget',
      style: 'destructive',
      onPress: () => {
        registry.close(instanceId)
        void instances.forget(instanceId)
        // And its project choice, or a re-pair of the same machine inherits a filter nobody set.
        choice.drop(instanceId)
      },
    },
  ])
}

/**
 * What a long press on a machine offers.
 *
 * A sheet rather than going straight to Forget, now that there are two things to do to a row:
 * renaming is cheap and undoable, forgetting is neither, and the one gesture should not lead
 * directly to the costly one. Forget keeps its own confirmation behind this.
 */
function actions(paired: Paired, onRename: (paired: Paired) => void): void {
  const name = nameOf(paired)
  Alert.alert(name, undefined, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Forget…', style: 'destructive', onPress: () => forget(paired.instanceId, name) },
    { text: 'Rename…', onPress: () => onRename(paired) },
  ])
}

/** Store the new alias, then redraw under it. Store first, so a redraw never shows a name a restart would lose. */
async function rename(paired: Paired, text: string): Promise<void> {
  const alias = aliasFrom(text, paired.label)
  await instances.rename(paired.instanceId, alias)
  registry.relabel(paired.instanceId, alias)
}

export default function Instances() {
  const views = useSyncExternalStore(registry.subscribe, registry.getSnapshot)
  const router = useRouter()
  // The machine being renamed, and what the box says so far. `null` is no dialog.
  const [renaming, setRenaming] = useState<Paired | null>(null)
  const [draft, setDraft] = useState('')
  const startRename = (paired: Paired) => {
    setDraft(nameOf(paired))
    setRenaming(paired)
  }
  const commitRename = () => {
    if (renaming !== null) void rename(renaming, draft)
    setRenaming(null)
  }

  // Coming back from pairing should show what was just paired without a restart.
  useFocusEffect(
    useCallback(() => {
      void instances.list().then((saved) => {
        for (const instance of saved) registry.open(instance)
      })
    }, []),
  )

  return (
    <ScrollView style={{ flex: 1, backgroundColor: T.bg }} contentContainerStyle={{ padding: 16, gap: 12 }}>
      {views.length === 0 ? (
        <Text style={{ color: T.dim, lineHeight: 22 }}>
          No cide is paired yet. Open Settings → Remote access on the machine you want to reach,
          turn it on, and press “Pair a device…”.
        </Text>
      ) : null}

      {views.length > 0 ? (
        <Text style={{ color: T.dim, fontSize: 12 }}>Press and hold a machine to rename or forget it.</Text>
      ) : null}

      {/* A notification on demand, in **development builds only**.
          It exists because the feature is otherwise unobservable until an agent happens to
          finish a turn, which makes "does this device actually show them" an expensive
          question during development. It is not a feature: a button on the first screen of a
          shipped app, whose entire job is to send a message that says nothing, is a control
          somebody presses once wondering what it does and never again.
          `__DEV__` is false in a release bundle, so this is not merely hidden — Metro drops
          the branch, and the string does not reach the APK. */}
      {__DEV__ && views.length > 0 ? (
        <Pressable
          onPress={() => {
            void notify.demonstrate(views[0] === undefined ? 'cide' : nameOf(views[0].paired)).then((granted) => {
              if (!granted) {
                Alert.alert(
                  'Notifications are off',
                  'Android is not letting this app post notifications. Turn them on for cide in system settings.',
                )
              }
            })
          }}
          style={{
            padding: 12,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: T.border,
            alignItems: 'center',
          }}
        >
          <Text style={{ color: T.dim, fontSize: 13 }}>Send a test notification</Text>
        </Pressable>
      ) : null}

      {views.map((view) => {
        // Only waits for a console this device can list — the count the Consoles row on the
        // next screen shows, over every project. cide's set also holds sessions no pane shows
        // (a closed tab parks its child, and a parked child can go on waiting), and counting
        // those here made this badge promise something the screen behind it had nowhere to show.
        const waiting = waitingIn(waitingByProject(view.sessions, view.awaiting), null)
        const counts = machineCounts(view)
        return (
          <Pressable
            key={view.paired.instanceId}
            onPress={() => router.push(`/instance/${view.paired.instanceId}`)}
            // Long press rather than a delete button on every row. Forgetting an instance is
            // not undoable from here — a pairing code is single use, so getting it back means
            // walking to the machine and minting another — and a control that costs that much
            // should not sit under a thumb that was aiming at the row.
            onLongPress={() => actions(view.paired, startRename)}
            style={{
              padding: 14,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: waiting > 0 ? T.warn : T.border,
              backgroundColor: T.panel,
              gap: 4,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Text style={{ color: T.text, fontSize: 17, flex: 1 }} numberOfLines={1}>
                {nameOf(view.paired)}
              </Text>
              <Badge count={waiting} />
            </View>
            {/* cide's own name under a renamed row. The alias is this phone's; the desktop,
                its Settings → Remote access and every other device still say this one, and a
                row that hid it would leave nothing to match the two up by. */}
            {nameOf(view.paired) !== view.paired.label ? (
              <Text style={{ color: T.dim, fontSize: 12 }} numberOfLines={1}>
                {view.paired.label}
              </Text>
            ) : null}
            <Text style={{ color: T.dim, fontSize: 13 }}>
              {describe(view.phase, view.detail)}
              {/* Which road, once there is more than one: home LAN or the remote address. */}
              {view.phase === 'ready' && view.paired.hosts.length > 1 && view.host !== undefined
                ? ` via ${view.host}`
                : ''}
              {view.phase === 'ready' ? ` · ${counts.consoles} consoles` : ''}
            </Text>
            {/* What the machine is *doing*, which the console count is not. Fixed shape, zeros
                included — `machineSummary` carries the argument. */}
            {view.phase === 'ready' ? (
              <Text style={{ color: T.dim, fontSize: 13 }}>{machineSummary(counts)}</Text>
            ) : null}
            {waiting > 0 ? (
              <Text style={{ color: T.warn, fontSize: 13 }}>
                {waiting} waiting for you
              </Text>
            ) : null}
          </Pressable>
        )
      })}

      <Link href="/pair" asChild>
        <Pressable
          style={{
            padding: 14,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: T.accent,
            alignItems: 'center',
          }}
        >
          <Text style={{ color: T.accent, fontSize: 16 }}>Pair a device…</Text>
        </Pressable>
      </Link>

      {/* A modal of our own because `Alert.prompt` is iOS-only, and this app is used on
          Android first. */}
      <Modal
        visible={renaming !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setRenaming(null)}
      >
        <View
          style={{
            flex: 1,
            justifyContent: 'center',
            padding: 24,
            backgroundColor: 'rgba(0,0,0,0.6)',
          }}
        >
          <View
            style={{
              padding: 16,
              gap: 12,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: T.border,
              backgroundColor: T.panel,
            }}
          >
            <Text style={{ color: T.text, fontSize: 17 }}>Rename machine</Text>
            <Text style={{ color: T.dim, fontSize: 13, lineHeight: 18 }}>
              Only on this phone. Leave it empty to use cide’s name
              {renaming === null ? '' : `, “${renaming.label}”`}.
            </Text>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder={renaming?.label ?? ''}
              placeholderTextColor={T.dim}
              autoFocus
              selectTextOnFocus
              returnKeyType="done"
              onSubmitEditing={commitRename}
              style={{
                color: T.text,
                borderWidth: 1,
                borderColor: T.border,
                borderRadius: 8,
                paddingHorizontal: 12,
                paddingVertical: 9,
                backgroundColor: T.bg,
                fontSize: 15,
              }}
            />
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 20 }}>
              <Pressable onPress={() => setRenaming(null)} hitSlop={8}>
                <Text style={{ color: T.dim, fontSize: 15 }}>Cancel</Text>
              </Pressable>
              <Pressable onPress={commitRename} hitSlop={8}>
                <Text style={{ color: T.accent, fontSize: 15 }}>Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  )
}

/**
 * What a phase means, in words.
 *
 * The two terminal phases carry cide's own sentence, because it names which end to update or
 * that this phone was removed — and there is nothing better this app could say about either.
 */
function describe(phase: string, detail: string | undefined): string {
  switch (phase) {
    case 'ready':
      return 'connected'
    case 'connecting':
    case 'handshaking':
      return 'connecting…'
    case 'backoff':
      return `reconnecting — ${detail ?? 'lost the connection'}`
    case 'incompatible':
    case 'revoked':
      return detail ?? phase
    default:
      return 'not connected'
  }
}
