/**
 * Pairing: by camera, or by hand.
 *
 * The screen asks which before it asks for anything, because the two roads want different
 * things from the user and a screen offering both at once asks for all of it. Scanning wants a
 * camera permission and nothing typed; typing wants three fields, one of which is a key that
 * cannot reasonably be typed at all and must be pasted.
 *
 * **Typing is not a degraded road and is never removed.** A camera can be denied, broken,
 * covered, or absent from the device; cide may fail to encode the symbol; and the machine may
 * be reached over a VPN whose address is nowhere near the one on its screen. The code is eight
 * characters of an alphabet chosen so that nothing is read wrongly, which is a minute's typing
 * once per device — so the fallback is always one tap away, and the failure arms of the camera
 * road all end at it rather than at an apology.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { useRouter } from 'expo-router'
import { freshMemory, judge, remember } from '../src/pairing/scan'
import { groupSas } from '../src/crypto/seal'
import { pair, pairable } from '../src/net/pair'
import { InviteError, parseInvite, typedInvite } from '../src/pairing/parse'
import { wsDial } from '../src/net/connection'
import * as instances from '../src/store/instances'
import * as registry from '../src/store/registry'
import { PROTOCOL_VERSION } from '../src/protocol/version'
import { T } from '../src/ui/theme'

/** Which road the user picked. `choose` is the landing state and is never skipped. */
type Road = 'choose' | 'scan' | 'type'

