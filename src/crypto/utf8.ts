/**
 * UTF-8, without `TextEncoder`.
 *
 * Hermes has no `TextEncoder` or `TextDecoder`, and React Native does not polyfill them. That is
 * not a small inconvenience here: `seal.ts` builds its protocol labels at **module scope**, so a
 * missing global does not fail at the call — it fails while the module is being evaluated, which
 * React reports as a blank screen and `TypeError: undefined is not a function` somewhere inside
 * the navigation container. Every route that imports the transport renders nothing, and the
 * message names none of them.
 *
 * So the encoding is written out. It is forty lines, it has no platform dependency at all, and
 * the same code runs under Node in the tests and under Hermes on the phone — which for a
 * *protocol* is worth more than the convenience of a global, because a difference between the
 * two would show up as a frame that does not authenticate.
 *
 * Surrogate pairs are combined; an unpaired surrogate becomes U+FFFD rather than throwing,
 * matching what `TextEncoder` does, because a protocol frame is not the place to discover that
 * somebody's device name has half an emoji in it.
 */

/** UTF-8 bytes for a string. */
export function encodeUtf8(text: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00)
        i++
      } else {
        code = 0xfffd
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd
    }

    if (code < 0x80) {
      out.push(code)
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
    }
  }
  return new Uint8Array(out)
}

/** A string from UTF-8 bytes. Malformed input becomes U+FFFD, as `TextDecoder` does. */
export function decodeUtf8(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  while (i < bytes.length) {
    const first = bytes[i]!
    let code: number
    let length: number

    if (first < 0x80) {
      code = first
      length = 1
    } else if ((first & 0xe0) === 0xc0) {
      code = first & 0x1f
      length = 2
    } else if ((first & 0xf0) === 0xe0) {
      code = first & 0x0f
      length = 3
    } else if ((first & 0xf8) === 0xf0) {
      code = first & 0x07
      length = 4
    } else {
      out += '�'
      i++
      continue
    }

    if (i + length > bytes.length) {
      out += '�'
      break
    }
    let ok = true
    for (let k = 1; k < length; k++) {
      const byte = bytes[i + k]!
      if ((byte & 0xc0) !== 0x80) {
        ok = false
        break
      }
      code = (code << 6) | (byte & 0x3f)
    }
    if (!ok) {
      out += '�'
      i++
      continue
    }

    i += length
    if (code > 0x10ffff) {
      out += '�'
    } else if (code >= 0x10000) {
      const offset = code - 0x10000
      out += String.fromCharCode(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff))
    } else {
      out += String.fromCharCode(code)
    }
  }
  return out
}
