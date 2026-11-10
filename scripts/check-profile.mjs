/**
 * Check what a user actually installs.
 *
 * The checkout resolves one copy of every package, so it cannot see what a
 * profile install produces. This check packs the bundle, installs the tarball
 * into a fresh DSH `0.2.2-rc.1` web profile the way `dsh plugin add` does, and
 * drives the same HTTP RPC the web UI uses:
 *
 *   stock        create a Standard session and one session in each removed
 *                mode before the bundle exists
 *   installed    one Standard mode, the Cordis tools and four Cordis skills,
 *                the pre-install Standard session resumes, and the removed
 *                modes' started sessions fail to resume
 *   arbor        the Arbor preset stays beside the new Standard mode
 *   removed      the four shipped modes come back, the removed modes' sessions
 *                resume, and the bundle-created session loses the skills
 *
 * The tool and skill assertions use a small observer plugin written into the
 * profile only for this check. It registers no agent capability; it reads the
 * session-scoped tool and skill catalogs on `agent/created`, which is the same
 * view the model prompt is built from. It is never part of the released package.
 *
 * Run: pnpm check:profile
 *
 * Set STANDARD_PLUS_CHECK_WORK to an empty directory to keep the install,
 * profile and server logs for inspection; a failing run prints the directory it
 * used. Set STANDARD_PLUS_CHECK_ARBOR=0 to skip the Arbor phase (the job needs
 * npm access for @4fu/dsh-arbor-bundle).
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PIN = '0.2.2-rc.1'
const DSH_CLI = 'node_modules/@deepseek-ai/dsh/lib/bin.js'
const PACKAGE = '@4fu/dsh-standard-plus'
const ARBOR = '@4fu/dsh-arbor-bundle'
const ARBOR_VERSION = '2026.1110.1'
const CHECK_ARBOR = process.env.STANDARD_PLUS_CHECK_ARBOR !== '0'

const work = process.env.STANDARD_PLUS_CHECK_WORK ?? (await mkdtemp(join(tmpdir(), 'dsh-standard-plus-profile-')))
const install = join(work, 'dsh')
const home = join(work, 'home')
const profile = join(home, 'profiles', 'web')
const project = join(work, 'project')
const inspectDir = join(work, 'inspect')
const tarballs = join(work, 'tarballs')

/** DSH without a model credential: this check never needs a live model. */
const env = { ...process.env, DSH_HOME: home, STANDARD_PLUS_INSPECT_DIR: inspectDir }
delete env.DEEPSEEK_API_KEY
delete env.DEEPSEEK_BASE_URL

const passed = []
function pass(message) {
  passed.push(message)
  console.log(`PASS ${message}`)
}
function fail(message) {
  throw new Error(message)
}

/** Run one command, and return its combined output; throw on a nonzero exit. */
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env, ...options })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(output)
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}\n${output}`))
    })
  })
}

/** One free loopback port. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

/** Remove a directory tree; a busy tree is retried, never a failed check. */
async function removeTree(path) {
  try {
    await rm(path, { recursive: true, force: true, maxRetries: 5 })
  } catch (error) {
    console.log(`warning: left ${path} behind (${error.code})`)
  }
}

/** Start `dsh web`, and settle on the printed launch URL. */
async function startWeb(label) {
  const port = await freePort()
  const child = spawn(process.execPath, [join(install, DSH_CLI), '--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: work,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dsh web (${label}) did not print a URL within 90s\n${output}`)), 90_000)
    const read = (chunk) => {
      output += chunk
      const match = /dsh web: (http:\/\/\S+\?token=\S+)/.exec(output)
      if (match !== null) {
        clearTimeout(timer)
        resolve(match[1])
      }
    }
    child.stdout.on('data', read)
    child.stderr.on('data', read)
    child.on('close', (code) => {
      clearTimeout(timer)
      reject(new Error(`dsh web (${label}) exited with ${code}\n${output}`))
    })
  })
  return { child, url, output: () => output }
}

