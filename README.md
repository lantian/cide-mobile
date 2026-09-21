# cide-mobile

The companion application for [cide](../cide): connect to one or more running instances, see
which Claude sessions and agent runs are live, open one, read it, type into it, and be told when
a turn ends.

## What this repository is, and what it depends on

The other half lives in cide itself (`crates/cide-remote`, ADR 0015). This repository speaks a
protocol generated from that one:

* **`src/protocol/generated.ts` is vendored**, copied from cide's `contract/protocol.ts` by
  `npm run sync-protocol`. It is not edited here. `npm run check` refuses a copy that has drifted
  from the source, which is the only thing standing between a renamed Rust field and an
  `undefined` on somebody's phone.
* `PROTOCOL_VERSION` is compared against what an instance announces. A mismatch is a terminal
  state with a sentence in it — never a reconnect loop, which drains a battery and explains
  nothing.

## The one pinned dependency, and why it is pinned

**`query-string` is pinned to exactly `7.1.3`, and a caret on it breaks navigation with no
compile error.** expo-router 4.0.22 requires it — `build/fork/getPathFromState.js` does
`__importStar(require("query-string"))` and then calls `.parse`/`.stringify` — but does not
*declare* it, so it has to be added here by hand, and `npm install query-string` gives version
9. Version 9 is pure ESM whose `index.js` is one line, `export default queryString`: it has a
default export and no named ones. Under Metro's interop `__importStar` of that yields
`{ default: … }`, `.parse` is `undefined`, and the call throws `TypeError: undefined is not a
function` from inside `BaseNavigationContainer`. Version 7 is CommonJS and exports the names.

Three things make this expensive to find, and are the reason for this section rather than a
comment in `package.json`. The path from state is only computed on a **navigation**, so the
first screen renders perfectly and the app dies on the first tap. The throw is reported against
`BaseNavigationContainer`, a file in `node_modules` that is entirely innocent, and names neither
`query-string` nor any route. And a release build has no source map, so the stack ends there.
The typecheck, the lint and all 90 unit tests pass either way, because none of them navigate.

## The transport, in one paragraph

Plain `ws://`, with **every frame sealed** (XChaCha20-Poly1305). Not TLS: React Native's
`WebSocket` exposes no certificate hook on either platform, so pinning a self-signed certificate
needs native work on both — and pinning *per paired instance*, which is what this actually
requires, needs it twice. Sealing the frames is pure JS here and pure Rust there, works
identically on both platforms, and is pinning by construction: only the instance holding the
pairing key can produce a frame this app can open.

After pairing, **no credential is ever sent**. The device is identified in the handshake — public
information — and authenticated by being able to seal a frame cide can open.

## The two pairing roads are not equally strong, and the app says which one you are on

Sealing is pinning by construction only if you already know cide's public key. Scanning the QR
gives you it, so the exchange cannot complete against anybody else and there is nothing further
to check. **Typing an address does not.** The key then comes off the wire during the handshake,
and anybody able to sit between this phone and that machine can put their own there.

So the typed road ends in six digits, shown on this screen and on cide's, for you to compare —
the Signal safety-number pattern. Somebody relaying the connection runs two exchanges, with
their own key towards the phone and their own towards cide, and the two numbers differ. Three
things about it are deliberate:

* **Nothing has been sent when you are asked.** The pairing code is still on the phone; the
  attempt is suspended. Confirming afterwards would be a dialog reporting a loss.
* **Neither button is the safe default**, and *No, stop* is listed first. Tapping without reading
  must not fall through to yes.
* **cide's side has no button at all.** It cannot know whether the numbers matched; only you can,
  and the tap that withholds the code is here.

`Invite.serverPublic` is `Uint8Array | null`, so which road you are on is carried by the type
rather than remembered — and a scanned pairing whose greeting carries a *different* key is
refused outright rather than downgraded to a question, because the QR already said which machine
this is and this is not it.

## The font is bundled, and it is not decoration

`android/app/src/main/assets/fonts/` carries all four faces of **Adwaita Mono** (Iosevka-derived,
OFL — the licence sits beside them), and the terminal draws in it rather than in
`fontFamily: 'monospace'`.

A phone's idea of monospace is Roboto Mono, which does not contain the characters a terminal
spends most of its time drawing: box drawing, braille, arrows, check marks. Android falls back
per glyph, to a face with a **different advance**, so a line of fifty characters that
`src/term/wrap.ts` had measured as fitting was wider than the screen — and because a row is drawn
with `numberOfLines={1}`, the surplus was ellipsised. A Claude pane's input box arrived as two
long rules each ending in `…`. The Cyrillic in the same screenshot wrapped perfectly, which is
why it took a photograph of a real session to notice.

Adwaita Mono carries all of them at one advance — 600 units of a 1000-unit em, which is the `0.6`
in the character budget and is now a measurement rather than a guess. All four faces, because a
style Android cannot find a file for is a style it substitutes from the system: one italic run in
a foreign face walks the rest of the line out of the grid.

They are not subsetted. A subset saves about a megabyte of a ninety-megabyte APK and reintroduces,
as a build step nobody will re-run, exactly the failure being fixed here: a character the font
does not have.

## A box is not re-flowed, it is redrawn

Bundling the font stopped the clipping and left a second problem: Claude Code frames its input in
a box the width of the terminal, and wrapping 120 columns of `╭───╮` to a phone turns three lines
into **seven** — two and a half wrapped lines of `─`, a stranded `│`, and two and a half more.

So `src/term/frame.ts` shapes a row before `wrap` re-flows it, in wrap mode only: trailing padding
is dropped, a row made of nothing but rule characters becomes one hairline in its own colour, and
a row fenced by `│ … │` loses the fence and gains a border down the side. The input box is three
lines again and reads as a box.

Pan mode is untouched, and that is the point of having it: it promises exact columns, so nothing
here may run there. The tests are in `test/term.test.ts`, and each rule is a silent failure the
other way — prose mistaken for a border **disappears**, and a trailing blank trimmed when it
carries a background takes the right edge of somebody's selection with it.

## The ceiling, stated up front

Notifications are **local**. There is no push service: cide does not talk to FCM or APNs, and
this app raises its own notifications from a live socket. So:

* while the app is in the foreground, or very recently backgrounded, a finished turn buzzes;
* when the OS has suspended or killed the app — iOS always, Android often — **nothing arrives**,
  because a local notification requires running code;
* on the next open, everything that became *awaiting* while the socket was down surfaces at once,
  because the server sends the set with a per-entry stamp and this app announces what is newer
  than the last thing it announced.

That reconcile is the primary mechanism, not a safety net. It is worth revisiting deliberately
rather than rediscovering.

## Status

Early. See `../cide/docs/journal.md`'s M72 entry for what exists on the other end.
