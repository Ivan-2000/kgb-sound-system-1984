/**
 * Generates libelectron-napi.dll.a — a MinGW import library that resolves
 * NAPI symbols from electron.exe at load time (no DELAYLOAD needed).
 *
 * GNU ld 2.44 (MSYS2 UCRT64) does not support --delayload, so instead of
 * the cmake-js DELAYLOAD+hook pattern we link against this import library.
 * The addon's PE import table then references electron.exe directly, which
 * Windows resolves from the already-running process at load time.
 *
 * Run this script when:
 *   - First-time setup on a new machine
 *   - After upgrading the electron version in package.json
 *
 * Prerequisites: MSYS2 UCRT64 with dlltool and nm in PATH.
 *
 * Usage:
 *   npm run gen-implib
 */

import { execSync, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

// Read electron version from the client package.json
const clientPkg = JSON.parse(
  (await import('node:fs')).promises.readFile(
    join(ROOT, '..', '..', '..', 'package.json'), 'utf8'
  ).then ? await (await import('node:fs')).promises.readFile(
    join(ROOT, '..', '..', '..', 'package.json'), 'utf8'
  ) : '{}'
)
const electronVersion = (clientPkg.devDependencies?.electron ?? '').replace(/[\^~]/, '')
if (!electronVersion) {
  console.error('Could not determine electron version from client/package.json')
  process.exit(1)
}

const nodeLibPath = join(
  process.env.HOME ?? process.env.USERPROFILE,
  '.cmake-js', 'electron-x64', `v${electronVersion}`, 'x64', 'node.lib'
)

console.log(`electron version : ${electronVersion}`)
console.log(`node.lib path    : ${nodeLibPath}`)

// Extract napi_* and node_api_* symbol names from node.lib
const nmResult = spawnSync('nm', [nodeLibPath], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
if (nmResult.error) {
  console.error('nm not found — install MSYS2 UCRT64 binutils and add to PATH')
  process.exit(1)
}

const symbols = [...new Set(
  nmResult.stdout
    .split('\n')
    .filter(l => l.includes(' I __imp_napi_') || l.includes(' I __imp_node_api_'))
    .map(l => l.replace(/.*__imp_/, '').trim())
    .filter(Boolean)
)].sort()

if (symbols.length === 0) {
  console.error('No NAPI symbols found in', nodeLibPath)
  console.error('Run: cmake-js --runtime=electron --runtime-version=' + electronVersion + ' to download node.lib first')
  process.exit(1)
}

console.log(`symbols found    : ${symbols.length}`)

// Write .def file
const defPath = join(tmpdir(), 'electron_napi.def')
writeFileSync(defPath, ['LIBRARY electron.exe', 'EXPORTS', ...symbols].join('\n') + '\n')

// Run dlltool
const outLib = join(ROOT, 'libelectron-napi.dll.a')
const dt = spawnSync('dlltool', [
  '--dllname', 'electron.exe',
  '--def', defPath,
  '--output-lib', outLib,
  '--machine', 'i386:x86-64',
], { encoding: 'utf8' })

unlinkSync(defPath)

if (dt.status !== 0) {
  console.error('dlltool failed:', dt.stderr)
  process.exit(1)
}

console.log(`output           : ${outLib}`)
console.log('Done. Commit libelectron-napi.dll.a and rebuild the addon.')
