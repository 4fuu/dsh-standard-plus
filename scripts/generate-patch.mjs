/**
 * Generate the bundle patch from the pinned DSH's own preset declarations.
 *
 * DSH ships four Web agent presets as `presets/<id>.patch.yml` files inside
 * `@deepseek-ai/dsh-web-app`: standard, ptc, minimal and cordis (Creator mode).
 * This repository replaces all four with one Standard mode that keeps Standard's
 * plugin list and adds the three things Creator mode has and Standard lacks:
 * `tool-cordis`, the conditionally enabled `tool-plugin-market`, and the
 * `skill-filesystem` row whose `customSkillDirs` mounts the four Cordis skills.
 *
 * Editing the list by hand would let it drift from the DSH version the bundle is
 * pinned to, so `packages/dsh-standard-plus/cordis.patch.yml` is generated from
 * the installed `@deepseek-ai/dsh-web-app` and `pnpm check:patch` fails when the
 * committed file differs.
 *
 *   node scripts/generate-patch.mjs           rewrite the committed patch
 *   node scripts/generate-patch.mjs --check    fail when it is out of date
 *
 * The generated patch keeps DSH's `!!js` platform conditions as they are. The
 * `customSkillDirs` expression is DSH's own, copied from preset-cordis; it
 * resolves `@deepseek-ai/dsh-agent-preset` through the profile's module
 * resolution, which is the same expression Creator mode uses in a profile.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

/** The one DSH version this bundle is built for. Mirrors `engines.dsh`. */
const PIN = '0.2.2-rc.1'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PACKAGE_DIR = join(ROOT, 'packages', 'dsh-standard-plus')
const OUTPUT = join(PACKAGE_DIR, 'cordis.patch.yml')
const CHECK = process.argv.includes('--check')

/** Locate the pinned DSH's Web bundle, which owns the shipped preset files. */
async function dshWebApp() {
  const require = createRequire(import.meta.url)
  let manifestPath
  try {
    manifestPath = require.resolve('@deepseek-ai/dsh-web-app/package.json')
  } catch {
    throw new Error(
      '@deepseek-ai/dsh-web-app is not installed. Run `pnpm install --frozen-lockfile` first; ' +
        'the generator reads the pinned DSH package rather than a copy of its presets.',
    )
  }
  const directory = dirname(manifestPath)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.version !== PIN) {
    throw new Error(`@deepseek-ai/dsh-web-app is ${String(manifest.version)}, expected ${PIN}`)
  }
  return directory
}

/** Parse one shipped patch file and return the single preset row it inserts. */
function shippedPreset(file, id) {
  const document = YAML.parseDocument(file)
  if (document.errors.length > 0) throw new Error(`${id}: ${document.errors[0].message}`)
  const rows = document.contents?.items
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error(`${id}: expected one patch row`)
  const inserted = rows[0]?.get?.('insert')?.items
  const row = Array.isArray(inserted) && inserted.length === 1 ? inserted[0] : undefined
  if (row?.get?.('id') !== `preset-${id}`) throw new Error(`${id}: expected row preset-${id}`)
  if (row.get('config')?.get?.('id') !== id) throw new Error(`${id}: expected config.id ${id}`)
  return { document, row }
}

/** The `config.plugins` sequence of a preset row. */
function plugins(row, id) {
  const list = row.get('config')?.get?.('plugins')
  if (list?.items === undefined) throw new Error(`${id}: expected config.plugins`)
  return list
}

/** The plugin row with one id, or a failure naming the missing row. */
function plugin(list, id, preset) {
  const row = list.items.find((item) => item?.get?.('id') === id)
  if (row === undefined) throw new Error(`${preset}: expected plugin row ${id}`)
  return row
}

const webAppDir = await dshWebApp()
const presets = join(webAppDir, 'presets')
const standard = shippedPreset(await readFile(join(presets, 'standard.patch.yml'), 'utf8'), 'standard')
const cordis = shippedPreset(await readFile(join(presets, 'cordis.patch.yml'), 'utf8'), 'cordis')

