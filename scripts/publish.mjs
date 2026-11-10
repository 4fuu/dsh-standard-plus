/**
 * Pack or publish the bundle.
 *
 *   node scripts/publish.mjs                 `npm pack --dry-run`
 *   node scripts/publish.mjs --pack-dir DIR  write the tarball into DIR
 *   node scripts/publish.mjs --publish       `npm publish --access public`
 *
 * The package directory is the whole published package: a manifest, the
 * generated `cordis.patch.yml`, and the license. There is no build step, so
 * packing is the same tree the checkout reviews. `--publish` refuses a version
 * whose date is not today in Asia/Hong_Kong, the release calendar every `@4fu`
 * package uses; `--pack-dir` does not, because the profile check packs the
 * current version on any day it runs.
 */

import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const directory = join(root, 'packages', 'dsh-standard-plus')
const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))

const publish = process.argv.includes('--publish')
const packDirAt = process.argv.indexOf('--pack-dir')
const packDir = packDirAt === -1 ? undefined : process.argv[packDirAt + 1]
if (packDirAt !== -1 && (packDir === undefined || packDir.startsWith('--'))) throw new Error('--pack-dir needs a directory')
if (publish && packDir !== undefined) throw new Error('--publish and --pack-dir are exclusive')

if (!/^\d{4}\.\d{4}\.\d+$/.test(manifest.version)) {
  throw new Error(`version ${manifest.version} is not YYYY.MMDD.REVISION`)
}
if (manifest.private === true) throw new Error('the published package must not be private')

/** A release carries today's date in Asia/Hong_Kong. */
function checkDate(value) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: 'numeric',
    day: '2-digit',
  }).formatToParts(new Date())
  const part = (type) => parts.find((one) => one.type === type).value
  const today = `${part('year')}.${part('month')}${part('day')}`
  if (!value.startsWith(`${today}.`)) {
    throw new Error(`version ${value} is not today's date in Asia/Hong_Kong (${today})`)
  }
}

if (publish) checkDate(manifest.version)

const args = publish ? ['publish', '--access', 'public'] : ['pack']
if (!publish) {
  if (packDir === undefined) args.push('--dry-run')
  else args.push('--pack-destination', resolve(packDir))
}

const result = spawnSync('npm', args, { cwd: directory, stdio: 'inherit' })
if (result.status !== 0) throw new Error(`npm exited with ${result.status}`)
