/**
 * The instances this device is paired with, and where their keys live.
 *
 * # Two stores, because two kinds of thing
 *
 * A device's key is a **secret**: it goes in `expo-secure-store`, which is the Keystore on
 * Android and the Keychain on iOS, and it never leaves. Everything else — the label, the
 * addresses, which host answered last — is not secret and is only here so the list can be drawn
 * before any socket exists.
 *
 * They are kept in the same place anyway, one `SecureStore` item per instance, for a duller
 * reason: a metadata row whose secret is missing is an instance that cannot connect and cannot
 * say why, and keeping the two together makes that state unreachable rather than merely unlikely.
 *
 * `SecureStore` holds about 2 KB per item on Android, which is why the *index* is a list of ids
 * and each instance is its own item rather than one blob that grows with every phone you pair.
 */
import * as SecureStore from 'expo-secure-store'
import type { Paired } from '../net/connection'

const INDEX_KEY = 'cide.instances'
const itemKey = (id: string) => `cide.instance.${id}`

/** What is stored, with the byte arrays as hex so it survives JSON. */
interface Stored {
  instanceId: string
  label: string
  hosts: string[]
  deviceId: string
  serverPublic: string
  key: string
  /** The address that answered last, tried first next time. */
  preferred?: string
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
const unhex = (text: string) => {
  const out = new Uint8Array(text.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16)
  return out
}

export interface Instance extends Paired {
  readonly preferred?: string
}

async function readIndex(): Promise<string[]> {
  const raw = await SecureStore.getItemAsync(INDEX_KEY)
  if (raw === null) return []
  try {
    return JSON.parse(raw) as string[]
  } catch {
    return []
  }
}

export async function list(): Promise<Instance[]> {
  const ids = await readIndex()
  const out: Instance[] = []
  for (const id of ids) {
    const raw = await SecureStore.getItemAsync(itemKey(id))
    // An index entry with no item is a half-written pairing or a partial wipe. Skipped rather
    // than surfaced: there is nothing a user could do about a row that has no key.
    if (raw === null) continue
    const stored = JSON.parse(raw) as Stored
    out.push({
      instanceId: stored.instanceId,
      label: stored.label,
      hosts: stored.hosts,
      deviceId: stored.deviceId,
      serverPublic: unhex(stored.serverPublic),
      key: unhex(stored.key),
      ...(stored.preferred === undefined ? {} : { preferred: stored.preferred }),
    })
  }
  return out
}

/**
 * Save a pairing, replacing any earlier one for the same instance.
 *
 * Replacing rather than appending is what the instance id is *for*: re-pairing a cide you already
 * know must update that row, not add a second one for the same machine under a new key.
 */
export async function save(paired: Paired, preferred?: string): Promise<void> {
  const stored: Stored = {
    instanceId: paired.instanceId,
    label: paired.label,
    hosts: [...paired.hosts],
    deviceId: paired.deviceId,
    serverPublic: hex(paired.serverPublic),
    key: hex(paired.key),
    ...(preferred === undefined ? {} : { preferred }),
  }
  await SecureStore.setItemAsync(itemKey(paired.instanceId), JSON.stringify(stored))
  const ids = await readIndex()
  if (!ids.includes(paired.instanceId)) {
    await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify([...ids, paired.instanceId]))
  }
}

/** Forget an instance. The key goes with it, which is the point. */
export async function forget(instanceId: string): Promise<void> {
  await SecureStore.deleteItemAsync(itemKey(instanceId))
  const ids = await readIndex()
  await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify(ids.filter((id) => id !== instanceId)))
}
