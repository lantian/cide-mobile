/**
 * Getting a downloaded attachment out of the app's cache: saved to a folder the person chose, or
 * handed to another app. (cide M136)
 *
 * The cache is the app's own and Android's cleaner may empty it, so "download to the phone" has
 * to mean a place the person can find in their file manager. On Android that is a folder picked
 * once through the Storage Access Framework and remembered; the app asks for no storage
 * permission at all, which a companion app that reads a desktop has no business holding.
 * iOS has no SAF, and its share sheet's *Save to Files* is the same act, so Save falls back to it.
 */
import { Platform } from 'react-native'
import * as FileSystem from 'expo-file-system'
import * as SecureStore from 'expo-secure-store'
import * as Sharing from 'expo-sharing'

const SAVE_DIR_KEY = 'cide.attachments.saveDir'

/** Open the system share sheet on a cached file — also Android's *Open with*. */
export async function share(uri: string, mime: string, name: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error('This phone cannot share files.')
  await Sharing.shareAsync(uri, { mimeType: mime, dialogTitle: name })
}

/**
 * Copy a cached file into the folder the person chose. Resolves with a sentence to show, or
 * `null` when they backed out of the folder picker.
 */
export async function saveToPhone(uri: string, mime: string, name: string): Promise<string | null> {
  if (Platform.OS !== 'android') {
    await share(uri, mime, name)
    return null
  }
  const SAF = FileSystem.StorageAccessFramework
  const remembered = await SecureStore.getItemAsync(SAVE_DIR_KEY)
  if (remembered !== null) {
    try {
      await copyInto(remembered, uri, mime, name)
      return `Saved ${name}.`
    } catch {
      // The grant was revoked, or the folder is gone. Forget it and ask again, once.
      await SecureStore.deleteItemAsync(SAVE_DIR_KEY)
    }
  }
  const picked = await SAF.requestDirectoryPermissionsAsync()
  if (!picked.granted) return null
  await SecureStore.setItemAsync(SAVE_DIR_KEY, picked.directoryUri)
  await copyInto(picked.directoryUri, uri, mime, name)
  return `Saved ${name}.`
}

async function copyInto(dir: string, uri: string, mime: string, name: string): Promise<void> {
  const SAF = FileSystem.StorageAccessFramework
  // SAF appends the extension it associates with `mime` itself, so a known type is created
  // without one — `shot.png` would otherwise land as `shot.png.png`. An unknown type keeps the
  // whole name, which is the only thing that says what the file is.
  const dot = name.lastIndexOf('.')
  const base = mime !== 'application/octet-stream' && dot > 0 ? name.slice(0, dot) : name
  const target = await SAF.createFileAsync(dir, base, mime)
  const encoding = FileSystem.EncodingType.Base64
  // One read and one write of the file's base64. On the tap that asked for it, for one file:
  // the cost the download path was built to avoid on every tile is fine here.
  const data = await FileSystem.readAsStringAsync(uri, { encoding })
  await SAF.writeAsStringAsync(target, data, { encoding })
}
