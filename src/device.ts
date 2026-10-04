/**
 * What this phone tells cide about itself — in `pair` and in every `hello`.
 *
 * One place, because there used to be two and both were wrong: pairing sent the literal `phone`,
 * so every device in cide's Settings → Remote access was called that, and each reconnect sent the
 * *instance's* label as the device's name, so cide logged a phone connecting under the name of
 * the machine it was connecting to.
 *
 * Outside `net/` because it reads expo, and `net/` is loaded by the vitest suite with no native
 * modules underneath it; a connection is handed this instead of reaching for it.
 */
import Constants from 'expo-constants'
import { Platform } from 'react-native'
import type { ClientInfo } from './protocol/generated'

export function clientInfo(): ClientInfo {
  const name = Constants.deviceName?.trim()
  return {
    // Android's own device name (Settings → About phone), or the model when it has none. `phone`
    // only when both are missing, which was the old answer for everybody.
    name: name === undefined || name === '' ? 'phone' : name,
    platform: Platform.OS,
    appVersion: Constants.expoConfig?.version ?? '0.1.0',
  }
}