/** Stop the server and let the port go. */
async function stopWeb(server) {
  if (server.child.exitCode !== null) return
  server.child.kill('SIGTERM')
  const stopped = await Promise.race([
    new Promise((resolve) => server.child.on('close', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 10_000)),
  ])
  if (!stopped) server.child.kill('SIGKILL')
}

/** Exchange the launch token for the API cookie the web UI's RPC uses. */
async function connect(url) {
  const launch = new URL(url)
  const connectUrl = new URL('/connect', launch.origin)
  connectUrl.searchParams.set('token', launch.searchParams.get('token'))
  connectUrl.searchParams.set('interactions', 'none')
  const response = await fetch(connectUrl, { redirect: 'manual' })
  if (response.status !== 302) fail(`/connect answered ${response.status}, expected the 302 that mints the API cookie`)
  const cookie = response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ')
  if (cookie === '') fail('/connect minted no cookie')
  return { origin: launch.origin, cookie }
}

/** One Remote call, rejected only when the transport itself fails. */
async function rpc(connection, method, args = {}) {
  const rpcId = crypto.randomUUID()
  const response = await fetch(`${connection.origin}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: connection.cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
  })
  if (response.status !== 200) fail(`${method} answered HTTP ${response.status}: ${await response.text()}`)
  const body = await response.json()
  if (body.rpcId !== rpcId) fail(`${method} answered rpcId ${String(body.rpcId)}, sent ${rpcId}`)
  return body.result
}

/** Await a value, polling until `read` returns one or the deadline passes. */
async function waitFor(read, describe, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  fail(`timed out waiting for ${describe}`)
}

/** The preset ids a roster answers with, in picker order. */
async function rosterIds(connection) {
  const result = await rpc(connection, 'agentPresets/list', {})
  if (!result.ok) fail(`agentPresets/list failed: ${JSON.stringify(result.error)}`)
  return result.value.presets
}

/** The DSH-owned packages a profile installed as second copies. */
async function dshCopies() {
  const modules = join(profile, 'node_modules', '@deepseek-ai')
  if (!existsSync(modules)) return []
  const runtime = (name) => name === 'cordis' || name.startsWith('cordis-') || name === 'dsh' || name.startsWith('dsh-')
  return (await readdir(modules)).filter(runtime).sort()
}

/** The profile manifest as a user's install leaves it. */
async function profileManifest() {
  return JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
}

/** Every session log under the Harness home, with its decompressed text. */
async function sessionLogs() {
  const found = []
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name.endsWith('.jsonl.zstd')) {
        const { zstdDecompressSync } = await import('node:zlib')
        found.push({ path, text: zstdDecompressSync(await readFile(path)).toString('utf8') })
      }
    }
  }
  const sessions = join(home, 'sessions')
  if (existsSync(sessions)) await walk(sessions)
  return found
}

/** The one tarball a pack step wrote. */
async function packedTarball() {
  const files = (await readdir(tarballs)).filter((name) => name.endsWith('.tgz'))
  if (files.length !== 1) fail(`expected one packed tarball, found ${files.length}: ${files.join(', ')}`)
  return join(tarballs, files[0])
}

/**
 * The observer plugin this check writes into the profile. It reads the
 * session-scoped catalogs on agent creation and writes them outside the home.
 * It is not part of the released package and registers no tool or prompt.
 */
const INSPECTOR = `import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { scopeOf } from '@deepseek-ai/dsh-scope'

export function apply(ctx) {
  ctx.on('agent/created', async ({ agent }) => {
    const output = process.env.STANDARD_PLUS_INSPECT_DIR
    if (output === undefined) return
    try {
      const scope = scopeOf(agent.ctx)
      const tools = ctx.get('tools')?.definitions(scope).map((definition) => definition.name).sort() ?? []
      const skills = (await ctx.get('skills')?.list({ scope, cwd: agent.session.header.cwd }))?.map((skill) => skill.name).sort() ?? []
      await mkdir(output, { recursive: true })
      await writeFile(join(output, \`\${agent.id}.json\`), JSON.stringify({
        sessionId: agent.id,
        preset: agent.session.header.agentPreset,
        tools,
        skills,
      }, null, 2))
    } catch (error) {
      await mkdir(output, { recursive: true })
      await writeFile(join(output, 'error.json'), String(error))
    }
  })
}
`

try {
  console.log(`work directory: ${work}`)
  await rm(tarballs, { recursive: true, force: true })
  await mkdir(tarballs, { recursive: true })
  await mkdir(project, { recursive: true })
  await run(process.execPath, [join(ROOT, 'scripts', 'publish.mjs'), '--pack-dir', tarballs])
  const tarball = await packedTarball()
  pass(`packed ${tarball.slice(tarball.lastIndexOf('/') + 1)}`)

  if (!existsSync(join(install, DSH_CLI))) {
    console.log(`installing @deepseek-ai/dsh@${PIN} into ${install}`)
    await rm(install, { recursive: true, force: true })
    await mkdir(install, { recursive: true })
    await run('npm', ['install', '--prefix', install, '--no-audit', '--no-fund', '--loglevel=error', `@deepseek-ai/dsh@${PIN}`])
  }
  pass(`DSH ${PIN} is installed`)

  // A profile before the bundle: sessions that predate it.
  await rm(home, { recursive: true, force: true })
  await mkdir(home, { recursive: true })
  await run(process.execPath, [join(install, DSH_CLI), 'plugin', '--profile', 'web', 'version-exemptions'])
  let server = await startWeb('stock')
  let connection
  let before
  const removedModes = []
  try {
    connection = await connect(server.url)
    const shipped = await rosterIds(connection)
    if (shipped.map((row) => row.id).join(',') !== 'standard,ptc,minimal,cordis') {
      fail(`the stock roster is ${shipped.map((row) => row.id).join(', ')}, expected standard, ptc, minimal, cordis`)
    }
    const created = await rpc(connection, 'session/create', { request: { cwd: project } })
    if (!created.ok) fail(`a stock Standard session failed: ${JSON.stringify(created.error)}`)
    if (created.value.agentPreset !== 'standard') fail(`the stock session ran preset ${String(created.value.agentPreset)}`)
    before = created.value.sessionId
    const prompt = await rpc(connection, 'session/prompt', {
      request: {
        requestId: crypto.randomUUID(),
        sessionId: before,
        mode: 'queue',
        content: [{ type: 'text', text: 'This session was created before the bundle was installed.' }],
      },
    })
    if (!prompt.ok) fail(`the stock session did not accept a prompt: ${JSON.stringify(prompt.error)}`)
    pass(`a stock profile created and started Standard session ${before}`)

    // A session in each mode this bundle removes, started before the install.
    for (const preset of ['ptc', 'minimal', 'cordis']) {
      const removed = await rpc(connection, 'session/create', { request: { cwd: project, agentPreset: preset } })
      if (!removed.ok) fail(`a stock ${preset} session failed: ${JSON.stringify(removed.error)}`)
      const accepted = await rpc(connection, 'session/prompt', {
        request: {
          requestId: crypto.randomUUID(),
          sessionId: removed.value.sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: `This ${preset} session started before the bundle was installed.` }],
        },
      })
      if (!accepted.ok) fail(`the stock ${preset} session did not accept a prompt: ${JSON.stringify(accepted.error)}`)
      removedModes.push({ preset, sessionId: removed.value.sessionId })
    }
    pass(`a stock profile started ptc, minimal and cordis sessions: ${removedModes.map((one) => one.preset).join(', ')}`)
  } finally {
    await stopWeb(server)
  }
  const logs = await sessionLogs()
  if (!logs.some((log) => log.text.includes('"type":"turn/start"'))) {
    fail('the pre-install session has no turn/start event, so the resume check would only reuse a blank session')
  }
  pass('the pre-install session has a started turn')

  // Install the packed bundle and a profile-only observer.
  await run(process.execPath, [join(install, DSH_CLI), 'plugin', '--profile', 'web', 'add', `file:${tarball}`])
  const installed = await profileManifest()
  const bundles = installed.dsh?.profile?.bundles ?? []
  if (!bundles.includes(PACKAGE)) fail(`the profile does not compose ${PACKAGE}: ${JSON.stringify(bundles)}`)
  pass(`the profile composes the bundle: ${bundles.join(', ')}`)

  const copies = await dshCopies()
  if (copies.length > 0) {
    fail(
      `the profile holds ${copies.length} second copies of DSH runtime packages: ${copies.join(', ')}\n` +
        'a published package must declare them as peerDependencies, never dependencies',
    )
  }
  pass('the profile holds no DSH runtime copy')

  await writeFile(join(profile, 'standard-plus-inspect.mjs'), INSPECTOR)
  await writeFile(
    join(profile, 'cordis.patch.yml'),
    [
      '# The profile layer this check owns: one observer row for the verification.',
      '- insert:',
      '    - id: standard-plus-inspect',
      "      name: './standard-plus-inspect.mjs'",
      '',
    ].join('\n'),
  )

  server = await startWeb('installed')
  let after
  try {
    connection = await connect(server.url)
    const roster = await rosterIds(connection)
    if (roster.map((row) => row.id).join(',') !== 'standard') {
      fail(`the installed roster is ${roster.map((row) => row.id).join(', ')}, expected only standard`)
    }
    if (roster[0].name !== undefined || roster[0].description !== undefined) {
      fail('the Standard row publishes a name or description, so DSH cannot resolve its built-in localized copy')
    }
    if (roster[0].isDefault !== true) fail('Standard is not the default preset')
    pass('the mode roster is one localized Standard mode and it is the default')

    const created = await rpc(connection, 'session/create', { request: { cwd: project } })
    if (!created.ok) fail(`a new Standard session failed: ${JSON.stringify(created.error)}`)
    if (created.value.agentPreset !== 'standard') fail(`the new session ran preset ${String(created.value.agentPreset)}`)
    after = created.value.sessionId
    pass(`a new Standard session was created: ${after}`)

    const observed = await waitFor(async () => {
      try {
        return JSON.parse(await readFile(join(inspectDir, `${after}.json`), 'utf8'))
      } catch {
        return undefined
      }
    }, `the observer record for ${after}`)
    for (const tool of ['cordis_inspect_list', 'cordis_inspect_query', 'plugin_manager']) {
      if (!observed.tools.includes(tool)) fail(`the model-facing tool list does not contain ${tool}: ${observed.tools.join(', ')}`)
    }
    const skills = ['agent-experience', 'cordis-composition-reference', 'cordis-plugin-development', 'editing-cordis-compositions']
    if (observed.skills.join(',') !== skills.join(',')) {
      fail(`the session skill catalog is ${observed.skills.join(', ')}, expected ${skills.join(', ')}`)
    }
    pass(`the session model lists cordis_inspect_list, cordis_inspect_query, plugin_manager and the four Cordis skills (${observed.tools.length} tools)`)

    const resumed = await rpc(connection, 'session/prompt', {
      request: {
        requestId: crypto.randomUUID(),
        sessionId: before,
        mode: 'queue',
        content: [{ type: 'text', text: 'This session continues after the bundle was installed.' }],
      },
    })
    if (!resumed.ok) fail(`the pre-install Standard session did not resume: ${JSON.stringify(resumed.error)}`)
    pass(`the pre-install session ${before} resumed under the new Standard definition`)

    for (const { preset, sessionId } of removedModes) {
      const denied = await rpc(connection, 'session/prompt', {
        request: {
          requestId: crypto.randomUUID(),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: `This ${preset} session must not resume while its preset is removed.` }],
        },
      })
      if (denied.ok) fail(`the ${preset} session resumed even though its preset is removed`)
      if (!JSON.stringify(denied.error).includes(`Unknown agent preset: ${preset}`)) {
        fail(`the ${preset} session failed for an unexpected reason: ${JSON.stringify(denied.error)}`)
      }
    }
    pass('started ptc, minimal and cordis sessions cannot resume while the bundle replaces their modes')
  } finally {
    await stopWeb(server)
  }

  // Arbor beside the new Standard mode.
  if (CHECK_ARBOR) {
    await run(process.execPath, [join(install, DSH_CLI), 'plugin', '--profile', 'web', 'add', `${ARBOR}@${ARBOR_VERSION}`])
    const withArbor = await profileManifest()
    const composed = withArbor.dsh?.profile?.bundles ?? []
    if (!composed.includes(ARBOR)) fail(`the profile does not compose ${ARBOR}: ${JSON.stringify(composed)}`)
    server = await startWeb('arbor')
    try {
      connection = await connect(server.url)
      const roster = await rosterIds(connection)
      if (roster.map((row) => row.id).join(',') !== 'standard,arbor') {
        fail(`the roster with arbor installed is ${roster.map((row) => row.id).join(', ')}, expected standard, arbor`)
      }
      pass(`Arbor stays beside the new Standard mode: ${roster.map((row) => row.id).join(', ')}`)
    } finally {
      await stopWeb(server)
    }
    await run(process.execPath, [join(install, DSH_CLI), 'plugin', '--profile', 'web', 'remove', ARBOR])
  } else {
    console.log('skipped the Arbor phase (STANDARD_PLUS_CHECK_ARBOR=0)')
  }

  // Remove the bundle: the shipped modes and an unskilled Standard.
  await run(process.execPath, [join(install, DSH_CLI), 'plugin', '--profile', 'web', 'remove', PACKAGE])
  const removed = await profileManifest()
  if ((removed.dsh?.profile?.bundles ?? []).includes(PACKAGE)) fail('the profile still composes the removed bundle')
  server = await startWeb('removed')
  try {
    connection = await connect(server.url)
    const roster = await rosterIds(connection)
    if (roster.map((row) => row.id).join(',') !== 'standard,ptc,minimal,cordis') {
      fail(`the restored roster is ${roster.map((row) => row.id).join(', ')}, expected standard, ptc, minimal, cordis`)
    }
    pass('removing the bundle restores standard, ptc, minimal and cordis')

    if (after !== undefined) {
      const result = await rpc(connection, 'skills/list', { request: { sessionId: after } })
      if (!result.ok) fail(`skills/list on the former bundle session failed: ${JSON.stringify(result.error)}`)
      if (result.value.skills.length !== 0) {
        fail(`the former bundle session still sees ${result.value.skills.map((skill) => skill.name).join(', ')} skills`)
      }
      pass('the bundle session now resolves the shipped Standard mode without the Cordis skills')
    }

    for (const { preset, sessionId } of removedModes) {
      const restored = await rpc(connection, 'session/prompt', {
        request: {
          requestId: crypto.randomUUID(),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: `This ${preset} session resumes after the bundle was removed.` }],
        },
      })
      if (!restored.ok) fail(`the ${preset} session did not resume after the bundle was removed: ${JSON.stringify(restored.error)}`)
    }
    pass('removing the bundle restores the ptc, minimal and cordis sessions')
  } finally {
    await stopWeb(server)
  }

  console.log(`\nPROFILE INSTALL OK: ${passed.length} checks passed`)
  if (process.env.STANDARD_PLUS_CHECK_WORK === undefined) await removeTree(work)
} catch (error) {
  console.error(`\nFAIL ${error instanceof Error ? error.message : String(error)}`)
  console.error(`work directory kept at ${work}`)
  process.exitCode = 1
}