export default function Pair() {
  const [road, setRoad] = useState<Road>('choose')
  const [uri, setUri] = useState('')
  const [address, setAddress] = useState('')
  const [code, setCode] = useState('')
  // The digits and the gate they are waiting on. `resolve` is held rather than called, because
  // the pairing is *suspended* inside `pair()` until somebody answers — which is the whole
  // point: the code has not been sent yet and must not be until it is confirmed.
  const [compare, setCompare] = useState<{ sas: string; answer: (ok: boolean) => void } | null>(
    null,
  )
  const [busy, setBusy] = useState(false)
  // Held in a ref rather than state: it is read by an event handler, never rendered, and a
  // stale closure over it would abort an attempt that had already been replaced.
  const attempt = useRef<AbortController | null>(null)
  // What the pairing is doing right now, in words. `null` while nothing is running.
  //
  // A spinner says *something is happening*. It cannot say *the code was read*, nor *this is
  // the third address of ten and the first two were not there* — and on a machine offering ten
  // private addresses, nine of them docker and VPN bridges, that is the difference between
  // waiting and concluding the app is broken.
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  // `scanned` is passed rather than routed through `uri` state, because a scan must pair on the
  // frame it was read: setting state and waiting for the render to call this would let the next
  // camera frame arrive first, and the debounce in `judge` is keyed on what has been *seen*,
  // not on what has been rendered.
  const go = async (scanned?: string) => {
    setError(null)
    setBusy(true)
    try {
      // Every road ends in an invite. A scan and a pasted URI are the same one line; the typed
      // road is three fields because a key cannot be typed.
      const line = scanned ?? uri
      // Two roads and two *different* invites, which is the point: a scanned one carries cide's
      // key and is authenticated by it, a typed one carries no key and is authenticated by the
      // six digits below. Building the typed one through a `cide://pair` URI — which is what
      // this did — meant inventing a key and an instance id, and an invented pinned key is
      // indistinguishable from a real one at exactly the moment the difference matters.
      const invite =
        line.trim().length > 0 ? parseInvite(line) : typedInvite(address, code, PROTOCOL_VERSION)

      // Checked before the code is spent: a pairing code is single use, so discovering the
      // mismatch afterwards would cost the user their one attempt as well as the explanation.
      const refusal = pairable(invite)
      if (refusal !== null) throw new InviteError(refusal)

      const controller = new AbortController()
      attempt.current = controller
      // Said before the first socket is opened, so a scan is acknowledged the instant it is
      // decoded rather than after however long the first unreachable address takes to fail.
      setProgress(scanned !== undefined ? 'Code read. Looking for that cide…' : 'Connecting…')
      const paired = await pair({
        invite,
        signal: controller.signal,
        onAttempt: ({ host, index, total }) =>
          setProgress(total > 1 ? `Trying ${host} — ${index + 1} of ${total}` : `Trying ${host}`),
        dial: wsDial,
        deviceName: 'phone',
        platform: 'android',
        appVersion: '0.1.0',
        // Only ever called on the typed road — `pair` does not ask when the key was pinned.
        confirm: (sas) =>
          new Promise<boolean>((answer) => {
            setCompare({
              sas,
              answer: (ok) => {
                setCompare(null)
                answer(ok)
              },
            })
          }),
      })
      await instances.save(paired)
      registry.open(paired)
      router.back()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      attempt.current = null
      setCompare(null)
      setProgress(null)
      setBusy(false)
    }
  }

  const field = {
    color: T.text,
    borderWidth: 1,
    borderColor: T.border,
    borderRadius: 8,
    padding: 12,
    backgroundColor: T.panel,
    fontSize: 15,
  } as const

  // Ahead of every other branch: a pairing is suspended behind this answer, and any screen
  // drawn over it would be a screen with a half-finished handshake behind it.
  if (compare !== null) {
    return <Confirm sas={compare.sas} onAnswer={compare.answer} />
  }

  if (road === 'choose') {
    return (
      <View style={{ flex: 1, backgroundColor: T.bg, padding: 16, gap: 14 }}>
        <Text style={{ color: T.dim, lineHeight: 21 }}>
          On the machine: Settings → Remote access → “Pair a device…”. It shows a code you can
          scan, and the same details in writing.
        </Text>
        <Choice
          title="Scan the code"
          detail="Point the camera at what cide is showing."
          onPress={() => setRoad('scan')}
        />
        <Choice
          title="Type it in"
          detail="The address and the eight-character code. Use this if there is no camera, or the machine is on a VPN."
          onPress={() => setRoad('type')}
        />
      </View>
    )
  }

  if (road === 'scan') {
    return (
      <Scanner
        busy={busy}
        error={error}
        progress={progress}
        onRead={(read) => void go(read)}
        onGiveUp={() => setRoad('type')}
      />
    )
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: T.bg }}
      contentContainerStyle={{ padding: 16, gap: 14 }}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={{ color: T.dim, lineHeight: 21 }}>
        On the machine: Settings → Remote access → “Pair a device…”. Paste the whole
        <Text style={{ color: T.text }}> cide://pair</Text> line if you have it, or type the
        address and the code. You will be shown six digits to check against the machine.
      </Text>

      <TextInput
        placeholder="cide://pair?…"
        placeholderTextColor={T.dim}
        value={uri}
        onChangeText={setUri}
        autoCapitalize="none"
        autoCorrect={false}
        style={field}
      />

      <Text style={{ color: T.dim, textAlign: 'center' }}>or</Text>

      <TextInput
        placeholder="192.168.1.4:17643"
        placeholderTextColor={T.dim}
        value={address}
        onChangeText={setAddress}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        style={field}
      />
      <TextInput
        placeholder="XXXX-XXXX"
        placeholderTextColor={T.dim}
        value={code}
        onChangeText={setCode}
        autoCapitalize="characters"
        autoCorrect={false}
        style={[field, { letterSpacing: 3, fontSize: 20, textAlign: 'center' }]}
      />

      {progress !== null ? (
        <Text style={{ color: T.dim, fontSize: 13, lineHeight: 19 }}>{progress}</Text>
      ) : null}

      {error !== null ? (
        <View style={{ padding: 12, borderRadius: 8, backgroundColor: '#3d1d1d' }}>
          <Text style={{ color: T.bad, lineHeight: 20 }}>{error}</Text>
        </View>
      ) : null}

      {/* While an attempt is running this is a way *out* of it, not a disabled spinner. An
          invite can carry several addresses and they are tried in turn, so a pairing that is
          going nowhere takes a while to say so — and a button that only spins is the thing a
          person reports as the app having hung. Aborting before the code is sent leaves it
          unspent, so pressing this costs nothing but the attempt. */}
      <Pressable
        onPress={() => {
          if (busy) attempt.current?.abort()
          else void go()
        }}
        style={{
          padding: 14,
          borderRadius: 10,
          alignItems: 'center',
          flexDirection: 'row',
          justifyContent: 'center',
          gap: 10,
          borderWidth: 1,
          borderColor: busy ? T.border : T.accent,
          backgroundColor: busy ? 'transparent' : T.accent,
        }}
      >
        {busy ? (
          <>
            <ActivityIndicator color={T.dim} />
            <Text style={{ color: T.text, fontSize: 16 }}>Stop trying</Text>
          </>
        ) : (
          <Text style={{ color: '#06121f', fontSize: 16 }}>Pair</Text>
        )}
      </Pressable>

      <Text style={{ color: T.dim, fontSize: 12, lineHeight: 18 }}>
        The code is good for two minutes and for one device. A wrong code cancels it, so type it
        carefully rather than quickly.
      </Text>
    </ScrollView>
  )
}

