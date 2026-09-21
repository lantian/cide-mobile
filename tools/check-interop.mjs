// A dependency whose *module format* is wrong fails at runtime, on a screen nobody's test
// opens, with a stack that names somebody else's file. This script is the gate for that class.
//
// The one member so far is `query-string`, and its failure is written up in the README: v9 is
// ESM with a default export and no named ones, expo-router reaches for `.parse` through
// `__importStar`, and the app throws `undefined is not a function` out of
// `BaseNavigationContainer` on the first navigation — after rendering the first screen
// perfectly, and with the typecheck, the lint and every unit test green, because none of them
// navigate. So the assertion here is not on the version string in `package.json`, which is only
// a wish: it requires the installed package and checks that the functions are actually there.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const problems = []

// { module, names, why } — `names` must all be callable off a plain CommonJS require().
const INTEROP = [
  {
    module: 'query-string',
    names: ['parse', 'stringify'],
    why: 'expo-router/build/fork/getPathFromState.js calls both through __importStar; v9 is ESM-only and yields undefined for each',
  },
]

for (const { module, names, why } of INTEROP) {
  let loaded
  try {
    loaded = require(module)
  } catch (e) {
    problems.push(`${module}: cannot be require()d at all — ${e.message}`)
    continue
  }
  for (const name of names) {
    if (typeof loaded[name] !== 'function') {
      problems.push(
        `${module}.${name} is ${typeof loaded[name]}, not a function.\n` +
          `    installed version: ${require(`${module}/package.json`).version}\n` +
          `    why this matters : ${why}\n` +
          `    see              : README.md, “The one pinned dependency, and why it is pinned”`,
      )
    }
  }
}

// A caret would let the next `npm install` undo the pin silently, so the spelling is asserted
// too — this half is cheap and catches the mistake before it is ever installed.
const declared = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
for (const { module } of INTEROP) {
  const range = declared.dependencies?.[module] ?? declared.devDependencies?.[module]
  if (range === undefined) {
    problems.push(`${module} is required at runtime but declared in neither dependency list`)
  } else if (/[\^~><*]|\|\||\s-\s/.test(range)) {
    problems.push(`${module} is declared as "${range}" — it must be one exact version, not a range`)
  }
}

if (problems.length > 0) {
  console.error('interop: FAILED\n')
  for (const p of problems) console.error(`  - ${p}\n`)
  process.exit(1)
}
console.log(`interop: ok (${INTEROP.length} module checked for its require() shape, pinned exactly)`)
