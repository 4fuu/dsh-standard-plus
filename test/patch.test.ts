/**
 * The contract a user installs: one Standard declaration carrying Creator
 * mode's Cordis tools, and no shipped preset left selectable.
 *
 * The generator check keeps the file in sync with the pinned DSH; this test
 * states what the file must mean, so a future DSH drift that the generator
 * happily copies (a renamed tool, a dropped skill directory) fails here too.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import YAML from 'yaml'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PACKAGE = join(ROOT, 'packages', 'dsh-standard-plus')
const PIN = '0.2.2-rc.1'

/** DSH's loader tag: every `!!js` node stays an expression, never a value. */
const jsTag = {
  tag: 'tag:yaml.org,2002:js',
  resolve: (value: string) => ({ __jsExpr: value }),
}

const patch = YAML.parse(await readFile(join(PACKAGE, 'cordis.patch.yml'), 'utf8'), { customTags: [jsTag] })
const manifest = JSON.parse(await readFile(join(PACKAGE, 'package.json'), 'utf8'))
const declaration = patch.find((row) => row.insert !== undefined)?.insert[0]
const plugins = declaration?.config?.plugins ?? []
const plugin = (id: string) => plugins.find((row: { id: string }) => row.id === id)

test('the generated patch disables every shipped Web preset', () => {
  const disabled = patch.filter((row) => row.disabled === true).map((row) => row.id)
  assert.deepEqual(disabled, ['preset-standard', 'preset-ptc', 'preset-minimal', 'preset-cordis'])
  assert.equal(patch.filter((row) => row.insert !== undefined).length, 1)
})

test('one declaration keeps the shipped Standard id so old sessions resolve', () => {
  assert.equal(declaration.id, 'preset-standard-plus')
  assert.equal(declaration.name, '@deepseek-ai/dsh-agent-preset')
  assert.equal(declaration.config.id, 'standard')
  assert.equal(declaration.config.order, 1)
  // Name and description stay absent: DSH resolves them from its own locale
  // dictionaries only while the declaration publishes no name.
  assert.equal('name' in declaration.config, false)
  assert.equal('description' in declaration.config, false)
})

test('the declaration keeps Standard tools and adds Creator mode Cordis tools', () => {
  for (const id of ['tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search', 'tool-jobs', 'tool-schedule', 'tool-goal', 'tool-ask-user', 'tool-todo', 'tool-web', 'present']) {
    assert.equal(plugin(id)?.name !== undefined, true, `${id} must stay in the declaration`)
  }
  for (const id of ['tool-cordis', 'tool-plugin-manager', 'tool-plugin-market', 'skill-filesystem']) {
    assert.equal(plugin(id)?.name !== undefined, true, `${id} must be declared`)
  }
  assert.equal(plugin('tool-cordis').name, '@deepseek-ai/dsh-tool-cordis')
  assert.equal(plugin('tool-plugin-manager').name, '@deepseek-ai/dsh-plugin-manager/tools')
  assert.equal(plugin('tool-plugin-market').name, '@deepseek-ai/dsh-plugin-market/tools')
})

test('platform conditions stay loader expressions', () => {
  assert.deepEqual(plugin('tool-bash').disabled, { __jsExpr: "process.platform === 'win32'" })
  assert.deepEqual(plugin('tool-pwsh').disabled, { __jsExpr: "process.platform !== 'win32'" })
  assert.deepEqual(plugin('tool-plugin-manager').disabled, { __jsExpr: "!ctx.get('profileContext')" })
  assert.deepEqual(plugin('tool-plugin-market').disabled, { __jsExpr: "!ctx.get('profileContext')" })
})

test('the skill directory is Creator mode expression, not a copied path', () => {
  const dirs = plugin('skill-filesystem').config.customSkillDirs
  assert.equal(Array.isArray(dirs), true)
  assert.equal(dirs.length, 1)
  assert.equal(typeof dirs[0].__jsExpr, 'string')
  assert.match(dirs[0].__jsExpr, /@deepseek-ai\/dsh-agent-preset\/package\.json/)
  assert.match(dirs[0].__jsExpr, /'skills'/)
})

test('the package is an installable bundle at the pinned DSH version', () => {
  assert.equal(manifest.engines.dsh, PIN)
  assert.equal(manifest.private, undefined)
  assert.equal(manifest.publishConfig.access, 'public')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.deepEqual(manifest.dependencies ?? {}, {})
  assert.match(manifest.version, /^\d{4}\.\d{4}\.\d+$/)
})