const document = standard.document
const row = standard.row
const list = plugins(row, 'standard')
const creator = plugins(cordis.row, 'cordis')

// The three things Standard lacks. Each node is moved from the Creator mode
// file, so comments, ordering and `!!js` expressions stay exactly as DSH ships
// them. `tool-cordis` sits after `tool-web`, where Creator mode declares it;
// the two replacements keep Standard's position for rows both modes share.
const replace = (id) => {
  const index = list.items.findIndex((item) => item?.get?.('id') === id)
  if (index === -1) throw new Error(`standard: expected plugin row ${id}`)
  list.items[index] = plugin(creator, id, 'cordis')
}
replace('skill-filesystem')
replace('tool-plugin-market')
const toolWeb = list.items.findIndex((item) => item?.get?.('id') === 'tool-web')
if (toolWeb === -1) throw new Error('standard: expected plugin row tool-web')
list.items.splice(toolWeb + 1, 0, plugin(creator, 'tool-cordis', 'cordis'))

row.set('id', 'preset-standard-plus')
const patchRow = document.contents.items[0]
patchRow.commentBefore = [
  ' The one mode this bundle declares. It keeps the shipped Standard id, so a',
  " session recorded under `standard` still resolves, and keeps Standard's plugin",
  " list with Creator mode's Cordis tooling added: `tool-cordis`, the plugin",
  ' market tool under the same profile condition Creator mode uses, and the',
  ' Cordis skill directory.',
].join('\n')

const header = [
  ' Generated by scripts/generate-patch.mjs from the pinned',
  ` @deepseek-ai/dsh-web-app@${PIN}: presets/standard.patch.yml and`,
  ' presets/cordis.patch.yml. Do not edit by hand; run `pnpm generate`.',
  '',
  " This bundle replaces DSH's four shipped Web agent modes with one Standard",
  " mode that also mounts Creator mode's Cordis tools. The four shipped rows are",
  ' disabled in place so later patches can still target their ids; the inserted',
  ' declaration is the only one registered, so no duplicate config.id reaches the',
  ' preset registry. The only mode a picker or settings page presents is',
  ' Standard; every other row, including one declared by another bundle, is',
  ' untouched.',
].join('\n')
document.commentBefore = header

const disables = ['standard', 'ptc', 'minimal', 'cordis'].map((id) => document.createNode({ id: `preset-${id}`, disabled: true }))
for (const disable of disables.slice(1)) disable.spaceBefore = true
patchRow.spaceBefore = true
document.contents.items.unshift(...disables)

const generated = document.toString({ lineWidth: 0 })

if (CHECK) {
  let committed
  try {
    committed = await readFile(OUTPUT, 'utf8')
  } catch {
    console.error(`FAIL ${relative(ROOT, OUTPUT)} is missing. Run pnpm generate.`)
    process.exitCode = 1
  }
  if (process.exitCode !== 1 && committed !== generated) {
    const expected = generated.split('\n')
    const actual = committed.split('\n')
    const length = Math.max(expected.length, actual.length)
    let index = -1
    for (let line = 0; line < length; line++) {
      if (expected[line] !== actual[line]) {
        index = line
        break
      }
    }
    const first = index === -1 ? '<same>' : actual[index] === undefined ? '<end of file>' : actual[index]
    const next = index === -1 ? '<same>' : expected[index] === undefined ? '<end of file>' : expected[index]
    console.error(
      `FAIL ${relative(ROOT, OUTPUT)} does not match the pinned DSH ${PIN} preset rows.\n` +
        `first difference at line ${index + 1}:\n  committed: ${first}\n  generated: ${next}\n` +
        'Run `pnpm generate` and commit the result.',
    )
    process.exitCode = 1
  }
  if (process.exitCode !== 1) console.log(`PASS generated patch: ${relative(ROOT, OUTPUT)} matches DSH ${PIN}`)
} else {
  await writeFile(OUTPUT, generated)
  console.log(`wrote ${relative(ROOT, OUTPUT)} from @deepseek-ai/dsh-web-app@${PIN}`)
}
