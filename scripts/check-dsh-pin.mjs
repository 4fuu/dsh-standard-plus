/**
 * Check the DSH compatibility pin and the bundle's published shape.
 *
 * This bundle is built for exactly one DeepSeek Harness version. DSH reads
 * `engines.dsh` before it composes a bundle layer, and the generated patch is
 * read from that version's own preset files. A manifest that drifts to another
 * version, or a `^`/`~` range, would make `pnpm check:patch` and the profile
 * check test something other than what an installation gets, so this check
 * fails before either runs.
 *
 * A published bundle may never list a DSH runtime package as a dependency.
 * `dsh plugin add` installs a dependency into the profile, and a second copy of
 * Cordis or a `dsh-*` package breaks service identity and scoped contexts (see
 * dsh-arbor's 2026.1110.0 regression). This bundle mounts DSH's own packages
 * from its patch rather than importing them, so it declares no DSH dependencies
 * at all; the devDependency on dsh-web-app only lets the generator read the
 * pinned preset files.
 *
 * Run: pnpm check:pin
 */

import { readFile, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const PIN = '0.2.2-rc.1'
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PACKAGE = join(ROOT, 'packages', 'dsh-standard-plus')

const failures = []
const read = async (path) => JSON.parse(await readFile(path, 'utf8'))

const root = await read(join(ROOT, 'package.json'))
const manifest = await read(join(PACKAGE, 'package.json'))

/** A DSH package, as opposed to Cordis or a library. */
const isDshPackage = (name) => name === '@deepseek-ai/cordis' || name.startsWith('@deepseek-ai/dsh-')

for (const [label, value] of [
  ['root package.json', root],
  [relative(ROOT, join(PACKAGE, 'package.json')), manifest],
]) {
  if (value.engines?.dsh !== PIN) failures.push(`${label}: engines.dsh is ${String(value.engines?.dsh)}, expected ${PIN}`)
}

for (const section of ['dependencies', 'optionalDependencies']) {
  for (const [name, version] of Object.entries(manifest[section] ?? {})) {
    if (isDshPackage(name)) {
      failures.push(
        `${relative(ROOT, join(PACKAGE, 'package.json'))}: ${section}.${name} is ${version}: ` +
          'a DSH package must never be a dependency of a bundle a profile installs',
      )
    }
    if (version === 'workspace:*' || version.startsWith('^') || version.startsWith('~')) {
      failures.push(`${relative(ROOT, join(PACKAGE, 'package.json'))}: ${section}.${name} is ${version}, expected an exact version`)
    }
  }
}

for (const [name, version] of Object.entries(manifest.peerDependencies ?? {})) {
  if (version !== PIN) failures.push(`peerDependencies.${name} is ${version}, expected ${PIN}`)
}

const patch = manifest.dsh?.bundle?.patch
if (typeof patch !== 'string') {
  failures.push('packages/dsh-standard-plus/package.json: dsh.bundle.patch must be a file path')
} else {
  try {
    await stat(join(PACKAGE, patch))
  } catch {
    failures.push(`packages/dsh-standard-plus/package.json: dsh.bundle.patch points at missing ${patch}`)
  }
  if (!Array.isArray(manifest.files) || !manifest.files.includes(patch.replace(/^\.\//, ''))) {
    failures.push(`packages/dsh-standard-plus/package.json: files does not carry ${patch}`)
  }
}

if (!/^\d{4}\.\d{4}\.\d+$/.test(manifest.version)) {
  failures.push(`packages/dsh-standard-plus/package.json: version ${manifest.version} is not YYYY.MMDD.REVISION`)
}
if (manifest.private === true) failures.push('packages/dsh-standard-plus/package.json: the published package must not be private')
if (manifest.publishConfig?.access !== 'public') failures.push('packages/dsh-standard-plus/package.json: publishConfig.access must be public')

for (const [name, version] of Object.entries(root.devDependencies ?? {})) {
  if (name.startsWith('@deepseek-ai/dsh-') && version !== PIN) {
    failures.push(`package.json: devDependencies.${name} is ${version}, expected ${PIN}`)
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`)
  process.exitCode = 1
} else {
  console.log(`PASS dsh pin: engines.dsh and every DSH devDependency are ${PIN}; the bundle declares no DSH runtime dependency`)
}