function Choice({ title, detail, onPress }: { title: string; detail: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        padding: 16,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: T.border,
        backgroundColor: T.panel,
        gap: 6,
      }}
    >
      <Text style={{ color: T.text, fontSize: 17 }}>{title}</Text>
      <Text style={{ color: T.dim, fontSize: 13, lineHeight: 19 }}>{detail}</Text>
    </Pressable>
  )
}

/**
 * The camera road.
 *
 * Three states before there is ever a picture, and each one is a sentence rather than a blank
 * viewfinder: permission not yet asked, permission refused, and permission granted. A denied
 * camera renders as a black rectangle that never resolves if this is got wrong, and the user
 * cannot tell that from a camera pointed at something dark — which is why every arm here ends
 * at a button, and one of them is always “Type it in instead”.
 */
function Scanner({
  busy,
  error,
  progress,
  onRead,
  onGiveUp,
}: {
  busy: boolean
  error: string | null
  /** What the pairing is doing, once a code has been read. `null` while still looking. */
  progress: string | null
  onRead: (uri: string) => void
  onGiveUp: () => void
}) {
  const [permission, requestPermission] = useCameraPermissions()
  // A ref and not state: this is read and written inside the scanner callback, which fires
  // between renders, and a stale closure over a state value would let the same symbol through
  // a second time — spending a single-use code twice and reporting the second failure as the
  // outcome.
  const memory = useRef(freshMemory())
  const [rejected, setRejected] = useState<string | null>(null)
  // Whether anything at all has been decoded, and for how long nothing has.
  //
  // Without this a camera that resolves no barcode looks exactly like one that is working and
  // simply has not been pointed yet — the screen says "point it at the code" for ever, and the
  // honest reading of that is "this app is broken". A QR that is too dense for the distance
  // fails silently and this is the only place that can say so.
  const [patience, setPatience] = useState(false)

  useEffect(() => {
    const slow = setTimeout(() => setPatience(true), 6_000)
    return () => clearTimeout(slow)
  }, [])

  const onBarcode = useCallback(
    ({ data }: { data: string }) => {
      setPatience(false)
      const verdict = judge(data, memory.current)
      if (verdict.kind === 'ignore') return
      memory.current = remember(memory.current, data)
      if (verdict.kind === 'reject') {
        setRejected(verdict.why)
        return
      }
      setRejected(null)
      onRead(verdict.uri)
    },
    [onRead],
  )

  const frame = { flex: 1, backgroundColor: T.bg, padding: 16, gap: 14 } as const

  if (permission === null) {
    // Still being read from the OS. Nothing to say yet, and a sentence here would flash.
    return <View style={frame} />
  }

  if (!permission.granted) {
    return (
      <View style={frame}>
        <Text style={{ color: T.dim, lineHeight: 21 }}>
          {permission.canAskAgain
            ? 'Scanning needs the camera. It is used for this one code and nothing else — no photo is kept and nothing leaves the phone.'
            : 'The camera is turned off for this app in Android settings, so scanning is not available until it is turned back on.'}
        </Text>
        {permission.canAskAgain ? (
          <Pressable
            onPress={() => void requestPermission()}
            style={{ padding: 14, borderRadius: 10, alignItems: 'center', backgroundColor: T.accent }}
          >
            <Text style={{ color: '#06121f', fontSize: 16 }}>Allow the camera</Text>
          </Pressable>
        ) : null}
        <Choice title="Type it in instead" detail="The address and the eight-character code." onPress={onGiveUp} />
      </View>
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <CameraView
        style={{ flex: 1 }}
        facing="back"
        // Only QR. A camera told to read every symbology reads the barcode on the laptop's
        // underside from across the desk, and every one of those is a rejection the user has to
        // read past.
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={busy ? undefined : onBarcode}
      />
      <View style={{ padding: 16, gap: 12, backgroundColor: T.bg }}>
        {busy ? <ActivityIndicator color={T.text} /> : null}
        {error !== null ? (
          <Text style={{ color: T.bad, lineHeight: 20 }}>{error}</Text>
        ) : rejected !== null ? (
          <Text style={{ color: T.dim, lineHeight: 20 }}>{rejected}</Text>
        ) : (
          <Text style={{ color: T.dim, lineHeight: 20 }}>
            {progress ??
              (patience
                ? 'Still looking. If nothing happens, the code may be too small to read from ' +
                  'here — move closer, or type the address in instead.'
                : 'Point it at the code on the machine.')}
          </Text>
        )}
        <Choice title="Type it in instead" detail="The address and the eight-character code." onPress={onGiveUp} />
      </View>
    </View>
  )
}

/**
 * Compare six digits with the machine, and decide.
 *
 * This is the whole of the typed road's security, and it is worth being blunt about why. A
 * scanned pairing carries cide's public key in the QR, so the exchange could not have completed
 * against anybody else. A typed one carries an address and eight characters; the key comes off
 * the wire, and anybody able to sit between this phone and that machine can put their own there.
 * Such a relay runs two exchanges and therefore derives two different numbers — so the one
 * defence is a person looking at both screens.
 *
 * Three things follow, and each is a deliberate choice rather than a style.
 *
 * **Nothing has been sent yet.** The pairing code is still on this phone; `pair()` is suspended
 * waiting for this answer. A confirmation collected *after* the code went out would be a dialog
 * reporting an attack it had already lost.
 *
 * **Neither button is the safe default.** There is no primary styling, no auto-focus and no
 * dismissal by tapping outside: a person who taps without reading should not fall through to
 * "yes". *No* is listed first for the same reason.
 *
 * **The question names what to do, not what to know.** "Does the machine show this number?" is
 * answerable by looking; "verify the fingerprint" is not.
 */
function Confirm({ sas, onAnswer }: { sas: string; onAnswer: (ok: boolean) => void }) {
  return (
    <View style={{ flex: 1, backgroundColor: T.bg, padding: 16, gap: 18 }}>
      <Text style={{ color: T.text, fontSize: 17, lineHeight: 24 }}>
        Does cide show this number?
      </Text>

      <Text
        style={{
          color: T.text,
          // Monospaced and tabular so 1 and 7 take the same width as 0 and 8. A proportional 1
          // makes two identical numbers look different at a glance, which is the one misread
          // this screen must not produce.
          fontFamily: 'monospace',
          fontVariant: ['tabular-nums'],
          fontSize: 44,
          letterSpacing: 4,
          textAlign: 'center',
          paddingVertical: 12,
        }}
      >
        {groupSas(sas)}
      </Text>

      <Text style={{ color: T.dim, lineHeight: 21 }}>
        Look at the pairing window on the machine. If it shows something else — or shows nothing
        — stop: somebody may be between this phone and that machine.
      </Text>

      <Pressable
        onPress={() => onAnswer(false)}
        style={{ padding: 16, borderRadius: 10, borderWidth: 1, borderColor: T.border, alignItems: 'center' }}
      >
        <Text style={{ color: T.text, fontSize: 16 }}>No, stop</Text>
      </Pressable>
      <Pressable
        onPress={() => onAnswer(true)}
        style={{ padding: 16, borderRadius: 10, borderWidth: 1, borderColor: T.border, alignItems: 'center' }}
      >
        <Text style={{ color: T.text, fontSize: 16 }}>Yes, it matches</Text>
      </Pressable>
    </View>
  )
}
