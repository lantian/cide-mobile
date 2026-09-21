/**
 * Copy cide's generated protocol into this repository, or refuse a copy that has drifted.
 *
 * `contract/protocol.ts` in the cide repository is written by `cargo xtask codegen` from the Rust
 * types, and is the transitive closure of the two frame types — exactly what the wire can carry
 * and nothing else. This repository **vendors** it rather than importing it, because a git
 * submodule would make this repository's CI depend on the other one's layout, and publishing it
 * as a package would be a release every time a field moved.
 *
 * Vendoring costs one thing, and this script is it: a copy can go stale. `--check` is what runs
 * in CI, and a stale copy there is the only thing standing between a renamed Rust field and an
 * `undefined` on somebody's phone.
 *
 *   node tools/sync-protocol.mjs            copy it
 *   node tools/sync-protocol.mjs --check    fail if the copy differs
 *
 * `CIDE_REPO` overrides where cide is; the default is a sibling directory, which is how these two
 * are checked out.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const cide = process.env.CIDE_REPO ?? resolve(repo, '../cide')
// Two vendored files, not one, and the second is the one that used to be copied by hand.
//
// `seal-vectors.json` is the transport's cross-language pin: cide's `cargo test -p cide-remote
// --test vectors -- --ignored` writes it, and this repository's `seal.test.ts` asserts that the
// same handshake produces the same sealed bytes and the same six pairing digits here. A stale
// copy is the worst kind of green: every test passes against last week's wire, and the failure
// shows up as a phone that connects to a real cide and understands nothing.
//
// The markdown trio is the third thing, and it is vendored for the reason cide's own
// `TaskMarkdown.tsx` gives for sharing the parser with the editor rather than writing a second
// one: *two grammars would disagree on the first nested list somebody wrote*. A comment is
// written once and read on both screens, so a phone with its own parser is a phone that renders
// somebody's report differently from the panel they wrote it in. The three files are import-free
// apart from each other — which is what makes vendoring them possible at all — and they produce a
// tree, never markup, so nothing about the injection argument changes by crossing repositories.
const FILES = [
  { source: join(cide, 'contract/protocol.ts'), target: join(repo, 'src/protocol/generated.ts') },
  { source: join(cide, 'contract/seal-vectors.json'), target: join(repo, 'test/seal-vectors.json') },
  { source: join(cide, 'ui/src/editor/markdown/types.ts'), target: join(repo, 'src/markdown/types.ts') },
  { source: join(cide, 'ui/src/editor/markdown/inline.ts'), target: join(repo, 'src/markdown/inline.ts') },
  { source: join(cide, 'ui/src/editor/markdown/blocks.ts'), target: join(repo, 'src/markdown/blocks.ts') },
]
const source = FILES[0].source
const check = process.argv.includes('--check')

if (!existsSync(source)) {
  // Not a failure in `--check`: somebody may be working on this repository alone, and a check
  // that cannot run is not a check that failed. It says so rather than passing silently.
  console.error(`cide is not at ${cide} — set CIDE_REPO, or clone it beside this repository.`)
  process.exit(check ? 0 : 1)
}

let drifted = 0
for (const file of FILES) {
  const name = file.target.slice(repo.length + 1)
  if (!existsSync(file.source)) {
    console.error(`${file.source} is missing from cide — it may not have been generated yet.`)
    process.exit(check ? 0 : 1)
  }
  const wanted = readFileSync(file.source, 'utf8')
  if (check) {
    const have = existsSync(file.target) ? readFileSync(file.target, 'utf8') : ''
    if (have !== wanted) {
      console.error(
        `${name} has drifted from cide's copy.\n` +
          'Run `npm run sync-protocol`, and read what changed before you trust it: a frame that\n' +
          'lost a field is a frame this app still thinks it has, and a seal vector that moved is\n' +
          'a wire that moved — every paired device is about to stop working.',
      )
      drifted += 1
    }
  } else {
    writeFileSync(file.target, wanted)
    console.log(`copied ${name}`)
  }
}

if (drifted > 0) process.exit(1)
if (check) {
  console.log('protocol: in sync')
} else {
  const version =
    readFileSync(FILES[0].source, 'utf8').match(/export const PROTOCOL_VERSION = (\d+)/)?.[1] ?? '?'
  const seal = JSON.parse(readFileSync(FILES[1].source, 'utf8')).sealVersion ?? '?'
  console.log(`protocol: version ${version}, seal ${seal}`)
}
